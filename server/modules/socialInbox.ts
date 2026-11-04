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
 * Posts   = a comment thread shows the post it is on: from `socialPosts`, else read from the platform when opened.
 * Media   = pictures, videos and shared posts of a message are read from Meta when the conversation is opened and not
 *           stored: Meta's links expire, and it has them for a conversation's 20 most recent messages only.
 * People  = the name, username and picture of who a conversation is with, kept in `socialInboxPeople`: Meta gives them
 *           only once the person has written, the picture link expires within days, and some fields can be refused.
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
  /** A conversation's other person, also when only the account has written so far. */
  partnerName?: string;
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
/** A message Meta gives without its content (a shared reel or post, a story, a voice note…). */
export const UNSUPPORTED_MESSAGE = '[Shared content Meta does not show to apps: open it in the app]';
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
        const text = msg.text || (Array.isArray(msg.attachments) && msg.attachments.length ? `[${msg.attachments.map((a: any) => a?.type || 'attachment').join(', ')}]` : msg.is_unsupported ? UNSUPPORTED_MESSAGE : '');
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
  /** Who a conversation is with, when Meta has told us. */
  username: string;
  picture: string;
  /** Worth asking Meta (refreshInboxPeople). */
  personStale: boolean;
  /** The post a comment thread is on. */
  parent: string;
  postText: string;
  postImage: string;
}

interface InboxPerson { _id: string; name: string; username: string; picture: string; at: Date; /** What Meta said when it gave no picture. */ reason?: string }
const peopleCol = () => col<InboxPerson>('socialInboxPeople');
const PERSON_REFRESH_MS = 3 * 86400000;
/** No picture yet: worth asking again sooner, it may be allowed by then. */
const PERSON_RETRY_MS = 6 * 3600000;
const MAX_PEOPLE = 30;
/** ig:dm:<account>:<person> or fb:dm:<account>:<person>. */
const DM_THREAD = /^(ig|fb):dm:([^:]+):([^:]+)$/;
const personKey = (thread: string) => {
  const m = DM_THREAD.exec(thread);
  return m ? `${m[1]}:${m[3]}` : '';
};

/** The most Meta will say about someone: it refuses a whole request over one field it does not allow. */
async function readPerson(ig: boolean, id: string, token: string): Promise<{ name: string; username: string; picture: string; reason: string }> {
  let said = '';
  for (const fields of ig ? ['name,username,profile_pic', 'name,profile_pic', 'username'] : ['name,profile_pic', 'first_name,last_name,profile_pic']) {
    try {
      const j = await graph<any>(id, { token, params: { fields } });
      const name = String(j.name || [j.first_name, j.last_name].filter(Boolean).join(' ') || '');
      const picture = /^https:\/\//.test(String(j.profile_pic || '')) ? String(j.profile_pic) : '';
      return { name: truncate(name, 120), username: truncate(String(j.username || ''), 60), picture, reason: picture ? '' : said || 'Meta answered without a profile picture.' };
    } catch (e: any) {
      said = said || truncate(String(e?.message || e), 240); // ask for less
    }
  }
  return { name: '', username: '', picture: '', reason: said };
}
const personStale = (p: InboxPerson | null | undefined, now: number) => !p || now - p.at.getTime() >= (p.picture ? PERSON_REFRESH_MS : PERSON_RETRY_MS);

/** Ask Meta about the people of these conversations, at most a few at a time and not too often. */
export async function refreshInboxPeople(d: any, now = new Date()): Promise<{ people: Array<{ thread: string; name: string; username: string; picture: string; reason: string }> }> {
  const threads = [...new Set((Array.isArray(d?.threads) ? d.threads : []).map(String))].slice(0, MAX_PEOPLE) as string[];
  const c = await peopleCol();
  const out: Array<{ thread: string; name: string; username: string; picture: string; reason: string }> = [];
  await Promise.all(threads.map(async (thread) => {
    const m = DM_THREAD.exec(thread);
    // only a conversation of this company, reached with this company's own page token
    if (!m || !(await (await inboxCol()).findOne({ thread }, { projection: { _id: 1 } }))) return;
    const key = personKey(thread);
    const known = await c.findOne({ _id: key });
    if (!d?.force && !personStale(known, now.getTime())) {
      out.push({ thread, name: known!.name, username: known!.username, picture: known!.picture, reason: known!.reason || '' });
      return;
    }
    const page = await pageFor(m[2]);
    const got = page ? await readPerson(m[1] === 'ig', m[3], page.token) : null;
    // nothing from Meta is remembered too, so it is not asked again at every screen; what we knew is kept
    const next = { name: got?.name || known?.name || '', username: got?.username || known?.username || '', picture: got?.picture || '', reason: page ? got?.reason || '' : 'This account is no longer connected.' };
    await c.updateOne({ _id: key }, { $set: { ...next, at: now } }, { upsert: true });
    out.push({ thread, ...next });
  }));
  return { people: out };
}

export interface InboxMedia { type: 'image' | 'video' | 'file' | 'link'; url: string; preview: string; name: string }
const httpsUrl = (v: unknown) => (/^https:\/\//.test(String(v || '')) ? String(v) : '');
const MEDIA_FIELDS = 'attachments{mime_type,name,file_url,image_data{url,preview_url},video_data{url,preview_url}},shares{link,name}';

/** What Meta sent for one message, in a form the screen can show. */
export function mediaOf(m: any): InboxMedia[] {
  const out: InboxMedia[] = [];
  for (const a of m?.attachments?.data || []) {
    const video = httpsUrl(a?.video_data?.url);
    const image = httpsUrl(a?.image_data?.url);
    const file = httpsUrl(a?.file_url);
    if (video) out.push({ type: 'video', url: video, preview: httpsUrl(a?.video_data?.preview_url), name: '' });
    else if (image) out.push({ type: 'image', url: image, preview: httpsUrl(a?.image_data?.preview_url), name: '' });
    else if (file) out.push({ type: 'file', url: file, preview: '', name: String(a?.name || 'File').slice(0, 120) });
  }
  for (const s of m?.shares?.data || []) {
    const link = httpsUrl(s?.link);
    if (link) out.push({ type: 'link', url: link, preview: '', name: String(s?.name || '').slice(0, 200) });
  }
  return out;
}

/** The link kept in a message's text, for when Meta no longer gives the message (not among the 20 most recent). */
const linkInText = (text: string): InboxMedia[] => {
  const hit = /^\[Shared a post\] (https:\/\/\S+)/.exec(text);
  return hit ? [{ type: 'link', url: hit[1], preview: '', name: '' }] : [];
};

/** Media of the newest messages that have some (their text is a label like [Attachment]). */
async function readMedia(items: InboxItem[]): Promise<Map<string, InboxMedia[]>> {
  const out = new Map<string, InboxMedia[]>();
  const withMedia = items.filter((i) => i.kind === 'message' && i.text.startsWith('[') && i.externalId).slice(-20);
  if (!withMedia.length) return out;
  const page = await pageFor(withMedia[0].account).catch(() => null);
  await Promise.all(withMedia.map(async (i) => {
    let media: InboxMedia[] = [];
    if (page) {
      try {
        media = mediaOf(await graph<any>(i.externalId, { token: page.token, params: { fields: MEDIA_FIELDS } }));
      } catch { /* an older message: the link in its text is all there is */ }
    }
    out.set(i._id, media.length ? media : linkInText(i.text));
  }));
  return out;
}

export interface InboxPost { id: string; text: string; imageUrl: string; url: string; at: string }

/** Posts already in the post scheduler, by their id on the platform. */
async function knownPosts(ids: string[]): Promise<Map<string, InboxPost>> {
  const out = new Map<string, InboxPost>();
  if (!ids.length) return out;
  const rows = await (await col<any>('socialPosts')).find({ 'targets.postId': { $in: ids } }, { projection: { text: 1, imageFileId: 1, imageExternal: 1, targets: 1, scheduledAt: 1, publishedAt: 1 } }).toArray();
  for (const p of rows) {
    for (const t of p.targets || []) {
      if (!ids.includes(t.postId)) continue;
      out.set(t.postId, { id: t.postId, text: p.text || '', imageUrl: p.imageFileId ? `/api/files/${p.imageFileId}` : p.imageExternal || '', url: t.url || '', at: new Date(p.publishedAt || p.scheduledAt).toISOString() });
    }
  }
  return out;
}

/** A post not in the scheduler (not synced yet) is read from the platform; no post is better than no conversation. */
async function readPost(id: string, platform: InboxPlatform, account: string): Promise<InboxPost | null> {
  try {
    const page = await pageFor(account);
    if (!page) return null;
    if (platform === 'facebook') {
      const j = await graph<any>(id, { token: page.token, params: { fields: 'message,full_picture,permalink_url,created_time' } });
      return { id, text: String(j.message || ''), imageUrl: String(j.full_picture || ''), url: String(j.permalink_url || ''), at: String(j.created_time || '') };
    }
    const j = await graph<any>(id, { token: page.token, params: { fields: 'caption,media_type,media_url,thumbnail_url,permalink,timestamp' } });
    return { id, text: String(j.caption || ''), imageUrl: String((j.media_type === 'VIDEO' ? j.thumbnail_url : j.media_url) || ''), url: String(j.permalink || ''), at: String(j.timestamp || '') };
  } catch {
    return null;
  }
}

export async function listInbox(d: any = {}): Promise<{ threads: InboxThread[]; unread: number; hasMore: boolean; peopleNote: string }> {
  const limit = Math.min(Math.max(Number(d?.limit) || 100, 1), 2000);
  const match: Record<string, unknown> = {};
  if (['facebook', 'instagram', 'google'].includes(d?.platform)) match.platform = d.platform;
  if (['comment', 'message', 'review'].includes(d?.kind)) match.kind = d.kind;
  if (d?.parent) match.parent = String(d.parent);
  const rows = await (await inboxCol()).aggregate<any>([
    { $match: match },
    { $sort: { at: 1 } },
    { $group: {
      _id: '$thread', platform: { $last: '$platform' }, kind: { $first: '$kind' }, at: { $last: '$at' }, count: { $sum: 1 },
      unread: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $eq: ['$read', false] }] }, 1, 0] } },
      // incoming items only ($push skips $REMOVE; $last would not), the last one is shown
      ins: { $push: { $cond: [{ $eq: ['$direction', 'in'] }, { name: '$authorName', text: '$text', rating: '$rating' }, '$REMOVE'] } },
      lastDir: { $last: '$direction' }, lastText: { $last: '$text' }, leadId: { $max: '$leadId' }, parent: { $max: '$parent' }, partner: { $max: '$partnerName' },
    } },
    { $sort: { at: -1 } },
    { $limit: limit + 1 },
    { $addFields: { lastIn: { $arrayElemAt: ['$ins', -1] } } },
    { $project: { ins: 0 } },
  ]).toArray();
  const known = await knownPosts([...new Set(rows.slice(0, limit).map((r) => String(r.parent || '')).filter(Boolean))]);
  const keys = rows.slice(0, limit).map((r) => personKey(String(r._id))).filter(Boolean);
  const people = new Map((keys.length ? await (await peopleCol()).find({ _id: { $in: keys } }).toArray() : []).map((p) => [p._id, p]));
  const threads: InboxThread[] = rows.slice(0, limit).map((r) => ({
    username: people.get(personKey(String(r._id)))?.username || '', picture: people.get(personKey(String(r._id)))?.picture || '',
    personStale: !!personKey(String(r._id)) && personStale(people.get(personKey(String(r._id))), Date.now()),
    parent: r.parent || '', postText: known.get(r.parent)?.text || '', postImage: known.get(r.parent)?.imageUrl || '',
    thread: r._id, platform: r.platform, kind: r.kind, authorName: r.lastIn?.name || r.partner || people.get(personKey(String(r._id)))?.name || '', text: r.lastDir === 'out' ? `You: ${r.lastText}` : r.lastIn?.text || r.lastText || '',
    rating: r.lastIn?.rating, at: new Date(r.at).toISOString(), unread: r.unread, count: r.count, leadId: r.leadId || '', answered: r.lastDir === 'out',
  }));
  const unread = (await (await inboxCol()).distinct('thread', { direction: 'in', read: false })).length;
  return { threads, unread, hasMore: rows.length > limit, peopleNote: [...people.values()].find((p) => !p.picture && p.reason)?.reason || '' };
}

export async function getInboxThread(d: any): Promise<{ thread: string; post: InboxPost | null; items: Array<Omit<InboxItem, 'at' | '_id'> & { id: string; at: string; media: InboxMedia[] }> }> {
  const thread = String(d?.thread || '');
  const items = await (await inboxCol()).find({ thread }).sort({ at: 1 }).limit(500).toArray();
  if (!items.length) throw fail('NOT_FOUND', 'Conversation not found');
  await (await inboxCol()).updateMany({ thread, direction: 'in', read: false }, { $set: { read: true } });
  const on = items.find((i) => i.parent);
  const post = on?.parent ? (await knownPosts([on.parent])).get(on.parent) || await readPost(on.parent, on.platform, on.account) : null;
  const media = await readMedia(items);
  return { thread, post, items: items.map(({ _id, at, ...x }) => ({ ...x, id: _id, at: at.toISOString(), media: media.get(_id) || [] })) };
}

/** Answer the conversation on its platform, then keep the answer in the thread. */
export async function replyInbox(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const thread = String(d?.thread || '');
  const text = String(d?.text || '').trim();
  if (!text) throw fail('VALIDATION', 'Write a reply first.');
  if (text.length > 2000) throw fail('VALIDATION', 'Replies can be up to 2000 characters.');
  const c = await inboxCol();
  const last = await c.find({ thread, direction: 'in' }).sort({ at: -1 }).limit(1).next();
  if (!last) throw fail('VALIDATION', 'Only your own messages are in this conversation. Meta lets you reply once the person writes.');
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
    text, direction: 'out', at: new Date(), read: true, by: ctx.user?.name || '', ...(last.parent ? { parent: last.parent } : {}), ...(last.leadId ? { leadId: last.leadId } : {}),
  } }, { upsert: true });
  await c.updateMany({ thread, direction: 'in', read: false }, { $set: { read: true } });
  return { ok: true };
}

/** A conversation becomes a lead (name and phone typed in by the team); the thread stays linked to it. */
export async function inboxCreateLead(d: any, ctx: Ctx): Promise<{ leadId: string }> {
  const thread = String(d?.thread || '');
  const first = await (await inboxCol()).find({ thread, direction: 'in' }).sort({ at: 1 }).limit(1).next();
  if (!first) throw fail('NOT_FOUND', 'Conversation not found');
  // on any item of the thread: old items copied in later are the oldest and carry none
  const linked = await (await inboxCol()).findOne({ thread, leadId: { $exists: true, $ne: '' } }, { projection: { leadId: 1 } });
  if (linked?.leadId) return { leadId: linked.leadId };
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
  refreshInboxPeople: { fn: (d) => refreshInboxPeople(d), perm: 'chat.view' },
  inboxCreateLead: { fn: (d, ctx) => inboxCreateLead(d, ctx), perm: 'leads.create' },
  refreshInbox: { fn: () => refreshInbox(), perm: 'chat.view' },
};

