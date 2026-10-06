/**
 * Amaya CRM — the single data-processing layer.
 *
 * Dashboard, Reports (monthly / comparison / till-date), the AI Copilot and
 * the Follow-ups view all compute their numbers through this module, so a KPI
 * means the same thing everywhere.
 *
 * Attribution rules (documented in docs/REPORTS.md):
 *  - Enquiries ............ Enquiry Date within range
 *  - Site visits .......... Site Visit Date within range; legacy rows without
 *                            a Site Visit Date fall back to Enquiry Date
 *  - Bookings ............. Booking Date within range; fallback Enquiry Date
 *  - Follow-ups completed . timestamp of each "Follow-up N" entry within range
 *  - Follow-ups due ....... Next Follow-up Date within range, active stages only
 *  - Tasks ................ task due date/time within range
 *  - Stage counts ......... CURRENT stage of the leads enquired in the range
 *  - Trash / Permanently Deleted leads are never counted.
 */
import { Lead, TaskItem } from '../types/crm';
import {
  F,
  MAX_FOLLOWUPS,
  QUALIFIED_STAGES,
  SITE_VISIT,
  SITE_VISIT_DONE,
  STAGES,
  STAGE_CLASS,
  followupField,
  FUNNEL_STAGES,
} from './config';
import {
  DateRange,
  currentMonthKey,
  daysSince,
  hoursBetween,
  inRange,
  listMonths,
  monthKey,
  monthLabel,
  monthRange,
  parseDate,
  splitFollowupEntry,
  startOfDay,
  endOfDay,
  dateKey,
} from './dates';
import { pctChange } from './format';

/* ------------------------------------------------------------------------ */
/* Stage helpers                                                             */
/* ------------------------------------------------------------------------ */

export type StageClass = 'active' | 'won' | 'lost' | 'excluded' | 'unknown';

export function stageOf(lead: Lead): string {
  return String(lead[F.STAGE] || '').trim();
}

export function classifyStage(stage: string): StageClass {
  const s = String(stage || '').trim();
  if (STAGE_CLASS.excluded.includes(s)) return 'excluded';
  if (STAGE_CLASS.won.includes(s)) return 'won';
  if (STAGE_CLASS.lost.includes(s)) return 'lost';
  if (STAGE_CLASS.active.includes(s)) return 'active';
  if (!s) return 'active'; // blank stage = brand new
  return 'unknown';
}

export const isCounted = (lead: Lead) => classifyStage(stageOf(lead)) !== 'excluded';
export const isActive = (lead: Lead) => {
  const c = classifyStage(stageOf(lead));
  return c === 'active' || c === 'unknown';
};
export const isBooked = (lead: Lead) => classifyStage(stageOf(lead)) === 'won';
export const isLost = (lead: Lead) => classifyStage(stageOf(lead)) === 'lost';
export const isQualified = (lead: Lead) => QUALIFIED_STAGES.includes(stageOf(lead));
export const isHot = (lead: Lead) => stageOf(lead) === STAGES.HOT;
export const isWarm = (lead: Lead) => stageOf(lead) === STAGES.WARM;
export const isNew = (lead: Lead) => stageOf(lead) === STAGES.NEW || stageOf(lead) === '';

/** Leads that should appear anywhere in the CRM (not trashed/deleted). */
export function countedLeads(leads: Lead[]): Lead[] {
  return leads.filter(isCounted);
}

/* ------------------------------------------------------------------------ */
/* Date accessors with legacy fallbacks                                      */
/* ------------------------------------------------------------------------ */

export function enquiryDate(lead: Lead): Date | null {
  return parseDate(lead[F.ENQUIRY_DATE]) || parseDate(lead[F.CREATED_AT]);
}

export function siteVisitDate(lead: Lead): Date | null {
  return parseDate(lead[F.SITE_VISIT_DATE]) || enquiryDate(lead);
}

export function bookingDate(lead: Lead): Date | null {
  return parseDate(lead[F.BOOKING_DATE]) || enquiryDate(lead);
}

export function nextFollowupDate(lead: Lead): Date | null {
  return parseDate(lead[F.NEXT_FOLLOWUP]);
}

export interface FollowupEntry {
  index: number;
  date: Date | null;
  text: string;
  raw: string;
}

/** Parsed "Follow-up N" entries in column order. */
export function followupEntries(lead: Lead): FollowupEntry[] {
  const out: FollowupEntry[] = [];
  for (let i = 1; i <= MAX_FOLLOWUPS; i++) {
    const raw = lead[followupField(i)];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const { date, text } = splitFollowupEntry(String(raw));
    out.push({ index: i, date, text, raw: String(raw) });
  }
  return out;
}

export function followupCount(lead: Lead): number {
  let n = 0;
  for (let i = 1; i <= MAX_FOLLOWUPS; i++) {
    if (String(lead[followupField(i)] || '').trim()) n++;
  }
  return n;
}

/** Latest contact timestamp: max(Last Follow-up, follow-up entry dates). */
export function lastActivityDate(lead: Lead): Date | null {
  let latest = parseDate(lead[F.LAST_FOLLOWUP]);
  for (const e of followupEntries(lead)) {
    if (e.date && (!latest || e.date > latest)) latest = e.date;
  }
  return latest;
}

/** Earliest follow-up (first response). */
export function firstResponseDate(lead: Lead): Date | null {
  let first: Date | null = null;
  for (const e of followupEntries(lead)) {
    if (e.date && (!first || e.date < first)) first = e.date;
  }
  return first;
}

export function responseTimeHours(lead: Lead): number | null {
  const enq = enquiryDate(lead);
  const first = firstResponseDate(lead);
  if (!enq || !first) return null;
  const h = hoursBetween(enq, first);
  return h === null ? null : Math.max(0, h);
}

/* ------------------------------------------------------------------------ */
/* Breakdowns                                                                */
/* ------------------------------------------------------------------------ */

export interface Breakdown {
  key: string;
  label: string;
  count: number;
  percent: number; // share of total
  qualified?: number;
  siteVisits?: number;
  bookings?: number;
  conversionRate?: number;
}

export interface RMPerformance {
  rm: string;
  enquiries: number;
  open: number;
  hot: number;
  qualified: number;
  siteVisits: number;
  bookings: number;
  conversionRate: number;
  followupsCompleted: number;
  followupsOverdue: number;
  avgResponseHours: number | null;
  slaWithin24hPercent: number | null;
}

export interface KpiSnapshot {
  rangeLabel: string;
  rangeKey?: string;
  totalEnquiries: number;
  newLeads: number;
  openLeads: number;
  hotLeads: number;
  warmLeads: number;
  qualifiedLeads: number;
  bookings: number;
  lostLeads: number;
  siteVisitProspects: number;
  siteVisitsScheduled: number;
  siteVisitsCompleted: number;
  siteVisitsTotal: number;
  followupsDue: number;
  followupsOverdue: number;
  followupsCompleted: number;
  pendingTasks: number;
  completedTasks: number;
  conversionRate: number; // % of the period's enquiries that are Booked (cohort-based, 0–100)
  qualificationRate: number; // % of the period's enquiries that are Qualified/Booked
  siteVisitRate: number; // % of the period's enquiries with a completed/walk-in visit
  avgResponseHours: number | null;
  bySource: Breakdown[];
  byRM: RMPerformance[];
  byStage: Breakdown[];
  byUnitType: Breakdown[];
  byPurchaseType: Breakdown[];
  /** IDs for drill-down from dashboard cards */
  ids: {
    enquiries: string[];
    open: string[];
    hot: string[];
    warm: string[];
    qualified: string[];
    booked: string[];
    lost: string[];
    svScheduled: string[];
    svCompleted: string[];
    svProspects: string[];
    followupsDue: string[];
    followupsOverdue: string[];
  };
}

const idOf = (l: Lead) => String(l[F.ID] || '');

function breakdown(leads: Lead[], field: string, labelFn?: (k: string) => string): Breakdown[] {
  const map = new Map<string, Lead[]>();
  for (const l of leads) {
    const k = String(l[field] || '').trim() || 'Unspecified';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(l);
  }
  const total = leads.length || 1;
  return [...map.entries()]
    .map(([key, list]) => {
      const bookings = list.filter(isBooked).length;
      return {
        key,
        label: labelFn ? labelFn(key) : key,
        count: list.length,
        percent: (list.length / total) * 100,
        qualified: list.filter(isQualified).length,
        siteVisits: list.filter((l) => SITE_VISIT_DONE.includes(l[F.SITE_VISIT_STATUS])).length,
        bookings,
        conversionRate: list.length ? (bookings / list.length) * 100 : 0,
      };
    })
    .sort((a, b) => b.count - a.count);
}

function stageBreakdown(leads: Lead[]): Breakdown[] {
  const order = [...FUNNEL_STAGES, ...STAGE_CLASS.lost];
  const counts = new Map<string, number>();
  for (const l of leads) {
    const s = stageOf(l) || STAGES.NEW;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const total = leads.length || 1;
  const keys = [...new Set([...order, ...counts.keys()])].filter((k) => counts.has(k));
  return keys.map((k) => ({ key: k, label: k, count: counts.get(k) || 0, percent: ((counts.get(k) || 0) / total) * 100 }));
}

/* ------------------------------------------------------------------------ */
/* KPI computation                                                           */
/* ------------------------------------------------------------------------ */

export interface KpiOptions {
  /** Filter by RM before computing */
  rm?: string;
  /** Filter by source */
  source?: string;
  /** Reference "now" (for overdue) */
  now?: Date;
}

export function computeKpis(
  allLeads: Lead[],
  allTasks: TaskItem[],
  range: DateRange | null,
  opts: KpiOptions = {}
): KpiSnapshot {
  const now = opts.now || new Date();
  let leads = countedLeads(allLeads);
  if (opts.rm) leads = leads.filter((l) => String(l[F.RM] || '').trim() === opts.rm);
  if (opts.source) leads = leads.filter((l) => String(l[F.SOURCE] || '').trim() === opts.source);

  // Cohort: leads enquired within range (or all when range null)
  const cohort = range ? leads.filter((l) => inRange(enquiryDate(l), range)) : leads;

  const open = cohort.filter(isActive);
  const hot = cohort.filter(isHot);
  const warm = cohort.filter(isWarm);
  const qualified = cohort.filter(isQualified);
  const lost = cohort.filter(isLost);
  const newLeads = cohort.filter(isNew);

  // Event-based metrics (own dates, with fallbacks) across ALL leads, not only the cohort
  const booked = leads.filter((l) => isBooked(l) && (!range || inRange(bookingDate(l), range)));
  const svScheduled = leads.filter(
    (l) => l[F.SITE_VISIT_STATUS] === SITE_VISIT.SCHEDULED && (!range || inRange(siteVisitDate(l), range))
  );
  const svCompleted = leads.filter(
    (l) => SITE_VISIT_DONE.includes(l[F.SITE_VISIT_STATUS]) && (!range || inRange(siteVisitDate(l), range))
  );
  const svProspects = cohort.filter((l) => l[F.SITE_VISIT_STATUS] === SITE_VISIT.PROSPECT);

  // Follow-ups
  const followupsDue = leads.filter((l) => {
    if (!isActive(l)) return false;
    const d = nextFollowupDate(l);
    if (!d) return false;
    return range ? inRange(d, range) : true;
  });
  const followupsOverdue = leads.filter((l) => {
    if (!isActive(l)) return false;
    const d = nextFollowupDate(l);
    return !!d && d.getTime() < now.getTime() && (range ? inRange(d, range) : true);
  });
  let followupsCompleted = 0;
  for (const l of leads) {
    for (const e of followupEntries(l)) {
      if (!e.date) continue;
      if (!range || inRange(e.date, range)) followupsCompleted++;
    }
  }

  // Tasks
  const tasksInRange = allTasks.filter((t) => (range ? inRange(t.datetime, range) : true));
  const completedTasks = tasksInRange.filter((t) => t.completed || t.status === 'Completed').length;
  const pendingTasks = tasksInRange.length - completedTasks;

  // Response time
  const rts = cohort.map(responseTimeHours).filter((h): h is number => h !== null);
  const avgResponseHours = rts.length ? rts.reduce((a, b) => a + b, 0) / rts.length : null;

  const total = cohort.length;
  const bookingsCount = booked.length;
  // Rates are cohort-based (how the enquiries received in the period performed) so they
  // stay within 0–100% even when bookings/visits in the period belong to older enquiries.
  const cohortBooked = cohort.filter(isBooked).length;
  const cohortVisited = cohort.filter((l) => SITE_VISIT_DONE.includes(l[F.SITE_VISIT_STATUS])).length;

  return {
    rangeLabel: range ? range.label : 'All Time',
    rangeKey: range?.key,
    totalEnquiries: total,
    newLeads: newLeads.length,
    openLeads: open.length,
    hotLeads: hot.length,
    warmLeads: warm.length,
    qualifiedLeads: qualified.length,
    bookings: bookingsCount,
    lostLeads: lost.length,
    siteVisitProspects: svProspects.length,
    siteVisitsScheduled: svScheduled.length,
    siteVisitsCompleted: svCompleted.length,
    siteVisitsTotal: svScheduled.length + svCompleted.length,
    followupsDue: followupsDue.length,
    followupsOverdue: followupsOverdue.length,
    followupsCompleted,
    pendingTasks,
    completedTasks,
    conversionRate: total ? (cohortBooked / total) * 100 : 0,
    qualificationRate: total ? (qualified.length / total) * 100 : 0,
    siteVisitRate: total ? (cohortVisited / total) * 100 : 0,
    avgResponseHours,
    bySource: breakdown(cohort, F.SOURCE),
    byRM: rmPerformance(cohort, leads, range, now),
    byStage: stageBreakdown(cohort),
    byUnitType: breakdown(cohort, F.UNIT_TYPE),
    byPurchaseType: breakdown(cohort, F.PURCHASE_OR_RENT),
    ids: {
      enquiries: cohort.map(idOf),
      open: open.map(idOf),
      hot: hot.map(idOf),
      warm: warm.map(idOf),
      qualified: qualified.map(idOf),
      booked: booked.map(idOf),
      lost: lost.map(idOf),
      svScheduled: svScheduled.map(idOf),
      svCompleted: svCompleted.map(idOf),
      svProspects: svProspects.map(idOf),
      followupsDue: followupsDue.map(idOf),
      followupsOverdue: followupsOverdue.map(idOf),
    },
  };
}

function rmPerformance(cohort: Lead[], allCounted: Lead[], range: DateRange | null, now: Date): RMPerformance[] {
  const rms = new Set<string>();
  for (const l of cohort) rms.add(String(l[F.RM] || '').trim() || 'Unassigned');
  for (const l of allCounted) if (isBooked(l)) rms.add(String(l[F.RM] || '').trim() || 'Unassigned');

  const rows: RMPerformance[] = [];
  for (const rm of rms) {
    const mine = cohort.filter((l) => (String(l[F.RM] || '').trim() || 'Unassigned') === rm);
    const mineAll = allCounted.filter((l) => (String(l[F.RM] || '').trim() || 'Unassigned') === rm);
    const bookings = mineAll.filter((l) => isBooked(l) && (!range || inRange(bookingDate(l), range))).length;
    const siteVisits = mineAll.filter(
      (l) => SITE_VISIT_DONE.includes(l[F.SITE_VISIT_STATUS]) && (!range || inRange(siteVisitDate(l), range))
    ).length;
    let followupsCompleted = 0;
    for (const l of mineAll) for (const e of followupEntries(l)) if (e.date && (!range || inRange(e.date, range))) followupsCompleted++;
    const overdue = mineAll.filter((l) => {
      if (!isActive(l)) return false;
      const d = nextFollowupDate(l);
      return !!d && d.getTime() < now.getTime();
    }).length;
    const rts = mine.map(responseTimeHours).filter((h): h is number => h !== null);
    const avg = rts.length ? rts.reduce((a, b) => a + b, 0) / rts.length : null;
    const sla = rts.length ? (rts.filter((h) => h <= 24).length / rts.length) * 100 : null;
    rows.push({
      rm,
      enquiries: mine.length,
      open: mine.filter(isActive).length,
      hot: mine.filter(isHot).length,
      qualified: mine.filter(isQualified).length,
      siteVisits,
      bookings,
      conversionRate: mine.length ? (mine.filter(isBooked).length / mine.length) * 100 : 0,
      followupsCompleted,
      followupsOverdue: overdue,
      avgResponseHours: avg,
      slaWithin24hPercent: sla,
    });
  }
  return rows.sort((a, b) => b.enquiries - a.enquiries || b.bookings - a.bookings);
}

/* ------------------------------------------------------------------------ */
/* Monthly reporting                                                         */
/* ------------------------------------------------------------------------ */

export interface MonthPoint {
  key: string; // yyyy-MM
  label: string;
  enquiries: number;
  qualified: number;
  hot: number;
  siteVisits: number;
  bookings: number;
  conversionRate: number;
  followupsCompleted: number;
  tasks: number;
}

/** Month keys from the earliest enquiry to the current month (ascending). */
export function availableMonths(leads: Lead[], tasks: TaskItem[] = []): string[] {
  let earliest: string | null = null;
  for (const l of countedLeads(leads)) {
    const k = monthKey(enquiryDate(l));
    if (k && (!earliest || k < earliest)) earliest = k;
  }
  for (const t of tasks) {
    const k = monthKey(t.datetime);
    if (k && (!earliest || k < earliest)) earliest = k;
  }
  const current = currentMonthKey();
  if (!earliest) return [current];
  // guard against garbage dates far in the past
  const minAllowed = `${+current.slice(0, 4) - 5}-01`;
  if (earliest < minAllowed) earliest = minAllowed;
  return listMonths(earliest, current);
}

export function monthlySeries(leads: Lead[], tasks: TaskItem[], monthKeys?: string[], opts: KpiOptions = {}): MonthPoint[] {
  const keys = monthKeys && monthKeys.length ? monthKeys : availableMonths(leads, tasks);
  return keys.map((k) => {
    const s = computeKpis(leads, tasks, monthRange(k), opts);
    return {
      key: k,
      label: monthLabel(k),
      enquiries: s.totalEnquiries,
      qualified: s.qualifiedLeads,
      hot: s.hotLeads,
      siteVisits: s.siteVisitsCompleted,
      bookings: s.bookings,
      conversionRate: s.conversionRate,
      followupsCompleted: s.followupsCompleted,
      tasks: s.pendingTasks + s.completedTasks,
    };
  });
}

export function monthlyReport(leads: Lead[], tasks: TaskItem[], key: string, opts: KpiOptions = {}): KpiSnapshot {
  return computeKpis(leads, tasks, monthRange(key), opts);
}

export interface ComparisonRow {
  metric: string;
  previous: number;
  current: number;
  difference: number;
  pctChange: number | null; // null when previous = 0 and current > 0
  direction: 'up' | 'down' | 'flat';
  format?: 'number' | 'percent' | 'hours';
  /** true when a decrease is good (e.g. overdue follow-ups) */
  lowerIsBetter?: boolean;
}

export const COMPARISON_METRICS: Array<{
  id: keyof KpiSnapshot;
  label: string;
  format?: 'number' | 'percent' | 'hours';
  lowerIsBetter?: boolean;
}> = [
  { id: 'totalEnquiries', label: 'Enquiries' },
  { id: 'newLeads', label: 'New Leads' },
  { id: 'qualifiedLeads', label: 'Qualified Leads' },
  { id: 'hotLeads', label: 'Hot Leads' },
  { id: 'warmLeads', label: 'Warm Leads' },
  { id: 'siteVisitsScheduled', label: 'Site Visits Scheduled' },
  { id: 'siteVisitsCompleted', label: 'Site Visits Completed' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'conversionRate', label: 'Conversion Rate', format: 'percent' },
  { id: 'followupsCompleted', label: 'Follow-ups Completed' },
  { id: 'followupsOverdue', label: 'Follow-ups Overdue', lowerIsBetter: true },
  { id: 'pendingTasks', label: 'Pending Tasks', lowerIsBetter: true },
  { id: 'completedTasks', label: 'Completed Tasks' },
  { id: 'lostLeads', label: 'Lost / Disqualified', lowerIsBetter: true },
  { id: 'avgResponseHours', label: 'Avg First Response', format: 'hours', lowerIsBetter: true },
];

export function compareSnapshots(previous: KpiSnapshot, current: KpiSnapshot): ComparisonRow[] {
  return COMPARISON_METRICS.map((m) => {
    const p = Number(previous[m.id] ?? 0) || 0;
    const c = Number(current[m.id] ?? 0) || 0;
    const diff = c - p;
    return {
      metric: m.label,
      previous: p,
      current: c,
      difference: diff,
      pctChange: pctChange(p, c),
      direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
      format: m.format || 'number',
      lowerIsBetter: m.lowerIsBetter,
    };
  });
}

export function compareMonths(leads: Lead[], tasks: TaskItem[], prevKey: string, currKey: string, opts: KpiOptions = {}) {
  const previous = monthlyReport(leads, tasks, prevKey, opts);
  const current = monthlyReport(leads, tasks, currKey, opts);
  return { previous, current, rows: compareSnapshots(previous, current) };
}

export interface TillDateReport {
  snapshot: KpiSnapshot;
  monthly: MonthPoint[];
  firstEnquiryDate: Date | null;
  totalFollowups: number;
}

export function tillDateReport(leads: Lead[], tasks: TaskItem[], opts: KpiOptions = {}): TillDateReport {
  const snapshot = computeKpis(leads, tasks, null, opts);
  const monthly = monthlySeries(leads, tasks, undefined, opts);
  let first: Date | null = null;
  let totalFollowups = 0;
  for (const l of countedLeads(leads)) {
    const d = enquiryDate(l);
    if (d && (!first || d < first)) first = d;
    totalFollowups += followupCount(l);
  }
  return { snapshot, monthly, firstEnquiryDate: first, totalFollowups };
}

/* ------------------------------------------------------------------------ */
/* Follow-up buckets and lead queries (Follow-ups view, Copilot)             */
/* ------------------------------------------------------------------------ */

export interface FollowupBuckets {
  none: Lead[];
  overdue: Lead[];
  today: Lead[];
  tomorrow: Lead[];
  upcoming: Lead[];
}

export function followupBuckets(leads: Lead[], now: Date = new Date()): FollowupBuckets {
  const active = countedLeads(leads).filter(isActive);
  const today = dateKey(now);
  const tomorrow = dateKey(new Date(startOfDay(now).getTime() + 86_400_000 + 3_600_000));
  const out: FollowupBuckets = { none: [], overdue: [], today: [], tomorrow: [], upcoming: [] };
  for (const l of active) {
    const d = nextFollowupDate(l);
    if (!d) {
      out.none.push(l);
      continue;
    }
    const k = dateKey(d);
    if (k < today) out.overdue.push(l);
    else if (k === today) out.today.push(l);
    else if (k === tomorrow) out.tomorrow.push(l);
    else out.upcoming.push(l);
  }
  const byDue = (a: Lead, b: Lead) => (nextFollowupDate(a)?.getTime() || 0) - (nextFollowupDate(b)?.getTime() || 0);
  out.overdue.sort(byDue);
  out.today.sort(byDue);
  out.tomorrow.sort(byDue);
  out.upcoming.sort(byDue);
  out.none.sort((a, b) => (enquiryDate(b)?.getTime() || 0) - (enquiryDate(a)?.getTime() || 0));
  return out;
}

/** Active leads with no contact for at least `days` days (or never contacted and older than `days`). */
export function leadsNotContactedForDays(leads: Lead[], days: number, now: Date = new Date()): Lead[] {
  return countedLeads(leads)
    .filter(isActive)
    .filter((l) => {
      const last = lastActivityDate(l) || enquiryDate(l);
      const ds = daysSince(last, now);
      return ds !== null && ds >= days;
    })
    .sort((a, b) => (lastActivityDate(a)?.getTime() || 0) - (lastActivityDate(b)?.getTime() || 0));
}

export function leadsByStage(leads: Lead[], stage: string): Lead[] {
  const s = stage.trim().toLowerCase();
  return countedLeads(leads).filter((l) => stageOf(l).toLowerCase() === s);
}

export function leadsBySource(leads: Lead[], source: string): Lead[] {
  const s = source.trim().toLowerCase();
  return countedLeads(leads).filter((l) => String(l[F.SOURCE] || '').toLowerCase().includes(s));
}

export function leadsByRM(leads: Lead[], rm: string): Lead[] {
  const s = rm.trim().toLowerCase();
  return countedLeads(leads).filter((l) => String(l[F.RM] || '').toLowerCase().includes(s));
}

/** Free-text search over the main identifying fields. */
export function searchLeads(leads: Lead[], query: string, limit = 50): Lead[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, '');
  const scored: Array<{ l: Lead; score: number }> = [];
  for (const l of countedLeads(leads)) {
    const name = String(l[F.NAME] || '').toLowerCase();
    const id = String(l[F.ID] || '').toLowerCase();
    const email = String(l[F.EMAIL] || '').toLowerCase();
    const phone = String(l[F.PHONE] || '').replace(/\D/g, '');
    const notes = String(l[F.NOTES] || '').toLowerCase();
    let score = 0;
    if (id === q) score = 100;
    else if (name === q) score = 95;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (digits.length >= 4 && phone.includes(digits)) score = 70;
    else if (email.includes(q)) score = 50;
    else if (id.includes(q)) score = 45;
    else if (notes.includes(q)) score = 20;
    if (score) scored.push({ l, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.l);
}

/** 1–5 engagement score used in lists. One implementation for the whole app. */
export function leadScore(l: Lead): number {
  let s = 1;
  if (l[F.PHONE]) s++;
  if (l[F.EMAIL] || l[F.UNIT_TYPE]) s++;
  if (SITE_VISIT_DONE.includes(l[F.SITE_VISIT_STATUS])) s++;
  if (String(l[F.NOTES] || '').length > 15) s++;
  if (l[F.NEXT_FOLLOWUP]) s++;
  return Math.min(5, s);
}

/** Range covering a whole day (helper for the Copilot). */
export function dayRange(d: Date, label = 'Day'): DateRange {
  return { start: startOfDay(d), end: endOfDay(d), label };
}
