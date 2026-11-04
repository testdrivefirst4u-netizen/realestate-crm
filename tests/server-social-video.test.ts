/** Post scheduler › video: uploads in pieces, Instagram's processing wait, Facebook's upload steps, storage cleanup, the public link. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { createPost, deletePost, mediaSig, publicMediaUrl, retryPost, runPostsCron, uploadPostImage } from '../server/modules/socialPosts';
import { discardPostVideo, finishPostVideo, mediaTiming, sweepOrphanVideos, uploadPostVideoPart } from '../server/modules/socialPostVideo';
import { statFile } from '../server/modules/storage';
import { GET as mediaGET } from '../app/api/public/media/[companyId]/[fileId]/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: Array<{ host: string; path: string; method: string; params: Record<string, string>; headers: Record<string, string> }> = [];
let igStatus = 'FINISHED';
const ctx = { user: { name: 'Asha', email: 'asha@video.test' } } as any;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const posted = (re: RegExp) => calls.filter((c) => c.method === 'POST' && re.test(`${c.host}${c.path}`));

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  const params = method === 'GET' ? Object.fromEntries(url.searchParams) : Object.fromEntries(new URLSearchParams(String(init.body || '')));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  calls.push({ host: url.host, path, method, params, headers: init.headers || {} });
  if (url.host === 'rupload.facebook.com') return json(200, { success: true });
  if (path === '/IG1/media') return json(200, { id: 'CONT1' });
  if (path === '/CONT1') return json(200, { status_code: igStatus, status: igStatus === 'ERROR' ? 'Bad video format' : '' });
  if (path === '/IG1/media_publish') return json(200, { id: 'M9' });
  if (path === '/M9') return json(200, { permalink: 'https://www.instagram.com/reel/m9/' });
  if (path === '/PAGE1/video_reels' || path === '/PAGE1/video_stories') {
    if (params.upload_phase === 'start') return json(200, { video_id: 'V1', upload_url: 'https://rupload.facebook.com/video-upload/v23.0/V1' });
    return json(200, { success: true, post_id: 'PAGE1_STORY' });
  }
  if (path === '/PAGE1/videos') return json(200, { id: 'V2' });
  if (path === '/PAGE1/photos') return json(200, { id: 'PH9' });
  if (path === '/PAGE1/photo_stories') return json(200, { post_id: 'PAGE1_PS' });
  if (/\/comments$/.test(path)) return json(200, { id: 'cm1' });
  return json(404, { error: { message: `unexpected ${method} ${path}` } });
}

async function video(bytes = 'fake video bytes'): Promise<string> {
  const data = Buffer.from(bytes);
  const mid = Math.floor(data.length / 2);
  await inCo(() => uploadPostVideoPart({ uploadId: 'upload-1234', index: 1, base64: data.subarray(mid).toString('base64') }, ctx));
  await inCo(() => uploadPostVideoPart({ uploadId: 'upload-1234', index: 0, base64: data.subarray(0, mid).toString('base64') }, ctx));
  return (await inCo(() => finishPostVideo({ uploadId: 'upload-1234', parts: 2, name: 'tour.mp4', mime: 'video/mp4' }, ctx))).fileId;
}

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = 'secret';
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'APP_URL']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { socialPosts: true });
  calls = [];
  igStatus = 'FINISHED';
  mediaTiming.waitMs = 0;
  mediaTiming.everyMs = 0;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [{ id: 'PAGE1', name: 'Amaya', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' }] }));
});
afterEach(() => vi.unstubAllGlobals());

describe('upload', () => {
  it('puts the pieces together in order, and refuses what is not a video or not complete', async () => {
    const id = await video('0123456789');
    expect(await inCo(() => statFile(id))).toMatchObject({ mime: 'video/mp4', size: 10, category: 'Social post videos' });
    await expect(inCo(() => finishPostVideo({ uploadId: 'upload-5678', parts: 1, name: 'x.exe', mime: 'application/octet-stream' }, ctx))).rejects.toThrow(/MP4 or MOV/);
    await expect(inCo(() => finishPostVideo({ uploadId: 'upload-5678', parts: 2, name: 'x.mp4', mime: 'video/mp4' }, ctx))).rejects.toThrow(/did not arrive complete/);
    await expect(inCo(() => uploadPostVideoPart({ uploadId: 'bad id!', index: 0, base64: 'AA==' }, ctx))).rejects.toThrow(/Bad upload/);
  });

  it('removes a dropped video, but not one a post uses', async () => {
    const dropped = await video();
    await inCo(() => discardPostVideo({ fileId: dropped }));
    expect(await inCo(() => statFile(dropped))).toBeNull();
    const kept = await video();
    await inCo(() => createPost({ draft: true, postType: 'reel', text: 'Later', videoFileId: kept }, ctx));
    await inCo(() => discardPostVideo({ fileId: kept }));
    expect(await inCo(() => statFile(kept))).not.toBeNull();
  });

  it('the daily job removes old videos no post uses', async () => {
    const lost = await video();
    const used = await video();
    await inCo(() => createPost({ draft: true, postType: 'reel', text: 'Later', videoFileId: used }, ctx));
    const later = new Date(Date.now() + 8 * 86400000);
    expect(await inCo(() => sweepOrphanVideos(new Date()))).toBe(0);
    expect(await inCo(() => sweepOrphanVideos(later))).toBe(1);
    expect(await inCo(() => statFile(lost))).toBeNull();
    expect(await inCo(() => statFile(used))).not.toBeNull();
  });
});

describe('Instagram', () => {
  it('a reel waits for processing, publishes, adds the first comment, and the video then leaves storage', async () => {
    const v = await video();
    const p = await inCo(() => createPost({ postType: 'reel', text: 'Tour', firstComment: 'Book now', videoFileId: v, targets: ['instagram:IG1'] }, ctx));
    expect(p).toMatchObject({ status: 'published', postType: 'reel', videoFileId: '', videoUrl: '' });
    const made = posted(/IG1\/media$/)[0].params;
    expect(made).toMatchObject({ media_type: 'REELS', caption: 'Tour', share_to_feed: 'true' });
    expect(made.video_url).toMatch(/^https:\/\/crm\.example\.com\/api\/public\/media\/CMP-test\/[a-f0-9]{24}\?sig=/);
    expect(posted(/IG1\/media_publish/)[0].params.creation_id).toBe('CONT1');
    expect(p.targets[0].url).toBe('https://www.instagram.com/reel/m9/');
    expect(posted(/M9\/comments/)[0].params.message).toBe('Book now');
    expect(await inCo(() => statFile(v))).toBeNull();
  });

  it('still processing is not a failure: the next run goes on with the same container, without uploading again', async () => {
    const v = await video();
    igStatus = 'IN_PROGRESS';
    const p = await inCo(() => createPost({ postType: 'reel', text: 'Tour', videoFileId: v, targets: ['instagram:IG1'] }, ctx));
    expect(p.status).toBe('scheduled');
    expect(p.targets[0]).toMatchObject({ status: 'pending', containerId: 'CONT1' });
    expect(posted(/IG1\/media_publish/)).toHaveLength(0);
    expect(await inCo(() => statFile(v))).not.toBeNull();
    igStatus = 'FINISHED';
    expect(await runPostsCron(new Date(Date.now() + 6 * 60000))).toEqual({ test: { published: 1 } });
    expect(posted(/IG1\/media$/)).toHaveLength(1);
    expect(posted(/IG1\/media_publish/)).toHaveLength(1);
  });

  it('gives up after an hour, and Instagram rejecting the video says why; a retry starts again', async () => {
    const v = await video();
    igStatus = 'IN_PROGRESS';
    const p = await inCo(() => createPost({ postType: 'reel', text: 'Tour', videoFileId: v, targets: ['instagram:IG1'] }, ctx));
    expect(await runPostsCron(new Date(Date.now() + 61 * 60000))).toEqual({ test: { failed: 1 } });
    const c = await inCo(async () => (await col<any>('socialPosts')).findOne({ _id: p.id }));
    expect(c.targets[0].error).toMatch(/within an hour/);
    igStatus = 'ERROR';
    const again = await inCo(() => retryPost({ id: p.id }, ctx));
    expect(again.status).toBe('failed');
    expect(again.targets[0].error).toMatch(/Bad video format/);
    expect(posted(/IG1\/media$/)).toHaveLength(2);
    expect(await inCo(() => statFile(v))).not.toBeNull(); // kept for the next try
  });

  it('a story has no caption or comment, with a video or a photo', async () => {
    const v = await video();
    await inCo(() => createPost({ postType: 'story', firstComment: 'No', videoFileId: v, targets: ['instagram:IG1'] }, ctx));
    expect(posted(/IG1\/media$/)[0].params).toMatchObject({ media_type: 'STORIES' });
    expect(posted(/IG1\/media$/)[0].params.video_url).toBeTruthy();
    expect(posted(/IG1\/media$/)[0].params.caption).toBeUndefined();
    expect(posted(/\/comments$/)).toHaveLength(0);
    const img = await inCo(() => uploadPostImage({ name: 's.png', mime: 'image/png', base64: PNG.toString('base64') }, ctx));
    calls = [];
    await inCo(() => createPost({ postType: 'story', imageFileIds: [img.fileId], targets: ['instagram:IG1'] }, ctx));
    expect(posted(/IG1\/media$/)[0].params.image_url).toBeTruthy();
  });
});

describe('Facebook', () => {
  it('a reel: start, the file by link with the page token to Facebook only, finish', async () => {
    const v = await video();
    const p = await inCo(() => createPost({ postType: 'reel', text: 'Tour', videoFileId: v, targets: ['facebook:PAGE1'] }, ctx));
    expect(p.status).toBe('published');
    expect(p.targets[0]).toMatchObject({ postId: 'V1', url: 'https://www.facebook.com/reel/V1' });
    const steps = posted(/PAGE1\/video_reels/).map((c) => c.params);
    expect(steps[0].upload_phase).toBe('start');
    expect(steps[1]).toMatchObject({ upload_phase: 'finish', video_id: 'V1', video_state: 'PUBLISHED', description: 'Tour' });
    const up = calls.find((c) => c.host === 'rupload.facebook.com')!;
    expect(up.headers.Authorization).toBe('OAuth PT');
    expect(up.headers.file_url).toContain('/api/public/media/');
  });

  it('never sends the page token to an upload address that is not Facebook', async () => {
    const v = await video();
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/video_reels') && String(init.body).includes('upload_phase=start')) return json(200, { video_id: 'V1', upload_url: 'https://evil.example/steal' });
      return fake(input, init);
    }));
    await inCo(() => createPost({ postType: 'reel', text: 'Tour', videoFileId: v, targets: ['facebook:PAGE1'] }, ctx));
    expect(calls.some((c) => c.host === 'evil.example')).toBe(false);
    expect(calls.some((c) => c.host === 'rupload.facebook.com')).toBe(true);
  });

  it('a video post, a video story and a photo story', async () => {
    const a = await video();
    const vp = await inCo(() => createPost({ postType: 'video', text: 'Walkthrough', videoFileId: a, targets: ['facebook:PAGE1'] }, ctx));
    expect(vp.targets[0]).toMatchObject({ postId: 'V2', url: 'https://www.facebook.com/PAGE1/videos/V2' });
    expect(posted(/PAGE1\/videos/)[0].params).toMatchObject({ description: 'Walkthrough' });
    const b = await video();
    const vs = await inCo(() => createPost({ postType: 'story', videoFileId: b, targets: ['facebook:PAGE1'] }, ctx));
    expect(vs.targets[0].postId).toBe('PAGE1_STORY');
    const img = await inCo(() => uploadPostImage({ name: 's.png', mime: 'image/png', base64: PNG.toString('base64') }, ctx));
    const ps = await inCo(() => createPost({ postType: 'story', imageFileIds: [img.fileId], targets: ['facebook:PAGE1'] }, ctx));
    expect(ps.targets[0].postId).toBe('PAGE1_PS');
    expect(posted(/PAGE1\/photo_stories/)[0].params.photo_id).toBe('PH9');
  });
});

describe('rules', () => {
  it('each type goes where it can, and needs its media', async () => {
    const v = await video();
    await expect(inCo(() => createPost({ postType: 'video', text: 'x', videoFileId: v, targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/Facebook only/);
    await expect(inCo(() => createPost({ postType: 'reel', text: 'x', targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/Add a video/);
    await expect(inCo(() => createPost({ postType: 'story', targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/photo or a video/);
    await expect(inCo(() => createPost({ postType: 'reel', text: 'x', videoFileId: '507f1f77bcf86cd799439011', targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/Upload the video again/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('deleting a scheduled or draft post removes its video', async () => {
    const v = await video();
    const d = await inCo(() => createPost({ draft: true, postType: 'reel', text: 'x', videoFileId: v }, ctx));
    await inCo(() => deletePost({ id: d.id }, ctx));
    expect(await inCo(() => statFile(v))).toBeNull();
  });
});

describe('the public link', () => {
  const get = (fileId: string, sig: string, headers: Record<string, string> = {}) => mediaGET(new Request(`https://crm.example.com/api/public/media/CMP-test/${fileId}?sig=${sig}`, { headers }), { params: Promise.resolve({ companyId: 'CMP-test', fileId }) });

  it('serves a post video with the right signature, also in ranges, and nothing without it', async () => {
    const v = await video('0123456789');
    expect(await inCo(async () => publicMediaUrl(v))).toContain(v);
    const sig = await inCo(async () => mediaSig('CMP-test', v));
    const full = await get(v, sig);
    expect([full.status, full.headers.get('content-type'), await full.text()]).toEqual([200, 'video/mp4', '0123456789']);
    const part = await get(v, sig, { range: 'bytes=2-5' });
    expect([part.status, part.headers.get('content-range'), await part.text()]).toEqual([206, 'bytes 2-5/10', '2345']);
    expect((await get(v, sig, { range: 'bytes=50-' })).status).toBe(416);
    expect((await get(v, 'x'.repeat(sig.length))).status).toBe(404);
  });
});
