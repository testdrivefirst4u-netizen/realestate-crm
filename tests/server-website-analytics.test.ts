/** Website analytics: GA4 properties found on connect, GA4 figures next to CRM enquiries / site visits / bookings. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { encryptSecret } from '../server/core/settings';
import { addLead, updateLead } from '../server/modules/leads';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { getGoogleMarketing, refreshGoogleAssets, saveGoogleMarketing } from '../server/modules/googleMarketing';
import { actions, clearAnalyticsCache, getWebsiteAnalytics, rangeDays } from '../server/modules/websiteAnalytics';

let t: Awaited<ReturnType<typeof startTestDb>>;
let reports: any[] = [];
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const row = (dims: string[], mets: number[]) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((m) => ({ value: String(m) })) });

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  if (url.host === 'analyticsadmin.googleapis.com') return json(200, { accountSummaries: [{ displayName: 'Amaya', propertySummaries: [{ property: 'properties/4455', displayName: 'amaya.example' }] }] });
  if (url.host === 'analyticsdata.googleapis.com') {
    expect(url.pathname).toBe('/v1beta/properties/4455:runReport');
    const body = JSON.parse(String(init.body));
    reports.push(body);
    const d = body.dimensions?.[0]?.name;
    if (!d) return json(200, { rows: [row([], [1200, 900, 1500])] });
    if (d === 'date') return json(200, { rows: [row(['20261102'], [80, 95]), row(['20261101'], [60, 70])] });
    if (d === 'sessionDefaultChannelGroup') return json(200, { rows: [row(['Paid Social'], [700, 600]), row(['Organic Search'], [500, 400])] });
    if (d === 'sessionSourceMedium') return json(200, { rows: [row(['facebook / cpc'], [650])] });
    if (d === 'landingPage') return json(200, { rows: [row(['/amaya'], [900])] });
  }
  return json(404, { error: { message: 'unexpected ' + url } });
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
  clearAnalyticsCache();
  reports = [];
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '', connectedBy: 'x', connectedAt: new Date() });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'a@b.c', scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('website analytics', () => {
  it('lists the GA4 property on connect and picks the only one', async () => {
    await inCo(() => refreshGoogleAssets());
    const v = await inCo(() => getGoogleMarketing());
    expect(v).toMatchObject({ analyticsAccess: true, ga4Properties: [{ id: '4455', name: 'amaya.example · Amaya' }], ga4PropertyId: '4455', setupError: '' });
    await expect(inCo(() => saveGoogleMarketing({ ga4PropertyId: '999' }, { user: { name: 'x' } } as any))).rejects.toThrow(/Choose one of the Google Analytics properties/);
  });

  it('shows GA4 visitors next to CRM enquiries, site visits and bookings for the same days', async () => {
    await inCo(() => refreshGoogleAssets());
    const ids = await inCo(async () => {
      const out: string[] = [];
      for (const [name, source] of [['A', 'Facebook'], ['B', 'Facebook'], ['C', 'Website']]) out.push((await addLead({ 'Prospect Name': name, 'Phone Number': '9123406' + (100 + out.length), 'Enquiry Source': source } as any, null)).id);
      return out;
    });
    await inCo(() => updateLead(ids[0], { 'Site Visit Status': 'Site Visit - Completed' } as any, null));
    await inCo(() => updateLead(ids[0], { 'Lead Stage': 'Booked', 'Booking Date': new Date().toISOString().slice(0, 10) } as any, null));
    const now = new Date('2026-11-02T10:00:00Z');
    const r = await inCo(() => getWebsiteAnalytics({ days: 7 }, now));
    expect(r).toMatchObject({ days: 7, from: '2026-10-27', to: '2026-11-02', property: { id: '4455' }, error: '' });
    expect(r.web).toMatchObject({ visitors: 1200, newVisitors: 900, sessions: 1500, sources: [{ name: 'facebook / cpc', sessions: 650 }], pages: [{ path: '/amaya', sessions: 900 }] });
    expect(r.web!.daily).toHaveLength(7);
    expect(r.web!.daily.slice(-2)).toEqual([{ day: '2026-11-01', visitors: 60, sessions: 70 }, { day: '2026-11-02', visitors: 80, sessions: 95 }]);
    expect(r.web!.channels[0]).toEqual({ name: 'Paid Social', sessions: 700, visitors: 600 });
    expect(reports[0].dateRanges).toEqual([{ startDate: '2026-10-27', endDate: '2026-11-02' }]);
    // CRM side counts the real leads (created today, in real time)
    const live = await inCo(() => getWebsiteAnalytics({ days: 7, refresh: true }));
    expect(live.crm).toMatchObject({ enquiries: 3, siteVisits: 1, bookings: 1 });
    expect(live.crm.bySource[0]).toEqual({ name: 'Facebook', enquiries: 2, siteVisits: 1, bookings: 1 });
    expect(live.crm.daily.reduce((s, d) => s + d.enquiries, 0)).toBe(3);
    // answers are kept for 15 minutes
    const n = reports.length;
    await inCo(() => getWebsiteAnalytics({ days: 7 }));
    expect(reports.length).toBe(n);
  });

  it('without a chosen property the CRM figures still show with a hint; switched off is refused', async () => {
    const r = await inCo(() => getWebsiteAnalytics({ days: 30 }));
    expect(r.web).toBeNull();
    expect(r.error).toMatch(/Choose the Google Analytics property/);
    expect(r.crm.daily).toHaveLength(30);
    expect(rangeDays(3, new Date('2026-01-01T20:00:00Z'))).toEqual(['2025-12-31', '2026-01-01', '2026-01-02']);
    await t.company('test', { websiteAnalytics: false });
    await expect(inCo(async () => actions.getWebsiteAnalytics.fn({}, {} as any))).rejects.toThrow(/not included/);
  });
});
