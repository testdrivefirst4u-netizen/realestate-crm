/** WhatsApp campaigns: nobody twice, pausing on account problems and no credits, the audience rules, and media templates. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { createUser, login } from '../server/core/auth';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { addLead } from '../server/modules/leads';
import { handleMetaWebhookPost } from '../server/modules/metaQueue';
import { saveFile } from '../server/modules/storage';
import { connectDirect, createTemplate, readTemplate, sendDirect } from '../server/modules/whatsappDirect';
import { PRICING_DEFAULTS, setPricing, addCreditEntry, toUnits, creditsBalance } from '../server/modules/whatsappCredits';
import { changeCampaign, fillValue, listCampaigns, campaignDetail, noteCampaignReply, runCampaignsDue, saveCampaign, setAudience, startCampaign, testCampaign } from '../server/modules/whatsappCampaigns';
import { GET as cronGET } from '../app/api/cron/campaigns/route';
import { filterLeads, parseAudienceRows } from '../src/modules/campaigns/campaignAudience';

const SECRET = 'app-secret';
const NUMBER_ID = '10001';
const WABA = '20002';
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
const OFFER = { name: 'offer', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello {{1}}, see {{2}}.' }] };
const PLAIN = { name: 'plain', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello there' }] };
const PIC = { name: 'pic', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'See this' }] };
const PENDING = { name: 'waiting', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] };
const CAROUSEL = { name: 'cards', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }, { type: 'CAROUSEL', cards: [] }] };
let t: Awaited<ReturnType<typeof startTestDb>>;
let sent: any[] = [];
let answer: ((body: any) => Response | null) | null = null;
let uploads: any[] = [];
let nextId = 0;

const inCo = async <X>(fn: () => Promise<X>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  if (path === `/${WABA}/phone_numbers`) return json(200, { data: [{ id: NUMBER_ID, display_phone_number: '+91 90000 11111', verified_name: 'Test' }] });
  if (path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
  if (path === `/${WABA}/message_templates`) return init.method === 'POST' ? (uploads.push({ template: JSON.parse(init.body) }), json(200, { status: 'PENDING', category: 'MARKETING' })) : json(200, { data: [OFFER, PLAIN, PIC, PENDING, CAROUSEL] });
  if (path === '/111/uploads') { uploads.push({ start: url.searchParams.get('file_type') }); return json(200, { id: 'upload:abc' }); }
  if (path === '/upload:abc') { uploads.push({ auth: init.headers.Authorization, offset: init.headers.file_offset }); return json(200, { h: 'HANDLE' }); }
  if (path === `/${NUMBER_ID}/messages`) {
    const body = JSON.parse(String(init.body));
    const a = answer?.(body);
    if (a) return a;
    sent.push(body);
    return json(200, { messages: [{ id: `wamid.${++nextId}` }] });
  }
  return json(404, { error: { message: `unexpected ${path}` } });
}
const webhook = (body: unknown) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return handleMetaWebhookPost(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), (fn) => void fn());
};
const receipt = (id: string, status: string, extra: Record<string, unknown> = {}) => webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER_ID }, statuses: [{ id, status, ...extra }] } }] }] });
const phones = (n: number, start = 0) => Array.from({ length: n }, (_, i) => ({ phone: `9198765${String(10000 + start + i)}`, name: `Person ${i + 1}` }));
const draft = async (list = phones(3), over: Record<string, unknown> = {}) => {
  const { id } = await inCo(() => saveCampaign({ name: 'Diwali', template: 'offer', language: 'en', params: ['{first_name}', 'the show flat'], ...over }, ctx));
  await inCo(() => setAudience({ id, list, label: 'A list' }, ctx));
  return id;
};
const ready = async (list = phones(3), over: Record<string, unknown> = {}) => {
  const id = await draft(list, over);
  await inCo(() => testCampaign({ id, phone: '919000000000' }));
  sent = [];
  return id;
};
const started = async (list = phones(3), over: Record<string, unknown> = {}) => {
  const id = await ready(list, over);
  await inCo(() => startCampaign({ id, consent: true }, ctx));
  return id;
};
const run = () => inCo(() => runCampaignsDue(30000));
const stats = async (id: string) => (await inCo(() => listCampaigns())).campaigns.find((c) => c.id === id)!;
const rows = (id: string) => inCo(async () => (await col<any>('whatsappCampaignRecipients')).find({ campaignId: id }).toArray());

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = SECRET;
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['META_APP_ID', 'META_APP_SECRET', 'APP_URL', 'CRON_SECRET']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { chat360: true, whatsappDirect: true, whatsappCampaigns: true });
  sent = [];
  uploads = [];
  answer = null;
  delete process.env.CRON_SECRET;
  vi.stubGlobal('fetch', vi.fn(fake));
  await setPricing(PRICING_DEFAULTS, 'test');
  await inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: 'TOKEN' }, ctx));
});
afterEach(() => vi.unstubAllGlobals());

describe('without the switch', () => {
  it('nothing is available, and the background job does nothing', async () => {
    await t.company('test', { chat360: true, whatsappDirect: true, whatsappCampaigns: false });
    expect(await run()).toEqual({ sent: 0, more: false });
    const token = await inCo(async () => {
      await createUser({ name: 'Boss', email: 'boss@c.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null);
      return (await login('boss@c.test', 'long-enough-pw', { userAgent: 'v', ip: '1.1.1.1' })).token;
    });
    expect(((await inCo(() => dispatch('waCampaignList', {}, { userAgent: 'v', ip: '1.1.1.1', token }))) as any).status).toBe(403);
  });
});

describe('sending', () => {
  it('sends each person the template with their own values, then completes', async () => {
    const id = await started();
    expect((await run()).sent).toBe(3);
    expect(sent.map((b) => b.template.components[0].parameters[0].text).sort()).toEqual(['Person', 'Person', 'Person']);
    expect(sent[0].template.components[0].parameters[1].text).toBe('the show flat');
    expect((await stats(id)).status).toBe('completed');
    expect((await stats(id)).stats).toMatchObject({ total: 3, sent: 3, failed: 0, waiting: 0 });
  });
  it('never messages anyone twice, even if run again or at once', async () => {
    await started(phones(30));
    await Promise.all([run(), run(), run()]);
    await run();
    expect(sent).toHaveLength(30);
    expect(new Set(sent.map((b) => b.to)).size).toBe(30);
  });
  it('the same number twice in a list counts once', async () => {
    const id = await draft([...phones(2), { phone: '+91 98765 10000', name: 'Again' }]);
    expect((await rows(id))).toHaveLength(2);
    expect((await stats(id)).skippedAtStart).toEqual({ 'Same number twice': 1 });
  });
  it('a failed person does not stop the rest, and shows why', async () => {
    const id = await started();
    answer = (b) => (b.to === phones(1)[0].phone ? json(400, { error: { code: 131026, message: 'not on WhatsApp' } }) : null);
    await run();
    expect((await stats(id)).stats).toMatchObject({ sent: 2, failed: 1 });
    expect((await inCo(() => campaignDetail({ id }))).failures[0].error).toMatch(/may not be on WhatsApp/);
  });
  it('keeps to the daily limit and carries on later', async () => {
    const id = await started(phones(5), { perDay: 2 });
    await run();
    expect(sent).toHaveLength(2);
    expect((await stats(id)).status).toBe('running');
    await inCo(async () => (await col<any>('whatsappCampaignRecipients')).updateMany({ campaignId: id, sentDay: { $ne: '' } }, { $set: { sentDay: '2000-01-01' } }));
    await run();
    expect(sent).toHaveLength(4);
  });
  it('a send interrupted long ago is marked failed, never sent again', async () => {
    const id = await started(phones(1));
    await inCo(async () => (await col<any>('whatsappCampaignRecipients')).updateMany({ campaignId: id }, { $set: { status: 'sending', claimedAt: new Date(Date.now() - 3600000) } }));
    await run();
    expect(sent).toEqual([]);
    expect((await rows(id))[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/not tried again/i) });
  });
  it('the background job runs a campaign for a company that has them', async () => {
    const { runLeadWatch } = await import('../server/modules/salesOps');
    await started(phones(2));
    expect((await inCo(() => runLeadWatch())).campaigns).toMatchObject({ sent: 2 });
  });
  it('runs a scheduled one only when due', async () => {
    const id = await ready();
    await inCo(() => startCampaign({ id, consent: true, at: new Date(Date.now() + 3600000).toISOString() }, ctx));
    await run();
    expect(sent).toEqual([]);
    expect((await stats(id)).status).toBe('scheduled');
    await inCo(async () => (await col<any>('whatsappCampaigns')).updateOne({ _id: id }, { $set: { scheduledAt: new Date(Date.now() - 1000) } }));
    await run();
    expect(sent).toHaveLength(3);
  });
  it('does not write an audit line per message', async () => {
    await started();
    await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).deleteMany({}));
    await run();
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'WhatsApp Sent' }))).toBe(0);
  });
});

describe('pausing', () => {
  it('on an account problem from Meta, with everyone not reached still waiting', async () => {
    const id = await started();
    answer = () => json(400, { error: { code: 131048, message: 'Spam rate limit hit' } });
    await run();
    const c = await stats(id);
    expect(c.status).toBe('paused');
    expect(c.pauseReason).toMatch(/Spam rate limit/);
    expect(c.stats.waiting).toBe(3);
    answer = null;
    await inCo(() => changeCampaign({ id, action: 'resume' }, ctx));
    await run();
    expect(sent).toHaveLength(3);
    expect((await stats(id)).status).toBe('completed');
  });
  it('when a receipt reports an account problem', async () => {
    const id = await started(phones(25));
    await inCo(() => runCampaignsDue(30000));
    const c0 = (await rows(id)).find((r) => r.messageId)!;
    await inCo(async () => (await col<any>('whatsappCampaigns')).updateOne({ _id: id }, { $set: { status: 'running' } }));
    await receipt(c0.messageId, 'failed', { errors: [{ code: 131048, title: 'Spam' }] });
    expect((await stats(id)).status).toBe('paused');
  });
  it('by hand, and stopping is final', async () => {
    const id = await started();
    await inCo(() => changeCampaign({ id, action: 'pause' }, ctx));
    await run();
    expect(sent).toEqual([]);
    await inCo(() => changeCampaign({ id, action: 'stop' }, ctx));
    await expect(inCo(() => changeCampaign({ id, action: 'resume' }, ctx))).rejects.toThrow(/cannot be done/);
  });
});

describe('credits', () => {
  beforeEach(async () => { await t.company('test', { chat360: true, whatsappDirect: true, whatsappCampaigns: true, whatsappCredits: true }); });
  const add = (rupees: number) => inCo(() => addCreditEntry({ requestId: crypto.randomUUID(), units: toUnits(rupees), reference: 'T', note: '', by: 'T' }));

  it('will not start without enough for everyone', async () => {
    await add(2);
    const id = await ready(phones(5));
    await expect(inCo(() => startCampaign({ id, consent: true }, ctx))).rejects.toThrow(/needs about ₹4\.8/);
  });
  it('pauses if they run out during sending, and the charge is tied to the campaign', async () => {
    await add(10);
    const id = await ready(phones(3));
    await inCo(() => startCampaign({ id, consent: true }, ctx));
    const b = await inCo(() => creditsBalance());
    await inCo(async () => (await col<any>('whatsappWallet')).updateOne({ _id: 'CMP-test' }, { $set: { balance: toUnits(1), held: 0 } }));
    expect(b.available).toBeGreaterThan(0);
    await run();
    const c = await stats(id);
    expect(c.status).toBe('paused');
    expect(c.pauseReason).toMatch(/Credits ran out/);
    expect(c.stats.sent).toBe(1);
    expect(c.stats.waiting).toBe(2);
    const first = (await rows(id)).find((r) => r.messageId)!;
    await receipt(first.messageId, 'delivered', { pricing: { billable: true, category: 'marketing' } });
    expect((await stats(id)).stats.credits).toBe(0.96);
  });
});

describe('what comes back', () => {
  it('counts delivered and read in order, and a reply', async () => {
    const id = await started(phones(1));
    await run();
    const [r] = await rows(id);
    await receipt(r.messageId, 'read');
    await receipt(r.messageId, 'delivered');
    expect((await rows(id))[0].status).toBe('read');
    await inCo(() => noteCampaignReply(r.phone, 'Yes, interested'));
    expect((await stats(id)).stats).toMatchObject({ read: 1, delivered: 1, replied: 1 });
  });
  it('someone who says STOP is left out of later campaigns', async () => {
    const list = phones(2);
    await started(list);
    await run();
    await webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER_ID }, contacts: [], messages: [{ id: 'in1', from: list[0].phone, timestamp: '1', type: 'text', text: { body: 'STOP' } }] } }] }] });
    const id2 = await draft(list);
    expect((await stats(id2)).skippedAtStart).toEqual({ 'Asked not to be messaged': 1 });
    expect(await rows(id2)).toHaveLength(1);
  });
  it('someone who says STOP after being queued is not messaged', async () => {
    const list = phones(1);
    const id = await started(list);
    await inCo(async () => (await col<any>('dripOptOuts')).insertOne({ _id: `whatsapp:${list[0].phone.slice(-10)}` as any, channel: 'whatsapp' }));
    await run();
    expect(sent).toEqual([]);
    expect((await rows(id))[0].status).toBe('skipped');
  });
  it('an agent recording "opted out" while the campaign is queued stops later marketing sends (central consent)', async () => {
    const list = phones(2);
    const id = await started(list);
    const { recordConsent } = await import('../server/modules/consent');
    await inCo(() => recordConsent('+' + list[1].phone, 'denied', { source: 'agent', evidence: 'Asked on the call', by: 'Asha' }));
    await run();
    const r = await rows(id);
    expect(r.find((x: any) => x.phone.endsWith(list[1].phone.slice(-10)))?.status).toBe('skipped');
    expect(r.find((x: any) => x.phone.endsWith(list[0].phone.slice(-10)))?.status).not.toBe('skipped');
    expect(sent).toHaveLength(1);
  });
  it('with the explicit-consent policy, only numbers with recorded consent get marketing', async () => {
    const list = phones(2);
    const { recordConsent } = await import('../server/modules/consent');
    const { settingSet } = await import('../server/core/settings');
    await inCo(() => settingSet('whatsappMarketingConsent', 'explicit', 'test'));
    await inCo(() => recordConsent('+' + list[0].phone, 'granted', { source: 'website', evidence: 'Ticked the box', by: 'Website' }));
    const id = await started(list);
    await run();
    const r = await rows(id);
    expect(r.filter((x: any) => x.status === 'skipped').map((x: any) => x.error)).toEqual(['No recorded consent for WhatsApp marketing']);
    expect(sent).toHaveLength(1);
  });
});

describe('before it can start', () => {
  it('needs consent, a test and people', async () => {
    const id = await draft();
    await expect(inCo(() => startCampaign({ id, consent: true }, ctx))).rejects.toThrow(/test first/);
    await inCo(() => testCampaign({ id, phone: '919000000000' }));
    await expect(inCo(() => startCampaign({ id, consent: false }, ctx))).rejects.toThrow(/agreed to hear/);
    await inCo(() => startCampaign({ id, consent: true }, ctx));
    await expect(inCo(() => startCampaign({ id, consent: true }, ctx))).rejects.toThrow(/already been started/);
  });
  it('changing the template or people asks for a new test', async () => {
    const id = await ready();
    await inCo(() => setAudience({ id, list: phones(1), label: 'x' }, ctx));
    await expect(inCo(() => startCampaign({ id, consent: true }, ctx))).rejects.toThrow(/test first/);
  });
  it('refuses a template not approved, the wrong values, or nobody', async () => {
    await expect(inCo(() => saveCampaign({ name: 'x', template: 'waiting', language: 'en', params: [] }, ctx))).rejects.toThrow(/not approved/);
    await expect(inCo(() => saveCampaign({ name: 'x', template: 'offer', language: 'en', params: ['a'] }, ctx))).rejects.toThrow(/needs 2 values/);
    await expect(inCo(() => saveCampaign({ name: 'x', template: 'cards', language: 'en', params: [] }, ctx))).rejects.toThrow(/cannot be sent/);
    const { id } = await inCo(() => saveCampaign({ name: 'x', template: 'plain', language: 'en', params: [] }, ctx));
    await expect(inCo(() => setAudience({ id, list: [], label: '' }, ctx))).rejects.toThrow(/Choose who/);
  });
  it('refuses a past time, and a time too far ahead', async () => {
    const id = await ready();
    await expect(inCo(() => startCampaign({ id, consent: true, at: new Date(Date.now() - 1000).toISOString() }, ctx))).rejects.toThrow(/future/);
    await expect(inCo(() => startCampaign({ id, consent: true, at: new Date(Date.now() + 90 * 86400000).toISOString() }, ctx))).rejects.toThrow(/60 days/);
  });
  it('a started campaign cannot be edited; only a draft can be deleted', async () => {
    const id = await started();
    await expect(inCo(() => saveCampaign({ id, name: 'x', template: 'plain', language: 'en', params: [] }, ctx))).rejects.toThrow(/Only a draft/);
    await expect(inCo(() => changeCampaign({ id, action: 'delete' }, ctx))).rejects.toThrow(/cannot be done/);
  });
});

describe('choosing people', () => {
  it('leads: only ones this person may see, no deleted ones, no bad numbers', async () => {
    const a = await inCo(() => addLead({ 'Prospect Name': 'Meera', 'Phone Number': '+919876510000' } as any, ctx));
    const b = await inCo(() => addLead({ 'Prospect Name': 'Gone', 'Phone Number': '+919876510001' } as any, ctx));
    await inCo(async () => (await col<any>(CFG.COLL.LEADS)).updateOne({ _id: b.id }, { $set: { stage: CFG.STAGES.TRASH } }));
    const { id } = await inCo(() => saveCampaign({ name: 'x', template: 'plain', language: 'en', params: [] }, ctx));
    const r = await inCo(() => setAudience({ id, leadIds: [a.id, b.id, 'ENQ-NOPE'], label: 'x' }, ctx));
    expect(r).toEqual({ added: 1, skipped: { 'Not available to you': 1, 'Deleted leads': 1 } });
    const scoped = { user: { name: 'Dev', role: 'RM', email: 'd@x.test', id: 'U-rm' } } as any;
    expect((await inCo(() => setAudience({ id, leadIds: [a.id], label: 'x' }, scoped))).added).toBe(0);
  });
  it('a list: bad numbers are counted, not sent', async () => {
    const id = await draft([{ phone: '123', name: 'Bad' }, { phone: '919876510000', name: 'Good' }]);
    expect((await stats(id)).skippedAtStart).toEqual({ 'No valid number': 1 });
  });
  it('a limit on size', async () => {
    const { id } = await inCo(() => saveCampaign({ name: 'x', template: 'plain', language: 'en', params: [] }, ctx));
    await expect(inCo(() => setAudience({ id, list: phones(10001), label: '' }, ctx))).rejects.toThrow(/up to 10,000/);
  });
  it('with credits on, outside India is left out, as prices cover India only', async () => {
    await t.company('test', { whatsappDirect: true, whatsappCampaigns: true, whatsappCredits: true });
    const id = await draft([{ phone: '971501234567', name: 'UAE' }, { phone: '919876510000', name: 'India' }]);
    expect((await stats(id)).skippedAtStart).toEqual({ 'Outside India': 1 });
  });
});

describe('values', () => {
  it('fills in each person, and a missing name reads there', () => {
    const p = { name: 'Meera Rao', rm: 'Asha', unit: '3 BHK' };
    expect(fillValue('{first_name}', p, 'Amaya')).toBe('Meera');
    expect(fillValue('{unit} at {company}', p, 'Amaya')).toBe('3 BHK at Amaya');
    expect(fillValue('{first_name}', { ...p, name: '' }, 'A')).toBe('there');
    expect(fillValue('{name}', { ...p, name: 'WhatsApp +919876510000' }, 'A')).toBe('there');
    expect(fillValue('{name}', { ...p, name: '919876510000' }, 'A')).toBe('there');
    expect(fillValue('{rm}', { ...p, rm: '' }, 'A')).toBe('');
  });
  it('someone with a value missing fails alone, rather than getting a blank', async () => {
    const id = await started(phones(1), { params: ['{rm}', 'x'] });
    await run();
    expect(sent).toEqual([]);
    expect((await rows(id))[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/empty/) });
  });
});

describe('a template with a picture', () => {
  const picture = () => inCo(() => saveFile({ category: 'WhatsApp files', name: 'flat.png', mime: 'image/png', data: Buffer.from('png'), uploadedBy: 't' }));
  it('needs a file, and a campaign sends it', async () => {
    await expect(inCo(() => saveCampaign({ name: 'x', template: 'pic', language: 'en', params: [] }, ctx))).rejects.toThrow(/needs a image/);
    const { fileId } = await picture();
    await started(phones(1), { template: 'pic', params: [], headerFileId: fileId });
    await run();
    expect(sent[0].template.components[0]).toMatchObject({ type: 'header', parameters: [{ type: 'image', image: { link: expect.stringContaining(fileId) } }] });
  });
  it('another kind of file is refused', async () => {
    const other = await inCo(() => saveFile({ category: 'Lead documents', name: 'id.png', mime: 'image/png', data: Buffer.from('x'), uploadedBy: 't' }));
    await expect(inCo(() => sendDirect({ phone: '919876510000', templateName: 'pic', headerFileId: other.fileId }, ctx))).rejects.toThrow(/Add the image/);
  });
  it('a quick send from a chat still explains itself', async () => {
    await expect(inCo(() => sendDirect({ phone: '919876510000', templateName: 'pic' }, ctx))).rejects.toThrow(/WhatsApp Campaigns/);
  });
  it('carousels are now marked as not sendable', () => {
    expect(readTemplate(CAROUSEL)).toMatchObject({ sendable: false, headerMedia: '', notSendable: expect.stringMatching(/carousel/) });
    expect(readTemplate(PIC)).toMatchObject({ sendable: false, headerMedia: 'image' });
    expect(readTemplate({ name: 'a', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BUTTONS', buttons: [{ url: 'https://x/{{1}}' }] }] })).toMatchObject({ headerMedia: '' });
  });
  it('creating one uploads the example to Meta first', async () => {
    const base64 = Buffer.from('png').toString('base64');
    await inCo(() => createTemplate({ name: 'new_pic', category: 'MARKETING', language: 'en', body: 'See this', headerMedia: 'image', sample: { name: 'a.png', mime: 'image/png', base64 }, examples: [] }, ctx));
    expect(uploads[0]).toEqual({ start: 'image/png' });
    expect(uploads[1]).toEqual({ auth: 'OAuth TOKEN', offset: '0' });
    expect(uploads[2].template.components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['HANDLE'] } });
    await expect(inCo(() => createTemplate({ name: 'bad', category: 'MARKETING', language: 'en', body: 'See', headerMedia: 'image', sample: { mime: 'text/html', base64 }, examples: [] }, ctx))).rejects.toThrow(/JPG or PNG/);
  });
});

describe('the batch route', () => {
  it('needs the secret, and hands over only while progress is made', async () => {
    process.env.CRON_SECRET = 'cron-key';
    const get = (auth?: string) => cronGET(new Request('https://crm.example.com/api/cron/campaigns', { headers: auth ? { authorization: auth } : {} }));
    expect((await get()).status).toBe(401);
    expect((await get('Bearer wrong')).status).toBe(401);
    await started(phones(2));
    const r = await get('Bearer cron-key');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { sent: 2, more: false } });
  });
});

describe('who can use it', () => {
  it('Admins and Managers only', async () => {
    for (const [role, code] of [['Admin', 200], ['Manager', 200], ['RM', 403], ['Viewer', 403]] as const) {
      const token = await inCo(async () => {
        const email = `${role.toLowerCase()}@camp.test`;
        await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
        return (await login(email, 'long-enough-pw', { userAgent: 'v', ip: '1.1.1.1' })).token;
      });
      expect(((await inCo(() => dispatch('waCampaignList', {}, { userAgent: 'v', ip: '1.1.1.1', token }))) as any).status, role).toBe(code);
    }
  });
});

describe('reading a list', () => {
  it('finds the columns by heading, or without any', () => {
    expect(parseAudienceRows([['Name', 'Mobile No'], ['Meera', '9876510000'], ['', ''], ['Ravi', '9876510001']])).toEqual({ problem: '', list: [{ phone: '9876510000', name: 'Meera' }, { phone: '9876510001', name: 'Ravi' }] });
    expect(parseAudienceRows([['Meera', '9876510000']])).toEqual({ problem: '', list: [{ phone: '9876510000', name: 'Meera' }] });
  });
  it('says what is wrong', () => {
    expect(parseAudienceRows([]).problem).toMatch(/empty/);
    expect(parseAudienceRows([['Name', 'City'], ['A', 'B']]).problem).toMatch(/headed Phone/);
    expect(parseAudienceRows([['Phone']]).problem).toMatch(/No phone numbers/);
  });
  it('filters leads, empty meaning any', () => {
    const leads = [{ 'Lead Stage': 'New', 'Enquiry Source': 'Meta', 'Assigned RM': 'A' }, { 'Lead Stage': 'Hot', 'Enquiry Source': 'Web', 'Assigned RM': 'B' }] as any[];
    expect(filterLeads(leads, { stages: [], sources: [], rms: [] })).toHaveLength(2);
    expect(filterLeads(leads, { stages: ['Hot'], sources: [], rms: [] })).toHaveLength(1);
    expect(filterLeads(leads, { stages: ['Hot'], sources: ['Meta'], rms: [] })).toHaveLength(0);
  });
});
