/**
 * Customer engagement — before and after the sale (Amaya Sales SOP: "value-add follow-ups only, no check-in calls";
 * after booking: welcome sequence, community preview, monthly progress updates, referral ask at 30 days).
 *
 * Touches already in the CRM are read, not copied: calls, WhatsApp messages, follow-up remarks, visits. What the
 * CRM cannot see (an event attended, a brochure or progress update e-mailed, a family meeting, a community preview)
 * is logged here as an engagement: channel, kind, who it involved, and whether the customer responded.
 *
 * Health per enquiry / customer, from the last 90 days:
 *   engaged   the customer (or their family) responded in the last 14 days
 *   cooling   last response 15–30 days ago
 *   cold      no response for more than 30 days, or never despite 3+ touches
 *   new       too few touches to tell
 * A response is the customer acting: an inbound message, a connected inbound call, an event attended, a reply to
 * something sent, a visit.
 *
 * After booking each customer has a CX owner and the SOP steps (customerJourney.<step> = { at, by }), and Today
 * lists what is due: welcome call, community preview, monthly progress update, referral ask after 30 days, payment
 * demands, and customers going cold.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import { assertLeadAccess, leadFilter } from '../core/scope';
import { last10, shortId, str, truncate } from '../core/utils';

const DAY = 86_400_000;
export const CHANNELS = ['call', 'whatsapp', 'email', 'visit', 'event', 'meeting', 'video', 'letter', 'other'] as const;
export const KINDS = ['welcome', 'communityPreview', 'progressUpdate', 'eventInvite', 'eventAttended', 'content', 'familyMeeting', 'referralAsk', 'feedback', 'paymentReminder', 'other'] as const;
export const CUSTOMER_STEPS = ['welcomeCall', 'handedOver', 'communityPreview', 'agreementRegistered', 'referralAsked', 'possession', 'moveIn'] as const;
export type CustomerStep = (typeof CUSTOMER_STEPS)[number];
export const STEP_LABEL: Record<CustomerStep, string> = {
  welcomeCall: 'Welcome call', handedOver: 'Handed over to customer team', communityPreview: 'Community preview', agreementRegistered: 'Agreement registered',
  referralAsked: 'Referral asked', possession: 'Possession handed over', moveIn: 'Moved in',
};

export interface EngagementDoc {
  _id: string;
  leadId: string;
  personId: string;
  channel: (typeof CHANNELS)[number];
  kind: (typeof KINDS)[number];
  direction: 'out' | 'in';
  responded: boolean;
  note: string;
  at: Date;
  by: string;
  byId: string;
}
const engagements = () => col<EngagementDoc>('engagements');
const leads = () => col<any>(CFG.COLL.LEADS);
const who = (ctx: Ctx) => ctx?.user?.name || 'System';

export async function logEngagement(d: any, ctx: Ctx): Promise<EngagementDoc> {
  const leadId = str(d?.leadId);
  await assertLeadAccess(ctx, leadId);
  if (!(await (await leads()).findOne({ _id: leadId }, { projection: { _id: 1 } }))) throw fail('NOT_FOUND', 'Lead not found: ' + leadId);
  const channel = (CHANNELS as readonly string[]).includes(str(d?.channel)) ? (str(d.channel) as EngagementDoc['channel']) : null;
  const kind = (KINDS as readonly string[]).includes(str(d?.kind)) ? (str(d.kind) as EngagementDoc['kind']) : null;
  if (!channel) throw fail('VALIDATION', 'Choose the channel');
  if (!kind) throw fail('VALIDATION', 'Choose what it was');
  const at = d?.at ? new Date(d.at) : new Date();
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000) throw fail('VALIDATION', 'The time cannot be in the future');
  const doc: EngagementDoc = {
    _id: shortId('ENG'), leadId, personId: str(d?.personId), channel, kind,
    direction: d?.direction === 'in' || kind === 'eventAttended' ? 'in' : 'out',
    responded: kind === 'eventAttended' || d?.responded === true,
    note: truncate(str(d?.note), 500), at, by: who(ctx), byId: str(ctx?.user?.id),
  };
  await (await engagements()).insertOne(doc);
  await addTimeline(leadId, 'engagement', `${kindLabel(doc.kind)} · ${doc.channel}`, [doc.note, doc.responded ? 'Responded' : ''].filter(Boolean).join(' · '), who(ctx), 'Engagement', doc._id);
  // SOP steps that an engagement completes
  if (doc.kind === 'communityPreview') await markCustomerStep(leadId, 'communityPreview', ctx, at).catch(() => undefined);
  if (doc.kind === 'referralAsk') await markCustomerStep(leadId, 'referralAsked', ctx, at).catch(() => undefined);
  if (doc.kind === 'welcome' && doc.channel === 'call') await markCustomerStep(leadId, 'welcomeCall', ctx, at).catch(() => undefined);
  return doc;
}

export const kindLabel = (k: string) => ({ welcome: 'Welcome', communityPreview: 'Community preview', progressUpdate: 'Progress update', eventInvite: 'Event invite', eventAttended: 'Event attended', content: 'Content shared', familyMeeting: 'Family meeting', referralAsk: 'Referral ask', feedback: 'Feedback', paymentReminder: 'Payment reminder', other: 'Touch' } as Record<string, string>)[k] || k;

/* ---------------------------------- health ---------------------------------- */

export interface Touch { at: string; channel: string; kind: string; direction: 'in' | 'out'; responded: boolean; source: 'call' | 'whatsapp' | 'remark' | 'visit' | 'engagement'; note: string; personId: string }
export type HealthState = 'engaged' | 'cooling' | 'cold' | 'new';

export function healthOf(touches: Touch[], now = new Date()): { state: HealthState; lastResponseAt: string; lastTouchAt: string; touches30: number; responses30: number; daysSinceResponse: number | null } {
  const sorted = [...touches].sort((a, b) => b.at.localeCompare(a.at));
  const responses = sorted.filter((t) => t.direction === 'in' || t.responded);
  const lastResp = responses[0]?.at || '';
  const since = lastResp ? Math.floor((now.getTime() - new Date(lastResp).getTime()) / DAY) : null;
  const in30 = (t: Touch) => now.getTime() - new Date(t.at).getTime() <= 30 * DAY;
  const outward = sorted.filter((t) => t.direction === 'out').length;
  const state: HealthState = since !== null ? (since <= 14 ? 'engaged' : since <= 30 ? 'cooling' : 'cold') : outward >= 3 ? 'cold' : 'new';
  return { state, lastResponseAt: lastResp, lastTouchAt: sorted[0]?.at || '', touches30: sorted.filter(in30).length, responses30: responses.filter(in30).length, daysSinceResponse: since };
}

/** Every touch of the last 90 days for one enquiry, from calls, WhatsApp, remarks, visits and logged engagements. */
export async function touchesFor(lead: any, now = new Date()): Promise<Touch[]> {
  const since = new Date(now.getTime() - 90 * DAY);
  const id = String(lead._id);
  const phones = [lead.phone, ...((lead.people || []) as any[]).map((p) => p.phone)].map((p) => last10(p)).filter((k) => k.length === 10);
  const personOf = (phone: unknown) => ((lead.people || []) as any[]).find((p) => last10(p.phone) === last10(phone))?.id || '';
  const out: Touch[] = [];
  for (const c of await (await col<any>(CFG.COLL.CALLS)).find({ $or: [{ leadId: id }, { phoneLast10: { $in: phones } }], createdAt: { $gte: since } }, { projection: { direction: 1, status: 1, createdAt: 1, startTime: 1, phone: 1, outcome: 1 } }).toArray()) {
    const inbound = c.direction === 'Inbound';
    out.push({ at: new Date(c.startTime || c.createdAt).toISOString(), channel: 'call', kind: 'call', direction: inbound && c.status === 'Completed' ? 'in' : 'out', responded: c.status === 'Completed', source: 'call', note: String(c.outcome || c.status || ''), personId: personOf(c.phone) });
  }
  if (phones.length) {
    for (const m of await (await col<any>(CFG.COLL.CHAT_MESSAGES)).find({ phoneLast10: { $in: phones }, timestamp: { $gte: since } }, { projection: { direction: 1, timestamp: 1, phoneLast10: 1 } }).sort({ timestamp: -1 }).limit(300).toArray()) {
      out.push({ at: new Date(m.timestamp).toISOString(), channel: 'whatsapp', kind: 'message', direction: m.direction === 'Inbound' ? 'in' : 'out', responded: m.direction === 'Inbound', source: 'whatsapp', note: '', personId: personOf(m.phoneLast10) });
    }
  }
  for (const f of (lead.followups || []) as any[]) if (f.at && new Date(f.at) >= since) out.push({ at: new Date(f.at).toISOString(), channel: 'note', kind: 'remark', direction: 'out', responded: /spoke|agreed|discuss|visited|replied|called back/i.test(String(f.text || '')), source: 'remark', note: truncate(String(f.text || ''), 120), personId: '' });
  const visit = lead.milestones?.visitDone?.at;
  if (visit && new Date(visit) >= since) out.push({ at: new Date(visit).toISOString(), channel: 'visit', kind: 'visit', direction: 'in', responded: true, source: 'visit', note: 'Visited', personId: '' });
  for (const e of await (await engagements()).find({ leadId: id, at: { $gte: since } }).toArray()) out.push({ at: e.at.toISOString(), channel: e.channel, kind: e.kind, direction: e.direction, responded: e.responded, source: 'engagement', note: e.note, personId: e.personId });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export async function getEngagement(leadId: string, ctx: Ctx, now = new Date()) {
  await assertLeadAccess(ctx, leadId);
  const lead = await (await leads()).findOne({ _id: str(leadId) }, { projection: { phone: 1, people: 1, followups: 1, milestones: 1, customerJourney: 1, cxOwner: 1, cxOwnerId: 1, stage: 1, bookingDate: 1 } });
  if (!lead) throw fail('NOT_FOUND', 'Lead not found: ' + leadId);
  const touches = await touchesFor(lead, now);
  const people = ((lead.people || []) as any[]).map((p) => ({ personId: p.id, name: p.name, ...healthOf(touches.filter((t) => t.personId === p.id), now) }));
  const booked = !!lead.milestones?.booked;
  return {
    health: healthOf(touches, now),
    people,
    touches: touches.slice(0, 60),
    customer: booked ? {
      owner: str(lead.cxOwner), ownerId: str(lead.cxOwnerId),
      bookedAt: new Date(lead.milestones.booked.at).toISOString(),
      steps: CUSTOMER_STEPS.map((s) => ({ step: s, label: STEP_LABEL[s], at: lead.customerJourney?.[s]?.at ? new Date(lead.customerJourney[s].at).toISOString() : '', by: str(lead.customerJourney?.[s]?.by) })),
      due: customerDue(lead, touches, now),
    } : null,
  };
}

/* ----------------------------- customer journey ----------------------------- */

export async function markCustomerStep(leadId: string, step: CustomerStep, ctx: Ctx | null, at = new Date()) {
  if (!(CUSTOMER_STEPS as readonly string[]).includes(step)) throw fail('VALIDATION', 'Unknown step');
  const r = await (await leads()).updateOne({ _id: str(leadId), [`customerJourney.${step}`]: { $exists: false } } as any, { $set: { [`customerJourney.${step}`]: { at, by: ctx?.user?.name || 'System' } } });
  if (r.modifiedCount) await addTimeline(str(leadId), 'customer_step', STEP_LABEL[step], '', ctx?.user?.name || 'System', 'Lead', str(leadId));
  return { ok: true, changed: r.modifiedCount === 1 };
}

export async function assignCxOwner(leadId: string, userId: string, ctx: Ctx) {
  await assertLeadAccess(ctx, leadId);
  const u = (await listUsers()).find((x) => x.id === userId && x.status !== 'Disabled');
  if (!u) throw fail('VALIDATION', 'Choose an active team member');
  const lead = await (await leads()).findOne({ _id: str(leadId) }, { projection: { milestones: 1 } });
  if (!lead?.milestones?.booked) throw fail('VALIDATION', 'A customer owner is assigned once the unit is booked');
  await (await leads()).updateOne({ _id: str(leadId) }, { $set: { cxOwner: u.name, cxOwnerId: u.id } });
  await markCustomerStep(leadId, 'handedOver', ctx);
  await auditLog(ctx, 'Customer Owner Assigned', 'Lead', str(leadId), u.name);
  return { ok: true, owner: u.name };
}

/** What the SOP says is due for one booked customer. */
export function customerDue(lead: any, touches: Touch[], now = new Date()): Array<{ key: string; label: string; late: boolean }> {
  const out: Array<{ key: string; label: string; late: boolean }> = [];
  const booked = lead.milestones?.booked?.at ? new Date(lead.milestones.booked.at) : null;
  if (!booked) return out;
  const days = Math.floor((now.getTime() - booked.getTime()) / DAY);
  const j = lead.customerJourney || {};
  if (!j.welcomeCall) out.push({ key: 'welcomeCall', label: 'Welcome call', late: days > 2 });
  if (!j.handedOver) out.push({ key: 'handedOver', label: 'Assign a customer owner', late: days > 7 });
  if (!j.communityPreview && days >= 7) out.push({ key: 'communityPreview', label: 'Community preview', late: days > 21 });
  const lastUpdate = touches.filter((t) => t.kind === 'progressUpdate').map((t) => t.at).sort().pop();
  const since = lastUpdate ? Math.floor((now.getTime() - new Date(lastUpdate).getTime()) / DAY) : days;
  if (since >= 30) out.push({ key: 'progressUpdate', label: 'Monthly progress update', late: since > 37 });
  if (!j.referralAsked && days >= 30) out.push({ key: 'referralAsk', label: 'Ask for a referral', late: days > 45 });
  const h = healthOf(touches, now);
  if (h.state === 'cooling' || h.state === 'cold') out.push({ key: 'reengage', label: h.state === 'cold' ? 'Customer has gone quiet' : 'Customer is cooling', late: h.state === 'cold' });
  return out;
}

/** Booked customers this user looks after (their own, or all for managers) with what is due. */
export async function customerQueue(ctx: Ctx, now = new Date()) {
  const scope = (await leadFilter(ctx)) || {};
  const mine = ctx?.user && !(await import('../core/auth')).can(ctx.user, 'leads.viewAll') ? { $or: [scope, { cxOwnerId: ctx.user.id }] } : scope;
  const rows = await (await leads()).find({ ...mine, 'milestones.booked': { $exists: true } } as any, { projection: { name: 1, phone: 1, people: 1, followups: 1, milestones: 1, customerJourney: 1, cxOwner: 1, assignedRm: 1 } }).limit(200).toArray();
  const out = [];
  for (const l of rows) {
    const touches = await touchesFor(l, now);
    const due = customerDue(l, touches, now);
    if (due.length) out.push({ leadId: String(l._id), name: String(l.name || ''), owner: String(l.cxOwner || ''), rm: String(l.assignedRm || ''), due, health: healthOf(touches, now).state });
  }
  return out.sort((a, b) => Number(b.due.some((d) => d.late)) - Number(a.due.some((d) => d.late)));
}

/** Leads whose engagement is cooling or cold (pre-sale), for the agent's queue: value-add follow-up, not a check-in. */
export async function coolingLeads(ctx: Ctx, now = new Date()) {
  const scope = (await leadFilter(ctx)) || {};
  const open = await (await leads()).find({ ...scope, stage: { $in: [CFG.STAGES.OPEN, CFG.STAGES.QUALIFIED, CFG.STAGES.WARM, CFG.STAGES.HOT] }, 'milestones.contacted': { $exists: true } } as any, { projection: { name: 1, phone: 1, people: 1, followups: 1, milestones: 1, stage: 1, assignedRm: 1 } }).limit(150).toArray();
  const out = [];
  for (const l of open) {
    const h = healthOf(await touchesFor(l, now), now);
    if (h.state === 'cooling' || h.state === 'cold') out.push({ leadId: String(l._id), name: String(l.name || ''), phone: String(l.phone || ''), stage: String(l.stage || ''), rm: String(l.assignedRm || ''), at: h.lastResponseAt || h.lastTouchAt, note: h.state === 'cold' ? `No response for ${h.daysSinceResponse ?? '30+'} days` : `Last response ${h.daysSinceResponse} days ago`, late: h.state === 'cold' });
  }
  return out;
}

export const actions: ActionMap = {
  logEngagement: { perm: 'leads.edit', fn: (d, ctx) => logEngagement(d, ctx) },
  getEngagement: { perm: 'leads.view', fn: (d, ctx) => getEngagement(str(d?.leadId), ctx) },
  markCustomerStep: { perm: 'leads.edit', fn: async (d, ctx) => { await assertLeadAccess(ctx, d?.leadId); return markCustomerStep(str(d?.leadId), str(d?.step) as CustomerStep, ctx); } },
  assignCxOwner: { perm: 'leads.edit', fn: (d, ctx) => assignCxOwner(str(d?.leadId), str(d?.userId), ctx) },
  getCustomerQueue: { perm: 'leads.view', fn: (_d, ctx) => customerQueue(ctx) },
};
