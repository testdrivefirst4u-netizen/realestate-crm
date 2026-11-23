/** Read-only Data API (v1): key issue/resolve/revoke, read endpoints, pagination, updatedSince, and no PII. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { addLead } from '../server/modules/leads';
import { createReadKey, listReadKeys, readLeads, readUsers, resolveReadKey, revokeReadKey } from '../server/modules/dataApi';
import { CFG } from '../server/core/config';
import type { Ctx } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;
const L = CFG.LEAD;
const inCo = async <T>(fn: () => Promise<T>) => { invalidateTenant(); return runWithTenant((await getTenantById('CMP-test'))!, fn); };

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await t.reset(); await t.company('test'); admin = await t.ctx('Admin', 'Asha Admin'); });

describe('read-only data API', () => {
  it('issues a key, resolves it, reads leads with no phone/e-mail, then revokes it', async () => {
    await inCo(() => addLead({ [L.NAME]: 'Ravi', [L.PHONE]: '9876501234', [L.EMAIL]: 'r@x.com', [L.SOURCE]: 'Website', [L.RM]: 'Asha Admin' }, admin));
    const { key, row } = await inCo(() => createReadKey({ label: 'Dashboard' }, admin));
    expect(key).toMatch(/^crm_live_[0-9a-f]{48}$/);
    expect(row.prefix.startsWith('crm_live_')).toBe(true);
    expect(await resolveReadKey(key)).toBe('CMP-test');

    const page = await inCo(() => readLeads({ limit: 10 }));
    expect(page.data.length).toBeGreaterThan(0);
    const lead = page.data[0];
    expect(lead).toMatchObject({ source: 'Website', stage: expect.any(String), owner: 'Asha Admin' });
    expect(lead).not.toHaveProperty('phone');
    expect(lead).not.toHaveProperty('email');
    expect(JSON.stringify(page.data)).not.toContain('9876501234');
    expect(JSON.stringify(page.data)).not.toContain('r@x.com');

    const keys = await inCo(() => listReadKeys());
    expect(keys[0].prefix).toBe(row.prefix);
    expect(JSON.stringify(keys)).not.toContain(key); // the secret is never returned

    await inCo(() => revokeReadKey({ id: row.id }, admin));
    expect(await resolveReadKey(key)).toBeNull();
  });

  it('paginates by cursor and honours updatedSince', async () => {
    for (let i = 0; i < 5; i++) await inCo(() => addLead({ [L.NAME]: `L${i}`, [L.PHONE]: `90000000${10 + i}`, [L.SOURCE]: 'Website' }, admin));
    const p1 = await inCo(() => readLeads({ limit: 2 }));
    expect(p1.data).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await inCo(() => readLeads({ limit: 2, cursor: p1.nextCursor }));
    expect(p2.data).toHaveLength(2);
    expect(p2.data.map((x: any) => x.id)).not.toContain(p1.data[0].id);
    const none = await inCo(() => readLeads({ updatedSince: new Date(Date.now() + 86400000).toISOString() }));
    expect(none.data).toHaveLength(0);
  });

  it('users expose no phone or e-mail', async () => {
    const page = await inCo(() => readUsers());
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0]).toHaveProperty('name');
    expect(page.data[0]).not.toHaveProperty('email');
    expect(page.data[0]).not.toHaveProperty('phone');
  });

  it('a malformed or unknown key never resolves', async () => {
    expect(await resolveReadKey('not-a-key')).toBeNull();
    expect(await resolveReadKey('crm_live_' + 'f'.repeat(48))).toBeNull();
  });
});
