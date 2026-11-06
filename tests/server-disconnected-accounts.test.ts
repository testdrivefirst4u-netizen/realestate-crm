/** A disconnected account's posts and conversations are hidden, nothing is deleted, and connecting again brings them back. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { disconnectSocialPage } from '../server/modules/socialAccounts';
import { getInboxThread, listInbox } from '../server/modules/socialInbox';
import { clearInsightsCache, getSocialInsights } from '../server/modules/socialInsights';
import { getPost, listPosts } from '../server/modules/socialPosts';
import { gbpLocationPath } from '../server/modules/googleMarketing';

let t: Awaited<ReturnType<typeof startTestDb>>;
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PAGE1 = { id: 'PAGE1', name: 'Amaya', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' };
const PAGE2 = { id: 'PAGE2', name: 'Other', token: encryptSecret('PT2'), igId: '', igUsername: '' };
const out = (id: string, key: string, kind: string, extra: any = {}) => ({ _id: id, text: id, link: '', imageFileId: '', status: 'published', scheduledAt: new Date('2026-11-01T00:00:00Z'), createdBy: 'x', createdAt: new Date(), updatedAt: new Date(), targets: [{ key, kind, name: key, status: 'posted', postId: `${id}_p` }], metrics: { likes: 5, comments: 1, shares: 0 }, ...extra });
const item = (id: string, account: string, read = false) => ({ _id: `facebook:${id}`, platform: 'facebook', kind: 'comment', thread: `fb:c:${id}`, account, externalId: id, authorId: 'a', authorName: 'Neha', text: 'Price?', direction: 'in', read, at: new Date('2026-11-01T00:00:00Z') });
const all = { from: '2000-01-01T00:00:00Z' };
const ids = (r: { posts: Array<{ id: string }> }) => r.posts.map((p) => p.id).sort();
const setPages = (pages: any[]) => inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'metaSocial' }, { $set: { pages } }));

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
  await t.company('test', { socialPosts: true, socialInbox: true });
  clearInsightsCache();
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: [] })));
  await inCo(async () => {
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [PAGE1, PAGE2] });
    await (await col<any>('socialPosts')).insertMany([
      out('A', 'facebook:PAGE1', 'facebook'), out('B', 'facebook:PAGE2', 'facebook'),
      out('BOTH', 'facebook:PAGE1', 'facebook', { targets: [{ key: 'facebook:PAGE1', kind: 'facebook', name: 'Amaya', status: 'posted', postId: 'x1' }, { key: 'facebook:PAGE2', kind: 'facebook', name: 'Other', status: 'posted', postId: 'x2' }] }),
      out('LATER', 'facebook:PAGE2', 'facebook', { status: 'scheduled', scheduledAt: new Date('2026-12-01T00:00:00Z') }),
      out('DRAFT', 'facebook:PAGE2', 'facebook', { status: 'draft' }),
    ]);
    await (await col<any>('socialInbox')).insertMany([item('c1', 'PAGE1'), item('c2', 'PAGE2')]);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('posts', () => {
  it('shows every connected account\'s posts', async () => {
    expect(ids(await inCo(() => listPosts(all)))).toEqual(['A', 'B', 'BOTH', 'DRAFT', 'LATER']);
  });

  it('hides what is out on a disconnected account, keeps it stored, and brings it back', async () => {
    await inCo(() => disconnectSocialPage({ pageId: 'PAGE2' }, ctx));
    const r = await inCo(() => listPosts(all));
    expect(ids(r)).toEqual(['A', 'BOTH', 'DRAFT', 'LATER']);
    expect(r.targets.map((x) => x.key)).not.toContain('facebook:PAGE2');
    expect(await inCo(async () => (await col<any>('socialPosts')).countDocuments({}))).toBe(5);
    await expect(inCo(() => getPost({ id: 'B' }))).rejects.toThrow(/not found/i);
    await setPages([PAGE1, PAGE2]);
    expect(ids(await inCo(() => listPosts(all)))).toEqual(['A', 'B', 'BOTH', 'DRAFT', 'LATER']);
    expect((await inCo(() => getPost({ id: 'B' }))).post.id).toBe('B');
  });

  it('a post on two accounts shows only the one still connected', async () => {
    await inCo(() => disconnectSocialPage({ pageId: 'PAGE2' }, ctx));
    const both = (await inCo(() => listPosts(all))).posts.find((p) => p.id === 'BOTH')!;
    expect(both.targets.map((x) => x.key)).toEqual(['facebook:PAGE1']);
    expect((await inCo(async () => (await col<any>('socialPosts')).findOne({ _id: 'BOTH' }))).targets).toHaveLength(2);
  });

  it('drafts and scheduled posts always show, so someone can fix them', async () => {
    await setPages([]);
    expect(ids(await inCo(() => listPosts(all)))).toEqual(['DRAFT', 'LATER']);
  });

  it('asking for a disconnected account by name shows nothing that is out', async () => {
    await inCo(() => disconnectSocialPage({ pageId: 'PAGE2' }, ctx));
    expect(ids(await inCo(() => listPosts({ ...all, account: 'facebook:PAGE2' })))).toEqual(['DRAFT', 'LATER']);
  });

  it('top posts leave out a disconnected account at once', async () => {
    const before = await inCo(() => getSocialInsights({}, new Date('2026-11-06T00:00:00Z')));
    expect(before.topPosts.map((p) => p.id)).toContain('B');
    await inCo(() => disconnectSocialPage({ pageId: 'PAGE2' }, ctx));
    const after = await inCo(() => getSocialInsights({}, new Date('2026-11-06T00:00:00Z')));
    expect(after.topPosts.map((p) => p.id)).not.toContain('B');
    expect(after.topPosts.map((p) => p.id)).toContain('A');
    const asked = await inCo(() => getSocialInsights({ account: 'facebook:PAGE2' }, new Date('2026-11-06T00:00:00Z')));
    expect(asked.topPosts).toEqual([]);
  });
});

describe('inbox', () => {
  it('hides a disconnected account\'s conversations and unread, keeps them, and brings them back', async () => {
    const before = await inCo(() => listInbox({}));
    expect(before.threads.map((x) => x.thread).sort()).toEqual(['fb:c:c1', 'fb:c:c2']);
    expect(before.unread).toBe(2);
    await inCo(() => disconnectSocialPage({ pageId: 'PAGE2' }, ctx));
    const after = await inCo(() => listInbox({}));
    expect(after.threads.map((x) => x.thread)).toEqual(['fb:c:c1']);
    expect(after.unread).toBe(1);
    await expect(inCo(() => getInboxThread({ thread: 'fb:c:c2' }))).rejects.toThrow(/not found/i);
    expect(await inCo(async () => (await col<any>('socialInbox')).countDocuments({}))).toBe(2);
    // opening a hidden conversation did not mark it read
    expect((await inCo(async () => (await col<any>('socialInbox')).findOne({ _id: 'facebook:c2' }))).read).toBe(false);
    await setPages([PAGE1, PAGE2]);
    expect((await inCo(() => listInbox({}))).unread).toBe(2);
    expect((await inCo(() => getInboxThread({ thread: 'fb:c:c2' }))).thread).toBe('fb:c:c2');
  });
});

describe('Google', () => {
  it('a disconnected Google account has no location to show or post to', async () => {
    const google = { _id: 'google', connectionId: 'GCN-1', email: 'a@b.c', scopes: [], gbpLocation: { name: 'locations/1', title: 'Amaya', account: 'accounts/9' } };
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne(google));
    expect((await inCo(() => gbpLocationPath()))?.path).toBe('accounts/9/locations/1');
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'google' }, { $set: { connectionId: '' } }));
    expect(await inCo(() => gbpLocationPath())).toBeNull();
  });
});
