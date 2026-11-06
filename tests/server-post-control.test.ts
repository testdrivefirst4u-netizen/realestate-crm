/** Post scheduler › after posting: edit the text on one account, delete from the accounts chosen. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { BUSINESS_SCOPE } from '../server/modules/googleMarketing';
import { deletePost, deletePublishedPost, editPublishedPost, listPosts, publishPost } from '../server/modules/socialPosts';

let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: Array<{ host: string; path: string; method: string; query: URLSearchParams; body: string }> = [];
let refuse: Record<string, string> = {};
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const GOOGLE_POST = 'accounts/9/locations/1/localPosts/5';
const FB = { key: 'facebook:PAGE1', kind: 'facebook', name: 'Amaya Page', status: 'posted', postId: 'PAGE1_7', url: 'https://www.facebook.com/PAGE1_7' };
const IG = { key: 'instagram:IG1', kind: 'instagram', name: '@amaya', status: 'posted', postId: 'M7', url: 'https://www.instagram.com/p/m7/' };
const GO = { key: 'google:accounts/9/locations/1', kind: 'google', name: 'Amaya', status: 'posted', postId: GOOGLE_POST };
const LI = { key: 'linkedin:urn:li:organization:1', kind: 'linkedin', name: 'Amaya Co', status: 'posted', postId: 'urn:li:share:1' };

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  const path = url.pathname.replace(/^\/v\d+(\.\d+)?\//, '/');
  const method = String(init.method || 'GET');
  calls.push({ host: url.host, path, method, query: url.searchParams, body: String(init.body || '') });
  if (refuse[path]) return json(400, { error: { message: refuse[path], code: 10 } });
  return json(200, { success: true });
}
const writes = () => calls.filter((c) => c.method !== 'GET');
const post = (extra: any) => inCo(async () => (await col<any>('socialPosts')).insertOne({ _id: 'POST-1', text: 'Hello', link: '', imageFileId: '', status: 'published', scheduledAt: new Date(), createdBy: 'x', createdAt: new Date(), updatedAt: new Date(), targets: [FB], ...extra }));
const saved = () => inCo(async () => (await col<any>('socialPosts')).findOne({ _id: 'POST-1' }));

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = 'secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-123';
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { socialPosts: true });
  resetGoogleOAuthTokenCache();
  calls = [];
  refuse = {};
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [{ id: 'PAGE1', name: 'Amaya Page', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' }] });
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '', connectedBy: 'x', connectedAt: new Date() });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'a@b.c', scopes: [BUSINESS_SCOPE] });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('delete from the platforms', () => {
  it('removes it from each account chosen, keeps a copy, and logs it', async () => {
    await post({ targets: [FB, IG, GO] });
    const r = await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key, IG.key, GO.key], confirm: true }, ctx));
    expect(r.deleted).toEqual(['Amaya Page', '@amaya', 'Amaya']);
    expect(r.failed).toEqual([]);
    expect(writes().map((c) => [c.method, c.path])).toEqual([['DELETE', '/PAGE1_7'], ['DELETE', '/M7'], ['DELETE', `/${GOOGLE_POST}`]]);
    expect(r.post.status).toBe('deleted');
    expect(r.post.text).toBe('Hello');
    const doc = await saved();
    expect(doc.targets[0]).toMatchObject({ status: 'deleted', deletedBy: 'Asha', postId: 'PAGE1_7' });
    const log = await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).findOne({ action: 'Published Post Deleted' }));
    expect(log?.details).toContain('Amaya Page');
  });

  it('only the accounts chosen; the rest stay live', async () => {
    await post({ targets: [FB, IG] });
    const r = await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx));
    expect(writes()).toHaveLength(1);
    expect(r.post.status).toBe('published');
    expect(r.post.targets.map((x) => x.status)).toEqual(['deleted', 'posted']);
  });

  it('a refusal leaves that account as it was and says why, and the rest still go', async () => {
    await post({ targets: [IG, FB] });
    refuse['/M7'] = '(#10) Application does not have permission for this action';
    const r = await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [IG.key, FB.key], confirm: true }, ctx));
    expect(r.deleted).toEqual(['Amaya Page']);
    expect(r.failed[0]).toMatchObject({ key: IG.key, name: '@amaya' });
    expect(r.failed[0].error).toMatch(/Meta permission/);
    expect(r.post.targets.map((x) => x.status)).toEqual(['posted', 'deleted']);
    expect(r.post.status).toBe('published');
  });

  it('an old post Facebook will not delete says where to delete it, not Meta\'s wording', async () => {
    await post({ imported: true });
    refuse['/PAGE1_7'] = "Unsupported delete request. Object with ID 'PAGE1_7' does not exist, cannot be loaded due to missing permissions, or does not support this operation.";
    const r = await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx));
    expect(r.failed[0].error).toMatch(/not published through the CRM/);
    expect(r.failed[0].error).not.toMatch(/Object with ID|advertiser/);
    expect(r.failed[0].url).toBe(FB.url);
    expect(r.post.imported).toBe(true);
    expect(r.post.status).toBe('published');
  });

  it('a post made in the CRM keeps Facebook\'s own words, so a real fault can be seen', async () => {
    await post({});
    refuse['/PAGE1_7'] = 'Unsupported delete request. Object does not exist';
    const r = await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx));
    expect(r.failed[0].error).toMatch(/Unsupported delete request/);
  });

  it('nothing logged when everything was refused', async () => {
    await post({});
    refuse['/PAGE1_7'] = 'Nope';
    const r = await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx));
    expect(r.deleted).toEqual([]);
    expect(r.post.status).toBe('published');
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Published Post Deleted' }))).toBe(0);
  });

  it('needs confirming, a choice, and an account that can be deleted from here', async () => {
    await post({ targets: [FB, LI] });
    await expect(inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key] }, ctx))).rejects.toThrow(/Confirm/);
    await expect(inCo(() => deletePublishedPost({ id: 'POST-1', targets: [], confirm: true }, ctx))).rejects.toThrow(/Choose where/);
    await expect(inCo(() => deletePublishedPost({ id: 'POST-1', targets: [LI.key], confirm: true }, ctx))).rejects.toThrow(/cannot be deleted/);
    await expect(inCo(() => deletePublishedPost({ id: 'POST-1', targets: ['facebook:OTHER'], confirm: true }, ctx))).rejects.toThrow(/cannot be deleted/);
    expect(writes()).toHaveLength(0);
  });

  it('only a post that is out, and not twice', async () => {
    await post({ status: 'scheduled', targets: [{ ...FB, status: 'pending', postId: '' }] });
    await expect(inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx))).rejects.toThrow(/that is out/);
    await inCo(async () => (await col<any>('socialPosts')).deleteOne({ _id: 'POST-1' }));
    await post({ targets: [FB, IG] });
    await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx));
    await expect(inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx))).rejects.toThrow(/cannot be deleted/);
    expect(writes()).toHaveLength(1);
  });

  it('a Google post name outside the location is refused', async () => {
    await post({ targets: [{ ...GO, postId: 'accounts/1/locations/999/localPosts/1' }] });
    const r = await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [GO.key], confirm: true }, ctx));
    expect(r.failed).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it('a retry never brings a deleted post back', async () => {
    await post({ status: 'partial', targets: [{ ...FB, status: 'deleted' }, { ...IG, status: 'failed', postId: '', error: 'x' }, { ...LI }] });
    refuse['/IG1/media'] = 'Still no';
    const p = await inCo(() => publishPost('POST-1', { retry: true }));
    expect(p!.targets.map((x: any) => x.status)).toEqual(['deleted', 'failed', 'posted']);
    expect(writes().some((c) => c.path.includes('PAGE1'))).toBe(false);
  });

  it('the copy shows under Deleted, and can then be removed from the CRM', async () => {
    await post({});
    await expect(inCo(() => deletePost({ id: 'POST-1' }, ctx))).rejects.toThrow(/Delete from platforms/);
    await inCo(() => deletePublishedPost({ id: 'POST-1', targets: [FB.key], confirm: true }, ctx));
    const { posts } = await inCo(() => listPosts({ from: '2000-01-01T00:00:00Z', statuses: ['deleted'] }));
    expect(posts.map((p) => p.id)).toEqual(['POST-1']);
    await inCo(() => deletePost({ id: 'POST-1' }, ctx));
    expect(await saved()).toBeNull();
  });
});

describe('edit the text', () => {
  it('changes a Google post, only its summary', async () => {
    await post({ targets: [GO] });
    const r = await inCo(() => editPublishedPost({ id: 'POST-1', text: 'New words' }, ctx));
    const w = writes()[0];
    expect(w).toMatchObject({ method: 'PATCH', path: `/${GOOGLE_POST}`, host: 'mybusiness.googleapis.com' });
    expect(w.query.get('updateMask')).toBe('summary');
    expect(JSON.parse(w.body)).toEqual({ summary: 'New words' });
    expect(r.text).toBe('New words');
    await expect(inCo(() => editPublishedPost({ id: 'POST-1', text: 'x'.repeat(1501) }, ctx))).rejects.toThrow(/1500/);
  });

  it('with several accounts, changes only the one chosen', async () => {
    await post({ targets: [FB, GO] });
    await expect(inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx))).rejects.toThrow(/Choose which/);
    const r = await inCo(() => editPublishedPost({ id: 'POST-1', text: 'New', target: GO.key }, ctx));
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toBe(`/${GOOGLE_POST}`);
    expect(r.text).toBe('Hello');
    expect(r.targets[1].text).toBe('New');
    expect(r.targets[0].text).toBeUndefined();
  });

  it('keeps the link of a Facebook photo post', async () => {
    await post({ link: 'https://amaya.example/x', imageFileId: 'F1', imageFileIds: ['F1'] });
    await inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx));
    expect(new URLSearchParams(writes()[0].body).get('message')).toBe('New\n\nhttps://amaya.example/x');
    await inCo(() => editPublishedPost({ id: 'POST-1', text: 'See https://amaya.example/x' }, ctx));
    expect(new URLSearchParams(writes()[1].body).get('message')).toBe('See https://amaya.example/x');
  });

  it('own text of a platform does not hide the edit', async () => {
    await post({ texts: { facebook: 'Old own text' } });
    const r = await inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx));
    expect(r.text).toBe('New');
    expect(r.texts.facebook).toBeUndefined();
  });

  it('refuses Instagram, others, stories and deleted accounts, and keeps the text when refused', async () => {
    await post({ targets: [IG] });
    await expect(inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx))).rejects.toThrow(/Instagram does not let/);
    await inCo(async () => (await col<any>('socialPosts')).updateOne({ _id: 'POST-1' }, { $set: { targets: [LI] } }));
    await expect(inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx))).rejects.toThrow(/platform itself/);
    await inCo(async () => (await col<any>('socialPosts')).updateOne({ _id: 'POST-1' }, { $set: { targets: [FB], postType: 'story' } }));
    await expect(inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx))).rejects.toThrow(/story/);
    await inCo(async () => (await col<any>('socialPosts')).updateOne({ _id: 'POST-1' }, { $set: { targets: [{ ...FB, status: 'deleted' }], postType: 'post' } }));
    await expect(inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx))).rejects.toThrow(/Choose which/);
    expect(writes()).toHaveLength(0);
    await inCo(async () => (await col<any>('socialPosts')).updateOne({ _id: 'POST-1' }, { $set: { targets: [FB] } }));
    refuse['/PAGE1_7'] = 'Only posts made by this app';
    await expect(inCo(() => editPublishedPost({ id: 'POST-1', text: 'New' }, ctx))).rejects.toThrow(/made by this app/);
    expect((await saved()).text).toBe('Hello');
  });
});

describe('who', () => {
  it('needs the feature and the marketing permission', async () => {
    await post({});
    const session = async (role: 'Admin' | 'RM') => inCo(async () => {
      const email = `${role.toLowerCase()}@posts.test`;
      await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
      return (await login(email, 'long-enough-pw', { userAgent: 'vitest', ip: '10.9.9.9' })).token;
    });
    const base = { userAgent: 'vitest', ip: '10.9.9.9' };
    const body = { id: 'POST-1', targets: [FB.key], confirm: true };
    const rm = await session('RM');
    expect((await inCo(() => dispatch('deletePublishedPost', body, { ...base, token: rm }))).status).toBe(403);
    const admin = await session('Admin');
    await t.company('test', { socialPosts: false });
    expect((await inCo(() => dispatch('deletePublishedPost', body, { ...base, token: admin }))).status).toBe(403);
    expect(writes()).toHaveLength(0);
    await t.company('test', { socialPosts: true });
    expect((await inCo(() => dispatch('deletePublishedPost', body, { ...base, token: admin }))).status).toBe(200);
  });
});
