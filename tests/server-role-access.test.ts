/** Roles & access: an Admin chooses, the server enforces, and nothing outside the fixed list can ever be given. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login, can as serverCan } from '../server/core/auth';
import { clearRoleAccessCache } from '../server/core/roleAccess';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { ACCESS_ITEMS, accessFor, accessSays, cleanConfig, itemDefault, itemOffered, itemOn, CONFIGURABLE_ROLES } from '../src/core/roleAccess';
import { can as clientCan } from '../src/core/rbac';
import { viewAllowed } from '../src/core/views';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.9.9.9' };
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const session = (role: 'Admin' | 'Manager' | 'RM' | 'Viewer') => inCo(async () => {
  const email = `${role.toLowerCase()}@roles.test`;
  await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  return (await login(email, 'long-enough-pw', base)).token;
});
const call = (action: string, data: any, token: string) => inCo(() => dispatch(action, data, { ...base, token }));
const me = async (token: string) => ((await call('me', {}, token)).body as any).data;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await t.company('test', { socialPosts: true, reports: true });
  clearRoleAccessCache();
});

describe('the list', () => {
  it('starts from exactly what each role has today, on both sides', () => {
    for (const { id: role } of CONFIGURABLE_ROLES) {
      for (const item of ACCESS_ITEMS) {
        if (item.screen) continue;
        for (const p of item.perms) {
          expect(clientCan({ role } as any, p), `${role} ${p} browser`).toBe(itemDefault(role, item));
          expect(serverCan({ role } as any, p), `${role} ${p} server`).toBe(itemDefault(role, item));
        }
      }
    }
  });

  it('no choices means no changes', () => {
    for (const { id } of CONFIGURABLE_ROLES) expect(accessFor(id, {})).toBeNull();
    expect(accessFor('Admin', { Manager: { marketing: false } })).toBeNull();
  });

  it('never offers settings, keys, connected accounts or managing users', () => {
    const offered = ACCESS_ITEMS.flatMap((i) => i.perms as string[]);
    for (const p of offered) expect(p).not.toMatch(/^(settings|secrets|developer|users|integrations)\b/);
  });

  it('a View only user can never be given anything that changes data', () => {
    for (const item of ACCESS_ITEMS.filter((i) => i.writes)) expect(itemOffered('Viewer', item)).toBe(false);
    const c = cleanConfig({ Viewer: { 'marketing.posts': true, 'marketing.drip': true, 'leads.edit': true, 'leads.export': true } });
    expect(c).toEqual({ Viewer: { 'leads.export': true } });
  });

  it('drops anything not on the list, roles included', () => {
    expect(cleanConfig({ RM: { 'settings.edit': true, 'users.manage': true, 'marketing.posts': true }, Admin: { 'marketing.posts': false }, Developer: { x: true } })).toEqual({ RM: { 'marketing.posts': true } });
    expect(cleanConfig({ RM: { 'marketing.posts': 'yes' } })).toEqual({});
    expect(cleanConfig(null)).toEqual({});
  });

  it('something off takes what depends on it with it', () => {
    const send = ACCESS_ITEMS.find((i) => i.id === 'chat.send')!;
    expect(itemOn('RM', send, {})).toBe(true);
    expect(itemOn('RM', send, { 'chat.view': false })).toBe(false);
    const a = accessFor('RM', { RM: { 'chat.view': false } })!;
    expect(a.deny).toEqual(expect.arrayContaining(['chat.view', 'chat.send']));
  });

  it('turns screens off, and only those', () => {
    const a = accessFor('RM', { RM: { 'screen.mis': false } })!;
    expect(a.hide).toEqual(['mis']);
    const can = (p: string) => accessSays(a, p) ?? true;
    expect(viewAllowed('mis', { features: {} }, can as any)).toBe(false);
    expect(viewAllowed('kanban', { features: {} }, can as any)).toBe(true);
    expect(viewAllowed('dashboard', { features: {} }, can as any)).toBe(true);
  });
});

describe('the marketing switches', () => {
  it('each opens only its own part', async () => {
    await t.company('test', { socialPosts: true, dripCampaigns: true, adsControl: true, competitorAds: true });
    const admin = await session('Admin');
    const rm = await session('RM');
    const results = async () => ({
      posts: (await call('listPosts', {}, rm)).status, insights: (await call('getSocialInsights', {}, rm)).status,
      drip: (await call('getDrip', {}, rm)).status, ads: (await call('setCampaignStatus', {}, rm)).status, competitors: (await call('saveCompetitor', {}, rm)).status,
    });
    expect(await results()).toEqual({ posts: 403, insights: 403, drip: 403, ads: 403, competitors: 403 });
    await call('saveRoleAccess', { config: { RM: { 'marketing.posts': true } } }, admin);
    expect(await results()).toMatchObject({ posts: 200, insights: 200, drip: 403, ads: 403, competitors: 403 });
    await call('saveRoleAccess', { config: { RM: { 'marketing.drip': true } } }, admin);
    expect(await results()).toMatchObject({ posts: 403, insights: 403, drip: 200, ads: 403, competitors: 403 });
    await call('saveRoleAccess', { config: { RM: { 'leads.all': true, 'marketing.ads': true } } }, admin);
    const ads = await results();
    expect(ads).toMatchObject({ posts: 403, drip: 403, competitors: 403 });
    expect(ads.ads).not.toBe(403); // through the permission check; what it was sent is another matter
    await call('saveRoleAccess', { config: { RM: { 'marketing.other': true } } }, admin);
    const other = await results();
    expect(other).toMatchObject({ posts: 403, drip: 403, ads: 403 });
    expect(other.competitors).not.toBe(403);
  });

  it('a Manager keeps them all by default, and can lose one', async () => {
    await t.company('test', { socialPosts: true, dripCampaigns: true });
    const admin = await session('Admin');
    const manager = await session('Manager');
    expect((await call('listPosts', {}, manager)).status).toBe(200);
    expect((await call('getDrip', {}, manager)).status).toBe(200);
    await call('saveRoleAccess', { config: { Manager: { 'marketing.drip': false } } }, admin);
    expect((await call('listPosts', {}, manager)).status).toBe(200);
    expect((await call('getDrip', {}, manager)).status).toBe(403);
  });

  it('a choice saved under the old single switch still counts for all of them', async () => {
    const ids = ['marketing.posts', 'marketing.ads', 'marketing.drip', 'marketing.other'];
    const on = ACCESS_ITEMS.filter((i) => ids.includes(i.id));
    expect(on).toHaveLength(4);
    expect(on.filter((i) => itemOn('RM', i, { 'leads.all': true, marketing: true })).length).toBe(4);
    expect(on.filter((i) => itemOn('Manager', i, { marketing: false })).length).toBe(0);
    const saved = accessFor('Manager', { Manager: { marketing: false } } as any)!;
    expect(saved.deny).toEqual(expect.arrayContaining(['marketing.posts', 'marketing.ads', 'marketing.drip', 'marketing.manage']));
    // a new choice wins over the old one
    expect(itemOn('Manager', on[0], { marketing: false, 'marketing.posts': true })).toBe(true);
  });

  it('changing ads needs seeing all leads, because that is what opens the Ads screen', () => {
    const ads = ACCESS_ITEMS.find((i) => i.id === 'marketing.ads')!;
    expect(itemOn('RM', ads, { 'marketing.ads': true })).toBe(false);
    expect(itemOn('RM', ads, { 'marketing.ads': true, 'leads.all': true })).toBe(true);
  });
});

describe('enforced on the server', () => {
  it('an Agent can be given marketing, and a Manager can lose it', async () => {
    const admin = await session('Admin');
    const rm = await session('RM');
    const manager = await session('Manager');
    expect((await call('listPosts', {}, rm)).status).toBe(403);
    expect((await call('listPosts', {}, manager)).status).toBe(200);
    expect((await call('saveRoleAccess', { config: { RM: { 'marketing.posts': true }, Manager: { 'marketing.posts': false } } }, admin)).status).toBe(200);
    expect((await call('listPosts', {}, rm)).status).toBe(200);
    expect((await call('listPosts', {}, manager)).status).toBe(403);
    // back to how it was
    expect((await call('saveRoleAccess', { config: {} }, admin)).status).toBe(200);
    expect((await call('listPosts', {}, rm)).status).toBe(403);
    expect((await call('listPosts', {}, manager)).status).toBe(200);
  });

  it('Admins always keep everything, whatever is chosen', async () => {
    const admin = await session('Admin');
    await call('saveRoleAccess', { config: { Manager: { 'marketing.posts': false }, RM: { 'marketing.posts': false } } }, admin);
    expect((await call('listPosts', {}, admin)).status).toBe(200);
    expect((await call('getRoleAccess', {}, admin)).status).toBe(200);
  });

  it('only those who manage users can change it', async () => {
    const manager = await session('Manager');
    const rm = await session('RM');
    const viewer = await session('Viewer');
    for (const token of [manager, rm, viewer]) {
      expect((await call('getRoleAccess', {}, token)).status).toBe(403);
      expect((await call('saveRoleAccess', { config: { RM: { marketing: true } } }, token)).status).toBe(403);
    }
  });

  it('nothing sent can give what is not on the list', async () => {
    const admin = await session('Admin');
    const rm = await session('RM');
    await call('saveRoleAccess', { config: { RM: { 'settings.edit': true, 'users.manage': true, 'integrations.connect': true } } }, admin);
    expect((await call('getRoleAccess', {}, rm)).status).toBe(403);
    expect((await call('getConversionRules', {}, rm)).status).toBe(403);
  });

  it('a View only user stays read only, even with a change forced in', async () => {
    const admin = await session('Admin');
    const viewer = await session('Viewer');
    await call('saveRoleAccess', { config: { Viewer: { 'marketing.posts': true } } }, admin);
    expect((await call('listPosts', {}, viewer)).status).toBe(403);
    expect((await call('saveRoleAccess', { config: {} }, viewer)).status).toBe(403);
  });

  it('the browser is told, so the screen matches', async () => {
    const admin = await session('Admin');
    const rm = await session('RM');
    await call('saveRoleAccess', { config: { RM: { 'marketing.posts': true, 'screen.mis': false } } }, admin);
    const u = await me(rm);
    const user = u?.user || u;
    expect(user.access).toMatchObject({ allow: ['marketing.posts'], hide: ['mis'] });
    expect(clientCan(user, 'marketing.posts')).toBe(true);
    expect(clientCan(user, 'marketing.drip')).toBe(false);
    expect(clientCan(user, 'view.mis' as any)).toBe(false);
    expect(clientCan(user, 'view.kanban' as any)).toBe(true);
  });

  it('each company has its own', async () => {
    const admin = await session('Admin');
    await call('saveRoleAccess', { config: { RM: { 'marketing.posts': true } } }, admin);
    const { accessOfRole, loadRoleAccess } = await import('../server/core/roleAccess');
    expect(await inCo(() => loadRoleAccess())).toEqual({ RM: { 'marketing.posts': true } }); // now kept for this company
    // the test helper puts every company in one database; real companies have their own
    const other = { ...(await getTenantById('CMP-test'))!, id: 'CMP-other', dbName: 'role_access_other' };
    await runWithTenant(other, async () => {
      expect(await loadRoleAccess()).toEqual({});
      expect(await accessOfRole('RM')).toBeNull();
    });
  });

  it('changes are logged', async () => {
    const admin = await session('Admin');
    await call('saveRoleAccess', { config: { RM: { 'marketing.posts': true } } }, admin);
    const { col } = await import('../server/core/db');
    const { CFG } = await import('../server/core/config');
    const log = await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).findOne({ action: 'Role Access Changed' }));
    expect(log?.details).toContain('RM');
  });
});
