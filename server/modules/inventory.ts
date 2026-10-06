/**
 * Inventory — port of apps-script/12_Inventory.gs.
 *
 * Stored in CFG.COLL.INVENTORY ('units'), `_id` = Inventory ID ('INV-0001'). The service stamps
 * lastModified / modifiedBy itself on every write (the Sheets onEdit trigger no longer exists).
 * Conflict detection: the client sends `expectedLastModified`; if the stored unit changed after that
 * (more than 1 s later), the update is NOT applied and `{ unit, conflict, version }` is returned with
 * the current server copy — exactly like GAS.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, getVersion, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { tenantKey } from '../core/tenant';
import { addEvent, addTimeline } from '../core/events';
import { bool, normalizeUnitType, num, parseDate, str, toIso } from '../core/utils';

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
  };
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
  };
}

const actorOf = (ctx: Ctx | null | undefined) => (ctx && ctx.user ? ctx.user.name : 'System');

export async function getAllUnits(): Promise<any[]> {
  const rows = await (await units()).find({}).sort({ _id: 1 }).toArray(); // insertion order, like the sheet
  return rows.map(serializeUnit).filter((u) => u.inventoryId || u.unitId);
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
  const id = await nextSeq('INV', 4);
  const doc = newUnitDoc(id, toFields({ ...data, unitId: unitNo }), 'CRM:' + actorOf(ctx));
  try {
    await (await units()).insertOne(doc);
  } catch (e: any) {
    if (e?.code === 11000) throw fail('CONFLICT', 'Unit ' + unitNo + ' already exists');
    throw e;
  }
  const unit = serializeUnit(doc);
  await auditLog(ctx, 'Unit Added', 'Inventory', id, unit.unitId);
  return { unit, version: await bumpVersion() };
}

export async function updateUnit(id: string, patch: any, ctx: Ctx, expectedLastModified?: string): Promise<{ unit: any; version: string; conflict?: any }> {
  const key = str(id);
  if (!key) throw fail('VALIDATION', 'Inventory id is required');
  const actor = actorOf(ctx);
  const c = await units();
  let beforeDoc = await c.findOne({ _id: key });
  if (!beforeDoc) beforeDoc = await c.findOne({ unitNumber: key });
  if (!beforeDoc) throw fail('NOT_FOUND', 'Unit not found: ' + key);
  const before = serializeUnit(beforeDoc);

  const expected = expectedLastModified ? parseDate(expectedLastModified) : null;
  if (expected && before.lastModified && new Date(before.lastModified).getTime() > expected.getTime() + 1000) {
    return { unit: before, conflict: before, version: await getVersion() };
  }

  const fields = toFields(patch || {});
  if (!Object.keys(fields).length) return { unit: before, version: await getVersion() };

  if (fields.unitNumber !== undefined) {
    if (!fields.unitNumber) throw fail('VALIDATION', 'Unit Number is required');
    const clash = await findByUnitNumber(fields.unitNumber);
    if (clash && clash._id !== beforeDoc._id) throw fail('CONFLICT', 'Unit ' + fields.unitNumber + ' already exists');
  }
  if (fields.status === 'Booked' && !parseDate(before.bookedDate) && fields.bookedDate === undefined) fields.bookedDate = new Date();
  if (fields.status === 'Available') {
    // releasing a unit clears the customer link
    if (fields.customerName === undefined) fields.customerName = '';
    if (fields.contact === undefined) fields.contact = '';
    if (fields.leadId === undefined) fields.leadId = '';
    if (fields.bookedDate === undefined) fields.bookedDate = null;
  }
  const changedKeys = Object.keys(fields).filter((k) => k !== 'unitKey');
  const set: Partial<UnitDoc> = { ...fields, lastModified: new Date(), modifiedBy: 'CRM:' + actor, syncStatus: 'Synced', syncError: '' };

  let after: UnitDoc | null;
  try {
    after = await c.findOneAndUpdate({ _id: beforeDoc._id }, { $set: set }, { returnDocument: 'after' });
  } catch (e: any) {
    if (e?.code === 11000) throw fail('CONFLICT', 'Unit ' + fields.unitNumber + ' already exists');
    throw e;
  }
  if (!after) throw fail('NOT_FOUND', 'Unit not found: ' + key);
  const unit = serializeUnit(after);

  const leadId = unit.leadId || before.leadId;
  if (leadId && (fields.status !== undefined || fields.leadId !== undefined)) {
    await addTimeline(leadId, 'inventory', 'Unit ' + unit.unitId + ' → ' + unit.status, unit.customerName || '', actor, 'Inventory', unit.inventoryId);
  }
  if (fields.status !== undefined && fields.status !== before.status) {
    await addEvent('inventory_status', 'Inventory', unit.inventoryId, 'Unit ' + unit.unitId + ' is now ' + unit.status, unit.customerName ? unit.customerName : 'Updated by ' + actor, actor);
  }
  await auditLog(ctx, 'Unit Updated', 'Inventory', unit.inventoryId, unit.unitId + ' → ' + changedKeys.join(', '), { before, after: unit });
  return { unit, version: await bumpVersion() };
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
  getInventory: { fn: async () => ({ units: await getAllUnits(), version: await getVersion() }), perm: 'inventory.view' },
  updateInventoryUnit: { fn: (d, ctx) => updateUnit(d.id, d.data, ctx, d.expectedLastModified), perm: 'inventory.edit' },
  addInventoryUnit: { fn: (d, ctx) => addUnit(d.data, ctx), perm: 'inventory.edit' },
  importInventory: { fn: (d, ctx) => importUnits(d.units, ctx), perm: 'inventory.edit' },
};
