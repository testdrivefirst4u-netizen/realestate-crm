/**
 * Post scheduler › Insights: reach, views and engagement of the connected Facebook Pages and Instagram accounts, overall
 * and per post. Needs read_insights and instagram_manage_insights on the connection.
 *
 * Accounts = Instagram GET <ig>/insights (metric_type total_value; reach per day for the chart); Facebook GET <page>/insights
 *            (period day, added up; the unique-viewer metric is read for the week / 28 days as a whole, because a person
 *            counted on two days is one person). Kept 15 minutes per company, account and range.
 * Posts    = GET <post>/insights when a post is opened; nothing stored.
 * Top posts = the reactions, comments and shares in `socialPosts`, as of the last sync.
 * Each metric is asked for on its own: Meta refuses a whole request for one retired or forbidden metric, and it has been
 * renaming these. A metric it refuses has no value (never a zero) and the screen says what Meta said.
 */
import type { ActionMap } from '../core/actions';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { socialPages, type SocialPage } from './socialAccounts';

const CACHE_MS = 15 * 60000;
const DAY_MS = 86400000;
const TOP_POSTS = 10;
const cache = new Map<string, { at: number; data: InsightsOverview }>();

type Format = 'number' | 'duration';
interface MetricDef { id: string; label: string; format?: Format }
export interface InsightValue { id: string; label: string; value: number | null; format: Format }
export interface InsightsAccount {
  key: string; kind: 'facebook' | 'instagram'; name: string; followers: number | null;
  metrics: InsightValue[]; chartLabel: string; daily: Array<{ day: string; value: number }>;
  /** What Meta said about the metrics it refused. */
  refused: string[];
}
export interface TopPost { id: string; text: string; imageUrl: string; url: string; kind: string; account: string; postType: string; at: string; likes: number | null; comments: number | null; shares: number | null }
export interface InsightsOverview { days: number; accounts: InsightsAccount[]; topPosts: TopPost[]; fetchedAt: string }

const INSTAGRAM_ACCOUNT: MetricDef[] = [
  { id: 'reach', label: 'Accounts reached' }, { id: 'views', label: 'Views' }, { id: 'accounts_engaged', label: 'Accounts engaged' }, { id: 'total_interactions', label: 'Interactions' },
  { id: 'likes', label: 'Likes' }, { id: 'comments', label: 'Comments' }, { id: 'shares', label: 'Shares' }, { id: 'saves', label: 'Saves' },
];
const FACEBOOK_SUMMED: MetricDef[] = [{ id: 'page_media_view', label: 'Views' }, { id: 'page_post_engagements', label: 'Post engagements' }];
const FACEBOOK_UNIQUE: MetricDef = { id: 'page_total_media_view_unique', label: 'People reached' };
const INSTAGRAM_POST: MetricDef[] = [{ id: 'views', label: 'Views' }, { id: 'reach', label: 'Accounts reached' }, { id: 'total_interactions', label: 'Interactions' }, { id: 'saved', label: 'Saves' }, { id: 'shares', label: 'Shares' }];
const INSTAGRAM_REEL: MetricDef = { id: 'ig_reels_avg_watch_time', label: 'Average watch time', format: 'duration' };
const FACEBOOK_POST: MetricDef[] = [{ id: 'post_media_view', label: 'Views' }, { id: 'post_total_media_view_unique', label: 'People reached' }, { id: 'post_clicks', label: 'Clicks' }];

const shown = (m: MetricDef, value: number | null): InsightValue => ({ id: m.id, label: m.label, value, format: m.format || 'number' });
const reason = (e: any) => truncate(String(e?.message || e), 240);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' && v !== undefined ? Number(v) : null);

/** A metric's total, whichever form Meta answers in. */
export function metricTotal(row: any): number | null {
  const whole = num(row?.total_value?.value);
  if (whole !== null) return whole;
  const list = (row?.values || []).map((x: any) => num(x?.value)).filter((x: number | null): x is number => x !== null);
  return list.length ? list.reduce((a: number, b: number) => a + b, 0) : null;
}
const lastValue = (row: any): number | null => {
  const list = row?.values || [];
  return list.length ? num(list[list.length - 1]?.value) : null;
};
const dailyOf = (row: any) => (row?.values || []).map((x: any) => ({ day: String(x?.end_time || '').slice(0, 10), value: num(x?.value) || 0 })).filter((x: { day: string }) => x.day);

async function instagramAccount(p: SocialPage, days: number, now: Date): Promise<InsightsAccount> {
  const since = Math.floor((now.getTime() - days * DAY_MS) / 1000);
  const until = Math.floor(now.getTime() / 1000);
  const refused = new Set<string>();
  const metrics = await Promise.all(INSTAGRAM_ACCOUNT.map(async (m) => {
    try {
      const j = await graph<{ data?: any[] }>(`${p.igId}/insights`, { token: p.token, params: { metric: m.id, period: 'day', metric_type: 'total_value', since, until } });
      return shown(m, metricTotal(j.data?.[0]));
    } catch (e) {
      refused.add(`${m.label}: ${reason(e)}`);
      return shown(m, null);
    }
  }));
  const [daily, followers] = await Promise.all([
    graph<{ data?: any[] }>(`${p.igId}/insights`, { token: p.token, params: { metric: 'reach', period: 'day', since, until } }).then((j) => dailyOf(j.data?.[0])).catch((e) => { refused.add(`Reach per day: ${reason(e)}`); return []; }),
    graph<{ followers_count?: number }>(String(p.igId), { token: p.token, params: { fields: 'followers_count' } }).then((j) => num(j.followers_count)).catch(() => null),
  ]);
  return { key: `instagram:${p.igId}`, kind: 'instagram', name: `@${p.igUsername || p.igId}`, followers, metrics, chartLabel: 'Accounts reached per day', daily, refused: [...refused] };
}

async function facebookAccount(p: SocialPage, days: number, now: Date): Promise<InsightsAccount> {
  const since = Math.floor((now.getTime() - days * DAY_MS) / 1000);
  const until = Math.floor(now.getTime() / 1000);
  const refused = new Set<string>();
  let daily: InsightsAccount['daily'] = [];
  const summed = await Promise.all(FACEBOOK_SUMMED.map(async (m) => {
    try {
      const j = await graph<{ data?: any[] }>(`${p.id}/insights`, { token: p.token, params: { metric: m.id, period: 'day', since, until } });
      if (m.id === 'page_media_view') daily = dailyOf(j.data?.[0]);
      return shown(m, metricTotal(j.data?.[0]));
    } catch (e) {
      refused.add(`${m.label}: ${reason(e)}`);
      return shown(m, null);
    }
  }));
  let unique: InsightValue;
  try {
    const j = await graph<{ data?: any[] }>(`${p.id}/insights`, { token: p.token, params: { metric: FACEBOOK_UNIQUE.id, period: days <= 7 ? 'week' : 'days_28', since, until } });
    unique = shown(FACEBOOK_UNIQUE, lastValue(j.data?.[0]));
  } catch (e) {
    refused.add(`${FACEBOOK_UNIQUE.label}: ${reason(e)}`);
    unique = shown(FACEBOOK_UNIQUE, null);
  }
  const followers = await graph<{ followers_count?: number }>(p.id, { token: p.token, params: { fields: 'followers_count' } }).then((j) => num(j.followers_count)).catch(() => null);
  return { key: `facebook:${p.id}`, kind: 'facebook', name: p.name, followers, metrics: [unique, ...summed], chartLabel: 'Views per day', daily, refused: [...refused] };
}

async function topPosts(cutoff: Date, account: string): Promise<TopPost[]> {
  const rows = await (await col<any>('socialPosts')).find({
    status: { $in: ['published', 'partial'] }, scheduledAt: { $gte: cutoff }, metrics: { $exists: true, $ne: null }, ...(account ? { 'targets.key': account } : {}),
  }, { projection: { text: 1, imageFileId: 1, imageExternal: 1, targets: 1, postType: 1, scheduledAt: 1, publishedAt: 1, metrics: 1 } }).limit(500).toArray();
  const score = (p: any) => (p.metrics?.likes || 0) + (p.metrics?.comments || 0) + (p.metrics?.shares || 0);
  return rows.sort((a, b) => score(b) - score(a)).slice(0, TOP_POSTS).map((p) => ({
    id: String(p._id), text: truncate(p.text || '', 160), imageUrl: p.imageFileId ? `/api/files/${p.imageFileId}` : p.imageExternal || '', url: p.targets?.[0]?.url || '', kind: p.targets?.[0]?.kind || '', account: p.targets?.[0]?.name || '',
    postType: p.postType || 'post', at: new Date(p.publishedAt || p.scheduledAt).toISOString(), likes: p.metrics?.likes ?? null, comments: p.metrics?.comments ?? null, shares: p.metrics?.shares ?? null,
  }));
}

export async function getSocialInsights(d: any = {}, now = new Date()): Promise<InsightsOverview> {
  const days = Number(d?.days) === 7 ? 7 : 28;
  const account = String(d?.account || '');
  const key = `${currentTenant()?.id || ''}:${days}:${account}`;
  const hit = cache.get(key);
  if (!d?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const pages = await socialPages();
  const jobs: Array<Promise<InsightsAccount>> = [];
  for (const p of pages) {
    if (!account || account === `facebook:${p.id}`) jobs.push(facebookAccount(p, days, now));
    if (p.igId && (!account || account === `instagram:${p.igId}`)) jobs.push(instagramAccount(p, days, now));
  }
  const data: InsightsOverview = { days, accounts: await Promise.all(jobs), topPosts: await topPosts(new Date(now.getTime() - days * DAY_MS), account), fetchedAt: now.toISOString() };
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function clearInsightsCache() {
  cache.clear();
}

/** The figures of one published post, per account it went to. */
export async function getPostInsights(d: any): Promise<{ targets: Array<{ key: string; kind: string; name: string; metrics: InsightValue[]; refused: string[] }> }> {
  const post = await (await col<any>('socialPosts')).findOne({ _id: String(d?.id || '') });
  if (!post) throw fail('NOT_FOUND', 'Post not found');
  const pages = await socialPages();
  const targets = (post.targets || []).filter((t: any) => t.status === 'posted' && t.postId && (t.kind === 'facebook' || t.kind === 'instagram'));
  return {
    targets: await Promise.all(targets.map(async (t: any) => {
      const id = String(t.key).slice(t.kind.length + 1);
      const page = pages.find((p) => (t.kind === 'facebook' ? p.id === id : p.igId === id));
      const refused: string[] = [];
      if (!page) return { key: t.key, kind: t.kind, name: t.name, metrics: [], refused: ['This account is no longer connected.'] };
      const list = t.kind === 'facebook' ? FACEBOOK_POST : post.postType === 'reel' ? [...INSTAGRAM_POST, INSTAGRAM_REEL] : INSTAGRAM_POST;
      const metrics = await Promise.all(list.map(async (m) => {
        try {
          const j = await graph<{ data?: any[] }>(`${t.postId}/insights`, { token: page.token, params: { metric: m.id, ...(t.kind === 'facebook' ? { period: 'lifetime' } : {}) } });
          return shown(m, metricTotal(j.data?.[0]));
        } catch (e) {
          refused.push(`${m.label}: ${reason(e)}`);
          return shown(m, null);
        }
      }));
      return { key: t.key, kind: t.kind, name: t.name, metrics, refused };
    })),
  };
}

export const actions: ActionMap = {
  getSocialInsights: { fn: (d) => getSocialInsights(d), perm: 'marketing.manage' },
  getPostInsights: { fn: (d) => getPostInsights(d), perm: 'marketing.manage' },
};
