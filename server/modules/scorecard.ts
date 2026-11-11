/**
 * Scorecards: each person's month, against targets, rolled up through the organisation (server/modules/org.ts).
 *
 * Measures, per person, for the calendar month (India time), from recorded events only:
 *   enquiries        new enquiries they own (Enquiry Date in the month)
 *   respondedInTime  of those that are due, first response within the SLA (overall: overdue unanswered count against)
 *   contacted        enquiries whose first contact happened in the month
 *   calls            connected calls they logged
 *   visits           visits completed (recorded milestone)
 *   quotations       quotations they created
 *   bookings         bookings recorded in the month, and their value (agreed price of the units)
 *   collections      receipts received in the month on their customers' units (receipts ledger, not typed totals)
 *   touches          customer touches they logged (engagement)
 *
 * A team's row is the sum of everyone under that person, themselves included; the in-time % is recomputed from the
 * summed counts, never averaged. Who sees what: everyone sees their own card; a manager sees their team (or
 * everyone, if not limited to a team); Admins and View only see everyone. Targets are set per person per month by
 * someone above them in the organisation (or an Admin), never by the person themselves.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { restrictionFor } from '../core/scope';
import { makeZoned, str } from '../core/utils';
import { orgLevels, orgPeople, subtree, type OrgPerson } from './org';
import { computeSalesReport } from './salesReport';

export const MEASURES = ['enquiries', 'respondedInTime', 'contacted', 'calls', 'visits', 'quotations', 'bookings', 'bookedValue', 'collections', 'touches'] as const;
export type Measure = (typeof MEASURES)[number];
export const TARGETABLE: Measure[] = ['contacted', 'calls', 'visits', 'quotations', 'bookings', 'bookedValue', 'collections', 'touches', 'respondedInTime'];
type Counts = Record<Measure, number> & { slaEligible: number; slaWithin: number };

const zero = (): Counts => ({ enquiries: 0, respondedInTime: 0, contacted: 0, calls: 0, visits: 0, quotations: 0, bookings: 0, bookedValue: 0, collections: 0, touches: 0, slaEligible: 0, slaWithin: 0 });

export function monthRange(month: string): { from: Date; to: Date; key: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const now = new Date(Date.now() + 5.5 * 3600e3);
  const y = m ? Number(m[1]) : now.getUTCFullYear();
  const mo = m ? Number(m[2]) : now.getUTCMonth() + 1;
  if (mo < 1 || mo > 12) throw fail('VALIDATION', 'Month must be YYYY-MM');
  const from = makeZoned(y, mo, 1);
  const to = new Date(makeZoned(y, mo + 1, 1).getTime() - 1);
  return { from, to, key: `${y}-${String(mo).padStart(2, '0')}` };
}

/** Raw counts per person id for one month. */
export async function countsByPerson(people: OrgPerson[], from: Date, to: Date, now = new Date()): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>(people.map((p) => [p.id, zero()]));
  const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p.id]));
  const owner = (id: unknown, name: unknown) => (str(id) && out.has(str(id)) ? str(id) : byName.get(str(name).trim().toLowerCase()) || '');
  const inMonth = { $gte: from, $lte: to };
  const leadsCol = await col<any>(CFG.COLL.LEADS);
  const add = (pid: string, k: keyof Counts, n = 1) => {
    if (pid && out.has(pid)) out.get(pid)![k] += n;
  };

  // enquiries and the SLA, per owner, through the same definitions as the sales report
  const cohort = await leadsCol.find({ enquiryDate: inMonth, stage: { $nin: [CFG.STAGES.TRASH, CFG.STAGES.DELETED] } }, { projection: { enquiryDate: 1, createdAt: 1, stage: 1, followups: 1, milestones: 1, assignedRm: 1, assignedRmId: 1 } }).toArray();
  const perOwner = new Map<string, any[]>();
  for (const l of cohort) {
    const pid = owner(l.assignedRmId, l.assignedRm);
    if (pid) perOwner.set(pid, [...(perOwner.get(pid) || []), l]);
  }
  for (const [pid, list] of perOwner) {
    const r = computeSalesReport(list, [], { from, to, now });
    add(pid, 'enquiries', r.enquiries);
    add(pid, 'slaEligible', r.sla.eligible);
    add(pid, 'slaWithin', r.sla.withinSla);
  }
  // milestones in the month (whatever month the enquiry came in)
  for (const [m, k] of [['contacted', 'contacted'], ['visitDone', 'visits'], ['booked', 'bookings']] as const) {
    for (const l of await leadsCol.find({ [`milestones.${m}.at`]: inMonth } as any, { projection: { assignedRm: 1, assignedRmId: 1 } }).toArray()) add(owner(l.assignedRmId, l.assignedRm), k);
  }
  // booked value: agreed price of units booked in the month
  const booked = await leadsCol.find({ 'milestones.booked.at': inMonth } as any, { projection: { assignedRm: 1, assignedRmId: 1 } }).toArray();
  if (booked.length) {
    const ownerOf = new Map(booked.map((l) => [String(l._id), owner(l.assignedRmId, l.assignedRm)]));
    for (const u of await (await col<any>(CFG.COLL.INVENTORY)).find({ leadId: { $in: [...ownerOf.keys()] }, status: { $in: ['Booked', 'Sold'] } }, { projection: { leadId: 1, quotedAmount: 1, price: 1 } }).toArray()) {
      add(ownerOf.get(String(u.leadId)) || '', 'bookedValue', Number(u.quotedAmount || u.price || 0));
    }
  }
  for (const c of await (await col<any>(CFG.COLL.CALLS)).find({ status: 'Completed', createdAt: inMonth }, { projection: { loggedBy: 1, loggedById: 1 } }).toArray()) add(owner(c.loggedById, c.loggedBy), 'calls');
  for (const q of await (await col<any>('quotes')).find({ createdAt: inMonth }, { projection: { createdBy: 1 } }).toArray()) add(owner('', q.createdBy), 'quotations');
  for (const e of await (await col<any>('engagements')).find({ at: inMonth }, { projection: { byId: 1, by: 1 } }).toArray()) add(owner(e.byId, e.by), 'touches');
  // collections: receipts received in the month, credited to the customer's owner
  const receipts = await (await col<any>('receipts')).find({ receivedOn: inMonth, voided: { $exists: false } }, { projection: { leadId: 1, amount: 1 } }).toArray();
  if (receipts.length) {
    const owners = new Map((await leadsCol.find({ _id: { $in: [...new Set(receipts.map((r) => String(r.leadId)))] } }, { projection: { assignedRm: 1, assignedRmId: 1 } }).toArray()).map((l) => [String(l._id), owner(l.assignedRmId, l.assignedRm)]));
    for (const r of receipts) add(owners.get(String(r.leadId)) || '', 'collections', Number(r.amount || 0));
  }
  for (const c of out.values()) c.respondedInTime = c.slaEligible ? Math.round((c.slaWithin * 1000) / c.slaEligible) / 10 : 0;
  return out;
}

function sumCounts(list: Counts[]): Counts {
  const s = zero();
  for (const c of list) for (const k of Object.keys(s) as Array<keyof Counts>) if (k !== 'respondedInTime') s[k] += c[k];
  s.respondedInTime = s.slaEligible ? Math.round((s.slaWithin * 1000) / s.slaEligible) / 10 : 0;
  return s;
}

const targetsCol = () => col<any>('targets'); // _id `${userId}:${YYYY-MM}`

export interface ScoreRow { id: string; name: string; role: string; level: number | null; levelName: string; reportsTo: string; depth: number; own: Counts; team: Counts; hasTeam: boolean; targets: Partial<Record<Measure, number>> }

/** The scorecard tree this user may see for a month. */
export async function getScorecard(d: { month?: string }, ctx: Ctx, now = new Date()) {
  const { from, to, key } = monthRange(str(d?.month));
  const people = (await orgPeople()).filter((p) => p.status === 'Active' && p.role !== 'Viewer' && p.role !== 'Developer');
  const levels = await orgLevels();
  const me = ctx.user!;
  const r = await restrictionFor(me);
  // whom this user may see: everyone (admins, view only, managers not limited), their team, or just themselves
  const visible = new Set(!r ? people.map((p) => p.id) : r.team ? r.ids : [me.id]);
  if (!r && !can(me, 'leads.viewAll')) visible.clear(), visible.add(me.id);
  const shown = people.filter((p) => visible.has(p.id));
  const counts = await countsByPerson(people, from, to, now);
  const targets = new Map((await targetsCol().then((c) => c.find({ month: key }).toArray())).map((t: any) => [String(t.userId), t.values || {}]));
  // tree over the people shown: roots are those whose manager is not shown
  const shownIds = new Set(shown.map((p) => p.id));
  const children = new Map<string, OrgPerson[]>();
  const roots: OrgPerson[] = [];
  for (const p of shown) (p.reportsTo && shownIds.has(p.reportsTo) ? children.set(p.reportsTo, [...(children.get(p.reportsTo) || []), p]) : roots.push(p));
  const rows: ScoreRow[] = [];
  const walk = (p: OrgPerson, depth: number) => {
    const ids = subtree(shown, p.id);
    rows.push({ id: p.id, name: p.name, role: p.role, level: p.level, levelName: p.level ? levels[p.level - 1] || '' : '', reportsTo: p.reportsTo, depth, own: counts.get(p.id)!, team: sumCounts(ids.map((i) => counts.get(i)!)), hasTeam: ids.length > 1, targets: targets.get(p.id) || {} });
    for (const c of (children.get(p.id) || []).sort((a, b) => (a.level || 9) - (b.level || 9) || a.name.localeCompare(b.name))) walk(c, depth + 1);
  };
  for (const p of roots.sort((a, b) => (a.level || 9) - (b.level || 9) || a.name.localeCompare(b.name))) walk(p, 0);
  return {
    month: key, levels, rows,
    total: sumCounts(shown.map((p) => counts.get(p.id)!)),
    mine: rows.find((x) => x.id === me.id) || null,
    canSetTargetsFor: shown.filter((p) => mayTarget(ctx, p, people)).map((p) => p.id),
  };
}

function mayTarget(ctx: Ctx, p: OrgPerson, people: OrgPerson[]): boolean {
  if (!ctx.user || p.id === ctx.user.id) return false;
  if (can(ctx.user, 'users.manage')) return true; // Admins
  return subtree(people, ctx.user.id).includes(p.id) && can(ctx.user, 'users.manageAgents'); // someone above them
}

export async function setTargets(d: { userId: string; month: string; values: Record<string, unknown> }, ctx: Ctx) {
  const { key } = monthRange(str(d?.month));
  const people = await orgPeople();
  const p = people.find((x) => x.id === str(d?.userId));
  if (!p) throw fail('NOT_FOUND', 'User not found');
  if (!mayTarget(ctx, p, people)) throw fail('FORBIDDEN', 'Targets are set by someone above this person in the organisation, or an admin');
  const values: Partial<Record<Measure, number>> = {};
  for (const k of TARGETABLE) {
    const v = d?.values?.[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (k === 'respondedInTime' && n > 100)) throw fail('VALIDATION', `Invalid target for ${k}`);
    values[k] = Math.round(n * 100) / 100;
  }
  await (await targetsCol()).updateOne({ _id: `${p.id}:${key}` }, { $set: { userId: p.id, month: key, values, setBy: ctx.user?.name || '', setAt: new Date() } }, { upsert: true });
  await auditLog(ctx, 'Targets Set', 'Settings', p.id, `${p.name} ${key}: ${Object.entries(values).map(([k, v]) => `${k} ${v}`).join(', ') || 'cleared'}`);
  return { ok: true, values };
}

export const actions: ActionMap = {
  getScorecard: { perm: 'reports.view', fn: (d, ctx) => getScorecard(d, ctx) },
  setTargets: { perm: 'users.manageAgents', fn: (d, ctx) => setTargets(d, ctx) },
};
