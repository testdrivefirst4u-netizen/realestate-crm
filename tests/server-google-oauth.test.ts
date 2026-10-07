/**
 * "Connect with Google" (OAuth) for the Google Sheets integration: the platform OAuth client, the connect /
 * callback routes (signed state + nonce cookie + session), stored connections (refresh token encrypted), the token
 * provider (refresh + cache, invalid_grant → reconnect), imports/exports/checkSheet/cron with oauth auth, the
 * default-auth rule, disconnect (CONFLICT vs force + revoke), the plan gate and the console view.
 * Google is an in-memory fake behind a stubbed global fetch — nothing calls Google for real.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { getClient, PLATFORM_DB } from '../server/core/db';
import { runWithTenant, type Tenant } from '../server/core/tenant';
import { DEFAULT_FEATURES, getTenantById, invalidateTenant } from '../server/platform/registry';
import { createUser, login, SYSTEM_CTX } from '../server/core/auth';
import { decryptSecret } from '../server/core/settings';
import * as LS from '../server/modules/leadSources';
import * as SH from '../server/modules/sheets';
import * as GC from '../server/modules/googleConnect';
import { sourcesCol } from '../server/modules/intake';
import { GOOGLE_TOKEN_URL, resetGoogleTokenCache, SHEETS_SCOPE, __setGoogleRetryDelay } from '../server/integrations/google';
import { dispatch } from '../server/router';
import { platformDispatch } from '../server/platform/router';
import { GET as connectGET } from '../app/api/integrations/google/connect/route';
import { GET as callbackGET } from '../app/api/integrations/google/callback/route';
import { GET as cronGET } from '../app/api/cron/sheets/route';

/* ------------------------------ fake Google ------------------------------ */

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SA_EMAIL = 'crm-sync@amaya-test.iam.gserviceaccount.com';
const SA_JSON = JSON.stringify({ type: 'service_account', project_id: 'amaya-test', private_key: privateKey, client_email: SA_EMAIL });
const CLIENT_ID = '123456789012-abcdef0123456789.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret-value';

interface FakeTab { title: string; sheetId: number; rows: string[][] }
let sheets: Record<string, { title: string; tabs: FakeTab[] }> = {};
let sheetAuth: string[] = []; // Authorization header of every Sheets API call
let tokenRequests: URLSearchParams[] = [];
let revoked: string[] = [];
let invalidRefresh = new Set<string>();
let codeAnswers: Record<string, any> = {};
let nextSheetId = 100;
let oauthN = 0;
let saN = 0;

const SID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab';
const SID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-zz';
const URL1 = `https://docs.google.com/spreadsheets/d/${SID}/edit`;
const URL2 = `https://docs.google.com/spreadsheets/d/${SID2}/edit`;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const idToken = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

function addFakeSheet(id: string, tabs: Array<{ title: string; rows: string[][] }>) {
  sheets[id] = { title: 'Book', tabs: tabs.map((t) => ({ title: t.title, sheetId: nextSheetId++, rows: t.rows.map((r) => [...r]) })) };
}
const tabOf = (sheet: { tabs: FakeTab[] }, range: string) => {
  const m = range.match(/^'((?:[^']|'')*)'(?:!([A-Z]+)(\d+)?)?/);
  return m ? { tab: sheet.tabs.find((t) => t.title === m[1].replace(/''/g, "'")), row: m[3] ? Number(m[3]) - 1 : 0 } : { tab: undefined, row: 0 };
};

async function fakeFetch(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  if (url.toString() === GOOGLE_TOKEN_URL) {
    const f = new URLSearchParams(String(init.body));
    tokenRequests.push(f);
    const g = f.get('grant_type');
    if (g === 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json(200, { access_token: `ya29.sa-${++saN}`, expires_in: 3599 });
    if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
    if (g === 'authorization_code') {
      expect(f.get('redirect_uri')).toBe('https://crm.example.com/api/integrations/google/callback');
      const a = codeAnswers[f.get('code') || ''];
      return a ? json(200, a) : json(400, { error: 'invalid_grant', error_description: 'Bad code' });
    }
    if (g === 'refresh_token') {
      if (invalidRefresh.has(f.get('refresh_token') || '')) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: `ya29.oauth-${++oauthN}`, expires_in: 3599, scope: `openid email ${SHEETS_SCOPE}` });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }
  if (url.toString() === GC.GOOGLE_REVOKE_URL) {
    revoked.push(new URLSearchParams(String(init.body)).get('token') || '');
    return json(200, {});
  }
  if (url.host !== 'sheets.googleapis.com') throw new Error('fake: unexpected host ' + url.host);
  sheetAuth.push(String(init.headers?.Authorization || ''));  const path = decodeURIComponent(url.pathname.replace(/^\/v4\/spreadsheets\//, ''));
  const [idOp, ...rest] = path.split('/');
  const [id, op] = idOp.split(':');
  const sheet = sheets[id];
  if (!sheet) return json(404, { error: { message: 'Requested entity was not found.' } });
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (!rest.length && !op) return json(200, { properties: { title: sheet.title }, sheets: sheet.tabs.map((t, i) => ({ properties: { sheetId: t.sheetId, title: t.title, index: i } })) });
  if (op === 'batchUpdate') {
    const replies = body.requests.map((r: any) => {
      if (!r.addSheet) return {};
      const tab = { title: r.addSheet.properties.title, sheetId: nextSheetId++, rows: [] as string[][] };
      sheet.tabs.push(tab);
      return { addSheet: { properties: { sheetId: tab.sheetId } } };
    });
    return json(200, { replies });
  }
  if (rest[0] === 'values:batchUpdate') return json(200, {});
  const [range, suffix] = rest.slice(1).join('/').split(':');
  const { tab, row } = tabOf(sheet, range);
  if (!tab) return json(400, { error: { message: 'Unable to parse range: ' + range } });
  if (method === 'GET') return json(200, { values: tab.rows.slice(row) });
  if (suffix === 'clear') {
    tab.rows = [];
    return json(200, {});
  }
  if (method === 'PUT') {
    body.values.forEach((r: any[], i: number) => {
      const cur = (tab.rows[row + i] ||= []);
      r.forEach((v, j) => (cur[j] = String(v)));
    });
    return json(200, {});
  }
  throw new Error(`fake: unhandled ${method} ${url}`);
}

/* --------------------------------- setup --------------------------------- */

let t: Awaited<ReturnType<typeof startTestDb>>;
const OTHER_DB = 'amaya_test_google_other';

async function tenant(id = 'CMP-test'): Promise<Tenant> {
  invalidateTenant();
  return (await getTenantById(id))!;
}
const inCo = async <T>(fn: () => Promise<T>, id = 'CMP-test') => runWithTenant(await tenant(id), fn);
const connect = (email: string, refreshToken = 'rt-' + email, id = 'CMP-test') =>
  inCo(() => GC.upsertGoogleConnection({ email, refreshToken, scopes: ['openid', 'email', SHEETS_SCOPE], ctx: SYSTEM_CTX }), id);
const sheetSource = (sheet: Record<string, unknown>) => inCo(() => LS.createLeadSource({ name: 'Sheet leads', type: 'google_sheet', config: { sheet } as any }, null));

// Connecting Google is platform-support work (role Developer); company Admins no longer manage settings.
async function signIn(role: 'Developer' | 'Admin' | 'RM' = 'Developer', email = 'boss@google.test') {
  await createUser({ name: 'Boss ' + role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  const r = await login(email, 'long-enough-pw', { userAgent: 'vitest', ip: '10.2.2.2' });
  return { token: r.token, userId: r.user.id, cookie: `CMP-test.${r.token}` };
}
const rpc = (token: string) => (action: string, data: any = {}) => dispatch(action, data, { token, userAgent: 'vitest', ip: '10.2.2.2', companyId: 'CMP-test' });
async function superAdmin() {
  const setup = await platformDispatch('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' }, { token: '', userAgent: 'vitest', ip: '10.0.0.1' });
  return (action: string, data: any = {}) => platformDispatch(action, data, { token: setup.session!.token, userAgent: 'vitest', ip: '10.0.0.1' });
}

beforeAll(async () => {
  t = await startTestDb();
  __setGoogleRetryDelay(5);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'APP_URL', 'CRON_SECRET']) delete process.env[k];
  await (await getClient())!.db(OTHER_DB).dropDatabase();
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { googleSheets: true, websiteApi: true });
  await (await getClient())!.db(PLATFORM_DB()).collection('companies').updateOne(
    { _id: 'CMP-other' as any },
    { $set: { slug: 'other', name: 'Other Co', dbName: OTHER_DB, status: 'Active', plan: 'Test', maxUsers: 0, features: { ...DEFAULT_FEATURES, googleSheets: true }, logo: '', tagline: '', createdAt: new Date(), updatedAt: new Date() } },
    { upsert: true }
  );
  const other = (await getClient())!.db(OTHER_DB);
  await Promise.all((await other.collections()).map((c) => c.deleteMany({})));
  invalidateTenant();
  sheets = {};
  sheetAuth = [];
  tokenRequests = [];
  revoked = [];
  invalidRefresh = new Set();
  codeAnswers = {};
  oauthN = 0;
  saN = 0;
  resetGoogleTokenCache();
  GC.resetGoogleOAuthTokenCache();
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
  process.env.APP_URL = 'https://crm.example.com';
  process.env.CRON_SECRET = 'cron-secret-123';
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

/* --------------------------------- tests --------------------------------- */

describe('platform OAuth client', () => {
  it('validates, stores the secret encrypted, never returns it; env fallback; removing the service account keeps it', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const pd = await superAdmin();
    const empty = (await pd('getGoogleSettings')).body as any;
    expect(empty.data).toMatchObject({ oauthConfigured: false, oauthClientId: '', oauthSecretSet: false, oauthSource: 'none', oauthRedirectUri: 'https://crm.example.com/api/integrations/google/callback', connectUrl: '/api/integrations/google/connect' });

    for (const bad of ['abc', 'abc-def.apps.googleusercontent.com', '123-ABC.apps.googleusercontent.com', `${CLIENT_ID}.evil.com`]) {
      expect((await pd('setGoogleOAuthClient', { clientId: bad, clientSecret: CLIENT_SECRET })).status).toBe(400);
    }
    expect(((await pd('setGoogleOAuthClient', { clientId: CLIENT_ID, clientSecret: '' })).body as any).message).toMatch(/Client Secret/);

    const set = await pd('setGoogleOAuthClient', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(set.status).toBe(200);
    expect((set.body as any).data).toMatchObject({ oauthConfigured: true, oauthClientId: CLIENT_ID, oauthSecretSet: true, oauthSource: 'platform' });
    expect(JSON.stringify(set.body)).not.toContain(CLIENT_SECRET);
    const settings = (await getClient())!.db(PLATFORM_DB()).collection('platformSettings');
    const doc = await settings.findOne({ _id: 'google' as any });
    expect(JSON.stringify(doc)).not.toContain(CLIENT_SECRET);
    expect(decryptSecret(doc!.oauthClientSecret)).toBe(CLIENT_SECRET);

    // '' secret keeps the stored one
    const id2 = '987654321-zzz.apps.googleusercontent.com';
    await pd('setGoogleOAuthClient', { clientId: id2, clientSecret: '' });
    const doc2 = await settings.findOne({ _id: 'google' as any });
    expect(doc2!.oauthClientId).toBe(id2);
    expect(decryptSecret(doc2!.oauthClientSecret)).toBe(CLIENT_SECRET);

    // removing the service account leaves the OAuth client
    await pd('setGoogleServiceAccount', { json: SA_JSON });
    await pd('setGoogleServiceAccount', { json: '' });
    expect(((await pd('getGoogleSettings')).body as any).data).toMatchObject({ configured: false, oauthConfigured: true, oauthClientId: id2 });
    const audit = JSON.stringify((await pd('auditLog', {})).body);
    expect(audit).toContain('Google OAuth Client Set');
    expect(audit).not.toContain(CLIENT_SECRET);

    // '' clientId removes it; env is the fallback (stored wins while present)
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    expect(((await pd('getGoogleSettings')).body as any).data).toMatchObject({ oauthSource: 'platform', oauthClientId: id2 });
    const rm = await pd('setGoogleOAuthClient', { clientId: '' });
    expect((rm.body as any).data).toMatchObject({ oauthConfigured: true, oauthSource: 'env', oauthClientId: CLIENT_ID });
    expect(JSON.stringify(rm.body)).not.toContain(CLIENT_SECRET);
  });
});

describe('connect flow', () => {
  const cb = (q: string, cookie: string) => callbackGET(new Request(`https://crm.example.com/api/integrations/google/callback?${q}`, { headers: { cookie } }));
  const loc = (r: Response) => new URL(r.headers.get('location')!);

  async function start(me: { cookie: string }) {
    const r = await connectGET(new Request('https://crm.example.com/api/integrations/google/connect', { headers: { cookie: `amaya_session=${me.cookie}` } }));
    const setCookie = r.headers.get('set-cookie') || '';
    return { r, url: loc(r), nonce: setCookie.match(/google_oauth_nonce=([0-9a-f]+)/)?.[1] || '', setCookie };
  }

  it('redirects to Google with the right parameters, a signed state and an httpOnly nonce cookie', async () => {
    const anon = await connectGET(new Request('https://crm.example.com/api/integrations/google/connect'));
    expect(anon.headers.get('location')).toBe('https://crm.example.com/');
    const me = await signIn();
    const { r, url, nonce, setCookie } = await start(me);
    expect(r.status).toBe(302);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe('https://crm.example.com/api/integrations/google/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe(`openid email ${SHEETS_SCOPE}`);
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('include_granted_scopes')).toBe('true');
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie).toContain('Path=/api/integrations/google');
    const [body] = q.get('state')!.split('.');
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toMatchObject({ c: 'CMP-test', u: me.userId, n: nonce });

    // no OAuth client / not an admin / no plan feature → back to Settings with an error
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(loc((await start(me)).r).searchParams.get('googleError')).toMatch(/not set up/);
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    const rm = await signIn('RM', 'rm@google.test');
    const rmStart = loc((await start(rm)).r);
    expect(rmStart.searchParams.get('section')).toBe('googleSheets');
    expect(rmStart.searchParams.get('googleError')).toMatch(/administrator/);
    await t.company('test', { googleSheets: false });
    expect(loc((await start(me)).r).searchParams.get('googleError')).toMatch(/plan/);
  });

  it('callback: refuses bad, tampered, expired and foreign states; handles access_denied, no refresh token, missing scope', async () => {
    const me = await signIn();
    const { url, nonce } = await start(me);
    const state = url.searchParams.get('state')!;
    const cookie = `amaya_session=${me.cookie}; google_oauth_nonce=${nonce}`;
    codeAnswers.good = { access_token: 'ya29.x', refresh_token: 'rt-good', scope: `openid ${SHEETS_SCOPE} email`, id_token: idToken({ email: 'Owner@Example.com' }) };

    expect(loc(await cb(`code=good&state=${encodeURIComponent(state)}`, `google_oauth_nonce=${nonce}`)).toString()).toBe('https://crm.example.com/');
    const denied = loc(await cb('error=access_denied', cookie));
    expect(denied.pathname).toBe('/settings');
    expect(denied.searchParams.get('section')).toBe('googleSheets');
    expect(denied.searchParams.get('googleError')).toBe(GC.CANCELLED_MSG);

    const bad = (s: string, c = cookie) => cb(`code=good&state=${encodeURIComponent(s)}`, c).then((r) => loc(r).searchParams.get('googleError'));
    expect(await bad('garbage')).toBe(GC.NOT_VERIFIED_MSG);
    const [body, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), c: 'CMP-other' })).toString('base64url');
    expect(await bad(`${forged}.${sig}`)).toBe(GC.NOT_VERIFIED_MSG);
    expect(await bad(state, `amaya_session=${me.cookie}`)).toBe(GC.NOT_VERIFIED_MSG); // no nonce cookie
    const other = await signIn('Developer', 'second@google.test');
    expect(await bad(state, `amaya_session=${other.cookie}; google_oauth_nonce=${nonce}`)).toBe(GC.NOT_VERIFIED_MSG);
    // a Facebook state is not a Google state
    const { signState } = await import('../server/core/oauthState');
    const metaState = signState({ c: 'CMP-test', u: me.userId, n: nonce, exp: Math.floor(Date.now() / 1000) + 600 });
    expect(await bad(metaState)).toBe(GC.NOT_VERIFIED_MSG);
    // expired (core function with a clock)
    const late = await GC.finishGoogleConnect({ params: new URLSearchParams({ code: 'good', state }), sessionCookie: me.cookie, nonceCookie: nonce, nowMs: Date.now() + 11 * 60000 });
    expect(new URL(late.redirect).searchParams.get('googleError')).toBe(GC.NOT_VERIFIED_MSG);
    expect(tokenRequests).toHaveLength(0);

    codeAnswers.offline = { access_token: 'ya29.x', scope: `openid email ${SHEETS_SCOPE}`, id_token: idToken({ email: 'a@b.com' }) };
    expect(await cb(`code=offline&state=${encodeURIComponent(state)}`, cookie).then((r) => loc(r).searchParams.get('googleError'))).toBe(GC.NO_OFFLINE_MSG);
    codeAnswers.noscope = { access_token: 'ya29.x', refresh_token: 'rt-noscope', scope: 'openid email', id_token: idToken({ email: 'a@b.com' }) };
    expect(await cb(`code=noscope&state=${encodeURIComponent(state)}`, cookie).then((r) => loc(r).searchParams.get('googleError'))).toBe(GC.NO_SHEETS_SCOPE_MSG);
    expect(revoked).toEqual(['rt-noscope']);
    expect(await inCo(() => SH.listGoogleConnections())).toEqual([]);
  });

  it('callback success stores the e-mail and the encrypted refresh token; reconnecting the same e-mail updates it', async () => {
    const me = await signIn();
    const { url, nonce } = await start(me);
    const state = url.searchParams.get('state')!;
    const cookie = `amaya_session=${me.cookie}; google_oauth_nonce=${nonce}`;
    codeAnswers.good = { access_token: 'ya29.x', refresh_token: 'RT-SECRET-1', scope: `openid ${SHEETS_SCOPE} https://www.googleapis.com/auth/userinfo.email`, id_token: idToken({ email: 'Owner@Example.com' }) };
    const res = await cb(`code=good&state=${encodeURIComponent(state)}`, cookie);
    expect(res.headers.get('set-cookie')).toMatch(/google_oauth_nonce=;/);
    const back = loc(res);
    expect(back.origin + back.pathname).toBe('https://crm.example.com/settings');
    expect(back.searchParams.get('section')).toBe('googleSheets');
    expect(back.searchParams.get('googleConnected')).toBe('GCN-0001');
    expect(back.toString()).not.toContain('RT-SECRET');
    expect(tokenRequests[0].get('grant_type')).toBe('authorization_code');

    const raw = await inCo(async () => (await GC.googleConnectionsCol()).findOne({ _id: 'GCN-0001' }));
    expect(raw).toMatchObject({ email: 'owner@example.com', status: 'Active', lastError: '', connectedBy: expect.stringContaining('boss@google.test') });
    expect(JSON.stringify(raw)).not.toContain('RT-SECRET');
    expect(decryptSecret(raw!.refreshToken)).toBe('RT-SECRET-1');

    const list = await rpc(me.token)('listGoogleConnections');
    expect((list.body as any).data).toEqual([{ id: 'GCN-0001', email: 'owner@example.com', status: 'Active', lastError: '', connectedBy: expect.any(String), connectedAt: expect.any(String), usedBy: 0 }]);
    expect(JSON.stringify(list.body)).not.toContain('RT-SECRET');

    // reconnect (after an error) → same connection, new token, error cleared
    await inCo(async () => (await GC.googleConnectionsCol()).updateOne({ _id: 'GCN-0001' }, { $set: { status: 'Error', lastError: GC.RECONNECT_MSG } }));
    codeAnswers.again = { ...codeAnswers.good, refresh_token: 'RT-SECRET-2' };
    const again = loc(await cb(`code=again&state=${encodeURIComponent(state)}`, cookie));
    expect(again.searchParams.get('googleConnected')).toBe('GCN-0001');
    const raw2 = await inCo(async () => (await GC.googleConnectionsCol()).find({}).toArray());
    expect(raw2).toHaveLength(1);
    expect(raw2[0]).toMatchObject({ status: 'Active', lastError: '' });
    expect(decryptSecret(raw2[0].refreshToken)).toBe('RT-SECRET-2');
  });

  it('reads the e-mail from userinfo when the id_token has none', async () => {
    const me = await signIn();
    const { url, nonce } = await start(me);
    codeAnswers.c = { access_token: 'ya29.ui', refresh_token: 'rt-ui', scope: `openid email ${SHEETS_SCOPE}` };
    const base = fetch;
    vi.stubGlobal('fetch', vi.fn(async (u: any, i: any) => (String(u) === GC.GOOGLE_USERINFO_URL ? json(200, { email: 'ui@example.com' }) : (base as any)(u, i))));
    const r = loc(await cb(`code=c&state=${encodeURIComponent(url.searchParams.get('state')!)}`, `amaya_session=${me.cookie}; google_oauth_nonce=${nonce}`));
    expect(r.searchParams.get('googleConnected')).toBe('GCN-0001');
    expect((await inCo(() => SH.listGoogleConnections()))[0].email).toBe('ui@example.com');
  });
});

describe('sheets through an OAuth connection', () => {
  it('checkSheet, import and export use the OAuth token; access tokens are cached per connection', async () => {
    const { id } = await connect('owner@example.com');
    addFakeSheet(SID, [{ title: 'Sheet1', rows: [['Name', 'Phone'], ['Asha', '9876543210']] }]);
    addFakeSheet(SID2, [{ title: 'Sheet1', rows: [] }]);
    const auth = { mode: 'oauth' as const, connectionId: id };

    const chk = await inCo(() => SH.checkSheet({ spreadsheetUrl: URL1, auth }));
    expect(chk).toMatchObject({ ok: true, headers: ['Name', 'Phone'], canWrite: true });
    const { source } = await sheetSource({ spreadsheetUrl: URL1, auth });
    expect(source.config.sheet!.auth).toEqual(auth);
    const r = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(r).toMatchObject({ created: 1 });
    const x = await inCo(() => SH.createSheetExport({ name: 'Backup', spreadsheetUrl: URL2, auth }, null));
    expect(x.auth).toEqual(auth);
    await inCo(() => SH.runSheetExport({ id: x.id }, null));
    expect(sheets[SID2].tabs.find((tb) => tb.title === 'CRM Leads')!.rows).toHaveLength(2);

    expect(sheetAuth.length).toBeGreaterThan(5);
    expect(new Set(sheetAuth)).toEqual(new Set(['Bearer ya29.oauth-1']));
    const refreshes = tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].get('refresh_token')).toBe('rt-owner@example.com');
    expect(refreshes[0].get('client_id')).toBe(CLIENT_ID);
    expect(tokenRequests.some((f) => f.get('grant_type')?.includes('jwt-bearer'))).toBe(false);

    // resolveSheetToken hands out the cached token
    expect(await inCo(() => GC.resolveSheetToken(auth))).toBe('ya29.oauth-1');
  });

  it('auth validation and the default rule', async () => {
    addFakeSheet(SID, [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    // no connection, no service account → service_account (and the check says Google is not set up)
    expect(await inCo(() => GC.defaultSheetAuth())).toEqual({ mode: 'service_account' });
    const { id } = await connect('one@example.com');
    // exactly one Active connection and no service account → that connection
    expect(await inCo(() => GC.defaultSheetAuth())).toEqual({ mode: 'oauth', connectionId: id });
    const { source } = await sheetSource({ spreadsheetUrl: URL1 });
    expect(source.config.sheet!.auth).toEqual({ mode: 'oauth', connectionId: id });
    // with a service account → service_account
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;
    expect(await inCo(() => GC.defaultSheetAuth())).toEqual({ mode: 'service_account' });
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    // two Active connections → service_account
    await connect('two@example.com');
    expect(await inCo(() => GC.defaultSheetAuth())).toEqual({ mode: 'service_account' });

    // another company's connection, an unknown id, an Error connection, a bad mode → VALIDATION
    const foreign = await connect('foreign@example.com', 'rt-f', 'CMP-other');
    expect(foreign.id).toBe('GCN-0001');
    await inCo(async () => (await GC.googleConnectionsCol()).deleteMany({}));
    await expect(inCo(() => SH.checkSheet({ spreadsheetUrl: URL1, auth: { mode: 'oauth', connectionId: 'GCN-0001' } }))).rejects.toMatchObject({ code: 'VALIDATION' });
    const mine = await connect('mine@example.com');
    await inCo(async () => (await GC.googleConnectionsCol()).updateOne({ _id: mine.id }, { $set: { status: 'Error', lastError: GC.RECONNECT_MSG } }));
    await expect(inCo(() => SH.createSheetExport({ name: 'X', spreadsheetUrl: URL1, tab: 'Out', auth: { mode: 'oauth', connectionId: mine.id } }, null))).rejects.toThrow(/reconnected/);
    await expect(inCo(() => SH.checkSheet({ spreadsheetUrl: URL1, auth: { mode: 'magic' } as any }))).rejects.toMatchObject({ code: 'VALIDATION' });
    // switching an import to the service account re-checks the sheet with it
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;
    const upd = await inCo(() => LS.updateLeadSource({ id: source.id, patch: { config: { sheet: { auth: { mode: 'service_account' } } } as any } }, null));
    expect(upd.config.sheet!.auth).toEqual({ mode: 'service_account' });
    expect(sheetAuth[sheetAuth.length - 1]).toMatch(/^Bearer ya29\.sa-/);
  });

  it('updateSheetExport can switch the access (validated, re-checked, re-exported on the next run)', async () => {
    const { id } = await connect('owner@example.com');
    addFakeSheet(SID2, [{ title: 'Sheet1', rows: [] }]);
    const x = await inCo(() => SH.createSheetExport({ name: 'Backup', spreadsheetUrl: URL2, auth: { mode: 'oauth', connectionId: id } }, null));
    await inCo(() => SH.runSheetExport({ id: x.id }, null));
    const before = await inCo(async () => (await SH.exportsCol()).findOne({ _id: x.id }));
    expect(before!.lastVersion).not.toBe('');

    // no platform service account → refused
    await expect(inCo(() => SH.updateSheetExport({ id: x.id, patch: { auth: { mode: 'service_account' } } }, null))).rejects.toThrow(/service account is not set up/);
    // an unknown connection → refused
    await expect(inCo(() => SH.updateSheetExport({ id: x.id, patch: { auth: { mode: 'oauth', connectionId: 'GCN-0099' } } }, null))).rejects.toMatchObject({ code: 'VALIDATION' });

    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;
    sheetAuth = [];
    const upd = await inCo(() => SH.updateSheetExport({ id: x.id, patch: { auth: { mode: 'service_account' } } }, null));
    expect(upd.auth).toEqual({ mode: 'service_account' });
    expect(sheetAuth.length).toBeGreaterThan(0); // re-checked with the new access
    expect(sheetAuth.every((h) => h.startsWith('Bearer ya29.sa-'))).toBe(true);
    const after = await inCo(async () => (await SH.exportsCol()).findOne({ _id: x.id }));
    expect(after!.lastVersion).toBe('');

    // the sheet unreachable with the new access → refused, nothing changed
    const { id: id2 } = await connect('second@example.com');
    delete sheets[SID2];
    await expect(inCo(() => SH.updateSheetExport({ id: x.id, patch: { auth: { mode: 'oauth', connectionId: id2 } } }, null))).rejects.toThrow(/not found/);
    expect((await inCo(() => SH.listSheetExports()))[0].auth).toEqual({ mode: 'service_account' });
  });

  it('invalid_grant marks the connection Error; import/export get the reconnect message; the cron continues with other links', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;
    const { id } = await connect('gone@example.com', 'rt-gone');
    const auth = { mode: 'oauth' as const, connectionId: id };
    addFakeSheet(SID, [{ title: 'Sheet1', rows: [['Name', 'Phone'], ['Asha', '9876543210']] }]);
    addFakeSheet(SID2, [{ title: 'Sheet1', rows: [] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1, auth, intervalMinutes: 5 });
    const xo = await inCo(() => SH.createSheetExport({ name: 'OAuth backup', spreadsheetUrl: URL2, tab: 'A', auth, intervalMinutes: 5 }, null));
    const xs = await inCo(() => SH.createSheetExport({ name: 'SA backup', spreadsheetUrl: URL2, tab: 'B', auth: { mode: 'service_account' }, intervalMinutes: 5 }, null));

    invalidRefresh.add('rt-gone');
    GC.resetGoogleOAuthTokenCache();
    tokenRequests = [];
    const b = await (await cronGET(new Request('https://crm.example.com/api/cron/sheets', { headers: { Authorization: 'Bearer cron-secret-123' } }))).json();
    expect(b.data.results.test.imports).toEqual([{ id: source.id, error: GC.RECONNECT_MSG }]);
    expect(b.data.results.test.exports).toEqual([{ id: xo.id, error: GC.RECONNECT_MSG }, { id: xs.id, rows: 0 }]);
    // only one refresh attempt: the second link sees the Error status without calling Google
    expect(tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token')).toHaveLength(1);

    const conn = (await inCo(() => SH.listGoogleConnections()))[0];
    expect(conn).toMatchObject({ id, status: 'Error', lastError: GC.RECONNECT_MSG, usedBy: 2 });
    const src = await inCo(async () => (await sourcesCol()).findOne({ _id: source.id }));
    expect(src!.config.sheet!.lastSyncResult).toBe('Error: ' + GC.RECONNECT_MSG);
    expect((await inCo(() => SH.listSheetExports())).find((x) => x.id === xo.id)!.lastError).toBe(GC.RECONNECT_MSG);
    const chk = await inCo(() => SH.checkSheet({ spreadsheetUrl: URL1, auth: { mode: 'service_account' } }));
    expect(chk.ok).toBe(true);
  });
});

describe('disconnect', () => {
  it('CONFLICT while used; force pauses the links, revokes the token and deletes the connection', async () => {
    const me = await signIn();
    const call = rpc(me.token);
    const { id } = await connect('owner@example.com', 'rt-owner');
    const auth = { mode: 'oauth' as const, connectionId: id };
    addFakeSheet(SID, [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    addFakeSheet(SID2, [{ title: 'Sheet1', rows: [] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1, auth });
    const x = await inCo(() => SH.createSheetExport({ name: 'Backup', spreadsheetUrl: URL2, auth }, null));

    const c1 = await call('disconnectGoogleConnection', { id });
    expect(c1.status).toBe(409);
    expect((c1.body as any).message).toMatch(/import "Sheet leads".*export "Backup"/);
    expect(revoked).toEqual([]);

    const c2 = await call('disconnectGoogleConnection', { id, force: true });
    expect(c2.status).toBe(200);
    expect(revoked).toEqual(['rt-owner']);
    expect(await inCo(() => SH.listGoogleConnections())).toEqual([]);
    expect((await inCo(() => LS.listLeadSources())).find((s) => s.id === source.id)!.status).toBe('Paused');
    expect((await inCo(() => SH.listSheetExports()))[0]).toMatchObject({ id: x.id, status: 'Paused' });
    // a resumed link says the connection was removed
    await expect(inCo(() => SH.runSheetExport({ id: x.id }, null))).rejects.toThrow(GC.REMOVED_MSG);
    expect((await call('disconnectGoogleConnection', { id })).status).toBe(404);

    // unused connection → deleted straight away
    const { id: id2 } = await connect('spare@example.com', 'rt-spare');
    expect((await call('disconnectGoogleConnection', { id: id2 })).status).toBe(200);
    expect(revoked).toEqual(['rt-owner', 'rt-spare']);
  });
});

describe('plan gate and console', () => {
  it('connection actions need googleSheets; googleStatus is not gated and reports the OAuth client', async () => {
    await connect('owner@example.com');
    await t.company('test', { googleSheets: false, websiteApi: true });
    const me = await signIn();
    const call = rpc(me.token);
    expect((await call('listGoogleConnections')).status).toBe(403);
    expect((await call('disconnectGoogleConnection', { id: 'GCN-0001' })).status).toBe(403);
    const g = await call('googleStatus');
    expect((g.body as any).data).toEqual({ configured: false, serviceAccountEmail: '', source: 'none', oauthConfigured: true, connectUrl: '/api/integrations/google/connect' });
    // RM cannot disconnect even with the feature
    await t.company('test', { googleSheets: true });
    const rm = await signIn('RM', 'rm@google.test');
    expect((await rpc(rm.token)('disconnectGoogleConnection', { id: 'GCN-0001' })).status).toBe(403);
  });

  it('companySheets lists connections (no tokens) and the auth of each import', async () => {
    const { id } = await connect('owner@example.com', 'RT-NEVER-SHOWN');
    addFakeSheet(SID, [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    await sheetSource({ spreadsheetUrl: URL1, auth: { mode: 'oauth', connectionId: id } });
    const pd = await superAdmin();
    const cs = await pd('companySheets', { companyId: 'CMP-test' });
    expect((cs.body as any).data.connections).toEqual([expect.objectContaining({ id, email: 'owner@example.com', status: 'Active', usedBy: 1 })]);
    expect((cs.body as any).data.imports[0].auth).toEqual({ mode: 'oauth', connectionId: id });
    expect(JSON.stringify(cs.body)).not.toContain('RT-NEVER-SHOWN');
    expect(JSON.stringify(cs.body)).not.toContain('refreshToken');
  });

  it('deleting a company revokes its Google connections', async () => {
    await connect('other@example.com', 'rt-other-co', 'CMP-other');
    const pd = await superAdmin();
    const del = await pd('deleteCompany', { id: 'CMP-other', confirmSlug: 'other' });
    expect(del.status).toBe(200);
    expect(revoked).toEqual(['rt-other-co']);
  });
});
