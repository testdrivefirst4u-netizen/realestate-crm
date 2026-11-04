/**
 * Post scheduler (plan feature socialPosts, screen /posts): write once, publish now or at a time to the connected
 * Facebook Pages, Instagram accounts, Google Business Profile location, LinkedIn page and Pinterest board.
 *
 * Posts  = company collection `socialPosts` { _id: POST-0001, text, link, imageFileId, targets[{ key, kind, name,
 *          status 'pending' | 'posted' | 'failed', postId, url, error }], scheduledAt, status 'scheduled' |
 *          'publishing' | 'published' | 'partial' | 'failed' }.
 * Image  = stored in the file store (category 'Social posts'); Instagram, Pinterest and Google fetch it from a
 *          signed public link (GET /api/public/media/<company>/<file>?sig=…) that serves only social post images.
 * Publish = "Post now" publishes at once; scheduled posts are published by the Meta cron (every 10 minutes) once due.
 *          A failed target can be retried; posted ones are never posted twice.
 */
import crypto from 'crypto';
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { col, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { appUrl } from '../core/settings';
import { currentTenant, requireTenant, runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { listActiveTenants } from '../platform/registry';
import { gbpFetch, gbpLocationPath } from './googleMarketing';
import { postToLinkedIn } from './linkedin';
import { pinToPinterest } from './pinterest';
import { socialPages } from './socialAccounts';
import { decodeBase64, readFile, saveFile, statFile } from './storage';

export const POST_IMAGE_CATEGORY = 'Social posts';
const MAX_IMAGE = 3 * 1024 * 1024;

export interface PostMetrics { likes: number | null; comments: number | null; shares: number | null }
export type TargetKind = 'facebook' | 'instagram' | 'google' | 'linkedin' | 'pinterest';
export interface PostTarget { key: string; kind: TargetKind; name: string; status: 'pending' | 'posted' | 'failed'; postId?: string; url?: string; error?: string }
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed';
interface PostDoc {
  _id: string;
  text: string;
  link: string;
  imageFileId: string;
  targets: PostTarget[];
  scheduledAt: Date;
  status: PostStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date | null;
  /** Copied from the platform (socialPostsImport.ts): its picture link, read only. */
  imported?: boolean;
  imageExternal?: string;
  metrics?: PostMetrics | null;
}
const postsCol = () => col<PostDoc>('socialPosts');

/* ------------------------------ public images ----------------------------- */

function mediaKey(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY?.trim() || (process.env.NODE_ENV !== 'production' ? 'amaya-dev-only-key' : '');
  if (!raw) throw fail('NOT_CONFIGURED', 'SECRETS_ENCRYPTION_KEY is not set on the server.');
  return crypto.createHash('sha256').update('social-media\n' + raw).digest();
}
export const mediaSig = (companyId: string, fileId: string) => crypto.createHmac('sha256', mediaKey()).update(`${companyId}:${fileId}`).digest('base64url').slice(0, 32);
export function publicMediaUrl(fileId: string): string {
  const c = requireTenant().id;
  return `${appUrl()}/api/public/media/${encodeURIComponent(c)}/${fileId}?sig=${mediaSig(c, fileId)}`;
}
/** The public image route: only social post images, only with the right signature. */
export function mediaSigOk(companyId: string, fileId: string, sig: string): boolean {
  const want = mediaSig(companyId, fileId);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

export async function uploadPostImage(d: any, ctx: Ctx): Promise<{ fileId: string; previewUrl: string }> {
  const mime = String(d?.mime || '').toLowerCase();
  if (!/^image\/(jpeg|png)$/.test(mime)) throw fail('VALIDATION', 'Use a JPG or PNG image (Instagram and Pinterest accept these).');
  const data = decodeBase64(d?.base64);
  if (data.length > MAX_IMAGE) throw fail('VALIDATION', 'The image is larger than 3 MB. Make it smaller first.');
  const saved = await saveFile({ category: POST_IMAGE_CATEGORY, name: String(d?.name || 'post.jpg'), mime, data, uploadedBy: ctx.user?.name || 'System' });
  return { fileId: saved.fileId, previewUrl: saved.url };
}

/* --------------------------------- targets -------------------------------- */

export interface TargetOption { key: string; kind: TargetKind; name: string; needsImage: boolean }

/** Where this company can post now (connected accounts of the switched-on features). */
export async function listPostTargets(): Promise<TargetOption[]> {
  const f = (currentTenant()?.features || {}) as Record<string, boolean>;
  const out: TargetOption[] = [];
  for (const p of await socialPages().catch(() => [])) {
    out.push({ key: `facebook:${p.id}`, kind: 'facebook', name: p.name, needsImage: false });
    if (p.igId) out.push({ key: `instagram:${p.igId}`, kind: 'instagram', name: `@${p.igUsername || p.igId}`, needsImage: true });
  }
  const loc = await gbpLocationPath().catch(() => null);
  if (loc) out.push({ key: `google:${loc.path}`, kind: 'google', name: loc.title, needsImage: false });
  if (f.linkedin) {
    const { getLinkedIn } = await import('./linkedin');
    const li = await getLinkedIn().catch(() => null);
    const org = li?.orgs.find((o) => o.urn === li.orgUrn);
    if (li?.connected && org) out.push({ key: `linkedin:${org.urn}`, kind: 'linkedin', name: org.name, needsImage: false });
  }
  if (f.pinterest) {
    const { getPinterest } = await import('./pinterest');
    const pi = await getPinterest().catch(() => null);
    const board = pi?.boards.find((b) => b.id === pi.boardId);
    if (pi?.connected && board) out.push({ key: `pinterest:${board.id}`, kind: 'pinterest', name: board.name, needsImage: true });
  }
  return out;
}

/* -------------------------------- publishing ------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function publishTarget(post: PostDoc, t: PostTarget): Promise<{ postId: string; url: string }> {
  const id = t.key.slice(t.kind.length + 1);
  const imageUrl = post.imageFileId ? publicMediaUrl(post.imageFileId) : '';
  // the link goes in the text where the platform has no link of its own (photo captions, Instagram, LinkedIn with an image)
  const withLink = post.link ? `${post.text}\n\n${post.link}` : post.text;
  if (t.kind === 'facebook') {
    const page = (await socialPages()).find((p) => p.id === id);
    if (!page) throw fail('VALIDATION', 'This Facebook Page is no longer connected.');
    const r = imageUrl
      ? await graph<{ id?: string; post_id?: string }>(`${id}/photos`, { token: page.token, method: 'POST', params: { url: imageUrl, caption: withLink } })
      : await graph<{ id?: string }>(`${id}/feed`, { token: page.token, method: 'POST', params: { message: post.text, ...(post.link ? { link: post.link } : {}) } });
    const pid = String((r as any).post_id || r.id || '');
    return { postId: pid, url: pid ? `https://www.facebook.com/${pid}` : '' };
  }
  if (t.kind === 'instagram') {
    const page = (await socialPages()).find((p) => p.igId === id);
    if (!page) throw fail('VALIDATION', 'This Instagram account is no longer connected.');
    if (!imageUrl) throw fail('VALIDATION', 'Instagram needs an image.');
    const c = await graph<{ id?: string }>(`${id}/media`, { token: page.token, method: 'POST', params: { image_url: imageUrl, caption: truncate(withLink, 2200) } });
    let last: any;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await graph<{ id?: string }>(`${id}/media_publish`, { token: page.token, method: 'POST', params: { creation_id: String(c.id) } });
        const link = await graph<{ permalink?: string }>(String(r.id), { token: page.token, params: { fields: 'permalink' } }).catch(() => ({ permalink: '' }));
        return { postId: String(r.id || ''), url: String(link.permalink || '') };
      } catch (e: any) {
        last = e;
        if (!/not ready|9007|processing/i.test(e?.message || '')) break; // only wait while Instagram is still processing the image
        await sleep(2000 * (i + 1));
      }
    }
    throw last;
  }
  if (t.kind === 'google') {
    const r = await gbpFetch<{ name?: string; searchUrl?: string }>(`https://mybusiness.googleapis.com/v4/${id}/localPosts`, { body: {
      languageCode: 'en-IN', summary: truncate(post.text, 1500), topicType: 'STANDARD',
      ...(imageUrl ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }] } : {}),
      ...(post.link ? { callToAction: { actionType: 'LEARN_MORE', url: post.link } } : {}),
    } });
    return { postId: String(r.name || ''), url: String(r.searchUrl || '') };
  }
  if (t.kind === 'linkedin') {
    const img = post.imageFileId ? await readFile(post.imageFileId) : null;
    const r = await postToLinkedIn({ text: img ? withLink : post.text, image: img ? { data: img.data, mime: img.mime } : null, link: img ? '' : post.link });
    return { postId: r.id, url: r.url };
  }
  const pin = await pinToPinterest({ text: post.text, imageUrl, link: post.link, title: post.text.split('\n')[0] });
  return { postId: pin.id, url: pin.url };
}

/** Publish the targets not yet posted (one taker at a time). */
export async function publishPost(id: string, opts: { now?: Date; retry?: boolean } = {}): Promise<PostDoc | null> {
  const c = await postsCol();
  const now = opts.now || new Date();
  const from: PostStatus[] = opts.retry ? ['partial', 'failed', 'scheduled'] : ['scheduled'];
  const post = await c.findOneAndUpdate({ _id: id, status: { $in: from }, ...(opts.retry ? {} : { scheduledAt: { $lte: now } }) }, { $set: { status: 'publishing', updatedAt: now } }, { returnDocument: 'after' });
  if (!post) return c.findOne({ _id: id });
  const targets: PostTarget[] = [];
  for (const t of post.targets) {
    if (t.status === 'posted') { targets.push(t); continue; }
    try {
      const r = await publishTarget(post, t);
      targets.push({ ...t, status: 'posted', postId: r.postId, url: r.url, error: '' });
    } catch (e: any) {
      targets.push({ ...t, status: 'failed', error: truncate(e?.message || String(e), 300) });
    }
  }
  const ok = targets.filter((t) => t.status === 'posted').length;
  const status: PostStatus = ok === targets.length ? 'published' : ok ? 'partial' : 'failed';
  await c.updateOne({ _id: id }, { $set: { targets, status, updatedAt: new Date(), ...(ok ? { publishedAt: new Date() } : {}) } });
  return c.findOne({ _id: id });
}

/** Cron: due scheduled posts of every company with the post scheduler. */
export async function runPostsCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.socialPosts) continue;
    try {
      const r = await runWithTenant(tenant, async () => {
        const due = await (await postsCol()).find({ status: 'scheduled', scheduledAt: { $lte: now } }, { projection: { _id: 1 } }).limit(20).toArray();
        const res: Record<string, number> = {};
        for (const d of due) {
          const p = await publishPost(d._id, { now });
          if (p) res[p.status] = (res[p.status] || 0) + 1;
        }
        return res;
      });
      if (Object.keys(r).length) out[tenant.slug] = r;
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

/* ---------------------------------- screen -------------------------------- */

export interface PostView { id: string; text: string; link: string; imageFileId: string; imageUrl: string; targets: PostTarget[]; scheduledAt: string; status: PostStatus; createdBy: string; publishedAt: string; metrics: PostMetrics | null }
const view = (p: PostDoc): PostView => ({
  id: p._id, text: p.text, link: p.link, imageFileId: p.imageFileId, imageUrl: p.imageFileId ? `/api/files/${p.imageFileId}` : p.imageExternal || '', targets: p.targets, scheduledAt: p.scheduledAt.toISOString(),
  status: p.status, createdBy: p.createdBy, publishedAt: p.publishedAt ? p.publishedAt.toISOString() : '', metrics: p.metrics || null,
});

/** Posts in the range (the planner's month; by default from 30 days ago), and every draft. */
export async function listPosts(d: any = {}): Promise<{ posts: PostView[]; targets: TargetOption[]; hasMore: boolean }> {
  const parsed = d?.from ? new Date(d.from) : null;
  const from = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() - 30 * 86400000);
  const until = d?.to ? new Date(d.to) : null;
  const range = { $gte: from, ...(until && !Number.isNaN(until.getTime()) ? { $lt: until } : {}) };
  const statuses = Array.isArray(d?.statuses) ? d.statuses.map(String) as PostStatus[] : null;
  const limit = Math.min(Math.max(Number(d?.limit) || 500, 1), 500);
  const skip = Math.max(Number(d?.skip) || 0, 0);
  const filter = statuses ? { status: { $in: statuses }, scheduledAt: range } : { $or: [{ status: 'draft' as const }, { scheduledAt: range }] };
  const rows = await (await postsCol()).find(filter as any).sort({ scheduledAt: -1 }).skip(skip).limit(limit + 1).toArray();
  return { posts: rows.slice(0, limit).map(view), targets: await listPostTargets(), hasMore: rows.length > limit };
}

const LINK_RE = /^https:\/\/[^\s]+$/i;

/** The post's content; a draft may still be unfinished (no account yet, no image for Instagram). */
async function readPost(d: any, draft: boolean) {
  const text = String(d?.text || '').trim();
  const link = String(d?.link || '').trim();
  const imageFileId = String(d?.imageFileId || '');
  if (!text && !(draft && imageFileId)) throw fail('VALIDATION', 'Write the post first.');
  if (link && !LINK_RE.test(link)) throw fail('VALIDATION', 'The link must start with https://');
  const options = await listPostTargets();
  const keys = [...new Set((Array.isArray(d?.targets) ? d.targets : []).map(String))] as string[];
  if (!keys.length && !draft) throw fail('VALIDATION', 'Choose where to post.');
  const chosen = keys.map((k) => options.find((o) => o.key === k));
  if (chosen.some((o) => !o)) throw fail('VALIDATION', 'One of the chosen accounts is no longer connected. Reload the page.');
  if (imageFileId) {
    const f = await statFile(imageFileId);
    if (!f || f.category !== POST_IMAGE_CATEGORY) throw fail('VALIDATION', 'Upload the image again.');
  }
  if (!draft) {
    for (const o of chosen as TargetOption[]) {
      if (o.needsImage && !imageFileId) throw fail('VALIDATION', `${o.kind === 'instagram' ? 'Instagram' : 'Pinterest'} needs an image.`);
      if (o.kind === 'google' && text.length > 1500) throw fail('VALIDATION', 'Google Business Profile posts can be up to 1500 characters.');
      if (o.kind === 'instagram' && text.length > 2200) throw fail('VALIDATION', 'Instagram captions can be up to 2200 characters.');
    }
  }
  if (text.length > 3000) throw fail('VALIDATION', 'Posts can be up to 3000 characters.');
  return { text, link, imageFileId, targets: (chosen as TargetOption[]).map((o) => ({ key: o.key, kind: o.kind, name: o.name, status: 'pending' as const })) };
}

/** When it goes out: the chosen time, or now. */
function readWhen(d: any, now: Date): Date {
  const when = d?.scheduledAt ? new Date(d.scheduledAt) : now;
  if (Number.isNaN(when.getTime())) throw fail('VALIDATION', 'Choose a valid date and time.');
  if (when.getTime() < now.getTime() - 60000) throw fail('VALIDATION', 'The time has passed. Choose a later time, or Post now.');
  if (when.getTime() > now.getTime() + 180 * 86400000) throw fail('VALIDATION', 'Posts can be scheduled up to 6 months ahead.');
  return when;
}

export async function createPost(d: any, ctx: Ctx): Promise<PostView> {
  const draft = !!d?.draft;
  const fields = await readPost(d, draft);
  const now = new Date();
  const when = draft ? now : readWhen(d, now);
  const doc: PostDoc = { _id: await nextSeq('POST', 4), ...fields, scheduledAt: when, status: draft ? 'draft' : 'scheduled', createdBy: ctx.user?.name || 'System', createdAt: now, updatedAt: now };
  await (await postsCol()).insertOne(doc);
  await auditLog(ctx, draft ? 'Post Draft Saved' : d?.scheduledAt ? 'Post Scheduled' : 'Post Published', 'Post', doc._id, `${doc.targets.map((t) => t.kind).join(', ')} · ${truncate(fields.text, 80)}`);
  const out = draft || d?.scheduledAt ? doc : await publishPost(doc._id, { now });
  return view(out || doc);
}

/** Change a draft or a scheduled post: keep it as a draft, (re)schedule it, or publish it now. */
export async function updatePost(d: any, ctx: Ctx): Promise<PostView> {
  const id = String(d?.id || '');
  const draft = !!d?.draft;
  const fields = await readPost(d, draft);
  const now = new Date();
  const when = draft ? now : readWhen(d, now);
  const c = await postsCol();
  // the filter is the guard: a post the cron has just taken is no longer changed
  const r = await c.findOneAndUpdate({ _id: id, status: { $in: ['draft', 'scheduled'] } }, { $set: { ...fields, scheduledAt: when, status: draft ? 'draft' : 'scheduled', updatedAt: now } }, { returnDocument: 'after' });
  if (!r) throw fail('VALIDATION', 'Only a draft or a scheduled post can be changed. This one may have just been posted.');
  await auditLog(ctx, draft ? 'Post Draft Saved' : d?.scheduledAt ? 'Post Rescheduled' : 'Post Published', 'Post', id, `${fields.targets.map((t) => t.kind).join(', ')} · ${truncate(fields.text, 80)}`);
  const out = draft || d?.scheduledAt ? r : await publishPost(id, { now });
  return view(out || r);
}

/** Change the text of a post already on Facebook. The platforms do not let an app change a published picture, or Instagram captions. */
export async function editPublishedPost(d: any, ctx: Ctx): Promise<PostView> {
  const id = String(d?.id || '');
  const text = String(d?.text || '').trim();
  if (!text) throw fail('VALIDATION', 'Write the post first.');
  if (text.length > 3000) throw fail('VALIDATION', 'Posts can be up to 3000 characters.');
  const c = await postsCol();
  const post = await c.findOne({ _id: id });
  if (!post) throw fail('NOT_FOUND', 'Post not found');
  const t = post.targets[0];
  if (post.targets.length !== 1 || t.kind !== 'facebook' || t.status !== 'posted' || !t.postId) throw fail('VALIDATION', 'Only a post on one Facebook Page can be changed here. Change others on the platform itself.');
  const page = (await socialPages()).find((p) => p.id === t.key.slice('facebook:'.length));
  if (!page) throw fail('VALIDATION', 'This Facebook Page is no longer connected.');
  await graph(t.postId, { token: page.token, method: 'POST', params: { message: text } });
  const r = await c.findOneAndUpdate({ _id: id }, { $set: { text, updatedAt: new Date() } }, { returnDocument: 'after' });
  await auditLog(ctx, 'Published Post Edited', 'Post', id, truncate(text, 80));
  return view(r || post);
}

export async function retryPost(d: any, ctx: Ctx): Promise<PostView> {
  const p = await publishPost(String(d?.id || ''), { retry: true });
  if (!p) throw fail('NOT_FOUND', 'Post not found');
  await auditLog(ctx, 'Post Retried', 'Post', p._id, p.status);
  return view(p);
}

export async function deletePost(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const id = String(d?.id || '');
  const r = await (await postsCol()).deleteOne({ _id: id, status: { $in: ['draft', 'scheduled', 'failed'] } });
  if (!r.deletedCount) throw fail('VALIDATION', 'Only a draft, a scheduled post, or one that failed everywhere, can be deleted here. Published posts are removed on the platform itself.');
  await auditLog(ctx, 'Post Deleted', 'Post', id, '');
  return { ok: true };
}

export const actions: ActionMap = {
  listPosts: { fn: (d) => listPosts(d), perm: 'marketing.manage' },
  createPost: { fn: (d, ctx) => createPost(d, ctx), perm: 'marketing.manage' },
  updatePost: { fn: (d, ctx) => updatePost(d, ctx), perm: 'marketing.manage' },
  editPublishedPost: { fn: (d, ctx) => editPublishedPost(d, ctx), perm: 'marketing.manage' },
  retryPost: { fn: (d, ctx) => retryPost(d, ctx), perm: 'marketing.manage' },
  deletePost: { fn: (d, ctx) => deletePost(d, ctx), perm: 'marketing.manage' },
  uploadPostImage: { fn: (d, ctx) => uploadPostImage(d, ctx), perm: 'marketing.manage' },
};
