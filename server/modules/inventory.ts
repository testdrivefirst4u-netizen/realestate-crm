/**
 * Inventory — port of apps-script/12_Inventory.gs.
 *
 * Stored in CFG.COLL.INVENTORY ('units'), `_id` = Inventory ID ('INV-0001'). The service stamps
 * lastModified / modifiedBy itself on every write (the Sheets onEdit trigger no longer exists).
 * Concurrency (mandatory): every unit carries a revision `rev`. A write must say which version it is based on
 * (`expectedRev`, or the older `expectedLastModified`) and is applied with a compare-and-set on `rev`, so two people
 * saving at once can never both win. A stale or losing write is NOT applied; `{ unit, conflict, version, reason }`
 * returns the current server copy. A repeated `idempotencyKey` returns the first answer and changes nothing.
 *
 * Booking rules (server/modules/unitRules.ts) apply to every write, including the generic field edit: reserving,
 * booking, selling and releasing are state transitions with a customer lead, never a free-text status change.
 *
 * Disclosure: unit facts (number, tower, type, area, price, status) are visible to everyone with inventory.view.
 * Customer and money fields (buyer name, phone, lead ID, quoted / paid / due, notes) only reach users with
 * `inventory.customers`, or the agent whose own lead the unit is linked to (presentUnits below).
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, getVersion, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { tenantKey } from '../core/tenant';
import { addEvent, addTimeline } from '../core/events';
import { bool, normalizeUnitType, num, parseDate, str, toIso } from '../core/utils';
import { can } from '../core/auth';
import { visibleLeadIds } from '../core/scope';
import { currentTenant } from '../core/tenant';
import { checkTransition, holdExpired, HOLD_STATES, type TransitionCheck } from './unitRules';


/** Stored shape of a unit (camelCase; `unitNumber` is the UI's `unitId`). */
export interface UnitDoc {
  _id: string;
  unitNumber: string;
  /** Upper-cased unit number used for the uniqueness guard. */
  unitKey?: string;
  tower: string;
  floor: string;
  unitType: string;
  carpetArea: number;
  totalArea: number;
  uds: number;
  facing: string;
  status: string;
  price: number;
  /** What the customer was quoted (agreed value) and what they have paid so far; due = quoted − paid. */
  quotedAmount: number;
  paidAmount: number;
  /** When the next payment is due (reminders before and on the day, then weekly while overdue). */
  dueDate: Date | null;
  availability: string;
  bookingStatus: string;
  customerName: string;
  contact: string;
  leadId: string;
  bookedDate: Date | null;
  notes: string;
  ownership: string;
  mortgaged: boolean;
  lastModified: Date;
  modifiedBy: string;
  syncStatus: string;
  syncError: string;
  /** Revision, +1 on every write (compare-and-set). Missing on rows written before revisions = 0. */
  rev?: number;
  /** A Reserved unit is held for its lead until this moment; afterwards it can be taken (and is released by the job). */
  holdUntil?: Date | null;
  /** Lead that holds / booked the unit by immutable id, and who did it. */
  heldBy?: string;
}

const units = () => col<UnitDoc>(CFG.COLL.INVENTORY);
const CI = { locale: 'en', strength: 2 } as const; // case-insensitive collation for unit-number lookups

/** Per-company database: the unique index is ensured once per company. */
const indexReady = new Map<string, Promise<unknown>>();
/** Unique guard on the normalised unit number (partial: migrated rows without unitKey are ignored). */
async function ensureUnitIndex() {
  const k = tenantKey();
  if (!indexReady.has(k)) {
    indexReady.set(
      k,
      units()
        .then((c) => c.createIndex({ unitKey: 1 }, { unique: true, partialFilterExpression: { unitKey: { $type: 'string' } } }))
        .catch((e) => {
          indexReady.delete(k);
          console.error('[inventory] unitKey index failed', e);
        })
    );
  }
  await indexReady.get(k);
}

const unitKey = (s: unknown) => str(s).toUpperCase();

/** GAS Inventory_serialize — the InventoryUnit shape the browser expects. */
export function serializeUnit(r: any) {
  return {
    inventoryId: str(r._id),
    unitId: str(r.unitNumber),
    tower: str(r.tower),
    floor: str(r.floor),
    unitType: normalizeUnitType(r.unitType),
    carpetArea: num(r.carpetArea),
    totalArea: num(r.totalArea),
    uds: num(r.uds),
    facing: str(r.facing),
    status: str(r.status) || 'Available',
    price: num(r.price),
    quotedAmount: num(r.quotedAmount),
    paidAmount: num(r.paidAmount),
    dueDate: toIso(r.dueDate),
    availability: str(r.availability),
    bookingStatus: str(r.bookingStatus),
    customerName: str(r.customerName),
    contact: str(r.contact),
    leadId: str(r.leadId),
    bookedDate: toIso(r.bookedDate),
    notes: str(r.notes),
    lastModified: toIso(r.lastModified),
    modifiedBy: str(r.modifiedBy),
    syncStatus: str(r.syncStatus) || 'Synced',
    syncError: str(r.syncError),
    ownership: str(r.ownership),
    mortgaged: bool(r.mortgaged),
    rev: num(r.rev),
    holdUntil: toIso(r.holdUntil),
  };
}

/** Customer and money fields: only for people allowed to see the buyer (see presentUnits). */
export const RESTRICTED_UNIT_FIELDS = ['customerName', 'contact', 'leadId', 'quotedAmount', 'paidAmount', 'dueDate', 'notes', 'bookingStatus'] as const;

function redact(u: ReturnType<typeof serializeUnit>) {
  return {
    ...u,
    customerName: '', contact: '', leadId: '', quotedAmount: 0, paidAmount: 0, dueDate: '', notes: '', bookingStatus: '',
    /** Tells the screen the buyer is hidden (not missing), so it can say so. */
    restricted: true,
  };
}

type Viewer = { user?: Ctx['user'] } | null | undefined;

/**
 * Units as one user may see them. The system (no user) and users with `inventory.customers` get everything; anyone
 * else gets the unit facts, plus the buyer fields only on units linked to a lead they may see.
 */
export async function presentUnits<T extends ReturnType<typeof serializeUnit>>(units: T[], who: Viewer): Promise<Array<T | ReturnType<typeof redact>>> {
  const user = who?.user;
  if (!user || user.id === 'SYSTEM') return units;
  // a manager limited to their team sees buyers of their team's leads only, whatever their role allows
  const team = (user as any).leadScope === 'team' && String(user.role) === 'Manager';
  if (!team && can(user, 'inventory.customers')) return units;
  // Without the permission, the buyer shows only on units of the user's own (restricted) leads. Someone who sees all
  // leads but was not given buyer details (a View only user the company limited) sees no buyers at all.
  const ids = await visibleLeadIds(user);
  return units.map((u) => (u.leadId && ids && ids.has(u.leadId) ? u : redact(u)));
}

async function presentOne(u: ReturnType<typeof serializeUnit>, ctx: Viewer) {
  return (await presentUnits([u], ctx))[0];
}

/** Inventory is part of the plan and of the role: bootstrap leaves it out for anyone who may not have it. */
export function inventoryAllowed(ctx: Viewer): boolean {
  const t = currentTenant();
  if (t && !t.features.inventory) return false;
  return !ctx?.user || can(ctx.user, 'inventory.view');
}

/** GAS Inventory_toCells — only the fields present in `u` are returned. */
function toFields(u: any): Partial<UnitDoc> {
  const c: Partial<UnitDoc> = {};
  if (!u || typeof u !== 'object') return c;
  if (u.unitId !== undefined) {
    c.unitNumber = str(u.unitId);
    c.unitKey = unitKey(u.unitId);
  }
  if (u.tower !== undefined) c.tower = str(u.tower);
  if (u.floor !== undefined) c.floor = str(u.floor);
  if (u.unitType !== undefined) c.unitType = normalizeUnitType(u.unitType);
  if (u.carpetArea !== undefined) c.carpetArea = num(u.carpetArea);
  if (u.totalArea !== undefined) c.totalArea = num(u.totalArea);
  if (u.uds !== undefined) c.uds = num(u.uds);
  if (u.facing !== undefined) c.facing = str(u.facing);
  if (u.status !== undefined) c.status = str(u.status);
  if (u.price !== undefined) c.price = num(u.price);
  if (u.quotedAmount !== undefined) c.quotedAmount = Math.max(0, num(u.quotedAmount));
  if (u.paidAmount !== undefined) c.paidAmount = Math.max(0, num(u.paidAmount));
  if (u.dueDate !== undefined) c.dueDate = parseDate(u.dueDate);
  if (u.availability !== undefined) c.availability = str(u.availability);
  if (u.bookingStatus !== undefined) c.bookingStatus = str(u.bookingStatus);
  if (u.customerName !== undefined) c.customerName = str(u.customerName);
  if (u.contact !== undefined) c.contact = str(u.contact);
  if (u.leadId !== undefined) c.leadId = str(u.leadId);
  if (u.bookedDate !== undefined) c.bookedDate = parseDate(u.bookedDate);
  if (u.notes !== undefined) c.notes = str(u.notes);
  if (u.ownership !== undefined) c.ownership = str(u.ownership);
  if (u.mortgaged !== undefined) c.mortgaged = bool(u.mortgaged);
  return c;
}

/** A complete new document (defaults for every field not supplied). */
function newUnitDoc(id: string, fields: Partial<UnitDoc>, modifiedBy: string): UnitDoc {
  return {
    _id: id,
    unitNumber: '',
    tower: '',
    floor: '',
    unitType: '',
    carpetArea: 0,
    totalArea: 0,
    uds: 0,
    facing: '',
    price: 0,
    quotedAmount: 0,
    paidAmount: 0,
    dueDate: null,
    availability: '',
    bookingStatus: '',
    customerName: '',
    contact: '',
    leadId: '',
    bookedDate: null,
    notes: '',
    ownership: '',
    mortgaged: false,
    ...fields,
    status: fields.status || 'Available',
    lastModified: new Date(),
    modifiedBy,
    syncStatus: 'Synced',
    syncError: '',
    rev: 0,
    holdUntil: null,
    heldBy: '',
  };
}

const actorOf = (ctx: Ctx | null | undefined) => (ctx && ctx.user ? ctx.user.name : 'System');

/** Every unit, unredacted (system use). Screens use getUnitsFor(ctx). */
export async function getAllUnits(): Promise<any[]> {
  const rows = await (await units()).find({}).sort({ _id: 1 }).toArray(); // insertion order, like the sheet
  return rows.map(serializeUnit).filter((u) => u.inventoryId || u.unitId);
}

/** Units as this user may see them; [] when the plan or the role has no inventory. */
export async function getUnitsFor(ctx: Viewer): Promise<any[]> {
  if (!inventoryAllowed(ctx)) return [];
  return presentUnits(await getAllUnits(), ctx);
}

async function findByUnitNumber(unitNo: string) {
  if (!unitNo) return null;
  return (await units()).findOne({ unitNumber: unitNo }, { collation: CI });
}

export async function addUnit(data: any, ctx: Ctx): Promise<{ unit: any; version: string }> {
  const unitNo = str(data?.unitId);
  if (!data || !unitNo) throw fail('VALIDATION', 'Unit Number is required');
  await ensureUnitIndex();
  if (await findByUnitNumber(unitNo)) throw fail('CONFLICT', 'Unit ' + unitNo + ' already exists');
  const fields0 = toFields({ ...data, unitId: unitNo });
  // a new unit starts free: reserving / booking it for a customer is a transition on an existing unit
  if (fields0.status && HOLD_STATES.includes(fields0.status)) throw fail('VALIDATION', `Add the unit as Available, then ${fields0.status === 'Reserved' ? 'reserve' : 'book'} it for the customer's lead`);
  for (const k of ['customerName', 'contact', 'leadId', 'bookedDate'] as const) delete (fields0 as any)[k];
  const id = await nextSeq('INV', 4);
  const doc = newUnitDoc(id, fields0, 'CRM:' + actorOf(ctx));
  try {
    await (await units()).insertOne(doc);
  } catch (e: any) {
    if (e?.code === 11000) throw fail('CONFLICT', 'Unit ' + unitNo + ' already exists');
    throw e;
  }
  const unit = serializeUnit(doc);
  await auditLog(ctx, 'Unit Added', 'Inventory', id, unit.unitId);
  return { unit: await presentOne(unit, ctx), version: await bumpVersion() };
}

export interface UpdateOptions {
  /** The revision the change is based on (UnitDoc.rev). One of expectedRev / expectedLastModified is required. */
  expectedRev?: number | string;
  /** A repeated key returns the first answer and changes nothing (double clicks, retried requests). */
  idempotencyKey?: string;
  now?: Date;
}

type UpdateResult = { unit: any; version: string; conflict?: any; reason?: string; replay?: boolean };

const COLL_UNIT_OPS = 'unitOps';
interface UnitOpDoc { _id: string; unitId: string; userId: string; status: 'pending' | 'done'; result?: { inventoryId: string; conflict: boolean; reason?: string }; createdAt: Date }
const opsCol = () => col<UnitOpDoc>(COLL_UNIT_OPS);
const opsIndexReady = new Map<string, Promise<unknown>>();
async function ensureOpsIndex() {
  const k = tenantKey();
  if (!opsIndexReady.has(k)) {
    // idempotency keys are kept 7 days
    opsIndexReady.set(k, opsCol().then((c) => c.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 })).catch((e) => { opsIndexReady.delete(k); console.error('[inventory] unitOps index failed', e); }));
  }
  await opsIndexReady.get(k);
}

/** The filter that matches the revision we read (rows written before revisions have none). */
const revFilter = (rev: number | undefined) => (rev ? { rev } : { rev: { $in: [null, 0] } });

const conflictOut = async (doc: UnitDoc, ctx: Ctx, reason: string): Promise<UpdateResult> => {
  const cur = await presentOne(serializeUnit(doc), ctx);
  return { unit: cur, conflict: cur, reason, version: await getVersion() };
};

export async function updateUnit(id: string, patch: any, ctx: Ctx, expectedLastModified?: string, opts: UpdateOptions = {}): Promise<UpdateResult> {
  const key = str(id);
  if (!key) throw fail('VALIDATION', 'Inventory id is required');
  const now = opts.now || new Date();
  const actor = actorOf(ctx);
  const c = await units();
  let beforeDoc = await c.findOne({ _id: key });
  if (!beforeDoc) beforeDoc = await c.findOne({ unitNumber: key });
  if (!beforeDoc) throw fail('NOT_FOUND', 'Unit not found: ' + key);

  // idempotency: the same submission twice gives the same answer
  const idem = str(opts.idempotencyKey).slice(0, 120);
  const opId = idem ? `${beforeDoc._id}:${ctx?.user?.id || 'system'}:${idem}` : '';
  if (opId) {
    await ensureOpsIndex();
    const ops = await opsCol();
    const seen = await ops.findOne({ _id: opId });
    if (seen?.status === 'done') {
      const cur = (await c.findOne({ _id: beforeDoc._id }))!;
      const u = await presentOne(serializeUnit(cur), ctx);
      return seen.result?.conflict ? { unit: u, conflict: u, reason: seen.result.reason, version: await getVersion(), replay: true } : { unit: u, version: await getVersion(), replay: true };
    }
    if (seen) throw fail('CONFLICT', 'This change is already being saved. Wait a moment and reload the unit.');
    try {
      await ops.insertOne({ _id: opId, unitId: beforeDoc._id, userId: ctx?.user?.id || 'system', status: 'pending', createdAt: now });
    } catch (e: any) {
      if (e?.code === 11000) throw fail('CONFLICT', 'This change is already being saved. Wait a moment and reload the unit.');
      throw e;
    }
  }
  const settle = async (result: UpdateResult): Promise<UpdateResult> => {
    if (opId) await (await opsCol()).updateOne({ _id: opId }, { $set: { status: 'done', result: { inventoryId: beforeDoc!._id, conflict: !!result.conflict, reason: result.reason } } });
    return result;
  };
  const abandon = async () => {
    if (opId) await (await opsCol()).deleteOne({ _id: opId, status: 'pending' });
  };

  try {
    const before = serializeUnit(beforeDoc);
    const fields = toFields(patch || {});
    delete (fields as any).rev;
    if (!Object.keys(fields).length) {
      await abandon();
      return { unit: await presentOne(before, ctx), version: await getVersion() };
    }
    // mandatory revision: a write must say what it is based on
    const beforeRev = num(beforeDoc.rev);
    const hasRev = opts.expectedRev !== undefined && opts.expectedRev !== null && str(opts.expectedRev) !== '';
    const expected = expectedLastModified ? parseDate(expectedLastModified) : null;
    if (!hasRev && !expected) throw fail('VALIDATION', 'Reload the unit and try again: the change did not say which version it was based on.');
    if (hasRev && num(opts.expectedRev) !== beforeRev) return settle(await conflictOut(beforeDoc, ctx, 'Someone else changed this unit. The latest version is shown.'));
    if (!hasRev && expected && beforeDoc.lastModified && new Date(beforeDoc.lastModified).getTime() > expected.getTime() + 1000) {
      return settle(await conflictOut(beforeDoc, ctx, 'Someone else changed this unit. The latest version is shown.'));
    }


    if (fields.unitNumber !== undefined) {
      if (!fields.unitNumber) throw fail('VALIDATION', 'Unit Number is required');
      const clash = await findByUnitNumber(fields.unitNumber);
      if (clash && clash._id !== beforeDoc._id) throw fail('CONFLICT', 'Unit ' + fields.unitNumber + ' already exists');
    }

    // booking rules, for every write (a generic field edit cannot skip them)
    const expired = holdExpired(beforeDoc, now);
    const fromStatus = expired ? 'Available' : before.status;
    const fromLead = expired ? '' : before.leadId;
    const toStatus = fields.status !== undefined ? fields.status || 'Available' : fromStatus;
    let toLead = fields.leadId !== undefined ? fields.leadId : fromLead;
    if (toStatus === 'Available' && fields.leadId === undefined) toLead = '';
    const check: TransitionCheck = checkTransition({ status: before.status, leadId: before.leadId, holdUntil: beforeDoc.holdUntil }, { status: toStatus, leadId: toLead }, { canApprove: !ctx?.user || can(ctx.user, 'inventory.approve'), now });
    if (check.ok === false) {
      const bad = check as Extract<TransitionCheck, { ok: false }>;
      if (bad.code === 'CONFLICT') return settle(await conflictOut(beforeDoc, ctx, bad.message));
      throw fail(bad.code, bad.message);
    }
    const kind = check.kind;
    // a lead the user may not see cannot be linked by them
    if (toLead && toLead !== fromLead && ctx?.user) {
      const ids = await visibleLeadIds(ctx.user);
      if (ids && !ids.has(toLead)) throw fail('NOT_FOUND', 'Lead not found: ' + toLead);
    }
    // once payments are recorded as receipts, the paid total and next due date come from that ledger only
    if ((beforeDoc as any).ledger && (fields.paidAmount !== undefined || fields.dueDate !== undefined)) {
      throw fail('VALIDATION', 'Payments on this unit are recorded as receipts. Add a receipt (or void one) instead of editing the paid amount.');
    }
    // money fields are buyer detail: only people who may see buyers change them
    if (ctx?.user && !can(ctx.user, 'inventory.customers') && ['quotedAmount', 'paidAmount', 'dueDate'].some((k) => (fields as any)[k] !== undefined) && fromLead) {
      const ids = await visibleLeadIds(ctx.user);
      if (ids && !ids.has(fromLead)) throw fail('FORBIDDEN', 'You cannot change payment details of another agent\'s customer.');
    }

    const set: any = { ...fields, lastModified: now, modifiedBy: 'CRM:' + actor, syncStatus: 'Synced', syncError: '' };
    const holdCfg = holdHoursSetting();
    if (kind === 'reserve' || (kind === 'extend' && fields.status !== undefined)) {
      set.holdUntil = new Date(now.getTime() + (await holdCfg) * 3_600_000);
      set.heldBy = toLead;
    }
    if (kind === 'book') {
      set.holdUntil = null;
      set.heldBy = toLead;
      if (!parseDate(before.bookedDate) && fields.bookedDate === undefined) set.bookedDate = now;
    }
    if (kind === 'release' || kind === 'cancel' || (toStatus === 'Available' && expired)) {
      // releasing a unit clears the customer link
      for (const k of ['customerName', 'contact', 'leadId'] as const) if (fields[k] === undefined) set[k] = '';
      if (fields.bookedDate === undefined) set.bookedDate = null;
      set.holdUntil = null;
      set.heldBy = '';
    }
    if (expired && fields.status === undefined) set.status = 'Available';
    const changedKeys = Object.keys(fields).filter((k) => k !== 'unitKey');

    // compare-and-set on the revision read above: of two writes based on the same version, exactly one wins
    let after: UnitDoc | null;
    try {
      after = await c.findOneAndUpdate({ _id: beforeDoc._id, ...revFilter(beforeRev) } as any, { $set: set, $inc: { rev: 1 } }, { returnDocument: 'after' });
    } catch (e: any) {
      if (e?.code === 11000) throw fail('CONFLICT', 'Unit ' + fields.unitNumber + ' already exists');
      throw e;
    }
    if (!after) {
      const cur = await c.findOne({ _id: beforeDoc._id });
      if (!cur) throw fail('NOT_FOUND', 'Unit not found: ' + key);
      return settle(await conflictOut(cur, ctx, 'Someone else changed this unit at the same moment. The latest version is shown.'));
    }
    const unit = serializeUnit(after);

    const leadId = unit.leadId || before.leadId;
    if (leadId && (fields.status !== undefined || fields.leadId !== undefined)) {
      const verb = { reserve: 'reserved', extend: 'reservation extended', book: 'booked', sell: 'sold', release: 'released', cancel: 'booking cancelled', block: unit.status, edit: unit.status, none: unit.status }[kind];
      await addTimeline(leadId, 'inventory', `Unit ${unit.unitId} ${verb}`, kind === 'reserve' || kind === 'extend' ? `Held until ${toIso(after.holdUntil)}` : '', actor, 'Inventory', unit.inventoryId);
    }
    // journey milestones on the lead (first time each step happens)
    const step = kind === 'reserve' ? 'reserved' : kind === 'book' ? 'booked' : kind === 'cancel' ? 'cancelled' : '';
    if (step && leadId) await (await import('../core/milestones')).markMilestones(leadId, [step as any], actor, now);
    if (unit.status !== before.status) {
      // the event feed reaches everyone: no buyer name in it; the lead id lets the feed filter by lead access
      await addEvent('inventory_status', 'Inventory', unit.inventoryId, 'Unit ' + unit.unitId + ' is now ' + unit.status, 'Updated by ' + actor, actor, { leadId: unit.leadId || before.leadId || '' });
    }
    await auditLog(ctx, 'Unit Updated', 'Inventory', unit.inventoryId, unit.unitId + ' → ' + changedKeys.join(', ') + (kind !== 'edit' && kind !== 'none' ? ` (${kind})` : ''), { before: { ...before, rev: beforeRev }, after: unit });
    return settle({ unit: await presentOne(unit, ctx), version: await bumpVersion() });
  } catch (e) {
    await abandon();
    throw e;
  }
}

async function holdHoursSetting(): Promise<number> {
  const { settingsAll } = await import('../core/settings');
  const { holdHours } = await import('./unitRules');
  return holdHours((await settingsAll()).unitHoldHours);
}

/** Lapsed reservations go back to Available (run by the daily / 10-minute job). Each is a normal guarded write. */
export async function releaseExpiredHolds(now = new Date()): Promise<{ released: number }> {
  const c = await units();
  const due = await c.find({ status: 'Reserved', holdUntil: { $ne: null, $lte: now } } as any, { projection: { _id: 1, rev: 1, leadId: 1, unitNumber: 1 } }).limit(200).toArray();
  let released = 0;
  for (const u of due) {
    const r = await c.updateOne({ _id: u._id, status: 'Reserved', holdUntil: { $lte: now }, ...revFilter(num(u.rev)) } as any, {
      $set: { status: 'Available', customerName: '', contact: '', leadId: '', bookedDate: null, holdUntil: null, heldBy: '', lastModified: now, modifiedBy: 'System:hold expired' },
      $inc: { rev: 1 },
    });
    if (!r.modifiedCount) continue;
    released++;
    if (u.leadId) await addTimeline(String(u.leadId), 'inventory', `Reservation of unit ${u.unitNumber} lapsed`, 'The unit is available again', 'System', 'Inventory', u._id);
    await addEvent('inventory_status', 'Inventory', u._id, 'Unit ' + u.unitNumber + ' is now Available', 'Reservation lapsed', 'System', { leadId: String(u.leadId || '') });
    await auditLog(null, 'Unit Hold Expired', 'Inventory', u._id, String(u.unitNumber));
  }
  if (released) await bumpVersion();
  return { released };
}

/** Import units (e.g. migrating the old local inventory). Existing Unit Numbers are skipped, never overwritten. */
export async function importUnits(list: any[], ctx: Ctx): Promise<{ created: number; skipped: number; version: string }> {
  if (!Array.isArray(list)) throw fail('VALIDATION', 'units must be an array');
  await ensureUnitIndex();
  const actor = actorOf(ctx);
  const c = await units();
  const existing = new Set((await c.find({}, { projection: { unitNumber: 1 } }).toArray()).map((u) => unitKey(u.unitNumber)));
  let created = 0;
  let skipped = 0;
  const docs: UnitDoc[] = [];
  for (const u of list) {
    const unitNo = str(u?.unitId ?? u?.unitNumber);
    if (!unitNo || existing.has(unitKey(unitNo))) {
      skipped++;
      continue;
    }
    existing.add(unitKey(unitNo));
    const id = await nextSeq('INV', 4);
    docs.push(newUnitDoc(id, toFields({ ...u, unitId: unitNo }), 'Import:' + actor));
    created++;
  }
  if (docs.length) {
    try {
      await c.insertMany(docs, { ordered: false });
    } catch (e: any) {
      // a concurrent add/import inserted the same unit number: count those as skipped
      if (e?.code !== 11000 && !(e?.writeErrors || []).every((w: any) => w.code === 11000)) throw e;
      const failed = Array.isArray(e.writeErrors) ? e.writeErrors.length : 0;
      created -= failed;
      skipped += failed;
    }
  }
  await auditLog(ctx, 'Inventory Imported', 'Inventory', '', created + ' created, ' + skipped + ' skipped');
  return { created, skipped, version: await bumpVersion() };
}

export const actions: ActionMap = {
  getInventory: { fn: async (_d, ctx) => ({ units: await getUnitsFor(ctx), version: await getVersion() }), perm: 'inventory.view' },
  updateInventoryUnit: { fn: (d, ctx) => updateUnit(d.id, d.data, ctx, d.expectedLastModified, { expectedRev: d.expectedRev, idempotencyKey: d.idempotencyKey }), perm: 'inventory.edit' },
  addInventoryUnit: { fn: (d, ctx) => addUnit(d.data, ctx), perm: 'inventory.edit' },
  importInventory: { fn: (d, ctx) => importUnits(d.units, ctx), perm: 'inventory.edit' },
};
