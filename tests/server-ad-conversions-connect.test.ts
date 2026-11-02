/** Ad conversions › "Connect with Facebook": shared callback, signed state, one dataset saved at once, several chosen, disconnect. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { createUser, login, type Ctx } from '../server/core/auth';
import { chooseAdConversionDataset, disconnectAdConversions, getAdConversions } from '../server/modules/adConversions';
import { GET as capiConnectGET } from '../app/api/integrations/meta/conversions/connect/route';
import { GET as callbackGET } from '../app/api/integrations/meta/callback/route';

const APP_ID = '111222333444555';
const APP_SECRET = 'a'.repeat(32);
let t: Awaited<ReturnType<typeof startTestDb>>;
let datasets: Array<{ account: string; pixels: Array<{ id: string; name: string }> }> = [];
let graphPaths: string[] = [];
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fakeGraph(input: any): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  graphPaths.push(path);
  const p = url.searchParams;
  if (path === 'oauth/access_token') {
    if (p.get('grant_type') === 'fb_exchange_token') return json(200, { access_token: 'LONG-USER-TOKEN' });
    return p.get('code') === 'good-code' ? json(200, { access_token: 'SHORT-TOKEN' }) : json(400, { error: { message: 'bad code', code: 100 } });
  }
  if (path === 'me/adaccounts') return json(200, { data: datasets.map((a, i) => ({ id: 'act_' + i, account_id: String(i), name: a.account, adspixels: { data: a.pixels } })) });
  if (path === 'me/businesses') return json(200, { data: [] });
  if (path === 'debug_token') return json(200, { data: { expires_at: 0, data_access_expires_at: 0 } });
  return json(404, { error: { message: 'unexpected ' + path, code: 100 } });
}

async function signIn(role: 'Developer' | 'Admin' = 'Developer', email = 'support@capi.test') {
  await createUser({ name: `Support ${email}`, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  const r = await login(email, 'long-enough-pw', { userAgent: 'vitest', ip: '10.3.3.3' });
  return { cookie: `amaya_session=CMP-test.${r.token}`, ctx: { user: r.user } as unknown as Ctx };
}
async function connect(cookie: string) {
  const start = await capiConnectGET(new Request('https://crm.example.com/api/integrations/meta/conversions/connect', { headers: { cookie } }));
  const dialog = new URL(start.headers.get('location')!);
  const nonce = (start.headers.get('set-cookie') || '').match(/meta_oauth_nonce=([0-9a-f]+)/)?.[1] || '';
  return { start, dialog, nonce };
}
const callback = async (q: string, cookie: string) => new URL((await callbackGET(new Request(`https://crm.example.com/api/integrations/meta/callback?${q}`, { headers: { cookie } }))).headers.get('location')!);

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_CAPI_CONFIG_ID', 'APP_URL']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { adConversions: true, metaLeads: true });
  process.env.META_APP_ID = APP_ID;
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_VERIFY_TOKEN = 'verify-token-123';
  process.env.APP_URL = 'https://crm.example.com';
  delete process.env.META_CAPI_CONFIG_ID;
  datasets = [{ account: 'Amaya Ads', pixels: [{ id: '1234567890123456', name: 'Amaya Website' }] }];
  graphPaths = [];
  vi.stubGlobal('fetch', vi.fn(fakeGraph));
});
afterEach(() => vi.unstubAllGlobals());

describe('connect with Facebook', () => {
  it('asks for the ads permissions on the shared callback, or uses the configuration when set; Admins and the switch-off are refused', async () => {
    const me = await signIn();
    const { start, dialog, nonce } = await connect(me.cookie);
    expect(start.status).toBe(302);
    expect(dialog.origin + dialog.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v[\d.]+\/dialog\/oauth$/);
    expect(dialog.searchParams.get('redirect_uri')).toBe('https://crm.example.com/api/integrations/meta/callback');
    expect(dialog.searchParams.get('scope')).toBe('ads_management,business_management');
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);

    process.env.META_CAPI_CONFIG_ID = '987654321';
    const withConfig = (await connect(me.cookie)).dialog;
    expect(withConfig.searchParams.get('config_id')).toBe('987654321');
    expect(withConfig.searchParams.get('scope')).toBeNull();

    const admin = await signIn('Admin', 'owner@capi.test');
    expect((await connect(admin.cookie)).dialog.searchParams.get('capiError')).toMatch(/Platform support/);
    await t.company('test', { adConversions: false });
    expect((await connect(me.cookie)).dialog.searchParams.get('capiError')).toMatch(/not included/);
  });

  it('one dataset is saved at once (token encrypted, never in the URL), sending stays off until switched on', async () => {
    const me = await signIn();
    const { dialog, nonce } = await connect(me.cookie);
    const state = encodeURIComponent(dialog.searchParams.get('state')!);
    // a wrong nonce is refused before Facebook is called
    const bad = await callback(`code=good-code&state=${state}`, `${me.cookie}; meta_oauth_nonce=other`);
    expect(bad.searchParams.get('section')).toBe('adConversions');
    expect(bad.searchParams.get('capiError')).toMatch(/could not be verified/);
    expect(graphPaths).toHaveLength(0);

    const back = await callback(`code=good-code&state=${state}`, `${me.cookie}; meta_oauth_nonce=${nonce}`);
    expect(back.pathname).toBe('/settings');
    expect(Object.fromEntries(back.searchParams)).toEqual({ section: 'adConversions', capiConnected: 'Amaya Website' });
    expect(back.toString()).not.toContain('TOKEN');
    const v = await inCo(() => getAdConversions(me.ctx));
    expect(v).toMatchObject({ enabled: false, datasetId: '1234567890123456', datasetName: 'Amaya Website', tokenSet: true, connectedVia: 'facebook', tokenExpiresAt: '', pending: null });
    const raw = await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'metaCapi' }));
    expect(JSON.stringify(raw)).not.toContain('LONG-USER-TOKEN');
    expect(graphPaths).toContain('me/adaccounts');
  });

  it('several datasets wait for a choice by the same person; cancelling says so', async () => {
    datasets = [
      { account: 'Amaya Ads', pixels: [{ id: '1111111111111111', name: 'Amaya Website' }] },
      { account: 'Other Ads', pixels: [{ id: '2222222222222222', name: 'Other Project' }, { id: '1111111111111111', name: 'Amaya Website' }] },
    ];
    const me = await signIn();
    const { dialog, nonce } = await connect(me.cookie);
    const back = await callback(`code=good-code&state=${encodeURIComponent(dialog.searchParams.get('state')!)}`, `${me.cookie}; meta_oauth_nonce=${nonce}`);
    expect(back.searchParams.get('capiChoose')).toBe('2');
    const v = await inCo(() => getAdConversions(me.ctx));
    expect(v.tokenSet).toBe(false);
    expect(v.pending!.map((d) => d.id)).toEqual(['1111111111111111', '2222222222222222']);
    const other = await signIn('Developer', 'second@capi.test');
    expect((await inCo(() => getAdConversions(other.ctx))).pending).toBeNull();
    await expect(inCo(() => chooseAdConversionDataset({ datasetId: '2222222222222222' }, other.ctx))).rejects.toThrow(/expired/);
    await expect(inCo(() => chooseAdConversionDataset({ datasetId: '999' }, me.ctx))).rejects.toThrow(/Choose one/);
    const chosen = await inCo(() => chooseAdConversionDataset({ datasetId: '2222222222222222' }, me.ctx));
    expect(chosen).toMatchObject({ datasetId: '2222222222222222', datasetName: 'Other Project', connectedVia: 'facebook', pending: null });

    const off = await inCo(() => disconnectAdConversions(me.ctx));
    expect(off).toMatchObject({ tokenSet: false, enabled: false, connectedVia: '' });

    const cancelled = await callback('error=access_denied&error_reason=user_denied&state=' + encodeURIComponent((await connect(me.cookie)).dialog.searchParams.get('state')!), me.cookie);
    expect(cancelled.searchParams.get('capiError')).toBe('Facebook login was cancelled.');
  });

  it('Facebook returning no dataset is explained', async () => {
    datasets = [];
    const me = await signIn();
    const { dialog, nonce } = await connect(me.cookie);
    const back = await callback(`code=good-code&state=${encodeURIComponent(dialog.searchParams.get('state')!)}`, `${me.cookie}; meta_oauth_nonce=${nonce}`);
    expect(back.searchParams.get('capiError')).toMatch(/no dataset/);
  });
});
