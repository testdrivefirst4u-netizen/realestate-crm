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
import { allLocationReviews, deleteBusinessReply, getBusinessReviews, replyBusinessReview } from '../server/modules/businessReviews';
import { getBusinessLocations, snapshotBusinessRatings } from '../server/modules/businessProfile';
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
  if (url.host === 'api.anthropic.com') {
    calls.push({ path: 'anthropic', method: String(init.method || 'POST'), body: init.body ? JSON.parse(String(init.body)) : null, query: url.searchParams });
    return json(200, { content: [{ type: 'text', text: 'Thank you, Neha! So glad you enjoyed your visit — we hope to see you again soon.' }] });
  }
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

describe('all locations', () => {
  const LOC2 = { name: 'locations/2', title: 'Amaya South', account: 'accounts/9', storeCode: 'AMY-2', address: 'MG Road, Hyderabad', status: 'verified' as const };
  const seedTwo = async () => inCo(async () => {
    await (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'google' }, { $set: { gbpLocations: [{ ...LOC, storeCode: 'AMY-1', address: 'Munirabad', status: 'verified' }, LOC2] } });
  });

  it('getBusinessLocations lists every location with store code, address and status', async () => {
    await seedTwo();
    const r = await inCo(() => getBusinessLocations({}));
    expect(r).toMatchObject({ connected: true, total: 2, verified: 2 });
    expect(r.locations.map((l) => l.storeCode).sort()).toEqual(['AMY-1', 'AMY-2']);
    expect(r.locations.find((l) => l.name === 'locations/2')).toMatchObject({ title: 'Amaya South', address: 'MG Road, Hyderabad', status: 'verified' });
  });

  it('snapshotBusinessRatings caches each location rating, and getBusinessLocations serves it', async () => {
    await seedTwo();
    const n = await inCo(() => snapshotBusinessRatings());
    expect(n).toBe(2); // one light reviews call per location
    const r = await inCo(() => getBusinessLocations({}));
    expect(r.needsAction).toBe(0);
    expect(r.locations.every((l) => l.rating === 3.5 && l.reviews === 60)).toBe(true); // from the fake's averageRating/totalReviewCount
  });

  it('allLocationReviews aggregates across locations, tags each, and filters unanswered', async () => {
    await seedTwo();
    const r = await inCo(() => allLocationReviews({}));
    expect(r.locations).toBe(2);
    expect(r.scanned).toBe(2);
    expect(r.reviews).toHaveLength(4); // 2 reviews × 2 locations (fake returns the same set per location)
    expect(new Set(r.reviews.map((x) => x.locationTitle))).toEqual(new Set(['Amaya', 'Amaya South']));
    expect(r.unansweredTotal).toBe(2); // R2 has no reply, once per location
    const only = await inCo(() => allLocationReviews({ unansweredOnly: true }));
    expect(only.reviews.every((x) => !x.reply)).toBe(true);
    expect(only.reviews).toHaveLength(2);
  });

  it('a chosen subset limits the CRM to those locations everywhere (list + reviews feed)', async () => {
    const { getGbpSelection, setGbpSelection } = await import('../server/modules/businessProfile');
    await seedTwo();
    // default: manage all
    expect((await inCo(() => getGbpSelection())).all).toBe(true);
    expect((await inCo(() => getBusinessLocations({}))).total).toBe(2);

    // choose only the second location
    const saved = await inCo(() => setGbpSelection({ names: ['locations/2'] }, ctx));
    expect(saved).toMatchObject({ all: false, selected: ['locations/2'] });

    const list = await inCo(() => getBusinessLocations({}));
    expect(list.total).toBe(1);
    expect(list.locations[0].name).toBe('locations/2');

    const feed = await inCo(() => allLocationReviews({}));
    expect(feed.locations).toBe(1);
    expect(new Set(feed.reviews.map((x) => x.locationTitle))).toEqual(new Set(['Amaya South']));

    // selecting every location again means "manage everything" (stored as empty)
    const back = await inCo(() => setGbpSelection({ names: ['locations/1', 'locations/2'] }, ctx));
    expect(back.all).toBe(true);
    expect((await inCo(() => getBusinessLocations({}))).total).toBe(2);
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

describe('AI draft reply (Claude)', () => {
  it('drafts a reply with Claude (Haiku) when the Anthropic key is set, without posting anything', async () => {
    const { aiDraftReviewReply } = await import('../server/modules/businessReviews');
    await inCo(async () => (await col<any>(CFG.COLL.SECRETS)).insertOne({ _id: 'ANTHROPIC_API_KEY', value: encryptSecret('sk-ant-test') }));
    const r = await inCo(() => aiDraftReviewReply({ stars: 5, author: 'Neha', comment: 'Lovely' }));
    expect(r.reply).toContain('Neha');
    const call = calls.find((c) => c.path === 'anthropic');
    expect(call).toBeTruthy();
    expect(call!.body.model).toBe('claude-haiku-5-5');
    expect(String(call!.body.system)).toMatch(/Google review/i);
    expect(writes().filter((c) => c.path !== 'anthropic')).toHaveLength(0); // drafting never writes to Google
  });
});
