/** Post scheduler › Instagram view: the account's public profile from Meta, kept a while; a refusal is said, never a blank. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { clearInstagramProfileCache, getInstagramProfile } from '../server/modules/instagramProfile';

let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: URL[] = [];
let refuse = false;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fake(input: any): Promise<Response> {
  const url = new URL(String(input));
  calls.push(url);
  if (refuse) return json(400, { error: { message: 'Missing permission', code: 10 } });
  return json(200, { username: 'amaya.living', name: 'Amaya', biography: 'Senior living', website: 'https://amaya.example/', profile_picture_url: 'https://cdn.example/p.jpg', followers_count: 1200, follows_count: 40, media_count: 88 });
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
  clearInstagramProfileCache();
  calls = [];
  refuse = false;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'metaSocial', pages: [{ id: 'PAGE1', name: 'Amaya', token: encryptSecret('PT'), igId: 'IG1', igUsername: 'amaya' }] }));
});
afterEach(() => vi.unstubAllGlobals());

describe('profile', () => {
  it('reads the connected account, and keeps it a while', async () => {
    const r = await inCo(() => getInstagramProfile({ account: 'instagram:IG1' }));
    expect(r).toMatchObject({ username: 'amaya.living', name: 'Amaya', bio: 'Senior living', website: 'https://amaya.example/', picture: 'https://cdn.example/p.jpg', followers: 1200, following: 40, posts: 88, error: '' });
    expect(calls[0].pathname).toMatch(/\/IG1$/);
    await inCo(() => getInstagramProfile({ account: 'instagram:IG1' }));
    expect(calls).toHaveLength(1);
    await inCo(() => getInstagramProfile({ account: 'instagram:IG1', refresh: true }));
    expect(calls).toHaveLength(2);
  });

  it('a refusal keeps the name and says why, and counts stay unknown rather than zero', async () => {
    refuse = true;
    const r = await inCo(() => getInstagramProfile({ account: 'instagram:IG1' }));
    expect(r).toMatchObject({ username: 'amaya', followers: null, posts: null });
    expect(r.error).toContain('Missing permission');
  });

  it('drops unsafe links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { username: 'a', website: 'javascript:alert(1)', profile_picture_url: 'http://cdn.example/p.jpg' })));
    const r = await inCo(() => getInstagramProfile({ account: 'instagram:IG1' }));
    expect(r.website).toBe('');
    expect(r.picture).toBe('');
  });

  it('only a connected Instagram account', async () => {
    await expect(inCo(() => getInstagramProfile({ account: 'instagram:OTHER' }))).rejects.toThrow(/no longer connected/);
    await expect(inCo(() => getInstagramProfile({ account: 'facebook:PAGE1' }))).rejects.toThrow(/no longer connected/);
    expect(calls).toHaveLength(0);
  });

  it('needs the post scheduler, and the marketing permission', async () => {
    const base = { userAgent: 'vitest', ip: '10.9.9.9' };
    const session = (role: 'Admin' | 'RM') => inCo(async () => {
      const email = `${role.toLowerCase()}@ig.test`;
      await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
      return (await login(email, 'long-enough-pw', base)).token;
    });
    const body = { account: 'instagram:IG1' };
    const rm = await session('RM');
    expect((await inCo(() => dispatch('getInstagramProfile', body, { ...base, token: rm }))).status).toBe(403);
    const admin = await session('Admin');
    expect((await inCo(() => dispatch('getInstagramProfile', body, { ...base, token: admin }))).status).toBe(200);
    await t.company('test', { socialPosts: false });
    expect((await inCo(() => dispatch('getInstagramProfile', body, { ...base, token: admin }))).status).toBe(403);
  });
});
