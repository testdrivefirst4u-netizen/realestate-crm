/**
 * Post scheduler (plan feature socialPosts, screen /posts): write once, publish now or at a time to the connected
 * Facebook Pages, Instagram accounts, Google Business Profile location, LinkedIn page and Pinterest board.
 *
 * Posts  = company collection `socialPosts` { _id: POST-0001, text, link, imageFileId, targets[{ key, kind, name,
 *          status 'pending' | 'posted' | 'failed', postId, url, error }], scheduledAt, status 'scheduled' |
 *          'publishing' | 'published' | 'partial' | 'failed' }.
 * Image  = stored in the file store (category 'Social posts'); Instagram, Pinterest and Google fetch it from a
 *          signed public link (GET /api/public/media/<company>/<file>?sig=…) that serves only social post images.
 * Photos  = up to 10: Facebook posts them together (unpublished photos, then one feed post with attached_media), Instagram
 *          as a carousel; Google, LinkedIn and Pinterest take the first. `imageFileId` stays the first photo.
 * Text    = one text, or a different one per platform (`texts`). First comment = added on Facebook and Instagram right
 *          after the post; if it fails the post still counts as posted and the target says why.
 * Types   = post (photos and text), video (Facebook), reel and story (Facebook and Instagram): modules/socialPostVideo.ts.
 *          A video Instagram is still processing keeps its target pending and the post is looked at again 5 minutes later.
 * Shown   = what is out shows only while its account is connected: disconnecting hides it, connecting again brings it back,
 *          nothing is deleted. Drafts and scheduled posts always show, so someone can fix them.
 * Publish = "Post now" publishes at once; scheduled posts are published by the Meta cron (every 10 minutes) once due.
 *          A failed target can be retried; posted ones are never posted twice, and deleted ones never come back.
 * After   = text of a published post can change on Facebook (only posts this app made, says Meta) and Google, for each account.
 *          Delete removes it from Facebook, Instagram (whole carousel) or Google, each account on its own; the copy stays
 *          here marked deleted. Instagram has no caption editing; LinkedIn and Pinterest stay on the platform.
 */
import crypto from 'crypto';
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { col, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { appUrl } from '../core/settings';
import { currentTenant, requireTenant, runWithTenant } from '../core/tenant';
import { escapeRegex, truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { listActiveTenants } from '../platform/registry';
import { gbpFetch, gbpLocationPath } from './googleMarketing';
import { postToLinkedIn } from './linkedin';
import { pinToPinterest } from './pinterest';
import { socialPages } from './socialAccounts';
import { decodeBase64, deleteFile, readFile, saveFile, statFile } from './storage';
import { POST_VIDEO_CATEGORY, publishMedia, StillProcessing, type PostType } from './socialPostVideo';

export const POST_IMAGE_CATEGORY = 'Social posts';
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_PHOTOS = 10;
const MAX_HASHTAGS = 30;
const PROCESSING_RETRY_MS = 5 * 60000;
const CRON_BUDGET_MS = 150000;
const PROCESSING_LIMIT_MS = 60 * 60000;

export interface PostMetrics { likes: number | null; comments: number | null; shares: number | null }
export type TargetKind = 'facebook' | 'instagram' | 'google' | 'linkedin' | 'pinterest';
export interface PostTarget { key: string; kind: TargetKind; name: string; status: 'pending' | 'posted' | 'failed' | 'deleted'; postId?: string; url?: string; error?: string; commentError?: string; containerId?: string; processingSince?: string; /** This account's text after an edit, when the post went to several. */ text?: string; deletedAt?: string; deletedBy?: string }
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'deleted';
interface PostDoc {
  _id: string;
  text: string;
  /** Text for one platform instead of `text`. */
  texts?: Partial<Record<TargetKind, string>>;
  link: string;
  imageFileId: string;
  /** All photos in order, the first being imageFileId. Older posts have only imageFileId. */
  imageFileIds?: string[];
  firstComment?: string;
  /** Older posts have none: 'post'. */
  postType?: PostType;
  videoFileId?: string;
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
  /** Copied from the platform too: all a carousel's pictures, and a video's own link. */
  imageExternals?: string[];
  videoExternal?: string;
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

/** The accounts connected now, as target keys: what is out on any other account stays hidden. */
export const connectedAccountKeys = async () => (await listPostTargets()).map((o) => o.key);
/** The account ids of those, as the inbox keeps them. */
export const connectedInboxAccounts = async () => (await connectedAccountKeys()).filter((k) => /^(facebook|instagram|google):/.test(k)).map((k) => k.slice(k.indexOf(':') + 1));
const NOT_OUT_YET: PostStatus[] = ['draft', 'scheduled', 'publishing'];

/* -------------------------------- publishing ------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const photosOf = (p: Pick<PostDoc, 'imageFileId' | 'imageFileIds'>) => (p.imageFileIds?.length ? p.imageFileIds : p.imageFileId ? [p.imageFileId] : []);

/** Instagram may still be processing the media: wait and try again for that reason only. */
async function publishInstagram(id: string, token: string, creationId: string): Promise<{ postId: string; url: string }> {
  let last: any;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await graph<{ id?: string }>(`${id}/media_publish`, { token, method: 'POST', params: { creation_id: creationId } });
      const link = await graph<{ permalink?: string }>(String(r.id), { token, params: { fields: 'permalink' } }).catch(() => ({ permalink: '' }));
      return { postId: String(r.id || ''), url: String(link.permalink || '') };
    } catch (e: any) {
      last = e;
      if (!/not ready|9007|processing/i.test(e?.message || '')) break; // only wait while Instagram is still processing the image
      await sleep(2000 * (i + 1));
    }
  }
  throw last;
}

async function publishTarget(post: PostDoc, t: PostTarget): Promise<{ postId: string; url: string }> {
  const id = t.key.slice(t.kind.length + 1);
  const photoUrls = photosOf(post).map(publicMediaUrl);
  const imageUrl = photoUrls[0] || '';
  const text = post.texts?.[t.kind] || post.text;
  const type = post.postType || 'post';
  if (type !== 'post') {
    if (t.kind !== 'facebook' && t.kind !== 'instagram') throw fail('VALIDATION', 'Videos, Reels and Stories go to Facebook and Instagram only.');
    const page = (await socialPages()).find((p) => (t.kind === 'facebook' ? p.id === id : p.igId === id));
    if (!page) throw fail('VALIDATION', 'This account is no longer connected.');
    return publishMedia(t.kind, { type, accountId: id, token: page.token, text, videoUrl: post.videoFileId ? publicMediaUrl(post.videoFileId) : '', imageUrl, containerId: t.containerId });
  }
  // the link goes in the text where the platform has no link of its own (photo captions, Instagram, LinkedIn with an image)
  const withLink = post.link ? `${text}\n\n${post.link}` : text;
  if (t.kind === 'facebook') {
    const page = (await socialPages()).find((p) => p.id === id);
    if (!page) throw fail('VALIDATION', 'This Facebook Page is no longer connected.');
    if (photoUrls.length > 1) {
      const media: Array<{ media_fbid: string }> = [];
      for (const url of photoUrls) {
        const photo = await graph<{ id?: string }>(`${id}/photos`, { token: page.token, method: 'POST', params: { url, published: 'false' } });
        media.push({ media_fbid: String(photo.id) });
      }
      const r = await graph<{ id?: string }>(`${id}/feed`, { token: page.token, method: 'POST', params: { message: withLink, attached_media: JSON.stringify(media) } });
      const pid = String(r.id || '');
      return { postId: pid, url: pid ? `https://www.facebook.com/${pid}` : '' };
    }
    const r = imageUrl
      ? await graph<{ id?: string; post_id?: string }>(`${id}/photos`, { token: page.token, method: 'POST', params: { url: imageUrl, caption: withLink } })
      : await graph<{ id?: string }>(`${id}/feed`, { token: page.token, method: 'POST', params: { message: text, ...(post.link ? { link: post.link } : {}) } });
    const pid = String((r as any).post_id || r.id || '');
    return { postId: pid, url: pid ? `https://www.facebook.com/${pid}` : '' };
  }
  if (t.kind === 'instagram') {
    const page = (await socialPages()).find((p) => p.igId === id);
    if (!page) throw fail('VALIDATION', 'This Instagram account is no longer connected.');
    if (!imageUrl) throw fail('VALIDATION', 'Instagram needs an image.');
    if (photoUrls.length > 1) {
      const children: string[] = [];
      for (const url of photoUrls) {
        const item = await graph<{ id?: string }>(`${id}/media`, { token: page.token, method: 'POST', params: { image_url: url, is_carousel_item: 'true' } });
        children.push(String(item.id));
      }
      const parent = await graph<{ id?: string }>(`${id}/media`, { token: page.token, method: 'POST', params: { media_type: 'CAROUSEL', children: children.join(','), caption: truncate(withLink, 2200) } });
      return publishInstagram(id, page.token, String(parent.id));
    }
    const c = await graph<{ id?: string }>(`${id}/media`, { token: page.token, method: 'POST', params: { image_url: imageUrl, caption: truncate(withLink, 2200) } });
    return publishInstagram(id, page.token, String(c.id));
  }
  if (t.kind === 'google') {
    const r = await gbpFetch<{ name?: string; searchUrl?: string }>(`https://mybusiness.googleapis.com/v4/${id}/localPosts`, { body: {
      languageCode: 'en-IN', summary: truncate(text, 1500), topicType: 'STANDARD',
      ...(imageUrl ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }] } : {}),
      ...(post.link ? { callToAction: { actionType: 'LEARN_MORE', url: post.link } } : {}),
    } });
    return { postId: String(r.name || ''), url: String(r.searchUrl || '') };
  }
  if (t.kind === 'linkedin') {
    const img = post.imageFileId ? await readFile(post.imageFileId) : null;
    const r = await postToLinkedIn({ text: img ? withLink : text, image: img ? { data: img.data, mime: img.mime } : null, link: img ? '' : post.link });
    return { postId: r.id, url: r.url };
  }
  const pin = await pinToPinterest({ text, imageUrl, link: post.link, title: text.split('\n')[0] });
  return { postId: pin.id, url: pin.url };
}

/** The first comment, right after a post; the post stays posted whatever happens to it. */
async function addFirstComment(post: PostDoc, t: PostTarget, postId: string): Promise<string> {
  if (!post.firstComment || post.postType === 'story' || (t.kind !== 'facebook' && t.kind !== 'instagram')) return '';
  try {
    const id = t.key.slice(t.kind.length + 1);
    const page = (await socialPages()).find((p) => (t.kind === 'facebook' ? p.id === id : p.igId === id));
    if (!page) return 'This account is no longer connected.';
    await graph(`${postId}/comments`, { token: page.token, method: 'POST', params: { message: post.firstComment } });
    return '';
  } catch (e: any) {
    return truncate(e?.message || String(e), 300);
  }
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
    if (t.status === 'posted' || t.status === 'deleted') { targets.push(t); continue; }
    try {
      const r = await publishTarget(post, t);
      const commentError = await addFirstComment(post, t, r.postId);
      targets.push({ ...t, status: 'posted', postId: r.postId, url: r.url, error: '', ...(commentError ? { commentError } : {}) });
    } catch (e: any) {
      if (e instanceof StillProcessing) {
        const since = t.processingSince || now.toISOString();
        if (now.getTime() - Date.parse(since) < PROCESSING_LIMIT_MS) {
          targets.push({ ...t, status: 'pending', containerId: e.containerId, processingSince: since, error: '' });
          continue;
        }
        targets.push({ ...t, status: 'failed', containerId: undefined, processingSince: undefined, error: 'Instagram did not finish processing this video within an hour.' });
        continue;
      }
      // a retry starts again: a container that failed cannot be used
      targets.push({ ...t, status: 'failed', containerId: undefined, processingSince: undefined, error: truncate(e?.message || String(e), 300) });
    }
  }
  if (targets.some((t) => t.status === 'pending')) {
    await c.updateOne({ _id: id }, { $set: { targets, status: 'scheduled', scheduledAt: new Date(now.getTime() + PROCESSING_RETRY_MS), updatedAt: new Date() } });
    return c.findOne({ _id: id });
  }
  const ok = targets.filter((t) => t.status === 'posted').length;
  const failedCount = targets.filter((t) => t.status === 'failed').length;
  const status: PostStatus = !failedCount ? 'published' : ok ? 'partial' : 'failed';
  await c.updateOne({ _id: id }, { $set: { targets, status, updatedAt: new Date(), ...(ok ? { publishedAt: new Date() } : {}) } });
  // posted everywhere: the platforms have the video now, and it would only take up the company's storage
  if (status === 'published' && post.videoFileId) {
    await deleteFile(post.videoFileId);
    await c.updateOne({ _id: id }, { $set: { videoFileId: '' } });
  }
  return c.findOne({ _id: id });
}

/** Cron: due scheduled posts of every company with the post scheduler. */
export async function runPostsCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const started = Date.now();
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.socialPosts) continue;
    try {
      const r = await runWithTenant(tenant, async () => {
        const due = await (await postsCol()).find({ status: 'scheduled', scheduledAt: { $lte: now } }, { projection: { _id: 1 } }).limit(20).toArray();
        const res: Record<string, number> = {};
        for (const d of due) {
          // a video can take a minute and a half: leave the rest for the next run rather than be cut off mid-post
          if (Date.now() - started > CRON_BUDGET_MS) break;
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

export interface PostView { id: string; text: string; texts: Partial<Record<TargetKind, string>>; firstComment: string; link: string; imageFileId: string; imageFileIds: string[]; imageUrls: string[]; imageUrl: string; targets: PostTarget[]; scheduledAt: string; status: PostStatus; createdBy: string; publishedAt: string; metrics: PostMetrics | null; postType: PostType; videoFileId: string; videoUrl: string }
/** What the screen may show: a post that is out only with the accounts still connected, and none if it has none left. */
function shownView(p: PostDoc, keys: string[]): PostView | null {
  if (NOT_OUT_YET.includes(p.status)) return view(p);
  const targets = p.targets.filter((t) => keys.includes(t.key));
  return targets.length ? view({ ...p, targets }) : null;
}
const view = (p: PostDoc): PostView => ({
  id: p._id, text: p.text, texts: p.texts || {}, firstComment: p.firstComment || '', link: p.link, imageFileId: p.imageFileId, imageFileIds: photosOf(p),
  imageUrls: photosOf(p).length ? photosOf(p).map((f) => `/api/files/${f}`) : p.imageExternals?.length ? p.imageExternals : p.imageExternal ? [p.imageExternal] : [], imageUrl: p.imageFileId ? `/api/files/${p.imageFileId}` : p.imageExternal || '', targets: p.targets, scheduledAt: p.scheduledAt.toISOString(),
  status: p.status, createdBy: p.createdBy, publishedAt: p.publishedAt ? p.publishedAt.toISOString() : '', metrics: p.metrics || null,
  postType: p.postType || 'post', videoFileId: p.videoFileId || '', videoUrl: p.videoFileId ? `/api/files/${p.videoFileId}` : p.videoExternal || '',
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
  const q = String(d?.q || '').trim().slice(0, 100);
  const account = String(d?.account || '');
  const filter = {
    ...(statuses ? { status: { $in: statuses }, scheduledAt: range } : { $or: [{ status: 'draft' as const }, { scheduledAt: range }] }),
    ...(q ? { text: { $regex: escapeRegex(q), $options: 'i' } } : {}),
    ...(account ? { 'targets.key': account } : {}),
  };
  const targets = await listPostTargets();
  const keys = targets.map((o) => o.key);
  const rows = await (await postsCol()).find({ $and: [filter, { $or: [{ status: { $in: NOT_OUT_YET } }, { 'targets.key': { $in: account ? keys.filter((k) => k === account) : keys } }] }] } as any).sort({ scheduledAt: -1 }).skip(skip).limit(limit + 1).toArray();
  return { posts: rows.slice(0, limit).map((p) => shownView(p, keys)).filter((p): p is PostView => !!p), targets, hasMore: rows.length > limit };
}

const LINK_RE = /^https:\/\/[^\s]+$/i;

/** The post's content; a draft may still be unfinished (no account yet, no image for Instagram). */
async function readPost(d: any, draft: boolean) {
  const text = String(d?.text || '').trim();
  const link = String(d?.link || '').trim();
  const postType: PostType = (['video', 'reel', 'story'] as string[]).includes(d?.postType) ? d.postType : 'post';
  const videoFileId = postType === 'post' ? '' : String(d?.videoFileId || '');
  // a reel's photo is its cover; a story is one photo or one video; a Facebook video has none
  const asked = [...new Set((Array.isArray(d?.imageFileIds) ? d.imageFileIds : d?.imageFileId ? [d.imageFileId] : []).map(String))] as string[];
  const imageFileIds = postType === 'post' ? asked : postType === 'reel' ? asked.slice(0, 1) : postType === 'story' && !videoFileId ? asked.slice(0, 1) : [];
  const imageFileId = imageFileIds[0] || '';
  if (imageFileIds.length > MAX_PHOTOS) throw fail('VALIDATION', `A post can have up to ${MAX_PHOTOS} photos.`);
  if (postType === 'post' && !text && !(draft && imageFileId)) throw fail('VALIDATION', 'Write the post first.');
  if (videoFileId) {
    const info = await statFile(videoFileId);
    if (!info || info.category !== POST_VIDEO_CATEGORY) throw fail('VALIDATION', 'Upload the video again.');
  }
  if (!draft && (postType === 'video' || postType === 'reel') && !videoFileId) throw fail('VALIDATION', `Add a video for this ${postType}.`);
  if (!draft && postType === 'story' && !videoFileId && !imageFileId) throw fail('VALIDATION', 'Add a photo or a video for this story.');
  if (link && !LINK_RE.test(link)) throw fail('VALIDATION', 'The link must start with https://');
  const options = await listPostTargets();
  const keys = [...new Set((Array.isArray(d?.targets) ? d.targets : []).map(String))] as string[];
  if (!keys.length && !draft) throw fail('VALIDATION', 'Choose where to post.');
  const chosen = keys.map((k) => options.find((o) => o.key === k));
  if (chosen.some((o) => !o)) throw fail('VALIDATION', 'One of the chosen accounts is no longer connected. Reload the page.');
  for (const f of imageFileIds) {
    const info = await statFile(f);
    if (!info || info.category !== POST_IMAGE_CATEGORY) throw fail('VALIDATION', 'Upload the image again.');
  }
  const kinds = [...new Set((chosen as TargetOption[]).map((o) => o.kind))];
  if (postType === 'video' && kinds.some((k) => k !== 'facebook')) throw fail('VALIDATION', 'A video post goes to Facebook only. For Instagram, choose Reel.');
  if ((postType === 'reel' || postType === 'story') && kinds.some((k) => k !== 'facebook' && k !== 'instagram')) throw fail('VALIDATION', 'Reels and Stories go to Facebook and Instagram only.');
  // only for the platforms chosen; an empty one means the common text
  const texts: Partial<Record<TargetKind, string>> = {};
  for (const k of kinds) {
    const own = String(d?.texts?.[k] || '').trim();
    if (own) texts[k] = own;
  }
  const textOf = (k: TargetKind) => texts[k] || text;
  const firstComment = postType !== 'story' && kinds.some((k) => k === 'facebook' || k === 'instagram') ? String(d?.firstComment || '').trim() : '';
  if (firstComment.length > 2000) throw fail('VALIDATION', 'The first comment can be up to 2000 characters.');
  if (!draft) {
    for (const o of chosen as TargetOption[]) {
      const own = textOf(o.kind);
      if (postType === 'post' && o.needsImage && !imageFileId) throw fail('VALIDATION', `${o.kind === 'instagram' ? 'Instagram' : 'Pinterest'} needs an image.`);
      if (o.kind === 'google' && own.length > 1500) throw fail('VALIDATION', 'Google Business Profile posts can be up to 1500 characters.');
      if (o.kind === 'instagram' && own.length > 2200) throw fail('VALIDATION', 'Instagram captions can be up to 2200 characters.');
      if (o.kind === 'instagram' && (own.match(/#[\p{L}\p{N}_]+/gu) || []).length > MAX_HASHTAGS) throw fail('VALIDATION', `Instagram allows up to ${MAX_HASHTAGS} hashtags in a caption.`);
    }
  }
  if (text.length > 3000 || Object.values(texts).some((v) => (v as string).length > 3000)) throw fail('VALIDATION', 'Posts can be up to 3000 characters.');
  return { postType, videoFileId, text, texts, firstComment, link: postType === 'post' ? link : '', imageFileId, imageFileIds, targets: (chosen as TargetOption[]).map((o) => ({ key: o.key, kind: o.kind, name: o.name, status: 'pending' as const })) };
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

const accountOf = (t: PostTarget) => t.key.slice(t.kind.length + 1);
const isGoogleName = (t: PostTarget) => !!t.postId && t.postId.startsWith(`${accountOf(t)}/localPosts/`);

/**
 * Change the text of a post already out, on one account: Facebook (Meta allows only posts this app made) or Google.
 * Instagram has no caption editing. With several accounts, the others keep their text.
 */
export async function editPublishedPost(d: any, ctx: Ctx): Promise<PostView> {
  const id = String(d?.id || '');
  const text = String(d?.text || '').trim();
  if (!text) throw fail('VALIDATION', 'Write the post first.');
  if (text.length > 3000) throw fail('VALIDATION', 'Posts can be up to 3000 characters.');
  const c = await postsCol();
  const post = await c.findOne({ _id: id });
  if (!post) throw fail('NOT_FOUND', 'Post not found');
  const live = post.targets.filter((x) => x.status === 'posted' && x.postId);
  const t = d?.target ? live.find((x) => x.key === String(d.target)) : live.length === 1 ? live[0] : null;
  if (!t) throw fail('VALIDATION', 'Choose which account to change.');
  if (t.kind === 'instagram') throw fail('VALIDATION', 'Instagram does not let an app change a caption. Delete the post and post it again, which loses its likes and comments.');
  if (t.kind !== 'facebook' && t.kind !== 'google') throw fail('VALIDATION', 'Change this one on the platform itself.');
  if (post.postType === 'story') throw fail('VALIDATION', 'A story has no text to change.');
  if (t.kind === 'facebook') {
    const page = (await socialPages()).find((p) => p.id === accountOf(t));
    if (!page) throw fail('VALIDATION', 'This Facebook Page is no longer connected.');
    // on a photo post the link is part of the text, so it stays there
    const keepLink = post.link && photosOf(post).length && !text.includes(post.link);
    await graph(t.postId!, { token: page.token, method: 'POST', params: { message: keepLink ? `${text}\n\n${post.link}` : text } });
  } else {
    if (text.length > 1500) throw fail('VALIDATION', 'Google Business Profile posts can be up to 1500 characters.');
    if (!isGoogleName(t)) throw fail('VALIDATION', 'This Google post cannot be changed here.');
    await gbpFetch(`https://mybusiness.googleapis.com/v4/${t.postId}?updateMask=summary`, { method: 'PATCH', body: { summary: text } });
  }
  const now = new Date();
  // one account: the post's text is that text. Several: only this account's, the others keep theirs
  const r = post.targets.length === 1
    ? await c.findOneAndUpdate({ _id: id }, { $set: { text, updatedAt: now }, $unset: { [`texts.${t.kind}`]: '' } }, { returnDocument: 'after' })
    : await c.findOneAndUpdate({ _id: id, 'targets.key': t.key }, { $set: { 'targets.$.text': text, updatedAt: now } }, { returnDocument: 'after' });
  await auditLog(ctx, 'Published Post Edited', 'Post', id, `${t.name}: ${truncate(text, 80)}`);
  return view(r || post);
}

/** Remove it from one account. Throws what the platform says, so that account stays as it was. */
async function removeFromPlatform(t: PostTarget): Promise<void> {
  if (t.kind === 'google') {
    if (!isGoogleName(t)) throw new Error('This Google post cannot be deleted here.');
    await gbpFetch(`https://mybusiness.googleapis.com/v4/${t.postId}`, { method: 'DELETE' });
    return;
  }
  const id = accountOf(t);
  const page = (await socialPages()).find((p) => (t.kind === 'facebook' ? p.id === id : p.igId === id));
  if (!page) throw new Error('This account is no longer connected.');
  const r = await graph<{ success?: boolean }>(t.postId!, { token: page.token, method: 'DELETE' });
  if (r?.success === false) throw new Error(`${t.kind === 'facebook' ? 'Facebook' : 'Instagram'} did not delete it.`);
}

/** Delete a published post from the accounts chosen. Each is saved as it happens; a refusal leaves that account as it was. */
export async function deletePublishedPost(d: any, ctx: Ctx): Promise<{ post: PostView; deleted: string[]; failed: Array<{ key: string; name: string; error: string }> }> {
  const id = String(d?.id || '');
  if (d?.confirm !== true) throw fail('VALIDATION', 'Confirm the delete first.');
  const c = await postsCol();
  const post = await c.findOne({ _id: id });
  if (!post) throw fail('NOT_FOUND', 'Post not found');
  if (post.status !== 'published' && post.status !== 'partial') throw fail('VALIDATION', 'Only a post that is out can be deleted from the platforms.');
  const keys = [...new Set((Array.isArray(d?.targets) ? d.targets : []).map(String))] as string[];
  if (!keys.length) throw fail('VALIDATION', 'Choose where to delete it from.');
  const chosen = keys.map((k) => post.targets.find((x) => x.key === k));
  if (chosen.some((x) => !x || x.status !== 'posted' || !x.postId || !['facebook', 'instagram', 'google'].includes(x.kind))) throw fail('VALIDATION', 'One of those accounts cannot be deleted from here. Reload the page.');
  const deleted: string[] = [];
  const failed: Array<{ key: string; name: string; error: string }> = [];
  for (const t of chosen as PostTarget[]) {
    try {
      await removeFromPlatform(t);
      await c.updateOne({ _id: id, 'targets.key': t.key }, { $set: { 'targets.$.status': 'deleted', 'targets.$.deletedAt': new Date().toISOString(), 'targets.$.deletedBy': ctx.user?.name || 'System', updatedAt: new Date() } });
      deleted.push(t.name);
    } catch (e: any) {
      const said = truncate(String(e?.message || e), 300);
      failed.push({ key: t.key, name: t.name, error: t.kind === 'instagram' && /permission/i.test(said) ? `${said} Deleting on Instagram needs a Meta permission this app may not have yet.` : said });
    }
  }
  const now = (await c.findOne({ _id: id })) || post;
  const posted = now.targets.filter((x) => x.status === 'posted').length;
  const bad = now.targets.filter((x) => x.status === 'failed').length;
  const status: PostStatus = now.targets.every((x) => x.status === 'deleted') ? 'deleted' : !bad ? 'published' : posted ? 'partial' : 'failed';
  const r = await c.findOneAndUpdate({ _id: id }, { $set: { status, updatedAt: new Date() } }, { returnDocument: 'after' });
  if (deleted.length) await auditLog(ctx, 'Published Post Deleted', 'Post', id, truncate(`${deleted.join(', ')}${failed.length ? ` · refused by ${failed.map((f) => f.name).join(', ')}` : ''} · ${post.text}`, 300));
  return { post: view(r || now), deleted, failed };
}

/** Move a scheduled post to another time (the planner's drag), keeping everything else. */
export async function reschedulePost(d: any, ctx: Ctx): Promise<PostView> {
  const id = String(d?.id || '');
  if (!d?.scheduledAt) throw fail('VALIDATION', 'Choose a valid date and time.');
  const now = new Date();
  const when = readWhen(d, now);
  // the filter is the guard: a post the cron has just taken is no longer moved
  const r = await (await postsCol()).findOneAndUpdate({ _id: id, status: 'scheduled' }, { $set: { scheduledAt: when, updatedAt: now } }, { returnDocument: 'after' });
  if (!r) throw fail('VALIDATION', 'Only a scheduled post can be moved. This one may have just been posted.');
  await auditLog(ctx, 'Post Rescheduled', 'Post', id, when.toISOString());
  return view(r);
}

export async function getPost(d: any): Promise<{ post: PostView }> {
  const p = await (await postsCol()).findOne({ _id: String(d?.id || '') });
  const post = p ? shownView(p, await connectedAccountKeys()) : null;
  if (!post) throw fail('NOT_FOUND', 'Post not found');
  return { post };
}

export async function retryPost(d: any, ctx: Ctx): Promise<PostView> {
  const p = await publishPost(String(d?.id || ''), { retry: true });
  if (!p) throw fail('NOT_FOUND', 'Post not found');
  await auditLog(ctx, 'Post Retried', 'Post', p._id, p.status);
  return view(p);
}

export async function deletePost(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const id = String(d?.id || '');
  const video = (await (await postsCol()).findOne({ _id: id }, { projection: { videoFileId: 1 } }))?.videoFileId;
  const r = await (await postsCol()).deleteOne({ _id: id, status: { $in: ['draft', 'scheduled', 'failed', 'deleted'] } });
  if (!r.deletedCount) throw fail('VALIDATION', 'Only a draft, a scheduled post, or one that failed everywhere, can be removed here. To remove a published post, use Delete from platforms.');
  if (video) await deleteFile(video);
  await auditLog(ctx, 'Post Deleted', 'Post', id, '');
  return { ok: true };
}

export const actions: ActionMap = {
  listPosts: { fn: (d) => listPosts(d), perm: 'marketing.manage' },
  getPost: { fn: (d) => getPost(d), perm: 'marketing.manage' },
  createPost: { fn: (d, ctx) => createPost(d, ctx), perm: 'marketing.manage' },
  updatePost: { fn: (d, ctx) => updatePost(d, ctx), perm: 'marketing.manage' },
  reschedulePost: { fn: (d, ctx) => reschedulePost(d, ctx), perm: 'marketing.manage' },
  editPublishedPost: { fn: (d, ctx) => editPublishedPost(d, ctx), perm: 'marketing.manage' },
  deletePublishedPost: { fn: (d, ctx) => deletePublishedPost(d, ctx), perm: 'marketing.manage' },
  retryPost: { fn: (d, ctx) => retryPost(d, ctx), perm: 'marketing.manage' },
  deletePost: { fn: (d, ctx) => deletePost(d, ctx), perm: 'marketing.manage' },
  uploadPostImage: { fn: (d, ctx) => uploadPostImage(d, ctx), perm: 'marketing.manage' },
};
