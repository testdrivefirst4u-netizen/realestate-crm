/**
 * Daily work queues (Release B).
 *
 * getToday (agents; managers see their team's): what needs doing now, in the order an RM should do it —
 *   1. new enquiries not yet contacted (oldest first, flagged once past the response SLA)
 *   2. missed calls not returned
 *   3. promised callbacks and tasks due now or overdue
 *   4. follow-ups overdue, then due today
 *   5. visits in the next 7 days
 *   6. open enquiries with NO next action (each needs an owner and a next step)
 *
 * getTeamExceptions (managers): unassigned enquiries, untouched past the SLA, missed calls not returned, visits
 * in the next 48 h, stalled opportunities (no change in 14 days), pending approvals, and each agent's workload.
 *
 * Everything is scoped by record-level access (leadFilter / filterTasks / filterCalls), so an agent only ever
 * sees their own customers. Rows carry only what the queue needs; phone numbers pass the router's mask.
 */
import type { ActionMap } from '../core/actions';
import { can, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { leadFilter, restrictionFor } from '../core/scope';
import { filterCalls, filterTasks } from '../core/scopeGuards';
import { settingsAll } from '../core/settings';
import { dateKey, makeZoned } from '../core/utils';

const S = CFG.STAGES;
const HOUR = 3_600_000;
const CLOSED = [S.BOOKED, S.LOST, S.JUNK, S.DND, S.TRASH, S.DELETED, S.DQ_BUDGET, S.DQ_LOCATION, S.DQ_RENTAL, S.DQ_NI, S.DQ_TIMELINE, S.DQ_PROJECT];
const PROJ = { _id: 1, name: 1, phone: 1, stage: 1, assignedRm: 1, enquiryDate: 1, createdAt: 1, nextFollowupAt: 1, siteVisitDate: 1, siteVisitStatus: 1, updatedAt: 1, milestones: 1, source: 1, nextAction: 1 };

export interface QueueRow {
  leadId: string;
  name: string;
  phone: string;
  stage: string;
  rm: string;
  at: string; // the time that matters for this queue
  note: string;
  late: boolean;
}

const row = (l: any, at: Date | null | undefined, note: string, late = false): QueueRow => ({
  leadId: String(l._id), name: String(l.name || ''), phone: String(l.phone || ''), stage: String(l.stage || ''), rm: String(l.assignedRm || ''),
  at: at ? new Date(at).toISOString() : '', note, late,
});

async function slaHours(): Promise<number> {
  const n = Number((await settingsAll()).responseSlaHours);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function dayBounds(now: Date) {
  const [y, m, d] = dateKey(now).split('-').map(Number);
  return { start: makeZoned(y, m, d), end: makeZoned(y, m, d + 1) };
}

export async function getToday(ctx: Ctx, now = new Date()) {
  const scope = (await leadFilter(ctx)) || {};
  const leads = await col<any>(CFG.COLL.LEADS);
  const open = { ...scope, stage: { $nin: CLOSED } };
  const { start, end } = dayBounds(now);
  const sla = (await slaHours()) * HOUR;

  const fresh = await leads.find({ ...open, 'milestones.contacted': { $exists: false }, stage: S.NEW } as any, { projection: PROJ }).sort({ enquiryDate: 1 }).limit(100).toArray();
  const newEnquiries = fresh.map((l) => {
    const at = l.enquiryDate || l.createdAt;
    const late = at && now.getTime() - new Date(at).getTime() > sla;
    return row(l, at, late ? 'Past the response time' : 'Not contacted yet', !!late);
  });

  const overdue = await leads.find({ ...open, nextFollowupAt: { $lt: start } } as any, { projection: PROJ }).sort({ nextFollowupAt: 1 }).limit(100).toArray();
  const today = await leads.find({ ...open, nextFollowupAt: { $gte: start, $lt: end } } as any, { projection: PROJ }).sort({ nextFollowupAt: 1 }).limit(100).toArray();
  const visits = await leads
    .find({ ...scope, siteVisitStatus: CFG.SITE_VISIT.SCHEDULED, siteVisitDate: { $gte: new Date(now.getTime() - 2 * HOUR), $lt: new Date(now.getTime() + 7 * 24 * HOUR) } } as any, { projection: PROJ })
    .sort({ siteVisitDate: 1 })
    .limit(50)
    .toArray();

  // tasks: mine (or visible), pending, due before the end of today
  const taskRows = await (await col<any>(CFG.COLL.TASKS)).find({ completed: { $ne: true }, status: { $ne: 'Completed' }, dateTime: { $lt: end } }).sort({ dateTime: 1 }).limit(300).toArray();
  const mine = await filterTasks(ctx.user, taskRows.map((t) => ({ ...t, leadId: String(t.leadId || '') })));
  const restricted = !can(ctx.user, 'leads.viewAll');
  const tasks = mine
    .filter((t: any) => !restricted || t.assignedToId === ctx.user?.id || String(t.assignedTo || '').toLowerCase() === String(ctx.user?.name || '').toLowerCase())
    .slice(0, 100)
    .map((t: any) => ({ taskId: String(t._id), name: String(t.name), leadId: String(t.leadId || ''), lead: String(t.lead || ''), at: t.dateTime ? new Date(t.dateTime).toISOString() : '', late: !!t.dateTime && new Date(t.dateTime) < now }));

  const missedCalls = await missedNotReturned(ctx, now);
  // engagement: open enquiries going quiet, and booked customers with an SOP step due (server/modules/engagement.ts)
  const E = await import('./engagement');
  const [cooling, customers] = await Promise.all([E.coolingLeads(ctx, now), E.customerQueue(ctx, now)]);

  // open enquiries without a next step: no follow-up date and no pending task
  const withTask = new Set(taskRows.filter((t) => t.leadId).map((t) => String(t.leadId)));
  const noNext = (await leads.find({ ...open, $or: [{ nextFollowupAt: null }, { nextFollowupAt: { $exists: false } }] } as any, { projection: PROJ }).limit(200).toArray())
    .filter((l) => !withTask.has(String(l._id)))
    .slice(0, 100)
    .map((l) => row(l, l.updatedAt, 'No next action'));

  return {
    generatedAt: now.toISOString(),
    slaHours: sla / HOUR,
    newEnquiries,
    missedCalls,
    tasks,
    overdueFollowups: overdue.map((l) => row(l, l.nextFollowupAt, 'Follow-up overdue', true)),
    dueToday: today.map((l) => row(l, l.nextFollowupAt, 'Follow-up today')),
    upcomingVisits: visits.map((l) => row(l, l.siteVisitDate, 'Visit')),
    noNextAction: noNext,
    cooling,
    customers,
    counts: {
      newEnquiries: newEnquiries.length, late: newEnquiries.filter((r) => r.late).length, missedCalls: missedCalls.length, tasks: tasks.length,
      overdueFollowups: overdue.length, dueToday: today.length, upcomingVisits: visits.length, noNextAction: noNext.length, cooling: cooling.length, customers: customers.length,
    },
  };
}

/** Inbound missed / unanswered calls in the last 48 h with no later connected call to that number. */
async function missedNotReturned(ctx: Ctx, now: Date) {
  const calls = await col<any>(CFG.COLL.CALLS);
  const since = new Date(now.getTime() - 48 * HOUR);
  const missed = await calls.find({ direction: 'Inbound', status: { $in: ['Missed', 'No Answer'] }, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(200).toArray();
  if (!missed.length) return [];
  const keys = [...new Set(missed.map((c) => String(c.phoneLast10 || '')).filter(Boolean))];
  const later = await calls.find({ phoneLast10: { $in: keys }, status: 'Completed', createdAt: { $gte: since } }, { projection: { phoneLast10: 1, createdAt: 1 } }).toArray();
  const returned = (c: any) => later.some((x) => x.phoneLast10 === c.phoneLast10 && x.createdAt > c.createdAt);
  const seen = new Set<string>();
  const open = missed.filter((c) => {
    if (returned(c) || seen.has(String(c.phoneLast10))) return false;
    seen.add(String(c.phoneLast10));
    return true;
  });
  const visible = await filterCalls(ctx.user, open.map((c) => ({ ...c, leadId: String(c.leadId || ''), loggedBy: String(c.loggedBy || ''), phone: String(c.phone || '') })));
  return visible.slice(0, 50).map((c: any) => ({ callId: String(c._id), leadId: String(c.leadId || ''), name: String(c.customerName || ''), phone: String(c.phone || ''), at: new Date(c.createdAt).toISOString(), minutesAgo: Math.round((now.getTime() - new Date(c.createdAt).getTime()) / 60000) }));
}

export async function getTeamExceptions(ctx: Ctx, now = new Date()) {
  if (!can(ctx.user, 'leads.viewAll')) throw fail('FORBIDDEN', 'The team view is for managers');
  const leads = await col<any>(CFG.COLL.LEADS);
  // a manager limited to their team (organisation) sees their team's exceptions only
  const scope = (await leadFilter(ctx)) || {};
  const r = await restrictionFor(ctx.user);
  const open = { ...scope, stage: { $nin: CLOSED } };
  const sla = (await slaHours()) * HOUR;
  const unassigned = await leads.find({ ...open, $or: [{ assignedRm: { $in: ['', null] } }, { assignedRm: { $exists: false } }] } as any, { projection: PROJ }).sort({ enquiryDate: 1 }).limit(100).toArray();
  const untouched = await leads.find({ ...open, stage: S.NEW, 'milestones.contacted': { $exists: false }, enquiryDate: { $lt: new Date(now.getTime() - sla) } } as any, { projection: PROJ }).sort({ enquiryDate: 1 }).limit(100).toArray();
  const stalled = await leads.find({ ...open, stage: { $in: [S.QUALIFIED, S.WARM, S.HOT] }, updatedAt: { $lt: new Date(now.getTime() - 14 * 24 * HOUR) } } as any, { projection: PROJ }).sort({ updatedAt: 1 }).limit(100).toArray();
  const visits = await leads.find({ ...scope, siteVisitStatus: CFG.SITE_VISIT.SCHEDULED, siteVisitDate: { $gte: now, $lt: new Date(now.getTime() + 48 * HOUR) } } as any, { projection: PROJ }).sort({ siteVisitDate: 1 }).limit(50).toArray();
  const { filterByLead } = await import('../core/scope');
  const approvals = await filterByLead(ctx.user, await (await col<any>('approvals')).find({ status: 'pending' }).sort({ requestedAt: 1 }).limit(50).toArray(), (a: any) => a.leadId);
  const pendingQuotes = await filterByLead(ctx.user, await (await col<any>('quotes')).find({ status: 'pendingApproval' }).sort({ createdAt: 1 }).limit(50).toArray(), (q: any) => q.leadId);

  // workload per active agent (by immutable id, with the name as a label)
  const users = (await listUsers()).filter((u) => u.status !== 'Disabled' && ['RM', 'Manager'].includes(u.role) && (!r || r.ids.includes(u.id)));
  const agg = await leads.aggregate<{ _id: string; open: number; overdue: number; untouched: number }>([
    { $match: open },
    { $group: { _id: { $ifNull: ['$assignedRmId', '$assignedRm'] }, open: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$nextFollowupAt', now] }, 1, 0] } }, untouched: { $sum: { $cond: [{ $and: [{ $eq: ['$stage', S.NEW] }, { $eq: [{ $type: '$milestones.contacted' }, 'missing'] }] }, 1, 0] } } } },
  ]).toArray();
  const byKey = new Map(agg.map((a) => [String(a._id), a]));
  const workload = users.map((u) => {
    const a = byKey.get(u.id) || byKey.get(u.name);
    return { userId: u.id, name: u.name, role: u.role, open: a?.open || 0, overdue: a?.overdue || 0, untouched: a?.untouched || 0 };
  }).sort((x, y) => y.overdue - x.overdue || y.open - x.open);

  // people read names, not ids
  const unitIds = [...new Set([...approvals.map((a) => a.unitId), ...pendingQuotes.map((q) => q.unitId)])];
  const leadIds = [...new Set([...approvals.map((a) => a.leadId), ...pendingQuotes.map((q) => q.leadId)])];
  const unitDocs = await (await col<any>(CFG.COLL.INVENTORY)).find({ _id: { $in: unitIds } }, { projection: { unitNumber: 1, price: 1 } }).toArray();
  const unitNo = new Map(unitDocs.map((u) => [String(u._id), String(u.unitNumber)]));
  const listPrice = new Map(unitDocs.map((u) => [String(u._id), Number(u.price) || 0]));
  // the quotation each booking will be made at, so the approver sees the price and the discount
  const quoteIds = approvals.map((a) => a.quoteId).filter(Boolean);
  const quoteOf = new Map((await (await col<any>('quotes')).find({ _id: { $in: quoteIds } }, { projection: { total: 1, discount: 1, basePrice: 1, version: 1 } }).toArray()).map((q) => [String(q._id), q]));
  const leadName = new Map((await leads.find({ _id: { $in: leadIds } }, { projection: { name: 1 } }).toArray()).map((l) => [String(l._id), String(l.name)]));
  return {
    generatedAt: now.toISOString(),
    slaHours: sla / HOUR,
    unassigned: unassigned.map((l) => row(l, l.enquiryDate || l.createdAt, 'No owner')),
    untouchedPastSla: untouched.map((l) => row(l, l.enquiryDate, 'Not contacted within the response time', true)),
    missedCalls: await missedNotReturned(ctx, now),
    visitsNext48h: visits.map((l) => row(l, l.siteVisitDate, 'Visit')),
    stalled: stalled.map((l) => row(l, l.updatedAt, 'No change in 14 days')),
    approvals: approvals.map((a) => ({ id: a._id, kind: a.kind, leadId: a.leadId, leadName: leadName.get(a.leadId) || a.leadId, unitId: a.unitId, unitNumber: unitNo.get(a.unitId) || a.unitId, requestedBy: a.requestedBy, note: a.note || '', at: new Date(a.requestedAt).toISOString(), quoteTotal: Number(quoteOf.get(String(a.quoteId))?.total) || 0, quoteDiscount: Number(quoteOf.get(String(a.quoteId))?.discount) || 0, quoteBase: Number(quoteOf.get(String(a.quoteId))?.basePrice) || 0, listPrice: listPrice.get(a.unitId) || 0 })),
    discountApprovals: pendingQuotes.map((q) => ({ id: q._id, leadId: q.leadId, leadName: leadName.get(q.leadId) || q.leadId, unitId: q.unitId, unitNumber: unitNo.get(q.unitId) || q.unitId, version: q.version, discount: q.discount, total: q.total, by: q.createdBy, at: new Date(q.createdAt).toISOString() })),
    workload,
  };
}

/** Audited reassignment of many leads at once (a manager moving an absent agent's work). */
export async function reassignLeads(d: { leadIds: string[]; to: string; reason: string }, ctx: Ctx) {
  if (!can(ctx.user, 'leads.viewAll')) throw fail('FORBIDDEN', 'Only managers reassign leads');
  const reason = String(d?.reason || '').trim();
  if (!reason) throw fail('VALIDATION', 'Give a reason for the reassignment (it is kept in the history)');
  const ids = Array.isArray(d?.leadIds) ? d.leadIds.map(String).slice(0, 500) : [];
  if (!ids.length) throw fail('VALIDATION', 'Choose the leads to reassign');
  const target = (await listUsers()).find((u) => u.id === d.to || u.name === d.to);
  if (!target || target.status === 'Disabled') throw fail('VALIDATION', 'Choose an active team member');
  const r = await restrictionFor(ctx.user);
  if (r && !r.ids.includes(target.id)) throw fail('FORBIDDEN', `${target.name} is not in your team`);
  const { assertLeadAccess } = await import('../core/scope');
  for (const id of ids) await assertLeadAccess(ctx, id);
  const { updateLead, appendRemark } = await import('./leads');
  let moved = 0;
  for (const id of ids) {
    try {
      await updateLead(id, { [CFG.LEAD.RM]: target.name }, ctx);
      await appendRemark(id, `Reassigned to ${target.name}: ${reason}`, null, undefined, ctx.user?.name || 'Manager');
      moved++;
    } catch {
      /* a lead that no longer exists is skipped */
    }
  }
  const { auditLog } = await import('../core/auth');
  await auditLog(ctx, 'Leads Reassigned', 'Lead', ids.slice(0, 20).join(','), `${moved} to ${target.name} · ${reason}`);
  return { moved, to: target.name };
}

export const actions: ActionMap = {
  getToday: { perm: 'leads.view', fn: (_d, ctx) => getToday(ctx) },
  getTeamExceptions: { perm: 'leads.viewAll', fn: (_d, ctx) => getTeamExceptions(ctx) },
  reassignLeads: { perm: 'leads.edit', fn: (d, ctx) => reassignLeads(d, ctx) },
};
