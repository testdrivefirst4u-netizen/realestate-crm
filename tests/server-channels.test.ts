/** LinkedIn (connect, lead forms), Pinterest (connect), Ads manager (campaigns, pause, budget, alerts), Marketing apps. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { encryptSecret } from '../server/core/settings';
import { createUser, login, type Ctx } from '../server/core/auth';
import { addLead, getAllLeads } from '../server/modules/leads';
import { mapLinkedInAnswers, saveLinkedIn, syncLinkedInLeads } from '../server/modules/linkedin';
import { getPinterest } from '../server/modules/pinterest';
import { checkAdAlerts, listAdCampaigns, saveAdAlerts, setCampaignBudget, setCampaignStatus } from '../server/modules/adsControl';
import { getMarketingApps, loadMarketingApps, setMarketingApps } from '../server/platform/marketingApps';
import { GET as liConnectGET } from '../app/api/integrations/linkedin/connect/route';
import { GET as pinConnectGET } from '../app/api/integrations/pinterest/connect/route';
import { GET as pinCallbackGET } from '../app/api/integrations/pinterest/callback/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: Array<{ host: string; path: string; method: string; body: any; headers: Record<string, string> }> = [];
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hits = (re: RegExp) => calls.filter((c) => re.test(`${c.method} ${c.host}${c.path}`));

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  const headers = init.headers || {};
  const ct = String(headers['Content-Type'] || headers['content-type'] || '');
  const body = method === 'GET' ? Object.fromEntries(url.searchParams) : ct.includes('json') ? JSON.parse(String(init.body || '{}')) : Object.fromEntries(new URLSearchParams(String(init.body || '')));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  calls.push({ host: url.host, path, method, body, headers });
  if (url.host === 'api.linkedin.com') {
    if (path === '/rest/leadFormResponses') return json(200, { elements: [{
      id: 'LR1', versionedLeadGenFormUrn: 'urn:li:versionedLeadGenForm:(urn:li:leadGenForm:900,1)',
      formResponse: { answers: [
        { questionId: 1, answerDetails: { textQuestionAnswer: { answer: 'Neha' } } }, { questionId: 2, answerDetails: { textQuestionAnswer: { answer: 'Rao' } } },
        { questionId: 3, answerDetails: { textQuestionAnswer: { answer: '+91 91234 07777' } } }, { questionId: 4, answerDetails: { textQuestionAnswer: { answer: 'Within 6 months' } } },
      ] },
    }] });
    if (path === '/rest/leadForms/900') return json(200, { content: { questions: [
      { questionId: 1, predefinedField: 'FIRST_NAME' }, { questionId: 2, predefinedField: 'LAST_NAME' }, { questionId: 3, predefinedField: 'PHONE_NUMBER' },
      { questionId: 4, question: { localized: { en_US: 'When do you plan to buy?' } } },
    ] } });
  }
  if (url.host === 'api.pinterest.com') {
    if (path === '/v5/oauth/token') return json(200, { access_token: 'PAT', refresh_token: 'PRT', expires_in: 2592000 });
    if (path === '/v5/user_account') return json(200, { username: 'amayahomes' });
    if (path === '/v5/boards') return json(200, { items: [{ id: 'B7', name: 'Amaya homes' }] });
  }
  if (url.host === 'graph.facebook.com') {
    if (path === '/act_1000/campaigns') return json(200, { data: [
      { id: '6001', name: 'Amaya Q4', status: 'ACTIVE', daily_budget: '150000', insights: { data: [{ spend: '9000.50' }] } },
      { id: '6002', name: 'Retargeting', status: 'ACTIVE', insights: { data: [{ spend: '4000' }] } },
      { id: '6003', name: 'Old', status: 'PAUSED' },
    ] });
    if (/^\/600\d$/.test(path) && method === 'POST') return json(200, { success: true });
  }
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  if (url.host === 'googleads.googleapis.com') {
    if (path.endsWith('googleAds:search')) return json(200, { results: [
      { campaign: { id: '77', name: 'Amaya Search', status: 'ENABLED' }, campaignBudget: { amountMicros: '2000000000', resourceName: 'customers/1234567890/campaignBudgets/5' }, metrics: { costMicros: '7000000000' } },
    ] });
    if (path.endsWith(':mutate')) return json(200, { results: [{}] });
  }
  return json(404, { error: { message: `unexpected ${method} ${url.host}${path}` } });
}

async function dev(): Promise<{ cookie: string; ctx: Ctx }> {
  await createUser({ name: 'Support', email: 'support@ch.test', password: 'long-enough-pw', role: 'Developer', mustChangePassword: false }, null);
  const r = await login('support@ch.test', 'long-enough-pw', { userAgent: 'vitest', ip: '10.6.6.6' });
  return { cookie: `amaya_session=CMP-test.${r.token}`, ctx: { user: r.user } as unknown as Ctx };
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'APP_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'PINTEREST_APP_ID', 'PINTEREST_APP_SECRET']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { linkedin: true, pinterest: true, adsControl: true });
  Object.assign(process.env, {
    META_APP_ID: '1234567890', META_APP_SECRET: 'abcdef0123456789abcdef0123456789', APP_URL: 'https://crm.example.com',
    GOOGLE_OAUTH_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'secret-123', GOOGLE_ADS_DEVELOPER_TOKEN: 'DEVTOKEN-1234567890ab',
    LINKEDIN_CLIENT_ID: 'li12345678', LINKEDIN_CLIENT_SECRET: 'li-secret-123', PINTEREST_APP_ID: '1500000', PINTEREST_APP_SECRET: 'pin-secret-123',
  });
  calls = [];
  vi.stubGlobal('fetch', vi.fn(fake));
});
afterEach(() => vi.unstubAllGlobals());

describe('LinkedIn', () => {
  it('asks for the lead scopes only when asked; Lead Gen Form answers become a lead once', async () => {
    const me = await dev();
    const plain = new URL((await liConnectGET(new Request('https://crm.example.com/api/integrations/linkedin/connect', { headers: { cookie: me.cookie } }))).headers.get('location')!);
    expect(plain.origin + plain.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(plain.searchParams.get('scope')).toBe('r_organization_admin w_organization_social r_organization_social');
    expect(plain.searchParams.get('redirect_uri')).toBe('https://crm.example.com/api/integrations/linkedin/callback');
    const leads = new URL((await liConnectGET(new Request('https://crm.example.com/api/integrations/linkedin/connect?leads=1', { headers: { cookie: me.cookie } }))).headers.get('location')!);
    expect(leads.searchParams.get('scope')).toContain('r_marketing_leadgen_automation');

    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'linkedin', token: encryptSecret('LIT'), refresh: '', expiresAt: null, scopes: ['r_marketing_leadgen_automation'], orgs: [], orgUrn: '', adAccounts: [{ urn: 'urn:li:sponsoredAccount:55', name: 'Amaya ads' }], leadAccount: '' }));
    await expect(inCo(() => saveLinkedIn({ leadAccount: 'urn:li:sponsoredAccount:99' }, me.ctx))).rejects.toThrow(/Choose one/);
    await inCo(() => saveLinkedIn({ leadAccount: 'urn:li:sponsoredAccount:55' }, me.ctx));
    expect(await inCo(() => syncLinkedInLeads())).toEqual({ received: 1, created: 1 });
    expect(await inCo(() => syncLinkedInLeads())).toEqual({ received: 1, created: 0 });
    const req = hits(/api\.linkedin\.com\/rest\/leadFormResponses/)[0];
    expect(req.headers['LinkedIn-Version']).toMatch(/^20\d{4}$/);
    const [lead] = (await inCo(() => getAllLeads(null))).leads;
    expect(lead).toMatchObject({ 'Prospect Name': 'Neha Rao', 'Enquiry Source': 'LinkedIn', 'Form: When do you plan to buy?': 'Within 6 months' });
    expect(mapLinkedInAnswers([{ questionId: 9, answerDetails: { multipleChoiceAnswer: { options: ['2 BHK', '3 BHK'] } } }], [])).toEqual({ 'Question 9': '2 BHK, 3 BHK' });
  });
});

describe('Pinterest', () => {
  it('connects with the app keys (Basic auth) and keeps the only board', async () => {
    const me = await dev();
    const start = await pinConnectGET(new Request('https://crm.example.com/api/integrations/pinterest/connect', { headers: { cookie: me.cookie } }));
    const dialog = new URL(start.headers.get('location')!);
    expect(dialog.searchParams.get('scope')).toBe('boards:read,pins:read,pins:write,user_accounts:read');
    const nonce = (start.headers.get('set-cookie') || '').match(/social_oauth_nonce=([0-9a-f]+)/)![1];
    const back = new URL((await pinCallbackGET(new Request(`https://crm.example.com/api/integrations/pinterest/callback?code=c1&state=${encodeURIComponent(dialog.searchParams.get('state')!)}`, { headers: { cookie: `${me.cookie}; social_oauth_nonce=${nonce}` } }))).headers.get('location')!);
    expect(Object.fromEntries(back.searchParams)).toEqual({ section: 'social', pinterestConnected: 'amayahomes' });
    expect(hits(/POST api\.pinterest\.com\/v5\/oauth\/token/)[0].headers.Authorization).toBe('Basic ' + Buffer.from('1500000:pin-secret-123').toString('base64'));
    expect(await inCo(() => getPinterest())).toMatchObject({ connected: true, username: 'amayahomes', boardId: 'B7' });
  });
});

describe('Ads manager', () => {
  async function connectBoth() {
    await inCo(async () => {
      const c = await col<any>(CFG.COLL.INTEGRATIONS);
      await c.insertOne({ _id: 'metaCapi', enabled: false, datasetId: '1', token: encryptSecret('MT'), testCode: '', rules: [], connectedVia: 'facebook', adAccounts: [{ id: 'act_1000', name: 'Amaya Ads', currency: 'INR' }] });
      await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '', connectedBy: 'x', connectedAt: new Date() });
      await c.insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'a@b.c', scopes: [], adsCustomerId: '1234567890', adsCustomers: [{ id: '1234567890', name: 'Amaya Google', currency: 'INR', manager: false }] });
      for (const name of ['Amaya Q4', 'Amaya Q4', 'Amaya Search']) await addLead({ 'Prospect Name': 'X', 'Phone Number': '9123406' + String(Math.floor(Math.random() * 900) + 100), Campaign: name } as any, null);
    });
  }

  it('lists both platforms with 7-day spend and CRM leads; pause / budget go to the platform and the audit log', async () => {
    const me = await dev();
    await connectBoth();
    const r = await inCo(() => listAdCampaigns());
    expect(r.errors).toEqual({});
    expect(r.campaigns.map((c) => `${c.platform}:${c.name}:${c.status}:${c.dailyBudget}:${c.spend7}:${c.leads7}`)).toEqual([
      'meta:Amaya Q4:ACTIVE:1500:9000.5:2', 'google:Amaya Search:ACTIVE:2000:7000:1', 'meta:Retargeting:ACTIVE:null:4000:0', 'meta:Old:PAUSED:null:0:0',
    ]);
    const q4 = r.campaigns[0], search = r.campaigns[1], retarget = r.campaigns[2];
    await inCo(() => setCampaignStatus({ platform: 'meta', id: q4.id, status: 'PAUSED', name: q4.name }, me.ctx));
    expect(hits(/POST graph\.facebook\.com\/6001/)[0].body).toMatchObject({ status: 'PAUSED' });
    await inCo(() => setCampaignStatus({ platform: 'google', id: search.id, status: 'PAUSED' }, me.ctx));
    expect(hits(/campaigns:mutate/)[0].body).toEqual({ operations: [{ update: { resourceName: 'customers/1234567890/campaigns/77', status: 'PAUSED' }, updateMask: 'status' }] });
    await inCo(() => setCampaignBudget({ platform: 'meta', id: q4.id, daily: 2000 }, me.ctx));
    expect(hits(/POST graph\.facebook\.com\/6001/)[1].body).toMatchObject({ daily_budget: '200000' });
    await inCo(() => setCampaignBudget({ platform: 'google', id: search.id, budgetRef: search.budgetRef, daily: 2500 }, me.ctx));
    expect(hits(/campaignBudgets:mutate/)[0].body.operations[0].update).toEqual({ resourceName: 'customers/1234567890/campaignBudgets/5', amountMicros: '2500000000' });
    await expect(inCo(() => setCampaignBudget({ platform: 'meta', id: retarget.id, daily: 50 }, me.ctx))).rejects.toThrow(/₹100/);
    const audit = await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).find({ entityType: 'Campaign' }).toArray());
    expect(audit.map((a) => a.action).sort()).toEqual(['Campaign Budget Changed', 'Campaign Budget Changed', 'Campaign Paused', 'Campaign Paused']);
  });

  it('alerts once a week for a running campaign spending without leads', async () => {
    const me = await dev();
    await connectBoth();
    await inCo(() => saveAdAlerts({ enabled: true, minSpend: 3000 }, me.ctx));
    expect(await inCo(() => checkAdAlerts())).toBe(1); // Retargeting: ₹4000, no lead
    expect(await inCo(() => checkAdAlerts())).toBe(0);
    expect(await inCo(() => checkAdAlerts(new Date(Date.now() + 8 * 86400e3)))).toBe(1);
    await expect(inCo(() => saveAdAlerts({ minSpend: 10 }, me.ctx))).rejects.toThrow(/₹500/);
  });
});

describe('Marketing apps (platform)', () => {
  it('stores secrets encrypted, never returns them, validates the formats', async () => {
    const ctx = { user: { id: 'SA-1', name: 'Root', email: 'root@x.y' } } as any;
    for (const k of ['GOOGLE_ADS_DEVELOPER_TOKEN', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'PINTEREST_APP_ID', 'PINTEREST_APP_SECRET']) delete process.env[k];
    await expect(setMarketingApps({ googleAdsLoginCustomerId: '12' }, ctx)).rejects.toThrow(/10 digits/);
    const v = await setMarketingApps({ googleAdsDeveloperToken: 'AbCdEfGhIjKlMnOpQrStUv', googleAdsLoginCustomerId: '123-456-7890', linkedinClientId: '86abcdefgh', linkedinClientSecret: 'WPL_AP1.secret.xyz', pinterestAppId: '1500000', pinterestAppSecret: 'pinsecret123' }, ctx);
    expect(v).toMatchObject({ googleAds: { tokenSet: true, loginCustomerId: '1234567890' }, linkedin: { clientId: '86abcdefgh', secretSet: true }, pinterest: { appId: '1500000', secretSet: true } });
    expect(JSON.stringify(await getMarketingApps())).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
    expect((await loadMarketingApps()).linkedinClientSecret).toBe('WPL_AP1.secret.xyz');
  });
});
