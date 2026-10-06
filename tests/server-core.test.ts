/** Core server: auth, sessions, throttling, permissions, settings/secrets and the action router. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { col, nextSeq } from '../server/core/db';
import { CFG } from '../server/core/config';
import { can, createUser, login, validateSession, logout, changePassword, findUserByEmail } from '../server/core/auth';
import { dispatch } from '../server/router';
import { getSecret, getSettings, setSecret, updateSettings } from '../server/core/settings';
import { sha256Hex } from '../server/core/utils';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { token: '', userAgent: 'vitest', ip: '10.0.0.1' };

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('ids', () => {
  it('never reuses a sequence number', async () => {
    expect(await nextSeq('ENQ', 4)).toBe('ENQ-0001');
    expect(await nextSeq('ENQ', 4)).toBe('ENQ-0002');
    expect(await nextSeq('ENQ', 4)).toBe('ENQ-0003');
  });
});

describe('auth', () => {
  it('logs in with bcrypt, stores only a token hash, and validates the session', async () => {
    await createUser({ name: 'Asha', email: 'Asha@Example.com', password: 'long-enough-pw', role: 'RM' }, null);
    const r = await login('asha@example.com', 'long-enough-pw', base);
    expect(r.user.email).toBe('asha@example.com');
    const stored = await (await col(CFG.COLL.SESSIONS)).findOne({});
    expect(stored!.tokenHash).toBe(sha256Hex(r.token));
    expect(JSON.stringify(stored)).not.toContain(r.token);
    const s = await validateSession(r.token);
    expect(s?.user.id).toBe(r.user.id);
    await logout(r.token);
    expect(await validateSession(r.token)).toBeNull();
  });

  it('rejects short passwords for new accounts', async () => {
    await expect(createUser({ name: 'X', email: 'x@x.io', password: 'short', role: 'RM' }, null)).rejects.toThrow(/at least 10/);
  });

  it('accepts and upgrades a legacy Apps Script SHA-256 hash', async () => {
    const salt = 'abc123';
    await (await col(CFG.COLL.USERS)).insertOne({
      _id: 'USR-0042' as any, name: 'Legacy', email: 'old@x.io', emailLower: 'old@x.io', role: 'RM', status: 'Active',
      createdAt: new Date(), mustChangePassword: false, legacySalt: salt, passwordHash: sha256Hex(`${salt}::secret1`),
    });
    const r = await login('old@x.io', 'secret1', base);
    expect(r.user.id).toBe('USR-0042');
    const u = await findUserByEmail('old@x.io');
    expect(u!.passwordHash.startsWith('$2')).toBe(true);
    expect(u!.legacySalt).toBeUndefined();
    await expect(login('old@x.io', 'secret1', base)).resolves.toBeTruthy();
  });

  it('gives the same error for unknown, disabled and wrong-password accounts', async () => {
    await createUser({ name: 'D', email: 'd@x.io', password: 'long-enough-pw', role: 'RM', status: 'Disabled' }, null);
    const msgs = await Promise.all([
      login('nobody@x.io', 'whatever-123', base).catch((e) => e.message),
      login('d@x.io', 'long-enough-pw', base).catch((e) => e.message),
      login('d@x.io', 'wrong-password', base).catch((e) => e.message),
    ]);
    expect(new Set(msgs).size).toBe(1);
  });

  it('locks an email+IP pair after repeated failures', async () => {
    await createUser({ name: 'L', email: 'l@x.io', password: 'long-enough-pw', role: 'RM' }, null);
    for (let i = 0; i < 8; i++) await login('l@x.io', 'nope-nope-nope', base).catch(() => {});
    await expect(login('l@x.io', 'long-enough-pw', base)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    // a different IP is not locked
    await expect(login('l@x.io', 'long-enough-pw', { ...base, ip: '10.0.0.2' })).resolves.toBeTruthy();
  });

  it('changing the password signs out other sessions', async () => {
    await createUser({ name: 'C', email: 'c@x.io', password: 'long-enough-pw', role: 'RM' }, null);
    const a = await login('c@x.io', 'long-enough-pw', base);
    const b = await login('c@x.io', 'long-enough-pw', base);
    const s = await validateSession(a.token);
    await changePassword({ user: s!.user, session: s, token: a.token, userAgent: '', ip: '', action: 'x' }, 'long-enough-pw', 'new-long-password');
    expect(await validateSession(a.token)).not.toBeNull();
    expect(await validateSession(b.token)).toBeNull();
  });

  it('permission wildcards match the old Apps Script rules', () => {
    expect(can({ role: 'RM' }, 'leads.view')).toBe(true);
    expect(can({ role: 'RM' }, 'leads.delete')).toBe(false);
    expect(can({ role: 'Manager' }, 'tasks.anything')).toBe(true);
    expect(can({ role: 'Manager' }, 'users.manage')).toBe(false);
    expect(can({ role: 'Admin' }, 'secrets.manage')).toBe(true);
    expect(can({ role: 'Developer' }, 'whatever')).toBe(true);
  });
});

describe('router', () => {
  it('requires a session for data actions and enforces permissions', async () => {
    const anon = await dispatch('getAuditLog', {}, base);
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ status: 'error', code: 'AUTH_REQUIRED', isAuthError: true });

    await createUser({ name: 'R', email: 'r@x.io', password: 'long-enough-pw', role: 'RM' }, null);
    const { token } = await login('r@x.io', 'long-enough-pw', base);
    const forbidden = await dispatch('getAuditLog', {}, { ...base, token });
    expect(forbidden.status).toBe(403);
    const unknown = await dispatch('nope', {}, { ...base, token });
    expect(unknown.status).toBe(404);
    const me = await dispatch('me', {}, { ...base, token });
    expect((me.body as any).data.user.email).toBe('r@x.io');
  });

  it('first-run admin is possible only once', async () => {
    const ping = await dispatch('ping', {}, base);
    expect((ping.body as any).data.setupRequired).toBe(true);
    const first = await dispatch('createFirstAdmin', { name: 'Admin', email: 'a@x.io', password: 'long-enough-pw' }, base);
    expect(first.status).toBe(200);
    const second = await dispatch('createFirstAdmin', { name: 'Evil', email: 'e@x.io', password: 'long-enough-pw' }, base);
    expect(second.status).toBe(403);
  });

  it('retired developer actions answer without running code', async () => {
    const dev = await t.ctx('Developer');
    await createUser({ name: 'Dv', email: 'dv@x.io', password: 'long-enough-pw', role: 'Developer' }, null);
    const { token } = await login('dv@x.io', 'long-enough-pw', base);
    const r = await dispatch('devSaveModule', { name: '10_Leads', source: 'x' }, { ...base, token });
    expect(r.body).toMatchObject({ status: 'error', code: 'NOT_CONFIGURED' });
    expect(dev.user?.role).toBe('Developer');
  });
});

describe('settings & secrets', () => {
  it('stores secrets encrypted and only returns them masked', async () => {
    const admin = await t.ctx('Admin');
    await setSecret('GEMINI_API_KEY', 'AIzaSy-very-secret-1234', admin);
    const raw = await (await col(CFG.COLL.SECRETS)).findOne({ _id: 'GEMINI_API_KEY' as any });
    expect(JSON.stringify(raw)).not.toContain('very-secret');
    expect(await getSecret('GEMINI_API_KEY')).toBe('AIzaSy-very-secret-1234');
    const s = await getSettings(admin);
    expect(s.geminiKeyMasked).toBe('••••••••1234');
  });

  it('rejects redirecting the Chat360 base URL or the digest to outsiders', async () => {
    const admin = await t.ctx('Admin');
    await expect(updateSettings({ chat360BaseUrl: 'https://evil.example.com' }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ chat360BaseUrl: 'http://api.chat360.io' }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ dailyDigestEmail: 'someone@gmail.com' }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const ok = await updateSettings({ chat360BaseUrl: 'https://api.chat360.io', dailyDigestEmail: admin.user!.email }, admin);
    expect(ok.chat360BaseUrl).toBe('https://api.chat360.io');
  });

  it('reveals webhook secrets only to roles that manage secrets', async () => {
    const admin = await t.ctx('Admin');
    const manager = await t.ctx('Manager');
    await setSecret('CHAT360_WEBHOOK_SECRET', 'hook-secret-abcdef', admin);
    expect((await getSettings(admin)).chat360WebhookUrl).toContain('hook-secret-abcdef');
    expect((await getSettings(manager)).chat360WebhookUrl).not.toContain('hook-secret-abcdef');
  });
});
