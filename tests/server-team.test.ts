/** Company roles: settings belong to platform support; Admins run the team; Managers add Agents; support sessions. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { createUser, listUsers, login, openSupportSession, SUPPORT_USER_ID, validateSession } from '../server/core/auth';
import { dispatch } from '../server/router';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById } from '../server/platform/registry';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.3.3.3', companyId: 'CMP-test' };

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test');
});

/** Inside the test company. */
const inCo = async <T,>(fn: () => Promise<T>) => runWithTenant((await getTenantById('CMP-test'))!, fn);

async function as(role: 'Admin' | 'Manager' | 'RM' | 'Developer', email: string) {
  await inCo(() => createUser({ name: `${role} ${email}`, email, password: 'long-enough-pw', role, mustChangePassword: false }, null));
  const token = (await login(email, 'long-enough-pw', { userAgent: 'vitest', ip: '10.3.3.3' })).token;
  return (action: string, data: any = {}) => dispatch(action, data, { ...base, token });
}

describe('settings belong to platform support', () => {
  it('company Admins and Managers cannot read or change settings, keys or lead sources', async () => {
    const admin = await as('Admin', 'admin@co.test');
    const manager = await as('Manager', 'mgr@co.test');
    for (const call of [admin, manager]) {
      expect((await call('getSettings')).status).toBe(403);
      expect((await call('updateSettings', { data: { appName: 'x' } })).status).toBe(403);
      expect((await call('setSecret', { key: 'GEMINI_API_KEY', value: 'k' })).status).toBe(403);
      expect((await call('listLeadSources')).status).toBe(403);
    }
    const support = await as('Developer', 'support@co.test');
    expect((await support('getSettings')).status).toBe(200);
  });
});

describe('team management', () => {
  it('Managers add and manage Agents only', async () => {
    const admin = await as('Admin', 'admin@co.test');
    const manager = await as('Manager', 'mgr@co.test');
    const agent = await manager('saveUser', { data: { name: 'New Agent', email: 'agent@co.test', role: 'RM' } });
    expect(agent.status).toBe(200);
    const agentId = (agent.body as any).data.id;
    expect((await manager('saveUser', { data: { id: agentId, name: 'Agent Renamed' } })).status).toBe(200);
    expect((await manager('resetPassword', { id: agentId, newPassword: 'another-long-pw' })).status).toBe(200);
    expect((await manager('saveUser', { data: { name: 'Boss 2', email: 'boss2@co.test', role: 'Manager' } })).status).toBe(403);
    expect((await manager('saveUser', { data: { name: 'Boss 3', email: 'boss3@co.test', role: 'Admin' } })).status).toBe(403);
    // promoting an Agent, or touching an Admin, is refused
    expect((await manager('saveUser', { data: { id: agentId, role: 'Manager' } })).status).toBe(403);
    const adminId = (await inCo(() => listUsers())).find((u) => u.role === 'Admin')!.id;
    expect((await manager('saveUser', { data: { id: adminId, name: 'Hacked' } })).status).toBe(403);
    expect((await manager('deleteUser', { id: adminId })).status).toBe(403);
    expect((await manager('deleteUser', { id: agentId })).status).toBe(200);
    // Admins manage everyone except support accounts
    expect((await admin('saveUser', { data: { name: 'Mgr 2', email: 'mgr2@co.test', role: 'Manager' } })).status).toBe(200);
    expect((await admin('saveUser', { data: { name: 'Sneaky', email: 'dev@co.test', role: 'Developer' } })).status).toBe(403);
    // Agents cannot manage anyone
    const rm = await as('RM', 'rm@co.test');
    expect((await rm('listUsers')).status).toBe(403);
  });
});

describe('Platform support session', () => {
  it('is hidden from the team, not counted, reused, and expires for real', async () => {
    const admin = await as('Admin', 'admin@co.test');
    const first = await inCo(() => openSupportSession({ name: 'Broaddcast', email: 'sa@platform.test' }, { ip: '1.1.1.1' }));
    const again = await inCo(() => openSupportSession({ name: 'Broaddcast', email: 'sa@platform.test' }, { ip: '1.1.1.1' }));
    expect(first.token).not.toBe(again.token);
    const s = (await inCo(() => validateSession(first.token)))!;
    expect(s.user).toMatchObject({ id: SUPPORT_USER_ID, role: 'Developer', name: 'Support · Broaddcast' });
    expect(new Date(s.expiresAt).getTime() - Date.now()).toBeLessThan(2.1 * 3_600_000); // not slid to 12 h
    expect((await inCo(() => listUsers())).map((u) => u.id)).not.toContain(SUPPORT_USER_ID);
    expect(await inCo(async () => (await col(CFG.COLL.USERS)).countDocuments({ _id: SUPPORT_USER_ID } as any))).toBe(1);
    // the company Admin cannot touch it
    expect((await admin('saveUser', { data: { id: SUPPORT_USER_ID, name: 'Mine now' } })).status).toBe(403);
    expect((await admin('deleteUser', { id: SUPPORT_USER_ID })).status).toBe(403);
    // and it can do settings work
    expect((await dispatch('getSettings', {}, { ...base, token: first.token })).status).toBe(200);
  });
});
