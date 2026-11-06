/** Ads manager: which dates a choice means, what to compare them with, what changed, and the Excel sheet. No screen code, so it can be tested. */
import type { MetaAdsRow } from '../../core/api';

export interface DayRange { since: string; until: string }
export type CompareMode = 'off' | 'previous' | 'sameDays' | 'lastMonth' | 'custom';

const toDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toKey = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (key: string, n: number) => {
  const d = toDay(key);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
};
const lastDayOf = (y: number, monthIndex: number) => new Date(Date.UTC(y, monthIndex + 1, 0)).getUTCDate();
const isKey = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export const daysIn = (r: DayRange) => Math.round((toDay(r.until).getTime() - toDay(r.since).getTime()) / 86400000) + 1;

/** The dates a choice in the date list means, counted the way Meta does: "last 7 days" ends yesterday. Null when it has no fixed dates. */
export function rangeOfPreset(preset: string, today: string): DayRange | null {
  const t = toDay(today);
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  if (preset === 'today') return { since: today, until: today };
  if (preset === 'yesterday') { const d = plusDays(today, -1); return { since: d, until: d }; }
  const last = /^last_(\d+)d$/.exec(preset);
  if (last) return { since: plusDays(today, -Number(last[1])), until: plusDays(today, -1) };
  if (preset === 'this_month') return { since: toKey(new Date(Date.UTC(y, m, 1))), until: today };
  if (preset === 'last_month') return { since: toKey(new Date(Date.UTC(y, m - 1, 1))), until: toKey(new Date(Date.UTC(y, m, 0))) };
  return null;
}

/** One month back, the same dates. 31 March goes to the last day of February. */
function monthBack(key: string): string {
  const d = toDay(key);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return toKey(new Date(Date.UTC(y, m - 1, Math.min(d.getUTCDate(), lastDayOf(y, m - 1)))));
}

export function compareRange(mode: Exclude<CompareMode, 'off' | 'custom'>, main: DayRange, today: string): DayRange {
  if (mode === 'previous') {
    const n = daysIn(main);
    return { since: plusDays(main.since, -n), until: plusDays(main.since, -1) };
  }
  if (mode === 'lastMonth') return rangeOfPreset('last_month', today)!;
  // a whole month against the whole month before it, whatever their lengths
  const u = toDay(main.until);
  const wholeMonth = main.since.endsWith('-01') && u.getUTCDate() === lastDayOf(u.getUTCFullYear(), u.getUTCMonth());
  if (wholeMonth && main.since.slice(0, 7) === main.until.slice(0, 7)) {
    const since = monthBack(main.since);
    const s = toDay(since);
    return { since, until: toKey(new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0))) };
  }
  // anything else keeps its number of days, so totals stay comparable when a month is shorter
  const since = monthBack(main.since);
  return { since, until: plusDays(since, daysIn(main) - 1) };
}

export const validRange = (r: Partial<DayRange>): r is DayRange => !!r.since && !!r.until && isKey(r.since) && isKey(r.until) && r.since <= r.until;

/** What to say about comparing these two, when something makes the totals misleading. */
export function compareNote(main: DayRange, other: DayRange, today: string): string {
  const notes: string[] = [];
  const a = daysIn(main), b = daysIn(other);
  if (a !== b) notes.push(`These periods are different lengths (${a} and ${b} days), so totals like spend and leads will not match up. Compare costs and rates instead, or use the same number of days.`);
  if (main.until >= today) notes.push('Today is not finished, and Meta is still adding to it.');
  if (main.since <= other.until && other.since <= main.until) notes.push('These periods overlap.');
  return notes.join(' ');
}

/* --------------------------------- change --------------------------------- */

export type Better = 'up' | 'down' | 'none';
export interface Change { text: string; tone: 'good' | 'bad' | 'flat'; arrow: 'up' | 'down' | '' }

/** How a figure moved, and whether that is good news. Nothing at all in the earlier period is "New", not an endless rise. */
export function changeOf(now: number | null, before: number | null, better: Better): Change | null {
  if (now === null && before === null) return null;
  const a = now ?? 0, b = before ?? 0;
  if (a === b) return { text: 'No change', tone: 'flat', arrow: '' };
  const up = a > b;
  // a cost that appears or vanishes only means the ad started or stopped: neither good nor bad
  const costCameOrWent = better === 'down' && (a === 0 || b === 0);
  const tone: Change['tone'] = better === 'none' || costCameOrWent ? 'flat' : up === (better === 'up') ? 'good' : 'bad';
  if (b === 0) return { text: 'New', tone, arrow: 'up' };
  const p = Math.abs((a - b) / b) * 100;
  return { text: `${p >= 100 ? Math.round(p).toLocaleString('en-IN') : p.toFixed(1)}%`, tone, arrow: up ? 'up' : 'down' };
}

export function changePercent(now: number | null, before: number | null): number | null {
  if (!before) return null;
  return Math.round((((now ?? 0) - before) / before) * 1000) / 10;
}

/* --------------------------------- figures -------------------------------- */

export type MetricKind = 'count' | 'money' | 'percent' | 'number';
export interface Metric { id: string; label: string; kind: MetricKind; better: Better; get: (r: MetaAdsRow) => number | null }

/** The columns that can be compared. Budgets, dates and rankings describe the ad today, not a period. */
export const METRICS: Metric[] = [
  { id: 'results', label: 'Results', kind: 'count', better: 'up', get: (r) => r.results },
  { id: 'reach', label: 'Reach', kind: 'count', better: 'up', get: (r) => r.reach },
  { id: 'impressions', label: 'Impressions', kind: 'count', better: 'up', get: (r) => r.impressions },
  { id: 'frequency', label: 'Frequency', kind: 'number', better: 'none', get: (r) => r.frequency },
  { id: 'cpr', label: 'Cost per result', kind: 'money', better: 'down', get: (r) => r.costPerResult },
  { id: 'spend', label: 'Amount spent', kind: 'money', better: 'none', get: (r) => r.spend },
  { id: 'linkClicks', label: 'Link clicks', kind: 'count', better: 'up', get: (r) => r.linkClicks },
  { id: 'linkCtr', label: 'CTR (link)', kind: 'percent', better: 'up', get: (r) => r.linkCtr },
  { id: 'linkCpc', label: 'CPC (link)', kind: 'money', better: 'down', get: (r) => r.linkCpc },
  { id: 'cpm', label: 'CPM', kind: 'money', better: 'down', get: (r) => r.cpm },
  { id: 'clicks', label: 'Clicks (all)', kind: 'count', better: 'up', get: (r) => r.clicks },
  { id: 'ctr', label: 'CTR (all)', kind: 'percent', better: 'up', get: (r) => r.ctr },
  { id: 'cpc', label: 'CPC (all)', kind: 'money', better: 'down', get: (r) => r.cpc },
  { id: 'leads', label: 'Leads', kind: 'count', better: 'up', get: (r) => r.leads },
  { id: 'landing', label: 'Landing page views', kind: 'count', better: 'up', get: (r) => r.landingPageViews },
];
export const metricOf = (id: string) => METRICS.find((m) => m.id === id);

/**
 * The bottom line. Costs and rates are worked out from the totals, never added up. Reach and frequency are left out because one
 * person can be in several rows, and results only count when every row has the same kind of result.
 */
export function totalsOf(rows: MetaAdsRow[]): Record<string, number | null> {
  const sum = (f: (r: MetaAdsRow) => number | null) => rows.reduce((t, r) => t + (f(r) || 0), 0);
  const spend = sum((r) => r.spend), impressions = sum((r) => r.impressions), linkClicks = sum((r) => r.linkClicks), clicks = sum((r) => r.clicks), leads = sum((r) => r.leads);
  const singleResult = new Set(rows.filter((r) => r.results !== null).map((r) => r.resultLabel)).size === 1;
  const results = singleResult ? sum((r) => r.results) : null;
  const ratio = (a: number, b: number, by = 1) => (b ? (a / b) * by : null);
  return {
    results, cpr: results ? spend / results : null, spend, impressions, linkClicks, clicks, leads, costPerLead: ratio(spend, leads),
    landing: sum((r) => r.landingPageViews), linkCtr: ratio(linkClicks, impressions, 100), ctr: ratio(clicks, impressions, 100),
    linkCpc: ratio(spend, linkClicks), cpc: ratio(spend, clicks), cpm: ratio(spend, impressions, 1000),
  };
}

/* ------------------------------ side by side ------------------------------ */

const costPerLead: Metric = { id: 'costPerLead', label: 'Cost per lead', kind: 'money', better: 'down', get: (r) => (r.leads && r.spend !== null ? r.spend / r.leads : null) };
/** The figures in the side-by-side view, in reading order. */
export const SIDE_BY_SIDE: Metric[] = ['spend', 'results', 'cpr', 'leads', 'costPerLead', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpc', 'cpm', 'linkClicks', 'linkCtr', 'linkCpc', 'landing']
  .map((id) => (id === 'costPerLead' ? costPerLead : metricOf(id)!));
export const MAX_SIDE_BY_SIDE = 4;

/** Which columns hold the best figure. None when it says nothing: too few to compare, all equal, or no better direction. A cost of zero is no cost, not the best one. */
export function bestIndexes(values: Array<number | null>, better: Better): number[] {
  if (better === 'none') return [];
  const real = values.filter((v): v is number => v !== null && v > 0);
  if (real.length < 2) return [];
  const best = better === 'up' ? Math.max(...real) : Math.min(...real);
  if (real.every((v) => v === best)) return [];
  return values.flatMap((v, i) => (v === best ? [i] : []));
}

/** Can these be ranked at all? Not money in different currencies, and not results of different kinds (leads against reach). */
export function metricsComparable(id: string, rows: Array<Pick<MetaAdsRow, 'currency' | 'resultLabel' | 'results'>>): boolean {
  const metric = id === 'costPerLead' ? costPerLead : metricOf(id);
  if (!metric) return false;
  if (metric.kind === 'money' && new Set(rows.map((r) => r.currency)).size > 1) return false;
  if ((id === 'results' || id === 'cpr') && new Set(rows.filter((r) => r.results !== null).map((r) => r.resultLabel)).size > 1) return false;
  return true;
}

/* ---------------------------------- Excel --------------------------------- */

export interface SheetColumn { label: string; metric?: string; value: (r: MetaAdsRow) => unknown }
export interface AdsSheet { headers: string[]; rows: unknown[][] }

/** One row per campaign, ad set or ad as shown, with real numbers Excel can add up. Comparing adds the earlier figure and the change. */
export function buildAdsSheet(o: { nameLabel: string; level: string; rows: MetaAdsRow[]; columns: SheetColumn[]; before?: Map<string, MetaAdsRow> | null; mainLabel?: string; otherLabel?: string; accountName: (r: MetaAdsRow) => string }): AdsSheet {
  const parents: SheetColumn[] = [
    ...(o.level === 'ad' ? [{ label: 'Ad set', value: (r: MetaAdsRow) => r.adsetName }] : []),
    ...(o.level !== 'campaign' ? [{ label: 'Campaign', value: (r: MetaAdsRow) => r.campaignName }] : []),
  ];
  const compared = (c: SheetColumn) => !!(o.before && c.metric);
  const headers = [o.nameLabel, ...parents.map((c) => c.label), 'Ad account'];
  for (const c of o.columns) {
    if (compared(c)) headers.push(`${c.label} (${o.mainLabel})`, `${c.label} (${o.otherLabel})`, `${c.label} change %`);
    else headers.push(c.label);
  }
  const rows = o.rows.map((r) => {
    const row: unknown[] = [r.name, ...parents.map((c) => c.value(r)), o.accountName(r)];
    const was = o.before?.get(r.id);
    for (const c of o.columns) {
      const now = c.value(r);
      row.push(now ?? '');
      if (!compared(c)) continue;
      const earlier = was ? metricOf(c.metric!)!.get(was) : null;
      row.push(earlier ?? '', changePercent(now as number | null, earlier) ?? '');
    }
    return row;
  });
  const now = totalsOf(o.rows);
  const then = o.before ? totalsOf(o.rows.map((r) => o.before!.get(r.id)).filter((x): x is MetaAdsRow => !!x)) : null;
  const total: unknown[] = ['Total', ...parents.map(() => ''), ''];
  for (const c of o.columns) {
    const id = c.metric || '';
    total.push(now[id] ?? '');
    if (compared(c)) total.push(then?.[id] ?? '', changePercent(now[id] ?? null, then?.[id] ?? null) ?? '');
  }
  if (o.rows.length) rows.push(total);
  return { headers, rows };
}

const safe = (s: string) => s.replace(/[^\w-]+/g, '_');
export const adsFileName = (level: string, main: DayRange | null, preset: string, other?: DayRange | null) =>
  `Ads_${safe(level)}_${main ? `${main.since}_to_${main.until}` : safe(preset)}${other ? `_vs_${other.since}_to_${other.until}` : ''}.xlsx`;
