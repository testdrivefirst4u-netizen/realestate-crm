/** Release A — tenant isolation: a session from one company is useless in another, through the real router. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser } from '../server/core/auth';
import { pcol } from '../server/core/db';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant, DEFAULT_FEATURES } from '../server/platform/registry';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.1.1.9' };

async function company(slug: string, dbName: string) {
  await (await pcol<any>('companies')).updateOne(
    { _id: 'CMP-' + slug },
    { $set: { slug, name: slug.toUpperCase(), dbName, status: 'Active', plan: 'Test', maxUsers: 0, features: { ...DEFAULT_FEATURES, inventory: true }, logo: '', tagline: '', createdAt: new Date(), updatedAt: new Date() } },
    { upsert: true }
  );
  invalidateTenant();
  return (await getTenantById('CMP-' + slug))!;
}
const call = async (action: string, data: any, token: string, companyId: string) => (await dispatch(action, data, { ...base, token, companyId })).body as any;
async function signIn(email: string) {
  const r = await dispatch('login', { email, password: 'long-enough-pw' }, { ...base, token: '' } as any);
  return { token: String((r.body as any).data?.token || ''), companyId: String(r.companyId || '') };
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('tenant isolation', () => {
  it("a token from company A gets nothing from company B, and B's records are unreachable from A", async () => {
    const a = await company('alpha', 'crm_alpha_test');
    const b = await company('beta', 'crm_beta_test');
    await runWithTenant(a, () => createUser({ name: 'Anil', email: 'anil@alpha.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null));
    await runWithTenant(b, () => createUser({ name: 'Bina', email: 'bina@beta.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null));
    const sa = await signIn('anil@alpha.test');
    const sb = await signIn('bina@beta.test');
    expect(sa.companyId).toBe(a.id);
    expect(sb.companyId).toBe(b.id);
    expect(sa.token).toBeTruthy();

    const bLead = (await call('addLead', { data: { 'Prospect Name': 'Beta Customer', 'Phone Number': '9811122233' } }, sb.token, b.id)).data.lead['Enquiry ID'];
    await call('addInventoryUnit', { data: { unitId: 'B-1' } }, sb.token, b.id);

    // A's token presented with B's company cookie: refused
    const cross = await call('getBootstrap', {}, sa.token, b.id);
    expect(cross.code).toBe('AUTH_REQUIRED');
    expect(JSON.stringify(cross)).not.toContain('Beta Customer');
    // inside A, B's ids do not exist
    const edit = await call('updateLead', { id: bLead, data: { 'Lead Stage': 'Hot' } }, sa.token, a.id);
    expect(edit).toMatchObject({ code: 'NOT_FOUND' });
    expect(edit.message).toMatch(/Lead not found/);
    const aBoot = (await call('getBootstrap', {}, sa.token, a.id)).data;
    expect(aBoot.leads.leads).toHaveLength(0);
    expect(aBoot.inventory).toHaveLength(0);
    // a suspended company's valid session stops working
    await (await pcol<any>('companies')).updateOne({ _id: b.id }, { $set: { status: 'Suspended' } });
    invalidateTenant();
    expect((await call('getBootstrap', {}, sb.token, b.id)).code).toBe('AUTH_REQUIRED');
  });
});
