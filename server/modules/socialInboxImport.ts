/**
 * Social inbox › old items: copies past comments and direct messages of the connected Pages and Instagram accounts into
 * `socialInbox`, under the same ids and threads as the webhooks (modules/socialInbox.ts), so nothing is stored twice and
 * an old conversation continues when the person writes again.
 *
 * Messages = GET <page>/conversations?platform=messenger|instagram. Meta gives the details of only the 20 most recent
 *            messages of a conversation.
 * Comments = GET <post>/comments with one level of replies, for the posts in `socialPosts` (Sync old posts).
 * "Sync old messages" = everything, marked read, no notification; it stops at a time limit and a next click goes on
 * with the posts not done yet. Daily cron = the last 7 days, to catch anything a webhook missed: new finds are unread,
 * also without a notification.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { listActiveTenants } from '../platform/registry';
import { socialPages, type SocialPage } from './socialAccounts';
import { inboxCol, UNSUPPORTED_MESSAGE, type InboxItem } from './socialInbox';
import { importOldPosts } from './socialPostsImport';

const DAY_MS = 86400000;
const CONVERSATION_PAGES = 20;
const COMMENT_PAGES = 3;
const MAX_POSTS = 2000;
/** Older posts are not read again by a later sync: their comments rarely change. */
const REREAD_POST_DAYS = 30;
const ALL_DAYS = 20 * 365;
const MANUAL_BUDGET_MS = 240000;
const CRON_BUDGET_MS = 45000;

type Item = Omit<InboxItem, 'read'>;
export interface InboxImportResult { added: number; conversations: number; posts: number; partial: boolean; errors: Array<{ account: string; message: string }> }

async function pages<T = any>(path: string, token: string, params: Record<string, string | number>, max: number, stop: (rows: T[]) => boolean = () => false): Promise<T[]> {
  const out: T[] = [];
  let after = '';
  for (let i = 0; i < max; i++) {
    const j = await graph<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, { token, params: { ...params, ...(after ? { after } : {}) } });
    const rows = j.data || [];
    out.push(...rows);
    after = j.paging?.next ? String(j.paging?.cursors?.after || '') : '';
    if (!after || stop(rows)) break;
  }
  return out;
}
const dateOf = (v: unknown) => {
  const d = new Date(String(v || ''));
  return Number.isNaN(d.getTime()) ? null : d;
};

/* -------------------------------- messages -------------------------------- */

const messageFields = (rich: boolean) => `id,updated_time,messages.limit(20){id,message,created_time,from,to,attachments${rich ? ',shares{link,name},story,is_unsupported' : ''}}`;

/** What a message without text was, so a conversation is never just "no text". */
export function messageText(m: any): string {
  if (m?.message) return String(m.message);
  if (m?.story) return m.story.mention ? '[Mentioned you in a story]' : '[Replied to a story]';
  const share = m?.shares?.data?.[0];
  if (share) return `[Shared a post]${share.link ? ' ' + share.link : ''}`;
  if (m?.attachments?.data?.length) return '[Attachment]';
  return UNSUPPORTED_MESSAGE;
}
const personName = (p: any) => String(p?.name || (p?.username ? `@${p.username}` : ''));

/** One conversation's messages as inbox items; the other person is whoever is not the account. */
export function conversationItems(conv: any, platform: 'facebook' | 'instagram', account: string, accountName: string, cutoff: Date): Item[] {
  const ig = platform === 'instagram';
  const out: Item[] = [];
  for (const m of conv?.messages?.data || []) {
    const at = dateOf(m?.created_time);
    const fromId = String(m?.from?.id || '');
    if (!m?.id || !at || !fromId || at.getTime() < cutoff.getTime()) continue;
    const mine = fromId === account;
    const person = mine ? String(m?.to?.data?.[0]?.id || '') : fromId;
    if (!person) continue;
    const other = mine ? m?.to?.data?.[0] : m?.from;
    out.push({
      _id: `${platform}:${m.id}`, platform, kind: 'message', thread: `${ig ? 'ig' : 'fb'}:dm:${account}:${person}`, account, externalId: String(m.id),
      authorId: mine ? '' : person, authorName: truncate(mine ? accountName : personName(m?.from), 120), partnerName: truncate(personName(other), 120), text: truncate(messageText(m), 4000), at, direction: mine ? 'out' : 'in',
    });
  }
  return out;
}

async function readConversations(p: SocialPage, platform: 'messenger' | 'instagram', cutoff: Date): Promise<Item[]> {
  const read = (rich: boolean) => pages<any>(`${p.id}/conversations`, p.token, { platform, fields: messageFields(rich), limit: 25 }, CONVERSATION_PAGES,
    // the newest conversations come first: stop once a whole page is older than the cutoff
    (rows) => rows.length > 0 && rows.every((c) => (dateOf(c.updated_time)?.getTime() || 0) < cutoff.getTime()));
  const convs = await read(true).catch(() => read(false));
  const items = convs.flatMap((c) => (platform === 'instagram'
    ? conversationItems(c, 'instagram', String(p.igId), `@${p.igUsername || p.igId}`, cutoff)
    : conversationItems(c, 'facebook', p.id, p.name, cutoff)));
  return items;
}

/* -------------------------------- comments -------------------------------- */

function facebookComment(c: any, postId: string, root: string, p: SocialPage): Item | null {
  const at = dateOf(c?.created_time);
  if (!c?.id || !at) return null;
  const mine = String(c?.from?.id || '') === p.id;
  return {
    _id: `facebook:${c.id}`, platform: 'facebook', kind: 'comment', thread: `fb:c:${root}`, account: p.id, externalId: String(c.id), parent: postId,
    authorId: String(c?.from?.id || ''), authorName: truncate(String(c?.from?.name || (mine ? p.name : '')), 120), text: truncate(String(c?.message || ''), 4000), at, direction: mine ? 'out' : 'in',
  };
}

function instagramComment(c: any, postId: string, root: string, p: SocialPage): Item | null {
  const at = dateOf(c?.timestamp);
  if (!c?.id || !at) return null;
  const mine = !!p.igUsername && c?.username === p.igUsername;
  return {
    _id: `instagram:${c.id}`, platform: 'instagram', kind: 'comment', thread: `ig:c:${root}`, account: String(p.igId), externalId: String(c.id), parent: postId,
    authorId: '', authorName: c?.username ? `@${c.username}` : '', text: truncate(String(c?.text || ''), 4000), at, direction: mine ? 'out' : 'in',
  };
}

async function readComments(kind: 'facebook' | 'instagram', postId: string, p: SocialPage): Promise<Item[]> {
  const out: Array<Item | null> = [];
  if (kind === 'facebook') {
    const fields = 'id,from{id,name},message,created_time,comments.limit(50){id,from{id,name},message,created_time}';
    for (const c of await pages<any>(`${postId}/comments`, p.token, { fields, filter: 'toplevel', limit: 100 }, COMMENT_PAGES)) {
      out.push(facebookComment(c, postId, String(c.id), p));
      for (const r of c?.comments?.data || []) out.push(facebookComment(r, postId, String(c.id), p));
    }
  } else {
    const fields = 'id,text,username,timestamp,replies{id,text,username,timestamp}';
    for (const c of await pages<any>(`${postId}/comments`, p.token, { fields, limit: 50 }, COMMENT_PAGES)) {
      out.push(instagramComment(c, postId, String(c.id), p));
      for (const r of c?.replies?.data || []) out.push(instagramComment(r, postId, String(c.id), p));
    }
  }
  return out.filter((x): x is Item => !!x);
}

/* ---------------------------------- import --------------------------------- */

/** New items only: one already here (a webhook, a reply from the CRM) is left as it is, except for what it lacks. */
async function storeItems(items: Item[], unread: boolean): Promise<number> {
  if (!items.length) return 0;
  const r = await (await inboxCol()).bulkWrite(items.map((i) => ({
    updateOne: { filter: { _id: i._id }, update: { $setOnInsert: { ...i, read: !(unread && i.direction === 'in') } }, upsert: true },
  })), { ordered: false });
  const fill = (field: 'text' | 'authorName' | 'partnerName', i: Item) => (i[field] ? [{ updateOne: { filter: { _id: i._id, $or: [{ [field]: '' }, { [field]: { $exists: false } }] }, update: { $set: { [field]: i[field] } } } }] : []);
  await (await inboxCol()).bulkWrite(items.flatMap((i) => [...fill('text', i), ...fill('authorName', i), ...fill('partnerName', i)]) as any, { ordered: false });
  return r.upsertedCount;
}

export async function importOldInbox(opts: { days?: number; now?: Date; markNew?: boolean; budgetMs?: number } = {}): Promise<InboxImportResult> {
  const now = opts.now || new Date();
  const days = opts.days ?? ALL_DAYS;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const deadline = Date.now() + (opts.budgetMs ?? MANUAL_BUDGET_MS);
  const res: InboxImportResult = { added: 0, conversations: 0, posts: 0, partial: false, errors: [] };
  const failed = (account: string, e: any) => {
    const message = truncate(e?.message || String(e), 300);
    if (!res.errors.some((x) => x.account === account && x.message === message)) res.errors.push({ account, message });
  };
  const accounts = await socialPages();

  // messages first: they matter most, and a time limit should cut comments of old posts rather than conversations
  for (const p of accounts) {
    for (const platform of ['messenger', ...(p.igId ? ['instagram'] : [])] as Array<'messenger' | 'instagram'>) {
      const account = platform === 'instagram' ? `@${p.igUsername || p.igId}` : p.name;
      try {
        const items = await readConversations(p, platform, cutoff);
        res.conversations += new Set(items.map((i) => i.thread)).size;
        res.added += await storeItems(items, !!opts.markNew);
      } catch (e) {
        failed(account, e);
      }
    }
  }

  const posts = await col<any>('socialPosts');
  const rereadFrom = new Date(now.getTime() - REREAD_POST_DAYS * DAY_MS);
  const due = await posts.find({
    status: { $in: ['published', 'partial'] },
    scheduledAt: { $gte: cutoff },
    'metrics.comments': { $ne: 0 },
    $or: [{ inboxSyncedAt: { $exists: false } }, { scheduledAt: { $gte: rereadFrom } }],
  }, { projection: { targets: 1 } }).sort({ scheduledAt: -1 }).limit(MAX_POSTS).toArray();
  for (const post of due) {
    if (Date.now() > deadline) { res.partial = true; break; }
    let done = true;
    for (const t of post.targets || []) {
      if (t.status !== 'posted' || !t.postId || (t.kind !== 'facebook' && t.kind !== 'instagram')) continue;
      const id = String(t.key).slice(t.kind.length + 1);
      const p = accounts.find((a) => (t.kind === 'facebook' ? a.id === id : a.igId === id));
      if (!p) continue;
      try {
        res.added += await storeItems(await readComments(t.kind, t.postId, p), !!opts.markNew);
      } catch (e) {
        done = false;
        failed(t.name, e);
      }
    }
    res.posts += 1;
    if (done) await posts.updateOne({ _id: post._id }, { $set: { inboxSyncedAt: now } });
  }
  return res;
}

export async function syncOldInbox(_d: any, ctx: Ctx): Promise<InboxImportResult & { postsImported: number }> {
  if (!(await socialPages()).length) throw fail('VALIDATION', 'Connect a Facebook Page first (Settings › Social accounts).');
  // comments hang under posts: bring the posts first
  const posts = await importOldPosts({ days: ALL_DAYS });
  const r = await importOldInbox();
  const errors = [...r.errors];
  for (const e of posts.errors) if (!errors.some((x) => x.account === e.account && x.message === e.message)) errors.push(e);
  await auditLog(ctx, 'Old Messages Synced', 'Inbox', 'import', `${r.added} new · ${r.conversations} conversations · ${r.posts} posts${r.partial ? ' · stopped at the time limit' : ''}${errors.length ? ` · ${errors.length} failed` : ''}`);
  return { ...r, errors, postsImported: posts.imported };
}

/** Daily: the last 7 days of every company with the inbox, in case a webhook did not arrive. */
export async function runInboxImportCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.socialInbox) continue;
    try {
      const r = await runWithTenant(tenant, () => importOldInbox({ days: 7, now, markNew: true, budgetMs: CRON_BUDGET_MS }));
      if (r.added || r.errors.length) out[tenant.slug] = r;
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

export const actions: ActionMap = {
  syncOldInbox: { fn: (d, ctx) => syncOldInbox(d, ctx), perm: 'marketing.manage' },
};
