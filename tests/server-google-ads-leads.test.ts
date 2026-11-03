/** Google Ads lead forms: webhook → lead source of type google_ads (key in google_key, idempotent, tests logged only). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import * as LS from '../server/modules/leadSources';
import { getAllLeads } from '../server/modules/leads';
import { sourcesCol, TEST_MESSAGE } from '../server/modules/intake';
import { mapGoogleAdsLead } from '../server/modules/googleAdsLeads';
import { POST } from '../app/api/webhooks/google-ads/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const leads = () => inCo(async () => (await getAllLeads(null)).leads);
const post = (body: unknown) => POST(new Request('https://crm.example.com/api/webhooks/google-ads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

const lead = (key: string, extra: Record<string, unknown> = {}) => ({
  lead_id: 'TeSter-123-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  api_version: '1.0',
  form_id: 40000000001,
  campaign_id: 20000000002,
  adgroup_id: 30000000003,
  creative_id: 50000000004,
  gcl_id: 'TeSter-123-gclid',
  google_key: key,
  is_test: false,
  user_column_data: [
    { column_id: 'FULL_NAME', column_name: 'Full Name', string_value: 'Meena Iyer' },
    { column_id: 'PHONE_NUMBER', column_name: 'User Phone', string_value: '+91 91234 05678' },
    { column_id: 'EMAIL', column_name: 'User Email', string_value: 'meena@example.com' },
    { column_id: 'CITY', column_name: 'City', string_value: 'Hyderabad' },
    { column_name: 'When do you plan to move?', string_value: 'Within 3 months' },
  ],
  ...extra,
});

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { googleAdsLeads: true, websiteApi: true });
});

const newSource = (type: 'google_ads' | 'website' = 'google_ads') => inCo(() => LS.createLeadSource({ name: type === 'google_ads' ? 'Google Ads' : 'Website', type }, null));

describe('Google Ads lead forms', () => {
  it('maps the standard columns, keeps other questions, ids and click id in the log only', () => {
    const f = mapGoogleAdsLead(lead('k') as any);
    expect(f).toMatchObject({ name: 'Meena Iyer', phone: '+91 91234 05678', email: 'meena@example.com', city: 'Hyderabad', 'When do you plan to move?': 'Within 3 months' });
    expect(f).toMatchObject({ meta_campaign: 'Google Ads campaign 20000000002', meta_ad_set: 'Ad group 30000000003', meta_form: 'Google form 40000000001', _gclid: 'TeSter-123-gclid' });
  });

  it('a lead becomes a CRM lead once; a repeat delivery makes nothing new', async () => {
    const { apiKey, source } = await newSource();
    expect(source).toMatchObject({ type: 'google_ads', config: { sourceLabel: 'Google Ads' } });
    const r = await post(lead(apiKey));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ status: 'success', data: { duplicate: false, test: false } });
    const [l] = await leads();
    expect(l).toMatchObject({
      'Prospect Name': 'Meena Iyer', Email: 'meena@example.com', 'Enquiry Source': 'Google Ads', 'Lead Stage': 'New',
      Campaign: 'Google Ads campaign 20000000002', 'Form: When do you plan to move?': 'Within 3 months',
    });
    expect((await post(lead(apiKey))).status).toBe(200);
    expect(await leads()).toHaveLength(1);
  });

  it("Google's test data is logged as received, makes no lead and is not an error", async () => {
    const { apiKey, source } = await newSource();
    const r = await post(lead(apiKey, { is_test: true }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.test).toBe(true);
    expect(await leads()).toHaveLength(0);
    const log = await inCo(() => LS.listInboundLog({ sourceId: source.id } as any));
    expect(JSON.stringify(log)).toContain(TEST_MESSAGE);
    const doc = await inCo(async () => (await sourcesCol()).findOne({ _id: source.id }));
    expect(doc?.stats?.lastError || '').toBe('');
  });

  it('wrong key, a website key, a paused source or the switch off are refused', async () => {
    expect((await post(lead('crm_live_' + '0'.repeat(48)))).status).toBe(401);
    expect((await post({ ...lead(''), google_key: undefined })).status).toBe(401);
    const web = await newSource('website');
    expect((await post(lead(web.apiKey))).status).toBe(403);
    const { apiKey } = await newSource();
    await t.company('test', { googleAdsLeads: false, websiteApi: true });
    expect((await post(lead(apiKey))).status).toBe(403);
    // the "Add source" action is held to the switch too
    const gated = await inCo(async () => (LS as any).actions.createLeadSource.fn({ name: 'Google Ads 2', type: 'google_ads' }, null)).catch((e: any) => e);
    expect(String(gated?.message)).toMatch(/Google Ads lead forms are not included/);
    expect(await leads()).toHaveLength(0);
  });
});
