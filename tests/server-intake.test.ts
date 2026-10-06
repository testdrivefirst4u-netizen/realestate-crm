/**
 * Lead sources: key handling, the public intake endpoint (POST /api/inbound/leads), field recognition,
 * duplicates, round robin, honeypot, idempotency, CORS, rate limits, rotation, tenant isolation,
 * retry of failed submissions and the super-admin actions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { getClient, PLATFORM_DB } from '../server/core/db';
import { runWithTenant, type Tenant } from '../server/core/tenant';
import { DEFAULT_FEATURES, getTenantById, invalidateTenant } from '../server/platform/registry';
import { sha256Hex } from '../server/core/utils';
import { CFG } from '../server/core/config';
import * as LS from '../server/modules/leadSources';
import { inboundCol, ingestLead, mapFields, sourcesCol } from '../server/modules/intake';
import * as leadsModule from '../server/modules/leads';
import { dispatch } from '../server/router';
import { platformDispatch } from '../server/platform/router';
import { OPTIONS, POST } from '../app/api/inbound/leads/route';
import type { LeadSourceConfig, LeadSourceType } from '../server/core/leadSourceTypes';

let t: Awaited<ReturnType<typeof startTestDb>>;
const OTHER_DB = 'amaya_test_other';
const URL_ = 'https://crm.example.com/api/inbound/leads';

async function tenant(id = 'CMP-test'): Promise<Tenant> {
  invalidateTenant();
  return (await getTenantById(id))!;
}
const inCo = async <T>(fn: () => Promise<T>, id = 'CMP-test') => runWithTenant(await tenant(id), fn);

async function newSource(type: LeadSourceType = 'website', config: Partial<LeadSourceConfig> = {}, name = 'Main website', companyId = 'CMP-test') {
  return inCo(() => LS.createLeadSource({ name, type, config }, null), companyId);
}

function post(body: unknown, opts: { key?: string; headers?: Record<string, string>; form?: boolean; query?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.key) headers['X-Api-Key'] = opts.key;
  let payload: string;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body as Record<string, string>).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return POST(new Request(URL_ + (opts.query || ''), { method: 'POST', headers, body: payload }));
}

const leadsIn = async (id = 'CMP-test') => inCo(async () => (await leadsModule.getAllLeads(null)).leads, id);
const logIn = async (id = 'CMP-test') => inCo(() => LS.listInboundLog({}), id);

async function registerOther(features: Partial<typeof DEFAULT_FEATURES> = {}) {
  const client = (await getClient())!;
  await client.db(PLATFORM_DB()).collection('companies').updateOne(
    { _id: 'CMP-other' as any },
    { $set: { slug: 'other', name: 'Other Co', dbName: OTHER_DB, status: 'Active', plan: 'Test', maxUsers: 0, features: { ...DEFAULT_FEATURES, ...features }, logo: '', tagline: '', createdAt: new Date(), updatedAt: new Date() } },
    { upsert: true }
  );
  invalidateTenant();
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await (await getClient())!.db(OTHER_DB).dropDatabase();
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  const other = (await getClient())!.db(OTHER_DB);
  await Promise.all((await other.collections()).map((c) => c.deleteMany({})));
  await t.company('test', { websiteApi: true });
});

describe('lead source management', () => {
  it('returns the key once and stores only its hash (in the platform DB)', async () => {
    const { source, apiKey } = await newSource();
    expect(apiKey).toMatch(/^crm_live_[0-9a-f]{48}$/);
    expect(source).toMatchObject({ id: 'SRC-0001', type: 'website', status: 'Active', keyPrefix: apiKey.slice(0, 12) });
    expect(source.config).toMatchObject({ sourceLabel: 'Website', defaultStage: 'New', duplicates: 'remark', assignment: { mode: 'unassigned' } });
    const client = (await getClient())!;
    const keyDoc = await client.db(PLATFORM_DB()).collection('apiKeys').findOne({ sourceId: 'SRC-0001' });
    expect(keyDoc).toMatchObject({ _id: sha256Hex(apiKey), companyId: 'CMP-test' });
    const raw = await inCo(async () => (await sourcesCol()).findOne({ _id: 'SRC-0001' }));
    expect(JSON.stringify(raw)).not.toContain(apiKey);
    expect(JSON.stringify(await inCo(() => LS.listLeadSources()))).not.toContain(apiKey);
  });

  it('validates the config', async () => {
    await expect(newSource('website', { allowedOrigins: ['https://x.com/path'] })).rejects.toThrow(/origin/);
    await expect(newSource('website', { assignment: { mode: 'fixed', rm: 'Nobody', rms: [] } })).rejects.toThrow(/not a user/);
    await expect(newSource('website', { fieldMap: { foo: 'Not A Field' } })).rejects.toThrow(/not a lead field/);
    await expect(newSource('website', {}, '')).rejects.toThrow(/1–80/);
    const ok = await newSource('webhook', { allowedOrigins: ['https://www.Example.com/'], fieldMap: { city: 'Enquiry Notes' } });
    expect(ok.source.config.allowedOrigins).toEqual(['https://www.example.com']);
    expect(ok.source.config.sourceLabel).toBe('Webhook');
  });

  it('company actions are gated by the websiteApi plan feature', async () => {
    await t.company('test', { websiteApi: false });
    const r = await dispatch('listLeadSources', {}, { token: '', userAgent: 'vitest', ip: '1.1.1.1', companyId: 'CMP-test' });
    expect(r.status).toBe(403);
    expect((r.body as any).message).toMatch(/Website forms/);
  });
});

describe('POST /api/inbound/leads', () => {
  it('creates a lead from JSON (Bearer key) and from a urlencoded form (_key field)', async () => {
    const { apiKey } = await newSource();
    const r1 = await post({ name: 'Asha Rao', phone: '+91 98765 43210', email: 'Asha@Example.com', message: 'Call me' }, { headers: { Authorization: 'Bearer ' + apiKey } });
    expect(r1.status).toBe(201);
    const b1 = await r1.json();
    expect(b1).toEqual({ status: 'success', data: { leadId: 'ENQ-0001', duplicate: false } });
    const r2 = await post({ _key: apiKey, 'your-name': 'Vikram', 'your-phone': '9123456780' }, { form: true });
    expect(r2.status).toBe(201);
    const leads = await leadsIn();
    expect(leads).toHaveLength(2);
    const a = leads.find((l) => l['Enquiry ID'] === 'ENQ-0001')!;
    expect(a).toMatchObject({ 'Prospect Name': 'Asha Rao', 'Phone Number': '+91 98765 43210', Email: 'asha@example.com', 'Lead Stage': 'New', 'Enquiry Source': 'Website', 'Enquiry Notes': 'Call me' });
    expect(leads.find((l) => l['Prospect Name'] === 'Vikram')!['Phone Number']).toBe('9123456780');
    const log = await logIn();
    expect(log.map((e) => e.status)).toEqual(['created', 'created']);
    expect(JSON.stringify(log)).not.toContain(apiKey);
    const [src] = await inCo(() => LS.listLeadSources());
    expect(src.stats).toMatchObject({ received: 2, created: 2 });
    expect(src.stats.lastReceivedAt).not.toBe('');
  });

  it('answers 401 for a missing or unknown key', async () => {
    await newSource();
    expect((await post({ name: 'x', phone: '9876543210' })).status).toBe(401);
    expect((await post({ name: 'x', phone: '9876543210' }, { key: 'crm_live_' + 'a'.repeat(48) })).status).toBe(401);
    const r = await post({ name: 'x', phone: '9876543210' }, { key: 'garbage' });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ status: 'error', code: 'AUTH_REQUIRED' });
  });

  it('answers 403 for a paused source and for a plan without websiteApi', async () => {
    const { source, apiKey } = await newSource();
    await inCo(() => LS.updateLeadSource({ id: source.id, patch: { status: 'Paused' } }, null));
    expect((await post({ name: 'x', phone: '9876543210' }, { key: apiKey })).status).toBe(403);
    await inCo(() => LS.updateLeadSource({ id: source.id, patch: { status: 'Active' } }, null));
    expect((await post({ name: 'x', phone: '9876543210' }, { key: apiKey })).status).toBe(201);
    await t.company('test', { websiteApi: false });
    const r = await post({ name: 'y', phone: '9876543211' }, { key: apiKey });
    expect(r.status).toBe(403);
    expect((await r.json()).message).toMatch(/plan/);
    expect(await leadsIn()).toHaveLength(1);
  });

  it('recognises common field names and appends unknown / tracking fields to the notes', async () => {
    const { apiKey } = await newSource('website', { fieldMap: { project_choice: 'Purchase or Rent', secret_field: '_ignore' }, sourceLabel: 'Landing page', defaultStage: 'Open' });
    const r = await post({
      First_Name: 'Meera', 'Last Name': 'Iyer', Mobile: '98450 12345', 'E-mail': 'meera@x.in', Comments: 'Need a 2 BHK', BHK: '2 bhk',
      project_choice: 'Purchase', budget: '1.2 Cr', utm_source: 'google', gclid: 'abc', page_url: 'https://site/x', secret_field: 'hide me', _internal: 'skip',
      'Lead Stage': 'Booked', 'Assigned RM': 'Hacker',
    }, { key: apiKey });
    expect(r.status).toBe(201);
    const [lead] = await leadsIn();
    expect(lead).toMatchObject({ 'Prospect Name': 'Meera Iyer', 'Phone Number': '98450 12345', Email: 'meera@x.in', 'Unit Type Interested In': '2 BHK', 'Purchase or Rent': 'Purchase', 'Lead Stage': 'Open', 'Enquiry Source': 'Landing page', 'Assigned RM': '' });
    const notes = lead['Enquiry Notes'];
    expect(notes.split('\n')[0]).toBe('Need a 2 BHK');
    expect(notes).toContain('budget: 1.2 Cr');
    expect(notes).toContain('utm_source: google');
    expect(notes).toContain('gclid: abc');
    expect(notes).toContain('page_url: https://site/x');
    expect(notes).not.toContain('hide me');
    expect(notes).not.toContain('_internal');
  });

  it('names a nameless enquiry, rejects one without valid contact details', async () => {
    const { apiKey } = await newSource();
    expect((await post({ email: 'only@mail.com' }, { key: apiKey })).status).toBe(201);
    const bad = await post({ name: 'No Contact', phone: '12' }, { key: apiKey });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ status: 'error', code: 'VALIDATION' });
    const leads = await leadsIn();
    expect(leads).toHaveLength(1);
    expect(leads[0]['Prospect Name']).toBe('Website enquiry only@mail.com');
    const log = await logIn();
    expect(log[0]).toMatchObject({ status: 'rejected', leadId: '' });
  });

  it("duplicate 'remark' adds a follow-up to the existing lead and creates nothing", async () => {
    const { apiKey } = await newSource();
    await post({ name: 'Ravi', phone: '9876543210' }, { key: apiKey });
    const r = await post({ name: 'Ravi K', phone: '+91-98765-43210', message: 'Still interested' }, { key: apiKey });
    expect(r.status).toBe(201);
    expect((await r.json()).data).toEqual({ leadId: 'ENQ-0001', duplicate: true });
    // by e-mail too
    await post({ name: 'Em', email: 'em@x.com' }, { key: apiKey });
    const r3 = await post({ email: 'EM@x.com' }, { key: apiKey });
    expect((await r3.json()).data).toEqual({ leadId: 'ENQ-0002', duplicate: true });
    const leads = await leadsIn();
    expect(leads).toHaveLength(2);
    const ravi = leads.find((l) => l['Enquiry ID'] === 'ENQ-0001')!;
    expect(ravi['Follow-up 1']).toContain('New enquiry via Main website: Still interested');
    const em = leads.find((l) => l['Enquiry ID'] === 'ENQ-0002')!;
    expect(em['Follow-up 1']).toContain('form submitted');
    const events = await inCo(async () => (await (await import('../server/core/db')).col(CFG.COLL.EVENTS)).find({ type: 'lead_reenquiry' }).toArray());
    expect(events.map((e) => e.recordId).sort()).toEqual(['ENQ-0001', 'ENQ-0002']);
    const [src] = await inCo(() => LS.listLeadSources());
    expect(src.stats).toMatchObject({ received: 4, created: 2, duplicates: 2 });
  });

  it("duplicate 'skip' and 'create' modes", async () => {
    const skip = await newSource('webhook', { duplicates: 'skip' }, 'Skipper');
    const create = await newSource('webhook', { duplicates: 'create' }, 'Creator');
    await post({ name: 'A', phone: '9000000001' }, { key: skip.apiKey });
    const s = await post({ name: 'A', phone: '9000000001' }, { key: skip.apiKey });
    expect((await s.json()).data).toEqual({ leadId: 'ENQ-0001', duplicate: true });
    const c = await post({ name: 'A', phone: '9000000001' }, { key: create.apiKey });
    expect((await c.json()).data).toEqual({ leadId: 'ENQ-0002', duplicate: false });
    const leads = await leadsIn();
    expect(leads).toHaveLength(2);
    expect(leads.find((l) => l['Enquiry ID'] === 'ENQ-0001')!['Follow-up 1'] || '').toBe('');
    expect(leads.find((l) => l['Enquiry ID'] === 'ENQ-0002')!['Enquiry Source']).toBe('Webhook');
  });

  it('round robin alternates between active RMs; fixed assigns one RM', async () => {
    await t.ctx('RM', 'Rina');
    await t.ctx('RM', 'Sam');
    const rr = await newSource('website', { assignment: { mode: 'round_robin', rm: '', rms: ['Rina', 'Sam'] } });
    for (let i = 0; i < 4; i++) expect((await post({ name: 'L' + i, phone: '90000000' + (10 + i) }, { key: rr.apiKey })).status).toBe(201);
    const leads = (await leadsIn()).sort((a, b) => a['Enquiry ID'].localeCompare(b['Enquiry ID']));
    expect(leads.map((l) => l['Assigned RM'])).toEqual(['Rina', 'Sam', 'Rina', 'Sam']);
    const fixed = await newSource('website', { assignment: { mode: 'fixed', rm: 'Sam', rms: [] } }, 'Fixed');
    const r = await post({ name: 'F', phone: '9111111111' }, { key: fixed.apiKey });
    const id = (await r.json()).data.leadId;
    expect((await leadsIn()).find((l) => l['Enquiry ID'] === id)!['Assigned RM']).toBe('Sam');
  });

  it('honeypot: success-looking answer, no lead, logged as spam', async () => {
    const { apiKey } = await newSource();
    const r = await post({ name: 'Bot', phone: '9876543210', _gotcha: 'http://spam' }, { key: apiKey });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ status: 'success', data: { leadId: '', duplicate: false } });
    expect(await leadsIn()).toHaveLength(0);
    const [entry] = await logIn();
    expect(entry).toMatchObject({ status: 'rejected', message: 'spam (honeypot)' });
    expect(entry.payload._gotcha).toBeUndefined();
  });

  it('an idempotency key creates exactly one lead', async () => {
    const { apiKey } = await newSource();
    const a = await post({ name: 'Once', phone: '9876500000' }, { key: apiKey, headers: { 'Idempotency-Key': 'sub-1' } });
    const b = await post({ name: 'Once', phone: '9876500000' }, { key: apiKey, headers: { 'Idempotency-Key': 'sub-1' } });
    const c = await post({ name: 'Once', phone: '9876500000', _submission_id: 'sub-1' }, { key: apiKey });
    expect((await a.json()).data).toEqual({ leadId: 'ENQ-0001', duplicate: false });
    expect((await b.json()).data).toEqual({ leadId: 'ENQ-0001', duplicate: false });
    expect((await c.json()).data).toEqual({ leadId: 'ENQ-0001', duplicate: false });
    expect(await leadsIn()).toHaveLength(1);
    expect(await logIn()).toHaveLength(1);
  });

  it('CORS: foreign origin 403, allowed origin gets the CORS headers; OPTIONS answers the preflight', async () => {
    const { apiKey } = await newSource('website', { allowedOrigins: ['https://www.amaya.in'] });
    const bad = await post({ name: 'x', phone: '9876543210' }, { key: apiKey, headers: { Origin: 'https://evil.com' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const good = await post({ name: 'x', phone: '9876543210' }, { key: apiKey, headers: { Origin: 'https://www.amaya.in' } });
    expect(good.status).toBe(201);
    expect(good.headers.get('access-control-allow-origin')).toBe('https://www.amaya.in');
    expect(good.headers.get('vary')).toBe('Origin');
    const pre = await OPTIONS(new Request(URL_, { method: 'OPTIONS', headers: { Origin: 'https://www.amaya.in', 'Access-Control-Request-Method': 'POST' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://www.amaya.in');
    expect(pre.headers.get('access-control-allow-headers')).toContain('X-Api-Key');
    // server-to-server (no Origin) is fine
    expect((await post({ name: 'y', phone: '9876543299' }, { key: apiKey })).status).toBe(201);
  });

  it('_redirect answers 303 to an allowed https URL', async () => {
    const { apiKey } = await newSource('website', { allowedOrigins: ['https://www.amaya.in'] });
    const r = await post({ _key: apiKey, name: 'R', phone: '9876543210', _redirect: 'https://www.amaya.in/thanks' }, { form: true });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://www.amaya.in/thanks?lead=ok');
    const e = await post({ _key: apiKey, name: 'R', phone: '1', _redirect: 'https://www.amaya.in/thanks' }, { form: true });
    expect(e.headers.get('location')).toBe('https://www.amaya.in/thanks?lead=error');
    const foreign = await post({ _key: apiKey, name: 'R2', phone: '9876543211', _redirect: 'https://evil.com/x' }, { form: true });
    expect(foreign.status).toBe(201);
  });

  it('rate limit: 21st request per minute from one IP → 429', async () => {
    const { apiKey } = await newSource('website', { duplicates: 'skip' });
    const hdr = { 'X-Forwarded-For': '203.0.113.7' };
    for (let i = 0; i < 20; i++) expect((await post({ name: 'R', phone: '9876543210' }, { key: apiKey, headers: hdr })).status).toBe(201);
    const r = await post({ name: 'R', phone: '9876543210' }, { key: apiKey, headers: hdr });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'RATE_LIMIT' });
    expect((await post({ name: 'R', phone: '9876543210' }, { key: apiKey, headers: { 'X-Forwarded-For': '203.0.113.8' } })).status).toBe(201);
  });

  it('rotating the key invalidates the old one; deleting the source removes its key', async () => {
    const { source, apiKey } = await newSource();
    const rot = await inCo(() => LS.rotateLeadSourceKey({ id: source.id }, null));
    expect(rot.apiKey).not.toBe(apiKey);
    expect(rot.source.keyPrefix).toBe(rot.apiKey.slice(0, 12));
    expect((await post({ name: 'x', phone: '9876543210' }, { key: apiKey })).status).toBe(401);
    expect((await post({ name: 'x', phone: '9876543210' }, { key: rot.apiKey })).status).toBe(201);
    await inCo(() => LS.deleteLeadSource({ id: source.id }, null));
    expect((await post({ name: 'y', phone: '9876543211' }, { key: rot.apiKey })).status).toBe(401);
    expect(await (await getClient())!.db(PLATFORM_DB()).collection('apiKeys').countDocuments({})).toBe(0);
  });

  it("tenant isolation: a company's key creates the lead in that company's database only", async () => {
    await registerOther();
    const a = await newSource('website', {}, 'A site', 'CMP-test');
    const b = await newSource('website', {}, 'B site', 'CMP-other');
    expect(b.source.id).toBe('SRC-0001'); // own counters
    expect((await post({ name: 'In B', phone: '9876543210' }, { key: b.apiKey })).status).toBe(201);
    expect(await leadsIn('CMP-test')).toHaveLength(0);
    expect((await leadsIn('CMP-other')).map((l) => l['Prospect Name'])).toEqual(['In B']);
    expect((await post({ name: 'In A', phone: '9876543210' }, { key: a.apiKey })).status).toBe(201);
    expect((await leadsIn('CMP-test')).map((l) => l['Prospect Name'])).toEqual(['In A']);
    expect(await leadsIn('CMP-other')).toHaveLength(1);
  });
});

describe('retry & preview', () => {
  it('retries a failed submission from its stored payload', async () => {
    const { source } = await newSource();
    // a submission that failed while saving (e.g. a database hiccup)
    await inCo(async () => {
      await (await inboundCol()).insertOne({
        _id: 'INB_failed1', sourceId: source.id, receivedAt: new Date(), status: 'failed', leadId: '', message: 'Internal error: db hiccup',
        payload: { name: 'Retry Me', phone: '9876543210', city: 'Pune' }, ip: '', origin: '',
      });
      await (await sourcesCol()).updateOne({ _id: source.id }, { $inc: { 'stats.received': 1, 'stats.failed': 1 } });
    });
    const [failed] = await logIn();
    expect(failed).toMatchObject({ status: 'failed', sourceName: 'Main website' });
    expect(await leadsIn()).toHaveLength(0);
    const again = await inCo(() => LS.retryInbound({ id: failed.id }, null));
    expect(again).toMatchObject({ id: failed.id, status: 'created', leadId: 'ENQ-0001' });
    const [lead] = await leadsIn();
    expect(lead['Enquiry Notes']).toContain('city: Pune');
    await expect(inCo(() => LS.retryInbound({ id: failed.id }, null))).rejects.toThrow(/Only failed/);
    const [src] = await inCo(() => LS.listLeadSources());
    expect(src.id).toBe(source.id);
    expect(src.stats).toMatchObject({ received: 1, created: 1, failed: 0 });
  });

  it('preview maps a payload without saving anything', async () => {
    const { source } = await newSource();
    const p = await inCo(() => LS.previewLeadSource({ id: source.id, payload: { name: 'P', phone: '98765', email: 'p@x.io', utm_campaign: 'diwali' } }));
    expect(p.lead).toMatchObject({ 'Prospect Name': 'P', Email: 'p@x.io', 'Lead Stage': 'New' });
    expect(p.lead['Enquiry Notes']).toContain('utm_campaign: diwali');
    expect(p.warnings.join(' ')).toMatch(/Phone number/);
    expect(await leadsIn()).toHaveLength(0);
    expect(await logIn()).toHaveLength(0);
  });

  it('mapFields is pure and ingestLead logs payloads without the key', async () => {
    const m = mapFields({ type: 'webhook', config: LS.defaultConfig('webhook') }, { phone: '9876543210' });
    expect(m.lead['Prospect Name']).toBe('Webhook enquiry 9876543210');
    const { source } = await newSource();
    const doc = await inCo(async () => (await sourcesCol()).findOne({ _id: source.id }));
    const res = await inCo(() => ingestLead(doc!, { _key: 'crm_live_x', phone: '9876543210', long: 'x'.repeat(900) }, { ip: '1.2.3.4' }));
    expect(res.status).toBe('created');
    const [entry] = await logIn();
    expect(entry.payload._key).toBeUndefined();
    expect(entry.payload.long.length).toBeLessThanOrEqual(500);
    expect(entry.ip).toBe('1.2.3.4');
  });
});

describe('super admin', () => {
  it('lists and creates a company lead source through platformDispatch (even without websiteApi)', async () => {
    await t.company('test', { websiteApi: false });
    const setup = await platformDispatch('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' }, { token: '', userAgent: 'vitest', ip: '10.0.0.1' });
    const sa = setup.session!.token;
    const pd = (action: string, data: any) => platformDispatch(action, data, { token: sa, userAgent: 'vitest', ip: '10.0.0.1' });
    const created = await pd('createCompanyLeadSource', { companyId: 'CMP-test', name: 'Partner webhook', type: 'webhook' });
    expect(created.status).toBe(200);
    const data = (created.body as any).data;
    expect(data.apiKey).toMatch(/^crm_live_/);
    expect(data.source).toMatchObject({ id: 'SRC-0001', name: 'Partner webhook', type: 'webhook' });
    const list = await pd('listCompanyLeadSources', { companyId: 'CMP-test' });
    expect((list.body as any).data.map((s: any) => s.id)).toEqual(['SRC-0001']);
    expect((await pd('listCompanyLeadSources', { companyId: 'CMP-nope' })).status).toBe(404);
    // the endpoint still refuses until the plan has the feature
    expect((await post({ name: 'x', phone: '9876543210' }, { key: data.apiKey })).status).toBe(403);
    await t.company('test', { websiteApi: true });
    expect((await post({ name: 'x', phone: '9876543210' }, { key: data.apiKey })).status).toBe(201);
    const upd = await pd('updateCompanyLeadSource', { companyId: 'CMP-test', id: 'SRC-0001', patch: { status: 'Paused' } });
    expect((upd.body as any).data.status).toBe('Paused');
    const log = await pd('companyInboundLog', { companyId: 'CMP-test' });
    expect((log.body as any).data).toHaveLength(1);
    const audit = await pd('auditLog', { companyId: 'CMP-test' });
    expect((audit.body as any).data.map((a: any) => a.action)).toEqual(expect.arrayContaining(['Lead Source Created', 'Lead Source Updated']));
    expect((await pd('deleteCompanyLeadSource', { companyId: 'CMP-test', id: 'SRC-0001' })).status).toBe(200);
    expect((await post({ name: 'x', phone: '9876543210' }, { key: data.apiKey })).status).toBe(401);
  });
});
