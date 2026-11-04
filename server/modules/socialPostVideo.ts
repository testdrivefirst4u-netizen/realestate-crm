/**
 * Post scheduler › video: uploads in pieces (the host limits a request to ~4.5 MB) and the platform steps for Facebook
 * videos and Reels, Instagram Reels, and Stories on both.
 *
 * Instagram = POST <ig>/media with media_type REELS | STORIES and a public link, then wait for the container's status_code
 *             to be FINISHED, then media_publish. A slow container is not an error: StillProcessing keeps its id so the
 *             next run goes on from there.
 * Facebook  = video: POST <page>/videos with file_url. Reel and video story: upload_phase start, the file by link through
 *             rupload.facebook.com, upload_phase finish. Photo story: an unpublished photo, then photo_stories.
 * Storage   = videos live in the company's file store only until posted everywhere (socialPosts.ts removes them); ones
 *             never attached to a post are removed when dropped in the screen, or after 7 days by the daily job.
 */
import type { ActionMap } from '../core/actions';
import type { Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col, filesBucket } from '../core/db';
import { fail } from '../core/errors';
import { runWithTenant } from '../core/tenant';
import { str, truncate } from '../core/utils';
import { graph, loadMetaConfig } from '../integrations/meta';
import { listActiveTenants } from '../platform/registry';
import { decodeBase64, deleteFile, saveFile, statFile } from './storage';

export const POST_VIDEO_CATEGORY = 'Social post videos';
export const MAX_VIDEO_BYTES = CFG.UPLOAD_MAX_BYTES;
const PART_B64 = 4_200_000;
const MAX_PARTS = Math.ceil(MAX_VIDEO_BYTES / 3_000_000);
const VIDEO_MIME = /^video\/(mp4|quicktime)$/;
const ORPHAN_DAYS = 7;
const DAY_MS = 86400000;
/** How long one run waits for Instagram to process a video (the request has 300 seconds in all). */
export const mediaTiming = { waitMs: 90000, everyMs: 5000 };

export type PostType = 'post' | 'video' | 'reel' | 'story';

const uploadsCol = () => col<any>(CFG.COLL.LIBRARY_UPLOADS);
const uploadIdOk = (v: unknown) => /^[a-z0-9-]{8,40}$/i.test(str(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------- upload --------------------------------- */

export async function uploadPostVideoPart(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const index = Number(d?.index);
  if (!uploadIdOk(d?.uploadId) || !Number.isInteger(index) || index < 0 || index >= MAX_PARTS) throw fail('VALIDATION', 'Bad upload piece');
  if (str(d?.base64).length > PART_B64) throw fail('VALIDATION', 'Upload piece is too large');
  const data = decodeBase64(d.base64);
  await (await uploadsCol()).updateOne(
    { _id: `video:${d.uploadId}:${index}` },
    { $set: { uploadId: `video:${d.uploadId}`, index, data, by: str(ctx.user?.email).toLowerCase(), createdAt: new Date() } },
    { upsert: true },
  );
  return { ok: true };
}

export async function finishPostVideo(d: any, ctx: Ctx): Promise<{ fileId: string; previewUrl: string }> {
  const parts = Number(d?.parts);
  const mime = str(d?.mime).toLowerCase();
  if (!VIDEO_MIME.test(mime)) throw fail('VALIDATION', 'Use an MP4 or MOV video.');
  if (!uploadIdOk(d?.uploadId) || !Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) throw fail('VALIDATION', 'Bad upload');
  const uploads = await uploadsCol();
  const uploadId = `video:${d.uploadId}`;
  const pieces = await uploads.find({ uploadId, by: str(ctx.user?.email).toLowerCase() }).sort({ index: 1 }).toArray();
  await uploads.deleteMany({ $or: [{ uploadId }, { createdAt: { $lt: new Date(Date.now() - DAY_MS) } }] });
  if (pieces.length !== parts || pieces.some((p, i) => p.index !== i)) throw fail('VALIDATION', 'The video did not arrive complete. Please try again.');
  const data = Buffer.concat(pieces.map((p) => Buffer.from(p.data.buffer ?? p.data)));
  if (data.length > MAX_VIDEO_BYTES) throw fail('VALIDATION', `The video is larger than ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB.`);
  const saved = await saveFile({ category: POST_VIDEO_CATEGORY, name: str(d?.name) || 'video.mp4', mime, data, uploadedBy: ctx.user?.name || 'System' });
  return { fileId: saved.fileId, previewUrl: saved.url };
}

/** A video picked and then dropped before saving; one a post uses is left alone. */
export async function discardPostVideo(d: any): Promise<{ ok: true }> {
  const fileId = str(d?.fileId);
  const info = await statFile(fileId);
  if (!info || info.category !== POST_VIDEO_CATEGORY) return { ok: true };
  if (await (await col<any>('socialPosts')).findOne({ videoFileId: fileId }, { projection: { _id: 1 } })) return { ok: true };
  await deleteFile(fileId);
  return { ok: true };
}

/** Videos of tabs closed before saving: no post uses them, and they take up the company's storage. */
export async function sweepOrphanVideos(now = new Date()): Promise<number> {
  const bucket = await filesBucket();
  const old = await bucket.find({ 'metadata.category': POST_VIDEO_CATEGORY, uploadDate: { $lt: new Date(now.getTime() - ORPHAN_DAYS * DAY_MS) } }).toArray();
  if (!old.length) return 0;
  const used = new Set((await (await col<any>('socialPosts')).distinct('videoFileId', { videoFileId: { $in: old.map((f) => f._id.toString()) } })).map(String));
  const orphans = old.filter((f) => !used.has(f._id.toString()));
  await Promise.all(orphans.map((f) => deleteFile(f._id.toString())));
  return orphans.length;
}

export async function runVideoSweepCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.socialPosts) continue;
    try {
      const n = await runWithTenant(tenant, () => sweepOrphanVideos(now));
      if (n) out[tenant.slug] = n;
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

/* --------------------------------- publishing ------------------------------ */

/** Instagram has not finished with the video yet: not a failure, carry on later with this container. */
export class StillProcessing extends Error {
  constructor(public containerId: string) {
    super('Instagram is still processing the video.');
  }
}

export interface MediaJob {
  type: PostType;
  /** Page id or Instagram account id. */
  accountId: string;
  token: string;
  text: string;
  videoUrl: string;
  imageUrl: string;
  /** A container from an earlier run still being processed. */
  containerId?: string;
}

async function waitForContainer(id: string, token: string): Promise<void> {
  const until = Date.now() + mediaTiming.waitMs;
  for (;;) {
    const s = await graph<{ status_code?: string; status?: string }>(id, { token, params: { fields: 'status_code,status' } });
    const code = String(s.status_code || '');
    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') throw fail('VALIDATION', `Instagram could not use this video${s.status ? `: ${truncate(String(s.status), 200)}` : '.'}`);
    if (Date.now() >= until) throw new StillProcessing(id);
    await sleep(mediaTiming.everyMs);
  }
}

async function instagramMedia(job: MediaJob): Promise<{ postId: string; url: string }> {
  let container = job.containerId || '';
  if (!container) {
    const params: Record<string, string> = job.type === 'reel'
      ? { media_type: 'REELS', video_url: job.videoUrl, caption: truncate(job.text, 2200), share_to_feed: 'true', ...(job.imageUrl ? { cover_url: job.imageUrl } : {}) }
      : { media_type: 'STORIES', ...(job.videoUrl ? { video_url: job.videoUrl } : { image_url: job.imageUrl }) };
    const c = await graph<{ id?: string }>(`${job.accountId}/media`, { token: job.token, method: 'POST', params });
    container = String(c.id || '');
    if (!container) throw fail('VALIDATION', 'Instagram did not accept the video.');
  }
  await waitForContainer(container, job.token);
  const r = await graph<{ id?: string }>(`${job.accountId}/media_publish`, { token: job.token, method: 'POST', params: { creation_id: container } });
  const link = await graph<{ permalink?: string }>(String(r.id), { token: job.token, params: { fields: 'permalink' } }).catch(() => ({ permalink: '' }));
  return { postId: String(r.id || ''), url: String(link.permalink || '') };
}

/** Facebook fetches the file from its link. */
async function hostedUpload(uploadUrl: string, videoId: string, token: string, fileUrl: string): Promise<void> {
  const cfg = await loadMetaConfig();
  const fallback = `https://rupload.facebook.com/video-upload/${cfg.graphVersion}/${videoId}`;
  // the page token goes in this request, so only ever to Facebook's upload host
  let target = fallback;
  try {
    if (new URL(uploadUrl).host === 'rupload.facebook.com') target = uploadUrl;
  } catch { /* the usual address */ }
  const res = await fetch(target, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: fileUrl }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw fail('VALIDATION', `Facebook did not accept the video (${res.status}). ${truncate(body, 200)}`);
  }
}

async function facebookMedia(job: MediaJob): Promise<{ postId: string; url: string }> {
  const { accountId: page, token, text } = job;
  if (job.type === 'video') {
    const r = await graph<{ id?: string }>(`${page}/videos`, { token, method: 'POST', params: { file_url: job.videoUrl, description: text } });
    const id = String(r.id || '');
    return { postId: id, url: id ? `https://www.facebook.com/${page}/videos/${id}` : '' };
  }
  if (job.type === 'story' && !job.videoUrl) {
    const photo = await graph<{ id?: string }>(`${page}/photos`, { token, method: 'POST', params: { url: job.imageUrl, published: 'false' } });
    const r = await graph<{ post_id?: string }>(`${page}/photo_stories`, { token, method: 'POST', params: { photo_id: String(photo.id) } });
    return { postId: String(r.post_id || ''), url: '' };
  }
  const edge = job.type === 'reel' ? 'video_reels' : 'video_stories';
  const start = await graph<{ video_id?: string; upload_url?: string }>(`${page}/${edge}`, { token, method: 'POST', params: { upload_phase: 'start' } });
  const videoId = String(start.video_id || '');
  if (!videoId) throw fail('VALIDATION', 'Facebook did not start the video upload.');
  await hostedUpload(String(start.upload_url || ''), videoId, token, job.videoUrl);
  const done = await graph<{ post_id?: string }>(`${page}/${edge}`, {
    token, method: 'POST',
    params: { upload_phase: 'finish', video_id: videoId, ...(job.type === 'reel' ? { video_state: 'PUBLISHED', description: text } : {}) },
  });
  if (job.type === 'story') return { postId: String(done.post_id || videoId), url: '' };
  return { postId: videoId, url: `https://www.facebook.com/reel/${videoId}` };
}

export function publishMedia(kind: 'facebook' | 'instagram', job: MediaJob): Promise<{ postId: string; url: string }> {
  return kind === 'instagram' ? instagramMedia(job) : facebookMedia(job);
}

export const actions: ActionMap = {
  uploadPostVideoPart: { fn: (d, ctx) => uploadPostVideoPart(d, ctx), perm: 'marketing.manage' },
  finishPostVideo: { fn: (d, ctx) => finishPostVideo(d, ctx), perm: 'marketing.manage' },
  discardPostVideo: { fn: (d) => discardPostVideo(d), perm: 'marketing.manage' },
};
