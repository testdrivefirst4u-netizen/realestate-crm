/**
 * Leads — port of apps-script/10_Leads.gs (+ Timeline_forLead from 15_Timeline.gs).
 *
 * Storage: one document per lead in `leads` (shape in server/core/leadShape.ts), `_id` = 'ENQ-0001'.
 * The API keeps returning header-keyed strings exactly like Leads_serialize did.
 * Locking: no LockService — writes are conditional (updatedAt / free follow-up slot) and retried.
 */
import type { AnyBulkWriteOperation } from 'mongodb';
import type { ActionMap } from '../core/actions';
import { auditLog, can, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, ensureCounterAtLeast, getClient, getVersion, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { addEvent, addTimeline, logError, serializeTimeline } from '../core/events';
import {
  applyFollowupEdits, blankLeadDoc, cellToUi, FOLLOWUP_RE, fromUiPatch, headersFor, nextFollowupSlot, toCellValue, toUiLead,
  type ArchivedLeadDoc, type LeadDoc,
} from '../core/leadShape';
import { settingsAll } from '../core/settings';
import { assertLeadAccess, canSeeLead, leadFilter } from '../core/scope';
import { dedupeUnitTypes, fmtHuman, fmtSheet, last10, parseDate, shortId, str, truncate } from '../core/utils';
import { scheduleLeadAlerts } from './leadAlerts';
import { firstFollowup, nextFollowup as sequenceNextFollowup, parseSequence } from './sequences';

/** A lead as the browser sees it: keys are the sheet header names ('Prospect Name', 'Follow-up 3' …). */
export type UiLead = Record<string, string>;

const L = CFG.LEAD;
const S = CFG.STAGES;
const IMPORT_MAX_ROWS = 20000;
/** Imports producing more events than this emit one summary event instead of one per row. */
const IMPORT_EVENT_LIMIT = 100;

const leadsCol = () => col<LeadDoc>(CFG.COLL.LEADS);
const archiveCol = () => col<ArchivedLeadDoc>(CFG.COLL.ARCHIVE);
const actorOf = (ctx: Ctx | null | undefined, fallback = 'System') => (ctx && ctx.user ? ctx.user.name : fallback);

/* -------------------------------- ids ----------------------------------- */

async function counterValue(prefix: string) {
  const c = await (await col<{ _id: string; seq: number }>(CFG.COLL.COUNTERS)).findOne({ _id: 'seq:' + prefix });
  return c?.seq || 0;
}

/** Reserve `k` consecutive sequence numbers; returns the first. */
async function reserveSeq(prefix: string, k: number) {
  const c = await col<{ _id: string; seq: number }>(CFG.COLL.COUNTERS);
  const res = await c.findOneAndUpdate({ _id: 'seq:' + prefix }, { $inc: { seq: k } }, { upsert: true, returnDocument: 'after' });
  return res!.seq - k + 1;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * Accept a caller-supplied id (GAS kept it when free) only if it can never collide with an issued one:
 * 'PREFIX-n' must be above the counter (the counter is then bumped); other ids must be unused.
 * Anything else gets a fresh sequential id.
 */
export async function resolveSuppliedId(prefix: string, width: number, supplied: unknown, taken: (id: string) => Promise<boolean>) {
  const s = String(supplied ?? '').trim();
  if (s && SAFE_ID.test(s)) {
    const m = s.match(new RegExp('^' + prefix + '-(\\d+)$'));
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > (await counterValue(prefix)) && !(await taken(s))) {
        await ensureCounterAtLeast('seq:' + prefix, n);
        return s;
      }
    } else if (!/^\d/.test(s) && !(await taken(s))) {
      return s;
    }
  }
  return nextSeq(prefix, width);
}

async function leadIdTaken(id: string) {
  return !!((await (await leadsCol()).findOne({ _id: id }, { projection: { _id: 1 } })) || (await (await archiveCol()).findOne({ _id: id }, { projection: { _id: 1 } })));
}

/* ------------------------------ side effects ----------------------------- */

interface TlArgs { leadId: string; type: string; title: string; details: string; actor: string; refType: string; refId: string }
interface EvArgs { type: string; recordType: string; recordId: string; title: string; message: string; actor: string; payload?: unknown }
interface Effects { timeline: TlArgs[]; events: EvArgs[] }

const tl = (leadId: string, type: string, title: string, details: string, actor: string): TlArgs => ({ leadId, type, title, details, actor, refType: 'Lead', refId: leadId });
const ev = (type: string, id: string, title: string, message: string, actor: string, payload?: unknown): EvArgs => ({ type, recordType: 'Lead', recordId: id, title, message, actor, payload });

async function runEffects(e: Effects) {
  for (const t of e.timeline) await addTimeline(t.leadId, t.type, t.title, t.details, t.actor, t.refType, t.refId);
  for (const x of e.events) await addEvent(x.type, x.recordType, x.recordId, x.title, x.message, x.actor, x.payload);
}

/** Bulk timeline insert (same document shape as events.addTimeline). */
async function insertTimelineBulk(list: TlArgs[]) {
  if (!list.length) return;
  const now = new Date();
  const docs = list.map((t, i) => ({
    _id: `${shortId('TL')}_${i.toString(36)}` as any, leadId: t.leadId, timestamp: now, type: t.type, title: truncate(t.title, 200),
    details: truncate(t.details || '', 1000), actor: t.actor || 'System', refType: t.refType || '', refId: t.refId || '',
  }));
  for (let i = 0; i < docs.length; i += 1000) await (await col(CFG.COLL.TIMELINE)).insertMany(docs.slice(i, i + 1000), { ordered: false });
}

/** Bulk event insert with a reserved block of event numbers (same shape as events.addEvent). */
async function insertEventsBulk(list: EvArgs[]) {
  if (!list.length) return;
  const c = await col<{ _id: string; seq: number }>(CFG.COLL.COUNTERS);
  const res = await c.findOneAndUpdate({ _id: 'events' }, { $inc: { seq: list.length } }, { upsert: true, returnDocument: 'after' });
  const first = res!.seq - list.length + 1;
  const now = new Date();
  const docs = list.map((e, i) => {
    const n = first + i;
    const id = 'EVT-' + String(n).padStart(6, '0');
    return {
      _id: id as any, seq: n, key: `${e.type}:${e.recordId || '-'}:${id}`, type: e.type, recordType: e.recordType || '', recordId: e.recordId || '',
      title: truncate(e.title, 200), message: truncate(e.message || '', 500), createdAt: now, actor: e.actor || 'System', payload: e.payload === undefined ? null : e.payload,
    };
  });
  await (await col(CFG.COLL.EVENTS)).insertMany(docs, { ordered: false });
}

/** Bulk audit insert (same shape as auth.auditLog). */
async function insertAuditBulk(ctx: Ctx | null, rows: Array<{ action: string; entityId: string; details: string }>) {
  if (!rows.length) return;
  const user = (ctx && ctx.user) || { name: 'System', role: 'System', email: '' };
  const now = new Date();
  const docs = rows.map((r, i) => ({
    _id: `${shortId('LOG')}_${i.toString(36)}` as any, timestamp: now, user: user.name + ((user as any).email ? ` <${(user as any).email}>` : ''),
    role: (user as any).role || '', action: r.action, entityType: 'Lead', entityId: r.entityId, details: truncate(r.details || '', 500), ip: ctx?.ip || '',
  }));
  for (let i = 0; i < docs.length; i += 1000) await (await col(CFG.COLL.AUDIT_LOG)).insertMany(docs.slice(i, i + 1000), { ordered: false });
}

/* -------------------------------- reads --------------------------------- */

/** Every lead the caller may see (all of them for the system / managers; see server/core/scope.ts). */
export async function getAllLeads(ctx?: Ctx | null): Promise<{ headers: string[]; leads: UiLead[] }> {
  const docs = await (await leadsCol()).find((await leadFilter(ctx)) || {}).sort({ createdAt: 1, _id: 1 }).toArray();
  return { headers: headersFor(docs), leads: docs.map((d) => toUiLead(d)!) };
}

export async function getLeadsConfig(): Promise<{ fields: string[]; options: Record<string, string[]> }> {
  const opts: Record<string, string[]> = {};
  CFG.DROPDOWNS.forEach((f) => (opts[f] = []));
  const rows = await (await col(CFG.COLL.CONFIG)).find({}).sort({ order: 1, _id: 1 }).toArray();
  for (const r of rows as any[]) {
    const k = str(r.field), v = str(r.option ?? r.value);
    if (!k || !v) continue;
    if (!opts[k]) opts[k] = [];
    if (!opts[k].includes(v)) opts[k].push(v);
  }
  for (const f of Object.keys(CFG.DEFAULT_OPTIONS)) {
    if (!opts[f]) opts[f] = [];
    for (const o of CFG.DEFAULT_OPTIONS[f]) if (!opts[f].includes(o)) opts[f].push(o);
  }
  opts[L.UNIT_TYPE] = dedupeUnitTypes(opts[L.UNIT_TYPE] || []);
  try {
    for (const u of await listUsers()) {
      if (u.status === 'Disabled') continue;
      if (!opts[L.RM].includes(u.name)) opts[L.RM].push(u.name);
    }
  } catch {
    /* users collection may not exist yet */
  }
  return { fields: CFG.DROPDOWNS, options: opts };
}

export async function getLead(id: string): Promise<UiLead | null> {
  if (!id) return null;
  return toUiLead(await (await leadsCol()).findOne({ _id: String(id) }));
}

/** Raw document (other modules may need dates as Date). */
export async function getLeadDoc(id: string): Promise<LeadDoc | null> {
  if (!id) return null;
  return (await leadsCol()).findOne({ _id: String(id) });
}

/** Active (non-archived) lead whose phone matches on the last 10 digits, or null. */
export async function findLeadByPhone(phone: string): Promise<UiLead | null> {
  const key = last10(phone);
  if (!key || key.length < 10) return null;
  const doc = await (await leadsCol()).find({ phoneLast10: key, stage: { $ne: S.DELETED } }).sort({ createdAt: 1, _id: 1 }).limit(1).next();
  return toUiLead(doc);
}

/* -------------------------------- create -------------------------------- */

export interface AddLeadOptions {
  /** Skip duplicate-phone protection. */
  allowDuplicate?: boolean;
  /** On a duplicate phone, return the existing lead (with existing: true) instead of failing. */
  returnExisting?: boolean;
  /** Actor name when there is no signed-in user (e.g. 'Chat360'). */
  actor?: string;
  /** Recorded in the lead_created event payload ({source}). Default 'crm'. */
  eventSource?: string;
}

/** Build a new lead document from a UI-shaped object (port of the Leads_add row builder). */
function buildNewDoc(id: string, obj: Record<string, unknown>, actor: string, now: Date): LeadDoc {
  const dp = fromUiPatch(obj);
  const doc: LeadDoc = { ...blankLeadDoc(id), ...dp.set } as LeadDoc;
  doc._id = id;
  doc.enquiryDate = parseDate(obj[L.ENQUIRY_DATE]) || now;
  doc.createdAt = now;
  doc.updatedAt = now;
  doc.updatedBy = actor;
  doc.stage = String(obj[L.STAGE] || S.NEW).trim() || S.NEW;
  doc.phone = String(obj[L.PHONE] || '').trim();
  doc.phoneLast10 = last10(doc.phone);
  doc.followups = applyFollowupEdits([], dp.followups, actor);
  doc.extra = Object.fromEntries(Object.entries(dp.extra).filter(([, v]) => v !== ''));
  // auto-stamp dates implied by status
  if (!doc.bookingDate && doc.stage === S.BOOKED) doc.bookingDate = now;
  const svs = doc.siteVisitStatus;
  if (!doc.siteVisitDate && (svs === CFG.SITE_VISIT.COMPLETED || svs === CFG.SITE_VISIT.WALK_IN)) doc.siteVisitDate = now;
  return doc;
}

function createdEffects(lead: UiLead, actor: string, source: string): Effects {
  const id = lead[L.ID], name = lead[L.NAME];
  return {
    timeline: [tl(id, 'lead_created', 'Enquiry created', name + ' · ' + (lead[L.SOURCE] || 'Unknown source') + ' · ' + (lead[L.UNIT_TYPE] || ''), actor)],
    events: [ev('lead_created', id, 'New enquiry: ' + name, (lead[L.UNIT_TYPE] || 'Unit') + ' via ' + (lead[L.SOURCE] || 'Unknown') + (lead[L.RM] ? ' · RM ' + lead[L.RM] : ''), actor, { source })],
  };
}

export async function addLead(data: UiLead, ctx: Ctx | null, options: AddLeadOptions = {}): Promise<{ id: string; lead: UiLead; version: string; existing?: boolean }> {
  const obj = data as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') throw fail('VALIDATION', 'Lead data is required');
  const name = String(obj[L.NAME] || '').trim();
  if (!name) throw fail('VALIDATION', 'Prospect Name is required');
  const actor = actorOf(ctx, options.actor || 'System');

  // duplicate protection by phone (unless explicitly allowed)
  if (!options.allowDuplicate && obj[L.PHONE]) {
    const dup = await findLeadByPhone(String(obj[L.PHONE]));
    if (dup && dup[L.STAGE] !== S.TRASH) {
      if (options.returnExisting) return { id: dup[L.ID], lead: dup, version: await getVersion(), existing: true };
      if (!obj._forceCreate) {
        if (!(await canSeeLead(ctx?.user, dup[L.ID]))) {
          throw fail('CONFLICT', 'A lead with this phone number already exists and is assigned to another RM. Ask your manager to reassign it.');
        }
        throw fail('CONFLICT', `A lead with this phone number already exists: ${dup[L.ID]} (${dup[L.NAME]})`, { existingId: dup[L.ID] });
      }
    }
  }

  const leads = await leadsCol();
  let id = await resolveSuppliedId('ENQ', 4, obj[L.ID], leadIdTaken);
  const now = new Date();
  let doc = buildNewDoc(id, obj, actor, now);
  // follow-up sequence: a new open lead without a date gets its first follow-up (Settings › Alerts & follow-ups)
  const autoFollowup = firstFollowup(parseSequence((await settingsAll()).followupSequence), doc, now);
  if (autoFollowup) doc.nextFollowupAt = autoFollowup;
  for (let attempt = 0; ; attempt++) {
    try {
      await leads.insertOne(doc);
      break;
    } catch (e: any) {
      if (e?.code !== 11000 || attempt > 3) throw e;
      id = await nextSeq('ENQ', 4);
      doc = { ...doc, _id: id };
    }
  }
  const lead = toUiLead(doc)!;
  const created = createdEffects(lead, actor, options.eventSource || 'crm');
  if (autoFollowup) created.timeline[0].details += ' · first follow-up ' + fmtHuman(autoFollowup);
  await runEffects(created);
  await auditLog(ctx, 'Lead Created', 'Lead', id, name);
  scheduleLeadAlerts(lead, 'created'); // e-mail the RM / auto WhatsApp reply, after the response
  return { id, lead, version: await bumpVersion() };
}

/* -------------------------------- update -------------------------------- */

interface Change { field: string; from: string; to: string }

interface UpdatePlan {
  changes: Change[];
  set: Partial<LeadDoc>;
  next: LeadDoc;
  oldStage: string;
  newStage?: string;
  oldSvs: string;
  newSvs?: string;
  rm?: string;
  nextFollowupTouched: boolean;
}

const UNTOUCHABLE = [L.ID, L.CREATED_AT, L.UPDATED_AT, L.UPDATED_BY];

/** Pure part of Leads_update: which cells change and what gets auto-stamped. null = nothing changed. */
function planUpdate(before: LeadDoc, patch: Record<string, unknown>, ctx: Ctx | null, actor: string, now: Date): UpdatePlan | null {
  const beforeSer = toUiLead(before)!;
  const cellPatch: Record<string, Date | null | string> = {};
  const changes: Change[] = [];
  for (const k of Object.keys(patch)) {
    if (k === '_row' || k.startsWith('_') || UNTOUCHABLE.includes(k)) continue;
    if (FOLLOWUP_RE.test(k) && patch[k] === beforeSer[k]) continue;
    const newVal = toCellValue(k, patch[k]);
    if (newVal === undefined) continue;
    const oldSer = beforeSer[k] === undefined ? '' : beforeSer[k];
    const newSer = cellToUi(k, newVal);
    if (String(oldSer) === String(newSer)) continue;
    if (FOLLOWUP_RE.test(k) && String(oldSer).trim() && ctx && ctx.user && !can(ctx.user, 'leads.editHistory')) {
      throw fail('FORBIDDEN', 'Earlier follow-up remarks cannot be changed or removed. Add a new remark instead, or ask a manager to correct it.');
    }
    cellPatch[k] = newVal;
    changes.push({ field: k, from: oldSer, to: newSer });
  }
  if (!changes.length) return null;

  const newStage = cellPatch[L.STAGE] as string | undefined;
  const oldStage = str(before.stage);
  // Trashing / restoring is a 'leads.trash' permission even when done through a generic update
  if (ctx && ctx.user && newStage !== undefined && (newStage === S.TRASH || oldStage === S.TRASH) && !can(ctx.user, 'leads.trash')) {
    throw fail('FORBIDDEN', 'Your role cannot move leads to or from the Recycle Bin');
  }
  if (newStage !== undefined && newStage === S.BOOKED && !parseDate(before.bookingDate) && cellPatch[L.BOOKING_DATE] === undefined) {
    cellPatch[L.BOOKING_DATE] = now;
  }
  const newSvs = cellPatch[L.SITE_VISIT_STATUS] as string | undefined;
  if (newSvs !== undefined && cellPatch[L.SITE_VISIT_DATE] === undefined) {
    if (newSvs === CFG.SITE_VISIT.COMPLETED || newSvs === CFG.SITE_VISIT.WALK_IN) cellPatch[L.SITE_VISIT_DATE] = now;
    else if (newSvs === CFG.SITE_VISIT.SCHEDULED && !parseDate(before.siteVisitDate)) {
      // scheduled: use next follow-up as the planned visit date when present
      cellPatch[L.SITE_VISIT_DATE] = parseDate(cellPatch[L.NEXT_FOLLOWUP] || before.nextFollowupAt) || now;
    }
  }
  const dp = fromUiPatch(cellPatch);
  const set: Partial<LeadDoc> = { ...dp.set, updatedAt: now, updatedBy: actor };
  const next: LeadDoc = { ...before, ...set };
  if (Object.keys(dp.followups).length) set.followups = next.followups = applyFollowupEdits(before.followups || [], dp.followups, actor);
  if (Object.keys(dp.extra).length) set.extra = next.extra = { ...(before.extra || {}), ...dp.extra };
  return {
    changes, set, next, oldStage, newStage, oldSvs: str(before.siteVisitStatus), newSvs,
    rm: cellPatch[L.RM] as string | undefined, nextFollowupTouched: cellPatch[L.NEXT_FOLLOWUP] !== undefined,
  };
}

/** Timeline entries + events of Leads_update. */
function updateEffects(id: string, p: UpdatePlan, after: UiLead, actor: string): Effects {
  const out: Effects = { timeline: [], events: [] };
  const name = after[L.NAME];
  if (p.newStage !== undefined && p.newStage !== p.oldStage) {
    out.timeline.push(tl(id, 'stage_changed', 'Stage changed: ' + (p.oldStage || '—') + ' → ' + p.newStage, '', actor));
    if (p.newStage === S.BOOKED) {
      out.timeline.push(tl(id, 'booking', 'Booking recorded', (after[L.UNIT_TYPE] || '') + ' ' + (after[L.NOTES] ? '· ' + truncate(after[L.NOTES], 120) : ''), actor));
      out.events.push(ev('lead_booked', id, 'Unit booked: ' + name, (after[L.UNIT_TYPE] || 'Unit') + ' · RM ' + (after[L.RM] || '—'), actor));
    } else if (p.newStage === S.TRASH) {
      out.events.push(ev('lead_trashed', id, 'Lead moved to trash: ' + name, 'by ' + actor, actor));
    } else {
      out.events.push(ev('stage_changed', id, name + ': ' + (p.oldStage || '—') + ' → ' + p.newStage, 'Updated by ' + actor, actor));
    }
  }
  if (p.newSvs !== undefined && p.newSvs !== p.oldSvs) {
    const svs = p.newSvs;
    const kind = svs === CFG.SITE_VISIT.SCHEDULED ? 'site_visit_scheduled'
      : svs === CFG.SITE_VISIT.COMPLETED || svs === CFG.SITE_VISIT.WALK_IN ? 'site_visit_completed' : 'site_visit_status';
    out.timeline.push(tl(id, kind, 'Site visit: ' + svs, after[L.SITE_VISIT_DATE] ? fmtHuman(after[L.SITE_VISIT_DATE]) : '', actor));
    if (kind !== 'site_visit_status') out.events.push(ev(kind, id, name + ' · ' + svs, 'RM ' + (after[L.RM] || '—'), actor));
  }
  if (p.rm !== undefined) {
    out.timeline.push(tl(id, 'rm_assigned', 'Assigned to ' + p.rm, '', actor));
    out.events.push(ev('rm_assigned', id, name + ' assigned to ' + p.rm, 'by ' + actor, actor));
  }
  if (p.nextFollowupTouched) {
    out.timeline.push(tl(id, 'followup_scheduled', 'Next follow-up set', fmtHuman(p.next.nextFollowupAt) || 'cleared', actor));
  }
  const skip = [L.STAGE, L.SITE_VISIT_STATUS, L.RM, L.NEXT_FOLLOWUP, L.BOOKING_DATE, L.SITE_VISIT_DATE, L.LAST_FOLLOWUP];
  const other = p.changes.map((c) => c.field).filter((f) => !skip.includes(f) && !FOLLOWUP_RE.test(f));
  if (other.length) out.timeline.push(tl(id, 'lead_updated', 'Details updated', other.join(', '), actor));
  return out;
}

const auditDiff = (changes: Change[]) => ({
  before: Object.fromEntries(changes.map((c) => [c.field, c.from])),
  after: Object.fromEntries(changes.map((c) => [c.field, c.to])),
});

export async function updateLead(
  id: string, patch: Partial<UiLead>, ctx: Ctx | null, expectedUpdatedAt?: string
): Promise<{ lead: UiLead; version: string; changes?: Change[]; unchanged?: boolean }> {
  if (!id) throw fail('VALIDATION', 'Lead id is required');
  if (!patch || typeof patch !== 'object') throw fail('VALIDATION', 'Nothing to update');
  const actor = actorOf(ctx);
  const leads = await leadsCol();

  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await leads.findOne({ _id: String(id) });
    if (!before) throw fail('NOT_FOUND', 'Lead not found: ' + id);
    const exp = expectedUpdatedAt ? parseDate(expectedUpdatedAt) : null;
    if (exp && before.updatedAt && new Date(before.updatedAt).getTime() > exp.getTime() + 1000) {
      throw fail('CONFLICT', 'This lead was modified by someone else. Review the latest version before saving.', { lead: toUiLead(before) });
    }
    const plan = planUpdate(before, patch as Record<string, unknown>, ctx, actor, new Date());
    if (!plan) return { lead: toUiLead(before)!, version: await getVersion(), unchanged: true };

    // conditional write: only if nobody saved in between
    const res = await leads.updateOne({ _id: before._id, updatedAt: before.updatedAt ?? null } as any, { $set: plan.set });
    if (!res.matchedCount) continue; // re-read and re-check (a stale expectedUpdatedAt then fails above)

    const after = toUiLead(plan.next)!;
    await runEffects(updateEffects(before._id, plan, after, actor));
    await auditLog(ctx, 'Lead Updated', 'Lead', before._id, plan.changes.map((c) => c.field).join(', '), auditDiff(plan.changes));
    if (plan.rm) scheduleLeadAlerts(after, 'assigned'); // tell the newly assigned RM
    return { lead: after, version: await bumpVersion(), changes: plan.changes };
  }
  throw fail('CONFLICT', 'This lead is being edited by someone else right now. Please try again.');
}

/* --------------------------- follow-up remarks --------------------------- */

export async function appendRemark(
  id: string, remark: string, ctx: Ctx | null, nextFollowup?: string, actorName?: string
): Promise<{ index: number; timestamp: string; value: string; lead: UiLead; version: string }> {
  const text = String(remark || '').trim();
  if (!text) throw fail('VALIDATION', 'Remark cannot be empty');
  // actorName: who logged it when there is no signed-in user (e.g. a lead source)
  const actor = actorOf(ctx, actorName || 'System');
  const cap = Number((await settingsAll()).maxFollowups) || CFG.MAX_FOLLOWUPS;
  const nf = nextFollowup !== undefined && nextFollowup !== null && nextFollowup !== '' ? parseDate(nextFollowup) : null;
  const leads = await leadsCol();

  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await leads.findOne({ _id: String(id) }, { projection: { followups: 1, stage: 1, enquiryDate: 1, createdAt: 1 } });
    if (!cur) throw fail('NOT_FOUND', 'Lead not found: ' + id);
    const target = nextFollowupSlot(cur);
    if (target > cap) throw fail('VALIDATION', `Follow-up limit (${cap}) reached for this lead`);
    const now = new Date();
    const value = fmtSheet(now) + ' — ' + text;
    const set: Partial<LeadDoc> = { lastFollowupAt: now, updatedAt: now, updatedBy: actor };
    // no date given: the follow-up sequence schedules the next step (null when it is over or switched off)
    const auto = nf ? null : sequenceNextFollowup(parseSequence((await settingsAll()).followupSequence), { stage: String(cur.stage || ''), enquiryDate: cur.enquiryDate, createdAt: cur.createdAt }, target, now);
    if (nf || auto) set.nextFollowupAt = nf || auto;
    // atomic: the slot must still be free
    const doc = await leads.findOneAndUpdate(
      { _id: cur._id, 'followups.n': { $ne: target } } as any,
      { $push: { followups: { $each: [{ n: target, at: now, text, by: actor }], $sort: { n: 1 } } } as any, $set: set },
      { returnDocument: 'after' }
    );
    if (!doc) continue;
    await addTimeline(cur._id, 'remark_added', 'Follow-up #' + target + ' logged', text, actor, 'Lead', cur._id);
    if (nf) await addTimeline(cur._id, 'followup_scheduled', 'Next follow-up set', fmtHuman(nf), actor, 'Lead', cur._id);
    else if (auto) await addTimeline(cur._id, 'followup_scheduled', 'Next follow-up scheduled automatically', fmtHuman(auto), 'System', 'Lead', cur._id);
    await auditLog(ctx, 'Follow-up Logged', 'Lead', cur._id, truncate(text, 120));
    return { index: target, timestamp: now.toISOString(), value, lead: toUiLead(doc)!, version: await bumpVersion() };
  }
  throw fail('CONFLICT', 'Another follow-up was being saved at the same time. Please try again.');
}

/* ------------------------------- archive -------------------------------- */

let txSupport: Promise<boolean> | null = null;
/** Transactions need a replica set or mongos (Atlas: yes; a standalone dev/test mongod: no). */
function supportsTransactions(): Promise<boolean> {
  txSupport ||= (async () => {
    try {
      const client = await getClient();
      if (!client) return false;
      const h: any = await client.db('admin').command({ hello: 1 });
      return !!(h.setName || h.msg === 'isdbgrid');
    } catch {
      return false;
    }
  })();
  return txSupport;
}

/** Move the lead to the archive collection (with archivedAt/archivedBy) and remove it from leads. */
export async function archiveLead(id: string, ctx: Ctx | null): Promise<{ version: string }> {
  const actor = actorOf(ctx);
  const leads = await leadsCol();
  const archive = await archiveCol();
  const doc = await leads.findOne({ _id: String(id) });
  if (!doc) throw fail('NOT_FOUND', 'Lead not found: ' + id);
  const archived: ArchivedLeadDoc = { ...doc, archivedAt: new Date(), archivedBy: actor };

  const client = await getClient();
  if (client && (await supportsTransactions())) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await archive.replaceOne({ _id: doc._id }, archived, { upsert: true, session });
        const del = await leads.deleteOne({ _id: doc._id }, { session });
        if (!del.deletedCount) throw fail('NOT_FOUND', 'Lead not found: ' + id);
      });
    } finally {
      await session.endSession();
    }
  } else {
    // standalone server: insert first (idempotent), then delete
    await archive.replaceOne({ _id: doc._id }, archived, { upsert: true });
    await leads.deleteOne({ _id: doc._id });
  }
  await addTimeline(doc._id, 'lead_deleted', 'Lead permanently removed (archived)', '', actor, 'Lead', doc._id);
  await auditLog(ctx, 'Lead Deleted', 'Lead', doc._id, 'Moved to Archived Leads');
  return { version: await bumpVersion() };
}

/* ------------------------------- timeline ------------------------------- */

/** Full timeline for a lead, newest first. Includes synthesized entries for legacy follow-ups. */
export async function timelineForLead(id: string): Promise<any[]> {
  const leadId = String(id || '');
  const rows = await (await col(CFG.COLL.TIMELINE)).find({ leadId }).toArray();
  const entries: any[] = rows.map(serializeTimeline);
  const lead = await getLead(leadId);
  if (lead) {
    const have = new Set(entries.filter((e) => e.type === 'remark_added').map((e) => e.title));
    for (const k of Object.keys(lead)) {
      const fm = k.match(FOLLOWUP_RE);
      if (!fm) continue;
      const i = Number(fm[1]);
      const raw = String(lead[k] || '').trim();
      if (!raw) continue;
      const title = 'Follow-up #' + i + ' logged';
      if (have.has(title)) continue;
      const m = raw.match(/^(.+?)\s+[—–-]\s+([\s\S]*)$/);
      const d = m ? parseDate(m[1]) : null;
      entries.push({ id: 'legacy_fu_' + i, leadId, timestamp: d ? d.toISOString() : lead[L.ENQUIRY_DATE] || '', type: 'remark_added', title, details: m ? m[2] : raw, actor: '', refType: 'Lead', refId: leadId });
    }
    if (!entries.some((e) => e.type === 'lead_created')) {
      entries.push({ id: 'legacy_created', leadId, timestamp: lead[L.CREATED_AT] || lead[L.ENQUIRY_DATE] || '', type: 'lead_created', title: 'Enquiry created', details: lead[L.SOURCE] || '', actor: '', refType: 'Lead', refId: leadId });
    }
  }
  entries.sort((a, b) => (new Date(b.timestamp).getTime() || 0) - (new Date(a.timestamp).getTime() || 0));
  return entries;
}

/* -------------------------------- import -------------------------------- */

/**
 * Bulk import. strategy: 'SKIP' (keep existing), 'OVERWRITE' (replace provided fields), 'CREATE_COPY'.
 * Matching: Enquiry ID first, then phone number (against the leads that existed before the import).
 * Everything is planned first (one read for all matches), then written with bulkWrite.
 */
export async function importLeads(rows: UiLead[], strategy: string, ctx: Ctx | null): Promise<{ created: number; updated: number; skipped?: number; version: string }> {
  if (!Array.isArray(rows) || !rows.length) throw fail('VALIDATION', 'No leads supplied');
  if (rows.length > IMPORT_MAX_ROWS) throw fail('VALIDATION', `Too many rows (${rows.length}). Import at most ${IMPORT_MAX_ROWS} leads at a time.`);
  const strat = String(strategy || 'SKIP').toUpperCase();
  const actor = actorOf(ctx);
  const leads = await leadsCol();

  const ids = [...new Set(rows.map((r) => str(r && r[L.ID])).filter(Boolean))];
  const phones = [...new Set(rows.map((r) => last10(r && r[L.PHONE])).filter((p) => p.length === 10))];
  const existing = await leads.find({ $or: [{ _id: { $in: ids } }, { phoneLast10: { $in: phones } }] }).sort({ createdAt: 1, _id: 1 }).toArray();
  const byId = new Map<string, LeadDoc>(), byPhone = new Map<string, LeadDoc>();
  for (const d of existing) {
    byId.set(d._id, d);
    if (d.phoneLast10 && d.phoneLast10.length === 10) byPhone.set(d.phoneLast10, d);
  }
  const archivedIds = new Set((await (await archiveCol()).find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
  const counterStart = await counterValue('ENQ');

  const now = new Date();
  let updated = 0, skipped = 0;
  const creates: Array<{ obj: Record<string, unknown>; id: string }> = [];
  const usedIds = new Set<string>();
  const createdPhones = new Set<string>();
  const updates = new Map<string, { before: LeadDoc; cur: LeadDoc; set: Partial<LeadDoc>; effects: Effects; changes: Change[] }>();
  const errors: string[] = [];

  rows.forEach((incoming, i) => {
    if (!incoming || typeof incoming !== 'object') {
      errors.push(`Row ${i + 1}: not a lead object`);
      return;
    }
    const inId = str(incoming[L.ID]);
    const p = last10(incoming[L.PHONE]);
    const match = (inId && byId.get(inId)) || (p.length === 10 ? byPhone.get(p) : undefined);
    if (match && strat === 'SKIP') { skipped++; return; }
    if (match && strat === 'OVERWRITE') {
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(incoming)) if (incoming[k] !== '' && incoming[k] !== undefined && k !== L.ID) patch[k] = incoming[k];
      const u = updates.get(match._id) || { before: match, cur: match, set: {}, effects: { timeline: [], events: [] }, changes: [] };
      const plan = planUpdate(u.cur, patch, ctx, actor, now);
      if (plan) {
        u.cur = plan.next;
        Object.assign(u.set, plan.set);
        const e = updateEffects(match._id, plan, toUiLead(plan.next)!, actor);
        u.effects.timeline.push(...e.timeline);
        u.effects.events.push(...e.events);
        u.changes.push(...plan.changes);
      }
      updates.set(match._id, u);
      updated++;
      return;
    }
    // create (a copy when matched)
    if (!String(incoming[L.NAME] || '').trim()) {
      errors.push(`Row ${i + 1}: Prospect Name is required`);
      return;
    }
    // same phone as an earlier row of this file: only CREATE_COPY creates it again
    if (!match && p.length === 10 && createdPhones.has(p) && strat !== 'CREATE_COPY') { skipped++; return; }
    if (p.length === 10) createdPhones.add(p);
    let id = '';
    if (!match && inId && SAFE_ID.test(inId) && !usedIds.has(inId) && !archivedIds.has(inId)) {
      const m = inId.match(/^ENQ-(\d+)$/);
      if (m ? parseInt(m[1], 10) > counterStart : !/^\d/.test(inId)) id = inId;
    }
    if (id) usedIds.add(id);
    creates.push({ obj: incoming, id });
  });
  if (errors.length) throw fail('VALIDATION', errors.slice(0, 5).join('; ') + (errors.length > 5 ? ` (+${errors.length - 5} more)` : ''), { errors: errors.slice(0, 100) });

  // ids: keep accepted explicit ids above the counter, then reserve one block for the rest
  const maxExplicit = creates.reduce((mx, c) => {
    const m = c.id.match(/^ENQ-(\d+)$/);
    return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
  }, 0);
  if (maxExplicit) await ensureCounterAtLeast('seq:ENQ', maxExplicit);
  const need = creates.filter((c) => !c.id).length;
  let nextNum = need ? await reserveSeq('ENQ', need) : 0;
  const newDocs = creates.map((c) => {
    const id = c.id || `ENQ-${String(nextNum++).padStart(4, '0')}`;
    return buildNewDoc(id, c.obj, actor, now);
  });

  // write
  const ops: AnyBulkWriteOperation<LeadDoc>[] = [
    ...newDocs.map((d) => ({ insertOne: { document: d } })),
    ...[...updates.values()].filter((u) => Object.keys(u.set).length).map((u) => ({ updateOne: { filter: { _id: u.before._id }, update: { $set: u.set } } })),
  ];
  for (let i = 0; i < ops.length; i += 1000) {
    const chunk = ops.slice(i, i + 1000);
    try {
      await leads.bulkWrite(chunk, { ordered: false });
    } catch (e: any) {
      // an explicit id taken concurrently: give those rows fresh ids
      const failed: any[] = (e?.writeErrors || []).filter((w: any) => w.code === 11000);
      if (!failed.length || failed.length !== (e?.writeErrors || []).length) throw e;
      for (const w of failed) {
        const op: any = chunk[w.index];
        if (!op.insertOne) throw e;
        const doc: LeadDoc = op.insertOne.document;
        doc._id = await nextSeq('ENQ', 4);
        await leads.insertOne(doc);
      }
    }
  }

  // timeline, events, audit
  const timeline: TlArgs[] = [];
  const events: EvArgs[] = [];
  for (const d of newDocs) {
    const e = createdEffects(toUiLead(d)!, actor, 'import');
    timeline.push(...e.timeline);
    events.push(...e.events);
  }
  for (const u of updates.values()) {
    timeline.push(...u.effects.timeline);
    events.push(...u.effects.events);
  }
  try {
    await insertTimelineBulk(timeline);
    if (events.length <= IMPORT_EVENT_LIMIT) await insertEventsBulk(events);
    else await addEvent('leads_imported', 'Import', '', `Leads imported: ${newDocs.length} created, ${updated} updated`, `${skipped} skipped · by ${actor}`, actor, { source: 'import' });
    await insertAuditBulk(ctx, [
      ...newDocs.map((d) => ({ action: 'Lead Created', entityId: d._id, details: d.name })),
      ...[...updates.values()].filter((u) => u.changes.length).map((u) => ({ action: 'Lead Updated', entityId: u.before._id, details: u.changes.map((c) => c.field).join(', ') })),
    ]);
  } catch (e: any) {
    await logError('leads.import.effects', 'INTERNAL', e?.message, e?.stack, ctx?.user?.email || '', {});
  }
  await auditLog(ctx, 'Leads Imported', 'Import', '', `${newDocs.length} created, ${updated} updated, ${skipped} skipped`);
  return { created: newDocs.length, updated, skipped, version: await bumpVersion() };
}

/** Actions on one lead first check that the caller may see it (RMs: own leads — server/core/scope.ts). */
const onLead = <T>(fn: (d: any, ctx: Ctx) => Promise<T>) => async (d: any, ctx: Ctx) => {
  await assertLeadAccess(ctx, d.id);
  return fn(d, ctx);
};

export const actions: ActionMap = {
  getAllLeads: { fn: (_d, ctx) => getAllLeads(ctx), perm: 'leads.view' },
  addLead: { fn: (d, ctx) => addLead(d.data, ctx), perm: 'leads.create' },
  updateLead: { fn: onLead((d, ctx) => updateLead(d.id, d.data, ctx, d.expectedUpdatedAt)), perm: 'leads.edit' },
  appendRemark: { fn: onLead((d, ctx) => appendRemark(d.id, d.remark, ctx, d.nextFollowup)), perm: 'leads.edit' },
  setLeadStage: { fn: onLead((d, ctx) => updateLead(d.id, { [L.STAGE]: d.stage }, ctx)), perm: 'leads.edit' },
  trashLead: { fn: onLead((d, ctx) => updateLead(d.id, { [L.STAGE]: S.TRASH }, ctx)), perm: 'leads.trash' },
  restoreLead: { fn: onLead((d, ctx) => updateLead(d.id, { [L.STAGE]: S.NEW }, ctx)), perm: 'leads.trash' },
  deleteLead: { fn: onLead((d, ctx) => archiveLead(d.id, ctx)), perm: 'leads.delete' },
  getLeadTimeline: { fn: onLead((d) => timelineForLead(d.id)), perm: 'leads.view' },
  importLeads: { fn: (d, ctx) => importLeads(d.leads, d.strategy, ctx), perm: 'leads.import' },
};
