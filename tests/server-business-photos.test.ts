/** Business Profile › Photos: read fresh, add through a signed link, delete only the company's own. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { addBusinessPhoto, deleteBusinessPhoto, getBusinessPhotos } from '../server/modules/businessPhotos';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { BUSINESS_SCOPE } from '../server/modules/googleMarketing';
import { statFile } from '../server/modules/storage';

let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: Array<{ path: string; method: string; body: any; query: URLSearchParams }> = [];
let refuse = '';
let refuseCustomers = false;
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const LOC = { name: 'locations/1', title: 'Amaya', account: 'accounts/9' };
const PARENT = 'accounts/9/locations/1';
const OWN = { name: `${PARENT}/media/M1`, mediaFormat: 'PHOTO', locationAssociation: { category: 'EXTERIOR' }, googleUrl: 'https://lh3.googleusercontent.com/m1', thumbnailUrl: 'https://lh3.googleusercontent.com/t1', createTime: '2026-10-01T00:00:00Z' };
const PROFILE = { name: `${PARENT}/media/profile`, mediaFormat: 'PHOTO', locationAssociation: { category: 'PROFILE' }, googleUrl: 'javascript:alert(1)', createTime: '1970-01-01T00:00:00Z' };
const CUSTOMER = { name: `${PARENT}/media/customers/C1`, mediaFormat: 'PHOTO', googleUrl: 'https://lh3.googleusercontent.com/c1', attribution: { profileName: 'Neha', profileUrl: 'https://maps.google.com/neha', takedownUrl: 'https://support.google.com/takedown/1' } };
const png = (bytes = 20000) => Buffer.alloc(bytes, 1).toString('base64');

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  const path = url.pathname.replace(/^\/v4\//, '');
  const method = String(init.method || 'GET');
  calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null, query: url.searchParams });
  if (method !== 'GET' && refuse) return json(400, { error: { message: refuse } });
  if (path === `${PARENT}/media/customers`) return refuseCustomers ? json(403, { error: { message: 'No customers' } }) : json(200, { mediaItems: [CUSTOMER], totalMediaItemCount: 1 });
  if (path === `${PARENT}/media` && method === 'POST') return json(200, { name: `${PARENT}/media/NEW`, mediaFormat: 'PHOTO', locationAssociation: { category: 'INTERIOR' }, googleUrl: 'https://lh3.googleusercontent.com/new' });
  if (path === `${PARENT}/media`) return json(200, url.searchParams.get('pageToken') ? { mediaItems: [PROFILE], totalMediaItemCount: 3 } : { mediaItems: [OWN, CUSTOMER], totalMediaItemCount: 3, nextPageToken: 'NEXT' });
  if (path === OWN.name || path === `${PARENT}/media/NEW`) return json(200, method === 'DELETE' ? {} : { ...OWN, name: path });
  if (path === `${PARENT}/media/ATTRIBUTED`) return json(200, { ...CUSTOMER, name: path });
  return json(404, { error: { message: `unexpected ${path}` } });
}
const writes = () => calls.filter((c) => c.method !== 'GET');

beforeAll(async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-123';
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'APP_URL']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { businessProfile: true });
  resetGoogleOAuthTokenCache();
  calls = [];
  refuse = '';
  refuseCustomers = false;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '', connectedBy: 'x', connectedAt: new Date() });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'a@b.c', scopes: [BUSINESS_SCOPE], gbpLocation: LOC, gbpLocations: [LOC] });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('read', () => {
  it('lists own photos over pages, and customers\' with their credit, dropping unsafe links', async () => {
    const r = await inCo(() => getBusinessPhotos({}));
    expect(r.error).toBe('');
    expect(r.total).toBe(3);
    expect(r.photos.map((p) => p.name)).toEqual([OWN.name, PROFILE.name]); // a customer's listed with them stays with customers
    expect(r.photos[0]).toMatchObject({ category: 'EXTERIOR', url: OWN.googleUrl, thumbnail: OWN.thumbnailUrl, createdAt: OWN.createTime });
    expect(r.photos[1]).toMatchObject({ url: '', createdAt: '' });
    expect(r.customerPhotos[0]).toMatchObject({ author: 'Neha', authorUrl: 'https://maps.google.com/neha', removalUrl: 'https://support.google.com/takedown/1' });
    expect(writes()).toHaveLength(0);
  });

  it('still shows own photos when customers\' cannot be read', async () => {
    refuseCustomers = true;
    const r = await inCo(() => getBusinessPhotos({}));
    expect(r.photos).toHaveLength(2);
    expect(r.customersError).toContain('No customers');
  });

  it('says what is missing', async () => {
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'google' }, { $set: { gbpLocation: { ...LOC, account: '' }, gbpLocations: [{ ...LOC, account: '' }] } }));
    expect((await inCo(() => getBusinessPhotos({}))).error).toMatch(/Refresh accounts/);
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).deleteOne({ _id: 'google' }));
    expect((await inCo(() => getBusinessPhotos({}))).error).toMatch(/Connect your Google/);
    await expect(inCo(() => getBusinessPhotos({ location: 'locations/999' }))).resolves.toBeTruthy();
  });

  it('only a location this connection reaches', async () => {
    await expect(inCo(() => getBusinessPhotos({ location: 'locations/999' }))).rejects.toThrow(/Choose one/);
  });
});

describe('add', () => {
  it('gives Google a signed link, and logs it', async () => {
    const r = await inCo(() => addBusinessPhoto({ category: 'INTERIOR', name: 'a.jpg', mime: 'image/jpeg', base64: png() }, ctx));
    expect(r.name).toBe(`${PARENT}/media/NEW`);
    const body = writes()[0].body;
    expect(body).toMatchObject({ mediaFormat: 'PHOTO', locationAssociation: { category: 'INTERIOR' } });
    expect(body.sourceUrl).toMatch(/^https:\/\/crm\.example\.com\/api\/public\/media\/CMP-test\/[a-f0-9]{24}\?sig=/);
    const log = await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).findOne({ action: 'Business Profile Photo Added' }));
    expect(log?.details).toContain('INTERIOR');
  });

  it('refuses what Google would refuse before sending', async () => {
    await expect(inCo(() => addBusinessPhoto({ category: 'INTERIOR', mime: 'image/gif', base64: png() }, ctx))).rejects.toThrow(/JPG or PNG/);
    await expect(inCo(() => addBusinessPhoto({ category: 'NOPE', mime: 'image/png', base64: png() }, ctx))).rejects.toThrow(/Choose what/);
    await expect(inCo(() => addBusinessPhoto({ category: 'INTERIOR', mime: 'image/png', base64: png(3 * 1024 * 1024 + 1) }, ctx))).rejects.toThrow(/3 MB/);
    await expect(inCo(() => addBusinessPhoto({ category: 'INTERIOR', mime: 'image/png', base64: png(100) }, ctx))).rejects.toThrow(/10 KB/);
    expect(writes()).toHaveLength(0);
    await inCo(() => addBusinessPhoto({ category: 'PROFILE', mime: 'image/png', base64: png(100) }, ctx)); // Google's limit excludes profile and cover
    expect(writes()).toHaveLength(1);
  });

  it('passes on Google\'s reason, and keeps no copy', async () => {
    refuse = 'Photo is too blurry';
    await expect(inCo(() => addBusinessPhoto({ category: 'INTERIOR', name: 'a.jpg', mime: 'image/jpeg', base64: png() }, ctx))).rejects.toThrow(/too blurry/);
    const id = /media\/CMP-test\/([a-f0-9]{24})/.exec(writes()[0].body.sourceUrl)![1];
    expect(await inCo(() => statFile(id))).toBeNull();
  });
});

describe('delete', () => {
  it('removes the photo and our copy of it', async () => {
    await inCo(() => addBusinessPhoto({ category: 'INTERIOR', name: 'a.jpg', mime: 'image/jpeg', base64: png() }, ctx));
    const id = /media\/CMP-test\/([a-f0-9]{24})/.exec(writes()[0].body.sourceUrl)![1];
    await inCo(() => deleteBusinessPhoto({ name: `${PARENT}/media/NEW`, confirm: true }, ctx));
    expect(writes().at(-1)).toMatchObject({ method: 'DELETE', path: `${PARENT}/media/NEW` });
    expect(await inCo(() => statFile(id))).toBeNull();
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Business Profile Photo Deleted' }))).toBe(1);
  });

  it('needs confirming, and only own photos of this location', async () => {
    await expect(inCo(() => deleteBusinessPhoto({ name: OWN.name }, ctx))).rejects.toThrow(/Confirm/);
    await expect(inCo(() => deleteBusinessPhoto({ name: 'accounts/1/locations/9/media/X', confirm: true }, ctx))).rejects.toThrow(/Only your own/);
    await expect(inCo(() => deleteBusinessPhoto({ name: CUSTOMER.name, confirm: true }, ctx))).rejects.toThrow(/Only your own/);
    await expect(inCo(() => deleteBusinessPhoto({ name: `${PARENT}/media/ATTRIBUTED`, confirm: true }, ctx))).rejects.toThrow(/customer's photo/);
    expect(writes()).toHaveLength(0);
  });

  it('passes on Google\'s reason, and keeps the record', async () => {
    refuse = 'Cannot delete';
    await expect(inCo(() => deleteBusinessPhoto({ name: OWN.name, confirm: true }, ctx))).rejects.toThrow(/Cannot delete/);
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Business Profile Photo Deleted' }))).toBe(0);
  });
});

describe('who', () => {
  it('Viewers read, only those who connect accounts change, and the feature is needed', async () => {
    const base = { userAgent: 'vitest', ip: '10.9.9.9' };
    const session = (role: 'Admin' | 'Manager' | 'Viewer') => inCo(async () => {
      const email = `${role.toLowerCase()}@photos.test`;
      await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
      return (await login(email, 'long-enough-pw', base)).token;
    });
    const viewer = await session('Viewer');
    const manager = await session('Manager');
    const add = { category: 'INTERIOR', mime: 'image/png', base64: png() };
    expect((await inCo(() => dispatch('getBusinessPhotos', {}, { ...base, token: viewer }))).status).toBe(200);
    expect((await inCo(() => dispatch('addBusinessPhoto', add, { ...base, token: manager }))).status).toBe(403);
    expect((await inCo(() => dispatch('deleteBusinessPhoto', { name: OWN.name, confirm: true }, { ...base, token: manager }))).status).toBe(403);
    expect(writes()).toHaveLength(0);
    await t.company('test', { businessProfile: false });
    expect((await inCo(() => dispatch('getBusinessPhotos', {}, { ...base, token: viewer }))).status).toBe(403);
  });
});
