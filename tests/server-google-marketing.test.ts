/** Settings › Google: connect (shared callback), lead results to Google Ads + GA4, Google Ads spend, Business Profile. */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { createUser, login, type Ctx } from '../server/core/auth';
import { addLead, updateLead } from '../server/modules/leads';
import { inboundCol } from '../server/modules/intake';
import { getCampaignSpend } from '../server/modules/salesOps';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { e164, ga4EventName, getGoogleMarketing, googleCampaignName, saveGoogleMarketing, syncGoogleSpend } from '../server/modules/googleMarketing';
import { GET as connectGET } from '../app/api/integrations/google/marketing/connect/route';
import { GET as callbackGET } from '../app/api/integrations/google/callback/route';

const ACTION = 'customers/1234567890/conversionActions/55';
let t: Awaited<ReturnType<typeof startTestDb>>;
let uploads: any[] = [];
let ga4: any[] = [];
let failUpload = '';
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const idToken = (email: string) => ['e30', Buffer.from(JSON.stringify({ email })).toString('base64url'), 'sig'].join('.');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function fakeGoogle(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const body = init.body ? (String(init.headers?.['Content-Type'] || init.headers?.['content-type'] || '').includes('json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)))) : {};
  if (url.host === 'oauth2.googleapis.com') {
    if (body.grant_type === 'authorization_code') return json(200, { access_token: 'AT1', refresh_token: 'RT-1', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/business.manage', id_token: idToken('Ads@Amaya.test') });
    if (body.grant_type === 'refresh_token') return json(200, { access_token: 'AT2', expires_in: 3600 });
  }
  if (url.host === 'googleads.googleapis.com') {
    expect(init.headers['developer-token']).toBe('DEVTOKEN-1234567890ab');
    if (url.pathname.endsWith('customers:listAccessibleCustomers')) return json(200, { resourceNames: ['customers/1234567890', 'customers/9999999999'] });
    if (url.pathname.endsWith(':uploadClickConversions')) {
      uploads.push(body);
      return json(200, failUpload ? { partialFailureError: { message: failUpload } } : { results: [{}] });
    }
    if (url.pathname.endsWith('googleAds:search')) {
      const q = String(body.query);
      if (q.includes('FROM customer')) return json(200, { results: [url.pathname.includes('9999999999') ? { customer: { id: '9999999999', descriptiveName: 'Agency MCC', manager: true } } : { customer: { id: '1234567890', descriptiveName: 'Amaya Ads', currencyCode: 'INR', manager: false } }] });
      if (q.includes('FROM conversion_action')) return json(200, { results: [{ conversionAction: { resourceName: ACTION, name: 'CRM qualified lead', type: 'UPLOAD_CLICKS' } }] });
      if (q.includes('FROM campaign')) return json(200, { results: [
        { campaign: { id: '77', name: 'Amaya Search' }, segments: { month: '2026-11-01' }, metrics: { costMicros: '15000500000' } },
        { campaign: { id: '77', name: 'Amaya Search' }, segments: { month: '2026-10-01' }, metrics: { costMicros: '20000000000' } },
      ] });
    }
  }
  if (url.host === 'mybusinessaccountmanagement.googleapis.com') return json(200, { accounts: [{ name: 'accounts/1' }] });
  if (url.host === 'mybusinessbusinessinformation.googleapis.com') return json(200, { locations: [{ name: 'locations/9', title: 'Amaya Experience Centre' }] });
  if (url.host === 'www.google-analytics.com') {
    ga4.push({ q: Object.fromEntries(url.searchParams), body });
    return new Response(null, { status: 204 });
  }
  return json(404, { error: { message: 'unexpected ' + url.toString() } });
}

async function signIn(): Promise<{ cookie: string; ctx: Ctx }> {
  await createUser({ name: 'Support', email: 'support@google.test', password: 'long-enough-pw', role: 'Developer', mustChangePassword: false }, null);
  const r = await login('support@google.test', 'long-enough-pw', { userAgent: 'vitest', ip: '10.4.4.4' });
  return { cookie: `amaya_session=CMP-test.${r.token}`, ctx: { user: r.user } as unknown as Ctx };
}
async function connect(cookie: string) {
  const start = await connectGET(new Request('https://crm.example.com/api/integrations/google/marketing/connect', { headers: { cookie } }));
  const dialog = new URL(start.headers.get('location')!);
  const nonce = (start.headers.get('set-cookie') || '').match(/google_oauth_nonce=([0-9a-f]+)/)?.[1] || '';
  const back = new URL((await callbackGET(new Request(`https://crm.example.com/api/integrations/google/callback?code=c1&state=${encodeURIComponent(dialog.searchParams.get('state')!)}`, { headers: { cookie: `${cookie}; google_oauth_nonce=${nonce}` } }))).headers.get('location')!);
  return { dialog, back };
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'APP_URL', 'GOOGLE_ADS_DEVELOPER_TOKEN']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { googleConversions: true, googleAdsSpend: true, socialInbox: true });
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-123';
  process.env.APP_URL = 'https://crm.example.com';
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'DEVTOKEN-1234567890ab';
  resetGoogleOAuthTokenCache();
  uploads = [];
  ga4 = [];
  failUpload = '';
  vi.stubGlobal('fetch', vi.fn(fakeGoogle));
});
afterEach(() => vi.unstubAllGlobals());

describe('Google marketing', () => {
  it('connects on the shared callback, finds the ad account and the Business Profile location', async () => {
    const me = await signIn();
    const { dialog, back } = await connect(me.cookie);
    expect(dialog.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/adwords');
    expect(dialog.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/business.manage');
    expect(dialog.searchParams.get('redirect_uri')).toBe('https://crm.example.com/api/integrations/google/callback');
    expect(Object.fromEntries(back.searchParams)).toEqual({ section: 'google', gmktConnected: '1' });
    const v = await inCo(() => getGoogleMarketing());
    expect(v).toMatchObject({ connected: true, email: 'ads@amaya.test', adsAccess: true, businessAccess: true, adsCustomerId: '1234567890', gbpLocation: { title: 'Amaya Experience Centre' }, setupError: '' });
    expect(v.adsCustomers.map((c) => c.manager)).toEqual([false, true]);
    expect(JSON.stringify(await inCo(async () => (await col<any>('googleConnections')).find({}).toArray()))).not.toContain('RT-1');
  });

  it('lead results: Google Ads with gclid and hashed contact, GA4 with the visitor id; each once; unmapped events skip Google Ads', async () => {
    const me = await signIn();
    await connect(me.cookie);
    await inCo(() => saveGoogleMarketing({ adsConversions: { enabled: true, actions: { Qualified: ACTION } }, ga4: { enabled: true, measurementId: 'g-abc123xyz', apiSecret: 'SeCrEt_1234567' } }, me.ctx));
    const id = await inCo(async () => (await addLead({ 'Prospect Name': 'Ravi', 'Phone Number': '98765 01234', Email: 'Ra.vi@Gmail.com' } as any, null)).id);
    await inCo(async () => (await inboundCol()).insertOne({ _id: 'INB_g', sourceId: 'SRC-0001', receivedAt: new Date(), status: 'created', leadId: id, message: '', payload: { _gclid: 'Cj0KCQ-click', _ga: 'GA1.1.111.222' }, ip: '', origin: '' }));
    await inCo(() => updateLead(id, { 'Lead Stage': 'Qualified' } as any, null));
    await vi.waitFor(() => expect(uploads.length + ga4.length).toBe(2));
    const conv = uploads[0].conversions[0];
    expect(conv).toMatchObject({ conversionAction: ACTION, gclid: 'Cj0KCQ-click', userIdentifiers: [{ hashedEmail: sha('ravi@gmail.com') }, { hashedPhoneNumber: sha('+919876501234') }] });
    expect(conv.conversionDateTime).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+05:30$/);
    expect(ga4[0]).toMatchObject({ q: { measurement_id: 'G-ABC123XYZ', api_secret: 'SeCrEt_1234567' }, body: { client_id: '111.222', events: [{ name: 'qualified' }] } });
    await inCo(() => updateLead(id, { 'Site Visit Status': 'Site Visit - Completed' } as any, null));
    await vi.waitFor(() => expect(ga4).toHaveLength(2));
    expect(uploads).toHaveLength(1); // Site Visit Done has no Google Ads action
    const q = await inCo(async () => (await col<any>(CFG.COLL.CONVERSIONS)).find({}).sort({ _id: 1 }).toArray());
    expect(q.map((x) => `${x._id}:${x.status}`)).toEqual([`ga4:${id}:Qualified:sent`, `ga4:${id}:Site Visit Done:sent`, `google_ads:${id}:Qualified:sent`]);
  });

  it('a refused upload is kept with Google’s reason and retried; switched off sends nothing', async () => {
    const me = await signIn();
    await connect(me.cookie);
    await inCo(() => saveGoogleMarketing({ adsConversions: { enabled: true, actions: { Booked: ACTION } } }, me.ctx));
    failUpload = 'The click is too old';
    const id = await inCo(async () => (await addLead({ 'Prospect Name': 'Asha', 'Phone Number': '91234 01234' } as any, null)).id);
    await inCo(() => updateLead(id, { 'Lead Stage': 'Booked', 'Booking Date': '2026-11-01' } as any, null));
    await vi.waitFor(async () => expect((await inCo(async () => (await col<any>(CFG.COLL.CONVERSIONS)).findOne({}))).status).toBe('failed'));
    expect((await inCo(async () => (await col<any>(CFG.COLL.CONVERSIONS)).findOne({}))).error).toMatch(/too old/);
    await t.company('test', { googleConversions: false });
    const id2 = await inCo(async () => (await addLead({ 'Prospect Name': 'Kiran', 'Phone Number': '91234 05555' } as any, null)).id);
    await inCo(() => updateLead(id2, { 'Lead Stage': 'Booked', 'Booking Date': '2026-11-01' } as any, null));
    expect(await inCo(async () => (await col<any>(CFG.COLL.CONVERSIONS)).countDocuments({ leadId: id2 }))).toBe(0);
  });

  it('Google Ads spend fills Sales MIS (source google) and names Google lead form campaigns', async () => {
    const me = await signIn();
    await connect(me.cookie);
    const r = await inCo(() => syncGoogleSpend({ now: new Date('2026-11-02T06:00:00Z') }));
    expect(r).toEqual({ campaigns: 2, months: { '2026-10': 20000, '2026-11': 15000.5 } });
    const rows = (await inCo(() => getCampaignSpend())).rows;
    expect(rows).toEqual(expect.arrayContaining([{ campaign: 'Amaya Search', month: '2026-11', amount: 15000.5, source: 'google' }, { campaign: 'Amaya Search', month: '2026-10', amount: 20000, source: 'google' }]));
    expect(await inCo(() => googleCampaignName('77'))).toBe('Amaya Search');
  });

  it('validates the settings; formats for Google', async () => {
    const me = await signIn();
    await connect(me.cookie);
    await expect(inCo(() => saveGoogleMarketing({ adsCustomerId: '5555555555' }, me.ctx))).rejects.toThrow(/Choose one of the Google Ads accounts/);
    await expect(inCo(() => saveGoogleMarketing({ ga4: { enabled: true, measurementId: 'UA-1' } }, me.ctx))).rejects.toThrow(/G-ABC123XYZ/);
    await expect(inCo(() => saveGoogleMarketing({ adsConversions: { enabled: true, actions: { Qualified: 'nope' } } }, me.ctx))).rejects.toThrow(/conversion action/);
    expect(e164('09876501234')).toBe('+919876501234');
    expect(ga4EventName('Site Visit Done')).toBe('site_visit_done');
    expect(ga4EventName('3 BHK booked')).toBe('e_3_bhk_booked');
  });
});
