/**
 * Channel partners (brokers) — Release E.
 *
 * A channel partner brings leads and earns brokerage on the units those leads book. This module holds:
 *   channelPartners   the partner's details, status and commission rate (with optional deal-value slabs)
 *   cpCommissions     one accrual per booked unit (keyed by the unit's inventory id): deal value × rate, with
 *                     the rate resolved at booking time. Never deleted — a cancelled booking VOIDS it and it stays.
 *
 * Lead attribution lives on the lead document (`channelPartnerId`, `cpRegisteredAt`), not in a side table, so the
 * existing lead scope and queries see it. Registration follows "first CP keeps it": the first partner to register a
 * phone owns it for CFG.CP_REGISTRATION_DAYS; within that window another partner is refused, after it they may claim.
 *
 * v1 is accrual only — what is owed. Recording actual payouts to partners is a planned follow-up.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import type { LeadDoc } from '../core/leadShape';
import { visibleLeadIds } from '../core/scope';
import { last10, shortId, str, truncate } from '../core/utils';

/* -------------------------------- types ---------------------------------- */

export interface CommissionSlab { minValue: number; rate: number }

export interface PartnerDoc {
  _id: string; // CP-0001
  name: string;
  firm: string;
  phone: string;
  phoneLast10: string;
  email: string;
  pan: string;
  gst: string;
  reraId: string;
  /** Default brokerage, as a percentage of the deal value (e.g. 2 = 2%). */
  defaultRate: number;
  /** Optional deal-value slabs: the rate of the highest slab whose minValue ≤ deal value wins, else defaultRate. */
  slabs: CommissionSlab[];
  status: 'Active' | 'Suspended';
  notes: string;
  createdAt: Date;
  createdBy: string;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface CommissionDoc {
  _id: string; // the unit's inventory id — one accrual per booked unit
  cpId: string;
  leadId: string;
  unitId: string;
  unitLabel: string;
  dealValue: number;
  rate: number;
  amount: number;
  status: 'accrued' | 'void';
  computedAt: Date;
  computedBy: string;
  voidedAt?: Date;
  voidReason?: string;
}

export interface PartnerView {
  id: string; name: string; firm: string; phone: string; email: string; pan: string; gst: string; reraId: string;
  defaultRate: number; slabs: CommissionSlab[]; status: 'Active' | 'Suspended'; notes: string;
  createdAt: string;
  /** Aggregates (commission totals only for callers with partners.commission). */
  leads: number; bookings: number; commissionAccrued: number | null;
}

const partners = () => col<PartnerDoc>(CFG.COLL.CHANNEL_PARTNERS);
const commissions = () => col<CommissionDoc>(CFG.COLL.CP_COMMISSIONS);
const leads = () => col<LeadDoc>(CFG.COLL.LEADS);

const actorOf = (ctx: Ctx | null | undefined) => ctx?.user?.name || 'System';
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v: unknown) => Math.max(0, Math.round(num(v)));
const rate = (v: unknown) => Math.min(100, Math.max(0, Math.round(num(v) * 100) / 100));

function cleanSlabs(v: unknown): CommissionSlab[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s: any) => ({ minValue: money(s?.minValue), rate: rate(s?.rate) }))
    .filter((s) => s.minValue > 0 && s.rate > 0)
    .sort((a, b) => a.minValue - b.minValue)
    .slice(0, 10);
}

/** The commission rate for a deal: the highest slab whose minValue ≤ the value, else the partner's default. */
export function rateForDeal(cp: Pick<PartnerDoc, 'defaultRate' | 'slabs'>, dealValue: number): number {
  let r = num(cp.defaultRate);
  for (const s of cp.slabs || []) if (dealValue >= s.minValue) r = s.rate;
  return r;
}

/* -------------------------------- views ---------------------------------- */

function toView(doc: PartnerDoc, agg: { leads: number; bookings: number; accrued: number } | undefined, seeMoney: boolean): PartnerView {
  return {
    id: doc._id, name: str(doc.name), firm: str(doc.firm), phone: str(doc.phone), email: str(doc.email),
    pan: str(doc.pan), gst: str(doc.gst), reraId: str(doc.reraId), defaultRate: num(doc.defaultRate),
    slabs: doc.slabs || [], status: doc.status === 'Suspended' ? 'Suspended' : 'Active', notes: str(doc.notes),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : '',
    leads: agg?.leads || 0, bookings: agg?.bookings || 0, commissionAccrued: seeMoney ? agg?.accrued || 0 : null,
  };
}

/** Leads attributed per partner, and booked-unit commission totals per partner. */
async function aggregates(): Promise<Map<string, { leads: number; bookings: number; accrued: number }>> {
  const out = new Map<string, { leads: number; bookings: number; accrued: number }>();
  const touch = (id: string) => { if (!out.has(id)) out.set(id, { leads: 0, bookings: 0, accrued: 0 }); return out.get(id)!; };
  for (const r of await (await leads()).aggregate<{ _id: string; n: number }>([
    { $match: { channelPartnerId: { $exists: true, $nin: ['', null] } } },
    { $group: { _id: '$channelPartnerId', n: { $sum: 1 } } },
  ]).toArray()) touch(str(r._id)).leads = r.n;
  for (const r of await (await commissions()).aggregate<{ _id: string; n: number; amount: number }>([
    { $match: { status: 'accrued' } },
    { $group: { _id: '$cpId', n: { $sum: 1 }, amount: { $sum: '$amount' } } },
  ]).toArray()) { const a = touch(str(r._id)); a.bookings = r.n; a.accrued = r.amount; }
  return out;
}

export async function listPartners(_d: any, ctx: Ctx): Promise<{ partners: PartnerView[] }> {
  const seeMoney = can(ctx.user, 'partners.commission');
  const [docs, agg] = await Promise.all([(await partners()).find({}).sort({ createdAt: 1 }).toArray(), aggregates()]);
  return { partners: docs.map((d) => toView(d, agg.get(d._id), seeMoney)) };
}

export async function getPartner(d: any, ctx: Ctx): Promise<PartnerView> {
  const doc = await (await partners()).findOne({ _id: str(d?.id) });
  if (!doc) throw fail('NOT_FOUND', 'Channel partner not found');
  return toView(doc, (await aggregates()).get(doc._id), can(ctx.user, 'partners.commission'));
}

/* ------------------------------ create / edit ---------------------------- */

function validate(d: any): Partial<PartnerDoc> {
  const name = truncate(str(d?.name).trim(), 120);
  if (!name) throw fail('VALIDATION', 'Partner name is required');
  const phone = str(d?.phone).trim();
  const set: Partial<PartnerDoc> = {
    name,
    firm: truncate(str(d?.firm).trim(), 120),
    phone,
    phoneLast10: last10(phone),
    email: truncate(str(d?.email).trim(), 160),
    pan: truncate(str(d?.pan).trim().toUpperCase(), 20),
    gst: truncate(str(d?.gst).trim().toUpperCase(), 20),
    reraId: truncate(str(d?.reraId).trim(), 40),
    defaultRate: rate(d?.defaultRate),
    slabs: cleanSlabs(d?.slabs),
    notes: truncate(str(d?.notes).trim(), 2000),
    status: d?.status === 'Suspended' ? 'Suspended' : 'Active',
  };
  return set;
}

export async function savePartner(d: any, ctx: Ctx): Promise<PartnerView> {
  const set = validate(d);
  const id = str(d?.id);
  if (id) {
    const existing = await (await partners()).findOne({ _id: id });
    if (!existing) throw fail('NOT_FOUND', 'Channel partner not found');
    await (await partners()).updateOne({ _id: id }, { $set: { ...set, updatedAt: new Date(), updatedBy: actorOf(ctx) } });
    await auditLog(ctx, 'Channel Partner Updated', 'ChannelPartner', id, set.name || '');
    await bumpVersion();
    return getPartner({ id }, ctx);
  }
  const newId = await nextSeq('CP', 4);
  const doc: PartnerDoc = { _id: newId, firm: '', phone: '', phoneLast10: '', email: '', pan: '', gst: '', reraId: '', defaultRate: 0, slabs: [], notes: '', status: 'Active', ...set, name: set.name!, createdAt: new Date(), createdBy: actorOf(ctx) } as PartnerDoc;
  await (await partners()).insertOne(doc);
  await auditLog(ctx, 'Channel Partner Added', 'ChannelPartner', newId, doc.name);
  await bumpVersion();
  return getPartner({ id: newId }, ctx);
}

export async function setPartnerStatus(d: any, ctx: Ctx): Promise<PartnerView> {
  const id = str(d?.id);
  const status = d?.status === 'Suspended' ? 'Suspended' : 'Active';
  const r = await (await partners()).updateOne({ _id: id }, { $set: { status, updatedAt: new Date(), updatedBy: actorOf(ctx) } });
  if (!r.matchedCount) throw fail('NOT_FOUND', 'Channel partner not found');
  await auditLog(ctx, 'Channel Partner ' + (status === 'Suspended' ? 'Suspended' : 'Reactivated'), 'ChannelPartner', id, '');
  await bumpVersion();
  return getPartner({ id }, ctx);
}

export async function deletePartner(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const id = str(d?.id);
  const doc = await (await partners()).findOne({ _id: id });
  if (!doc) throw fail('NOT_FOUND', 'Channel partner not found');
  const attributed = await (await leads()).countDocuments({ channelPartnerId: id });
  if (attributed > 0) throw fail('VALIDATION', `This partner has ${attributed} lead${attributed === 1 ? '' : 's'} attributed. Re-attribute or remove those first, or suspend the partner instead.`);
  await (await partners()).deleteOne({ _id: id });
  await (await commissions()).deleteMany({ cpId: id });
  await auditLog(ctx, 'Channel Partner Deleted', 'ChannelPartner', id, doc.name);
  await bumpVersion();
  return { ok: true };
}

/* ---------------------------- attribution -------------------------------- */

const windowStart = () => new Date(Date.now() - CFG.CP_REGISTRATION_DAYS * 86_400_000);

export interface RegistrationResult { registered: boolean; partnerId: string; partnerName: string; until: string; leadId: string }

/** Is this phone already registered to a channel partner within the window? */
export async function checkRegistration(d: any, _ctx: Ctx): Promise<RegistrationResult> {
  const phone10 = last10(d?.phone);
  const none: RegistrationResult = { registered: false, partnerId: '', partnerName: '', until: '', leadId: '' };
  if (!phone10) return none;
  const hit = await (await leads()).findOne(
    { phoneLast10: phone10, channelPartnerId: { $nin: ['', null] }, cpRegisteredAt: { $gte: windowStart() } } as any,
    { projection: { channelPartnerId: 1, cpRegisteredAt: 1 } },
  );
  if (!hit?.channelPartnerId || !hit.cpRegisteredAt) return none;
  const cp = await (await partners()).findOne({ _id: hit.channelPartnerId }, { projection: { name: 1 } });
  const until = new Date(new Date(hit.cpRegisteredAt).getTime() + CFG.CP_REGISTRATION_DAYS * 86_400_000);
  return { registered: true, partnerId: str(hit.channelPartnerId), partnerName: str(cp?.name), until: until.toISOString(), leadId: str(hit._id) };
}

/** Search leads to attribute to a partner: digits match the phone, otherwise the name. Scoped to what the user may see. */
export async function findLeadsForPartner(d: any, ctx: Ctx): Promise<{ leads: Array<{ id: string; name: string; phone: string; stage: string; partnerId: string }> }> {
  const q = str(d?.query).trim();
  if (q.length < 2) return { leads: [] };
  const digits = q.replace(/\D/g, '');
  const filter = digits.length >= 3
    ? { phoneLast10: { $regex: digits.slice(-10) } }
    : { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
  const visible = await visibleLeadIds(ctx.user as any);
  const rows = await (await leads()).find(filter as any, { projection: { name: 1, phone: 1, stage: 1, channelPartnerId: 1 } }).limit(25).toArray();
  const out = rows
    .filter((r) => !visible || visible.has(r._id))
    .slice(0, 15)
    .map((r) => ({ id: r._id, name: str(r.name), phone: str(r.phone), stage: str(r.stage), partnerId: str(r.channelPartnerId) }));
  return { leads: out };
}

export async function attributeLead(d: any, ctx: Ctx): Promise<{ ok: true; leadId: string; partnerId: string }> {
  const leadId = str(d?.leadId);
  const cpId = str(d?.cpId);
  const lead = await (await leads()).findOne({ _id: leadId });
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const cp = await (await partners()).findOne({ _id: cpId });
  if (!cp) throw fail('NOT_FOUND', 'Channel partner not found');
  if (cp.status === 'Suspended') throw fail('VALIDATION', 'This channel partner is suspended. Reactivate them to attribute leads.');
  const phone10 = lead.phoneLast10 || last10(lead.phone);
  if (phone10) {
    const conflict = await (await leads()).findOne(
      { phoneLast10: phone10, channelPartnerId: { $nin: ['', null] }, cpRegisteredAt: { $gte: windowStart() } } as any,
      { projection: { channelPartnerId: 1, cpRegisteredAt: 1 } },
    );
    if (conflict?.channelPartnerId && conflict.channelPartnerId !== cpId) {
      const other = await (await partners()).findOne({ _id: conflict.channelPartnerId }, { projection: { name: 1 } });
      const until = new Date(new Date(conflict.cpRegisteredAt as Date).getTime() + CFG.CP_REGISTRATION_DAYS * 86_400_000);
      throw fail('CONFLICT', `This phone is already registered by ${other?.name || 'another partner'} until ${until.toLocaleDateString('en-IN')}. Only that partner can bring this lead until then.`);
    }
  }
  await (await leads()).updateOne({ _id: leadId }, { $set: { channelPartnerId: cpId, cpRegisteredAt: new Date(), source: 'Channel Partner', subSource: cp.name } });
  await addTimeline(leadId, 'partner', `Attributed to channel partner ${cp.name}`, cp.firm || '', actorOf(ctx), 'ChannelPartner', cpId);
  await auditLog(ctx, 'Lead Attributed to Channel Partner', 'Lead', leadId, cp.name);
  await bumpVersion();
  return { ok: true, leadId, partnerId: cpId };
}

/**
 * Attribute a just-ingested lead to the partner that owns its lead source. Conflict-aware and NEVER throws — a webhook
 * must never fail to create a lead. Returns whether it attributed, and why not. Honours first-CP-keeps-it: if the phone
 * is already registered to a different partner within the window, the lead is left as-is (not stolen).
 */
export async function attributeFromSource(leadId: string, cpId: string, actor: string): Promise<{ attributed: boolean; reason: string }> {
  try {
    if (!leadId || !cpId) return { attributed: false, reason: 'missing lead or partner' };
    const cp = await (await partners()).findOne({ _id: cpId });
    if (!cp || cp.status === 'Suspended') return { attributed: false, reason: 'partner missing or suspended' };
    const lead = await (await leads()).findOne({ _id: leadId }, { projection: { phone: 1, phoneLast10: 1 } });
    if (!lead) return { attributed: false, reason: 'lead not found' };
    const phone10 = lead.phoneLast10 || last10(lead.phone);
    if (phone10) {
      const conflict = await (await leads()).findOne(
        { _id: { $ne: leadId }, phoneLast10: phone10, channelPartnerId: { $nin: ['', null] }, cpRegisteredAt: { $gte: windowStart() } } as any,
        { projection: { channelPartnerId: 1 } },
      );
      if (conflict?.channelPartnerId && conflict.channelPartnerId !== cpId) {
        const other = await (await partners()).findOne({ _id: conflict.channelPartnerId }, { projection: { name: 1 } });
        await addTimeline(leadId, 'partner', 'Not attributed to the source partner', `This phone is already registered to ${other?.name || 'another partner'} (first-partner-keeps-it).`, actor, 'ChannelPartner', cpId);
        return { attributed: false, reason: `already registered to ${other?.name || 'another partner'}` };
      }
    }
    await (await leads()).updateOne({ _id: leadId }, { $set: { channelPartnerId: cpId, cpRegisteredAt: new Date(), subSource: cp.name } });
    await addTimeline(leadId, 'partner', `Attributed to channel partner ${cp.name}`, cp.firm || '', actor, 'ChannelPartner', cpId);
    return { attributed: true, reason: '' };
  } catch (e) {
    console.error('[partners] attributeFromSource failed', e);
    return { attributed: false, reason: 'error' };
  }
}

export async function unattributeLead(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const leadId = str(d?.leadId);
  const lead = await (await leads()).findOne({ _id: leadId }, { projection: { channelPartnerId: 1 } });
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  await (await leads()).updateOne({ _id: leadId }, { $set: { channelPartnerId: '', subSource: '' }, $unset: { cpRegisteredAt: '' } } as any);
  await addTimeline(leadId, 'partner', 'Channel partner attribution removed', '', actorOf(ctx), 'Lead', leadId);
  await auditLog(ctx, 'Lead Channel Partner Removed', 'Lead', leadId, str(lead.channelPartnerId));
  await bumpVersion();
  return { ok: true };
}

/* ----------------------------- partner detail ---------------------------- */

export async function partnerLeads(d: any, ctx: Ctx): Promise<{ leads: Array<{ id: string; name: string; phone: string; stage: string; registeredAt: string; booked: boolean }> }> {
  const cpId = str(d?.cpId);
  const visible = await visibleLeadIds(ctx.user as any);
  const rows = await (await leads()).find({ channelPartnerId: cpId } as any, { projection: { name: 1, phone: 1, stage: 1, cpRegisteredAt: 1 } }).sort({ cpRegisteredAt: -1 }).toArray();
  const bookedUnits = new Set((await (await commissions()).find({ cpId, status: 'accrued' }, { projection: { leadId: 1 } }).toArray()).map((c) => c.leadId));
  const out = rows
    .filter((r) => !visible || visible.has(r._id))
    .map((r) => ({ id: r._id, name: str(r.name), phone: str(r.phone), stage: str(r.stage), registeredAt: r.cpRegisteredAt ? new Date(r.cpRegisteredAt).toISOString() : '', booked: bookedUnits.has(r._id) }));
  return { leads: out };
}

export async function partnerCommissions(d: any, ctx: Ctx): Promise<{ commissions: Array<Omit<CommissionDoc, 'computedAt' | 'voidedAt'> & { computedAt: string; voidedAt: string }>; totalAccrued: number }> {
  if (!can(ctx.user, 'partners.commission')) throw fail('FORBIDDEN', 'You cannot see commission figures.');
  const cpId = str(d?.cpId);
  const rows = await (await commissions()).find({ cpId }).sort({ computedAt: -1 }).toArray();
  const totalAccrued = rows.filter((r) => r.status === 'accrued').reduce((s, r) => s + num(r.amount), 0);
  return {
    commissions: rows.map((r) => ({ ...r, computedAt: r.computedAt ? new Date(r.computedAt).toISOString() : '', voidedAt: r.voidedAt ? new Date(r.voidedAt).toISOString() : '' })),
    totalAccrued,
  };
}

export async function commissionSummary(_d: any, ctx: Ctx): Promise<{ rows: Array<{ cpId: string; name: string; bookings: number; accrued: number }>; totalAccrued: number }> {
  if (!can(ctx.user, 'partners.commission')) throw fail('FORBIDDEN', 'You cannot see commission figures.');
  const agg = await aggregates();
  const docs = await (await partners()).find({}, { projection: { name: 1 } }).toArray();
  const byId = new Map(docs.map((d) => [d._id, str(d.name)]));
  const rows = [...agg.entries()]
    .filter(([, a]) => a.bookings > 0)
    .map(([cpId, a]) => ({ cpId, name: byId.get(cpId) || cpId, bookings: a.bookings, accrued: a.accrued }))
    .sort((a, b) => b.accrued - a.accrued);
  return { rows, totalAccrued: rows.reduce((s, r) => s + r.accrued, 0) };
}

/* --------------------------- commission engine --------------------------- */

/**
 * Called by inventory.ts when a unit is booked or a booking is cancelled. Never throws — a commission problem must
 * not break a booking. On book: accrue (deal value × rate) for the lead's channel partner, if it has one. On cancel:
 * void the accrual for that unit.
 */
export async function onUnitBookingChanged(unit: { inventoryId: string; unitId: string; quotedAmount: number; price: number }, leadId: string, kind: 'book' | 'cancel', actor: string): Promise<void> {
  try {
    const unitId = str(unit?.inventoryId);
    if (!unitId) return;
    const c = await commissions();
    if (kind === 'cancel') {
      await c.updateOne({ _id: unitId, status: 'accrued' } as any, { $set: { status: 'void', voidedAt: new Date(), voidReason: 'Booking cancelled' } });
      return;
    }
    const lead = await (await leads()).findOne({ _id: str(leadId) }, { projection: { channelPartnerId: 1 } });
    const cpId = str(lead?.channelPartnerId);
    if (!cpId) return; // not a channel-partner lead — nothing to accrue
    const cp = await (await partners()).findOne({ _id: cpId });
    if (!cp || cp.status === 'Suspended') return;
    const dealValue = money(unit.quotedAmount) || money(unit.price);
    const r = rateForDeal(cp, dealValue);
    const amount = Math.round((dealValue * r) / 100);
    await c.updateOne(
      { _id: unitId },
      { $set: { cpId, leadId: str(leadId), unitId, unitLabel: str(unit.unitId), dealValue, rate: r, amount, status: 'accrued', computedAt: new Date(), computedBy: actor || 'System' }, $unset: { voidedAt: '', voidReason: '' } },
      { upsert: true },
    );
  } catch (e) {
    console.error('[partners] commission accrual failed', e);
  }
}

/** Manually recompute a partner's accruals from the units their leads currently hold (Settings / detail refresh). */
export async function recomputePartnerCommissions(d: any, ctx: Ctx): Promise<{ updated: number }> {
  const cpId = str(d?.cpId);
  const cp = await (await partners()).findOne({ _id: cpId });
  if (!cp) throw fail('NOT_FOUND', 'Channel partner not found');
  const leadIds = (await (await leads()).find({ channelPartnerId: cpId } as any, { projection: { _id: 1 } }).toArray()).map((l) => l._id);
  if (!leadIds.length) return { updated: 0 };
  const booked = await (await col<any>(CFG.COLL.INVENTORY)).find({ leadId: { $in: leadIds }, status: { $in: ['Booked', 'Sold'] } }).toArray();
  let updated = 0;
  for (const u of booked) {
    await onUnitBookingChanged({ inventoryId: String(u._id), unitId: str(u.unitNumber) || String(u._id), quotedAmount: num(u.quotedAmount), price: num(u.price) }, str(u.leadId), 'book', actorOf(ctx));
    updated++;
  }
  await auditLog(ctx, 'Channel Partner Commission Recomputed', 'ChannelPartner', cpId, String(updated));
  await bumpVersion();
  return { updated };
}

/* -------------------------------- actions -------------------------------- */

export const actions: ActionMap = {
  listPartners: { fn: listPartners, perm: 'partners.view' },
  getPartner: { fn: getPartner, perm: 'partners.view' },
  partnerLeads: { fn: partnerLeads, perm: 'partners.view' },
  checkCpRegistration: { fn: checkRegistration, perm: 'partners.view' },
  savePartner: { fn: savePartner, perm: 'partners.manage' },
  setPartnerStatus: { fn: setPartnerStatus, perm: 'partners.manage' },
  deletePartner: { fn: deletePartner, perm: 'partners.manage' },
  findLeadsForPartner: { fn: findLeadsForPartner, perm: 'partners.manage' },
  attributeLeadToPartner: { fn: attributeLead, perm: 'partners.manage' },
  unattributeLead: { fn: unattributeLead, perm: 'partners.manage' },
  recomputePartnerCommissions: { fn: recomputePartnerCommissions, perm: 'partners.manage' },
  partnerCommissions: { fn: partnerCommissions, perm: 'partners.commission' },
  commissionSummary: { fn: commissionSummary, perm: 'partners.commission' },
};
