/** Permanent WhatsApp access: BroaddCast's own system user is added to a client's account at signup, so the client never depends on the signup token, which expires. */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col, getClient, PLATFORM_DB } from '../server/core/db';
import { decryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { getMetaSettings, setWhatsappSystemToken } from '../server/platform/meta';
import { connectDirect, finishSignup, getDirect, switchToPlatformToken } from '../server/modules/whatsappDirect';
import { AccessLine } from '../src/modules/settings/WhatsappDirectSection';

const NUMBER_ID = '10001';
const WABA = '20002';
const SIGNUP_TOKEN = 'BUSINESS.TOKEN';
const PLATFORM_TOKEN = 'P'.repeat(120);
const SYSTEM_USER = '6100000001';
const SIXTY_DAYS = Math.floor(Date.now() / 1000) + 60 * 86400;
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
const sa = { sa: null, ip: '' } as any;
let t: Awaited<ReturnType<typeof startTestDb>>;
let meta: Array<{ path: string; method: string; token: string; q: URLSearchParams }> = [];
/** What Meta answers about each token. */
let debug: Record<string, any> = {};
/** Whether the platform token can see the client's number. */
let platformSees = true;

const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  const token = String(init.headers?.Authorization || '').replace(/^Bearer /, '') || url.searchParams.get('access_token') || '';
  meta.push({ path, method: init.method || 'GET', token, q: url.searchParams });
  if (path === '/oauth/access_token') return json(200, { access_token: SIGNUP_TOKEN });
  if (path === '/debug_token') return json(200, { data: debug[url.searchParams.get('input_token') || ''] || { is_valid: false } });
  if (path === `/${WABA}/assigned_users`) return platformSees ? json(200, { success: true }) : json(403, { error: { code: 200, message: 'Not allowed' } });
  if (path === `/${WABA}/phone_numbers`) {
    if (token === PLATFORM_TOKEN && !platformSees) return json(403, { error: { code: 200, message: 'No access' } });
    return json(200, { data: [{ id: NUMBER_ID, display_phone_number: '+91 90000 11111', verified_name: 'Test Co' }] });
  }
  if (path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
  if (path === `/${WABA}/message_templates`) return json(200, { data: [] });
  if (path === `/${NUMBER_ID}/register`) return json(200, { success: true });
  if (path === `/${NUMBER_ID}`) return json(200, { id: NUMBER_ID, platform_type: 'CLOUD_API', quality_rating: 'GREEN' });
  return json(404, { error: { message: `unexpected ${path}` } });
}
const hits = (p: string) => meta.filter((m) => m.path === p);
const plat = () => getClient().then((c) => c!.db(PLATFORM_DB()));
const raw = () => inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'whatsappDirect' }));
const finish = () => inCo(() => finishSignup({ code: 'code-from-meta', wabaId: WABA, phoneNumberId: NUMBER_ID, keepApp: false }, ctx));
const savePlatform = () => setWhatsappSystemToken({ token: PLATFORM_TOKEN }, sa);
/** The token the CRM used for its last question about the number. */
const lastNumberToken = () => hits(`/${NUMBER_ID}`).at(-1)?.token;

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = 'app-secret';
  t = await startTestDb();
});
afterAll(async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { chat360: true, whatsappDirect: true });
  await (await plat()).collection('platformSettings').deleteMany({ _id: 'meta' as any });
  await (await plat()).collection('platformSettings').updateOne({ _id: 'meta' as any }, { $set: { appId: '111', whatsappConfigId: '999' } }, { upsert: true });
  meta = [];
  platformSees = true;
  debug = {
    [PLATFORM_TOKEN]: { is_valid: true, app_id: '111', user_id: SYSTEM_USER, type: 'SYSTEM_USER', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'], expires_at: 0 },
    [SIGNUP_TOKEN]: { is_valid: true, app_id: '111', user_id: '777', type: 'SYSTEM_USER', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], expires_at: SIXTY_DAYS, granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [WABA] }] },
  };
  vi.stubGlobal('fetch', vi.fn(fake));
});
afterEach(() => vi.unstubAllGlobals());

describe('saving the platform system user in Super Admin', () => {
  it('checks the token with Meta, keeps it encrypted, and learns whose it is', async () => {
    const r = await savePlatform();
    expect(r.whatsappSystemUser).toEqual({ saved: true, userId: SYSTEM_USER, expiresAt: '' });
    const doc = await (await plat()).collection('platformSettings').findOne({ _id: 'meta' as any });
    expect(JSON.stringify(doc)).not.toContain(PLATFORM_TOKEN);
    expect(decryptSecret(doc!.whatsappSystemToken)).toBe(PLATFORM_TOKEN);
    expect(JSON.stringify(await getMetaSettings())).not.toContain(PLATFORM_TOKEN);
  });
  it('says when the token will expire', async () => {
    debug[PLATFORM_TOKEN].expires_at = SIXTY_DAYS;
    expect((await savePlatform()).whatsappSystemUser.expiresAt).toBe(new Date(SIXTY_DAYS * 1000).toISOString());
  });
  it('refuses a token that is invalid, for another app, not a system user, or missing a permission', async () => {
    await expect(setWhatsappSystemToken({ token: 'short' }, sa)).rejects.toThrow(/whole token/);
    debug[PLATFORM_TOKEN].is_valid = false;
    await expect(savePlatform()).rejects.toThrow(/not valid/);
    debug[PLATFORM_TOKEN] = { ...debug[PLATFORM_TOKEN], is_valid: true, app_id: '222' };
    await expect(savePlatform()).rejects.toThrow(/another app/);
    debug[PLATFORM_TOKEN] = { ...debug[PLATFORM_TOKEN], app_id: '111', type: 'USER' };
    await expect(savePlatform()).rejects.toThrow(/not a system user/);
    debug[PLATFORM_TOKEN] = { ...debug[PLATFORM_TOKEN], type: 'SYSTEM_USER', scopes: ['whatsapp_business_management'] };
    await expect(savePlatform()).rejects.toThrow(/missing whatsapp_business_messaging/);
    expect((await getMetaSettings()).whatsappSystemUser.saved).toBe(false);
  });
  it('can be removed', async () => {
    await savePlatform();
    expect((await setWhatsappSystemToken({ token: '' }, sa)).whatsappSystemUser).toEqual({ saved: false, userId: '', expiresAt: '' });
  });
});

describe('a client connecting through the popup', () => {
  it('with the platform user saved: it is added to their account, and its token is used from then on', async () => {
    await savePlatform();
    await finish();
    const assign = hits(`/${WABA}/assigned_users`);
    expect(assign).toHaveLength(1);
    expect(assign[0]).toMatchObject({ method: 'POST', token: PLATFORM_TOKEN });
    expect(assign[0].q.get('user')).toBe(SYSTEM_USER);
    expect(assign[0].q.get('tasks')).toBe("['MANAGE']");
    const doc = await raw();
    expect(doc.tokenSource).toBe('platform');
    expect(doc.tokenExpiresAt).toBeUndefined();
    // the signup token is kept, encrypted, as a spare
    expect(decryptSecret(doc.token)).toBe(SIGNUP_TOKEN);
    const view: any = await inCo(() => getDirect());
    expect(view.access).toEqual({ permanent: true, expiresAt: '', canSwitch: false });
    expect(lastNumberToken()).toBe(PLATFORM_TOKEN);
  });
  it('without it: keeps its own token, and knows when that expires', async () => {
    await finish();
    expect(hits(`/${WABA}/assigned_users`)).toEqual([]);
    const view: any = await inCo(() => getDirect());
    expect(view.access).toEqual({ permanent: false, expiresAt: new Date(SIXTY_DAYS * 1000).toISOString(), canSwitch: false });
    expect(lastNumberToken()).toBe(SIGNUP_TOKEN);
  });
  it('if Meta refuses, the connection still works on its own token, and can switch later', async () => {
    await savePlatform();
    platformSees = false;
    await finish();
    expect((await raw()).tokenSource).toBeUndefined();
    let view: any = await inCo(() => getDirect());
    expect(view.access).toMatchObject({ permanent: false, canSwitch: true });
    expect(lastNumberToken()).toBe(SIGNUP_TOKEN);
    await expect(inCo(() => switchToPlatformToken(ctx))).rejects.toThrow(/did not allow/);
    platformSees = true;
    await inCo(() => switchToPlatformToken(ctx));
    view = await inCo(() => getDirect());
    expect(view.access.permanent).toBe(true);
    expect(lastNumberToken()).toBe(PLATFORM_TOKEN);
  });
  it('removing the platform user puts clients back on their own token', async () => {
    await savePlatform();
    await finish();
    await setWhatsappSystemToken({ token: '' }, sa);
    await inCo(() => getDirect());
    expect(lastNumberToken()).toBe(SIGNUP_TOKEN);
  });
  it('saving the same number again without a new token keeps permanent access', async () => {
    await savePlatform();
    await finish();
    await inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: '' }, ctx));
    expect((await raw()).tokenSource).toBe('platform');
    expect(decryptSecret((await raw()).token)).toBe(SIGNUP_TOKEN);
  });
  it('a token typed in by hand replaces it', async () => {
    await savePlatform();
    await finish();
    debug['TYPED.TOKEN'] = { is_valid: true, app_id: '111', expires_at: 0 };
    await inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: 'TYPED.TOKEN' }, ctx));
    const doc = await raw();
    expect(doc.tokenSource).toBeUndefined();
    expect(decryptSecret(doc.token)).toBe('TYPED.TOKEN');
    expect(doc.tokenExpiresAt).toBeUndefined();
  });
  it("a hand-typed token that expires, like Meta's 24-hour one, is noticed", async () => {
    const tomorrow = Math.floor(Date.now() / 1000) + 86400;
    debug['TEMP.TOKEN'] = { is_valid: true, app_id: '111', expires_at: tomorrow };
    await inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: 'TEMP.TOKEN' }, ctx));
    expect(((await inCo(() => getDirect())) as any).access.expiresAt).toBe(new Date(tomorrow * 1000).toISOString());
  });
});

describe('the line on the WhatsApp page', () => {
  const now = Date.parse('2026-11-07T10:00:00Z');
  const html = (access: any) => renderToStaticMarkup(React.createElement(AccessLine, { access, busy: false, onSwitch: () => undefined, now }));
  it('permanent: says so, quietly', () => {
    expect(html({ permanent: true, expiresAt: '', canSwitch: false })).toContain('permanent. It does not expire');
  });
  it('counts down, warns near the end, and says when it has run out', () => {
    expect(html({ permanent: false, expiresAt: '2026-12-30T10:00:00Z', canSwitch: false })).toContain('in 53 days');
    const near = html({ permanent: false, expiresAt: '2026-11-12T10:00:00Z', canSwitch: false });
    expect(near).toContain('in 5 days');
    expect(near).toContain('amber');
    expect(html({ permanent: false, expiresAt: '2026-11-01T10:00:00Z', canSwitch: false })).toContain('expired on');
  });
  it('offers the switch when it can, and stays silent with nothing to say', () => {
    expect(html({ permanent: false, expiresAt: '', canSwitch: true })).toContain('Switch to permanent access');
    expect(html({ permanent: false, expiresAt: '', canSwitch: false })).toBe('');
  });
});
