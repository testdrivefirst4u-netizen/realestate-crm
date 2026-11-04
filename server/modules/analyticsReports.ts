/**
 * Website analytics › reports (plan feature websiteAnalytics, screen /analytics): the standard reports of Google
 * Analytics, read with the Data API through the Google connection of Settings › Google (scope analytics.readonly).
 *
 * Reports  = snapshot, realtime, user and traffic acquisition, events, pages, landing pages, demographics, tech.
 * Figures  = POST properties/<id>:runReport (totals, each day, and the same days just before, to compare);
 *            :runRealtimeReport for the last 30 minutes. Google's own totals are used, never a sum of rows: a person
 *            counted in two rows is one person in the total.
 * Notes    = what Google says about the answer (thresholds hiding small numbers, sampling, an "(other)" row), so a
 *            difference from the Google screen can be explained. Answers are kept 15 minutes; realtime is not kept.
 */
import type { ActionMap } from '../core/actions';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { gbpFetch } from './googleMarketing';
import { rangeDays } from './websiteAnalytics';

const CACHE_MS = 15 * 60000;
const DAY_MS = 86400000;
const IST_MS = 330 * 60000;
const ROW_LIMIT = 250;
const cache = new Map<string, { at: number; data: AnalyticsReport }>();

export type MetricFormat = 'number' | 'percent' | 'duration' | 'decimal' | 'money';
export interface MetricDef { id: string; label: string; format: MetricFormat }

const M: Record<string, MetricDef> = {
  activeUsers: { id: 'activeUsers', label: 'Active users', format: 'number' },
  totalUsers: { id: 'totalUsers', label: 'Total users', format: 'number' },
  newUsers: { id: 'newUsers', label: 'New users', format: 'number' },
  sessions: { id: 'sessions', label: 'Sessions', format: 'number' },
  engagedSessions: { id: 'engagedSessions', label: 'Engaged sessions', format: 'number' },
  engagementRate: { id: 'engagementRate', label: 'Engagement rate', format: 'percent' },
  bounceRate: { id: 'bounceRate', label: 'Bounce rate', format: 'percent' },
  engagedSessionsPerUser: { id: 'engagedSessionsPerUser', label: 'Engaged sessions per user', format: 'decimal' },
  eventsPerSession: { id: 'eventsPerSession', label: 'Events per session', format: 'decimal' },
  eventCountPerUser: { id: 'eventCountPerUser', label: 'Events per user', format: 'decimal' },
  averageSessionDuration: { id: 'averageSessionDuration', label: 'Average session duration', format: 'duration' },
  userEngagementDuration: { id: 'userEngagementDuration', label: 'Total engagement time', format: 'duration' },
  screenPageViews: { id: 'screenPageViews', label: 'Views', format: 'number' },
  screenPageViewsPerUser: { id: 'screenPageViewsPerUser', label: 'Views per user', format: 'decimal' },
  eventCount: { id: 'eventCount', label: 'Event count', format: 'number' },
  keyEvents: { id: 'keyEvents', label: 'Key events', format: 'number' },
  totalRevenue: { id: 'totalRevenue', label: 'Total revenue', format: 'money' },
};
const pick = (...ids: string[]) => ids.map((id) => M[id]);

interface TableReport { title: string; dimensions: Array<{ id: string; label: string }>; metrics: MetricDef[] }
const AUDIENCE = pick('activeUsers', 'newUsers', 'engagedSessions', 'engagementRate', 'engagedSessionsPerUser', 'userEngagementDuration', 'eventCount', 'keyEvents', 'totalRevenue');
export const TABLE_REPORTS: Record<string, TableReport> = {
  userAcquisition: {
    title: 'User acquisition',
    dimensions: [{ id: 'firstUserDefaultChannelGroup', label: 'First user channel' }, { id: 'firstUserSourceMedium', label: 'First user source / medium' }, { id: 'firstUserSource', label: 'First user source' }, { id: 'firstUserMedium', label: 'First user medium' }, { id: 'firstUserCampaignName', label: 'First user campaign' }],
    metrics: pick('totalUsers', 'newUsers', 'activeUsers', 'engagedSessions', 'engagementRate', 'userEngagementDuration', 'eventCount', 'keyEvents', 'totalRevenue'),
  },
  trafficAcquisition: {
    title: 'Traffic acquisition',
    dimensions: [{ id: 'sessionDefaultChannelGroup', label: 'Session channel' }, { id: 'sessionSourceMedium', label: 'Session source / medium' }, { id: 'sessionSource', label: 'Session source' }, { id: 'sessionMedium', label: 'Session medium' }, { id: 'sessionCampaignName', label: 'Session campaign' }],
    metrics: pick('sessions', 'activeUsers', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'eventsPerSession', 'eventCount', 'keyEvents', 'totalRevenue'),
  },
  events: { title: 'Events', dimensions: [{ id: 'eventName', label: 'Event name' }], metrics: pick('eventCount', 'totalUsers', 'eventCountPerUser', 'totalRevenue') },
  pages: {
    title: 'Pages and screens',
    dimensions: [{ id: 'pagePath', label: 'Page path' }, { id: 'pageTitle', label: 'Page title' }, { id: 'pageLocation', label: 'Full page address' }],
    metrics: pick('screenPageViews', 'activeUsers', 'screenPageViewsPerUser', 'userEngagementDuration', 'eventCount', 'keyEvents', 'totalRevenue'),
  },
  landingPages: { title: 'Landing page', dimensions: [{ id: 'landingPage', label: 'Landing page' }], metrics: pick('sessions', 'activeUsers', 'newUsers', 'engagementRate', 'bounceRate', 'averageSessionDuration', 'keyEvents', 'totalRevenue') },
  demographics: {
    title: 'Demographic details',
    dimensions: [{ id: 'country', label: 'Country' }, { id: 'region', label: 'Region' }, { id: 'city', label: 'City' }, { id: 'language', label: 'Language' }, { id: 'userAgeBracket', label: 'Age' }, { id: 'userGender', label: 'Gender' }, { id: 'brandingInterest', label: 'Interests' }],
    metrics: AUDIENCE,
  },
  tech: {
    title: 'Tech details',
    dimensions: [{ id: 'deviceCategory', label: 'Device category' }, { id: 'browser', label: 'Browser' }, { id: 'operatingSystem', label: 'Operating system' }, { id: 'platform', label: 'Platform' }, { id: 'screenResolution', label: 'Screen resolution' }, { id: 'mobileDeviceModel', label: 'Device model' }],
    metrics: AUDIENCE,
  },
};

export interface AnalyticsRow { name: string; values: Record<string, number> }
export interface AnalyticsCard { title: string; dimension: string; metric: MetricDef; rows: AnalyticsRow[]; error: string }
export interface AnalyticsDay { day: string; prevDay: string; values: Record<string, number>; prev: Record<string, number> | null }
export interface AnalyticsReport {
  report: string; title: string; property: { id: string; name: string } | null; error: string;
  from: string; to: string; prevFrom: string; prevTo: string;
  dimension: string; dimensions: Array<{ id: string; label: string }>; metrics: MetricDef[];
  totals: Record<string, number>; prevTotals: Record<string, number> | null;
  daily: AnalyticsDay[]; rows: AnalyticsRow[]; rowCount: number; cards: AnalyticsCard[];
  realtime: { activeUsers: number; perMinute: Array<{ minutesAgo: number; users: number }> } | null;
  currency: string; timeZone: string; notes: string[]; fetchedAt: string;
}

const dimOf = (r: any, i = 0) => String(r?.dimensionValues?.[i]?.value ?? '');
const valuesOf = (r: any, metrics: Array<{ id: string }>) => Object.fromEntries(metrics.map((m, i) => [m.id, Number(r?.metricValues?.[i]?.value ?? 0) || 0]));
const gaDay = (v: string) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : v);
const metricsBody = (metrics: Array<{ id: string }>) => metrics.map((m) => ({ name: m.id }));

async function run(property: string, body: Record<string, unknown>, realtime = false): Promise<any> {
  return gbpFetch<any>(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:${realtime ? 'runRealtimeReport' : 'runReport'}`, { body });
}

/** What Google says about how far this answer can be trusted to the last digit. */
function notesOf(answers: any[]): string[] {
  const out = new Set<string>();
  for (const a of answers) {
    const m = a?.metadata || {};
    if (m.subjectToThresholding) out.add('Google hides small numbers here to protect people\'s privacy, so some rows may be missing or lower.');
    if (m.dataLossFromOtherRow) out.add('Google grouped some rare values into an "(other)" row.');
    if (Array.isArray(m.samplingMetadatas) && m.samplingMetadatas.length) out.add('Google calculated this from a sample of the data, so figures are estimates.');
  }
  return [...out];
}

/** The range and the same number of days just before it. */
export function dateRange(d: any, now = new Date()): { from: string; to: string; prevFrom: string; prevTo: string; key: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
  let from: string;
  let to: string;
  const today = new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
  if (d?.from || d?.to) {
    from = String(d?.from || '');
    to = String(d?.to || '');
    if (!re.test(from) || !re.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to || to > today) throw fail('VALIDATION', 'Choose a start date on or before the end date, not in the future.');
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 5 * 366) throw fail('VALIDATION', 'Choose a range of up to five years.');
  } else {
    const preset = String(d?.preset || 'last28');
    if (preset === 'today') from = to = today;
    else if (preset === 'yesterday') from = to = shift(today, -1);
    else {
      const days = ({ last7: 7, last28: 28, last30: 30, last90: 90, last365: 365 } as Record<string, number>)[preset];
      if (!days) throw fail('VALIDATION', 'Choose a date range.');
      // like Google: the last whole days, without today
      const list = rangeDays(days, new Date(now.getTime() - DAY_MS));
      from = list[0];
      to = list[list.length - 1];
    }
  }
  const length = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  const prevTo = shift(from, -1);
  return { from, to, prevTo, prevFrom: shift(prevTo, -(length - 1)), key: `${from}:${to}` };
}

/** Every day of the range with the matching day before it; a day with no visits is a zero. */
function buildDaily(rows: any[], prevRows: any[] | null, metrics: MetricDef[], r: { from: string; prevFrom: string; to: string }): AnalyticsDay[] {
  const map = (list: any[]) => new Map(list.map((x) => [gaDay(dimOf(x)), valuesOf(x, metrics)]));
  const now = map(rows);
  const before = prevRows ? map(prevRows) : null;
  const zero = Object.fromEntries(metrics.map((m) => [m.id, 0]));
  const out: AnalyticsDay[] = [];
  const length = Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY_MS) + 1;
  for (let i = 0; i < length; i++) {
    const day = new Date(Date.parse(`${r.from}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);
    const prevDay = new Date(Date.parse(`${r.prevFrom}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);
    out.push({ day, prevDay, values: now.get(day) || zero, prev: before ? before.get(prevDay) || zero : null });
  }
  return out;
}

/** Totals, each day, and the same for the days before. The comparison is an extra: without it the report still shows. */
async function periodFigures(property: string, metrics: MetricDef[], r: ReturnType<typeof dateRange>, compare: boolean) {
  const range = (from: string, to: string) => [{ startDate: from, endDate: to }];
  const body = (from: string, to: string, daily: boolean) => ({ dateRanges: range(from, to), metrics: metricsBody(metrics), ...(daily ? { dimensions: [{ name: 'date' }], limit: 2000 } : {}) });
  const [total, days, prevTotal, prevDays] = await Promise.all([
    run(property, body(r.from, r.to, false)),
    run(property, body(r.from, r.to, true)),
    compare ? run(property, body(r.prevFrom, r.prevTo, false)).catch(() => null) : null,
    compare ? run(property, body(r.prevFrom, r.prevTo, true)).catch(() => null) : null,
  ]);
  return {
    answers: [total, days],
    totals: valuesOf(total?.rows?.[0], metrics),
    prevTotals: prevTotal ? valuesOf(prevTotal?.rows?.[0], metrics) : null,
    daily: buildDaily(days?.rows || [], prevDays ? prevDays.rows || [] : null, metrics, r),
    currency: String(total?.metadata?.currencyCode || ''),
    timeZone: String(total?.metadata?.timeZone || ''),
  };
}

async function card(property: string, title: string, dimension: { id: string; label: string }, metric: MetricDef, r: { from: string; to: string }): Promise<AnalyticsCard> {
  try {
    const a = await run(property, { dateRanges: [{ startDate: r.from, endDate: r.to }], dimensions: [{ name: dimension.id }], metrics: metricsBody([metric]), orderBys: [{ metric: { metricName: metric.id }, desc: true }], limit: 7 });
    return { title, dimension: dimension.label, metric, rows: (a?.rows || []).map((x: any) => ({ name: truncate(dimOf(x) || '(not set)', 200), values: valuesOf(x, [metric]) })), error: '' };
  } catch (e: any) {
    return { title, dimension: dimension.label, metric, rows: [], error: truncate(e?.message || String(e), 200) };
  }
}

async function realtimeCard(property: string, title: string, dimension: { id: string; label: string }, metric: MetricDef): Promise<AnalyticsCard> {
  try {
    const a = await run(property, { dimensions: [{ name: dimension.id }], metrics: metricsBody([metric]), orderBys: [{ metric: { metricName: metric.id }, desc: true }], limit: 10 }, true);
    return { title, dimension: dimension.label, metric, rows: (a?.rows || []).map((x: any) => ({ name: truncate(dimOf(x) || '(not set)', 200), values: valuesOf(x, [metric]) })), error: '' };
  } catch (e: any) {
    return { title, dimension: dimension.label, metric, rows: [], error: truncate(e?.message || String(e), 200) };
  }
}

async function realtimeFigures(property: string): Promise<NonNullable<AnalyticsReport['realtime']>> {
  const [total, minutes] = await Promise.all([
    run(property, { metrics: [{ name: 'activeUsers' }] }, true),
    run(property, { dimensions: [{ name: 'minutesAgo' }], metrics: [{ name: 'activeUsers' }], limit: 30 }, true),
  ]);
  const byMinute = new Map<number, number>((minutes?.rows || []).map((x: any) => [Number(dimOf(x)), Number(x?.metricValues?.[0]?.value || 0)]));
  return {
    activeUsers: Number(total?.rows?.[0]?.metricValues?.[0]?.value || 0),
    perMinute: Array.from({ length: 30 }, (_, i) => ({ minutesAgo: 29 - i, users: byMinute.get(29 - i) || 0 })),
  };
}

const SNAPSHOT_METRICS = pick('activeUsers', 'newUsers', 'sessions', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'screenPageViews', 'eventCount', 'keyEvents', 'totalRevenue');

export async function getAnalyticsReport(d: any = {}, now = new Date()): Promise<AnalyticsReport> {
  const report = String(d?.report || 'snapshot');
  const table = TABLE_REPORTS[report];
  if (!table && report !== 'snapshot' && report !== 'realtime') throw fail('VALIDATION', 'Choose a report.');
  const r = dateRange(d, now);
  const compare = d?.compare !== false;
  const dimension = table ? String(d?.dimension || table.dimensions[0].id) : '';
  if (table && !table.dimensions.some((x) => x.id === dimension)) throw fail('VALIDATION', 'Choose one of this report\'s dimensions.');

  const g = await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'google' });
  const property = g?.ga4PropertyId ? { id: String(g.ga4PropertyId), name: String((g.ga4Properties || []).find((p: any) => p.id === g.ga4PropertyId)?.name || g.ga4PropertyId) } : null;
  const base: AnalyticsReport = {
    report, title: table?.title || (report === 'realtime' ? 'Realtime' : 'Reports snapshot'), property, error: '',
    from: r.from, to: r.to, prevFrom: r.prevFrom, prevTo: r.prevTo, dimension, dimensions: table?.dimensions || [], metrics: table?.metrics || (report === 'snapshot' ? SNAPSHOT_METRICS : []),
    totals: {}, prevTotals: null, daily: [], rows: [], rowCount: 0, cards: [], realtime: null, currency: '', timeZone: '', notes: [], fetchedAt: now.toISOString(),
  };
  if (!g?.connectionId) return { ...base, error: 'Connect with Google in Settings › Google to see website visitors.' };
  if (!property) return { ...base, error: 'Choose the Google Analytics property in Settings › Google.' };

  const tenant = currentTenant();
  const key = `${tenant?.id || ''}:${property.id}:${report}:${dimension}:${r.key}:${compare}`;
  if (report !== 'realtime' && !d?.refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }

  try {
    let data: AnalyticsReport;
    if (report === 'realtime') {
      const [realtime, ...cards] = await Promise.all([
        realtimeFigures(property.id),
        realtimeCard(property.id, 'Users by country', { id: 'country', label: 'Country' }, M.activeUsers),
        realtimeCard(property.id, 'Users by city', { id: 'city', label: 'City' }, M.activeUsers),
        realtimeCard(property.id, 'Users by device', { id: 'deviceCategory', label: 'Device' }, M.activeUsers),
        realtimeCard(property.id, 'Views by page title', { id: 'unifiedScreenName', label: 'Page title' }, M.screenPageViews),
        realtimeCard(property.id, 'Event count by event name', { id: 'eventName', label: 'Event name' }, M.eventCount),
        realtimeCard(property.id, 'Key events by event name', { id: 'eventName', label: 'Event name' }, M.keyEvents),
      ]);
      data = { ...base, realtime, cards };
    } else if (report === 'snapshot') {
      const [fig, realtime, ...cards] = await Promise.all([
        periodFigures(property.id, SNAPSHOT_METRICS, r, compare),
        realtimeFigures(property.id).catch(() => null),
        card(property.id, 'Sessions by channel', { id: 'sessionDefaultChannelGroup', label: 'Session channel' }, M.sessions, r),
        card(property.id, 'New users by first channel', { id: 'firstUserDefaultChannelGroup', label: 'First user channel' }, M.newUsers, r),
        card(property.id, 'Active users by country', { id: 'country', label: 'Country' }, M.activeUsers, r),
        card(property.id, 'Active users by city', { id: 'city', label: 'City' }, M.activeUsers, r),
        card(property.id, 'Views by page title', { id: 'pageTitle', label: 'Page title' }, M.screenPageViews, r),
        card(property.id, 'Event count by event name', { id: 'eventName', label: 'Event name' }, M.eventCount, r),
        card(property.id, 'Key events by event name', { id: 'eventName', label: 'Event name' }, M.keyEvents, r),
        card(property.id, 'Active users by device', { id: 'deviceCategory', label: 'Device' }, M.activeUsers, r),
      ]);
      data = { ...base, totals: fig.totals, prevTotals: fig.prevTotals, daily: fig.daily, cards, realtime, currency: fig.currency, timeZone: fig.timeZone, notes: notesOf(fig.answers) };
    } else {
      const main = table.metrics[0];
      const [fig, rows] = await Promise.all([
        periodFigures(property.id, table.metrics, r, compare),
        run(property.id, { dateRanges: [{ startDate: r.from, endDate: r.to }], dimensions: [{ name: dimension }], metrics: metricsBody(table.metrics), orderBys: [{ metric: { metricName: main.id }, desc: true }], limit: ROW_LIMIT }),
      ]);
      data = {
        ...base, totals: fig.totals, prevTotals: fig.prevTotals, daily: fig.daily, currency: fig.currency, timeZone: fig.timeZone, notes: notesOf([...fig.answers, rows]),
        rows: (rows?.rows || []).map((x: any) => ({ name: truncate(dimOf(x) || '(not set)', 300), values: valuesOf(x, table.metrics) })), rowCount: Number(rows?.rowCount || 0),
      };
    }
    if (report !== 'realtime') cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e: any) {
    const msg = String(e?.message || e);
    return { ...base, error: /insufficient|scope|permission|403/i.test(msg) ? 'Google Analytics access is missing. Connect with Google again (Settings › Google) and allow Google Analytics.' : truncate(msg, 300) };
  }
}

export function clearAnalyticsReportCache() {
  cache.clear();
}

export const actions: ActionMap = {
  getAnalyticsReport: {
    fn: (d) => {
      if (!(currentTenant()?.features as any)?.websiteAnalytics) throw fail('FORBIDDEN', "Website analytics is not included in your company's plan.");
      return getAnalyticsReport(d);
    },
    perm: 'reports.view',
  },
};
