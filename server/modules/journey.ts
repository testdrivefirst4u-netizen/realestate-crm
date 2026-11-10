/**
 * Amaya's family-to-booking journey (Release B): the people around an opportunity, the next action, quotations
 * and booking approval. Every action is scoped to leads the user may see (assertLeadAccess) and audited.
 *
 * People (lead.people[]): the enquirer, the future resident(s), the family decision-maker, the payer and a
 * referrer are often different people — an adult child in Dubai enquiring for parents in Bengaluru. Each person
 * has a full international number (server/core/phone.ts), a preferred channel, language, time zone, best time to
 * call, and WhatsApp marketing consent with its evidence (server/modules/consent.ts enforces it on every send).
 *
 * Next action: an active opportunity always has an owner and a next action. logDisposition records what
 * happened on a contact (outcome + note) and, unless the outcome closes the lead, REQUIRES the next action with a
 * time — the one stage gate an agent meets on every call.
 *
 * Quotations (quotes): versioned per lead + unit. A draft with a discount above the company's limit must be
 * approved by someone with inventory.approve before it can be sent; a new version supersedes the old one.
 *
 * Booking (approvals): an agent asks to book a unit for a lead. Gates (bookingGate): an approved, current
 * quotation for that unit, and a payer identified among the lead's people. A manager approves, which performs
 * the atomic unit transition (server/modules/inventory.ts → updateUnit with the unit's current revision), or
 * rejects with a reason. Two requests for the same unit can be pending; only one can be approved (the unit
 * transition is compare-and-set), the other is then told the unit is taken.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline, addEvent } from '../core/events';
import { phoneIdentity } from '../core/phone';
import { assertLeadAccess } from '../core/scope';
import { settingsAll } from '../core/settings';
import { shortId, str, truncate } from '../core/utils';

const S = CFG.STAGES;

/* --------------------------------- people --------------------------------- */

export const PERSON_ROLES = ['enquirer', 'resident', 'decisionMaker', 'payer', 'referrer', 'other'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];
export const CHANNELS = ['whatsapp', 'call', 'email', 'sms'] as const;
export type ConsentState = 'granted' | 'denied' | 'unknown';

export interface Person {
  id: string;
  name: string;
  roles: PersonRole[];
  relationship: string; // to the future resident: "Son", "Daughter", "Self"…
  phone: string; // E.164
  email: string;
  preferredChannel: (typeof CHANNELS)[number] | '';
  language: string;
  timeZone: string; // IANA, e.g. Asia/Dubai
  bestTime: string;
  consent: { whatsappMarketing: ConsentState; at: string; source: string; evidence: string };
  notes: string;
  updatedAt: string;
  updatedBy: string;
}

const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

export function cleanPerson(raw: any, by: string, prev?: Person): Person {
  const name = truncate(str(raw?.name), 120);
  if (!name) throw fail('VALIDATION', 'Name is required');
  const roles = (Array.isArray(raw?.roles) ? raw.roles : []).map(String).filter((r: string) => (PERSON_ROLES as readonly string[]).includes(r)) as PersonRole[];
  if (!roles.length) throw fail('VALIDATION', 'Choose at least one role (enquirer, resident, decision-maker, payer, referrer, other)');
  let phone = '';
  if (str(raw?.phone)) {
    const id = phoneIdentity(raw.phone);
    if (!id) throw fail('VALIDATION', 'Enter the full phone number, with the country code for numbers outside India (e.g. +971 50 123 4567)');
    phone = id.e164;
  }
  const email = str(raw?.email).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail('VALIDATION', 'Enter a valid e-mail address');
  const tz = str(raw?.timeZone);
  if (tz && !validZone(tz)) throw fail('VALIDATION', `Unknown time zone “${tz}”. Use a city zone such as Asia/Dubai or Europe/London.`);
  const ch = str(raw?.preferredChannel);
  const c = raw?.consent || {};
  const state = (['granted', 'denied', 'unknown'].includes(str(c.whatsappMarketing)) ? str(c.whatsappMarketing) : prev?.consent.whatsappMarketing || 'unknown') as ConsentState;
  const changed = !prev || prev.consent.whatsappMarketing !== state;
  if (changed && state === 'granted' && !str(c.evidence)) throw fail('VALIDATION', 'Say how consent was given (e.g. "Ticked the WhatsApp box on the website form", "Asked on the call on 10 Nov")');
  return {
    id: prev?.id || shortId('PER'),
    name, roles,
    relationship: truncate(str(raw?.relationship), 60),
    phone, email,
    preferredChannel: (CHANNELS as readonly string[]).includes(ch) ? (ch as Person['preferredChannel']) : '',
    language: truncate(str(raw?.language), 40),
    timeZone: tz,
    bestTime: truncate(str(raw?.bestTime), 80),
    consent: changed
      ? { whatsappMarketing: state, at: new Date().toISOString(), source: truncate(str(c.source) || 'agent', 40), evidence: truncate(str(c.evidence), 300) }
      : prev!.consent,
    notes: truncate(str(raw?.notes), 500),
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
}

const leads = () => col<any>(CFG.COLL.LEADS);
const actor = (ctx: Ctx) => ctx?.user?.name || 'System';

export async function getLeadPeople(leadId: string, ctx: Ctx): Promise<Person[]> {
  await assertLeadAccess(ctx, leadId);
  const l = await (await leads()).findOne({ _id: leadId }, { projection: { people: 1, name: 1, phone: 1, email: 1, enquiredFor: 1 } });
  if (!l) throw fail('NOT_FOUND', 'Lead not found: ' + leadId);
  if (Array.isArray(l.people) && l.people.length) return l.people;
  // nobody recorded yet: the enquirer is the lead's own contact
  const id = phoneIdentity(l.phone);
  return [{ id: 'PER-ENQUIRER', name: str(l.name), roles: ['enquirer'], relationship: str(l.enquiredFor) === 'Self' ? 'Self' : '', phone: id?.e164 || str(l.phone), email: str(l.email), preferredChannel: '', language: '', timeZone: '', bestTime: '', consent: { whatsappMarketing: 'unknown', at: '', source: '', evidence: '' }, notes: '', updatedAt: '', updatedBy: '' }];
}

export async function saveLeadPerson(leadId: string, raw: any, ctx: Ctx): Promise<Person[]> {
  const list = await getLeadPeople(leadId, ctx);
  const prev = raw?.id ? list.find((p) => p.id === raw.id) : undefined;
  const p = cleanPerson(raw, actor(ctx), prev);
  const next = prev ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
  if (next.length > 12) throw fail('VALIDATION', 'At most 12 people per enquiry');
  await (await leads()).updateOne({ _id: leadId }, { $set: { people: next, updatedAt: new Date(), updatedBy: actor(ctx) } });
  await addTimeline(leadId, 'person_saved', `${prev ? 'Updated' : 'Added'} ${p.name}`, p.roles.join(', ') + (p.relationship ? ` · ${p.relationship}` : ''), actor(ctx), 'Lead', leadId);
  if (!prev || prev.consent.whatsappMarketing !== p.consent.whatsappMarketing) {
    await auditLog(ctx, 'Consent Recorded', 'Lead', leadId, `${p.name}: WhatsApp marketing ${p.consent.whatsappMarketing} — ${p.consent.evidence || p.consent.source}`);
    if (p.phone) {
      const { recordConsent } = await import('./consent');
      await recordConsent(p.phone, p.consent.whatsappMarketing, { source: p.consent.source, evidence: p.consent.evidence, by: actor(ctx), leadId });
    }
  }
  await auditLog(ctx, 'Person Saved', 'Lead', leadId, `${p.name} (${p.roles.join(', ')})`);
  return next;
}

export async function removeLeadPerson(leadId: string, personId: string, ctx: Ctx): Promise<Person[]> {
  const list = await getLeadPeople(leadId, ctx);
  const gone = list.find((p) => p.id === personId);
  if (!gone) throw fail('NOT_FOUND', 'Person not found');
  const next = list.filter((p) => p.id !== personId);
  await (await leads()).updateOne({ _id: leadId }, { $set: { people: next, updatedAt: new Date(), updatedBy: actor(ctx) } });
  await auditLog(ctx, 'Person Removed', 'Lead', leadId, gone.name);
  return next;
}

/* ------------------------- disposition → next action ------------------------- */

export const OUTCOMES = {
  connected: { label: 'Spoke to them', closes: false },
  noAnswer: { label: 'No answer', closes: false },
  callbackRequested: { label: 'Asked to call back', closes: false },
  visitAgreed: { label: 'Agreed to a visit', closes: false },
  familyConsult: { label: 'Will discuss with family', closes: false },
  wrongNumber: { label: 'Wrong number', closes: true, stage: S.LOST },
  notInterested: { label: 'Not interested', closes: true, stage: S.DQ_NI },
} as const;
export type Outcome = keyof typeof OUTCOMES;
export const NEXT_TYPES = ['call', 'whatsapp', 'visit', 'familyMeeting', 'sendQuote', 'other'] as const;

export async function logDisposition(d: { leadId: string; outcome: string; note?: string; next?: { type?: string; at?: string; note?: string }; personId?: string }, ctx: Ctx) {
  const leadId = str(d.leadId);
  await assertLeadAccess(ctx, leadId);
  const o = OUTCOMES[d.outcome as Outcome];
  if (!o) throw fail('VALIDATION', 'Choose what happened');
  const { appendRemark, updateLead } = await import('./leads');
  let nextAt: Date | null = null;
  if (!o.closes) {
    nextAt = d.next?.at ? new Date(d.next.at) : null;
    const type = str(d.next?.type);
    if (!nextAt || Number.isNaN(nextAt.getTime())) throw fail('VALIDATION', 'Set the next action and when — every open enquiry needs one');
    if (!(NEXT_TYPES as readonly string[]).includes(type)) throw fail('VALIDATION', 'Choose the next action (call, WhatsApp, visit, family meeting, send quotation, other)');
    if (nextAt.getTime() < Date.now() - 5 * 60_000) throw fail('VALIDATION', 'The next action must be in the future');
  }
  const people = d.personId ? await getLeadPeople(leadId, ctx) : [];
  const who = people.find((p) => p.id === d.personId);
  const text = `${o.label}${who ? ` (${who.name})` : ''}${d.note ? ` — ${truncate(str(d.note), 500)}` : ''}`;
  // a real conversation is the "contacted" milestone (no answer is not)
  const res = await appendRemark(leadId, text, d.outcome === 'noAnswer' ? null : ctx, nextAt ? nextAt.toISOString() : undefined, actor(ctx));
  if ('stage' in o && o.stage) await updateLead(leadId, { [CFG.LEAD.STAGE]: o.stage }, ctx);
  if (nextAt) {
    const { addTask } = await import('./tasks');
    const label = { call: 'Call', whatsapp: 'WhatsApp', visit: 'Visit', familyMeeting: 'Family meeting', sendQuote: 'Send quotation', other: 'Follow up' }[str(d.next!.type) as (typeof NEXT_TYPES)[number]];
    await addTask({ name: `${label}: ${truncate(str(d.next?.note) || who?.name || 'follow up', 80)}`, leadId, datetime: nextAt.toISOString(), assignedTo: actor(ctx) }, ctx);
  }
  await (await leads()).updateOne({ _id: leadId }, { $set: { nextAction: nextAt ? { type: str(d.next!.type), at: nextAt, note: truncate(str(d.next?.note), 200), setBy: actor(ctx) } : null } });
  return { ok: true, followup: res.index, nextAt: nextAt?.toISOString() || '' };
}

/* -------------------------------- quotations -------------------------------- */

export interface QuoteDoc {
  _id: string; // QT_…
  leadId: string;
  unitId: string; // inventory id
  version: number;
  status: 'draft' | 'pendingApproval' | 'approved' | 'rejected' | 'sent' | 'superseded';
  basePrice: number;
  charges: Array<{ label: string; amount: number }>;
  discount: number;
  total: number;
  validUntil: Date | null;
  createdAt: Date;
  createdBy: string;
  decidedBy?: string;
  decidedAt?: Date;
  decisionNote?: string;
}
const quotes = () => col<QuoteDoc>('quotes');
const money = (v: unknown) => Math.max(0, Math.round(Number(String(v ?? '').replace(/[,₹\s]/g, '')) || 0));

export async function saveQuote(d: any, ctx: Ctx): Promise<QuoteDoc> {
  const leadId = str(d?.leadId);
  await assertLeadAccess(ctx, leadId);
  const unit = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: str(d?.unitId) });
  if (!unit) throw fail('NOT_FOUND', 'Unit not found');
  const basePrice = money(d?.basePrice ?? unit.price);
  const charges = (Array.isArray(d?.charges) ? d.charges : []).slice(0, 20).map((c: any) => ({ label: truncate(str(c?.label), 60), amount: money(c?.amount) })).filter((c: any) => c.label && c.amount);
  const discount = money(d?.discount);
  const gross = basePrice + charges.reduce((a: number, c: any) => a + c.amount, 0);
  if (discount > gross) throw fail('VALIDATION', 'The discount is larger than the price');
  const limitPct = Number((await settingsAll()).quoteDiscountLimitPct ?? 2);
  const needsApproval = gross > 0 && (discount / gross) * 100 > limitPct;
  const c = await quotes();
  const last = await c.find({ leadId, unitId: unit._id }).sort({ version: -1 }).limit(1).next();
  const doc: QuoteDoc = {
    _id: shortId('QT'), leadId, unitId: unit._id, version: (last?.version || 0) + 1,
    status: needsApproval ? 'pendingApproval' : 'approved',
    basePrice, charges, discount, total: gross - discount,
    validUntil: d?.validUntil ? new Date(d.validUntil) : new Date(Date.now() + 14 * 86400e3),
    createdAt: new Date(), createdBy: actor(ctx),
  };
  await c.insertOne(doc);
  if (last) await c.updateMany({ leadId, unitId: unit._id, _id: { $ne: doc._id }, status: { $in: ['draft', 'pendingApproval', 'approved', 'sent'] } }, { $set: { status: 'superseded' } });
  await addTimeline(leadId, 'quote', `Quotation v${doc.version} for unit ${unit.unitNumber}`, `₹${doc.total.toLocaleString('en-IN')}${needsApproval ? ' · waiting for approval (discount above ' + limitPct + '%)' : ''}`, actor(ctx), 'Quote', doc._id);
  await auditLog(ctx, 'Quote Saved', 'Lead', leadId, `${unit.unitNumber} v${doc.version} ₹${doc.total}${needsApproval ? ' (needs approval)' : ''}`);
  if (needsApproval) await addEvent('approval_needed', 'Lead', leadId, `Discount approval: unit ${unit.unitNumber}`, `₹${discount.toLocaleString('en-IN')} off · by ${actor(ctx)}`, actor(ctx), { leadId });
  return doc;
}

export async function decideQuote(id: string, approve: boolean, note: string, ctx: Ctx): Promise<QuoteDoc> {
  if (!can(ctx.user, 'inventory.approve')) throw fail('FORBIDDEN', 'Only a manager can approve discounts');
  const q = await (await quotes()).findOne({ _id: str(id) });
  if (!q) throw fail('NOT_FOUND', 'Quotation not found');
  await assertLeadAccess(ctx, q.leadId);
  if (q.createdBy === actor(ctx)) throw fail('FORBIDDEN', 'Someone else must approve a discount you quoted');
  const r = await (await quotes()).findOneAndUpdate({ _id: q._id, status: 'pendingApproval' }, { $set: { status: approve ? 'approved' : 'rejected', decidedBy: actor(ctx), decidedAt: new Date(), decisionNote: truncate(note, 300) } }, { returnDocument: 'after' });
  if (!r) throw fail('CONFLICT', 'This quotation was already decided or replaced by a newer version');
  await addTimeline(q.leadId, 'quote', `Quotation v${q.version} ${approve ? 'approved' : 'rejected'}`, note, actor(ctx), 'Quote', q._id);
  await auditLog(ctx, approve ? 'Quote Approved' : 'Quote Rejected', 'Lead', q.leadId, `v${q.version}${note ? ' · ' + note : ''}`);
  return r;
}

export async function listQuotes(leadId: string, ctx: Ctx) {
  await assertLeadAccess(ctx, leadId);
  return (await quotes()).find({ leadId }).sort({ createdAt: -1 }).limit(50).toArray();
}

/* ----------------------------- booking approval ----------------------------- */

export interface ApprovalDoc {
  _id: string; // APR_…
  kind: 'booking';
  leadId: string;
  unitId: string;
  quoteId: string;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  requestedBy: string;
  requestedById: string;
  requestedAt: Date;
  decidedBy?: string;
  decidedAt?: Date;
  note?: string;
}
const approvals = () => col<ApprovalDoc>('approvals');

/** What is missing before a unit can be booked for a lead (empty = ready). */
export async function bookingGate(leadId: string, unitId: string, ctx: Ctx): Promise<{ missing: string[]; quote: QuoteDoc | null }> {
  const missing: string[] = [];
  const q = await (await quotes()).find({ leadId, unitId, status: { $in: ['approved', 'sent'] } }).sort({ version: -1 }).limit(1).next();
  if (!q) missing.push('An approved quotation for this unit');
  else if (q.validUntil && q.validUntil.getTime() < Date.now()) missing.push('A quotation that is still valid (the approved one has expired)');
  const people = await getLeadPeople(leadId, ctx);
  if (!people.some((p) => p.roles.includes('payer'))) missing.push('Who is paying (mark a person as payer)');
  return { missing, quote: q };
}

export async function requestBooking(d: { leadId: string; unitId: string; note?: string }, ctx: Ctx): Promise<ApprovalDoc> {
  const leadId = str(d.leadId);
  await assertLeadAccess(ctx, leadId);
  const gate = await bookingGate(leadId, str(d.unitId), ctx);
  if (gate.missing.length) throw fail('VALIDATION', 'Before booking: ' + gate.missing.join('; '), { missing: gate.missing });
  const c = await approvals();
  const open = await c.findOne({ kind: 'booking', leadId, unitId: str(d.unitId), status: 'pending' });
  if (open) return open;
  const doc: ApprovalDoc = { _id: shortId('APR'), kind: 'booking', leadId, unitId: str(d.unitId), quoteId: gate.quote!._id, status: 'pending', requestedBy: actor(ctx), requestedById: str(ctx.user?.id), requestedAt: new Date(), note: truncate(str(d.note), 300) };
  await c.insertOne(doc);
  await addTimeline(leadId, 'approval', 'Booking requested', `Unit ${d.unitId} · quotation v${gate.quote!.version}`, actor(ctx), 'Approval', doc._id);
  await addEvent('approval_needed', 'Lead', leadId, 'Booking approval needed', `${actor(ctx)} asks to book unit ${d.unitId}`, actor(ctx), { leadId });
  await auditLog(ctx, 'Booking Requested', 'Lead', leadId, `${d.unitId} (${doc._id})`);
  return doc;
}

export async function decideBooking(id: string, approve: boolean, note: string, ctx: Ctx): Promise<ApprovalDoc> {
  if (!can(ctx.user, 'inventory.approve')) throw fail('FORBIDDEN', 'Only a manager can approve a booking');
  const c = await approvals();
  const a = await c.findOne({ _id: str(id) });
  if (!a) throw fail('NOT_FOUND', 'Request not found');
  await assertLeadAccess(ctx, a.leadId);
  if (a.status !== 'pending') throw fail('CONFLICT', `This request is already ${a.status}`);
  if (!approve) {
    const r = await c.findOneAndUpdate({ _id: a._id, status: 'pending' }, { $set: { status: 'rejected', decidedBy: actor(ctx), decidedAt: new Date(), note: truncate(note, 300) } }, { returnDocument: 'after' });
    if (!r) throw fail('CONFLICT', 'This request was decided meanwhile');
    await auditLog(ctx, 'Booking Rejected', 'Lead', a.leadId, `${a.unitId}${note ? ' · ' + note : ''}`);
    await addTimeline(a.leadId, 'approval', 'Booking request rejected', note, actor(ctx), 'Approval', a._id);
    return r;
  }
  // gates again at decision time (the quotation may have been superseded or expired meanwhile)
  const gate = await bookingGate(a.leadId, a.unitId, ctx);
  if (gate.missing.length) throw fail('VALIDATION', 'Cannot approve yet: ' + gate.missing.join('; '), { missing: gate.missing });
  const claimed = await c.findOneAndUpdate({ _id: a._id, status: 'pending' }, { $set: { status: 'approved', decidedBy: actor(ctx), decidedAt: new Date(), note: truncate(note, 300) } }, { returnDocument: 'after' });
  if (!claimed) throw fail('CONFLICT', 'This request was decided meanwhile');
  const unit = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: a.unitId });
  const lead = await (await leads()).findOne({ _id: a.leadId }, { projection: { name: 1, phone: 1 } });
  const { updateUnit } = await import('./inventory');
  const res = await updateUnit(a.unitId, { status: 'Booked', leadId: a.leadId, customerName: str(lead?.name), contact: str(lead?.phone), quotedAmount: gate.quote!.total }, ctx, undefined, { expectedRev: Number(unit?.rev || 0), idempotencyKey: `approval:${a._id}` });
  if (res.conflict) {
    await c.updateOne({ _id: a._id }, { $set: { status: 'failed', note: truncate(`Unit not booked: ${res.reason || 'changed meanwhile'}`, 300) } });
    throw fail('CONFLICT', res.reason || 'The unit changed meanwhile; it was not booked.');
  }
  await (await import('./leads')).updateLead(a.leadId, { [CFG.LEAD.STAGE]: S.BOOKED, [CFG.LEAD.BOOKING_DATE]: new Date().toISOString() }, ctx);
  await auditLog(ctx, 'Booking Approved', 'Lead', a.leadId, `${unit?.unitNumber || a.unitId} · ₹${gate.quote!.total}`);
  return claimed;
}

export async function listApprovals(ctx: Ctx, status = 'pending') {
  const rows = await (await approvals()).find({ status: status as any }).sort({ requestedAt: 1 }).limit(100).toArray();
  const { filterByLead } = await import('../core/scope');
  return filterByLead(ctx.user, rows, (r) => r.leadId);
}

/* --------------------------------- actions -------------------------------- */

export const actions: ActionMap = {
  getLeadPeople: { perm: 'leads.view', fn: (d, ctx) => getLeadPeople(str(d?.leadId), ctx) },
  saveLeadPerson: { perm: 'leads.edit', fn: (d, ctx) => saveLeadPerson(str(d?.leadId), d?.person, ctx) },
  removeLeadPerson: { perm: 'leads.edit', fn: (d, ctx) => removeLeadPerson(str(d?.leadId), str(d?.personId), ctx) },
  logDisposition: { perm: 'leads.edit', fn: (d, ctx) => logDisposition(d, ctx) },
  saveQuote: { perm: 'leads.edit', fn: (d, ctx) => saveQuote(d, ctx) },
  decideQuote: { perm: 'inventory.approve', fn: (d, ctx) => decideQuote(str(d?.id), !!d?.approve, str(d?.note), ctx) },
  listQuotes: { perm: 'leads.view', fn: (d, ctx) => listQuotes(str(d?.leadId), ctx) },
  getBookingGate: { perm: 'leads.view', fn: async (d, ctx) => { await assertLeadAccess(ctx, d?.leadId); return bookingGate(str(d?.leadId), str(d?.unitId), ctx); } },
  requestBooking: { perm: 'leads.edit', fn: (d, ctx) => requestBooking(d, ctx) },
  decideBooking: { perm: 'inventory.approve', fn: (d, ctx) => decideBooking(str(d?.id), !!d?.approve, str(d?.note), ctx) },
  listApprovals: { perm: 'leads.view', fn: (d, ctx) => listApprovals(ctx, str(d?.status) || 'pending') },
};
