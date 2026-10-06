/**
 * Super Admin platform: first-run setup, login throttling, the platform_session cookie flow, company
 * provisioning, tenant isolation, suspension, plan limits/features, cross-company e-mail uniqueness and deletion.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { getClient, PLATFORM_DB } from '../server/core/db';
import { platformDispatch } from '../server/platform/router';
import { dispatch } from '../server/router';
import { POST } from '../app/api/platform/rpc/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
const IP = '10.0.0.9';
const PW = 'super-secret-pw-1';

async function dropCompanyDbs() {
  const client = (await getClient())!;
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  for (const d of databases) if (d.name.startsWith('crm_')) await client.db(d.name).dropDatabase();
}
async function dbExists(name: string) {
  const client = (await getClient())!;
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  return databases.some((d) => d.name === name);
}

const pd = (action: string, data: any = {}, token = '', ip = IP) => platformDispatch(action, data, { token, userAgent: 'vitest', ip });
const body = (r: { body: Record<string, unknown> }) => r.body as any;

/** First super admin + session token. */
async function setupSa() {
  const r = await pd('saSetup', { name: 'Root', email: 'root@platform.io', password: PW });
  expect(r.status).toBe(200);
  return r.session!.token;
}

async function newCompany(sa: string, slug: string, extra: Record<string, unknown> = {}, adminEmail = `admin@${slug}.io`) {
  const r = await pd('createCompany', { name: `Co ${slug}`, slug, plan: 'growth', admin: { name: 'Boss', email: adminEmail, password: 'company-pw-123' }, ...extra }, sa);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return body(r).data.company as { id: string; slug: string; dbName: string };
}

async function crmLogin(email: string, password = 'company-pw-123') {
  return dispatch('login', { email, password }, { token: '', userAgent: 'vitest', ip: IP });
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await dropCompanyDbs();
  await t.stop();
});
beforeEach(async () => {
  await dropCompanyDbs();
  await t.reset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('super admin setup & login', () => {
  it('first-run setup works once, honours PLATFORM_SETUP_TOKEN and never returns the token in JSON', async () => {
    expect(body(await pd('saStatus')).data).toMatchObject({ setupRequired: true, setupTokenRequired: false });
    vi.stubEnv('PLATFORM_SETUP_TOKEN', 'setup-token-xyz');
    expect(body(await pd('saStatus')).data.setupTokenRequired).toBe(true);
    const short = await pd('saSetup', { name: 'Root', email: 'root@platform.io', password: 'short', setupToken: 'setup-token-xyz' });
    expect(short.status).toBe(400);
    expect((await pd('saSetup', { name: 'Root', email: 'root@platform.io', password: PW })).status).toBe(403);
    expect((await pd('saSetup', { name: 'Root', email: 'root@platform.io', password: PW, setupToken: 'wrong' })).status).toBe(403);
    const ok = await pd('saSetup', { name: 'Root', email: 'Root@Platform.io', password: PW, setupToken: 'setup-token-xyz' });
    expect(ok.status).toBe(200);
    expect(body(ok).data.user).toMatchObject({ id: 'SA-0001', email: 'root@platform.io', status: 'Active' });
    expect(ok.session?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ok.body)).not.toContain(ok.session!.token);
    const again = await pd('saSetup', { name: 'Evil', email: 'evil@x.io', password: PW, setupToken: 'setup-token-xyz' });
    expect(again.status).toBe(403);
    expect(body(await pd('saStatus')).data.setupRequired).toBe(false);
    const me = await pd('saMe', {}, ok.session!.token);
    expect(body(me).data.user.email).toBe('root@platform.io');
  });

  it('production requires PLATFORM_SETUP_TOKEN for web setup', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLATFORM_SETUP_TOKEN', '');
    const r = await pd('saSetup', { name: 'Root', email: 'root@platform.io', password: PW });
    expect(r.status).toBe(403);
    expect(body(r).message).toContain('create-superadmin');
  });

  it('locks an email+IP pair after 8 failures, with one message for unknown and wrong passwords', async () => {
    await setupSa();
    const unknown = await pd('saLogin', { email: 'nobody@platform.io', password: PW });
    const wrong = await pd('saLogin', { email: 'root@platform.io', password: 'nope-nope-nope' });
    expect(unknown.status).toBe(401);
    expect(body(unknown).message).toBe(body(wrong).message);
    for (let i = 0; i < 7; i++) await pd('saLogin', { email: 'root@platform.io', password: 'nope-nope-nope' });
    const locked = await pd('saLogin', { email: 'root@platform.io', password: PW });
    expect(locked.status).toBe(429);
    expect(body(locked).code).toBe('RATE_LIMIT');
    const otherIp = await pd('saLogin', { email: 'root@platform.io', password: PW }, '', '10.0.0.10');
    expect(otherIp.status).toBe(200);
  });

  it('signed-in actions need a session; cannot delete/disable self or the last active super admin', async () => {
    expect((await pd('listCompanies')).status).toBe(401);
    const sa = await setupSa();
    const me = body(await pd('saMe', {}, sa)).data.user;
    expect((await pd('deleteSuperAdmin', { id: me.id }, sa)).status).toBe(400);
    expect((await pd('saveSuperAdmin', { id: me.id, name: 'Root', email: 'root@platform.io', status: 'Disabled' }, sa)).status).toBe(400);
    const created = await pd('saveSuperAdmin', { name: 'Ops', email: 'ops@platform.io' }, sa);
    expect(created.status).toBe(200);
    const { user, temporaryPassword } = body(created).data;
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);
    const opsLogin = await pd('saLogin', { email: 'ops@platform.io', password: temporaryPassword });
    expect(opsLogin.status).toBe(200);
    const ops = opsLogin.session!.token;
    // disabling root (by ops) leaves ops as the last active one
    expect((await pd('saveSuperAdmin', { id: me.id, name: 'Root', email: 'root@platform.io', status: 'Disabled' }, ops)).status).toBe(200);
    expect((await pd('saMe', {}, sa)).status).toBe(401); // root's session is gone
    expect((await pd('deleteSuperAdmin', { id: user.id }, ops)).status).toBe(400); // self
    expect((await pd('saChangePassword', { currentPassword: temporaryPassword, newPassword: 'short' }, ops)).status).toBe(400);
    expect((await pd('saChangePassword', { currentPassword: temporaryPassword, newPassword: 'a-brand-new-password' }, ops)).status).toBe(200);
    const audit = body(await pd('auditLog', { limit: 50 }, ops)).data;
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['Platform Setup', 'Super Admin Created', 'Super Admin Logged In', 'Super Admin Updated']));
  });
});

describe('route handler & cookie', () => {
  const req = (action: string, data: any = {}, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/platform/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', ...headers },
      body: JSON.stringify({ action, data }),
    });

  it('sets an httpOnly strict cookie on setup, uses it, clears it on logout', async () => {
    const res = await POST(req('saSetup', { name: 'Root', email: 'root@platform.io', password: PW }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toMatch(/^platform_session=[0-9a-f]{64};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
    expect(setCookie).toMatch(/Path=\//);
    const json = await res.json();
    expect(json.status).toBe('success');
    const token = setCookie.match(/^platform_session=([0-9a-f]{64})/)![1];
    expect(JSON.stringify(json)).not.toContain(token);

    const me = await POST(req('saMe', {}, { cookie: `platform_session=${token}` }));
    expect(me.status).toBe(200);
    expect((await me.json()).data.user.email).toBe('root@platform.io');

    const cross = await POST(req('saMe', {}, { cookie: `platform_session=${token}`, origin: 'https://evil.example' }));
    expect(cross.status).toBe(403);

    const out = await POST(req('saLogout', {}, { cookie: `platform_session=${token}` }));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie') || '').toMatch(/platform_session=;.*Max-Age=0/i);

    const after = await POST(req('saMe', {}, { cookie: `platform_session=${token}` }));
    expect(after.status).toBe(401);
    expect(after.headers.get('set-cookie') || '').toMatch(/platform_session=;/);
  });

  it('rejects bodies over 1 MB and bad JSON', async () => {
    const big = new Request('http://localhost/api/platform/rpc', { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ action: 'saStatus', data: { x: 'a'.repeat(1100000) } }) });
    expect((await POST(big)).status).toBe(413);
    const bad = new Request('http://localhost/api/platform/rpc', { method: 'POST', headers: { host: 'localhost' }, body: '{nope' });
    expect((await POST(bad)).status).toBe(400);
  });
});

describe('companies', () => {
  it('provisions a separate database with a working first admin', async () => {
    const sa = await setupSa();
    const plans = body(await pd('listPlans', {}, sa)).data;
    expect(plans.map((p: any) => p.id)).toEqual(['starter', 'growth', 'enterprise']);

    for (const bad of ['a', '-x', 'API', 'admin', 'has space', 'x'.repeat(41)]) {
      const r = await pd('createCompany', { name: 'X', slug: bad, plan: 'growth', admin: { name: 'A', email: 'a@x.io' } }, sa);
      expect(r.status, bad).toBe(400);
    }
    const r = await pd('createCompany', { name: 'Alpha Homes', slug: 'alpha-homes', plan: 'growth', admin: { name: 'Asha', email: 'Asha@Alpha.io' } }, sa);
    expect(r.status).toBe(200);
    const { company, adminTemporaryPassword } = body(r).data;
    expect(company).toMatchObject({ id: 'CMP-0001', slug: 'alpha-homes', dbName: 'crm_alpha_homes', plan: 'growth', maxUsers: 25, activeUsers: 1, status: 'Active' });
    expect(company.users).toHaveLength(1);
    expect(company.users[0]).toMatchObject({ email: 'asha@alpha.io', role: 'Admin' });
    expect(adminTemporaryPassword).toBeTruthy();
    expect(await dbExists('crm_alpha_homes')).toBe(true);
    const client = (await getClient())!;
    expect(await client.db('crm_alpha_homes').collection('users').countDocuments()).toBe(1);
    expect(await client.db('amaya_test').collection('users').countDocuments()).toBe(0);
    expect((await client.db('crm_alpha_homes').collection('settings').findOne({ _id: 'appName' as any }))?.value).toBe('Alpha Homes');

    const login = await crmLogin('asha@alpha.io', adminTemporaryPassword);
    expect(login.status).toBe(200);
    expect(login.companyId).toBe('CMP-0001');
    expect(body(login).data.user.mustChangePassword).toBe(true);

    expect((await pd('createCompany', { name: 'Dup', slug: 'alpha-homes', plan: 'growth', admin: { name: 'B', email: 'b@x.io' } }, sa)).status).toBe(409);
    const list = body(await pd('listCompanies', { q: 'alpha' }, sa)).data;
    expect(list).toHaveLength(1);
    const dash = body(await pd('dashboard', {}, sa)).data;
    expect(dash.companies).toEqual({ total: 1, active: 1, suspended: 0 });
    expect(dash.users).toBe(1);
  });

  it('isolates tenants: sessions only read their own company', async () => {
    const sa = await setupSa();
    const a = await newCompany(sa, 'alpha');
    const b = await newCompany(sa, 'beta');
    const la = await crmLogin('admin@alpha.io');
    const lb = await crmLogin('admin@beta.io');
    expect(la.companyId).toBe(a.id);
    expect(lb.companyId).toBe(b.id);
    const ta = body(la).data.token;
    const tb = body(lb).data.token;
    const base = { userAgent: 'vitest', ip: IP };
    expect((await dispatch('addLead', { data: { 'Prospect Name': 'Alpha Lead', 'Phone Number': '9876500001' } }, { ...base, token: ta, companyId: a.id })).status).toBe(200);
    expect((await dispatch('addLead', { data: { 'Prospect Name': 'Beta Lead', 'Phone Number': '9876500002' } }, { ...base, token: tb, companyId: b.id })).status).toBe(200);

    const leadsA = body(await dispatch('getAllLeads', {}, { ...base, token: ta, companyId: a.id })).data.leads.map((l: any) => l['Prospect Name']);
    const leadsB = body(await dispatch('getAllLeads', {}, { ...base, token: tb, companyId: b.id })).data.leads.map((l: any) => l['Prospect Name']);
    expect(leadsA).toEqual(['Alpha Lead']);
    expect(leadsB).toEqual(['Beta Lead']);

    const crossed = await dispatch('getAllLeads', {}, { ...base, token: ta, companyId: b.id });
    expect(crossed.status).toBe(401);
    expect(body(crossed).code).toBe('AUTH_REQUIRED');

    const detail = body(await pd('getCompany', { id: a.id }, sa)).data;
    expect(detail.usage.leads).toBe(1);
    expect(detail.leads).toBe(1);
    expect(detail.usage.lastActivityAt).not.toBe('');
  });

  it('suspension blocks login and kills existing sessions', async () => {
    const sa = await setupSa();
    const a = await newCompany(sa, 'alpha');
    const token = body(await crmLogin('admin@alpha.io')).data.token;
    const ctx = { token, companyId: a.id, userAgent: 'vitest', ip: IP };
    expect((await dispatch('me', {}, ctx)).status).toBe(200);

    const s = await pd('setCompanyStatus', { id: a.id, status: 'Suspended', reason: 'unpaid' }, sa);
    expect(body(s).data.status).toBe('Suspended');
    const login = await crmLogin('admin@alpha.io');
    expect(login.status).toBe(403);
    expect(body(login).code).toBe('FORBIDDEN');
    const me = await dispatch('me', {}, ctx);
    expect(me.status).toBe(401);
    expect(body(me).code).toBe('AUTH_REQUIRED');
    const client = (await getClient())!;
    expect(await client.db(a.dbName).collection('sessions').countDocuments()).toBe(0);

    await pd('setCompanyStatus', { id: a.id, status: 'Active' }, sa);
    expect((await crmLogin('admin@alpha.io')).status).toBe(200);
  });

  it('enforces maxUsers and platform-wide e-mail uniqueness; manages company users', async () => {
    const sa = await setupSa();
    const a = await newCompany(sa, 'alpha', { maxUsers: 2 });
    const b = await newCompany(sa, 'beta');
    const u1 = await pd('createCompanyUser', { companyId: a.id, name: 'Ravi', email: 'ravi@alpha.io', role: 'RM' }, sa);
    expect(u1.status).toBe(200);
    const { user, temporaryPassword } = body(u1).data;
    expect(temporaryPassword).toHaveLength(14);
    const u2 = await pd('createCompanyUser', { companyId: a.id, name: 'Mira', email: 'mira@alpha.io', role: 'RM' }, sa);
    expect(u2.status).toBe(400);
    expect(body(u2).message).toMatch(/2 active users/);

    const dup = await pd('createCompanyUser', { companyId: b.id, name: 'Clone', email: 'ravi@alpha.io', role: 'RM' }, sa);
    expect(dup.status).toBe(409);
    expect(body(dup).code).toBe('CONFLICT');
    const dupCompany = await pd('createCompany', { name: 'Gamma', slug: 'gamma', plan: 'starter', admin: { name: 'G', email: 'admin@alpha.io' } }, sa);
    expect(dupCompany.status).toBe(409);
    expect(await dbExists('crm_gamma')).toBe(false);
    expect(body(await pd('listCompanies', {}, sa)).data).toHaveLength(2);

    // disable frees a seat; reset password returns a new temporary password and revokes sessions
    const userLogin = await crmLogin('ravi@alpha.io', temporaryPassword);
    expect(userLogin.status).toBe(200);
    expect(body(await pd('setCompanyUserStatus', { companyId: a.id, userId: user.id, status: 'Disabled' }, sa)).data.status).toBe('Disabled');
    expect((await pd('createCompanyUser', { companyId: a.id, name: 'Mira', email: 'mira@alpha.io', role: 'Manager' }, sa)).status).toBe(200);
    const reset = await pd('resetCompanyUserPassword', { companyId: a.id, userId: 'USR-0001' }, sa);
    expect(body(reset).data.temporaryPassword).toHaveLength(14);
    expect((await crmLogin('admin@alpha.io')).status).toBe(401);
    expect((await crmLogin('admin@alpha.io', body(reset).data.temporaryPassword)).status).toBe(200);
    // the last active admin cannot be disabled
    expect((await pd('setCompanyUserStatus', { companyId: a.id, userId: 'USR-0001', status: 'Disabled' }, sa)).status).toBe(400);
  });

  it('gates features by plan and validates updates', async () => {
    const sa = await setupSa();
    const s = await newCompany(sa, 'small', { plan: 'starter' });
    const token = body(await crmLogin('admin@small.io')).data.token;
    const ctx = { token, companyId: s.id, userAgent: 'vitest', ip: IP };
    const ai = await dispatch('aiTest', {}, ctx);
    expect(ai.status).toBe(403);
    expect(body(ai).code).toBe('FORBIDDEN');

    expect((await pd('updateCompany', { id: s.id, patch: { logo: 'data:image/gif;base64,AAAA' } }, sa)).status).toBe(400);
    expect((await pd('updateCompany', { id: s.id, patch: { logo: 'data:image/png;base64,' + 'A'.repeat(48001) } }, sa)).status).toBe(400);
    expect((await pd('updateCompany', { id: s.id, patch: { maxUsers: -1 } }, sa)).status).toBe(400);
    expect((await pd('updateCompany', { id: s.id, patch: { maxUsers: 1.5 } }, sa)).status).toBe(400);
    const up = await pd('updateCompany', { id: s.id, patch: { features: { aiCopilot: true }, logo: 'data:image/png;base64,iVBORw0KGgo=', tagline: 'Hi' } }, sa);
    expect(up.status).toBe(200);
    expect(body(up).data.features.aiCopilot).toBe(true);
    expect(body(up).data.features.chat360).toBe(false);
    const ai2 = await dispatch('aiTest', {}, ctx);
    expect(body(ai2).code).not.toBe('FORBIDDEN');

    // plans in use cannot be deleted
    expect((await pd('deletePlan', { id: 'starter' }, sa)).status).toBe(409);
    expect((await pd('deletePlan', { id: 'enterprise' }, sa)).status).toBe(200);
    const saved = await pd('savePlan', { plan: { id: 'pro', name: 'Pro', description: '', maxUsers: 10, features: { aiCopilot: true }, priceMonthly: 5000, currency: 'INR' } }, sa);
    expect(body(saved).data).toMatchObject({ id: 'pro', maxUsers: 10 });
    const audit = body(await pd('auditLog', { companyId: s.id }, sa)).data;
    expect(audit[0].action).toBe('Company Updated');
    expect(audit.every((e: any) => e.companyId === s.id)).toBe(true);
  });

  it('deleting a company drops its database and frees its e-mails and slug', async () => {
    const sa = await setupSa();
    const a = await newCompany(sa, 'alpha');
    await pd('createCompanyUser', { companyId: a.id, name: 'Ravi', email: 'ravi@alpha.io', role: 'RM' }, sa);
    expect((await pd('deleteCompany', { id: a.id, confirmSlug: 'wrong' }, sa)).status).toBe(400);
    expect((await pd('deleteCompany', { id: a.id, confirmSlug: 'alpha' }, sa)).status).toBe(200);
    expect(await dbExists('crm_alpha')).toBe(false);
    const client = (await getClient())!;
    expect(await client.db(PLATFORM_DB()).collection('directory').countDocuments({ companyId: a.id })).toBe(0);
    expect((await crmLogin('admin@alpha.io')).status).toBe(401);
    expect((await pd('getCompany', { id: a.id }, sa)).status).toBe(404);
    expect(body(await pd('listCompanies', {}, sa)).data).toHaveLength(0);

    const again = await newCompany(sa, 'alpha');
    expect(again.id).not.toBe(a.id);
    expect(again.dbName).toBe('crm_alpha');
    expect((await crmLogin('admin@alpha.io')).status).toBe(200);
    expect((await pd('createCompanyUser', { companyId: again.id, name: 'Ravi', email: 'ravi@alpha.io', role: 'RM' }, sa)).status).toBe(200);
  });
});
