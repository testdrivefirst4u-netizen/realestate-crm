/**
 * Sales MIS — pure data helpers for MisView.
 *
 * Every CRM lead is mapped onto one MIS stage (Open, Sales Qualified, Disqualified,
 * Prospect for SV, HOT, Warm, Not Interested Post SV, Booked). Periods are compared as
 * 'yyyy-MM-dd' keys in the CRM time zone, so "today" and "this week" match the rest of the CRM.
 */
import { CallRecord, Lead } from '../../types/crm';
import { F, SITE_VISIT, SITE_VISIT_DONE, STAGES } from '../../core/config';
import { classifyStage, countedLeads, enquiryDate, firstResponseDate, stageOf } from '../../core/analytics';
import { dateKey, parseDate } from '../../core/dates';

/* ------------------------------- stages ---------------------------------- */

export type MisStageId = 'open' | 'qualified' | 'disqualified' | 'prospect' | 'hot' | 'warm' | 'ni' | 'booked';

export interface MisStage {
  id: MisStageId;
  name: string;
  short: string;
  color: string;
  note: string;
}

export const MIS_STAGES: MisStage[] = [
  { id: 'open', name: 'Open / Incoming', short: 'Open', color: '#74889A', note: 'New or open — not yet qualified' },
  { id: 'qualified', name: 'Sales Qualified', short: 'Qualified', color: '#0E8A7D', note: 'Meets the qualification criteria' },
  { id: 'disqualified', name: 'Disqualified', short: 'Disqualified', color: '#A7B1B4', note: 'Reason counts are shown below' },
  { id: 'prospect', name: 'Prospect for SV', short: 'Prospect SV', color: '#3B5BDB', note: '' },
  { id: 'hot', name: 'HOT', short: 'HOT', color: '#D92D3A', note: "Expected closure in a week's time" },
  { id: 'warm', name: 'Warm', short: 'Warm', color: '#E39A12', note: 'Expected closure in 15 to 20 days' },
  { id: 'ni', name: 'Not Interested Post Site Visit', short: 'Not int. post SV', color: '#7B4B8A', note: 'Dropped after the site visit' },
  { id: 'booked', name: 'Booked', short: 'Booked', color: '#1F7A4D', note: 'Unit booked' },
];
export const MIS_STAGE = Object.fromEntries(MIS_STAGES.map((s) => [s.id, s])) as Record<MisStageId, MisStage>;

/** Site-visit statuses shown under "Prospect for SV", in order. */
export const SV_STATUSES: string[] = [SITE_VISIT.PROSPECT, SITE_VISIT.SCHEDULED, SITE_VISIT.WALK_IN, SITE_VISIT.COMPLETED];

/** CRM lost stages → disqualification reason (custom lost stages use their own name). */
const DQ_REASON: Record<string, string> = {
  [STAGES.NOT_RESPONDING]: 'Call not answered',
  [STAGES.DND]: 'Do not disturb',
  [STAGES.LOST]: 'Lost',
  [STAGES.JUNK]: 'Junk / not interested',
  [STAGES.DQ_BUDGET]: 'Budget',
  [STAGES.DQ_LOCATION]: 'Location',
  [STAGES.DQ_RENTAL]: 'Rental',
  [STAGES.DQ_NI]: 'Not interested',
  [STAGES.DQ_TIMELINE]: 'Timeline',
  [STAGES.DQ_PROJECT]: 'Project type',
};
export const DQ_REASONS_BASE: string[] = Object.values(DQ_REASON);
export const NO_REASON = 'Reason not recorded';
export const BLANK = 'Not captured';
export const UNASSIGNED = 'Unassigned';

/* -------------------------------- leads ---------------------------------- */

export interface MisLead {
  lead: Lead;
  id: string;
  /** Enquiry day 'yyyy-MM-dd' (CRM time zone); '' when unknown. */
  day: string;
  /** Monday of the enquiry week. */
  week: string;
  source: string;
  rm: string;
  stage: MisStageId;
  /** Disqualification reason (disqualified only). */
  reason: string;
  /** Site Visit Status (raw). */
  sv: string;
  svPlanned: boolean;
  /** Minutes from enquiry to the first follow-up or call; null when either is unknown. */
  respMins: number | null;
  responded: boolean;
  country: string;
  state: string;
  city: string;
  /** The Meta ad behind the lead (extra columns filled by Meta Lead Ads intake; '' otherwise). */
  campaign: string;
  adSet: string;
  ad: string;
}

const pick = (l: Lead, ...keys: string[]) => {
  for (const k of keys) {
    const v = String(l[k] ?? '').trim();
    if (v) return v;
  }
  return '';
};

export function canonCountry(c: string): string {
  const k = c.toLowerCase().replace(/[^a-z]/g, '');
  if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica', 'america'].includes(k)) return 'USA';
  if (['uk', 'unitedkingdom', 'greatbritain', 'britain', 'england', 'gb'].includes(k)) return 'UK';
  if (['uae', 'ae', 'unitedarabemirates', 'emirates'].includes(k)) return 'UAE';
  if (['india', 'in', 'bharat'].includes(k)) return 'India';
  return c.trim();
}

function misStage(lead: Lead): { stage: MisStageId; reason: string } {
  const st = stageOf(lead);
  const cls = classifyStage(st);
  const sv = String(lead[F.SITE_VISIT_STATUS] || '').trim();
  if (cls === 'won') return { stage: 'booked', reason: '' };
  if (cls === 'lost') {
    if (SITE_VISIT_DONE.includes(sv)) return { stage: 'ni', reason: '' };
    return { stage: 'disqualified', reason: DQ_REASON[st] || st || NO_REASON };
  }
  if (st === STAGES.HOT) return { stage: 'hot', reason: '' };
  if (st === STAGES.WARM) return { stage: 'warm', reason: '' };
  if (sv) return { stage: 'prospect', reason: '' };
  if (st === STAGES.QUALIFIED) return { stage: 'qualified', reason: '' };
  return { stage: 'open', reason: '' };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Calendar arithmetic on 'yyyy-MM-dd' keys (no time zone involved). */
export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
export function weekStartKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysKey(key, -((wd + 6) % 7));
}
const monthStartKey = (key: string) => key.slice(0, 8) + '01';
const daysInMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Earliest call per lead id (any direction) — counts as a response too. */
export function firstCallByLead(calls: CallRecord[]): Map<string, Date> {
  const m = new Map<string, Date>();
  for (const c of calls) {
    if (!c.leadId) continue;
    const d = parseDate(c.startTime) || parseDate(c.callDate);
    if (!d) continue;
    const prev = m.get(c.leadId);
    if (!prev || d < prev) m.set(c.leadId, d);
  }
  return m;
}

export function toMisLeads(leads: Lead[], firstCall: Map<string, Date>): MisLead[] {
  return countedLeads(leads).map((lead) => {
    const id = String(lead[F.ID] || '');
    const enq = enquiryDate(lead);
    const day = enq ? dateKey(enq) : '';
    const fu = firstResponseDate(lead);
    const call = firstCall.get(id);
    const candidates = [fu, call].filter((d): d is Date => !!d && (!enq || d.getTime() >= enq.getTime()));
    const first = candidates.length ? candidates.reduce((a, b) => (a < b ? a : b)) : null;
    const { stage, reason } = misStage(lead);
    const sv = String(lead[F.SITE_VISIT_STATUS] || '').trim();
    return {
      lead,
      id,
      day,
      week: day ? weekStartKey(day) : '',
      source: String(lead[F.SOURCE] || '').trim(),
      rm: String(lead[F.RM] || '').trim(),
      stage,
      reason,
      sv,
      svPlanned: sv === SITE_VISIT.SCHEDULED && stage !== 'disqualified' && stage !== 'ni' && stage !== 'booked',
      respMins: enq && first ? (first.getTime() - enq.getTime()) / 60000 : null,
      responded: !!(fu || call),
      country: canonCountry(pick(lead, F.COUNTRY, 'country')),
      state: pick(lead, F.STATE, 'state'),
      city: pick(lead, F.CITY, 'city'),
      campaign: pick(lead, F.CAMPAIGN),
      adSet: pick(lead, F.AD_SET),
      ad: pick(lead, F.AD_NAME),
    };
  });
}

/* ------------------------------- periods --------------------------------- */

export type PeriodId = 'today' | 'yesterday' | 'week' | 'lastweek' | 'month' | 'lastmonth' | 'all' | 'custom' | 'monthtoyesterday' | 'lastmonthsame';
export type Range = [string, string];

export const PERIOD_NAME: Record<string, string> = {
  today: 'Today', yesterday: 'Yesterday', week: 'This week', lastweek: 'Last week', month: 'This month', lastmonth: 'Last month', all: 'Overall', custom: 'Custom range',
};

export function periodRange(p: PeriodId, custom: Range = ['', ''], today = dateKey(new Date())): Range {
  const ms = monthStartKey(today);
  const lms = monthStartKey(addDaysKey(ms, -1));
  switch (p) {
    case 'today': return [today, today];
    case 'yesterday': { const y = addDaysKey(today, -1); return [y, y]; }
    case 'week': return [weekStartKey(today), today];
    case 'lastweek': { const s = addDaysKey(weekStartKey(today), -7); return [s, addDaysKey(s, 6)]; }
    case 'month': return [ms, today];
    case 'lastmonth': return [lms, addDaysKey(ms, -1)];
    case 'monthtoyesterday': { const y = addDaysKey(today, -1); return y < ms ? ['9999-12-31', '9999-12-31'] : [ms, y]; }
    case 'lastmonthsame': {
      const upto = Math.min(Math.max(Number(today.slice(8)) - 1, 1), daysInMonth(lms));
      return [lms, addDaysKey(lms, upto - 1)];
    }
    case 'custom': return custom;
    default: return ['', ''];
  }
}

/**
 * The like-for-like earlier period for a trend: today vs yesterday, this week so far vs the same
 * weekdays last week, this month so far vs the same dates last month. null = nothing to compare.
 */
export function previousRange(p: PeriodId, today = dateKey(new Date())): { range: Range; label: string } | null {
  if (p === 'today') { const y = addDaysKey(today, -1); return { range: [y, y], label: 'vs yesterday' }; }
  if (p === 'week') {
    const ws = weekStartKey(today), s = addDaysKey(ws, -7);
    return { range: [s, addDaysKey(today, -7)], label: 'vs same days last week' };
  }
  if (p === 'month') {
    const lms = monthStartKey(addDaysKey(monthStartKey(today), -1));
    const upto = Math.min(Number(today.slice(8)), daysInMonth(lms));
    return { range: [lms, addDaysKey(lms, upto - 1)], label: 'vs same dates last month' };
  }
  return null;
}

/** % change; null when there is no earlier figure to compare with. */
export const changePct = (now: number, before: number): number | null => (before ? Math.round(((now - before) * 100) / before) : null);

/* -------------------------------- funnel --------------------------------- */

export const FUNNEL_STEPS = ['Leads', 'Contacted', 'Qualified', 'Site visit planned', 'Site visit done', 'Booked'] as const;
const SV_PLANNED_OR_DONE = new Set<string>([SITE_VISIT.SCHEDULED, SITE_VISIT.WALK_IN, SITE_VISIT.COMPLETED]);

/**
 * Furthest funnel step a lead reached (index into FUNNEL_STEPS). A later step implies the earlier
 * ones — a booked lead counts as contacted even when no follow-up was logged — so the funnel never widens.
 */
export function funnelStep(l: MisLead): number {
  if (l.stage === 'booked') return 5;
  if (SITE_VISIT_DONE.includes(l.sv) || l.stage === 'ni') return 4;
  if (SV_PLANNED_OR_DONE.has(l.sv)) return 3;
  if (l.stage !== 'open' && l.stage !== 'disqualified') return 2;
  if (l.responded) return 1;
  return 0;
}

export const funnelCounts = (list: MisLead[]) => {
  const out = FUNNEL_STEPS.map(() => 0);
  for (const l of list) for (let i = funnelStep(l); i >= 0; i--) out[i]++;
  return out;
};

export const inRange = (day: string, [a, b]: Range) => (!a || (!!day && day >= a)) && (!b || (!!day && day <= b));

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const fmtKey = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(k) ? `${Number(k.slice(8))} ${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : k);
export const fmtKeyShort = (k: string) => `${Number(k.slice(8))} ${MON[Number(k.slice(5, 7)) - 1]}`;
export const monthNameOf = (k: string) => MONTHS[Number(k.slice(5, 7)) - 1];

export function rangeLabel(p: PeriodId, r: Range): string {
  if (p === 'all') return 'All dates';
  if (p === 'month') return `${monthNameOf(r[0])} ${r[0].slice(0, 4)}`;
  const [a, b] = r;
  if (a && b) return a === b ? fmtKey(a) : `${fmtKey(a)} to ${fmtKey(b)}`;
  if (a) return `From ${fmtKey(a)}`;
  if (b) return `Up to ${fmtKey(b)}`;
  return 'Pick a from and to date';
}

/* ------------------------------- counting -------------------------------- */

export type StageCounts = Record<MisStageId, number>;
export function stageCounts(list: MisLead[]): StageCounts {
  const c = Object.fromEntries(MIS_STAGES.map((s) => [s.id, 0])) as StageCounts;
  for (const l of list) c[l.stage]++;
  return c;
}

/** Disqualification reasons present, base reasons first. */
export function dqReasons(list: MisLead[]): string[] {
  const present = new Set(list.filter((l) => l.stage === 'disqualified').map((l) => l.reason));
  return DQ_REASONS_BASE.concat([...present].filter((r) => !DQ_REASONS_BASE.includes(r)).sort());
}

export const pct = (n: number, t: number) => (t ? `${Math.round((n * 100) / t)}%` : '0%');
export const uniq = (vals: string[]) => [...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Configured source order first, then any other source found on leads. */
export function sourceOrder(configured: string[], list: MisLead[]): string[] {
  const present = new Set(list.map((l) => l.source).filter(Boolean));
  const base = configured.filter((s) => present.has(s));
  return base.concat([...present].filter((s) => !configured.includes(s)).sort((a, b) => a.localeCompare(b)));
}

const PALETTE = ['#1877F2', '#D62976', '#0B6BB0', '#0F9D58', '#25D366', '#E0543B', '#8A5CC7', '#D9961A', '#1A9BB0', '#C24E8B', '#7A8A2E', '#9C6B3C', '#4F7C8A', '#5E5AA8'];
export const sourceColour = (s: string, order: string[]) => (s === BLANK ? '#9AA5A8' : PALETTE[Math.max(0, order.indexOf(s)) % PALETTE.length]);

/* --------------------------- response & calls ---------------------------- */

export function avgResp(list: MisLead[]): { avg: number; n: number; fast: number } | null {
  const v = list.map((l) => l.respMins).filter((x): x is number => x != null);
  return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length, fast: v.filter((x) => x <= 60).length } : null;
}

export function fmtDur(m: number): string {
  m = Math.round(m);
  if (m < 60) return `${m} min`;
  if (m < 1440) { const h = Math.floor(m / 60), mm = m % 60; return `${h} h${mm ? ` ${mm} min` : ''}`; }
  const d = Math.floor(m / 1440), h = Math.round((m % 1440) / 60);
  return `${d} d${h ? ` ${h} h` : ''}`;
}

/** Speed to lead: how many leads got their first call / follow-up within 5 minutes, within an hour, later, or not yet. */
export function speedBuckets(list: MisLead[]): { total: number; m5: number; h1: number; later: number; none: number } {
  const out = { total: list.length, m5: 0, h1: 0, later: 0, none: 0 };
  for (const l of list) {
    if (!l.responded) { if (l.stage !== 'disqualified' && l.stage !== 'booked') out.none++; continue; }
    const m = l.respMins;
    if (m == null) continue;
    if (m <= 5) out.m5++;
    else if (m <= 60) out.h1++;
    else out.later++;
  }
  return out;
}

export const speedTone = (m: number | null | undefined) => (m == null ? '' : m <= 30 ? 'text-[#0E8A7D] font-bold' : m > 240 ? 'text-[#D92D3A] font-bold' : '');

export interface CallDay { day: string; rep: string; secs: number; calls: number }

/** Connected calls only (a missed call has no talk time) — one row per call. */
export function callDays(calls: CallRecord[], leadRm: Map<string, string>): CallDay[] {
  const out: CallDay[] = [];
  for (const c of calls) {
    const d = parseDate(c.startTime) || parseDate(c.callDate);
    if (!d) continue;
    const rep = String(c.loggedBy || '').trim() || leadRm.get(c.leadId) || UNASSIGNED;
    out.push({ day: dateKey(d), rep, secs: Math.max(0, Number(c.durationSec) || 0), calls: 1 });
  }
  return out;
}

export const fmtTalk = (secs: number) => {
  const m = Math.round(secs / 60), h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h} h${mm ? ` ${mm} min` : ''}` : `${mm} min`;
};
export const fmtAvgCall = (secs: number) => {
  const s = Math.round(secs);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
};
