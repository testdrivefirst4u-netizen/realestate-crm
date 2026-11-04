/** Social inbox › old items: past comments and messages, in the webhooks' threads, once, without notifications. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import * as push from '../server/modules/push';
import { getInboxThread, inboxCreateLead, listInbox, replyInbox, UNSUPPORTED_MESSAGE } from '../server/modules/socialInbox';
import { conversationItems, importOldInbox, messageText, runInboxImportCron, syncOldInbox } from '../server/modules/socialInboxImport';

let t: Awaited<ReturnType<typeof startTestDb>>;
let igFails = false;
const calls: string[] = [];
const now = new Date('2026-11-04T10:00:00Z');
const ctx = { user: { name: 'Asha', role: 'Admin', id: 'U1' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const items = () => inCo(async () => (await col<any>('socialInbox')).find({}).sort({ at: 1 }).toArray());
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fake(input: any): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  calls.push(path);
  if (path === '/PAGE1/conversations') {
    if (url.searchParams.get('platform') === 'instagram') {
      if (igFails) return json(400, { error: { message: 'Instagram said no', code: 10 } });
      return json(200, { data: [{ id: 'CI', updated_time: '2026-10-20T06:00:00+0000', messages: { data: [
        { id: 'im2', message: 'Hello from us', created_time: '2026-10-20T06:00:00+0000', from: { id: 'IG1', username: 'amaya' }, to: { data: [{ id: 'IGU1', username: 'ravi' }] } },
        { id: 'im1', message: 'Is it available?', created_time: '2026-10-19T06:00:00+0000', from: { id: 'IGU1', username: 'ravi' }, to: { data: [{ id: 'IG1' }] } },
      ] } }] });
    }
    return json(200, { data: [{ id: 'CF', updated_time: '2026-10-15T06:00:00+0000', messages: { data: [
      { id: 'fm1', message: 'What is the price?', created_time: '2026-10-15T06:00:00+0000', from: { id: 'U9', name: 'Neha' }, to: { data: [{ id: 'PAGE1', name: 'Amaya' }] } },
      { id: 'fm0', created_time: '2026-10-14T06:00:00+0000', attachments: { data: [{ id: 'a' }] }, from: { id: 'U9', name: 'Neha' }, to: { data: [{ id: 'PAGE1' }] } },
    ] } }] });
  }
  if (path === '/PAGE1/published_posts') return json(200, { data: [{ id: 'PAGE1_1', message: 'Post', created_time: '2026-10-01T06:00:00+0000', comments: { summary: { total_count: 2 } }, reactions: { summary: { total_count: 1 } } }, { id: 'PAGE1_0', message: 'Quiet', created_time: '2026-09-01T06:00:00+0000', comments: { summary: { total_count: 0 } }, reactions: { summary: { total_count: 0 } } }] });
  if (path === '/IG1/media') return json(200, { data: [{ id: 'M1', caption: 'Photo', media_type: 'IMAGE', media_url: 'https://cdn.example/m.jpg', timestamp: '2026-10-02T06:00:00+0000', like_count: 1, comments_count: 1 }] });
  if (path === '/PAGE1_1/comments') return json(200, { data: [{ id: 'c1', from: { id: 'U7', name: 'Sara' }, message: 'Nice flat', created_time: '2026-10-03T06:00:00+0000', comments: { data: [{ id: 'c1r', from: { id: 'PAGE1', name: 'Amaya' }, message: 'Thank you', created_time: '2026-10-04T06:00:00+0000' }] } }] });
  if (path === '/M1/comments') return json(200, { data: [{ id: 'ic1', username: 'ravi', text: 'Lovely', timestamp: '2026-10-05T06:00:00+0000', replies: { data: [{ id: 'ic1r', username: 'amaya', text: 'Thanks', timestamp: '2026-10-06T06:00:00+0000' }] } }] });
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
  await t.company('test', { socialInbox: true, socialPosts: true });
  igFails = false;
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [{ id: 'PAGE1', name: 'Amaya', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' }] }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('old comments and messages', () => {
  it('brings messages and comments into the same threads as webhooks, read, without a notification', async () => {
    const sent = vi.spyOn(push, 'sendPush').mockResolvedValue(undefined as any);
    const r = await inCo(() => syncOldInbox({}, ctx));
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ added: 8, conversations: 2, partial: false, postsImported: 3 });
    const all = await items();
    expect(all.map((i) => i._id).sort()).toEqual(['facebook:c1', 'facebook:c1r', 'facebook:fm0', 'facebook:fm1', 'instagram:ic1', 'instagram:ic1r', 'instagram:im1', 'instagram:im2']);
    const byId = (id: string) => all.find((i) => i._id === id)!;
    expect(byId('facebook:fm1')).toMatchObject({ thread: 'fb:dm:PAGE1:U9', kind: 'message', direction: 'in', authorId: 'U9', authorName: 'Neha', read: true });
    expect(byId('facebook:fm0').text).toBe('[Attachment]');
    expect(byId('instagram:im2')).toMatchObject({ thread: 'ig:dm:IG1:IGU1', direction: 'out', authorName: '@amaya', read: true });
    expect(byId('instagram:im1')).toMatchObject({ thread: 'ig:dm:IG1:IGU1', direction: 'in', authorName: '@ravi' });
    expect(byId('facebook:c1')).toMatchObject({ thread: 'fb:c:c1', kind: 'comment', parent: 'PAGE1_1', direction: 'in', authorName: 'Sara' });
    expect(byId('facebook:c1r')).toMatchObject({ thread: 'fb:c:c1', direction: 'out' });
    expect(byId('instagram:ic1r')).toMatchObject({ thread: 'ig:c:ic1', direction: 'out' });
    expect(sent).not.toHaveBeenCalled();
    const list = await inCo(() => listInbox({}));
    expect(list.unread).toBe(0);
    expect(list.threads).toHaveLength(4);
  });

  it('a post with no comments is not asked, and a second sync adds nothing', async () => {
    await inCo(() => syncOldInbox({}, ctx));
    expect(calls).not.toContain('/PAGE1_0/comments');
    const again = await inCo(() => syncOldInbox({}, ctx));
    expect(again.added).toBe(0);
    expect(await items()).toHaveLength(8);
  });

  it('what a webhook stored stays as it was', async () => {
    await inCo(async () => (await col<any>('socialInbox')).insertOne({ _id: 'facebook:fm1', platform: 'facebook', kind: 'message', thread: 'fb:dm:PAGE1:U9', account: 'PAGE1', externalId: 'fm1', authorId: 'U9', authorName: 'Neha K', text: 'What is the price?', direction: 'in', at: new Date('2026-10-15T06:00:00Z'), read: false }));
    await inCo(() => syncOldInbox({}, ctx));
    const kept = (await items()).find((i) => i._id === 'facebook:fm1')!;
    expect(kept).toMatchObject({ authorName: 'Neha K', read: false });
  });

  it('one account failing does not lose the others, and says why', async () => {
    igFails = true;
    const r = await inCo(() => syncOldInbox({}, ctx));
    expect(r.errors).toEqual([{ account: '@amaya', message: expect.stringContaining('Instagram said no') }]);
    expect((await items()).some((i) => i._id === 'facebook:fm1')).toBe(true);
    expect((await items()).some((i) => i._id === 'instagram:ic1')).toBe(true);
  });

  it('stops at the time limit, and the next run goes on with old posts it has not done', async () => {
    await inCo(() => syncOldInbox({}, ctx));
    const posts = await inCo(async () => (await col<any>('socialPosts')).find({ inboxSyncedAt: { $exists: true } }).toArray());
    expect(posts.length).toBeGreaterThan(0);
    await inCo(async () => (await col<any>('socialPosts')).updateMany({}, { $unset: { inboxSyncedAt: '' } }));
    const stopped = await inCo(() => importOldInbox({ now, budgetMs: -1 }));
    expect(stopped.partial).toBe(true);
    expect(stopped.posts).toBe(0);
    // far later, an old post already read is not read again
    await inCo(() => importOldInbox({ now }));
    calls.length = 0;
    await inCo(() => importOldInbox({ now: new Date('2027-06-01T00:00:00Z') }));
    expect(calls).not.toContain('/PAGE1_1/comments');
  });

  it('the daily job looks at 7 days, and what it finds is unread, without a notification', async () => {
    const sent = vi.spyOn(push, 'sendPush').mockResolvedValue(undefined as any);
    const r = await runInboxImportCron(new Date('2026-10-18T00:00:00Z'));
    expect(r.test).toMatchObject({ added: 4 }); // the conversations; the posts are not copied by this job
    expect((await items()).filter((i) => i.direction === 'in').every((i) => i.read === false)).toBe(true);
    expect(sent).not.toHaveBeenCalled();
    expect(calls).not.toContain('/PAGE1/published_posts');
  });

  it('a lead made from a thread stays linked when older items are copied in', async () => {
    await inCo(async () => (await col<any>('socialInbox')).insertOne({ _id: 'facebook:new', platform: 'facebook', kind: 'message', thread: 'fb:dm:PAGE1:U9', account: 'PAGE1', externalId: 'new', authorId: 'U9', authorName: 'Neha', text: 'Hi', direction: 'in', at: new Date('2026-10-30T06:00:00Z'), read: false, leadId: 'ENQ-0001' }));
    await inCo(() => syncOldInbox({}, ctx));
    expect(await inCo(() => inboxCreateLead({ thread: 'fb:dm:PAGE1:U9' }, ctx))).toEqual({ leadId: 'ENQ-0001' });
  });

  it('skips what it cannot place, and asks to connect a Page first', async () => {
    const got = conversationItems({ messages: { data: [{ id: 'x', created_time: 'bad', from: { id: 'U' } }, { id: 'y', created_time: '2026-10-01T00:00:00Z', from: { id: 'PAGE1' } }, { id: 'old', created_time: '2020-01-01T00:00:00Z', from: { id: 'U' } }] } }, 'facebook', 'PAGE1', 'Amaya', new Date('2026-01-01'));
    expect(got).toEqual([]);
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).deleteOne({ _id: 'metaSocial' }));
    await expect(inCo(() => syncOldInbox({}, ctx))).rejects.toThrow(/Connect a Facebook Page/);
  });
});

describe('clarity', () => {
  it('says what a message without text was', () => {
    expect(messageText({ message: 'Hi' })).toBe('Hi');
    expect(messageText({ story: { reply_to: { id: 'S' } } })).toBe('[Replied to a story]');
    expect(messageText({ story: { mention: { id: 'S' } } })).toBe('[Mentioned you in a story]');
    expect(messageText({ shares: { data: [{ link: 'https://x.example/p' }] } })).toBe('[Shared a post] https://x.example/p');
    expect(messageText({ attachments: { data: [{}] } })).toBe('[Attachment]');
    expect(messageText({ is_unsupported: true })).toBe(UNSUPPORTED_MESSAGE);
    expect(messageText({})).toBe(UNSUPPORTED_MESSAGE);
  });

  it('names the person when only the account has written, and refuses a reply with a clear reason', async () => {
    const conv = { messages: { data: [{ id: 'o1', created_time: '2026-10-01T00:00:00Z', from: { id: 'IG1', username: 'amaya' }, to: { data: [{ id: 'IGU2', username: 'meera' }] } }] } };
    const got = conversationItems(conv, 'instagram', 'IG1', '@amaya', new Date('2026-01-01'));
    expect(got[0]).toMatchObject({ direction: 'out', partnerName: '@meera', thread: 'ig:dm:IG1:IGU2', text: UNSUPPORTED_MESSAGE });
    await inCo(async () => (await col<any>('socialInbox')).insertOne({ ...got[0], read: true }));
    const { threads } = await inCo(() => listInbox({}));
    expect(threads[0]).toMatchObject({ authorName: '@meera', kind: 'message' });
    await expect(inCo(() => replyInbox({ thread: 'ig:dm:IG1:IGU2', text: 'Hello' }, ctx))).rejects.toThrow(/once the person writes/);
  });

  it('a second sync fills in text and names that were blank, and leaves the rest', async () => {
    await inCo(() => syncOldInbox({}, ctx));
    await inCo(async () => {
      const c = await col<any>('socialInbox');
      await c.updateOne({ _id: 'instagram:im1' }, { $set: { text: '', authorName: '' }, $unset: { partnerName: '' } });
      await c.updateOne({ _id: 'facebook:fm1' }, { $set: { text: 'Kept as it was', read: false } });
    });
    const again = await inCo(() => syncOldInbox({}, ctx));
    expect(again.added).toBe(0);
    const all = await items();
    expect(all.find((i) => i._id === 'instagram:im1')).toMatchObject({ text: 'Is it available?', authorName: '@ravi', partnerName: '@ravi' });
    expect(all.find((i) => i._id === 'facebook:fm1')).toMatchObject({ text: 'Kept as it was', read: false });
  });

  it('still reads conversations when Meta refuses the extra message fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any) => (/is_unsupported/.test(decodeURIComponent(String(input))) ? json(400, { error: { message: 'Unknown field', code: 100 } }) : fake(input))));
    const r = await inCo(() => importOldInbox({ now }));
    expect(r.errors).toEqual([]);
    expect((await items()).some((i) => i._id === 'facebook:fm1')).toBe(true);
  });

  it('a comment shows the post it is on, in the list and when opened', async () => {
    await inCo(() => syncOldInbox({}, ctx));
    const { threads } = await inCo(() => listInbox({ kind: 'comment' }));
    expect(threads.find((x) => x.thread === 'fb:c:c1')).toMatchObject({ parent: 'PAGE1_1', postText: 'Post' });
    expect(threads.find((x) => x.thread === 'ig:c:ic1')).toMatchObject({ parent: 'M1', postText: 'Photo', postImage: 'https://cdn.example/m.jpg' });
    const opened = await inCo(() => getInboxThread({ thread: 'ig:c:ic1' }));
    expect(opened.post).toMatchObject({ id: 'M1', text: 'Photo', imageUrl: 'https://cdn.example/m.jpg' });
    expect((await inCo(() => getInboxThread({ thread: 'fb:dm:PAGE1:U9' }))).post).toBeNull();
    expect((await inCo(() => listInbox({ parent: 'M1' }))).threads.map((x) => x.thread)).toEqual(['ig:c:ic1']);
  });

  it('a post not synced yet is read from the platform; if that fails the conversation still opens', async () => {
    const add = async (thread: string, parent: string) => inCo(async () => (await col<any>('socialInbox')).insertOne({ _id: `facebook:${thread}`, platform: 'facebook', kind: 'comment', thread, account: 'PAGE1', externalId: thread, parent, authorId: 'U', authorName: 'A', text: 'Hi', direction: 'in', at: new Date(), read: false }));
    await add('fb:c:z1', 'PAGE1_NEW');
    vi.stubGlobal('fetch', vi.fn(async (input: any) => (String(input).includes('/PAGE1_NEW') ? json(200, { message: 'Fresh post', full_picture: 'https://cdn.example/f.jpg', permalink_url: 'https://www.facebook.com/x', created_time: '2026-11-01T00:00:00+0000' }) : fake(input))));
    expect((await inCo(() => getInboxThread({ thread: 'fb:c:z1' }))).post).toMatchObject({ text: 'Fresh post', url: 'https://www.facebook.com/x' });
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: { message: 'Gone', code: 100 } })));
    const opened = await inCo(() => getInboxThread({ thread: 'fb:c:z1' }));
    expect(opened.post).toBeNull();
    expect(opened.items).toHaveLength(1);
  });
});

describe('the list', () => {
  it('says when there are more conversations than asked for', async () => {
    await inCo(() => syncOldInbox({}, ctx));
    const first = await inCo(() => listInbox({ limit: 2 }));
    expect([first.threads.length, first.hasMore]).toEqual([2, true]);
    expect((await inCo(() => listInbox({ limit: 100 }))).hasMore).toBe(false);
  });
});
