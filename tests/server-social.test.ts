/** Social inbox (Meta webhooks, replies, Google reviews, lead) and post scheduler (all five platforms, schedule, retry). */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { encryptSecret } from '../server/core/settings';
import { getClient, PLATFORM_DB } from '../server/core/db';
import { createUser, login, type Ctx } from '../server/core/auth';
import { getAllLeads } from '../server/modules/leads';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { savePages } from '../server/modules/socialAccounts';
import { getInboxThread, inboxCreateLead, listInbox, pollGoogleReviews, replyInbox } from '../server/modules/socialInbox';
import { createPost, deletePost, listPosts, listPostTargets, publicMediaUrl, reschedulePost, retryPost, runPostsCron, updatePost, uploadPostImage } from '../server/modules/socialPosts';
import { POST as webhookPOST } from '../app/api/webhooks/meta/route';
import { GET as mediaGET } from '../app/api/public/media/[companyId]/[fileId]/route';

const APP_ID = '1234567890';
const APP_SECRET = 'abcdef0123456789abcdef0123456789';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: Array<{ host: string; path: string; method: string; params: Record<string, any> }> = [];
let failPinterest = false;
let subscribed: Record<string, string[]> = {};
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sign = (raw: string) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
const hits = (re: RegExp) => calls.filter((c) => re.test(`${c.method} ${c.host}${c.path}`));

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  const ct = String(init.headers?.['Content-Type'] || init.headers?.['content-type'] || '');
  const params: Record<string, any> = method === 'GET' ? Object.fromEntries(url.searchParams) : ct.includes('json') ? JSON.parse(String(init.body || '{}')) : Object.fromEntries(new URLSearchParams(String(init.body || '')));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  calls.push({ host: url.host, path, method, params });
  if (url.host === 'graph.facebook.com') {
    const m = path.match(/^\/(\w+)\/subscribed_apps$/);
    if (m && method === 'GET') return json(200, { data: subscribed[m[1]] ? [{ id: APP_ID, subscribed_fields: subscribed[m[1]] }] : [] });
    if (m && method === 'POST') { subscribed[m[1]] = String(params.subscribed_fields).split(','); return json(200, { success: true }); }
    if (path === '/PSID1') return json(200, { name: 'Ravi Kumar' });
    if (path === '/PAGE1/messages') return json(200, { recipient_id: 'PSID1', message_id: 'm_out_1' });
    if (failComment && /\/comments$/.test(path) && method === 'POST') return json(400, { error: { message: 'Comments are off', code: 100 } });
    if (/^\/\w+\/(comments|replies)$/.test(path)) return json(200, { id: 'reply_1' });
    if (path === '/PAGE1/photos') return json(200, params.published === 'false' ? { id: `PH${(photoSeq += 1)}` } : { id: 'PH1', post_id: 'PAGE1_POST1' });
    if (path === '/PAGE1/feed') return json(200, { id: 'PAGE1_POST2' });
    if (path === '/IG1/media') return json(200, { id: params.media_type === 'CAROUSEL' ? 'PARENT' : params.is_carousel_item ? `CH${(photoSeq += 1)}` : 'C1' });
    if (path === '/IG1/media_publish') return json(200, { id: 'M1' });
    if (path === '/M1') return json(200, { permalink: 'https://www.instagram.com/p/abc/' });
  }
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  if (url.host === 'mybusiness.googleapis.com') {
    if (path.endsWith('/reviews') && method === 'GET') return json(200, { reviews: [
      { reviewId: 'R1', reviewer: { displayName: 'Lakshmi' }, starRating: 'TWO', comment: 'Nobody called back', createTime: '2026-11-01T10:00:00Z' },
      { reviewId: 'R2', reviewer: { displayName: 'Arjun' }, starRating: 'FIVE', comment: 'Lovely place', createTime: '2026-10-30T10:00:00Z', reviewReply: { comment: 'Thank you!', updateTime: '2026-10-31T10:00:00Z' } },
    ] });
    if (path.endsWith('/reply') && method === 'PUT') return json(200, { comment: params.comment });
    if (path.endsWith('/localPosts')) return json(200, { name: 'accounts/1/locations/9/localPosts/77', searchUrl: 'https://g.co/post77' });
  }
  if (url.host === 'api.linkedin.com') {
    if (path === '/rest/images' && url.searchParams.get('action') === 'initializeUpload') return json(200, { value: { uploadUrl: 'https://upload.linkedin.test/img', image: 'urn:li:image:I1' } });
    if (path === '/rest/posts') return json(201, {}, { 'x-restli-id': 'urn:li:share:S1' });
  }
  if (url.host === 'upload.linkedin.test') return new Response(null, { status: 201 });
  if (url.host === 'api.pinterest.com' && path === '/v5/pins') return failPinterest ? json(400, { message: 'Board not found' }) : json(201, { id: 'PIN1' });
  return json(404, { error: { message: `unexpected ${method} ${url.host}${path}` } });
}

let photoSeq = 0;
let failComment = false;

async function setup(): Promise<Ctx> {
  photoSeq = 0;
  failComment = false;
  await createUser({ name: 'Support', email: 'support@social.test', password: 'long-enough-pw', role: 'Developer', mustChangePassword: false }, null);
  const r = await login('support@social.test', 'long-enough-pw', { userAgent: 'vitest', ip: '10.5.5.5' });
  const ctx = { user: r.user } as unknown as Ctx;
  await inCo(() => savePages([{ id: 'PAGE1', name: 'Amaya Living', token: 'PT1', igId: 'IG1', igUsername: 'amaya' }], ctx));
  return ctx;
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'APP_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'PINTEREST_APP_ID', 'PINTEREST_APP_SECRET', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { socialInbox: true, socialPosts: true, linkedin: true, pinterest: true });
  Object.assign(process.env, {
    META_APP_ID: APP_ID, META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: 'verify-me-12345', APP_URL: 'https://crm.example.com',
    GOOGLE_OAUTH_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'secret-123',
    PINTEREST_APP_ID: '1500000', PINTEREST_APP_SECRET: 'pin-secret-123', LINKEDIN_CLIENT_ID: 'li12345678', LINKEDIN_CLIENT_SECRET: 'li-secret-123',
  });
  resetGoogleOAuthTokenCache();
  calls = [];
  subscribed = { PAGE1: ['leadgen'] };
  failPinterest = false;
  vi.stubGlobal('fetch', vi.fn(fake));
});
afterEach(() => vi.unstubAllGlobals());

async function connectGoogle() {
  await inCo(async () => {
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'ads@amaya.test', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '', connectedBy: 'x', connectedAt: new Date() });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'ads@amaya.test', scopes: ['https://www.googleapis.com/auth/business.manage'], gbpLocation: { name: 'locations/9', title: 'Amaya Experience Centre', account: 'accounts/1' } });
  });
}

describe('social accounts and inbox', () => {
  it('connecting a Page claims it, keeps leadgen and adds feed + messages', async () => {
    await setup();
    expect(subscribed.PAGE1.sort()).toEqual(['feed', 'leadgen', 'messages']);
    const claims = await (await getClient())!.db(PLATFORM_DB()).collection('socialAccounts').find({}).sort({ _id: 1 }).toArray();
    expect(claims.map((c) => `${c._id}=${c.companyId}`)).toEqual(['fb:PAGE1=CMP-test', 'ig:IG1=CMP-test']);
  });

  it('webhooks bring messages and comments in once (not echoes or the Page itself); replies go to the platform', async () => {
    const ctx = await setup();
    const page = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', time: 1, messaging: [
      { sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, timestamp: 1730000000000, message: { mid: 'mid.1', text: 'Price of 2 BHK?' } },
      { sender: { id: 'PAGE1' }, recipient: { id: 'PSID1' }, timestamp: 1730000001000, message: { mid: 'mid.2', text: 'echo', is_echo: true } },
    ], changes: [
      { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'POST9_C1', post_id: 'POST9', message: 'Is it ready to move?', from: { id: 'U5', name: 'Meena' }, created_time: 1730000002 } },
      { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'POST9_C2', post_id: 'POST9', parent_id: 'POST9_C1', message: 'Yes', from: { id: 'PAGE1', name: 'Amaya' } } },
    ] }] });
    const ig = JSON.stringify({ object: 'instagram', entry: [{ id: 'IG1', time: 1, changes: [{ field: 'comments', value: { id: 'IGC1', text: 'Location?', from: { id: 'IGU1', username: 'kiran' }, media: { id: 'MEDIA1' } } }] }] });
    for (const raw of [page, ig, page]) expect((await webhookPOST(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw }))).status).toBe(200);
    const { threads, unread } = await inCo(() => listInbox());
    expect(threads.map((x) => `${x.platform}/${x.kind}/${x.authorName}/${x.text}`).sort()).toEqual([
      'facebook/comment/Meena/Is it ready to move?', 'facebook/message/Ravi Kumar/Price of 2 BHK?', 'instagram/comment/@kiran/Location?',
    ]);
    expect(unread).toBe(3);

    const dm = threads.find((x) => x.kind === 'message')!;
    await inCo(() => replyInbox({ thread: dm.thread, text: 'Starts at ₹85 lakh. Shall I call you?' }, ctx));
    const sent = hits(/POST graph\.facebook\.com\/PAGE1\/messages/)[0].params;
    expect(JSON.parse(sent.recipient)).toEqual({ id: 'PSID1' });
    expect(JSON.parse(sent.message)).toEqual({ text: 'Starts at ₹85 lakh. Shall I call you?' });
    const igc = threads.find((x) => x.platform === 'instagram')!;
    await inCo(() => replyInbox({ thread: igc.thread, text: 'Medchal, Hyderabad' }, ctx));
    expect(hits(/POST graph\.facebook\.com\/IGC1\/replies/)).toHaveLength(1);
    const after = await inCo(() => listInbox());
    expect(after.threads.find((x) => x.thread === dm.thread)).toMatchObject({ answered: true, unread: 0 });
    expect((await inCo(() => getInboxThread({ thread: dm.thread }))).items.map((i) => i.direction)).toEqual(['in', 'out']);

    const { leadId } = await inCo(() => inboxCreateLead({ thread: dm.thread, name: 'Ravi Kumar', phone: '9876501234' }, ctx));
    const lead = (await inCo(() => getAllLeads(null))).leads.find((l) => l['Enquiry ID'] === leadId)!;
    expect(lead).toMatchObject({ 'Prospect Name': 'Ravi Kumar', 'Enquiry Source': 'Facebook', 'Form: First message': 'Price of 2 BHK?' });
    expect((await inCo(() => listInbox())).threads.find((x) => x.thread === dm.thread)!.leadId).toBe(leadId);
  });

  it('Google reviews come in (with replies made elsewhere) and are answered from the CRM; switched off ignores webhooks', async () => {
    const ctx = await setup();
    await connectGoogle();
    expect(await inCo(() => pollGoogleReviews())).toBe(2);
    expect(await inCo(() => pollGoogleReviews())).toBe(0);
    const { threads } = await inCo(() => listInbox({ kind: 'review' }));
    expect(threads.map((x) => `${x.authorName}:${x.rating}:${x.answered}`).sort()).toEqual(['Arjun:5:true', 'Lakshmi:2:false']);
    await inCo(() => replyInbox({ thread: 'g:r:R1', text: 'Sorry, Lakshmi. Our team will call you today.' }, ctx));
    expect(hits(/PUT mybusiness\.googleapis\.com\/v4\/accounts\/1\/locations\/9\/reviews\/R1\/reply/)[0].params).toEqual({ comment: 'Sorry, Lakshmi. Our team will call you today.' });

    await t.company('test', { socialInbox: false });
    const raw = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PSID9' }, timestamp: 1, message: { mid: 'mid.9', text: 'hi' } }] }] });
    await webhookPOST(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', headers: { 'x-hub-signature-256': sign(raw) }, body: raw }));
    expect(await inCo(async () => (await col<any>('socialInbox')).countDocuments({ authorId: 'PSID9' }))).toBe(0);
  });
});

describe('post scheduler', () => {
  async function everything(ctx: Ctx) {
    await connectGoogle();
    await inCo(async () => {
      await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'linkedin', token: encryptSecret('LIT'), refresh: '', expiresAt: null, scopes: [], orgs: [{ urn: 'urn:li:organization:42', name: 'Amaya by Vera Vita' }], orgUrn: 'urn:li:organization:42', adAccounts: [], leadAccount: '' });
      await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'pinterest', token: encryptSecret('PIT'), refresh: '', expiresAt: null, username: 'amaya', boards: [{ id: 'B1', name: 'Amaya homes' }], boardId: 'B1' });
    });
    return inCo(() => uploadPostImage({ name: 'site.png', mime: 'image/png', base64: PNG.toString('base64') }, ctx));
  }

  it('posts to Facebook, Instagram, Google, LinkedIn and Pinterest at once; the image link is signed and served', async () => {
    const ctx = await setup();
    const img = await everything(ctx);
    const targets = await inCo(() => listPostTargets());
    expect(targets.map((x) => x.key)).toEqual(['facebook:PAGE1', 'instagram:IG1', 'google:accounts/1/locations/9', 'linkedin:urn:li:organization:42', 'pinterest:B1']);
    const p = await inCo(() => createPost({ text: 'Site visits open this weekend.', link: 'https://amaya.example/visit', imageFileId: img.fileId, targets: targets.map((x) => x.key) }, ctx));
    expect(p.status).toBe('published');
    expect(p.targets.map((x) => `${x.kind}:${x.status}:${x.url}`)).toEqual([
      'facebook:posted:https://www.facebook.com/PAGE1_POST1', 'instagram:posted:https://www.instagram.com/p/abc/', 'google:posted:https://g.co/post77',
      'linkedin:posted:https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3AS1/', 'pinterest:posted:https://www.pinterest.com/pin/PIN1/',
    ]);
    const imageUrl = hits(/POST graph\.facebook\.com\/IG1\/media$/)[0].params.image_url as string;
    expect(imageUrl).toMatch(/^https:\/\/crm\.example\.com\/api\/public\/media\/CMP-test\/[a-f0-9]{24}\?sig=/);
    expect(hits(/POST graph\.facebook\.com\/PAGE1\/photos/)[0].params.caption).toBe('Site visits open this weekend.\n\nhttps://amaya.example/visit');
    expect(hits(/api\.linkedin\.com\/rest\/posts/)[0].params).toMatchObject({ author: 'urn:li:organization:42', content: { media: { id: 'urn:li:image:I1' } } });
    expect(hits(/mybusiness\.googleapis\.com.*localPosts/)[0].params).toMatchObject({ summary: 'Site visits open this weekend.', callToAction: { actionType: 'LEARN_MORE', url: 'https://amaya.example/visit' } });

    const u = new URL(imageUrl);
    const [, , , , companyId, fileId] = u.pathname.split('/');
    const ok = await mediaGET(new Request(imageUrl), { params: Promise.resolve({ companyId, fileId }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    const bad = await mediaGET(new Request(imageUrl.replace(/sig=.*/, 'sig=nope')), { params: Promise.resolve({ companyId, fileId }) });
    expect(bad.status).toBe(404);
    expect(await inCo(async () => publicMediaUrl(fileId))).toBe(imageUrl);
  });

  it('checks before posting; a scheduled post goes out when due; a failed account is retried alone', async () => {
    const ctx = await setup();
    const img = await everything(ctx);
    await expect(inCo(() => createPost({ text: 'No image', targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/Instagram needs an image/);
    await expect(inCo(() => createPost({ text: 'x'.repeat(1600), targets: ['google:accounts/1/locations/9'] }, ctx))).rejects.toThrow(/1500/);
    await expect(inCo(() => createPost({ text: 'Hi', targets: ['facebook:OTHER'] }, ctx))).rejects.toThrow(/no longer connected/);
    await expect(inCo(() => createPost({ text: 'Hi', targets: ['facebook:PAGE1'], scheduledAt: '2020-01-01T00:00:00Z' }, ctx))).rejects.toThrow(/has passed/);

    const at = new Date(Date.now() + 3600e3);
    const p = await inCo(() => createPost({ text: 'Diwali offer', imageFileId: img.fileId, targets: ['facebook:PAGE1', 'pinterest:B1'], scheduledAt: at.toISOString() }, ctx));
    expect(p.status).toBe('scheduled');
    expect(hits(/PAGE1\/photos/)).toHaveLength(0);
    expect(await runPostsCron(new Date())).toEqual({});
    failPinterest = true;
    expect(await runPostsCron(new Date(at.getTime() + 60000))).toEqual({ test: { partial: 1 } });
    failPinterest = false;
    const again = await inCo(() => retryPost({ id: p.id }, ctx));
    expect(again.status).toBe('published');
    expect(hits(/PAGE1\/photos/)).toHaveLength(1); // Facebook was not posted twice
  });

  it('a scheduled post can be moved by the planner, but not into the past or once posted, and goes out at the new time', async () => {
    const ctx = await setup();
    await everything(ctx);
    const at = new Date(Date.now() + 3600e3);
    const p = await inCo(() => createPost({ text: 'Open house', targets: ['facebook:PAGE1'], scheduledAt: at.toISOString() }, ctx));
    const moved = new Date(Date.now() + 2 * 86400e3);
    expect(await inCo(() => reschedulePost({ id: p.id, scheduledAt: moved.toISOString() }, ctx))).toMatchObject({ id: p.id, text: 'Open house', status: 'scheduled', scheduledAt: moved.toISOString() });
    await expect(inCo(() => reschedulePost({ id: p.id, scheduledAt: '2020-01-01T00:00:00Z' }, ctx))).rejects.toThrow(/has passed/);
    await expect(inCo(() => reschedulePost({ id: p.id }, ctx))).rejects.toThrow(/valid date/);
    expect(await runPostsCron(new Date(at.getTime() + 60000))).toEqual({});
    expect(await runPostsCron(new Date(moved.getTime() + 60000))).toEqual({ test: { published: 1 } });
    await expect(inCo(() => reschedulePost({ id: p.id, scheduledAt: new Date(Date.now() + 3600e3).toISOString() }, ctx))).rejects.toThrow(/Only a scheduled post/);
  });

  it('the list searches the text, safely, and filters by account', async () => {
    const ctx = await setup();
    await everything(ctx);
    const at = new Date(Date.now() + 3600e3).toISOString();
    await inCo(() => createPost({ text: 'Diwali (offer) price', targets: ['facebook:PAGE1'], scheduledAt: at }, ctx));
    await inCo(() => createPost({ text: 'Site visit', targets: ['google:accounts/1/locations/9'], scheduledAt: at }, ctx));
    const texts = async (d: any) => (await inCo(() => listPosts(d))).posts.map((x) => x.text);
    expect(await texts({ q: 'diwali' })).toEqual(['Diwali (offer) price']);
    expect(await texts({ q: '(offer)' })).toEqual(['Diwali (offer) price']); // a bracket is text, not a pattern
    expect(await texts({ q: '.*' })).toEqual([]);
    expect(await texts({ account: 'google:accounts/1/locations/9' })).toEqual(['Site visit']);
    expect(await texts({ q: 'diwali', account: 'google:accounts/1/locations/9' })).toEqual([]);
  });

  it('several photos: one Facebook post with them attached, an Instagram carousel, and the first photo elsewhere', async () => {
    const ctx = await setup();
    const a = await everything(ctx);
    const b = await inCo(() => uploadPostImage({ name: 'two.png', mime: 'image/png', base64: PNG.toString('base64') }, ctx));
    const p = await inCo(() => createPost({ text: 'Three towers', imageFileIds: [a.fileId, b.fileId], targets: ['facebook:PAGE1', 'instagram:IG1', 'pinterest:B1'] }, ctx));
    expect(p.status).toBe('published');
    expect(p).toMatchObject({ imageFileId: a.fileId, imageFileIds: [a.fileId, b.fileId], imageUrls: [`/api/files/${a.fileId}`, `/api/files/${b.fileId}`] });
    const staged = hits(/POST graph\.facebook\.com\/PAGE1\/photos/);
    expect(staged.map((c) => c.params.published)).toEqual(['false', 'false']);
    const feed = hits(/POST graph\.facebook\.com\/PAGE1\/feed/)[0].params;
    expect(feed.message).toBe('Three towers');
    expect(JSON.parse(feed.attached_media)).toEqual([{ media_fbid: 'PH1' }, { media_fbid: 'PH2' }]);
    const ig = hits(/POST graph\.facebook\.com\/IG1\/media$/).map((c) => c.params);
    expect(ig.slice(0, 2).every((x) => x.is_carousel_item === 'true' && !x.caption)).toBe(true);
    expect(ig[2]).toMatchObject({ media_type: 'CAROUSEL', children: 'CH3,CH4', caption: 'Three towers' });
    expect(hits(/POST graph\.facebook\.com\/IG1\/media_publish/)[0].params.creation_id).toBe('PARENT');
    expect(String(hits(/api\.pinterest\.com\/v5\/pins/)[0].params.media_source.url)).toContain(a.fileId);
  });

  it('text per platform, and only for the platforms chosen; limits apply to the text each one gets', async () => {
    const ctx = await setup();
    const img = await everything(ctx);
    const p = await inCo(() => createPost({ text: 'For all', texts: { instagram: 'Only #Instagram', linkedin: 'Not chosen' }, imageFileIds: [img.fileId], targets: ['facebook:PAGE1', 'instagram:IG1'] }, ctx));
    expect(p.texts).toEqual({ instagram: 'Only #Instagram' });
    expect(hits(/POST graph\.facebook\.com\/PAGE1\/photos/)[0].params.caption).toBe('For all');
    expect(hits(/POST graph\.facebook\.com\/IG1\/media$/)[0].params.caption).toBe('Only #Instagram');
    await expect(inCo(() => createPost({ text: 'Short', texts: { instagram: 'x'.repeat(2300) }, imageFileIds: [img.fileId], targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/2200/);
    // a long caption is fine elsewhere when Instagram has its own
    const ok = await inCo(() => createPost({ text: 'y'.repeat(2500), texts: { instagram: 'Short' }, imageFileIds: [img.fileId], targets: ['facebook:PAGE1', 'instagram:IG1'] }, ctx));
    expect(ok.status).toBe('published');
    const many = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    await expect(inCo(() => createPost({ text: many, imageFileIds: [img.fileId], targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/30 hashtags/);
    expect((await inCo(() => createPost({ text: many, targets: ['facebook:PAGE1'] }, ctx))).status).toBe('published');
    await expect(inCo(() => createPost({ text: 'x', imageFileIds: Array.from({ length: 11 }, (_, i) => `f${i}`), targets: ['facebook:PAGE1'] }, ctx))).rejects.toThrow(/up to 10/);
  });

  it('the first comment follows the post on Facebook and Instagram; if it fails the post still counts and says why', async () => {
    const ctx = await setup();
    const img = await everything(ctx);
    const p = await inCo(() => createPost({ text: 'Open house', firstComment: 'Book here', imageFileIds: [img.fileId], targets: ['facebook:PAGE1', 'instagram:IG1', 'pinterest:B1'] }, ctx));
    expect(p.status).toBe('published');
    expect(hits(/POST graph\.facebook\.com\/PAGE1_POST1\/comments/)[0].params.message).toBe('Book here');
    expect(hits(/POST graph\.facebook\.com\/M1\/comments/)[0].params.message).toBe('Book here');
    failComment = true;
    const q = await inCo(() => createPost({ text: 'Again', firstComment: 'Nope', targets: ['facebook:PAGE1'] }, ctx));
    expect(q.status).toBe('published');
    expect(q.targets[0].commentError).toContain('Comments are off');
    const onlyPin = await inCo(() => createPost({ text: 'Pin', firstComment: 'Ignored', imageFileIds: [img.fileId], targets: ['pinterest:B1'] }, ctx));
    expect(onlyPin.firstComment).toBe('');
  });

  it('a draft is never posted, can stay unfinished, and is listed whatever its date', async () => {
    const ctx = await setup();
    const img = await everything(ctx);
    await expect(inCo(() => createPost({ draft: true, text: '' }, ctx))).rejects.toThrow(/Write the post/);
    const d = await inCo(() => createPost({ draft: true, text: 'Idea for Instagram', targets: ['instagram:IG1'] }, ctx));
    expect(d.status).toBe('draft');
    const later = new Date(Date.now() + 90 * 86400000);
    expect(await runPostsCron(later)).toEqual({});
    expect(hits(/IG1\/media/)).toHaveLength(0);
    const far = await inCo(() => listPosts({ from: later.toISOString(), to: new Date(later.getTime() + 86400000).toISOString() }));
    expect(far.posts.map((p) => p.id)).toEqual([d.id]);
    // finishing it needs everything a real post needs
    await expect(inCo(() => updatePost({ id: d.id, text: 'Idea for Instagram', targets: ['instagram:IG1'] }, ctx))).rejects.toThrow(/needs an image/);
    const done = await inCo(() => updatePost({ id: d.id, text: 'Ready', imageFileId: img.fileId, targets: ['instagram:IG1'] }, ctx));
    expect(done.status).toBe('published');
    expect(done.imageFileId).toBe(img.fileId);
    expect(hits(/IG1\/media_publish/)).toHaveLength(1);
  });

  it('a scheduled post can be changed or moved until it is posted, and the planner gets one month', async () => {
    const ctx = await setup();
    await everything(ctx);
    const at = new Date(Date.now() + 3600e3);
    const p = await inCo(() => createPost({ text: 'First', targets: ['facebook:PAGE1'], scheduledAt: at.toISOString() }, ctx));
    const moved = new Date(Date.now() + 7200e3);
    const changed = await inCo(() => updatePost({ id: p.id, text: 'Second', targets: ['facebook:PAGE1'], scheduledAt: moved.toISOString() }, ctx));
    expect(changed).toMatchObject({ id: p.id, text: 'Second', status: 'scheduled', scheduledAt: moved.toISOString() });
    expect(await runPostsCron(new Date(at.getTime() + 60000))).toEqual({}); // the old time no longer applies
    const none = await inCo(() => listPosts({ from: new Date(Date.now() - 86400e3).toISOString(), to: new Date(Date.now() - 3600e3).toISOString() }));
    expect(none.posts).toEqual([]);
    expect(await runPostsCron(new Date(moved.getTime() + 60000))).toEqual({ test: { published: 1 } });
    await expect(inCo(() => updatePost({ id: p.id, text: 'Too late', targets: ['facebook:PAGE1'] }, ctx))).rejects.toThrow(/Only a draft or a scheduled/);
    await expect(inCo(() => deletePost({ id: p.id }, ctx))).rejects.toThrow(/Only a draft/);
    const d = await inCo(() => createPost({ draft: true, text: 'Bin me' }, ctx));
    expect(await inCo(() => deletePost({ id: d.id }, ctx))).toEqual({ ok: true });
  });
});
