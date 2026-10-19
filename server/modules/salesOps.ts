/**
 * Sales automation (company setting `salesOps`, Settings › Alerts & follow-ups) and team numbers.
 *
 * runLeadWatch(now) — every few minutes (cron /api/cron/watch):
 *   - auto-reassign: a fresh New lead nobody has acted on (no follow-up, call, WhatsApp or stage change) within
 *     `reassignAfterMin` working minutes moves to the next RM, who is alerted as usual; managers are told;
 *   - site-visit reminders: a phone notification to the assigned RM the day before (from 10 AM) and 2 hours before;
 *   - evening summary: once a day at `summaryHour`, a phone notification with the day's numbers to chosen users.
 * Everything is free (Web Push and e-mail) — no WhatsApp or SMS.
 * leaderboard({ days }) — follow-ups, calls, site visits and bookings per RM.
 * campaignSpend — ad spend per campaign and month (entered by hand) for cost per lead / visit / booking in MIS.
 */
import type { ActionMap } from '../core/actions';
import { listUsers, SYSTEM_CTX, type Ctx, type PublicUser } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addEvent, addTimeline, logError } from '../core/events';
import type { LeadDoc } from '../core/leadShape';
import { settingSet, settingsAll } from '../core/settings';
import { currentTenant } from '../core/tenant';
import { dateKey, fmtDate, fmtTime, localHour, makeZoned, safeJsonParse } from '../core/utils';
import { notifyAdmins } from './adminAlerts';
import { idsByEmail, idsByName, sendPush } from './push';
import { updateLead } from './leads';

const S = CFG.STAGES;
const L = CFG.LEAD;
const HOUR = 3600000;

/* -------------------------------- settings ------------------------------- */

export interface SalesOps {
  /** Move a New lead on when nobody acted on it within this many working minutes; 0 = off. */
  reassignAfterMin: number;
  /** How many times one lead may be moved on. */
  reassignMax: number;
  /** Working hours (local): the clock only runs between these hours. */
  workStartHour: number;
  workEndHour: number;
  /** Phone notification to the assigned RM before a scheduled site visit. */
  visitReminders: boolean;
  /** Evening phone notification with the day's numbers to chosen users. */
  summaryPush: boolean;
  summaryHour: number;
  /** E-mails of the users who get the summary. */
  summaryTo: string;
}

export const SALES_OPS_DEFAULTS: SalesOps = {
  reassignAfterMin: 0, reassignMax: 1, workStartHour: 9, workEndHour: 20,
  visitReminders: true, summaryPush: false, summaryHour: 19, summaryTo: '',
};

const int = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const bool = (v: unknown) => v === true || v === 'true';
const EMAILS = (s: string) => s.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

export function parseSalesOps(raw: unknown): SalesOps {
  const o = ((typeof raw === 'string' ? safeJsonParse<Record<string, unknown>>(raw, {}) : raw) || {}) as Record<string, unknown>;
  const D = SALES_OPS_DEFAULTS;
  const s = (k: keyof SalesOps) => String(o[k] ?? D[k]).trim();
  return {
    reassignAfterMin: int(o.reassignAfterMin, D.reassignAfterMin, 0, 24 * 60),
    reassignMax: int(o.reassignMax, D.reassignMax, 1, 5),
    workStartHour: int(o.workStartHour, D.workStartHour, 0, 23),
    workEndHour: int(o.workEndHour, D.workEndHour, 1, 24),
    visitReminders: o.visitReminders === undefined ? D.visitReminders : bool(o.visitReminders),
    summaryPush: bool(o.summaryPush),
    summaryHour: int(o.summaryHour, D.summaryHour, 0, 23),
    summaryTo: s('summaryTo'),
  };
}


export async function validateSalesOps(raw: unknown): Promise<string> {
  const c = parseSalesOps(raw);
  if (c.reassignAfterMin && c.reassignAfterMin < 5) throw fail('VALIDATION', 'Give the RM at least 5 minutes before a lead is moved on');
  if (c.workEndHour <= c.workStartHour) throw fail('VALIDATION', 'Working hours must end after they start');
  const active = new Map((await listUsers()).filter((u) => u.status !== 'Disabled').map((u) => [u.email.toLowerCase(), u]));
  const to = EMAILS(c.summaryTo);
  for (const e of to) if (!active.has(e)) throw fail('VALIDATION', `Summary recipients must be active CRM users (${e} is not)`);
  if (c.summaryPush && !to.length) throw fail('VALIDATION', 'Choose who gets the evening summary');
  return JSON.stringify({ ...c, summaryTo: to.join(', ') });
}

/* -------------------------------- helpers -------------------------------- */

/** Claim a once-only key (reminder sent, summary sent); false when it was claimed before. */
async function claimOnce(key: string): Promise<boolean> {
  try {
    await (await col<{ _id: string; at: Date }>(CFG.COLL.META)).insertOne({ _id: 'once:' + key, at: new Date() });
    return true;
  } catch (e: any) {
    if (e?.code === 11000) return false;
    throw e;
  }
}

const leadsCol = () => col<LeadDoc>(CFG.COLL.LEADS);

/* ----------------------------- auto-reassign ----------------------------- */

/** When the working-hours clock for a lead given out at `assignedAt` runs out (minutes after the later of the two). */
export function reassignDue(assignedAt: Date, cfg: Pick<SalesOps, 'reassignAfterMin' | 'workStartHour'>): Date {
  const k = dateKey(assignedAt).split('-').map(Number);
  const opens = makeZoned(k[0], k[1], k[2], cfg.workStartHour);
  const from = assignedAt < opens ? opens : assignedAt;
  return new Date(from.getTime() + cfg.reassignAfterMin * 60000);
}

/** Did anyone act on the lead since it was given to the current RM? */
async function touchedSince(l: LeadDoc, since: Date): Promise<boolean> {
  if ((l.followups || []).length || l.lastFollowupAt) return true;
  if ((await (await col(CFG.COLL.CALLS)).countDocuments({ leadId: l._id }, { limit: 1 })) > 0) return true;
  const robots = ['System', 'Auto-reply', 'RM alert', 'Auto-reassign', ''];
  const tl = await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId: l._id, type: 'chat_sent', actor: { $nin: robots }, timestamp: { $gte: since } }, { limit: 1 });
  return tl > 0;
}

/** The RM with the fewest leads given out today, other than the ones the lead already had. */
async function nextRm(exclude: string[], users: PublicUser[], now: Date): Promise<string> {
  const skip = new Set(exclude.map((x) => x.trim().toLowerCase()));
  const reps = users.filter((u) => u.status !== 'Disabled' && u.role === 'RM' && !skip.has(u.name.trim().toLowerCase()));
  if (!reps.length) return '';
  const k = dateKey(now).split('-').map(Number);
  const today = makeZoned(k[0], k[1], k[2]);
  const counts = new Map<string, number>();
  for (const r of await (await leadsCol()).aggregate<{ _id: string; n: number }>([{ $match: { assignedAt: { $gte: today } } }, { $group: { _id: '$assignedRm', n: { $sum: 1 } } }]).toArray()) counts.set(r._id, r.n);
  return [...reps].sort((a, b) => (counts.get(a.name) || 0) - (counts.get(b.name) || 0) || a.name.localeCompare(b.name))[0].name;
}

export async function reassignStale(cfg: SalesOps, now = new Date()): Promise<{ moved: number; stuck: number }> {
  const out = { moved: 0, stuck: 0 };
  if (!cfg.reassignAfterMin) return out;
  const h = localHour(now);
  if (h < cfg.workStartHour || h >= cfg.workEndHour) return out;
  const candidates = await (await leadsCol())
    .find({
      stage: S.NEW, assignedRm: { $nin: ['', null] }, assignedAt: { $gte: new Date(now.getTime() - 24 * HOUR), $lte: new Date(now.getTime() - cfg.reassignAfterMin * 60000) },
      $or: [{ reassignCount: { $exists: false } }, { reassignCount: { $lt: cfg.reassignMax } }],
    } as any)
    .limit(100)
    .toArray();
  if (!candidates.length) return out;
  const users = await listUsers();
  for (const l of candidates) {
    try {
      const at = new Date(l.assignedAt!);
      if (reassignDue(at, cfg) > now || (await touchedSince(l, at))) continue;
      const from = l.assignedRm;
      const tried = [...(l.reassignedFrom || []), from];
      const to = await nextRm(tried, users, now);
      const mins = Math.round((now.getTime() - at.getTime()) / 60000);
      if (!to) {
        // nobody left to give it to: stop trying and tell the managers once
        await (await leadsCol()).updateOne({ _id: l._id }, { $set: { reassignCount: cfg.reassignMax } });
        await notifyAdmins('reassign-none:' + l._id, `Lead not picked up: ${l.name}`, `${l.name} (${l._id}) has had no call, follow-up or WhatsApp from ${from} for ${mins} minutes and there is no other RM to move it to.`);
        out.stuck++;
        continue;
      }
      await updateLead(l._id, { [L.RM]: to }, { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: 'Auto-reassign' }, action: 'salesOps' });
      await (await leadsCol()).updateOne({ _id: l._id }, { $inc: { reassignCount: 1 }, $push: { reassignedFrom: from } } as any);
      await addTimeline(l._id, 'lead_reassigned', `Moved from ${from} to ${to}`, `No call, follow-up or WhatsApp within ${cfg.reassignAfterMin} working minutes`, 'Auto-reassign');
      await addEvent('lead_reassigned', 'Lead', l._id, `Lead moved to ${to}: ${l.name}`, `${from} did not act on it within ${cfg.reassignAfterMin} minutes`, 'Auto-reassign');
      await notifyAdmins('reassign:' + l._id, `Lead moved from ${from} to ${to}`, `${l.name} (${l._id}) had no call, follow-up or WhatsApp from ${from} for ${mins} minutes, so it was moved to ${to}.`);
      out.moved++;
    } catch (e: any) {
      await logError('salesOps.reassign', 'INTERNAL', e?.message, e?.stack, '', { leadId: l._id });
    }
  }
  return out;
}

/* --------------------------- site-visit reminders ------------------------ */

export async function sendVisitReminders(cfg: SalesOps, now = new Date()): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  if (!cfg.visitReminders) return out;
  const tomorrow = dateKey(new Date(now.getTime() + 24 * HOUR));
  const visits = await (await leadsCol())
    .find({ siteVisitStatus: CFG.SITE_VISIT.SCHEDULED, siteVisitDate: { $gt: now, $lte: new Date(now.getTime() + 48 * HOUR) }, stage: { $nin: [S.TRASH, S.DELETED, S.DND, S.JUNK] }, assignedRm: { $nin: ['', null] } } as any)
    .limit(300)
    .toArray();
  if (!visits.length) return out;
  const users = await listUsers();
  for (const l of visits) {
    const at = new Date(l.siteVisitDate!);
    const left = at.getTime() - now.getTime();
    // 2 hours before; and the day before from 10 AM (skipped when the visit is close anyway)
    const kind = left <= 2 * HOUR ? 'h2' : dateKey(at) === tomorrow && localHour(now) >= 10 && left > 4 * HOUR ? 'd1' : '';
    if (!kind) continue;
    const ids = idsByName([l.assignedRm], users);
    if (!ids.length || !(await claimOnce(`visit:${l._id}:${at.toISOString()}:${kind}`))) continue;
    const r = await sendPush(ids, {
      title: kind === 'h2' ? `Site visit at ${fmtTime(at)}: ${l.name}` : `Tomorrow: site visit with ${l.name}`,
      body: [kind === 'h2' ? 'In about 2 hours' : `${fmtDate(at)} at ${fmtTime(at)}`, l.unitType, l.phone ? `Call ${l.phone}` : ''].filter(Boolean).join(' · '),
      url: `/leads?lead=${encodeURIComponent(l._id)}`,
      tag: `visit-${l._id}`,
    });
    if (r.sent) out.sent++;
    else out.failed++;
  }
  return out;
}

/* ----------------------------- evening summary --------------------------- */

export async function dayNumbers(now = new Date()): Promise<Record<string, string>> {
  const k = dateKey(now).split('-').map(Number);
  const start = makeZoned(k[0], k[1], k[2]);
  const end = new Date(start.getTime() + 24 * HOUR);
  const end2 = new Date(start.getTime() + 48 * HOUR);
  const leads = await leadsCol();
  const live = { stage: { $nin: [S.TRASH, S.DELETED] } };
  const [created, followups, calls, visitsToday, visitsTomorrow, overdue, booked] = await Promise.all([
    leads.countDocuments({ ...live, enquiryDate: { $gte: start, $lt: end } } as any),
    (await col(CFG.COLL.TIMELINE)).countDocuments({ type: 'remark_added', timestamp: { $gte: start, $lt: end } }),
    (await col(CFG.COLL.CALLS)).countDocuments({ callDate: { $gte: start, $lt: end } }),
    leads.countDocuments({ ...live, siteVisitDate: { $gte: start, $lt: end } } as any),
    leads.countDocuments({ ...live, siteVisitDate: { $gte: end, $lt: end2 } } as any),
    leads.countDocuments({ stage: { $nin: [S.TRASH, S.DELETED, S.BOOKED, S.DND, S.JUNK, S.LOST], $not: /^Disqualified/ }, nextFollowupAt: { $ne: null, $lt: now } } as any),
    leads.countDocuments({ bookingDate: { $gte: start, $lt: end } } as any),
  ]);
  return {
    date: fmtDate(now), new: String(created), followups: String(followups), calls: String(calls),
    visits_today: String(visitsToday), visits_tomorrow: String(visitsTomorrow), overdue: String(overdue), booked: String(booked),
  };
}

export async function sendEveningSummary(cfg: SalesOps, now = new Date()): Promise<{ sent: number; skipped?: string }> {
  if (!cfg.summaryPush) return { sent: 0, skipped: 'off' };
  if (localHour(now) < cfg.summaryHour) return { sent: 0, skipped: 'not yet' };
  if (!(await claimOnce('summary:' + dateKey(now)))) return { sent: 0, skipped: 'already sent' };
  const n = await dayNumbers(now);
  const ids = idsByEmail(EMAILS(cfg.summaryTo), await listUsers());
  const r = await sendPush(ids, {
    title: `Today in the CRM · ${n.date}`,
    body: `${n.new} new leads · ${n.followups} follow-ups · ${n.calls} calls · ${n.visits_today} site visits · ${n.booked} booked\n${n.overdue} follow-ups overdue · ${n.visits_tomorrow} visits tomorrow`,
    url: '/dashboard',
    tag: 'daily-summary',
  });
  return { sent: r.sent };
}

/** One watch run (inside a company). */
export async function runLeadWatch(now = new Date()) {
  const cfg = parseSalesOps((await settingsAll()).salesOps);
  const reassigned = await reassignStale(cfg, now).catch(async (e) => { await logError('salesOps.watch', 'INTERNAL', e?.message, e?.stack); return { moved: 0, stuck: 0 }; });
  const visits = await sendVisitReminders(cfg, now).catch(async (e) => { await logError('salesOps.watch', 'INTERNAL', e?.message, e?.stack); return { sent: 0, failed: 0 }; });
  const summary = await sendEveningSummary(cfg, now).catch(async (e) => { await logError('salesOps.watch', 'INTERNAL', e?.message, e?.stack); return { sent: 0 }; });
  return { reassigned, visits, summary };
}

/* ------------------------------- leaderboard ----------------------------- */

export interface LeaderRow { rm: string; followups: number; calls: number; visits: number; bookings: number }

export async function leaderboard(d: { days?: number } | undefined, now = new Date()): Promise<{ from: string; to: string; rows: LeaderRow[] }> {
  const days = int(d?.days, 7, 1, 90);
  const k = dateKey(new Date(now.getTime() - (days - 1) * 24 * HOUR)).split('-').map(Number);
  const from = makeZoned(k[0], k[1], k[2]);
  const users = (await listUsers()).filter((u) => u.status !== 'Disabled' && (u.role === 'RM' || u.role === 'Manager'));
  const rows = new Map<string, LeaderRow>(users.map((u) => [u.name, { rm: u.name, followups: 0, calls: 0, visits: 0, bookings: 0 }]));
  const row = (name: string) => rows.get(name);
  const [fu, calls, visits, bookings] = await Promise.all([
    (await col(CFG.COLL.TIMELINE)).aggregate<{ _id: string; n: number }>([{ $match: { type: 'remark_added', timestamp: { $gte: from, $lte: now } } }, { $group: { _id: '$actor', n: { $sum: 1 } } }]).toArray(),
    (await col(CFG.COLL.CALLS)).aggregate<{ _id: string; n: number }>([{ $match: { callDate: { $gte: from, $lte: now } } }, { $group: { _id: '$loggedBy', n: { $sum: 1 } } }]).toArray(),
    (await leadsCol()).aggregate<{ _id: string; n: number }>([{ $match: { siteVisitDate: { $gte: from, $lte: now }, siteVisitStatus: { $in: [CFG.SITE_VISIT.COMPLETED, CFG.SITE_VISIT.WALK_IN] } } }, { $group: { _id: '$assignedRm', n: { $sum: 1 } } }]).toArray(),
    (await leadsCol()).aggregate<{ _id: string; n: number }>([{ $match: { bookingDate: { $gte: from, $lte: now } } }, { $group: { _id: '$assignedRm', n: { $sum: 1 } } }]).toArray(),
  ]);
  for (const r of fu) { const x = row(r._id); if (x) x.followups = r.n; }
  for (const r of calls) { const x = row(r._id); if (x) x.calls = r.n; }
  for (const r of visits) { const x = row(r._id); if (x) x.visits = r.n; }
  for (const r of bookings) { const x = row(r._id); if (x) x.bookings = r.n; }
  const score = (r: LeaderRow) => r.bookings * 100 + r.visits * 20 + r.calls * 2 + r.followups;
  return {
    from: from.toISOString(), to: now.toISOString(),
    rows: [...rows.values()].sort((a, b) => score(b) - score(a) || a.rm.localeCompare(b.rm)),
  };
}

/* ------------------------------ campaign spend --------------------------- */

export interface SpendRow { campaign: string; month: string; amount: number }

export function parseSpend(raw: unknown): SpendRow[] {
  const list = (typeof raw === 'string' ? safeJsonParse<unknown[]>(raw, []) : raw) as unknown[];
  if (!Array.isArray(list)) return [];
  return list
    .map((r: any) => ({ campaign: String(r?.campaign ?? '').trim().slice(0, 200), month: String(r?.month ?? '').trim(), amount: Math.round(Number(r?.amount) * 100) / 100 }))
    .filter((r) => r.campaign && /^\d{4}-\d{2}$/.test(r.month) && Number.isFinite(r.amount) && r.amount >= 0);
}

export async function getCampaignSpend(): Promise<{ rows: SpendRow[] }> {
  return { rows: parseSpend((await settingsAll()).campaignSpend) };
}

/** Replace the spend of one month (rows with amount 0 are removed). */
export async function saveCampaignSpend(d: { month: string; rows: Array<{ campaign: string; amount: number }> }, ctx: Ctx): Promise<{ rows: SpendRow[] }> {
  const month = String(d?.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail('VALIDATION', 'Choose a month');
  if (!Array.isArray(d?.rows) || d.rows.length > 500) throw fail('VALIDATION', 'Send at most 500 campaigns');
  const incoming = parseSpend(d.rows.map((r) => ({ ...r, month }))).filter((r) => r.amount > 0);
  if (incoming.some((r) => r.amount > 1e9)) throw fail('VALIDATION', 'That amount looks too large');
  const rows = [...parseSpend((await settingsAll()).campaignSpend).filter((r) => r.month !== month), ...incoming];
  if (rows.length > 5000) throw fail('VALIDATION', 'Too many spend entries — remove old months first');
  await settingSet('campaignSpend', JSON.stringify(rows), ctx.user?.name || 'System');
  return { rows };
}

export const actions: ActionMap = {
  leaderboard: { fn: (d) => leaderboard(d), perm: 'leads.view' },
  getCampaignSpend: { fn: () => getCampaignSpend(), perm: 'reports.view' },
  saveCampaignSpend: { fn: (d, ctx) => saveCampaignSpend(d, ctx), perm: 'settings.edit' },
};
