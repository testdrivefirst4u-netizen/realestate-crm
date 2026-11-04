/** Post scheduler › old posts: copied from Facebook and Instagram once, without posts made in the CRM, read only. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { deletePost, listPosts, runPostsCron, updatePost } from '../server/modules/socialPosts';
import { importOldPosts, runImportPostsCron, syncOldPosts } from '../server/modules/socialPostsImport';

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

async function fake(input: any): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  if (path === '/PAGE1/published_posts') {
    fbPages += 1;
    if (!url.searchParams.get('after')) return json(200, { data: [
      { id: 'PAGE1_1', message: 'Diwali offer', created_time: '2026-10-20T06:00:00+0000', permalink_url: 'https://www.facebook.com/PAGE1/posts/1', full_picture: 'https://cdn.example/1.jpg' },
      { id: 'PAGE1_CRM', message: 'Made in the CRM', created_time: '2026-10-10T06:00:00+0000' },
    ], paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' } });
    return json(200, { data: [
      { id: 'PAGE1_2', message: 'Site visit', created_time: '2026-03-01T06:00:00+0000' },
      { id: 'PAGE1_OLD', message: 'Too old', created_time: '2024-01-01T06:00:00+0000' },
    ], paging: { cursors: { after: 'MORE' }, next: 'https://graph.facebook.com/next' } });
  }
  if (path === '/IG1/media') {
    if (igFails) return json(400, { error: { message: 'Instagram said no', code: 10 } });
    return json(200, { data: [
      { id: 'M1', caption: 'Tower view', media_type: 'IMAGE', media_url: 'https://cdn.example/m1.jpg', permalink: 'https://www.instagram.com/p/m1/', timestamp: '2026-10-25T06:00:00+0000' },
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
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [{ id: 'PAGE1', name: 'Amaya', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' }] });
    await (await col<any>('socialPosts')).insertOne({ _id: 'POST-0001', text: 'Made in the CRM', link: '', imageFileId: '', status: 'published', scheduledAt: new Date('2026-10-10T06:00:00Z'), targets: [{ key: 'facebook:PAGE1', kind: 'facebook', name: 'Amaya', status: 'posted', postId: 'PAGE1_CRM' }], createdBy: 'Asha' });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('old posts', () => {
  it('copies a year of Facebook and Instagram posts, over pages, and stops at the cutoff', async () => {
    const r = await inCo(() => importOldPosts({ now }));
    expect(r).toEqual({ imported: 4, updated: 0, skipped: 1, errors: [] });
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
