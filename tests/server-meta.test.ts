/**
 * Meta (Facebook / Instagram) Lead Ads: webhook verification + signature, the lead queue (dedupe, mapping,
 * idempotency, form filter, orphan, back-off → dead, token errors), Graph client (appsecret_proof), Page claims,
 * the OAuth connect flow (signed state, callback → pending connection), connecting Pages, backfill, disconnect,
 * plan gating, super-admin settings (encrypted secret) and the inbound endpoint refusing meta sources.
 * Facebook is replaced by an in-memory fake behind a stubbed global fetch — no real network calls.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { getClient, PLATFORM_DB } from '../server/core/db';
import { runWithTenant, type Tenant } from '../server/core/tenant';
import { DEFAULT_FEATURES, getTenantById, invalidateTenant } from '../server/platform/registry';
import { createUser, login } from '../server/core/auth';
import { sha256Hex } from '../server/core/utils';
import * as LS from '../server/modules/leadSources';
import * as M from '../server/modules/meta';
import * as Q from '../server/modules/metaQueue';
import * as leadsModule from '../server/modules/leads';
import { sourcesCol } from '../server/modules/intake';
import { appSecretProof, graph, TOKEN_EXPIRED_MSG, __setMetaRetryDelay } from '../server/integrations/meta';
import { dispatch } from '../server/router';
import { platformDispatch } from '../server/platform/router';
import { GET as webhookGET, POST as webhookPOST } from '../app/api/webhooks/meta/route';
import { GET as connectGET } from '../app/api/integrations/meta/connect/route';
import { GET as callbackGET } from '../app/api/integrations/meta/callback/route';
import { GET as cronGET } from '../app/api/cron/meta/route';
import { POST as inboundPOST } from '../app/api/inbound/leads/route';

/* ------------------------------- fake Graph ------------------------------ */

const APP_ID = '1234567890';
const APP_SECRET = 'abcdef0123456789abcdef0123456789';
const VERIFY = 'verify-me-12345';
const PAGE = '111111111';
const PAGE2 = '222222222';
const FORM_A = '9001';
const FORM_B = '9002';
const pageToken = (id: string) => `PAGE-TOKEN-${id}`;

interface FakeLead { id: string; form_id: string; created_time: string; field_data: Array<{ name: string; values: string[] }>; ad_id?: string; ad_name?: string; adset_name?: string; campaign_name?: string; platform?: string; is_organic?: boolean }
interface GCall { method: string; path: string; params: URLSearchParams }

let calls: GCall[] = [];
let leads: Record<string, FakeLead> = {};
let failLead: Record<string, { status: number; error: any }> = {};
let expired = new Set<string>();
let subscribed = new Set<string>();
let pages: Array<{ id: string; name: string; tasks: string[] }> = [];
const forms: Record<string, Array<{ id: string; name: string; status: string }>> = {
  [PAGE]: [{ id: FORM_A, name: 'Brochure form', status: 'ACTIVE' }, { id: FORM_B, name: 'Site visit form', status: 'ACTIVE' }],
  [PAGE2]: [{ id: '9100', name: 'Other form', status: 'ACTIVE' }],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fbErr = (status: number, code: number, message: string) => json(status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'x' } });

function lead(id: string, extra: Partial<FakeLead> = {}): FakeLead {
  return {
    id,
    form_id: FORM_A,
    created_time: new Date().toISOString(),
    field_data: [
      { name: 'full_name', values: ['Asha Rao'] },
      { name: 'phone_number', values: ['+919876543210'] },
      { name: 'email', values: ['asha@example.com'] },
      { name: 'city', values: ['Bengaluru'] },
      { name: 'when_do_you_plan_to_move?', values: ['Within 6 months'] },
    ],
    ad_id: '777',
    ad_name: 'Diwali offer',
    adset_name: 'Seniors 60+',
    campaign_name: 'Amaya Q4',
    platform: 'ig',
    is_organic: false,
    ...extra,
  };
}

async function fakeFetch(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'graph.facebook.com') throw new Error('unexpected host ' + url.host);
  const method = String(init.method || 'GET').toUpperCase();
  const params = method === 'POST' ? new URLSearchParams(String(init.body || '')) : url.searchParams;
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '');
  calls.push({ method, path, params });
  const token = params.get('access_token') || '';
  if (token) {
    // every call with a token must carry the proof
    if (params.get('appsecret_proof') !== crypto.createHmac('sha256', APP_SECRET).update(token).digest('hex')) return fbErr(400, 100, 'Invalid appsecret_proof provided in the API argument');
    if (expired.has(token)) return fbErr(400, 190, 'Error validating access token: Session has expired');
  }
  if (path === 'oauth/access_token') {
    if (params.get('client_secret') !== APP_SECRET) return fbErr(400, 1, 'Error validating client secret.');
    if (params.get('grant_type') === 'client_credentials') return json(200, { access_token: `${APP_ID}|apptoken`, token_type: 'bearer' });
    if (params.get('grant_type') === 'fb_exchange_token') return json(200, { access_token: 'LONG-USER-TOKEN', token_type: 'bearer', expires_in: 5184000 });
    if (params.get('code') === 'good-code') return json(200, { access_token: 'SHORT-USER-TOKEN', token_type: 'bearer' });
    return fbErr(400, 100, 'Invalid verification code format.');
  }
  if (path === 'me/accounts') {
    if (token !== 'LONG-USER-TOKEN') return fbErr(400, 190, 'bad user token');
    return json(200, { data: pages.map((p) => ({ ...p, access_token: pageToken(p.id), category: 'Real estate' })), paging: { cursors: { before: 'a', after: 'b' } } });
  }
  const parts = path.split('/');
  const id = parts[0];
  if (parts[1] === 'leadgen_forms') return token === pageToken(id) ? json(200, { data: forms[id] || [] }) : fbErr(403, 200, 'Requires pages_manage_ads permission');
  if (parts[1] === 'subscribed_apps') {
    if (token !== pageToken(id)) return fbErr(403, 200, 'The user must be an administrator of the Page');
    if (method === 'POST') {
      expect(params.get('subscribed_fields')).toBe('leadgen');
      subscribed.add(id);
      return json(200, { success: true });
    }
    if (method === 'DELETE') {
      subscribed.delete(id);
      return json(200, { success: true });
    }
    return json(200, { data: subscribed.has(id) ? [{ id: APP_ID, name: 'CRM', subscribed_fields: ['leadgen'] }] : [] });
  }
  if (parts[1] === 'leads') {
    const f = JSON.parse(params.get('filtering') || '[]');
    const since = Number(f[0]?.value || 0);
    const rows = Object.values(leads).filter((l) => l.form_id === id && new Date(l.created_time).getTime() / 1000 > since);
    return json(200, { data: rows });
  }
  if (parts.length === 1 && (id === PAGE || id === PAGE2)) {
    if (token !== pageToken(id)) return fbErr(400, 190, 'Invalid OAuth access token');
    return json(200, { id, name: id === PAGE ? 'Amaya Living' : 'Second Page' });
  }
  if (parts.length === 1 && leads[id]) {
    if (failLead[id]) return json(failLead[id].status, { error: failLead[id].error });
    expect(params.get('fields')).toContain('field_data');
    return json(200, leads[id]);
  }
  if (parts.length === 1 && failLead[id]) return json(failLead[id].status, { error: failLead[id].error });
  return fbErr(404, 100, 'Unsupported get request.');
}

const graphCalls = (pred: (c: GCall) => boolean = () => true) => calls.filter(pred);

/* --------------------------------- setup --------------------------------- */

let t: Awaited<ReturnType<typeof startTestDb>>;
const OTHER_DB = 'amaya_test_meta_other';
const plat = () => getClient().then((c) => c!.db(PLATFORM_DB()));

async function tenant(id = 'CMP-test'): Promise<Tenant> {
  invalidateTenant();
  return (await getTenantById(id))!;
}
const inCo = async <T>(fn: () => Promise<T>, id = 'CMP-test') => runWithTenant(await tenant(id), fn);

async function registerOther(features: Partial<typeof DEFAULT_FEATURES> = {}) {
  await (await plat()).collection('companies').updateOne(
    { _id: 'CMP-other' as any },
    { $set: { slug: 'other', name: 'Other Co', dbName: OTHER_DB, status: 'Active', plan: 'Test', maxUsers: 0, features: { ...DEFAULT_FEATURES, metaLeads: true, ...features }, logo: '', tagline: '', createdAt: new Date(), updatedAt: new Date() } },
    { upsert: true }
  );
  invalidateTenant();
}

const leadsIn = async (id = 'CMP-test') => inCo(async () => (await leadsModule.getAllLeads(null)).leads, id);
const sign = (raw: string, secret = APP_SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const leadgenBody = (ids: string[], pageId = PAGE, formId = FORM_A) =>
  JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1700000000, changes: ids.map((id) => ({ field: 'leadgen', value: { leadgen_id: id, page_id: pageId, form_id: formId, ad_id: '777', created_time: 1700000000 } })) }] });
const post = (raw: string, sig: string | null) =>
  new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body: raw });

/** Connect PAGE directly (as the super admin would) inside a company. */
async function connectDirect(pageId = PAGE, companyId = 'CMP-test', formIds: string[] = []) {
  const cfg = await import('../server/integrations/meta').then((m) => m.loadMetaConfig());
  return inCo(() => M.connectPage({ pageId, pageName: pageId === PAGE ? 'Amaya Living' : 'Second Page', pageToken: pageToken(pageId), forms: forms[pageId] || [], formIds, config: LS.defaultConfig('meta'), ctx: null, cfg }), companyId);
}
const queueDoc = async (id: string) => (await plat()).collection('metaLeadQueue').findOne({ _id: id as any });

beforeAll(async () => {
  t = await startTestDb();
  __setMetaRetryDelay(1);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'APP_URL', 'CRON_SECRET']) delete process.env[k];
  await (await getClient())!.db(OTHER_DB).dropDatabase();
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  const other = (await getClient())!.db(OTHER_DB);
  await Promise.all((await other.collections()).map((c) => c.deleteMany({})));
  await t.company('test', { metaLeads: true, websiteApi: true });
  calls = [];
  leads = {};
  failLead = {};
  expired = new Set();
  subscribed = new Set();
  pages = [{ id: PAGE, name: 'Amaya Living', tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MESSAGING', 'MODERATE', 'MANAGE'] }, { id: PAGE2, name: 'Second Page', tasks: ['MODERATE'] }];
  process.env.META_APP_ID = APP_ID;
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_VERIFY_TOKEN = VERIFY;
  process.env.APP_URL = 'https://crm.example.com';
  process.env.CRON_SECRET = 'cron-secret-123';
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

/* ---------------------------------- webhook ------------------------------ */

describe('webhook', () => {
  it('GET echoes the challenge only for the right verify token', async () => {
    const ok = await webhookGET(new Request(`https://crm.example.com/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await ok.text()).toBe('1158201444');
    const bad = await webhookGET(new Request('https://crm.example.com/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1'));
    expect(bad.status).toBe(403);
    expect((await webhookGET(new Request(`https://crm.example.com/api/webhooks/meta?hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`))).status).toBe(403);
  });

  it('POST verifies X-Hub-Signature-256 before parsing anything', async () => {
    const raw = leadgenBody(['5001']);
    const parse = vi.spyOn(JSON, 'parse');
    expect((await webhookPOST(post(raw, null))).status).toBe(401);
    expect((await webhookPOST(post(raw, sign(raw, 'another-secret-0000000000000000')))).status).toBe(401);
    expect((await webhookPOST(post(raw, 'sha256=zz'))).status).toBe(401);
    expect(parse).not.toHaveBeenCalledWith(raw);
    parse.mockRestore();
    expect(await (await plat()).collection('metaLeadQueue').countDocuments({})).toBe(0);
    // a body that is not even JSON is refused on its signature first
    expect((await webhookPOST(post('not json', null))).status).toBe(401);

    const scheduled: Array<() => Promise<unknown>> = [];
    const r = await Q.handleMetaWebhookPost(post(raw, sign(raw)), (fn) => scheduled.push(fn));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'success', data: { queued: 1, received: 1 } });
    expect(scheduled).toHaveLength(1);
    expect(await queueDoc('5001')).toMatchObject({ pageId: PAGE, formId: FORM_A, adId: '777', status: 'pending', attempts: 0 });
  });

  it('repeated deliveries of a leadgen id are queued once', async () => {
    const raw = leadgenBody(['5001', '5001', '5002']);
    const r1 = await Q.handleMetaWebhookPost(post(raw, sign(raw)), () => {});
    expect((await r1.json()).data).toEqual({ queued: 2, received: 2 });
    const r2 = await Q.handleMetaWebhookPost(post(raw, sign(raw)), () => {});
    expect((await r2.json()).data).toEqual({ queued: 0, received: 2 });
    expect(await (await plat()).collection('metaLeadQueue').countDocuments({})).toBe(2);
    // non-leadgen changes and other objects are ignored
    const other = JSON.stringify({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'post' } }] }] });
    expect((await (await Q.handleMetaWebhookPost(post(other, sign(other)), () => {})).json()).data).toEqual({ queued: 0, received: 0 });
  });
});

/* ------------------------------- processing ------------------------------ */

describe('queue processing', () => {
  it('fetches the lead with the Page token, maps the fields and is idempotent', async () => {
    const { sourceId } = await connectDirect();
    leads['5001'] = lead('5001');
    await Q.enqueueLeadgen(JSON.parse(leadgenBody(['5001'])));
    calls = [];
    const done = await Q.processQueueItem('5001');
    expect(done).toMatchObject({ status: 'done', leadId: 'ENQ-0001', result: 'created', companyId: 'CMP-test', sourceId });
    const fetchCall = graphCalls((c) => c.path === '5001')[0];
    expect(fetchCall.params.get('access_token')).toBe(pageToken(PAGE));
    expect(fetchCall.params.get('appsecret_proof')).toBe(appSecretProof(pageToken(PAGE), APP_SECRET));

    const [l] = await leadsIn();
    expect(l).toMatchObject({ 'Prospect Name': 'Asha Rao', 'Phone Number': '+919876543210', Email: 'asha@example.com', 'Enquiry Source': 'Meta Lead Ads', 'Lead Stage': 'New' });
    const notes = l['Enquiry Notes'];
    expect(notes).toContain('City: Bengaluru');
    expect(notes).toContain('When do you plan to move?: Within 6 months');
    expect(notes).toContain('Ad: Diwali offer');
    expect(notes).toContain('Ad set: Seniors 60+');
    expect(notes).toContain('Campaign: Amaya Q4');
    expect(notes).toContain(`Form: Brochure form (${FORM_A})`);
    expect(notes).toContain('Platform: Instagram');
    expect(notes).not.toContain('leadgen_id');

    // processing again (even when forced back to pending) never creates a second lead
    expect((await Q.processQueueItem('5001'))!.status).toBe('done');
    await (await plat()).collection('metaLeadQueue').updateOne({ _id: '5001' as any }, { $set: { status: 'pending' } });
    expect(await Q.processQueueItem('5001')).toMatchObject({ status: 'done', leadId: 'ENQ-0001' });
    expect(await leadsIn()).toHaveLength(1);
    const src = (await inCo(() => LS.listLeadSources()))[0];
    expect(src).toMatchObject({ type: 'meta', keyPrefix: '', stats: { received: 1, created: 1 } });
    expect(src.config.meta!.lastLeadAt).not.toBe('');
    expect(JSON.stringify(src)).not.toContain('PAGE-TOKEN');
    expect(JSON.stringify(src)).not.toContain('pageToken');
  });

  it('skips leads of forms that are not selected, and marks unknown Pages orphan', async () => {
    await connectDirect(PAGE, 'CMP-test', [FORM_B]);
    leads['5001'] = lead('5001');
    await Q.enqueueLeadgen(JSON.parse(leadgenBody(['5001'])));
    expect(await Q.processQueueItem('5001')).toMatchObject({ status: 'skipped', lastError: expect.stringMatching(/not selected/) });
    expect(graphCalls((c) => c.path === '5001')).toHaveLength(0);

    await Q.enqueueLeadgen(JSON.parse(leadgenBody(['6001'], '999999999')));
    expect(await Q.processQueueItem('6001')).toMatchObject({ status: 'orphan' });
    expect(await leadsIn()).toHaveLength(0);
  });

  it('retries failures with back-off and gives up after 5 attempts', async () => {
    await connectDirect();
    failLead['5001'] = { status: 500, error: { message: 'An unexpected error has occurred.', code: 2, type: 'OAuthException' } };
    await Q.enqueueLeadgen(JSON.parse(leadgenBody(['5001'])));
    let now = Date.now();
    const backoff = [5, 15, 60, 240];
    for (let i = 1; i <= 4; i++) {
      const d = await Q.processQueueItem('5001', { now: new Date(now) });
      expect(d).toMatchObject({ status: 'failed', attempts: i, lastError: expect.stringMatching(/temporarily unavailable/) });
      expect(new Date(d!.nextAttemptAt!).getTime()).toBe(now + backoff[i - 1] * 60000);
      // not due before the back-off elapsed
      expect((await Q.processQueueItem('5001', { now: new Date(now + 60000) }))!.attempts).toBe(i);
      now += backoff[i - 1] * 60000;
    }
    const dead = await Q.processQueueItem('5001', { now: new Date(now) });
    expect(dead).toMatchObject({ status: 'dead', attempts: 5, nextAttemptAt: null });
    // 5xx was retried once inside each attempt
    expect(graphCalls((c) => c.path === '5001')).toHaveLength(10);

    // super admin re-queues it; it succeeds once Facebook answers again
    delete failLead['5001'];
    leads['5001'] = lead('5001');
    const setup = await platformDispatch('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' }, { token: '', userAgent: 'vitest', ip: '10.0.0.1' });
    const r = await platformDispatch('retryMetaQueue', { companyId: 'CMP-test' }, { token: setup.session!.token, userAgent: 'vitest', ip: '10.0.0.1' });
    expect((r.body as any).data).toEqual({ retried: 1 });
    expect(await Q.processQueueItem('5001')).toMatchObject({ status: 'done', leadId: 'ENQ-0001' });
  });

  it('an expired token (code 190) shows a friendly message on the source', async () => {
    await connectDirect();
    leads['5001'] = lead('5001');
    expired.add(pageToken(PAGE));
    await Q.enqueueLeadgen(JSON.parse(leadgenBody(['5001'])));
    expect(await Q.processQueueItem('5001')).toMatchObject({ status: 'failed', lastError: TOKEN_EXPIRED_MSG });
    const src = (await inCo(() => LS.listLeadSources()))[0];
    expect(src.config.meta!.lastError).toBe('The Facebook connection expired — reconnect the Page');
    const chk = await inCo(() => M.checkMetaSource({ sourceId: src.id }, null));
    expect(chk).toMatchObject({ ok: false, message: TOKEN_EXPIRED_MSG });
  });

  it('the graph client maps permission errors and never puts tokens in messages', async () => {
    await expect(graph(`${PAGE}/leadgen_forms`, { token: 'some-user-token' })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/^Facebook refused access/) });
    try {
      await graph(`${PAGE}/leadgen_forms`, { token: 'some-user-token' });
    } catch (e: any) {
      expect(e.message).not.toContain('some-user-token');
    }
  });
});

/* --------------------------------- claims -------------------------------- */

describe('claims', () => {
  it('a Page can be connected by one company only', async () => {
    await registerOther();
    const a = await connectDirect();
    expect(subscribed.has(PAGE)).toBe(true);
    const claim = await (await plat()).collection('metaPages').findOne({ _id: PAGE as any });
    expect(claim).toMatchObject({ companyId: 'CMP-test', sourceId: a.sourceId });
    await expect(connectDirect(PAGE, 'CMP-other')).rejects.toMatchObject({ code: 'CONFLICT', message: 'This Facebook Page is already connected to another workspace' });
    expect(await inCo(() => LS.listLeadSources(), 'CMP-other')).toHaveLength(0);
    // reconnecting in the same company refreshes the existing source
    const again = await connectDirect();
    expect(again).toEqual({ sourceId: a.sourceId, reconnected: true });
    expect(await inCo(() => LS.listLeadSources())).toHaveLength(1);
  });
});

/* ------------------------------ connect flow ----------------------------- */

describe('connect flow', () => {
  async function signIn(role: 'Admin' | 'Manager' = 'Admin', email = 'boss@meta.test') {
    await createUser({ name: 'Boss ' + role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
    const r = await login(email, 'long-enough-pw', { userAgent: 'vitest', ip: '10.2.2.2' });
    return { token: r.token, userId: r.user.id, cookie: `CMP-test.${r.token}` };
  }

  it('signs the state and rejects tampered, expired, foreign-user and wrong-nonce states', () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const s = M.signState({ c: 'CMP-test', u: 'USR-0001', n: 'nonce-1', exp });
    const ok = { nonce: 'nonce-1', companyId: 'CMP-test', userId: 'USR-0001' };
    expect(M.verifyState(s, ok)).toMatchObject({ ok: true, state: { c: 'CMP-test', u: 'USR-0001' } });
    const [body, sig] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ c: 'CMP-other', u: 'USR-0001', n: 'nonce-1', exp })).toString('base64url');
    expect(M.verifyState(`${forged}.${sig}`, ok)).toEqual({ ok: false, reason: 'bad signature' });
    expect(M.verifyState(`${body}.${sig.slice(0, -2)}AA`, ok)).toMatchObject({ ok: false });
    expect(M.verifyState(s, ok, (exp + 1) * 1000)).toEqual({ ok: false, reason: 'expired' });
    expect(M.verifyState(s, { ...ok, userId: 'USR-0002' })).toEqual({ ok: false, reason: 'different session' });
    expect(M.verifyState(s, { ...ok, companyId: 'CMP-other' })).toEqual({ ok: false, reason: 'different session' });
    expect(M.verifyState(s, { ...ok, nonce: 'other' })).toEqual({ ok: false, reason: 'nonce mismatch' });
    expect(M.verifyState(s, { ...ok, nonce: '' })).toEqual({ ok: false, reason: 'nonce mismatch' });
  });

  it('connect → Facebook dialog → callback stores a pending connection (tokens encrypted, never returned) → connectMetaPages', async () => {
    const me = await signIn();
    // not signed in → back to the login page
    const anon = await connectGET(new Request('https://crm.example.com/api/integrations/meta/connect'));
    expect(anon.headers.get('location')).toBe('https://crm.example.com/');

    const start = await connectGET(new Request('https://crm.example.com/api/integrations/meta/connect', { headers: { cookie: `amaya_session=${me.cookie}` } }));
    expect(start.status).toBe(302);
    const dialog = new URL(start.headers.get('location')!);
    expect(dialog.origin + dialog.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(dialog.searchParams.get('client_id')).toBe(APP_ID);
    expect(dialog.searchParams.get('redirect_uri')).toBe('https://crm.example.com/api/integrations/meta/callback');
    expect(dialog.searchParams.get('response_type')).toBe('code');
    expect(dialog.searchParams.get('scope')).toContain('leads_retrieval');
    const setCookie = start.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/meta_oauth_nonce=[0-9a-f]{32}/);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    const nonce = setCookie.match(/meta_oauth_nonce=([0-9a-f]+)/)![1];
    const state = dialog.searchParams.get('state')!;

    const cb = (q: string, cookie: string) => callbackGET(new Request(`https://crm.example.com/api/integrations/meta/callback?${q}`, { headers: { cookie } }));
    // user cancelled
    const cancelled = new URL((await cb('error=access_denied&error_reason=user_denied&error_description=Permissions+error', `amaya_session=${me.cookie}; meta_oauth_nonce=${nonce}`)).headers.get('location')!);
    expect(cancelled.pathname).toBe('/settings');
    expect(cancelled.searchParams.get('section')).toBe('leadSources');
    expect(cancelled.searchParams.get('metaError')).toBe('Facebook login was cancelled.');
    // missing nonce cookie / another user's session → refused, no Graph call
    calls = [];
    const noNonce = new URL((await cb(`code=good-code&state=${encodeURIComponent(state)}`, `amaya_session=${me.cookie}`)).headers.get('location')!);
    expect(noNonce.searchParams.get('metaError')).toMatch(/could not be verified/);
    const other = await signIn('Admin', 'second@meta.test');
    const foreign = new URL((await cb(`code=good-code&state=${encodeURIComponent(state)}`, `amaya_session=${other.cookie}; meta_oauth_nonce=${nonce}`)).headers.get('location')!);
    expect(foreign.searchParams.get('metaError')).toMatch(/could not be verified/);
    expect(calls).toHaveLength(0);

    const res = await cb(`code=good-code&state=${encodeURIComponent(state)}`, `amaya_session=${me.cookie}; meta_oauth_nonce=${nonce}`);
    expect(res.headers.get('set-cookie')).toMatch(/meta_oauth_nonce=;/);
    const back = new URL(res.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('https://crm.example.com/settings');
    const pendingId = back.searchParams.get('metaConnect')!;
    expect(pendingId).toMatch(/^mc_[0-9a-f]{24}$/);
    expect(back.toString()).not.toContain('TOKEN');
    expect(graphCalls((c) => c.path === 'oauth/access_token')).toHaveLength(2);
    const stored = await inCo(async () => (await M.connectionsCol()).findOne({ _id: pendingId }));
    expect(stored!.createdBy).toBe(me.userId);
    expect(JSON.stringify(stored)).not.toContain('PAGE-TOKEN');
    expect(JSON.stringify(stored)).not.toContain('USER-TOKEN');

    const call = (token: string) => (action: string, data: any = {}) => dispatch(action, data, { token, userAgent: 'vitest', ip: '10.2.2.2', companyId: 'CMP-test' });
    const pend = await call(me.token)('getMetaPendingConnection', { pendingId });
    expect(pend.status).toBe(200);
    const pd = (pend.body as any).data;
    expect(pd.pages).toEqual([
      { id: PAGE, name: 'Amaya Living', canReadLeads: true, claimedElsewhere: false, alreadyConnected: false, forms: forms[PAGE] },
      { id: PAGE2, name: 'Second Page', canReadLeads: false, claimedElsewhere: false, alreadyConnected: false, forms: forms[PAGE2] },
    ]);
    expect(JSON.stringify(pend.body)).not.toContain('TOKEN');
    expect(JSON.stringify(pend.body)).not.toContain('"token"');
    // only the user who logged in to Facebook sees it
    expect((await call(other.token)('getMetaPendingConnection', { pendingId })).status).toBe(404);

    const conn = await call(me.token)('connectMetaPages', { pendingId, pages: [{ pageId: PAGE, formIds: [FORM_A] }, { pageId: '333' , formIds: [] }], defaults: { sourceLabel: 'Facebook Ads', duplicates: 'skip' } });
    expect(conn.status).toBe(200);
    expect((conn.body as any).data).toEqual({ created: ['SRC-0001'], skipped: [{ pageId: '333', reason: 'This Page was not part of the Facebook login' }] });
    expect(subscribed.has(PAGE)).toBe(true);
    const src = (await inCo(() => LS.listLeadSources()))[0];
    expect(src).toMatchObject({ id: 'SRC-0001', type: 'meta', name: 'Facebook: Amaya Living', config: { sourceLabel: 'Facebook Ads', duplicates: 'skip', meta: { pageId: PAGE, pageName: 'Amaya Living', formIds: [FORM_A], subscribed: true } } });
    const raw = await inCo(async () => (await sourcesCol()).findOne({ _id: 'SRC-0001' }));
    expect((raw as any).secret.pageToken.split('.')).toHaveLength(3);
    expect(JSON.stringify(raw)).not.toContain('PAGE-TOKEN');
    // the pending connection is used up
    expect((await call(me.token)('getMetaPendingConnection', { pendingId })).status).toBe(404);
    // the form filter can be changed via updateLeadSource; other meta fields cannot
    const upd = await call(me.token)('updateLeadSource', { id: 'SRC-0001', patch: { config: { meta: { formIds: [FORM_A, FORM_B], pageId: '1' } } } });
    expect((upd.body as any).data.config.meta).toMatchObject({ formIds: [FORM_A, FORM_B], pageId: PAGE, pageName: 'Amaya Living', subscribed: true });
    // the UI sends the whole stored config back: only formIds is taken; unknown forms are refused; the token stays
    const whole = { ...(upd.body as any).data.config.meta, formIds: [FORM_B], pageName: 'Hacked', subscribed: false, lastError: 'x', forms: [] };
    const upd2 = await call(me.token)('updateLeadSource', { id: 'SRC-0001', patch: { config: { meta: whole } } });
    expect((upd2.body as any).data.config.meta).toMatchObject({ formIds: [FORM_B], pageName: 'Amaya Living', subscribed: true, lastError: '', forms: forms[PAGE] });
    expect((await call(me.token)('updateLeadSource', { id: 'SRC-0001', patch: { config: { meta: { formIds: ['123'] } } } })).status).toBe(400);
    const raw2 = await inCo(async () => (await sourcesCol()).findOne({ _id: 'SRC-0001' }));
    expect((raw2 as any).secret.pageToken).toBe((raw as any).secret.pageToken);
  });

  it('a Manager cannot start the connect flow', async () => {
    const mgr = await signIn('Manager', 'mgr@meta.test');
    const r = await connectGET(new Request('https://crm.example.com/api/integrations/meta/connect', { headers: { cookie: `amaya_session=${mgr.cookie}` } }));
    expect(new URL(r.headers.get('location')!).searchParams.get('metaError')).toMatch(/administrator/);
    expect(r.headers.get('set-cookie')).toBeNull();
  });
});

/* ------------------------- backfill / check / disconnect ----------------- */

describe('backfill, check and disconnect', () => {
  it('backfill imports recent leads of the forms once', async () => {
    const { sourceId } = await connectDirect();
    leads['7001'] = lead('7001');
    leads['7002'] = lead('7002', { form_id: FORM_B, field_data: [{ name: 'full_name', values: ['Ravi'] }, { name: 'phone_number', values: ['9876500001'] }] });
    leads['7003'] = lead('7003', { created_time: new Date(Date.now() - 20 * 86400000).toISOString(), field_data: [{ name: 'full_name', values: ['Old'] }, { name: 'phone_number', values: ['9876500002'] }] });
    const r1 = await inCo(() => M.backfillMetaSource({ sourceId, days: 7 }, null));
    expect(r1).toMatchObject({ created: 2, duplicates: 0, rejected: 0, failed: 0, message: '2 new' });
    const leadCalls = graphCalls((c) => c.path.endsWith('/leads'));
    expect(JSON.parse(leadCalls[0].params.get('filtering')!)[0]).toMatchObject({ field: 'time_created', operator: 'GREATER_THAN' });
    const r2 = await inCo(() => M.backfillMetaSource({ sourceId }, null));
    expect(r2).toMatchObject({ created: 0, message: '2 already imported' });
    expect(await leadsIn()).toHaveLength(2);
    // a webhook for the same lead later is a no-op too
    await Q.enqueueLeadgen(JSON.parse(leadgenBody(['7001'])));
    expect(await Q.processQueueItem('7001')).toMatchObject({ status: 'done', leadId: 'ENQ-0001' });
    expect(await leadsIn()).toHaveLength(2);
    await expect(inCo(() => M.backfillMetaSource({ sourceId, days: 31 }, null))).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('checkMetaSource refreshes forms and re-subscribes', async () => {
    const { sourceId } = await connectDirect();
    subscribed.delete(PAGE);
    const r = await inCo(() => M.checkMetaSource({ sourceId }, null));
    expect(r).toMatchObject({ ok: true, subscribed: true, forms: forms[PAGE] });
    expect(subscribed.has(PAGE)).toBe(true);
  });

  it('disconnect (and deleteLeadSource) unsubscribes the app and releases the claim', async () => {
    const { sourceId } = await connectDirect();
    await inCo(() => M.disconnectMetaSource({ sourceId }, null));
    expect(subscribed.has(PAGE)).toBe(false);
    expect(await (await plat()).collection('metaPages').countDocuments({})).toBe(0);
    expect(await inCo(() => LS.listLeadSources())).toHaveLength(0);

    const again = await connectDirect();
    await inCo(() => LS.deleteLeadSource({ id: again.sourceId }, null));
    expect(subscribed.has(PAGE)).toBe(false);
    expect(await (await plat()).collection('metaPages').countDocuments({})).toBe(0);

    // the other company can now connect it; deleting that company releases it
    await registerOther();
    await connectDirect(PAGE, 'CMP-other');
    const setup = await platformDispatch('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' }, { token: '', userAgent: 'vitest', ip: '10.0.0.1' });
    const del = await platformDispatch('deleteCompany', { id: 'CMP-other', confirmSlug: 'other' }, { token: setup.session!.token, userAgent: 'vitest', ip: '10.0.0.1' });
    expect(del.status).toBe(200);
    expect(subscribed.has(PAGE)).toBe(false);
    expect(await (await plat()).collection('metaPages').countDocuments({})).toBe(0);
  });
});

/* ---------------------------------- cron --------------------------------- */

describe('cron /api/cron/meta', () => {
  const cron = () => cronGET(new Request('https://crm.example.com/api/cron/meta', { headers: { Authorization: 'Bearer cron-secret-123' } }));

  it('needs the secret, processes due items and backfills once a day', async () => {
    expect((await cronGET(new Request('https://crm.example.com/api/cron/meta'))).status).toBe(401);
    const { sourceId } = await connectDirect();
    leads['5001'] = lead('5001');
    await Q.enqueueLeadgen(JSON.parse(leadgenBody(['5001'])));
    const b1 = await (await cron()).json();
    expect(b1.data.queue).toEqual({ processed: 1, byStatus: { done: 1 } });
    expect(b1.data.backfills.test).toEqual([{ id: sourceId, result: '1 already imported' }]);
    const b2 = await (await cron()).json();
    expect(b2.data).toEqual({ queue: { processed: 0, byStatus: {} }, backfills: {} });
  });

  it('skips cleanly when Meta is not configured', async () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    const b = await (await cron()).json();
    expect(b.data.skipped).toMatch(/not configured/);
  });
});

/* ------------------------------- plan gating ----------------------------- */

describe('plan gating and the inbound endpoint', () => {
  it('without metaLeads the Meta actions are FORBIDDEN but metaStatus answers', async () => {
    await t.company('test', { metaLeads: false, websiteApi: true });
    await createUser({ name: 'Boss', email: 'boss@meta.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null);
    const token = (await login('boss@meta.test', 'long-enough-pw', { userAgent: 'vitest', ip: '10.2.2.2' })).token;
    const call = (action: string, data: any = {}) => dispatch(action, data, { token, userAgent: 'vitest', ip: '10.2.2.2', companyId: 'CMP-test' });
    for (const a of ['getMetaPendingConnection', 'connectMetaPages', 'checkMetaSource', 'backfillMetaSource', 'disconnectMetaSource']) {
      const r = await call(a, {});
      expect(r.status, a).toBe(403);
      expect((r.body as any).code).toBe('FORBIDDEN');
    }
    const s = await call('metaStatus');
    expect(s.status).toBe(200);
    expect((s.body as any).data).toEqual({
      configured: true, appId: APP_ID, graphVersion: 'v23.0', source: 'env', connectUrl: '/api/integrations/meta/connect',
      webhookUrl: 'https://crm.example.com/api/webhooks/meta', oauthRedirectUri: 'https://crm.example.com/api/integrations/meta/callback',
    });
    expect(JSON.stringify(s.body)).not.toContain(APP_SECRET);
    expect((await call('createLeadSource', { name: 'X', type: 'meta' })).status).toBe(403);
    await t.company('test', { metaLeads: true, websiteApi: true });
    const c = await call('createLeadSource', { name: 'X', type: 'meta' });
    expect(c.status).toBe(400);
    expect((c.body as any).message).toMatch(/connecting a Facebook Page/);
  });

  it('the inbound endpoint refuses meta sources', async () => {
    const { sourceId } = await connectDirect();
    const key = 'crm_live_' + 'b'.repeat(48);
    await (await plat()).collection('apiKeys').insertOne({ _id: sha256Hex(key) as any, companyId: 'CMP-test', sourceId, createdAt: new Date() });
    const r = await inboundPOST(new Request('https://crm.example.com/api/inbound/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key }, body: JSON.stringify({ name: 'X', phone: '9876543210' }) }));
    expect(r.status).toBe(403);
    expect((await r.json()).message).toMatch(/Meta/);
    expect(await leadsIn()).toHaveLength(0);
  });
});

/* ------------------------------- super admin ----------------------------- */

describe('super admin', () => {
  it('stores the app secret encrypted, never returns it, and can connect a Page for a company', async () => {
    for (const k of ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN']) delete process.env[k];
    const setup = await platformDispatch('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' }, { token: '', userAgent: 'vitest', ip: '10.0.0.1' });
    const pd = (action: string, data: any = {}) => platformDispatch(action, data, { token: setup.session!.token, userAgent: 'vitest', ip: '10.0.0.1' });

    expect((await pd('getMetaSettings')).body).toMatchObject({ data: { configured: false, source: 'none', queue: { pending: 0, failed: 0, done24h: 0 } } });
    expect((await pd('setMetaSettings', { appId: 'abc' })).status).toBe(400);
    expect((await pd('setMetaSettings', { appId: APP_ID, appSecret: APP_SECRET, graphVersion: '23' })).status).toBe(400);

    const set = await pd('setMetaSettings', { appId: APP_ID, appSecret: APP_SECRET, verifyToken: '__generate__', graphVersion: 'v24.0' });
    expect(set.status).toBe(200);
    const data = (set.body as any).data;
    expect(data).toMatchObject({ configured: true, source: 'platform', appId: APP_ID, graphVersion: 'v24.0', updatedBy: 'Root <root@platform.io>', webhookUrl: 'https://crm.example.com/api/webhooks/meta' });
    expect(data.verifyToken).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(set.body)).not.toContain(APP_SECRET);
    const doc = await (await plat()).collection('platformSettings').findOne({ _id: 'meta' as any });
    expect(JSON.stringify(doc)).not.toContain(APP_SECRET);
    expect(JSON.stringify(doc)).not.toContain(data.verifyToken);
    expect(String(doc!.appSecret).split('.')).toHaveLength(3);

    // '' keeps the stored secret; the verify token is kept too
    const keep = await pd('setMetaSettings', { appId: APP_ID, appSecret: '' });
    expect((keep.body as any).data).toMatchObject({ configured: true, verifyToken: data.verifyToken, graphVersion: 'v24.0' });
    expect((await pd('testMetaSettings')).body).toMatchObject({ data: { ok: true } });
    expect(graphCalls((c) => c.path === 'oauth/access_token' && c.params.get('grant_type') === 'client_credentials')).toHaveLength(1);

    // webhook verification uses the stored token
    const ok = await webhookGET(new Request(`https://crm.example.com/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${data.verifyToken}&hub.challenge=42`));
    expect(await ok.text()).toBe('42');

    // connect a Page with a Page token on the company's behalf
    expect((await pd('connectCompanyMetaPage', { companyId: 'CMP-test', pageId: PAGE, pageAccessToken: pageToken(PAGE2) })).status).toBe(400);
    const c = await pd('connectCompanyMetaPage', { companyId: 'CMP-test', pageId: PAGE, pageAccessToken: pageToken(PAGE), formIds: [FORM_A] });
    expect(c.status).toBe(200);
    expect((c.body as any).data).toEqual({ sourceId: 'SRC-0001' });
    expect(subscribed.has(PAGE)).toBe(true);
    const list = await pd('companyMeta', { companyId: 'CMP-test' });
    expect((list.body as any).data).toEqual([expect.objectContaining({ sourceId: 'SRC-0001', name: 'Facebook: Amaya Living', status: 'Active', meta: expect.objectContaining({ pageId: PAGE, formIds: [FORM_A] }) })]);
    expect(JSON.stringify(list.body)).not.toContain('PAGE-TOKEN');
    const audit = await pd('auditLog', {});
    expect(JSON.stringify(audit.body)).toContain('Meta App Set');
    expect(JSON.stringify(audit.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(audit.body)).not.toContain('PAGE-TOKEN');
  });
});
