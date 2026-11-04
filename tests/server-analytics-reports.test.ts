/** Website analytics reports: Google's own totals, the days before, each report's dimensions, realtime, and what Google warns about. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { actions, clearAnalyticsReportCache, dateRange, getAnalyticsReport, TABLE_REPORTS } from '../server/modules/analyticsReports';

let t: Awaited<ReturnType<typeof startTestDb>>;
let asked: Array<{ path: string; body: any }> = [];
let meta: Record<string, unknown> = {};
let cardFails = '';
const now = new Date('2026-11-04T10:00:00Z');
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const row = (dims: string[], mets: number[]) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((m) => ({ value: String(m) })) });

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  const body = JSON.parse(String(init.body || '{}'));
  asked.push({ path: url.pathname, body });
  const d = body.dimensions?.[0]?.name;
  const n = (body.metrics || []).length;
  const fill = (v: number) => Array.from({ length: n }, (_, i) => v + i);
  if (url.pathname.endsWith(':runRealtimeReport')) {
    if (!d) return json(200, { rows: [row([], [12])] });
    if (d === 'minutesAgo') return json(200, { rows: [row(['00'], [5]), row(['03'], [2])] });
    return json(200, { rows: [row([d === 'country' ? 'India' : 'x'], [7])] });
  }
  const old = body.dateRanges[0].startDate < '2026-10-01';
  if (d === cardFails) return json(400, { error: { message: 'Bad dimension', status: 'INVALID_ARGUMENT' } });
  if (!d) return json(200, { rows: [row([], fill(old ? 50 : 100))], metadata: { currencyCode: 'INR', timeZone: 'Asia/Kolkata', ...meta } });
  if (d === 'date') return json(200, { rows: [row([body.dateRanges[0].startDate.replace(/-/g, '')], fill(old ? 5 : 10))] });
  return json(200, { rows: [row(['B row'], fill(20)), row(['', ], fill(10))], rowCount: 300, metadata: { ...meta } });
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { websiteAnalytics: true });
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-123';
  resetGoogleOAuthTokenCache();
  clearAnalyticsReportCache();
  asked = [];
  meta = {};
  cardFails = '';
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '' });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'a@b.c', scopes: ['https://www.googleapis.com/auth/analytics.readonly'], ga4PropertyId: '4455', ga4Properties: [{ id: '4455', name: 'amaya.example' }] });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('date ranges', () => {
  it('like Google, the last whole days without today, and the same number of days before', () => {
    expect(dateRange({ preset: 'last7' }, now)).toMatchObject({ from: '2026-10-28', to: '2026-11-03', prevFrom: '2026-10-21', prevTo: '2026-10-27' });
    expect(dateRange({}, now)).toMatchObject({ from: '2026-10-07', to: '2026-11-03' });
    expect(dateRange({ preset: 'today' }, now)).toMatchObject({ from: '2026-11-04', to: '2026-11-04', prevFrom: '2026-11-03', prevTo: '2026-11-03' });
    expect(dateRange({ preset: 'yesterday' }, now)).toMatchObject({ from: '2026-11-03', to: '2026-11-03' });
    expect(dateRange({ from: '2026-10-01', to: '2026-10-10' }, now)).toMatchObject({ prevFrom: '2026-09-21', prevTo: '2026-09-30' });
  });

  it('refuses what is not a range', () => {
    expect(() => dateRange({ from: '2026-10-10', to: '2026-10-01' }, now)).toThrow(/start date/);
    expect(() => dateRange({ from: '2026-10-10' }, now)).toThrow(/start date/);
    expect(() => dateRange({ from: '2026-10-10', to: '2027-01-01' }, now)).toThrow(/future/);
    expect(() => dateRange({ preset: 'forever' }, now)).toThrow(/date range/);
  });
});

describe('reports', () => {
  it('a table report uses Google\'s own totals, every day of the range, the days before, and all the rows', async () => {
    const r = await inCo(() => getAnalyticsReport({ report: 'trafficAcquisition', preset: 'last7' }, now));
    expect(r.error).toBe('');
    expect(r.dimension).toBe('sessionDefaultChannelGroup');
    expect(r.totals.sessions).toBe(100);
    expect(r.prevTotals!.sessions).toBe(100); // this range is after 1 October in the fake
    expect(r.daily).toHaveLength(7);
    expect(r.daily[0]).toMatchObject({ day: '2026-10-28', prevDay: '2026-10-21' });
    expect(r.daily[0].values.sessions).toBe(10);
    expect(r.daily[1].values.sessions).toBe(0); // a day with no visits is a zero, not missing
    expect(r.rows.map((x) => x.name)).toEqual(['B row', '(not set)']);
    expect(r.rowCount).toBe(300);
    expect(r).toMatchObject({ currency: 'INR', timeZone: 'Asia/Kolkata', title: 'Traffic acquisition' });
  });

  it('every report asks Google for at most 10 metrics at a time, and for its chosen dimension', async () => {
    for (const [id, def] of Object.entries(TABLE_REPORTS)) {
      expect(def.metrics.length, id).toBeLessThanOrEqual(10);
      asked = [];
      const dim = def.dimensions[def.dimensions.length - 1].id;
      const r = await inCo(() => getAnalyticsReport({ report: id, dimension: dim, preset: 'last7' }, now));
      expect(r.error, id).toBe('');
      expect(asked.some((a) => a.body.dimensions?.[0]?.name === dim), id).toBe(true);
    }
    await expect(inCo(() => getAnalyticsReport({ report: 'events', dimension: 'country' }, now))).rejects.toThrow(/dimensions/);
    await expect(inCo(() => getAnalyticsReport({ report: 'everything' }, now))).rejects.toThrow(/Choose a report/);
  });

  it('without Compare the days before are not asked for', async () => {
    const r = await inCo(() => getAnalyticsReport({ report: 'events', preset: 'last7', compare: false }, now));
    expect(r.prevTotals).toBeNull();
    expect(r.daily[0].prev).toBeNull();
    expect(asked.some((a) => a.body.dateRanges?.[0]?.startDate === '2026-10-21')).toBe(false);
  });

  it('the snapshot has the figures, the cards and the last 30 minutes; one card failing does not lose the rest', async () => {
    cardFails = 'city';
    const r = await inCo(() => getAnalyticsReport({ report: 'snapshot', preset: 'last7' }, now));
    expect(r.error).toBe('');
    expect(r.totals.activeUsers).toBe(100);
    expect(r.cards.length).toBe(8);
    expect(r.cards.find((c) => c.dimension === 'City')!.error).toContain('Bad dimension');
    expect(r.cards.find((c) => c.dimension === 'Country')!.rows.length).toBeGreaterThan(0);
    expect(r.realtime!.activeUsers).toBe(12);
    expect(r.realtime!.perMinute).toHaveLength(30);
    expect(r.realtime!.perMinute[29]).toEqual({ minutesAgo: 0, users: 5 });
    expect(r.realtime!.perMinute[26]).toEqual({ minutesAgo: 3, users: 2 });
  });

  it('realtime reads the realtime report and is never kept', async () => {
    const r = await inCo(() => getAnalyticsReport({ report: 'realtime' }, now));
    expect(r.realtime!.activeUsers).toBe(12);
    expect(r.cards.find((c) => c.title === 'Users by country')!.rows[0]).toEqual({ name: 'India', values: { activeUsers: 7 } });
    const n = asked.length;
    await inCo(() => getAnalyticsReport({ report: 'realtime' }, now));
    expect(asked.length).toBe(2 * n);
    expect(asked.every((a) => a.path.endsWith(':runRealtimeReport'))).toBe(true);
  });

  it('keeps answers for 15 minutes unless refreshed', async () => {
    await inCo(() => getAnalyticsReport({ report: 'events', preset: 'last7' }, now));
    const n = asked.length;
    await inCo(() => getAnalyticsReport({ report: 'events', preset: 'last7' }, now));
    expect(asked.length).toBe(n);
    await inCo(() => getAnalyticsReport({ report: 'events', preset: 'last7', refresh: true }, now));
    expect(asked.length).toBe(2 * n);
  });

  it('passes on what Google says about thresholds, sampling and the (other) row', async () => {
    meta = { subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: '1' }] };
    const r = await inCo(() => getAnalyticsReport({ report: 'demographics', preset: 'last7' }, now));
    expect(r.notes.join(' ')).toMatch(/hides small numbers/);
    expect(r.notes.join(' ')).toMatch(/\(other\)/);
    expect(r.notes.join(' ')).toMatch(/sample/);
  });

  it('says what is missing when not connected, or when Google refuses', async () => {
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'google' }, { $unset: { ga4PropertyId: '' } }));
    expect((await inCo(() => getAnalyticsReport({}, now))).error).toMatch(/Choose the Google Analytics property/);
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'google' }, { $unset: { connectionId: '' } }));
    expect((await inCo(() => getAnalyticsReport({}, now))).error).toMatch(/Connect with Google/);
  });

  it('a company without the feature is refused', async () => {
    await t.company('test', { websiteAnalytics: false });
    await expect(inCo(async () => actions.getAnalyticsReport.fn({}, {} as any))).rejects.toThrow(/not included/);
  });
});
