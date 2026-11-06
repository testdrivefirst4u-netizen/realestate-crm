/** Ads manager › Meta table: Meta's columns at three levels, the date range, results by goal, one account failing, who may read. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { dateParams, listMetaAds, resultAction } from '../server/modules/metaAdsTable';

let t: Awaited<ReturnType<typeof startTestDb>>;
let asked: Array<{ path: string; q: URLSearchParams }> = [];
const base = { userAgent: 'vitest', ip: '10.7.7.7' };
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fake(input: any): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  asked.push({ path, q: url.searchParams });
  if (path === '/act_2/campaigns' || path === '/act_2/insights') return json(400, { error: { message: 'No permission for this ad account', code: 200 } });
  if (path === '/act_1/campaigns') {
    if (!url.searchParams.get('after')) return json(200, { data: [{ id: '61', name: 'Leads Q4', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', daily_budget: '150000', start_time: '2026-10-01T00:00:00+0530' }], paging: { cursors: { after: 'P2' }, next: 'https://graph.facebook.com/next' } });
    return json(200, { data: [{ id: '62', name: 'Awareness', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_AWARENESS', lifetime_budget: '5000000' }] });
  }
  if (path === '/act_1/insights' && url.searchParams.get('level') === 'campaign') return json(200, { data: [
    { campaign_id: '61', spend: '9000.50', reach: '12000', impressions: '30000', frequency: '2.5', clicks: '900', ctr: '3', cpc: '10', cpm: '300', inline_link_clicks: '600', inline_link_click_ctr: '2', cost_per_inline_link_click: '15', actions: [{ action_type: 'link_click', value: '600' }, { action_type: 'lead', value: '45' }, { action_type: 'landing_page_view', value: '200' }] },
    { campaign_id: '62', spend: '100', reach: '5000', impressions: '6000' },
  ] });
  if (path === '/act_1/adsets') return json(200, { data: [{ id: '71', name: 'Hyderabad 35+', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', campaign_id: '61', campaign: { name: 'Leads Q4', objective: 'OUTCOME_LEADS' }, optimization_goal: 'LANDING_PAGE_VIEWS', end_time: '2026-12-01T00:00:00+0530' }] });
  if (path === '/act_1/ads') return json(200, { data: [{ id: '81', name: 'Tower video', status: 'ACTIVE', effective_status: 'ACTIVE', campaign_id: '61', adset_id: '71', campaign: { name: 'Leads Q4', objective: 'OUTCOME_LEADS' }, adset: { name: 'Hyderabad 35+', optimization_goal: 'LEAD_GENERATION' }, creative: { thumbnail_url: 'https://cdn.example/t.jpg' } }] });
  if (path === '/act_1/insights' && url.searchParams.get('level') === 'adset') return json(200, { data: [{ adset_id: '71', spend: '500', actions: [{ action_type: 'landing_page_view', value: '50' }, { action_type: 'lead', value: '5' }] }] });
  if (path === '/act_1/insights' && url.searchParams.get('level') === 'ad') return json(200, { data: [{ ad_id: '81', spend: '200', quality_ranking: 'ABOVE_AVERAGE_35', engagement_rate_ranking: 'AVERAGE', conversion_rate_ranking: 'BELOW_AVERAGE_10', actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '4' }] }] });
  return json(404, { error: { message: `unexpected ${path}` } });
}

async function connect(accounts = [{ id: 'act_1', name: 'Amaya', currency: 'INR' }]) {
  await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'metaCapi' }, { $set: { token: encryptSecret('MT'), connectedVia: 'facebook', adAccounts: accounts } }, { upsert: true }));
}

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = 'secret';
  t = await startTestDb();
});
afterAll(async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { adsControl: true });
  asked = [];
  vi.stubGlobal('fetch', vi.fn(fake));
});
afterEach(() => vi.unstubAllGlobals());

describe('Meta table', () => {
  it('lists campaigns over every page with Meta\'s figures, in the account\'s currency units', async () => {
    await connect();
    const r = await inCo(() => listMetaAds({ level: 'campaign', preset: 'last_30d' }));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.id)).toEqual(['61', '62']);
    expect(r.rows[0]).toMatchObject({
      name: 'Leads Q4', delivery: 'ACTIVE', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', dailyBudget: 1500, lifetimeBudget: null, resultLabel: 'Leads', results: 45, costPerResult: 9000.5 / 45,
      spend: 9000.5, reach: 12000, impressions: 30000, frequency: 2.5, clicks: 900, ctr: 3, cpc: 10, cpm: 300, linkClicks: 600, linkCtr: 2, linkCpc: 15, leads: 45, landingPageViews: 200, currency: 'INR',
    });
    expect(r.rows[1]).toMatchObject({ lifetimeBudget: 50000, dailyBudget: null, resultLabel: 'Reach', results: 5000, costPerResult: 100 / 5000 });
    const insight = asked.find((a) => a.path === '/act_1/insights')!.q;
    expect(insight.get('date_preset')).toBe('last_30d');
    expect(insight.get('use_unified_attribution_setting')).toBe('true');
  });

  it('counts the ad set\'s own goal as its result, and links ad sets and ads to their parents', async () => {
    await connect();
    const adsets = await inCo(() => listMetaAds({ level: 'adset' }));
    expect(adsets.rows[0]).toMatchObject({ campaignId: '61', campaignName: 'Leads Q4', delivery: 'CAMPAIGN_PAUSED', optimizationGoal: 'LANDING_PAGE_VIEWS', resultLabel: 'Landing page views', results: 50, leads: 5, costPerResult: 10 });
    expect(adsets.rows[0].end).toContain('2026-12-01');
    const ads = await inCo(() => listMetaAds({ level: 'ad' }));
    expect(ads.rows[0]).toMatchObject({ campaignId: '61', adsetId: '71', adsetName: 'Hyderabad 35+', thumbnail: 'https://cdn.example/t.jpg', results: 4, qualityRanking: 'ABOVE_AVERAGE_35', engagementRanking: 'AVERAGE', conversionRanking: 'BELOW_AVERAGE_10' });
    expect(asked.find((a) => a.path === '/act_1/insights' && a.q.get('level') === 'ad')!.q.get('fields')).toContain('quality_ranking');
  });

  it('shows no figures, not zero, when Meta has none for the range', async () => {
    await connect();
    vi.stubGlobal('fetch', vi.fn(async (input: any) => (String(input).includes('/insights') ? json(200, { data: [] }) : fake(input))));
    const r = await inCo(() => listMetaAds({ level: 'campaign', preset: 'today' }));
    expect(r.rows[0]).toMatchObject({ spend: null, results: null, costPerResult: null, reach: null });
  });

  it('one ad account failing does not hide the other', async () => {
    await connect([{ id: 'act_1', name: 'Amaya', currency: 'INR' }, { id: 'act_2', name: 'Blocked', currency: 'INR' }]);
    const r = await inCo(() => listMetaAds({ level: 'campaign' }));
    expect(r.rows.map((x) => x.id)).toEqual(['61', '62']);
    expect(r.errors).toEqual([{ account: 'Blocked', message: expect.stringContaining('No permission') }]);
  });

  it('says when Meta is not connected, without calling it', async () => {
    expect(await inCo(() => listMetaAds({ level: 'campaign' }))).toMatchObject({ connected: false, rows: [] });
    expect(asked).toEqual([]);
  });

  it('checks the level and the dates', async () => {
    await connect();
    await expect(inCo(() => listMetaAds({ level: 'creative' }))).rejects.toThrow(/Choose campaigns/);
    expect(dateParams({ since: '2026-10-01', until: '2026-10-31' })).toEqual({ time_range: JSON.stringify({ since: '2026-10-01', until: '2026-10-31' }) });
    expect(dateParams({})).toEqual({ date_preset: 'last_7d' });
    expect(() => dateParams({ since: '2026-10-31', until: '2026-10-01' })).toThrow(/start date/);
    expect(() => dateParams({ since: '2026-10-31' })).toThrow(/start date/);
    expect(() => dateParams({ preset: 'all&access_token=x' })).toThrow(/date range/);
  });

  it('knows what counts as a result', () => {
    expect(resultAction('OUTCOME_TRAFFIC', '')?.label).toBe('Link clicks');
    expect(resultAction('OUTCOME_LEADS', 'CONVERSATIONS')?.label).toBe('Messaging conversations');
    expect(resultAction('SOMETHING_NEW', '')).toBeNull();
  });
});

describe('who may read', () => {
  const as = async (name: string, role: 'Admin' | 'Manager' | 'RM' | 'Viewer') => {
    const email = name.toLowerCase() + '@ads.test';
    return inCo(async () => {
      await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
      const { token } = await login(email, 'long-enough-pw', base);
      return dispatch('listMetaAds', { level: 'campaign' }, { ...base, token });
    });
  };

  it('Admins, Managers and Viewers read; RMs do not see spend', async () => {
    expect((await as('Asha', 'Admin')).status).toBe(200);
    expect((await as('Meera', 'Manager')).status).toBe(200);
    expect((await as('Fiona', 'Viewer')).status).toBe(200);
    expect((await as('Ravi', 'RM')).status).toBe(403);
  });

  it('a company without the ads manager gets nothing', async () => {
    await t.company('test', { adsControl: false });
    expect((await as('Asha', 'Admin')).status).toBe(403);
  });
});

describe('comparing two periods', () => {
  const ranges = () => asked.filter((a) => a.path === '/act_1/insights').map((a) => a.q.get('time_range'));

  it('reads the earlier period once, for the same campaigns, without reading the campaigns again', async () => {
    await connect();
    const r = await inCo(() => listMetaAds({ level: 'campaign', since: '2026-11-01', until: '2026-11-06', compareSince: '2026-10-01', compareUntil: '2026-10-06' }));
    expect(ranges().sort()).toEqual([JSON.stringify({ since: '2026-10-01', until: '2026-10-06' }), JSON.stringify({ since: '2026-11-01', until: '2026-11-06' })]);
    expect(r.previous!.map((x) => x.id).sort()).toEqual(r.rows.map((x) => x.id).sort());
    expect(asked.filter((a) => a.path === '/act_1/campaigns' && !a.q.get('after'))).toHaveLength(1);
  });

  it('asks nothing extra when not comparing', async () => {
    await connect();
    const r = await inCo(() => listMetaAds({ level: 'campaign', preset: 'last_month' }));
    expect(r.previous).toBeUndefined();
    expect(ranges()).toHaveLength(1);
  });

  it('keeps the main figures if only the earlier period fails', async () => {
    await connect();
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const url = new URL(String(input));
      if ((url.searchParams.get('time_range') || '').includes('2026-10')) return json(400, { error: { message: 'Too far back', code: 100 } });
      return fake(input);
    }));
    const r = await inCo(() => listMetaAds({ level: 'campaign', since: '2026-11-01', until: '2026-11-06', compareSince: '2026-10-01', compareUntil: '2026-10-06' }));
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.previous).toEqual([]);
    expect(r.errors[0].message).toMatch(/earlier period could not be read/);
  });

  it('refuses dates the wrong way round', async () => {
    await connect();
    await expect(inCo(() => listMetaAds({ level: 'campaign', compareSince: '2026-10-09', compareUntil: '2026-10-01' }))).rejects.toThrow(/start date/);
    await expect(inCo(() => listMetaAds({ level: 'campaign', compareSince: '2026-10-09' }))).rejects.toThrow(/start date/);
  });

  it('knows the 90 day choice', () => {
    expect(dateParams({ preset: 'last_90d' })).toEqual({ date_preset: 'last_90d' });
  });
});
