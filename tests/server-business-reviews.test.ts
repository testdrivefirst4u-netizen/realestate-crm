/** Business Profile › Reviews: read fresh from Google, replies added, changed and deleted, Social Inbox kept in step. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { deleteBusinessReply, getBusinessReviews, replyBusinessReview } from '../server/modules/businessReviews';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { BUSINESS_SCOPE } from '../server/modules/googleMarketing';

let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: Array<{ path: string; method: string; body: any; query: URLSearchParams }> = [];
let refuse = '';
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const LOC = { name: 'locations/1', title: 'Amaya', account: 'accounts/9' };
const PARENT = 'accounts/9/locations/1';
const REVIEWS = [
  { reviewId: 'R1', reviewer: { displayName: 'Neha', profilePhotoUrl: 'https://lh3.googleusercontent.com/n' }, starRating: 'FIVE', comment: 'Lovely', createTime: '2026-10-01T00:00:00Z', updateTime: '2026-10-02T00:00:00Z', reviewReply: { comment: 'Thanks', updateTime: '2026-10-03T00:00:00Z' } },
  { reviewId: 'R2', reviewer: { isAnonymous: true, displayName: 'Hidden', profilePhotoUrl: 'https://x.example/h' }, starRating: 'TWO', createTime: '2026-10-05T00:00:00Z' },
];

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  const method = String(init.method || 'GET');
  calls.push({ path: url.pathname.replace(/^\/v4\//, ''), method, body: init.body ? JSON.parse(String(init.body)) : null, query: url.searchParams });
  if (refuse) return json(400, { error: { message: refuse } });
  if (method === 'GET') return json(200, { reviews: REVIEWS, averageRating: 3.5, totalReviewCount: 60, nextPageToken: 'NEXT' });
  return json(200, method === 'PUT' ? { comment: 'x' } : {});
}
const writes = () => calls.filter((c) => c.method !== 'GET');

beforeAll(async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-123';
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { businessProfile: true });
  resetGoogleOAuthTokenCache();
  calls = [];
  refuse = '';
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '', connectedBy: 'x', connectedAt: new Date() });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'a@b.c', scopes: [BUSINESS_SCOPE], gbpLocation: LOC, gbpLocations: [LOC] });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('read', () => {
  it('gives reviews in plain words, hides an anonymous person, and only reads', async () => {
    const r = await inCo(() => getBusinessReviews({}));
    expect(r).toMatchObject({ error: '', average: 3.5, total: 60, nextPage: 'NEXT', location: 'locations/1' });
    expect(r.reviews[0]).toMatchObject({ id: 'R1', author: 'Neha', stars: 5, comment: 'Lovely', reply: 'Thanks', repliedAt: '2026-10-03T00:00:00Z' });
    expect(r.reviews[1]).toMatchObject({ id: 'R2', author: 'Anonymous', photo: '', stars: 2, comment: '', reply: '' });
    expect(calls[0].path).toBe(`${PARENT}/reviews`);
    expect(calls[0].query.get('pageSize')).toBe('50');
    expect(writes()).toHaveLength(0);
  });

  it('sends the sort and the next page, and ignores an unknown sort', async () => {
    await inCo(() => getBusinessReviews({ order: 'rating', page: 'NEXT' }));
    expect(calls[0].query.get('orderBy')).toBe('rating');
    expect(calls[0].query.get('pageToken')).toBe('NEXT');
    await inCo(() => getBusinessReviews({ order: 'nonsense' }));
    expect(calls[1].query.get('orderBy')).toBe('updateTime desc');
  });

  it('says what is missing, and what Google says', async () => {
    refuse = 'Location is not verified';
    expect((await inCo(() => getBusinessReviews({}))).error).toContain('not verified');
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).deleteOne({ _id: 'google' }));
    expect((await inCo(() => getBusinessReviews({}))).error).toMatch(/Connect your Google/);
  });

  it('only a location this connection reaches', async () => {
    await expect(inCo(() => getBusinessReviews({ location: 'locations/999' }))).rejects.toThrow(/Choose one/);
  });
});

describe('reply', () => {
  it('sends the reply, keeps Social Inbox in step, and logs it', async () => {
    await inCo(async () => (await col<any>('socialInbox')).insertOne({ _id: 'google:R1:reply', text: 'Old words', thread: 'g:r:R1' }));
    await inCo(() => replyBusinessReview({ reviewId: 'R1', comment: '  Thank you  ' }, ctx));
    expect(writes()[0]).toMatchObject({ method: 'PUT', path: `${PARENT}/reviews/R1/reply`, body: { comment: 'Thank you' } });
    expect((await inCo(async () => (await col<any>('socialInbox')).findOne({ _id: 'google:R1:reply' })))?.text).toBe('Thank you');
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Google Review Replied' }))).toBe(1);
  });

  it('refuses an empty or too long reply, or no review', async () => {
    await expect(inCo(() => replyBusinessReview({ reviewId: 'R1', comment: '  ' }, ctx))).rejects.toThrow(/Write a reply/);
    await expect(inCo(() => replyBusinessReview({ reviewId: 'R1', comment: 'é'.repeat(2049) }, ctx))).rejects.toThrow(/too long/);
    await expect(inCo(() => replyBusinessReview({ comment: 'Hi' }, ctx))).rejects.toThrow(/Choose a review/);
    expect(writes()).toHaveLength(0);
  });

  it('cannot reach outside the location through the review id', async () => {
    await inCo(() => replyBusinessReview({ reviewId: '../../other', comment: 'Hi' }, ctx));
    expect(writes()[0].path).toBe(`${PARENT}/reviews/..%2F..%2Fother/reply`);
  });

  it('passes on Google\'s reason, changing nothing here', async () => {
    await inCo(async () => (await col<any>('socialInbox')).insertOne({ _id: 'google:R1:reply', text: 'Old words', thread: 'g:r:R1' }));
    refuse = 'Reply refused';
    await expect(inCo(() => replyBusinessReview({ reviewId: 'R1', comment: 'New' }, ctx))).rejects.toThrow(/Reply refused/);
    expect((await inCo(async () => (await col<any>('socialInbox')).findOne({ _id: 'google:R1:reply' })))?.text).toBe('Old words');
  });
});

describe('delete a reply', () => {
  it('needs confirming, removes it from Social Inbox too, and logs it', async () => {
    await inCo(async () => (await col<any>('socialInbox')).insertOne({ _id: 'google:R1:reply', text: 'Thanks', thread: 'g:r:R1' }));
    await expect(inCo(() => deleteBusinessReply({ reviewId: 'R1' }, ctx))).rejects.toThrow(/Confirm/);
    expect(writes()).toHaveLength(0);
    await inCo(() => deleteBusinessReply({ reviewId: 'R1', confirm: true }, ctx));
    expect(writes()[0]).toMatchObject({ method: 'DELETE', path: `${PARENT}/reviews/R1/reply` });
    expect(await inCo(async () => (await col<any>('socialInbox')).findOne({ _id: 'google:R1:reply' }))).toBeNull();
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Google Review Reply Deleted' }))).toBe(1);
  });
});

describe('who', () => {
  it('Viewers read, RMs cannot reply, Managers can, and the feature is needed', async () => {
    const base = { userAgent: 'vitest', ip: '10.9.9.9' };
    const session = (role: 'Manager' | 'RM' | 'Viewer') => inCo(async () => {
      const email = `${role.toLowerCase()}@reviews.test`;
      await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
      return (await login(email, 'long-enough-pw', base)).token;
    });
    const reply = { reviewId: 'R1', comment: 'Hi' };
    expect((await inCo(async () => dispatch('getBusinessReviews', {}, { ...base, token: await session('Viewer') }))).status).toBe(200);
    const rm = await session('RM');
    expect((await inCo(() => dispatch('replyBusinessReview', reply, { ...base, token: rm }))).status).toBe(403);
    expect(writes()).toHaveLength(0);
    const manager = await session('Manager');
    expect((await inCo(() => dispatch('replyBusinessReview', reply, { ...base, token: manager }))).status).toBe(200);
    await t.company('test', { businessProfile: false });
    expect((await inCo(() => dispatch('getBusinessReviews', {}, { ...base, token: manager }))).status).toBe(403);
  });
});
