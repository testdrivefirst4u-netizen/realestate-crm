/** Post scheduler › Insights: each metric on its own, a refusal is no figure (never zero), unique people are not added up. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { SOCIAL_SCOPES } from '../server/modules/socialAccounts';
import { clearInsightsCache, getPostInsights, getSocialInsights, metricTotal } from '../server/modules/socialInsights';

let t: Awaited<ReturnType<typeof startTestDb>>;
let asked: Array<{ path: string; q: URLSearchParams }> = [];
let refuse: RegExp | null = null;
const now = new Date('2026-11-04T10:00:00Z');
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const value = (m: Array<{ id: string; value: number | null }>, id: string) => m.find((x) => x.id === id)?.value;

async function fake(input: any): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  const metric = url.searchParams.get('metric') || '';
  asked.push({ path, q: url.searchParams });
  if (refuse?.test(metric)) return json(400, { error: { message: `(#100) ${metric} is not valid`, code: 100 } });
  if (path === '/IG1') return json(200, { followers_count: 900 });
  if (path === '/PAGE1') return json(200, { followers_count: 500 });
  if (path === '/IG1/insights') {
    if (url.searchParams.get('metric_type') === 'total_value') return json(200, { data: [{ name: metric, total_value: { value: metric === 'reach' ? 700 : 40 } }] });
    return json(200, { data: [{ name: 'reach', values: [{ value: 30, end_time: '2026-11-02T07:00:00+0000' }, { value: 50, end_time: '2026-11-03T07:00:00+0000' }] }] });
  }
  if (path === '/PAGE1/insights') {
    if (metric === 'page_total_media_view_unique') return json(200, { data: [{ name: metric, values: [{ value: 100, end_time: '2026-11-02' }, { value: 120, end_time: '2026-11-03' }] }] });
    return json(200, { data: [{ name: metric, values: [{ value: 10, end_time: '2026-11-02T07:00:00+0000' }, { value: 15, end_time: '2026-11-03T07:00:00+0000' }] }] });
  }
  if (/^\/(M1|PAGE1_1)\/insights$/.test(path)) return json(200, { data: [{ name: metric, values: [{ value: metric === 'ig_reels_avg_watch_time' ? 5400 : 77 }] }] });
  return json(404, { error: { message: `unexpected ${path}` } });
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
  await t.company('test', { socialPosts: true });
  clearInsightsCache();
  asked = [];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [{ id: 'PAGE1', name: 'Amaya', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' }] });
    await (await col<any>('socialPosts')).insertMany([
      { _id: 'A', text: 'Quiet', status: 'published', scheduledAt: new Date('2026-10-20T00:00:00Z'), metrics: { likes: 1, comments: 0, shares: 0 }, targets: [{ key: 'facebook:PAGE1', kind: 'facebook', name: 'Amaya', status: 'posted', postId: 'PAGE1_1' }] },
      { _id: 'B', text: 'Popular', status: 'published', postType: 'reel', scheduledAt: new Date('2026-10-25T00:00:00Z'), metrics: { likes: 50, comments: 5, shares: null }, targets: [{ key: 'instagram:IG1', kind: 'instagram', name: '@amaya', status: 'posted', postId: 'M1' }] },
      { _id: 'OLD', text: 'Long ago', status: 'published', scheduledAt: new Date('2026-01-01T00:00:00Z'), metrics: { likes: 999, comments: 0, shares: 0 }, targets: [{ key: 'facebook:PAGE1', kind: 'facebook', name: 'Amaya', status: 'posted', postId: 'X' }] },
    ]);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('accounts', () => {
  it('reads each account: totals, followers, a daily chart', async () => {
    const r = await inCo(() => getSocialInsights({ days: 28 }, now));
    const ig = r.accounts.find((a) => a.kind === 'instagram')!;
    expect(ig).toMatchObject({ key: 'instagram:IG1', name: '@amaya', followers: 900, refused: [] });
    expect(value(ig.metrics, 'reach')).toBe(700);
    expect(ig.daily).toEqual([{ day: '2026-11-02', value: 30 }, { day: '2026-11-03', value: 50 }]);
    const fb = r.accounts.find((a) => a.kind === 'facebook')!;
    expect(fb.followers).toBe(500);
    expect(value(fb.metrics, 'page_media_view')).toBe(25); // views add up
    expect(fb.daily.map((d) => d.value)).toEqual([10, 15]);
  });

  it('never adds up unique people across days, and asks for the whole period', async () => {
    const r = await inCo(() => getSocialInsights({ days: 7 }, now));
    expect(value(r.accounts.find((a) => a.kind === 'facebook')!.metrics, 'page_total_media_view_unique')).toBe(120);
    expect(asked.find((a) => a.q.get('metric') === 'page_total_media_view_unique')!.q.get('period')).toBe('week');
    clearInsightsCache();
    asked = [];
    await inCo(() => getSocialInsights({ days: 28 }, now));
    expect(asked.find((a) => a.q.get('metric') === 'page_total_media_view_unique')!.q.get('period')).toBe('days_28');
  });

  it('a metric Meta refuses has no figure, not zero, says why, and does not lose the others', async () => {
    refuse = /^views$|page_post_engagements/;
    const r = await inCo(() => getSocialInsights({ days: 28 }, now));
    const ig = r.accounts.find((a) => a.kind === 'instagram')!;
    expect(value(ig.metrics, 'views')).toBeNull();
    expect(value(ig.metrics, 'reach')).toBe(700);
    expect(ig.refused.join(' ')).toContain('Views:');
    expect(ig.refused.join(' ')).toContain('not valid');
    const fb = r.accounts.find((a) => a.kind === 'facebook')!;
    expect(value(fb.metrics, 'page_post_engagements')).toBeNull();
    expect(value(fb.metrics, 'page_media_view')).toBe(25);
  });

  it('asks for one metric at a time, one account when chosen, and keeps answers 15 minutes', async () => {
    await inCo(() => getSocialInsights({ days: 28, account: 'instagram:IG1' }, now));
    expect(asked.every((a) => !a.path.startsWith('/PAGE1'))).toBe(true);
    expect(asked.filter((a) => a.q.get('metric')).every((a) => !a.q.get('metric')!.includes(','))).toBe(true);
    const n = asked.length;
    await inCo(() => getSocialInsights({ days: 28, account: 'instagram:IG1' }, now));
    expect(asked.length).toBe(n);
    await inCo(() => getSocialInsights({ days: 28, account: 'instagram:IG1', refresh: true }, now));
    expect(asked.length).toBe(2 * n);
  });

  it('asks Meta for the insights permissions on connect', () => {
    expect(SOCIAL_SCOPES).toContain('read_insights');
    expect(SOCIAL_SCOPES).toContain('instagram_manage_insights');
  });
});

describe('top posts', () => {
  it('ranks by reactions, comments and shares within the period, and by account', async () => {
    const r = await inCo(() => getSocialInsights({ days: 28 }, now));
    expect(r.topPosts.map((p) => p.id)).toEqual(['B', 'A']); // not the older post
    expect(r.topPosts[0]).toMatchObject({ text: 'Popular', likes: 50, comments: 5, shares: null, postType: 'reel', account: '@amaya' });
    clearInsightsCache();
    const fb = await inCo(() => getSocialInsights({ days: 28, account: 'facebook:PAGE1' }, now));
    expect(fb.topPosts.map((p) => p.id)).toEqual(['A']);
  });
});

describe('one post', () => {
  it('reads each account it went to; a reel adds its watch time', async () => {
    const reel = await inCo(() => getPostInsights({ id: 'B' }));
    expect(value(reel.targets[0].metrics, 'views')).toBe(77);
    expect(value(reel.targets[0].metrics, 'ig_reels_avg_watch_time')).toBe(5400);
    const fb = await inCo(() => getPostInsights({ id: 'A' }));
    expect(value(fb.targets[0].metrics, 'post_media_view')).toBe(77);
    expect(asked.find((a) => a.path === '/PAGE1_1/insights')!.q.get('period')).toBe('lifetime');
    await expect(inCo(() => getPostInsights({ id: 'missing' }))).rejects.toThrow(/not found/);
  });

  it('a refused metric is no figure, with the reason', async () => {
    refuse = /saved/;
    const r = await inCo(() => getPostInsights({ id: 'B' }));
    expect(value(r.targets[0].metrics, 'saved')).toBeNull();
    expect(r.targets[0].refused[0]).toContain('Saves:');
  });

  it('understands both answer forms', () => {
    expect(metricTotal({ total_value: { value: 5 } })).toBe(5);
    expect(metricTotal({ values: [{ value: 2 }, { value: 3 }] })).toBe(5);
    expect(metricTotal({ total_value: { value: 0 } })).toBe(0);
    expect(metricTotal({})).toBeNull();
  });
});
