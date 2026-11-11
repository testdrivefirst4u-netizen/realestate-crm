/**
 * Customer insights: for each enquiry or customer, where they are, how ready they look, and the one next step the
 * team should take — with the reasons. Rule-based and explainable (no model guesses): every point and every
 * suggestion names the signal it comes from, so an agent can check it and a manager can trust it.
 *
 * Readiness score 0–100 (labelled as an estimate, not a prediction):
 *   furthest recorded step   contacted 10 · qualified 25 · visit set 35 · visited 50 · quotation approved 62 ·
 *                            reserved 80 · booked 100
 *   engagement               responded in 14 days +8 · cooling −6 · gone quiet −15
 *   family                   decision-maker engaged +5 · payer identified +4
 *   budget fit               typed budget ≥ 90 % of the shortlisted unit's price +5 · below 70 % −10
 *   hygiene                  follow-up overdue −5 · no next step −5
 *
 * Next step — the first rule that applies, in this order (urgency in brackets):
 *   missed call not returned (now) · new enquiry not contacted (now, past SLA) · payment demand overdue (today) ·
 *   reservation lapsing within 24 h (today) · discount waiting for approval (today) · approved quotation, no payer
 *   (this week) · visit in 48 h (today: confirm and who comes) · visit done, no quotation within 3 days (today) ·
 *   decision-maker never engaged (this week: family consultation) · qualified, no visit (this week: visit, virtual if
 *   the family is abroad) · going quiet (this week: something of value, not a check-in — Amaya SOP) · customer SOP
 *   step due (welcome call, owner, community preview, monthly update, referral) · follow-up overdue · no next step.
 * When the person to contact has a time zone, the suggested time falls in their 10:00–19:00.
 */
import type { ActionMap } from '../core/actions';
import type { Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { assertLeadAccess, leadFilter } from '../core/scope';
import { settingsAll } from '../core/settings';
import { last10, str } from '../core/utils';
import { customerDue, healthOf, touchesFor, type Touch } from './engagement';
import { typedBudget } from './salesReport';

const S = CFG.STAGES;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLOSED = new Set<string>([S.LOST, S.JUNK, S.DND, S.TRASH, S.DELETED, S.DQ_BUDGET, S.DQ_LOCATION, S.DQ_RENTAL, S.DQ_NI, S.DQ_TIMELINE, S.DQ_PROJECT]);

export type Urgency = 'now' | 'today' | 'this week';
export interface Suggestion { key: string; title: string; why: string; urgency: Urgency; nextType: 'call' | 'whatsapp' | 'visit' | 'familyMeeting' | 'sendQuote' | 'other'; at: string; personId: string; personName: string; timeNote: string }
export interface Insight {
  leadId: string;
  name: string;
  stageLabel: string;
  score: number;
  scoreLabel: 'Ready to decide' | 'Progressing' | 'Early' | 'Cold' | 'Customer';
  signals: Array<{ label: string; points: number }>;
  next: Suggestion | null;
  also: Array<Pick<Suggestion, 'key' | 'title' | 'why' | 'urgency'>>;
  risks: string[];
}

export interface InsightInput {
  lead: any;
  touches: Touch[];
  quotes: Array<{ status: string; unitId: string; total: number; validUntil?: Date | null; createdAt: Date }>;
  units: Array<{ _id: string; status: string; holdUntil?: Date | null; price?: number; quotedAmount?: number; unitNumber?: string; leadId?: string }>;
  pendingApproval: boolean;
  missedCallAt: Date | null;
  overdueDemand: { label: string; amount: number; daysLate: number } | null;
  slaHours: number;
}

const STEP_POINTS: Array<[string, number, string]> = [
  ['booked', 100, 'Booked'], ['reserved', 80, 'Unit reserved'], ['visitDone', 50, 'Visited'], ['visitScheduled', 35, 'Visit set'], ['qualified', 25, 'Qualified'], ['contacted', 10, 'Contacted'],
];

/** The suggested time to reach a person: now if it is their 10:00–19:00, else their next 11:00. */
export function contactTime(tz: string, now = new Date()): { at: Date; note: string } {
  if (!tz) return { at: now, note: '' };
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz }).format(now));
  } catch {
    return { at: now, note: '' };
  }
  const local = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d);
  const ist = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata', weekday: 'short' }).format(d);
  const city = tz.split('/').pop()!.replace(/_/g, ' ');
  if (hour >= 10 && hour < 19) return { at: now, note: `It is ${local(now)} in ${city} now` };
  // the next local 11:00, found in 15-minute steps (works for half-hour zones such as India and Nepal)
  const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d);
  const start = new Date(Math.ceil(now.getTime() / (15 * 60_000)) * 15 * 60_000);
  let at = start;
  for (let i = 0; i < 4 * 25; i++) {
    const c = new Date(start.getTime() + i * 15 * 60_000);
    if (hm(c) === '11:00') { at = c; break; }
  }
  return { at, note: `${ist(at)} IST is ${local(at)} in ${city}` };
}

export function analyse(input: InsightInput, now = new Date()): Insight {
  const l = input.lead;
  const ms = l.milestones || {};
  const people: any[] = Array.isArray(l.people) ? l.people : [];
  const signals: Insight['signals'] = [];
  const risks: string[] = [];

  // furthest recorded step (an approved quotation sits between visited and reserved)
  const approvedQuote = input.quotes.find((q) => q.status === 'approved' || q.status === 'sent');
  let base = 0;
  let stageLabel = 'New enquiry';
  for (const [k, pts, label] of STEP_POINTS) if (ms[k]) { base = pts; stageLabel = label; break; }
  if (approvedQuote && base < 62 && base >= 25) { base = 62; stageLabel = 'Quotation approved'; }
  if (base) signals.push({ label: `Furthest step: ${stageLabel.toLowerCase()}`, points: base });

  const h = healthOf(input.touches, now);
  if (h.state === 'engaged') signals.push({ label: `Responded ${h.daysSinceResponse === 0 ? 'today' : `${h.daysSinceResponse} days ago`}`, points: 8 });
  if (h.state === 'cooling') signals.push({ label: `Last response ${h.daysSinceResponse} days ago`, points: -6 });
  if (h.state === 'cold') signals.push({ label: h.daysSinceResponse === null ? 'Never responded despite several touches' : `No response for ${h.daysSinceResponse} days`, points: -15 });

  const dm = people.find((p) => (p.roles || []).includes('decisionMaker'));
  const dmTouches = dm ? input.touches.filter((t) => t.personId === dm.id && (t.direction === 'in' || t.responded)) : [];
  if (dm && dmTouches.length) signals.push({ label: `${dm.name} (decision-maker) engaged`, points: 5 });
  const payer = people.find((p) => (p.roles || []).includes('payer'));
  if (payer) signals.push({ label: `Payer known: ${payer.name}`, points: 4 });

  const budget = typedBudget(l);
  const shortlisted = input.units.find((u) => input.quotes.some((q) => q.unitId === u._id)) || null;
  const price = Number(shortlisted?.quotedAmount || shortlisted?.price || 0);
  if (budget && price) {
    if (budget >= price * 0.9) signals.push({ label: 'Budget fits the shortlisted unit', points: 5 });
    else if (budget < price * 0.7) { signals.push({ label: 'Budget well below the shortlisted unit', points: -10 }); risks.push('The budget they mentioned is well below the shortlisted unit: consider a smaller unit or a payment plan conversation.'); }
  }
  const overdueFu = l.nextFollowupAt && new Date(l.nextFollowupAt).getTime() < now.getTime() - HOUR;
  if (overdueFu) signals.push({ label: 'Follow-up overdue', points: -5 });
  const booked = !!ms.booked;
  const closed = CLOSED.has(String(l.stage || ''));
  if (!l.nextFollowupAt && !booked && !closed) signals.push({ label: 'No next step set', points: -5 });

  const score = booked ? 100 : Math.max(0, Math.min(99, signals.reduce((a, s) => a + s.points, 0)));
  const scoreLabel: Insight['scoreLabel'] = booked ? 'Customer' : score >= 70 ? 'Ready to decide' : score >= 45 ? 'Progressing' : score >= 20 ? 'Early' : 'Cold';

  // who to contact and when
  const enquirer = people.find((p) => (p.roles || []).includes('enquirer')) || { id: '', name: str(l.name), timeZone: '', phone: l.phone };
  const abroad = people.some((p) => p.phone && !String(p.phone).startsWith('+91'));
  const target = (p: any) => {
    const t = contactTime(str(p?.timeZone), now);
    return { at: t.at.toISOString(), personId: str(p?.id), personName: str(p?.name), timeNote: t.note };
  };
  const cands: Suggestion[] = [];
  const add = (key: string, title: string, why: string, urgency: Urgency, nextType: Suggestion['nextType'], who: any = enquirer, at?: Date) => {
    const t = target(who);
    cands.push({ key, title, why, urgency, nextType, ...t, ...(at ? { at: at.toISOString() } : {}) });
  };

  if (input.missedCallAt) add('missedCall', 'Call back now', `They called ${Math.max(1, Math.round((now.getTime() - input.missedCallAt.getTime()) / 60000))} minutes ago and nobody has called back.`, 'now', 'call');
  // (a booked customer with no recorded first contact — older or imported data — is not a new enquiry)
  if (!ms.contacted && !closed && !booked) {
    const age = now.getTime() - new Date(l.enquiryDate || l.createdAt || now).getTime();
    add('firstContact', 'Make the first call', age > input.slaHours * HOUR ? `New enquiry, not contacted for ${Math.round(age / HOUR)} hours (response time is ${input.slaHours} h).` : 'New enquiry: the first call decides most of what follows.', 'now', 'call');
  }
  if (input.overdueDemand) add('payment', 'Remind about the payment due', `${input.overdueDemand.label} is ${input.overdueDemand.daysLate} days overdue.`, 'today', 'call', payer || enquirer);
  const hold = input.units.find((u) => u.status === 'Reserved' && u.leadId === l._id && u.holdUntil && new Date(u.holdUntil).getTime() - now.getTime() < DAY);
  if (hold) add('hold', `Confirm the booking of ${hold.unitNumber || 'the unit'}`, `The reservation lapses ${new Date(hold.holdUntil!).getTime() < now.getTime() ? 'now' : 'within 24 hours'}.`, 'today', 'call', payer || enquirer);
  if (input.quotes.some((q) => q.status === 'pendingApproval') || input.pendingApproval) add('approval', 'Get the approval moving', input.pendingApproval ? 'A booking request is waiting for a manager.' : 'A discount is waiting for a manager’s approval.', 'today', 'other');
  if (approvedQuote && !payer && !booked) add('payer', 'Find out who is paying', 'The quotation is approved, but no payer is recorded — booking needs one.', 'this week', 'familyMeeting');
  const visitAt = l.siteVisitStatus === CFG.SITE_VISIT.SCHEDULED && l.siteVisitDate ? new Date(l.siteVisitDate) : null;
  if (visitAt && visitAt.getTime() > now.getTime() && visitAt.getTime() - now.getTime() < 2 * DAY) add('confirmVisit', 'Confirm the visit and who is coming', `Visit on ${visitAt.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Confirm the time and whether the family joins in person or on video.`, 'today', 'whatsapp');
  const visited = ms.visitDone?.at ? new Date(ms.visitDone.at) : null;
  if (visited && !input.quotes.length && !booked && now.getTime() - visited.getTime() > 3 * DAY) add('quote', 'Send a quotation for the unit they liked', `They visited ${Math.round((now.getTime() - visited.getTime()) / DAY)} days ago and have no quotation yet.`, 'today', 'sendQuote');
  if (dm && !dmTouches.length && ms.contacted && !booked) add('family', `Hold a family consultation with ${dm.name}`, `${dm.name} decides, and has not been part of a conversation yet.`, 'this week', 'familyMeeting', dm);
  if (ms.qualified && !ms.visitScheduled && !ms.visitDone && !booked) add('visit', abroad ? 'Offer a video tour with the family' : 'Invite them to the experience centre', abroad ? 'Qualified, no visit yet, and part of the family is abroad.' : 'Qualified, but no visit yet: the visit is where most decisions start.', 'this week', 'visit');
  if ((h.state === 'cooling' || h.state === 'cold') && !booked && !closed) add('reengage', 'Send something of value', `${h.state === 'cold' ? 'They have gone quiet' : 'They are cooling'}: share a construction update, an event invitation or a resident story — not a "just checking in".`, 'this week', 'whatsapp');
  if (booked) for (const d of customerDue(l, input.touches, now)) add(`cx:${d.key}`, d.label, d.late ? 'Overdue under the customer steps of the sales SOP.' : 'Due under the customer steps of the sales SOP.', d.late ? 'today' : 'this week', d.key === 'welcomeCall' ? 'call' : 'other');
  if (overdueFu && !booked) add('overdue', 'Do the overdue follow-up', 'The promised follow-up time has passed.', 'today', 'call');
  if (!l.nextFollowupAt && !booked && !closed && !cands.length) add('nextStep', 'Set a next step', 'Every open enquiry needs one.', 'today', 'call');

  if (h.state === 'cold') risks.push('No response for a long time: consider whether the enquiry is still live.');
  if (abroad && !people.some((p) => p.timeZone)) risks.push('Part of the family is abroad but no time zone is recorded: calls may land at night.');
  if (!people.some((p) => p.consent?.whatsappMarketing === 'granted') && cands.some((c) => c.nextType === 'whatsapp')) risks.push('No recorded consent for WhatsApp offers: send a service message (a reply or visit confirmation), not a promotion.');

  return {
    leadId: String(l._id), name: str(l.name), stageLabel: booked ? 'Customer' : stageLabel, score, scoreLabel, signals, risks,
    next: cands[0] || null,
    also: cands.slice(1, 4).map(({ key, title, why, urgency }) => ({ key, title, why, urgency })),
  };
}

/** Everything analyse() needs for a set of leads, in a few queries. */
async function gather(leads: any[], now: Date): Promise<InsightInput[]> {
  const ids = leads.map((l) => String(l._id));
  const [quotes, units, approvals, schedules] = await Promise.all([
    col<any>('quotes').then((c) => c.find({ leadId: { $in: ids }, status: { $ne: 'superseded' } }).toArray()),
    col<any>(CFG.COLL.INVENTORY).then((c) => c.find({ leadId: { $in: ids } }, { projection: { status: 1, holdUntil: 1, price: 1, quotedAmount: 1, unitNumber: 1, leadId: 1 } }).toArray()),
    col<any>('approvals').then((c) => c.find({ leadId: { $in: ids }, status: 'pending' }, { projection: { leadId: 1 } }).toArray()),
    col<any>('paymentSchedules').then((c) => c.find({ leadId: { $in: ids } }).toArray()),
  ]);
  // quoted units that belong to nobody yet (shortlist)
  const quotedUnitIds = [...new Set(quotes.map((q: any) => q.unitId))];
  const quotedUnits = quotedUnitIds.length ? await (await col<any>(CFG.COLL.INVENTORY)).find({ _id: { $in: quotedUnitIds } }, { projection: { status: 1, holdUntil: 1, price: 1, quotedAmount: 1, unitNumber: 1, leadId: 1 } }).toArray() : [];
  const phones = leads.map((l) => last10(l.phone)).filter((k) => k.length === 10);
  const since = new Date(now.getTime() - 48 * HOUR);
  const calls = phones.length ? await (await col<any>(CFG.COLL.CALLS)).find({ phoneLast10: { $in: phones }, createdAt: { $gte: since } }, { projection: { phoneLast10: 1, direction: 1, status: 1, createdAt: 1 } }).toArray() : [];
  const receipts = schedules.length ? await (await col<any>('receipts')).find({ unitId: { $in: schedules.map((s: any) => s._id) }, voided: { $exists: false } }, { projection: { unitId: 1, amount: 1 } }).toArray() : [];
  const { buildStatement } = await import('./rera');
  const rate = Number((await settingsAll()).reraInterestRatePct) || null;
  const slaHours = Number((await settingsAll()).responseSlaHours) || 24;
  const out: InsightInput[] = [];
  for (const l of leads) {
    const id = String(l._id);
    const key = last10(l.phone);
    const mine = calls.filter((c: any) => c.phoneLast10 === key);
    const missed = mine.filter((c: any) => c.direction === 'Inbound' && ['Missed', 'No Answer'].includes(c.status)).sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
    const answeredAfter = missed && mine.some((c: any) => c.status === 'Completed' && c.createdAt > missed.createdAt);
    let overdueDemand: InsightInput['overdueDemand'] = null;
    for (const s of schedules.filter((x: any) => x.leadId === id)) {
      const paid = receipts.filter((r: any) => r.unitId === s._id).reduce((a: number, r: any) => a + r.amount, 0);
      const line = buildStatement(s, paid, { ratePct: rate, agreementRegistered: true, now }).lines.find((x) => x.status === 'overdue');
      if (line) overdueDemand = { label: line.label, amount: line.outstanding, daysLate: line.daysLate };
    }
    out.push({
      lead: l, touches: await touchesFor(l, now),
      quotes: quotes.filter((q: any) => q.leadId === id),
      units: [...units.filter((u: any) => u.leadId === id), ...quotedUnits.filter((u: any) => quotes.some((q: any) => q.leadId === id && q.unitId === u._id) && u.leadId !== id)],
      pendingApproval: approvals.some((a: any) => a.leadId === id),
      missedCallAt: missed && !answeredAfter ? new Date(missed.createdAt) : null,
      overdueDemand, slaHours,
    });
  }
  return out;
}

const PROJ = { name: 1, phone: 1, stage: 1, milestones: 1, nextFollowupAt: 1, people: 1, notes: 1, 'extra.Budget': 1, 'extra.Deal Value': 1, siteVisitStatus: 1, siteVisitDate: 1, followups: 1, enquiryDate: 1, createdAt: 1, customerJourney: 1, cxOwner: 1, assignedRm: 1 };

export async function getLeadInsight(leadId: string, ctx: Ctx, now = new Date()): Promise<Insight> {
  await assertLeadAccess(ctx, leadId);
  const l = await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: str(leadId) }, { projection: PROJ });
  if (!l) throw fail('NOT_FOUND', 'Lead not found: ' + leadId);
  return analyse((await gather([l], now))[0], now);
}

const URGENCY: Record<Urgency, number> = { now: 3, today: 2, 'this week': 1 };

/** The best next steps across the user's enquiries and customers, most urgent and most promising first. */
export async function getNextSteps(ctx: Ctx, now = new Date(), limit = 12) {
  const scope = (await leadFilter(ctx)) || {};
  const leads = await (await col<any>(CFG.COLL.LEADS)).find({ ...scope, stage: { $nin: [...CLOSED] } } as any, { projection: PROJ }).sort({ updatedAt: -1 }).limit(150).toArray();
  const all = (await gather(leads, now)).map((i) => analyse(i, now)).filter((x) => x.next);
  return all
    // urgency always wins (a 'now' item can never fall below a 'today' one); readiness orders within the same urgency
    .map((x) => ({ ...x, priority: URGENCY[x.next!.urgency] * 1000 + x.score }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit)
    .map(({ priority: _p, ...x }) => x);
}

export const actions: ActionMap = {
  getLeadInsight: { perm: 'leads.view', fn: (d, ctx) => getLeadInsight(str(d?.leadId), ctx) },
  getNextSteps: { perm: 'leads.view', fn: (_d, ctx) => getNextSteps(ctx) },
};
