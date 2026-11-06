/** Search Console: its own connect asking only for its permission, figures, sitemaps, and indexing checked page by page. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { startGoogleMktConnect } from '../server/modules/googleMarketing';
import { belongsToSite, checkIndexing, clearSearchConsoleCache, disconnectSearchConsole, getIndexing, getSearchSitemaps, inspectSearchUrl, searchFilters, getSearchPerformance, inspectLimits, locsOf, saveSearchConsole, searchRange, startSearchConsoleConnect } from '../server/modules/searchConsole';

vi.mock('dns/promises', () => ({ default: { lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) } }));

let t: Awaited<ReturnType<typeof startTestDb>>;
let asked: Array<{ url: URL; body: any }> = [];
let inspectFails = '';
const SITE = 'sc-domain:amaya.example';
const now = new Date('2026-11-05T10:00:00Z');
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SITEMAP = '<urlset><url><loc>https://amaya.example/a</loc></url><url><loc>https://amaya.example/b?x=1&amp;y=2</loc></url><url><loc>https://evil.example/c</loc></url></urlset>';

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  const body = init.body ? JSON.parse(String(init.body)) : null;
  asked.push({ url, body });
  if (url.host === 'amaya.example') return new Response(url.pathname === '/index.xml' ? '<sitemapindex><sitemap><loc>https://amaya.example/sitemap.xml</loc></sitemap></sitemapindex>' : SITEMAP, { status: 200 });
  if (url.host === 'searchconsole.googleapis.com') {
    if (inspectFails) return json(429, { error: { message: inspectFails } });
    const page = String(body.inspectionUrl);
    return json(200, { inspectionResult: { inspectionResultLink: 'https://search.google.com/search-console/inspect?x=1', indexStatusResult: page.endsWith('/a') ? { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-11-01T00:00:00Z' } : { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' } } });
  }
  if (url.pathname.endsWith('/sitemaps')) return json(200, { sitemap: [{ path: 'https://amaya.example/index.xml', lastSubmitted: '2026-10-01T00:00:00Z', lastDownloaded: '2026-11-01T00:00:00Z', errors: '1', warnings: '2', contents: [{ type: 'web', submitted: '3', indexed: '0' }] }] });
  if (url.pathname.endsWith('/searchAnalytics/query')) {
    const d = body.dimensions[0];
    const old = body.startDate < '2026-10-01';
    const row = (key: string | null, clicks: number) => ({ ...(key ? { keys: [key] } : {}), clicks, impressions: clicks * 10, ctr: 0.1, position: 4.5 });
    if (!d) return json(200, { rows: [row(null, old ? 50 : 100)] });
    if (d === 'date') return json(200, { rows: [row(body.startDate, 7)] });
    if (d === 'query') return json(200, { rows: [row('senior living hyderabad', 40)] });
    if (d === 'page') return json(200, { rows: [row('https://amaya.example/a', 60), row('https://amaya.example/z', 2)] });
    if (d === 'country') return json(200, { rows: [row('ind', 90)] });
    return json(200, { rows: [row('MOBILE', 80)] });
  }
  return json(404, { error: { message: `unexpected ${url}` } });
}

beforeAll(async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-123';
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'APP_URL']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { searchConsole: true });
  resetGoogleOAuthTokenCache();
  clearSearchConsoleCache();
  asked = [];
  inspectFails = '';
  inspectLimits.perRun = 100;
  inspectLimits.perDay = 1900;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '' });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'searchConsole', connectionId: 'GCN-0001', email: 'a@b.c', scopes: [], sites: [SITE], siteUrl: SITE });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function session(role: 'Admin' | 'Manager' | 'RM' | 'Viewer' = 'Admin') {
  const email = `${role.toLowerCase()}@gsc.test`;
  return inCo(async () => {
    await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
    return (await login(email, 'long-enough-pw', { userAgent: 'vitest', ip: '10.9.9.9' })).token;
  });
}

describe('connect', () => {
  it('asks Google only for Search Console, and the verified connect is not changed', async () => {
    const token = await session();
    const r = await startSearchConsoleConnect({ sessionCookie: `CMP-test.${token}` });
    const scope = new URL(r.redirect).searchParams.get('scope')!;
    expect(scope).toBe('openid email https://www.googleapis.com/auth/webmasters.readonly');
    await t.company('test', { searchConsole: true, websiteAnalytics: true });
    const other = await startGoogleMktConnect({ sessionCookie: `CMP-test.${token}` });
    expect(new URL(other.redirect).searchParams.get('scope')).not.toContain('webmasters');
  });

  it('is refused for a company without the feature, which is off by default, and for non-Admins', async () => {
    const admin = await session();
    await t.company('test', { searchConsole: false });
    expect((await startSearchConsoleConnect({ sessionCookie: `CMP-test.${admin}` })).redirect).toContain('gscError');
    expect((await inCo(() => dispatch('getSearchPerformance', {}, { userAgent: 'vitest', ip: '10.9.9.9', token: admin }))).status).toBe(403);
    await t.company('test', { searchConsole: true });
    const manager = await session('Manager');
    expect((await startSearchConsoleConnect({ sessionCookie: `CMP-test.${manager}` })).redirect).toContain('gscError');
  });

  it('disconnect removes the stored access and checks, but keeps an account Ads or Analytics still use', async () => {
    await inCo(() => checkIndexing({}, ctx, now));
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001' }));
    await inCo(() => disconnectSearchConsole(ctx));
    expect(await inCo(async () => (await col<any>('googleConnections')).countDocuments({}))).toBe(1);
    expect(await inCo(async () => (await col<any>('searchConsolePages')).countDocuments({}))).toBe(0);
    await inCo(async () => {
      await (await col<any>(CFG.COLL.INTEGRATIONS)).deleteOne({ _id: 'google' });
      await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'searchConsole', connectionId: 'GCN-0001', email: 'a@b.c', scopes: [], sites: [SITE], siteUrl: SITE });
    });
    await inCo(() => disconnectSearchConsole(ctx));
    expect(await inCo(async () => (await col<any>('googleConnections')).countDocuments({}))).toBe(0);
  });

  it('only a website of this Google account can be chosen', async () => {
    await expect(inCo(() => saveSearchConsole({ siteUrl: 'sc-domain:other.example' }, ctx))).rejects.toThrow(/Choose one/);
  });
});

describe('figures', () => {
  it('ranges end 2 days ago, with the same number of days before', () => {
    expect(searchRange({ preset: 'last7' }, now)).toEqual({ from: '2026-10-28', to: '2026-11-03', prevFrom: '2026-10-21', prevTo: '2026-10-27' });
    expect(() => searchRange({ preset: 'forever' }, now)).toThrow(/date range/);
  });

  it('reads totals, every day, top lists and sitemaps for the chosen site', async () => {
    const r = await inCo(() => getSearchPerformance({ preset: 'last7' }, now));
    expect(r.error).toBe('');
    expect(r.totals).toMatchObject({ clicks: 100, impressions: 1000, ctr: 0.1, position: 4.5 });
    expect(r.daily).toHaveLength(7);
    expect(r.daily[0].values.clicks).toBe(7);
    expect(r.daily[1].values.clicks).toBe(0); // a day with no clicks is a zero
    expect(r.queries[0]).toMatchObject({ name: 'senior living hyderabad', clicks: 40 });
    expect(r.countries[0].name).toBe('ind');
    expect(r.sitemaps[0]).toMatchObject({ path: 'https://amaya.example/index.xml', errors: 1, warnings: 2, submitted: 3 });
    expect(asked[0].url.pathname).toContain(encodeURIComponent(SITE));
  });

  it('sends the search type and filters, and keeps each combination apart', async () => {
    const filters = [{ dimension: 'query', operator: 'contains', expression: 'senior' }];
    await inCo(() => getSearchPerformance({ preset: 'last7', type: 'image', filters }, now));
    const sent = asked.find((a) => a.url.pathname.endsWith('/searchAnalytics/query'))!.body;
    expect(sent.type).toBe('image');
    expect(sent.dimensionFilterGroups).toEqual([{ groupType: 'and', filters }]);
    const before = asked.length;
    await inCo(() => getSearchPerformance({ preset: 'last7', type: 'image', filters }, now));
    expect(asked.length).toBe(before);
    await inCo(() => getSearchPerformance({ preset: 'last7', type: 'web', filters }, now));
    expect(asked.length).toBeGreaterThan(before);
    await expect(inCo(() => getSearchPerformance({ preset: 'last7', type: 'everything' }, now))).rejects.toThrow(/search type/);
    expect(() => searchFilters([{ dimension: 'password', operator: 'equals', expression: 'x' }])).toThrow(/not valid/);
    expect(() => searchFilters([{ dimension: 'query', operator: 'equals', expression: '  ' }])).toThrow(/not valid/);
  });

  it('compares with the days before or a year before, with the tables only when asked', async () => {
    expect(searchRange({ preset: 'last7', compare: 'year' }, now)).toMatchObject({ prevFrom: '2025-10-29', prevTo: '2025-11-04' });
    expect((await inCo(() => getSearchPerformance({ preset: 'last7' }, now))).prevTables).toBeNull();
    const r = await inCo(() => getSearchPerformance({ preset: 'last7', compare: 'previous' }, now));
    expect(r.prevTables!.queries[0].name).toBe('senior living hyderabad');
    expect(() => searchRange({ from: '2020-01-01', to: '2026-01-01' }, now)).toThrow(/16 months/);
  });

  it('says what is missing, and passes on what Google says', async () => {
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'searchConsole' }, { $set: { siteUrl: '' } }));
    expect((await inCo(() => getSearchPerformance({}, now))).error).toMatch(/Choose your website/);
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'searchConsole' }, { $set: { siteUrl: SITE } }));
    vi.stubGlobal('fetch', vi.fn(async (input: any) => (String(input).includes('oauth2') ? json(200, { access_token: 'GAT', expires_in: 3600 }) : json(403, { error: { message: 'User does not have sufficient permission' } }))));
    expect((await inCo(() => getSearchPerformance({ preset: 'last7' }, now))).error).toMatch(/sufficient permission/);
  });
});

describe('sitemaps and one address', () => {
  it('lists sitemaps on their own', async () => {
    const r = await inCo(() => getSearchSitemaps());
    expect(r.sitemaps[0]).toMatchObject({ path: 'https://amaya.example/index.xml', type: 'Sitemap', submitted: 3 });
  });

  it('gives Google\'s result for an address of the site, counted in the daily limit', async () => {
    const r = await inCo(() => inspectSearchUrl({ url: 'https://amaya.example/a' }, now));
    expect(r).toMatchObject({ verdict: 'PASS', coverage: 'Submitted and indexed', link: 'https://search.google.com/search-console/inspect?x=1' });
    expect((await inCo(() => getIndexing(now))).usedToday).toBe(1);
    await expect(inCo(() => inspectSearchUrl({ url: 'https://evil.example/a' }, now))).rejects.toThrow(/not part of/);
    inspectLimits.perDay = 1;
    await expect(inCo(() => inspectSearchUrl({ url: 'https://amaya.example/a' }, now))).rejects.toThrow(/limit is used up/);
  });
});

describe('indexing', () => {
  it('reads sitemap pages, only of this site, and counts what Google says is indexed', async () => {
    const r = await inCo(() => checkIndexing({}, ctx, now));
    expect(r).toMatchObject({ total: 2, checked: 2, indexed: 1, notIndexed: 1, unchecked: 0, justChecked: 2, usedToday: 2, more: false });
    expect(r.reasons).toEqual([{ reason: 'Crawled - currently not indexed', pages: 1 }]);
    expect(r.rows.map((x) => x.url).sort()).toEqual(['https://amaya.example/a', 'https://amaya.example/b?x=1&y=2']);
    expect(asked.some((a) => a.url.host === 'evil.example')).toBe(false);
    expect(asked.filter((a) => a.url.host === 'searchconsole.googleapis.com').map((a) => a.body.siteUrl)).toEqual([SITE, SITE]);
  });

  it('carries on from where it stopped, and checks again only after a week', async () => {
    inspectLimits.perRun = 1;
    const first = await inCo(() => checkIndexing({}, ctx, now));
    expect(first).toMatchObject({ justChecked: 1, unchecked: 1, more: true });
    const second = await inCo(() => checkIndexing({}, ctx, now));
    expect(second).toMatchObject({ justChecked: 1, unchecked: 0, more: false });
    const third = await inCo(() => checkIndexing({}, ctx, now));
    expect(third.justChecked).toBe(0);
    expect((await inCo(() => checkIndexing({}, ctx, new Date(now.getTime() + 8 * 86400000)))).justChecked).toBe(1);
  });

  it('stays within the daily limit', async () => {
    inspectLimits.perDay = 1;
    const r = await inCo(() => checkIndexing({}, ctx, now));
    expect(r.justChecked).toBe(1);
    const next = await inCo(() => checkIndexing({}, ctx, now));
    expect(next.justChecked).toBe(0);
    expect(next.note).toMatch(/limit is used up/);
  });

  it('a refused check is said, not counted as not indexed', async () => {
    inspectFails = 'Quota exceeded';
    const r = await inCo(() => checkIndexing({}, ctx, now));
    expect(r).toMatchObject({ justChecked: 0, indexed: 0, notIndexed: 0, failed: 2, more: false });
    expect(r.note).toContain('Quota exceeded');
    expect(r.usedToday).toBe(0);
  });

  it('without a readable sitemap, uses pages seen in search, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => (new URL(String(input)).host === 'amaya.example' ? new Response('', { status: 500 }) : fake(input, init))));
    const r = await inCo(() => checkIndexing({}, ctx, now));
    expect(r.rows.map((x) => x.url).sort()).toEqual(['https://amaya.example/a', 'https://amaya.example/z']);
    expect(r.note).toMatch(/only pages already seen/);
  });

  it('a sitemap failing for a moment does not lose earlier results', async () => {
    await inCo(() => checkIndexing({}, ctx, now));
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => (new URL(String(input)).host === 'amaya.example' ? new Response('', { status: 500 }) : fake(input, init))));
    await inCo(() => checkIndexing({}, ctx, now));
    expect((await inCo(() => getIndexing(now))).rows.map((x) => x.url)).toContain('https://amaya.example/b?x=1&y=2');
  });

  it('only reads addresses of the verified site', () => {
    expect(belongsToSite('https://www.amaya.example/x', SITE)).toBe(true);
    expect(belongsToSite('https://amaya.example.evil.com/x', SITE)).toBe(false);
    expect(belongsToSite('ftp://amaya.example/x', SITE)).toBe(false);
    expect(belongsToSite('https://amaya.example/blog/a', 'https://amaya.example/blog/')).toBe(true);
    expect(belongsToSite('https://amaya.example/other', 'https://amaya.example/blog/')).toBe(false);
    expect(locsOf('<loc> https://a.example/x </loc><loc><![CDATA[https://a.example/y]]></loc>')).toEqual(['https://a.example/x', 'https://a.example/y']);
  });

  it('who may check pages and who may read', async () => {
    const rm = await session('RM');
    const viewer = await session('Viewer');
    const base = { userAgent: 'vitest', ip: '10.9.9.9' };
    expect((await inCo(() => dispatch('checkSearchIndexing', {}, { ...base, token: rm }))).status).toBe(403);
    expect((await inCo(() => dispatch('checkSearchIndexing', {}, { ...base, token: viewer }))).status).toBe(403);
    expect((await inCo(() => dispatch('getSearchIndexing', {}, { ...base, token: viewer }))).status).toBe(200);
    expect((await inCo(() => dispatch('getSearchSitemaps', {}, { ...base, token: viewer }))).status).toBe(200);
    expect((await inCo(() => dispatch('inspectSearchUrl', { url: 'https://amaya.example/a' }, { ...base, token: viewer }))).status).toBe(403);
  });
});
