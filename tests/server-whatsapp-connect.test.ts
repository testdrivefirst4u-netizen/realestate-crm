/** Connecting WhatsApp through Meta's popup, a number kept on the Business app, old chats, and the popup's messages. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col, getClient, PLATFORM_DB } from '../server/core/db';
import { decryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { addLead } from '../server/modules/leads';
import { messages } from '../server/modules/chat360';
import { handleMetaWebhookPost, MAX_BODY } from '../server/modules/metaQueue';
import { disconnectDirect, finishSignup, getDirect, inboundText, isConnected, requestPastChats, sendDirect, signupConfig } from '../server/modules/whatsappDirect';
import { isFacebookOrigin, loginOptions, parseSignupMessage } from '../src/modules/settings/whatsappSignup';
import nextConfig from '../next.config';

const SECRET = 'app-secret';
const NUMBER_ID = '10001';
const WABA = '20002';
const TOKEN = 'BUSINESS.TOKEN';
const CUSTOMER = '919876501234';
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
let t: Awaited<ReturnType<typeof startTestDb>>;
let meta: Array<{ path: string; method: string; body: any; q: URLSearchParams }> = [];
let numbers: any[] = [];
let platformType = 'NOT_APPLICABLE';
let codeAccepted = true;
let syncFails = '';

const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  const body = init.body ? JSON.parse(String(init.body)) : null;
  meta.push({ path, method: init.method || 'GET', body, q: url.searchParams });
  if (path === '/oauth/access_token') return codeAccepted ? json(200, { access_token: TOKEN }) : json(400, { error: { code: 100, message: 'This code has expired' } });
  if (path === '/debug_token') return json(200, { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [WABA] }] } });
  if (path === `/${WABA}/phone_numbers`) return json(200, { data: numbers });
  if (path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
  if (path === `/${WABA}/message_templates`) return json(200, { data: [] });
  if (path === `/${NUMBER_ID}/register`) return json(200, { success: true });
  if (path === `/${NUMBER_ID}/smb_app_data`) return syncFails === body.sync_type ? json(400, { error: { code: 1, message: 'Not now' } }) : json(200, { request_id: `req-${body.sync_type}` });
  if (path === `/${NUMBER_ID}`) return json(200, { platform_type: platformType, quality_rating: 'GREEN' });
  return json(404, { error: { message: `unexpected ${path}` } });
}
const hits = (p: string) => meta.filter((m) => m.path === p);
const plat = () => getClient().then((c) => c!.db(PLATFORM_DB()));
const setConfig = async (over: Record<string, unknown> = {}) => (await plat()).collection('platformSettings').updateOne({ _id: 'meta' as any }, { $set: { appId: '111', whatsappConfigId: '999', ...over } }, { upsert: true });
const finish = (over: Record<string, unknown> = {}) => inCo(() => finishSignup({ code: 'code-from-meta', wabaId: WABA, phoneNumberId: NUMBER_ID, keepApp: false, ...over }, ctx));
const coexist = () => finish({ keepApp: true });
const webhook = (body: unknown) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return handleMetaWebhookPost(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), (fn) => void fn());
};
const change = (field: string, value: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field, value: { metadata: { phone_number_id: NUMBER_ID }, ...value } }] }] });
const contact = () => inCo(async () => (await col<any>(CFG.COLL.CHAT_CONTACTS)).findOne({ phoneLast10: '9876501234' }));
const allLeads = () => inCo(async () => (await col<any>(CFG.COLL.LEADS)).find({}).toArray());
const OLD = 1780000000;
const historyChunk = (over: Record<string, unknown> = {}, messagesList: any[] = [{ from: CUSTOMER, id: 'wamid.old1', timestamp: String(OLD), type: 'text', text: { body: 'Is it available?' }, history_context: { status: 'READ' } }, { from: '919000011111', to: CUSTOMER, id: 'wamid.old2', timestamp: String(OLD + 60), type: 'text', text: { body: 'Yes it is' }, history_context: { status: 'DELIVERED' } }]) => change('history', { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 40 }, threads: [{ id: CUSTOMER, context: { wa_id: CUSTOMER, username: 'meera' }, messages: messagesList }], ...over }] });

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = SECRET;
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
  await setConfig();
  meta = [];
  numbers = [{ id: NUMBER_ID, display_phone_number: '+91 90000 11111', verified_name: 'Amaya Test' }];
  platformType = 'NOT_APPLICABLE';
  codeAccepted = true;
  syncFails = '';
  vi.stubGlobal('fetch', vi.fn(fake));
});
afterEach(() => vi.unstubAllGlobals());

describe('the popup', () => {
  it('only trusts the real facebook.com', () => {
    expect(isFacebookOrigin('https://www.facebook.com')).toBe(true);
    expect(isFacebookOrigin('https://web.facebook.com')).toBe(true);
    expect(isFacebookOrigin('https://evilfacebook.com')).toBe(false);
    expect(isFacebookOrigin('https://facebook.com.evil.example')).toBe(false);
    expect(isFacebookOrigin('http://www.facebook.com')).toBe(false);
    expect(isFacebookOrigin('not a url')).toBe(false);
  });
  it('reads what it says, and ignores anything else', () => {
    const fb = 'https://www.facebook.com';
    const finished = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '1', waba_id: '2' } };
    expect(parseSignupMessage(fb, JSON.stringify(finished))).toEqual({ kind: 'finish', event: 'FINISH', wabaId: '2', phoneNumberId: '1' });
    expect(parseSignupMessage(fb, JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '2' } }))).toMatchObject({ kind: 'finish', wabaId: '2', phoneNumberId: '' });
    expect(parseSignupMessage(fb, JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE' } }))).toEqual({ kind: 'cancel', step: 'PHONE' });
    expect(parseSignupMessage(fb, JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: { error_message: 'Nope' } }))).toEqual({ kind: 'error', message: 'Nope' });
    expect(parseSignupMessage('https://evil.example', JSON.stringify(finished))).toBeNull();
    expect(parseSignupMessage(fb, 'not json')).toBeNull();
    expect(parseSignupMessage(fb, JSON.stringify({ type: 'SOMETHING_ELSE' }))).toBeNull();
  });
  it('asks for the right flow, and puts the client on the partner when there is one', () => {
    expect(loginOptions({ configId: '9', solutionId: '' }, false)).toEqual({ config_id: '9', response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } });
    expect(loginOptions({ configId: '9', solutionId: '77' }, true).extras).toEqual({ setup: { solutionID: '77' }, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' });
  });
  it('only appears once the platform has its configuration', async () => {
    expect((await inCo(() => signupConfig())).ready).toBe(true);
    await (await plat()).collection('platformSettings').updateOne({ _id: 'meta' as any }, { $set: { whatsappConfigId: '' } });
    expect((await inCo(() => signupConfig())).ready).toBe(false);
  });
});

describe('security rules', () => {
  it('let the popup through and nothing broader', async () => {
    const headers = await nextConfig.headers!();
    const csp = headers.flatMap((h) => h.headers).find((x) => x.key === 'Content-Security-Policy')!.value;
    expect(csp).toMatch(/script-src [^;]*https:\/\/connect\.facebook\.net/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/www\.facebook\.com/);
    expect(csp).not.toMatch(/script-src [^;]*https:\s/);
    expect(csp).toMatch(/frame-ancestors 'self'/);
  });
  it('take a big chunk of old chats', () => {
    expect(MAX_BODY).toBeGreaterThanOrEqual(3 * 1024 * 1024);
  });
});

describe('finishing signup', () => {
  it('a new number: exchanges the code, registers it, keeps the token encrypted', async () => {
    const r = await finish();
    expect(r).toMatchObject({ displayPhone: '+91 90000 11111', webhookSubscribed: true, sync: null });
    expect(hits('/oauth/access_token')[0].q.get('code')).toBe('code-from-meta');
    expect(hits('/oauth/access_token')[0].q.has('redirect_uri')).toBe(false);
    const pin = hits(`/${NUMBER_ID}/register`)[0].body.pin;
    expect(pin).toMatch(/^\d{6}$/);
    const raw = await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'whatsappDirect' }));
    expect(raw).toMatchObject({ mode: 'cloud', phoneNumberId: NUMBER_ID, wabaId: WABA });
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    expect(raw.pin).not.toBe(pin);
    expect(decryptSecret(raw.pin)).toBe(pin);
    expect(await inCo(() => isConnected())).toBe(true);
  });
  it('a number already registered is not registered again', async () => {
    platformType = 'CLOUD_API';
    await finish();
    expect(hits(`/${NUMBER_ID}/register`)).toEqual([]);
  });
  it('a Business app number is never registered, and old chats are asked for straight away', async () => {
    const r = await coexist();
    expect(hits(`/${NUMBER_ID}/register`)).toEqual([]);
    expect(hits(`/${NUMBER_ID}/smb_app_data`).map((m) => m.body)).toEqual([{ messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }, { messaging_product: 'whatsapp', sync_type: 'history' }]);
    expect(r.sync).toMatchObject({ contactsRequestId: 'req-smb_app_state_sync', historyRequestId: 'req-history' });
    expect(await inCo(() => getDirect())).toMatchObject({ connected: true, mode: 'coexistence', sync: { contactsAsked: true, historyAsked: true } });
  });
  it('finds the account and number if the popup message never came', async () => {
    await finish({ wabaId: '', phoneNumberId: '' });
    expect(hits('/debug_token')).toHaveLength(1);
    expect(await inCo(() => isConnected())).toBe(true);
  });
  it('asks to choose when an account has several numbers, or says if it has none', async () => {
    numbers = [{ id: NUMBER_ID }, { id: '10002' }];
    await expect(finish({ phoneNumberId: '' })).rejects.toThrow(/several numbers/);
    numbers = [];
    await expect(finish({ phoneNumberId: '' })).rejects.toThrow(/No phone number/);
  });
  it('explains an expired code, and never shows Meta secrets', async () => {
    codeAccepted = false;
    await expect(finish()).rejects.toThrow(/connect again/);
    await expect(finish({ code: 'x' })).rejects.toThrow(/try again/);
    expect(await inCo(() => isConnected())).toBe(false);
  });
  it('still refuses the Chat360 number and a number of another company', async () => {
    await inCo(async () => (await import('../server/core/settings')).settingSet('chat360BusinessNumber', '919000011111', 'test'));
    await expect(finish()).rejects.toThrow(/Chat360 number/);
    await inCo(async () => (await import('../server/core/settings')).settingSet('chat360BusinessNumber', '', 'test'));
    await (await plat()).collection('whatsappNumbers').insertOne({ _id: NUMBER_ID as any, companyId: 'CMP-other', wabaId: WABA });
    await expect(finish()).rejects.toThrow(/another company/);
  });
});

describe('asking for old chats', () => {
  it('each can only ever be asked once, so what worked is not repeated', async () => {
    syncFails = 'history';
    const first = await coexist();
    expect(first.sync).toMatchObject({ contactsRequestId: 'req-smb_app_state_sync', error: 'Not now' });
    syncFails = '';
    const second = await inCo(() => requestPastChats());
    expect(second).toMatchObject({ historyRequestId: 'req-history', error: '' });
    expect(hits(`/${NUMBER_ID}/smb_app_data`).filter((m) => m.body.sync_type === 'smb_app_state_sync')).toHaveLength(1);
    await inCo(() => requestPastChats());
    expect(hits(`/${NUMBER_ID}/smb_app_data`).filter((m) => m.body.sync_type === 'history')).toHaveLength(2);
  });
  it("is refused after Meta's 24 hours, and for a number not on the app", async () => {
    syncFails = 'smb_app_state_sync';
    await coexist();
    await expect(inCo(() => requestPastChats(new Date(Date.now() + 25 * 3600000)))).rejects.toThrow(/within 24 hours/);
    await inCo(() => disconnectDirect(ctx));
    await finish();
    await expect(inCo(() => requestPastChats())).rejects.toThrow(/kept on the WhatsApp Business app/);
  });
});

describe('old chats arriving', () => {
  beforeEach(async () => { await coexist(); });

  it('join the chat list quietly: nothing unread, no alert, no new lead', async () => {
    expect((await webhook(historyChunk())).status).toBe(200);
    const list = await inCo(() => messages(CUSTOMER));
    expect(list.map((m: any) => [m.direction, m.text, m.status])).toEqual([['Inbound', 'Is it available?', 'received'], ['Outbound', 'Yes it is', 'delivered']]);
    expect(await allLeads()).toEqual([]);
    expect(await contact()).toMatchObject({ unreadCount: 0, lastMessage: 'Yes it is', contactName: 'meera' });
    expect(await inCo(async () => (await col<any>(CFG.COLL.EVENTS)).countDocuments({ type: 'chat_received' }))).toBe(0);
  });
  it('link to a lead when the number matches', async () => {
    const { id } = await inCo(() => addLead({ 'Prospect Name': 'Meera Rao', 'Phone Number': '+919876501234' } as any, ctx));
    await webhook(historyChunk());
    expect((await inCo(() => messages(CUSTOMER)))[0].leadId).toBe(id);
    expect((await contact()).contactName).toBe('Meera Rao');
  });
  it('a repeated chunk adds nothing, and an older chunk does not hide a newer message', async () => {
    await webhook(historyChunk());
    await webhook(historyChunk());
    expect(await inCo(() => messages(CUSTOMER))).toHaveLength(2);
    await webhook(change('messages', { contacts: [{ wa_id: CUSTOMER, profile: { name: 'Meera' } }], messages: [{ id: 'wamid.new', from: CUSTOMER, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Any update?' } }] }));
    await webhook(historyChunk({}, [{ from: CUSTOMER, id: 'wamid.older', timestamp: String(OLD - 999), type: 'text', text: { body: 'Very old' } }]));
    expect((await contact()).lastMessage).toBe('Any update?');
    expect((await contact()).unreadCount).toBe(1);
  });
  it('shows progress, and if sharing was declined', async () => {
    await webhook(historyChunk());
    expect(await inCo(() => getDirect())).toMatchObject({ sync: { progress: 40, declined: false } });
    await webhook(change('history', { history: [{ metadata: { progress: 20 }, threads: [] }] }));
    expect(await inCo(() => getDirect())).toMatchObject({ sync: { progress: 40 } });
    await webhook(change('history', { history: [{ errors: [{ code: 2593109 }] }] }));
    expect(await inCo(() => getDirect())).toMatchObject({ sync: { declined: true } });
  });
  it('old photos say where to find them', () => {
    expect(inboundText({ type: 'media_placeholder' }).text).toMatch(/See it on the phone/);
  });
  it('uses names from the phone, without adding anyone to the chat list', async () => {
    await webhook(change('smb_app_state_sync', { state_sync: [{ type: 'contact', action: 'add', contact: { full_name: 'Meera Rao', phone_number: CUSTOMER } }, { type: 'contact', action: 'add', contact: { full_name: 'My Mum', phone_number: '919111122222' } }] }));
    expect(await inCo(async () => (await col<any>(CFG.COLL.CHAT_CONTACTS)).countDocuments({}))).toBe(0);
    await webhook(historyChunk());
    expect((await contact()).contactName).toBe('Meera Rao');
  });
});

describe('typed on the phone', () => {
  beforeEach(async () => { await coexist(); });
  const echo = (id = 'wamid.echo1', over: Record<string, unknown> = {}) => change('smb_message_echoes', { message_echoes: [{ from: '919000011111', to: CUSTOMER, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Called you just now' }, ...over }] });

  it('shows in the chat as sent from the phone, once, with no new lead', async () => {
    await webhook(echo());
    await webhook(echo());
    const list = await inCo(() => messages(CUSTOMER));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ direction: 'Outbound', agent: 'WhatsApp app', text: 'Called you just now', status: 'sent' });
    expect(await allLeads()).toEqual([]);
    expect((await contact()).unreadCount).toBe(0);
  });
  it('counts as the team having replied to that lead', async () => {
    const { id } = await inCo(() => addLead({ 'Prospect Name': 'Meera', 'Phone Number': '+919876501234' } as any, ctx));
    await webhook(echo());
    const tl = await inCo(async () => (await col<any>(CFG.COLL.TIMELINE)).findOne({ leadId: id, type: 'chat_sent' }));
    expect(tl).toMatchObject({ actor: 'WhatsApp app' });
  });
  it('is never charged credits', async () => {
    await t.company('test', { chat360: true, whatsappDirect: true, whatsappCredits: true });
    await webhook(echo());
    await webhook(change('messages', { statuses: [{ id: 'wamid.echo1', status: 'delivered', pricing: { billable: true, category: 'service' } }] }));
    expect(await inCo(async () => (await col<any>('whatsappLedger')).countDocuments({}))).toBe(0);
  });
  it('a message only the phone could show says so', () => {
    expect(inboundText({ type: 'unsupported', errors: [{ code: 131060 }] }).text).toMatch(/check the WhatsApp Business app/);
  });
});

describe('removed in Meta', () => {
  it('stops using the connection, frees the number, and tells the Admins', async () => {
    await finish();
    expect((await webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: WABA, owner_business_id: '1' } } }] }] })).status).toBe(200);
    expect(await inCo(() => isConnected())).toBe(false);
    expect(await (await plat()).collection('whatsappNumbers').countDocuments({ _id: NUMBER_ID as any })).toBe(0);
    expect(await inCo(async () => (await col<any>(CFG.COLL.EVENTS)).countDocuments({ type: 'integration_alert' }))).toBe(1);
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, text: 'Hi' }, ctx))).rejects.toThrow(/not connected/);
  });
  it('another update, or another account, changes nothing', async () => {
    await finish();
    await webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'account_update', value: { event: 'PARTNER_ADDED' } }] }] });
    await webhook({ object: 'whatsapp_business_account', entry: [{ id: '555', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: '555' } } }] }] });
    expect(await inCo(() => isConnected())).toBe(true);
  });
});

describe('disconnecting', () => {
  it('also tells Meta to stop, and works even if Meta does not answer', async () => {
    await finish();
    await inCo(() => disconnectDirect(ctx));
    expect(hits(`/${WABA}/subscribed_apps`).some((m) => m.method === 'DELETE')).toBe(true);
    await finish();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await inCo(() => disconnectDirect(ctx));
    expect(await inCo(() => isConnected())).toBe(false);
  });
});
