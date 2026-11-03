/**
 * Website analytics (plan feature websiteAnalytics, screen /analytics): the company's GA4 property read with the
 * Google Analytics Data API through the Google connection of Settings › Google (scope analytics.readonly), shown
 * next to the CRM's own numbers for the same days: enquiries, site visits done, bookings.
 *
 * GA4  = POST analyticsdata.googleapis.com/v1beta/properties/<id>:runReport — visitors and sessions per day, by
 *        channel and by source / medium, and the top landing pages. Answers are kept 15 minutes per company and range.
 * CRM  = leads created in the range (by Enquiry Source and per day), site visits done (Completed / Walk-In) and
 *        bookings dated in the range.
 */
import type { ActionMap } from '../core/actions';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { gbpFetch } from './googleMarketing';

const IST_MS = 330 * 60000;
const CACHE_MS = 15 * 60000;
const cache = new Map<string, { at: number; data: WebsiteAnalytics }>();

export interface WebsiteAnalytics {
  days: number;
  from: string;
  to: string;
  property: { id: string; name: string } | null;
  error: string;
  web: {
    visitors: number;
    newVisitors: number;
    sessions: number;
    daily: Array<{ day: string; visitors: number; sessions: number }>;
    channels: Array<{ name: string; sessions: number; visitors: number }>;
    sources: Array<{ name: string; sessions: number }>;
    pages: Array<{ path: string; sessions: number }>;
  } | null;
  crm: {
    enquiries: number;
    siteVisits: number;
    bookings: number;
    daily: Array<{ day: string; enquiries: number }>;
    bySource: Array<{ name: string; enquiries: number; siteVisits: number; bookings: number }>;
  };
}

const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

/** The days of the range, oldest first (India time, today included). */
export function rangeDays(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(istDay(new Date(now.getTime() - i * 86400000)));
  return out;
}

async function runReport(property: string, body: Record<string, unknown>): Promise<any[]> {
  const j = await gbpFetch<{ rows?: any[] }>(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, { body });
  return j.rows || [];
}
const dim = (r: any, i = 0) => String(r?.dimensionValues?.[i]?.value ?? '');
const met = (r: any, i = 0) => Number(r?.metricValues?.[i]?.value ?? 0) || 0;
const gaDay = (v: string) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : v);

async function webFigures(property: string, from: string, to: string, days: string[]): Promise<NonNullable<WebsiteAnalytics['web']>> {
  const dateRanges = [{ startDate: from, endDate: to }];
  const [total, daily, channels, sources, pages] = await Promise.all([
    runReport(property, { dateRanges, metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' }] }),
    runReport(property, { dateRanges, dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }], limit: 400 }),
    runReport(property, { dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 12 }),
    runReport(property, { dateRanges, dimensions: [{ name: 'sessionSourceMedium' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }),
    runReport(property, { dateRanges, dimensions: [{ name: 'landingPage' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }),
  ]);
  const byDay = new Map(daily.map((r) => [gaDay(dim(r)), { visitors: met(r, 0), sessions: met(r, 1) }]));
  return {
    visitors: met(total[0], 0), newVisitors: met(total[0], 1), sessions: met(total[0], 2),
    daily: days.map((day) => ({ day, visitors: byDay.get(day)?.visitors || 0, sessions: byDay.get(day)?.sessions || 0 })),
    channels: channels.map((r) => ({ name: dim(r) || '(not set)', sessions: met(r, 0), visitors: met(r, 1) })),
    sources: sources.map((r) => ({ name: dim(r) || '(not set)', sessions: met(r, 0) })),
    pages: pages.map((r) => ({ path: truncate(dim(r) || '/', 120), sessions: met(r, 0) })),
  };
}

async function crmFigures(start: Date, days: string[]): Promise<WebsiteAnalytics['crm']> {
  const leads = await col<any>(CFG.COLL.LEADS);
  const done = [CFG.SITE_VISIT.COMPLETED, CFG.SITE_VISIT.WALK_IN];
  const [created, visits, bookings] = await Promise.all([
    leads.find({ createdAt: { $gte: start } }, { projection: { createdAt: 1, source: 1 } }).toArray(),
    leads.find({ siteVisitDate: { $gte: start }, siteVisitStatus: { $in: done } }, { projection: { source: 1 } }).toArray(),
    leads.find({ bookingDate: { $gte: start } }, { projection: { source: 1 } }).toArray(),
  ]);
  const perDay = new Map<string, number>();
  for (const l of created) perDay.set(istDay(new Date(l.createdAt)), (perDay.get(istDay(new Date(l.createdAt))) || 0) + 1);
  const src = new Map<string, { enquiries: number; siteVisits: number; bookings: number }>();
  const add = (s: unknown, k: 'enquiries' | 'siteVisits' | 'bookings') => {
    const name = String(s || '').trim() || 'Not set';
    const r = src.get(name) || { enquiries: 0, siteVisits: 0, bookings: 0 };
    r[k]++;
    src.set(name, r);
  };
  created.forEach((l) => add(l.source, 'enquiries'));
  visits.forEach((l) => add(l.source, 'siteVisits'));
  bookings.forEach((l) => add(l.source, 'bookings'));
  return {
    enquiries: created.length, siteVisits: visits.length, bookings: bookings.length,
    daily: days.map((day) => ({ day, enquiries: perDay.get(day) || 0 })),
    bySource: [...src.entries()].map(([name, r]) => ({ name, ...r })).sort((a, b) => b.enquiries - a.enquiries || b.bookings - a.bookings),
  };
}

export async function getWebsiteAnalytics(d: any = {}, now = new Date()): Promise<WebsiteAnalytics> {
  const days = [7, 30, 90].includes(Number(d?.days)) ? Number(d.days) : 30;
  const list = rangeDays(days, now);
  const from = list[0], to = list[list.length - 1];
  const tenant = currentTenant();
  const key = `${tenant?.id || ''}:${days}:${to}`;
  const hit = cache.get(key);
  if (!d?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const start = new Date(Date.parse(`${from}T00:00:00Z`) - IST_MS);
  const g = await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'google' });
  const prop = g?.ga4PropertyId ? { id: String(g.ga4PropertyId), name: String((g.ga4Properties || []).find((p: any) => p.id === g.ga4PropertyId)?.name || g.ga4PropertyId) } : null;
  let web: WebsiteAnalytics['web'] = null;
  let error = '';
  if (!g?.connectionId) error = 'Connect with Google in Settings › Google to see website visitors.';
  else if (!prop) error = 'Choose the Google Analytics property in Settings › Google.';
  else {
    try {
      web = await webFigures(prop.id, from, to, list);
    } catch (e: any) {
      error = /insufficient|scope|permission|403/i.test(e?.message || '') ? 'Google Analytics access is missing. Connect with Google again (Settings › Google) and allow Google Analytics.' : truncate(e?.message || String(e), 300);
    }
  }
  const data: WebsiteAnalytics = { days, from, to, property: prop, error, web, crm: await crmFigures(start, list) };
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function clearAnalyticsCache() {
  cache.clear();
}

export const actions: ActionMap = {
  getWebsiteAnalytics: {
    fn: (d) => {
      if (!(currentTenant()?.features as any)?.websiteAnalytics) throw fail('FORBIDDEN', "Website analytics is not included in your company's plan.");
      return getWebsiteAnalytics(d);
    },
    perm: 'reports.view',
  },
};
