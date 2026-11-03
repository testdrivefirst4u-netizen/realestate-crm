/**
 * Social inbox (plan feature socialInbox, screen /inbox): Facebook Page comments and Messenger messages, Instagram
 * comments and DMs (Meta webhooks, same URL as lead ads) and Google Business Profile reviews (polled), answered from
 * the CRM; a conversation can become a lead.
 *
 * Items   = company collection `socialInbox` { _id: '<platform>:<external id>' (a re-delivered webhook is a no-op),
 *           platform 'facebook' | 'instagram' | 'google', kind 'comment' | 'message' | 'review', thread, account,
 *           authorId, authorName, text, rating, direction 'in' | 'out', at, read, leadId }.
 * Threads = a direct conversation per person and account; a comment with its replies; a review with its reply.
 * Replies = Messenger / Instagram: POST /{page}/messages (inside Meta's 24-hour window); comments:
 *           /{comment}/comments (Facebook) or /{comment}/replies (Instagram); reviews: PUT …/reviews/{id}/reply.
 * Alerts  = a phone notification to Admins and Managers for each new message, comment or review (3 stars or less
 *           say so in the title).
 */
import type { ActionMap } from '../core/actions';
import { listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { getTenantById, listActiveTenants } from '../platform/registry';
import { gbpFetch, gbpLocationPath } from './googleMarketing';
import { addLead } from './leads';
import { sendPush } from './push';
import { companyOfSocial, pageFor, refreshSocialSubscriptions } from './socialAccounts';

export type InboxPlatform = 'facebook' | 'instagram' | 'google';
export type InboxKind = 'comment' | 'message' | 'review';

export interface InboxItem {
  _id: string;
  platform: InboxPlatform;
  kind: InboxKind;
  thread: string;
  /** Page id, Instagram account id or Business Profile location path. */
  account: string;
  /** The comment / review / message id on the platform (replies go to it). */
  externalId: string;
  /** Post / media the comment is on. */
  parent?: string;
  authorId: string;
  authorName: string;
  text: string;
  rating?: number;
  direction: 'in' | 'out';
  at: Date;
  read: boolean;
  leadId?: string;
  by?: string;
}

export const inboxCol = () => col<InboxItem>('socialInbox');
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Store one incoming item (no-op when it was stored before); alerts on new ones. */
async function store(item: Omit<InboxItem, 'read' | 'direction'> & { direction?: 'in' | 'out' }): Promise<boolean> {
  const doc: InboxItem = { direction: 'in', read: false, ...item, text: truncate(item.text || '', 4000), authorName: truncate(item.authorName || '', 120) } as InboxItem;
  try {
    await (await inboxCol()).insertOne(doc);
  } catch (e: any) {
    if (e?.code === 11000) return false;
    throw e;
  }
  // the lead already linked to this conversation stays linked
  const linked = await (await inboxCol()).findOne({ thread: doc.thread, leadId: { $exists: true, $ne: '' } }, { projection: { leadId: 1 } });
  if (linked?.leadId) await (await inboxCol()).updateOne({ _id: doc._id }, { $set: { leadId: linked.leadId } });
  if (doc.direction === 'in') await alert(doc).catch(() => undefined);
  return true;
}

async function alert(d: InboxItem) {
  const users = await listUsers();
  const ids = users.filter((u) => u.status !== 'Disabled' && (u.role === 'Admin' || u.role === 'Manager')).map((u) => u.id);
  if (!ids.length) return;
  const where = d.platform === 'google' ? 'Google review' : `${d.platform === 'facebook' ? 'Facebook' : 'Instagram'} ${d.kind === 'message' ? 'message' : 'comment'}`;
  const title = d.kind === 'review' && (d.rating || 5) <= 3 ? `${d.rating}★ ${where} from ${d.authorName || 'a customer'}` : `${where}: ${d.authorName || 'someone'}`;
  await sendPush(ids, { title, body: truncate(d.text || '(no text)', 160), url: `/inbox?thread=${encodeURIComponent(d.thread)}`, tag: `inbox-${d.thread}` });
}

/* ------------------------------ Meta webhooks ----------------------------- */

const tsDate = (v: unknown) => {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000);
  const d = new Date(String(v || ''));
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

async function personName(token: string, id: string, ig: boolean): Promise<string> {
  try {
    const j = await graph<{ name?: string; username?: string }>(id, { token, params: { fields: ig ? 'name,username' : 'name' } });
    return String(j.name || (j.username ? '@' + j.username : '') || '');
  } catch {
    return '';
  }
}

/**
 * Comments and messages of a verified Meta webhook body (object 'page' or 'instagram'). Each entry is stored in
 * the company that connected the Page / Instagram account; anything else is ignored. Returns how many were new.
 */
export async function ingestSocialWebhook(body: any): Promise<number> {
  const object = String(body?.object || '');
  if (object !== 'page' && object !== 'instagram') return 0;
  const ig = object === 'instagram';
  let n = 0;
  for (const entry of Array.isArray(body?.entry) ? body.entry.slice(0, 50) : []) {
    const account = String(entry?.id || '');
    const companyId = account ? await companyOfSocial(ig ? 'ig' : 'fb', account) : null;
    if (!companyId) continue;
    const tenant = await getTenantById(companyId);
    if (!tenant || tenant.status !== 'Active' || !tenant.features.socialInbox) continue;
    n += await runWithTenant(tenant, async () => {
      let k = 0;
      const page = await pageFor(account);
      const platform: InboxPlatform = ig ? 'instagram' : 'facebook';
      for (const m of Array.isArray(entry?.messaging) ? entry.messaging : []) {
        const msg = m?.message;
        if (!msg?.mid || msg.is_echo) continue;
        const sender = String(m?.sender?.id || '');
        if (!sender || sender === account) continue;
        const text = msg.text || (Array.isArray(msg.attachments) && msg.attachments.length ? `[${msg.attachments.map((a: any) => a?.type || 'attachment').join(', ')}]` : '');
        if (await store({
          _id: `${platform}:${msg.mid}`, platform, kind: 'message', thread: `${ig ? 'ig' : 'fb'}:dm:${account}:${sender}`, account, externalId: String(msg.mid),
          authorId: sender, authorName: page ? await personName(page.token, sender, ig) : '', text, at: tsDate(m?.timestamp),
        })) k++;
      }
      for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
        const v = ch?.value || {};
        if (!ig && ch?.field === 'feed' && v.item === 'comment' && v.verb === 'add' && v.comment_id) {
          const from = String(v.from?.id || '');
          if (from === account) continue; // the Page's own reply
          const root = v.parent_id && v.parent_id !== v.post_id ? String(v.parent_id) : String(v.comment_id);
          if (await store({
            _id: `facebook:${v.comment_id}`, platform: 'facebook', kind: 'comment', thread: `fb:c:${root}`, account, externalId: String(v.comment_id), parent: String(v.post_id || ''),
            authorId: from, authorName: String(v.from?.name || ''), text: String(v.message || ''), at: tsDate(v.created_time),
          })) k++;
        }
        if (ig && ch?.field === 'comments' && v.id) {
          const from = String(v.from?.id || '');
          if (from === account) continue;
          const root = v.parent_id ? String(v.parent_id) : String(v.id);
          if (await store({
            _id: `instagram:${v.id}`, platform: 'instagram', kind: 'comment', thread: `ig:c:${root}`, account, externalId: String(v.id), parent: String(v.media?.id || ''),
            authorId: from, authorName: v.from?.username ? '@' + v.from.username : '', text: String(v.text || ''), at: new Date(),
          })) k++;
        }
      }
      return k;
    });
  }
  return n;
}

/* ------------------------------ Google reviews ---------------------------- */

/** New Business Profile reviews (and replies made elsewhere) of the chosen location. */
export async function pollGoogleReviews(): Promise<number> {
  const loc = await gbpLocationPath();
  if (!loc) return 0;
  const j = await gbpFetch<{ reviews?: any[] }>(`https://mybusiness.googleapis.com/v4/${loc.path}/reviews?pageSize=50&orderBy=updateTime%20desc`);
  let n = 0;
  for (const r of j.reviews || []) {
    const id = String(r?.reviewId || '');
    if (!id) continue;
    const thread = `g:r:${id}`;
    if (await store({
      _id: `google:${id}`, platform: 'google', kind: 'review', thread, account: loc.path, externalId: id,
      authorId: '', authorName: String(r?.reviewer?.displayName || 'Google user'), text: String(r?.comment || ''), rating: STARS[String(r?.starRating)] || undefined, at: tsDate(r?.createTime),
    })) n++;
    if (r?.reviewReply?.comment) {
      await store({ _id: `google:${id}:reply`, platform: 'google', kind: 'review', thread, account: loc.path, externalId: id, authorId: '', authorName: loc.title, text: String(r.reviewReply.comment), at: tsDate(r.reviewReply.updateTime), direction: 'out' } as any);
    }
  }
  return n;
}

/** Cron (every 10 minutes with the Meta cron, and daily): reviews of every company with the inbox. */
export async function runInboxCron(opts: { daily?: boolean } = {}): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.socialInbox) continue;
    try {
      out[tenant.slug] = await runWithTenant(tenant, async () => ({
        reviews: await pollGoogleReviews().catch((e) => `error: ${truncate(e?.message || '', 120)}`),
        ...(opts.daily ? { subscriptions: await refreshSocialSubscriptions() } : {}),
      }));
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

/* --------------------------------- screen --------------------------------- */

export interface InboxThread {
  thread: string;
  platform: InboxPlatform;
  kind: InboxKind;
  authorName: string;
  text: string;
  rating?: number;
  at: string;
  unread: number;
  count: number;
  leadId: string;
  answered: boolean;
}

export async function listInbox(d: any = {}): Promise<{ threads: InboxThread[]; unread: number }> {
  const match: Record<string, unknown> = {};
  if (['facebook', 'instagram', 'google'].includes(d?.platform)) match.platform = d.platform;
  if (['comment', 'message', 'review'].includes(d?.kind)) match.kind = d.kind;
  const rows = await (await inboxCol()).aggregate<any>([
    { $match: match },
    { $sort: { at: 1 } },
    { $group: {
      _id: '$thread', platform: { $last: '$platform' }, kind: { $first: '$kind' }, at: { $last: '$at' }, count: { $sum: 1 },
      unread: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $eq: ['$read', false] }] }, 1, 0] } },
      // incoming items only ($push skips $REMOVE; $last would not), the last one is shown
      ins: { $push: { $cond: [{ $eq: ['$direction', 'in'] }, { name: '$authorName', text: '$text', rating: '$rating' }, '$REMOVE'] } },
      lastDir: { $last: '$direction' }, lastText: { $last: '$text' }, leadId: { $max: '$leadId' },
    } },
    { $sort: { at: -1 } },
    { $limit: Math.min(Number(d?.limit) || 100, 300) },
    { $addFields: { lastIn: { $arrayElemAt: ['$ins', -1] } } },
    { $project: { ins: 0 } },
  ]).toArray();
  const threads: InboxThread[] = rows.map((r) => ({
    thread: r._id, platform: r.platform, kind: r.kind, authorName: r.lastIn?.name || '', text: r.lastDir === 'out' ? `You: ${r.lastText}` : r.lastIn?.text || r.lastText || '',
    rating: r.lastIn?.rating, at: new Date(r.at).toISOString(), unread: r.unread, count: r.count, leadId: r.leadId || '', answered: r.lastDir === 'out',
  }));
  const unread = (await (await inboxCol()).distinct('thread', { direction: 'in', read: false })).length;
  return { threads, unread };
}

export async function getInboxThread(d: any): Promise<{ thread: string; items: Array<Omit<InboxItem, 'at' | '_id'> & { id: string; at: string }> }> {
  const thread = String(d?.thread || '');
  const items = await (await inboxCol()).find({ thread }).sort({ at: 1 }).limit(500).toArray();
  if (!items.length) throw fail('NOT_FOUND', 'Conversation not found');
  await (await inboxCol()).updateMany({ thread, direction: 'in', read: false }, { $set: { read: true } });
  return { thread, items: items.map(({ _id, at, ...x }) => ({ ...x, id: _id, at: at.toISOString() })) };
}

/** Answer the conversation on its platform, then keep the answer in the thread. */
export async function replyInbox(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const thread = String(d?.thread || '');
  const text = String(d?.text || '').trim();
  if (!text) throw fail('VALIDATION', 'Write a reply first.');
  if (text.length > 2000) throw fail('VALIDATION', 'Replies can be up to 2000 characters.');
  const c = await inboxCol();
  const last = await c.find({ thread, direction: 'in' }).sort({ at: -1 }).limit(1).next();
  if (!last) throw fail('NOT_FOUND', 'Conversation not found');
  let externalId = '';
  if (last.platform === 'google') {
    await gbpFetch(`https://mybusiness.googleapis.com/v4/${last.account}/reviews/${last.externalId}/reply`, { method: 'PUT', body: { comment: text } });
    externalId = `${last.externalId}:reply`;
  } else {
    const page = await pageFor(last.account);
    if (!page) throw fail('VALIDATION', 'This Page is no longer connected (Settings › Social accounts).');
    if (last.kind === 'message') {
      const r = await graph<{ message_id?: string }>(`${page.id}/messages`, {
        token: page.token, method: 'POST',
        params: { recipient: JSON.stringify({ id: last.authorId }), messaging_type: 'RESPONSE', message: JSON.stringify({ text }) },
      }).catch((e: any) => {
        throw fail('VALIDATION', /24|window|outside/i.test(e?.message || '') ? 'Meta only allows replies within 24 hours of the person’s last message. Ask them to message again, or reply from the Facebook / Instagram app.' : e?.message || 'Facebook refused the reply.');
      });
      externalId = String(r.message_id || '');
    } else {
      const root = thread.split(':').pop() || last.externalId;
      const r = await graph<{ id?: string }>(last.platform === 'instagram' ? `${root}/replies` : `${root}/comments`, { token: page.token, method: 'POST', params: { message: text } });
      externalId = String(r.id || '');
    }
  }
  const id = `${last.platform}:${externalId || 'out-' + Date.now()}`;
  await c.updateOne({ _id: id }, { $setOnInsert: {
    platform: last.platform, kind: last.kind, thread, account: last.account, externalId, authorId: '', authorName: ctx.user?.name || 'CRM',
    text, direction: 'out', at: new Date(), read: true, by: ctx.user?.name || '', ...(last.leadId ? { leadId: last.leadId } : {}),
  } }, { upsert: true });
  await c.updateMany({ thread, direction: 'in', read: false }, { $set: { read: true } });
  return { ok: true };
}

/** A conversation becomes a lead (name and phone typed in by the team); the thread stays linked to it. */
export async function inboxCreateLead(d: any, ctx: Ctx): Promise<{ leadId: string }> {
  const thread = String(d?.thread || '');
  const first = await (await inboxCol()).find({ thread, direction: 'in' }).sort({ at: 1 }).limit(1).next();
  if (!first) throw fail('NOT_FOUND', 'Conversation not found');
  if (first.leadId) return { leadId: first.leadId };
  // a Google review has no matching enquiry source: the team sets it on the lead
  const source = first.platform === 'facebook' ? 'Facebook' : first.platform === 'instagram' ? 'Instagram' : '';
  const name = String(d?.name || first.authorName || '').replace(/^@/, '').trim();
  const res = await addLead({
    [CFG.LEAD.NAME]: name, [CFG.LEAD.PHONE]: String(d?.phone || '').trim(), [CFG.LEAD.EMAIL]: String(d?.email || '').trim(),
    ...(source ? { [CFG.LEAD.SOURCE]: source } : {}),
    [`${CFG.FORM_ANSWER_PREFIX}${first.kind === 'review' ? 'Google review' : first.kind === 'message' ? 'First message' : 'Comment'}`]: truncate(first.text, 300),
  } as any, ctx);
  await (await inboxCol()).updateMany({ thread }, { $set: { leadId: res.id } });
  return { leadId: res.id };
}

export async function markInboxRead(d: any): Promise<{ ok: true }> {
  await (await inboxCol()).updateMany({ thread: String(d?.thread || ''), direction: 'in' }, { $set: { read: d?.read !== false } });
  return { ok: true };
}

export async function refreshInbox(): Promise<{ reviews: number }> {
  return { reviews: await pollGoogleReviews() };
}

export const actions: ActionMap = {
  listInbox: { fn: (d) => listInbox(d), perm: 'chat.view' },
  getInboxThread: { fn: (d) => getInboxThread(d), perm: 'chat.view' },
  replyInbox: { fn: (d, ctx) => replyInbox(d, ctx), perm: 'chat.send' },
  markInboxRead: { fn: (d) => markInboxRead(d), perm: 'chat.view' },
  inboxCreateLead: { fn: (d, ctx) => inboxCreateLead(d, ctx), perm: 'leads.create' },
  refreshInbox: { fn: () => refreshInbox(), perm: 'chat.view' },
};

