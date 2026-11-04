/**
 * Post scheduler › old posts: copies what the connected Facebook Pages and Instagram accounts already published into
 * `socialPosts`, so the planner shows them next to the posts made in the CRM.
 *
 * Facebook  = GET <page>/published_posts; Instagram = GET <ig>/media, with likes, comments and shares. All the history
 *             (up to 2000 posts an account) from "Sync old posts", the last 30 days every morning (the platforms'
 *             picture links expire, so recent posts get fresh ones). Views need other permissions and are not read.
 * Imported posts have status 'published' and are read only: they are changed or removed on the platform. A post made
 * in the CRM is recognised by its platform id and not copied, but gets the same counts when it went to one account.
 * A post deleted on the platform stays here. When Meta refuses some counts the posts still come, with a warning.
 * "likes" on Facebook is reactions: the number Facebook itself shows.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { listActiveTenants } from '../platform/registry';
import { socialPages } from './socialAccounts';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const ALL_HISTORY_DAYS = 20 * 365;
const DAY_MS = 86400000;
const postsCol = () => col<any>('socialPosts');

interface Metrics { likes: number | null; comments: number | null; shares: number | null }
interface Found { kind: 'facebook' | 'instagram'; accountId: string; accountName: string; postId: string; text: string; url: string; image: string; at: Date; metrics: Metrics }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const https = (v: unknown) => (/^https:\/\//.test(String(v || '')) ? String(v) : '');

/** Pages of a list, newest first, until the posts are older than the cutoff. */
async function newestPosts(path: string, token: string, fields: string, dateOf: (x: any) => Date, cutoff: Date): Promise<any[]> {
  const out: any[] = [];
  let after = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await graph<{ data?: any[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, { token, params: { fields, limit: PAGE_SIZE, ...(after ? { after } : {}) } });
    const rows = j.data || [];
    const fresh = rows.filter((x) => dateOf(x).getTime() >= cutoff.getTime());
    out.push(...fresh);
    after = j.paging?.next ? String(j.paging?.cursors?.after || '') : '';
    if (!after || fresh.length < rows.length) break;
  }
  return out;
}

/** The most the account lets us read: each try asks for less, and what Meta said first is kept as a warning. */
async function readWithCounts(tries: string[], read: (fields: string) => Promise<any[]>, account: string, warnings: string[]): Promise<any[]> {
  let said = '';
  for (let i = 0; i < tries.length - 1; i++) {
    try {
      const rows = await read(tries[i]);
      if (said) warnings.push(`${account}: some counts are missing. Meta said: ${said}`);
      return rows;
    } catch (e: any) {
      said = said || truncate(e?.message || String(e), 200);
    }
  }
  const rows = await read(tries[tries.length - 1]);
  if (said) warnings.push(`${account}: counts are missing. Meta said: ${said}`);
  return rows;
}

async function facebookPosts(p: { id: string; name: string; token: string }, cutoff: Date, warnings: string[]): Promise<Found[]> {
  const base = 'id,message,created_time,permalink_url,full_picture';
  const read = (fields: string) => newestPosts(`${p.id}/published_posts`, p.token, fields, (x) => new Date(x.created_time), cutoff);
  // the posts matter more than their counts: without the counts' permission they still come through
  const reactions = 'reactions.summary(true).limit(0)';
  const rows = await readWithCounts([`${base},shares,${reactions},comments.summary(true).limit(0)`, `${base},shares,${reactions}`, base], read, p.name, warnings);
  return rows.map((x) => ({ kind: 'facebook', accountId: p.id, accountName: p.name, postId: String(x.id), text: String(x.message || ''), url: https(x.permalink_url), image: https(x.full_picture), at: new Date(x.created_time), metrics: { likes: num(x.reactions?.summary?.total_count), comments: num(x.comments?.summary?.total_count), shares: num(x.shares?.count) ?? (x.reactions ? 0 : null) } }));
}

async function instagramPosts(p: { igId?: string; igUsername?: string; token: string }, cutoff: Date, warnings: string[]): Promise<Found[]> {
  const base = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const read = (fields: string) => newestPosts(`${p.igId}/media`, p.token, fields, (x) => new Date(x.timestamp), cutoff);
  const rows = await readWithCounts([`${base},like_count,comments_count`, base], read, `@${p.igUsername || p.igId}`, warnings);
  return rows.map((x) => ({
    kind: 'instagram', accountId: String(p.igId), accountName: `@${p.igUsername || p.igId}`, postId: String(x.id), text: String(x.caption || ''), url: https(x.permalink),
    image: https(x.media_type === 'VIDEO' ? x.thumbnail_url : x.media_url), at: new Date(x.timestamp), metrics: { likes: num(x.like_count), comments: num(x.comments_count), shares: null },
  }));
}

export async function importOldPosts(opts: { days?: number; now?: Date } = {}): Promise<{ imported: number; updated: number; skipped: number; errors: Array<{ account: string; message: string }>; warnings: string[] }> {
  const now = opts.now || new Date();
  const cutoff = new Date(now.getTime() - (opts.days ?? 365) * DAY_MS);
  const errors: Array<{ account: string; message: string }> = [];
  const found: Found[] = [];
  const warnings: string[] = [];
  const collect = async (account: string, read: () => Promise<Found[]>) => {
    try {
      found.push(...await read());
    } catch (e: any) {
      errors.push({ account, message: truncate(e?.message || String(e), 300) });
    }
  };
  for (const p of await socialPages()) {
    await collect(p.name, () => facebookPosts(p, cutoff, warnings));
    if (p.igId) await collect(`@${p.igUsername || p.igId}`, () => instagramPosts(p, cutoff, warnings));
  }
  const c = await postsCol();
  const made = new Set((await c.distinct('targets.postId', { imported: { $ne: true } })).map(String));
  // posts made in the CRM are not copied, but show the counts too (one account only: the counts would differ between accounts)
  const counted = found.filter((f) => made.has(f.postId));
  if (counted.length) await c.bulkWrite(counted.map((f) => ({ updateOne: { filter: { imported: { $ne: true }, targets: { $size: 1 }, 'targets.postId': f.postId }, update: { $set: { metrics: f.metrics } } } })));
  const fresh = found.filter((f) => !made.has(f.postId) && !Number.isNaN(f.at.getTime()));
  if (!fresh.length) return { imported: 0, updated: 0, skipped: found.length, errors, warnings };
  const r = await c.bulkWrite(fresh.map((f) => ({
    updateOne: {
      filter: { _id: `IMP-${f.kind}-${f.postId}` },
      update: {
        $set: {
          text: truncate(f.text, 3000), link: '', imageFileId: '', imageExternal: f.image, imported: true, metrics: f.metrics, scheduledAt: f.at, publishedAt: f.at, status: 'published', updatedAt: now,
          targets: [{ key: `${f.kind}:${f.accountId}`, kind: f.kind, name: f.accountName, status: 'posted', postId: f.postId, url: f.url, error: '' }],
          createdBy: `Imported from ${f.kind === 'facebook' ? 'Facebook' : 'Instagram'}`,
        },
        $setOnInsert: { createdAt: now },
      },
      upsert: true,
    },
  })));
  return { imported: r.upsertedCount, updated: r.modifiedCount, skipped: found.length - fresh.length, errors, warnings };
}

export async function syncOldPosts(_d: any, ctx: Ctx) {
  if (!(await socialPages()).length) throw fail('VALIDATION', 'Connect a Facebook Page first (Settings › Social accounts).');
  const r = await importOldPosts({ days: ALL_HISTORY_DAYS });
  await auditLog(ctx, 'Old Posts Synced', 'Post', 'import', `${r.imported} new · ${r.updated} updated${r.errors.length ? ` · ${r.errors.length} account(s) failed` : ''}`);
  return r;
}

/** Daily cron: recent posts of every company with the post scheduler. */
export async function runImportPostsCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.socialPosts) continue;
    try {
      const r = await runWithTenant(tenant, () => importOldPosts({ days: 30, now }));
      if (r.imported || r.errors.length) out[tenant.slug] = r;
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

export interface PostComment { id: string; author: string; text: string; at: string }

/** The comments of a published post, read when it is opened (nothing stored). Replies are written in the Social Inbox. */
export async function getPostComments(d: any): Promise<{ comments: PostComment[] }> {
  const post = await (await postsCol()).findOne({ _id: String(d?.id || '') });
  const t = (post?.targets || []).find((x: any) => x.status === 'posted' && x.postId && (x.kind === 'facebook' || x.kind === 'instagram'));
  if (!t) return { comments: [] };
  const account = t.key.slice(t.kind.length + 1);
  const page = (await socialPages()).find((p) => (t.kind === 'facebook' ? p.id === account : p.igId === account));
  if (!page) throw fail('VALIDATION', 'This account is no longer connected.');
  if (t.kind === 'facebook') {
    const j = await graph<{ data?: any[] }>(`${t.postId}/comments`, { token: page.token, params: { fields: 'id,from{name},message,created_time', order: 'reverse_chronological', limit: 50 } });
    return { comments: (j.data || []).map((c) => ({ id: String(c.id), author: String(c.from?.name || 'Facebook user'), text: String(c.message || ''), at: String(c.created_time || '') })) };
  }
  const j = await graph<{ data?: any[] }>(`${t.postId}/comments`, { token: page.token, params: { fields: 'id,username,text,timestamp', limit: 50 } });
  return { comments: (j.data || []).map((c) => ({ id: String(c.id), author: String(c.username || 'Instagram user'), text: String(c.text || ''), at: String(c.timestamp || '') })) };
}

export const actions: ActionMap = {
  getPostComments: { fn: (d) => getPostComments(d), perm: 'marketing.manage' },
  syncOldPosts: { fn: (d, ctx) => syncOldPosts(d, ctx), perm: 'marketing.manage' },
};
