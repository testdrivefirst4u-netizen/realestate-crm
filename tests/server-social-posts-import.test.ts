/** Post scheduler › old posts: copied from Facebook and Instagram once, without posts made in the CRM, read only. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { deletePost, deletePublishedPost, editPublishedPost, listPosts, runPostsCron, updatePost } from '../server/modules/socialPosts';
import { getPostComments, importOldPosts, runImportPostsCron, syncOldPosts } from '../server/modules/socialPostsImport';

let t: Awaited<ReturnType<typeof startTestDb>>;
let igFails = false;
let fbPages = 0;
const now = new Date('2026-11-04T10:00:00Z');
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let edits: Array<{ path: string; body: string }> = [];
let refuseCounts = false;
let refuseComments = false;

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  if (String(init.method || 'GET') === 'DELETE') return json(200, { success: true });
  if (String(init.method || 'GET') === 'POST') { edits.push({ path, body: String(init.body) }); return json(200, { success: true }); }
  if (refuseCounts && /reactions|like_count/.test(url.searchParams.get('fields') || '')) return json(400, { error: { message: 'Missing permission', code: 10 } });
  if (refuseComments && /comments\.summary/.test(url.searchParams.get('fields') || '')) return json(400, { error: { message: 'Needs pages_read_user_content', code: 10 } });
  if (path === '/PAGE1_1/comments') return json(200, { data: [{ id: 'C1', from: { name: 'Neha' }, message: 'Price?', created_time: '2026-10-21T06:00:00+0000' }, { id: 'C2', message: 'Nice', created_time: '2026-10-22T06:00:00+0000' }] });
  if (path === '/M1/comments') return json(200, { data: [{ id: 'C3', username: 'ravi', text: 'Lovely', timestamp: '2026-10-26T06:00:00+0000' }] });
  if (path === '/PAGE1/published_posts') {
    fbPages += 1;
    if (!url.searchParams.get('after')) return json(200, { data: [
      { id: 'PAGE1_1', message: 'Diwali offer', created_time: '2026-10-20T06:00:00+0000', permalink_url: 'https://www.facebook.com/PAGE1/posts/1', full_picture: 'https://cdn.example/1.jpg', ...(refuseCounts ? {} : { reactions: { summary: { total_count: 12 } }, ...(refuseComments ? {} : { comments: { summary: { total_count: 3 } } }), shares: { count: 2 } }) },
      { id: 'PAGE1_CRM', message: 'Made in the CRM', created_time: '2026-10-10T06:00:00+0000', reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 1 } } },
    ], paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' } });
    return json(200, { data: [
      { id: 'PAGE1_2', message: 'Site visit', created_time: '2026-03-01T06:00:00+0000' },
      { id: 'PAGE1_OLD', message: 'Too old', created_time: '2024-01-01T06:00:00+0000' },
    ], paging: { cursors: { after: 'MORE' }, next: 'https://graph.facebook.com/next' } });
  }
  if (path === '/IG1/media') {
    if (igFails) return json(400, { error: { message: 'Instagram said no', code: 10 } });
    return json(200, { data: [
      { id: 'M1', like_count: 40, comments_count: 5, caption: 'Tower view', media_type: 'IMAGE', media_url: 'https://cdn.example/m1.jpg', permalink: 'https://www.instagram.com/p/m1/', timestamp: '2026-10-25T06:00:00+0000' },
      { id: 'M2', media_type: 'VIDEO', media_url: 'https://cdn.example/m2.mp4', thumbnail_url: 'https://cdn.example/m2.jpg', permalink: 'https://www.instagram.com/p/m2/', timestamp: '2026-10-26T06:00:00+0000' },
    ] });
  }
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
  igFails = false;
  fbPages = 0;
  edits = [];
  refuseCounts = false;
  refuseComments = false;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [{ id: 'PAGE1', name: 'Amaya', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' }] });
    await (await col<any>('socialPosts')).insertOne({ _id: 'POST-0001', text: 'Made in the CRM', link: '', imageFileId: '', status: 'published', scheduledAt: new Date('2026-10-10T06:00:00Z'), targets: [{ key: 'facebook:PAGE1', kind: 'facebook', name: 'Amaya', status: 'posted', postId: 'PAGE1_CRM' }], createdBy: 'Asha' });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('old posts', () => {
  it('Sync old posts reads the whole history, with likes, comments and shares', async () => {
    const r = await inCo(() => syncOldPosts({}, ctx));
    expect(r.imported).toBe(5); // the 2024 post too
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['published'] }));
    expect(posts.find((p) => p.text === 'Diwali offer')!.metrics).toEqual({ likes: 12, comments: 3, shares: 2 });
    expect(posts.find((p) => p.text === 'Tower view')!.metrics).toEqual({ likes: 40, comments: 5, shares: null });
  });

  it('still copies the posts when Meta refuses the counts', async () => {
    refuseCounts = true;
    const r = await inCo(() => importOldPosts({ now }));
    expect(r).toMatchObject({ imported: 4, errors: [] });
    expect(r.warnings).toEqual([expect.stringMatching(/^Amaya: counts are missing. Meta said: .*Missing permission/), expect.stringMatching(/^@amaya: counts are missing. Meta said: .*Missing permission/)]);
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['published'] }));
    expect(posts.find((p) => p.text === 'Diwali offer')!.metrics).toEqual({ likes: null, comments: null, shares: null });
  });

  it('keeps the reactions when only the comment count is refused, and says so', async () => {
    refuseComments = true;
    const r = await inCo(() => importOldPosts({ now }));
    expect(r.warnings).toEqual([expect.stringMatching(/^Amaya: some counts are missing. Meta said: .*Needs pages_read_user_content/)]);
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['published'] }));
    expect(posts.find((p) => p.text === 'Diwali offer')!.metrics).toEqual({ likes: 12, comments: null, shares: 2 });
  });

  it('a post made in the CRM gets the counts too, without being copied', async () => {
    await inCo(() => importOldPosts({ now }));
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['published'] }));
    expect(posts.filter((p) => p.text === 'Made in the CRM')).toHaveLength(1);
    expect(posts.find((p) => p.id === 'POST-0001')!.metrics).toMatchObject({ likes: 7, comments: 1 });
  });

  it('reads the comments of a Facebook or Instagram post when it is opened', async () => {
    await inCo(() => importOldPosts({ now }));
    expect((await inCo(() => getPostComments({ id: 'IMP-facebook-PAGE1_1' }))).comments).toEqual([
      { id: 'C1', author: 'Neha', text: 'Price?', at: '2026-10-21T06:00:00+0000' }, { id: 'C2', author: 'Facebook user', text: 'Nice', at: '2026-10-22T06:00:00+0000' },
    ]);
    expect((await inCo(() => getPostComments({ id: 'IMP-instagram-M1' }))).comments).toEqual([{ id: 'C3', author: 'ravi', text: 'Lovely', at: '2026-10-26T06:00:00+0000' }]);
    expect(await inCo(() => getPostComments({ id: 'missing' }))).toEqual({ comments: [] });
  });

  it('the list comes in pages, by status', async () => {
    await inCo(() => syncOldPosts({}, ctx));
    const q = { from: '2000-01-01T00:00:00Z', statuses: ['published'], limit: 4 };
    const first = await inCo(() => listPosts({ ...q, skip: 0 }));
    expect([first.posts.length, first.hasMore]).toEqual([4, true]);
    const next = await inCo(() => listPosts({ ...q, skip: 4 }));
    expect([next.posts.length, next.hasMore]).toEqual([2, false]);
    expect((await inCo(() => listPosts({ ...q, statuses: ['draft'] }))).posts).toEqual([]);
  });

  it('changes the text of a post on one Facebook Page, on Facebook first; Instagram is refused', async () => {
    await inCo(() => importOldPosts({ now }));
    const p = await inCo(() => editPublishedPost({ id: 'IMP-facebook-PAGE1_1', text: 'New words' }, ctx));
    expect(p.text).toBe('New words');
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe('/PAGE1_1');
    expect(new URLSearchParams(edits[0].body).get('message')).toBe('New words');
    await expect(inCo(() => editPublishedPost({ id: 'IMP-instagram-M1', text: 'Nope' }, ctx))).rejects.toThrow(/Instagram does not let/);
    await expect(inCo(() => editPublishedPost({ id: 'IMP-facebook-PAGE1_1', text: ' ' }, ctx))).rejects.toThrow(/Write the post/);
    expect(edits).toHaveLength(1);
  });

  it('a post deleted from here stays deleted, even if the platform still lists it at the next sync', async () => {
    await inCo(() => importOldPosts({ now }));
    const r = await inCo(() => deletePublishedPost({ id: 'IMP-facebook-PAGE1_1', targets: ['facebook:PAGE1'], confirm: true }, ctx));
    expect(r.post.status).toBe('deleted');
    await inCo(() => importOldPosts({ now }));
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['deleted'] }));
    expect(posts.map((p) => p.id)).toEqual(['IMP-facebook-PAGE1_1']);
  });

  it('keeps videos, Reels and carousels as what they are, and the cover when Meta gives no video link', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
      if (path === '/IG1/media') return json(200, { data: [
        { id: 'R1', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://cdn.example/r1.mp4', thumbnail_url: 'https://cdn.example/r1.jpg', timestamp: '2026-10-25T06:00:00+0000' },
        { id: 'R2', media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'https://cdn.example/r2.jpg', timestamp: '2026-10-24T06:00:00+0000' },
        { id: 'V1', media_type: 'VIDEO', media_product_type: 'FEED', media_url: 'https://cdn.example/v1.mp4', thumbnail_url: 'https://cdn.example/v1.jpg', timestamp: '2026-10-23T06:00:00+0000' },
        { id: 'C1', media_type: 'CAROUSEL_ALBUM', media_url: 'https://cdn.example/c1.jpg', timestamp: '2026-10-22T06:00:00+0000', children: { data: [{ media_type: 'IMAGE', media_url: 'https://cdn.example/c1.jpg' }, { media_type: 'VIDEO', thumbnail_url: 'https://cdn.example/c2.jpg' }] } },
      ] });
      if (path === '/PAGE1/published_posts') return json(200, { data: [
        { id: 'FV', created_time: '2026-10-21T06:00:00+0000', full_picture: 'https://cdn.example/fv.jpg', attachments: { data: [{ media_type: 'video', type: 'video_inline', media: { source: 'https://cdn.example/fv.mp4' } }] } },
        { id: 'FR', created_time: '2026-10-20T06:00:00+0000', permalink_url: 'https://www.facebook.com/reel/1', attachments: { data: [{ media_type: 'video', media: { source: 'javascript:alert(1)' } }] } },
        { id: 'FA', created_time: '2026-10-19T06:00:00+0000', full_picture: 'https://cdn.example/fa.jpg', attachments: { data: [{ media_type: 'album', subattachments: { data: [{ media_type: 'photo', media: { image: { src: 'https://cdn.example/a1.jpg' } } }, { media_type: 'photo', media: { image: { src: 'https://cdn.example/a2.jpg' } } }] } }] } },
      ] });
      return fake(input, init);
    }));
    await inCo(() => importOldPosts({ now }));
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['published'] }));
    const of = (id: string) => posts.find((p) => p.id === id)!;
    expect(of('IMP-instagram-R1')).toMatchObject({ postType: 'reel', videoUrl: 'https://cdn.example/r1.mp4', imageUrl: 'https://cdn.example/r1.jpg' });
    expect(of('IMP-instagram-R2')).toMatchObject({ postType: 'reel', videoUrl: '', imageUrl: 'https://cdn.example/r2.jpg' });
    expect(of('IMP-instagram-V1')).toMatchObject({ postType: 'video', videoUrl: 'https://cdn.example/v1.mp4' });
    expect(of('IMP-instagram-C1').imageUrls).toEqual(['https://cdn.example/c1.jpg', 'https://cdn.example/c2.jpg']);
    expect(of('IMP-instagram-C1').postType).toBe('post');
    expect(of('IMP-facebook-FV')).toMatchObject({ postType: 'video', videoUrl: 'https://cdn.example/fv.mp4' });
    expect(of('IMP-facebook-FR')).toMatchObject({ postType: 'reel', videoUrl: '' });
    expect(of('IMP-facebook-FA').imageUrls).toEqual(['https://cdn.example/a1.jpg', 'https://cdn.example/a2.jpg']);
  });

  it('when Meta refuses the video details, the posts still come, with a warning', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const fields = new URL(String(input)).searchParams.get('fields') || '';
      if (/attachments|media_product_type/.test(fields)) return json(400, { error: { message: 'No such field', code: 100 } });
      return fake(input, init);
    }));
    const r = await inCo(() => importOldPosts({ now }));
    expect(r.imported).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/videos and carousels may show as pictures/);
  });

  it('keeps the old text when Facebook refuses the change', async () => {
    await inCo(() => importOldPosts({ now }));
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: { message: 'Not allowed', code: 200 } })));
    await expect(inCo(() => editPublishedPost({ id: 'IMP-facebook-PAGE1_1', text: 'New words' }, ctx))).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(fake));
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['published'] }));
    expect(posts.some((x) => x.text === 'Diwali offer')).toBe(true);
  });

  it('copies a year of Facebook and Instagram posts, over pages, and stops at the cutoff', async () => {
    const r = await inCo(() => importOldPosts({ now }));
    expect(r).toEqual({ imported: 4, updated: 0, skipped: 1, errors: [], warnings: [] });
    expect(fbPages).toBe(2); // the older page ended it; the third was not fetched
    const { posts } = await inCo(() => listPosts({ from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }));
    expect(posts.map((p) => p.text).sort()).toEqual(['', 'Diwali offer', 'Made in the CRM', 'Site visit', 'Tower view']);
    const fb = posts.find((p) => p.text === 'Diwali offer')!;
    expect(fb).toMatchObject({ status: 'published', imageUrl: 'https://cdn.example/1.jpg', createdBy: 'Imported from Facebook', scheduledAt: '2026-10-20T06:00:00.000Z' });
    expect(fb.targets[0]).toMatchObject({ kind: 'facebook', name: 'Amaya', status: 'posted', url: 'https://www.facebook.com/PAGE1/posts/1' });
    expect(posts.find((p) => p.targets[0].kind === 'instagram' && !p.text)!.imageUrl).toBe('https://cdn.example/m2.jpg'); // a video shows its thumbnail
  });

  it('does not copy twice, and a second sync refreshes the picture link', async () => {
    await inCo(() => importOldPosts({ now }));
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const res = await fake(input);
      const body = await res.text();
      return new Response(body.replace('cdn.example/1.jpg', 'cdn.example/1-new.jpg'), { status: res.status, headers: { 'content-type': 'application/json' } });
    }));
    const r = await inCo(() => importOldPosts({ now }));
    expect(r.imported).toBe(0);
    const { posts } = await inCo(() => listPosts({ from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }));
    expect(posts).toHaveLength(5);
    expect(posts.find((p) => p.text === 'Diwali offer')!.imageUrl).toBe('https://cdn.example/1-new.jpg');
  });

  it('one account failing does not lose the other', async () => {
    igFails = true;
    const r = await inCo(() => importOldPosts({ now }));
    expect(r.imported).toBe(2);
    expect(r.errors).toEqual([{ account: '@amaya', message: expect.stringContaining('Instagram said no') }]);
  });

  it('imported posts are read only, and are never posted by the cron', async () => {
    await inCo(() => importOldPosts({ now }));
    const id = 'IMP-facebook-PAGE1_1';
    await expect(inCo(() => updatePost({ id, text: 'Changed', targets: [] , draft: true }, ctx))).rejects.toThrow(/Only a draft or a scheduled/);
    await expect(inCo(() => deletePost({ id }, ctx))).rejects.toThrow(/Only a draft/);
    expect(await runPostsCron(now)).toEqual({});
  });

  it('asks to connect a Page first, and the daily job only looks at recent posts', async () => {
    const recent = await inCo(() => importOldPosts({ days: 30, now }));
    expect(recent.imported).toBe(3); // not the March post
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).deleteOne({ _id: 'metaSocial' }));
    await expect(inCo(() => syncOldPosts({}, ctx))).rejects.toThrow(/Connect a Facebook Page/);
    expect(await runImportPostsCron(now)).toEqual({});
  });
});
