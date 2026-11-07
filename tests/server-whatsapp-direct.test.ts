/** WhatsApp through Meta: Chat360 untouched unless a company is switched, sending, templates, the webhook, and one number per company. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col, getClient, PLATFORM_DB } from '../server/core/db';
import { settingSet, settingsPublic } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { addLead } from '../server/modules/leads';
import { messages, send } from '../server/modules/chat360';
import { handleMetaWebhookPost } from '../server/modules/metaQueue';
import { connectDirect, createTemplate, deleteTemplate, disconnectDirect, explainMetaError, getDirect, inboundText, isConnected, readTemplate, sendDirect, syncTemplates, templateParams, templateProblem } from '../server/modules/whatsappDirect';

const SECRET = 'app-secret';
const NUMBER_ID = '10001';
const WABA = '20002';
const TOKEN = 'SUPER.SECRET.TOKEN';
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
const CUSTOMER = '919876501234';
let t: Awaited<ReturnType<typeof startTestDb>>;
let meta: Array<{ url: string; method: string; body: any; auth: string }> = [];
let chat360: any[] = [];
let templates: any[] = [];
let sendAnswer: any = null;

const inCo = async <T>(fn: () => Promise<T>, id = 'CMP-test') => {
  invalidateTenant();
  return runWithTenant((await getTenantById(id))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const APPROVED = { name: 'welcome', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}, your visit is on {{2}}.' }] };

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(String(init.body)) : null;
  if (url.hostname.endsWith('chat360.io')) {
    chat360.push(body);
    return json(200, { message_id: 'c360.1', access_token: 'tok', expires_in: 3600 });
  }
  if (url.hostname === 'cdn.fbcdn.net') return new Response(Buffer.from('jpeg-bytes'), { status: 200 });
  if (url.hostname !== 'graph.facebook.com') return json(500, { error: { message: `unexpected ${url.hostname}` } });
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  meta.push({ url: url.toString(), method: init.method || 'GET', body, auth: String(init.headers?.Authorization || '') });
  if (path === `/${WABA}/phone_numbers`) return json(200, { data: [{ id: NUMBER_ID, display_phone_number: '+91 90000 11111', verified_name: 'Amaya Test' }] });
  if (path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
  if (path === `/${WABA}/message_templates`) {
    if (init.method === 'POST') return json(200, { id: '5', status: 'PENDING', category: body.category });
    if (init.method === 'DELETE') return json(200, { success: true });
    return json(200, { data: templates });
  }
  if (path === `/${NUMBER_ID}/messages`) return sendAnswer || json(200, { messages: [{ id: `wamid.out${meta.length}` }] });
  if (path === `/${NUMBER_ID}/register`) return json(200, { success: true });
  if (path === `/${NUMBER_ID}`) return json(200, { quality_rating: 'GREEN', platform_type: 'CLOUD_API' });
  if (path === '/media1') return json(200, { url: 'https://cdn.fbcdn.net/x.jpg', mime_type: 'image/jpeg', file_size: 10 });
  if (path === '/evil') return json(200, { url: 'https://evil.example.com/x.jpg', mime_type: 'image/jpeg', file_size: 10 });
  return json(404, { error: { message: `unexpected ${path}` } });
}
const plat = () => getClient().then((c) => c!.db(PLATFORM_DB()));
/** Calls made with the company's token. Meta's token check (debug_token) is the one exception: it takes the token to check in the address, by design, and is signed by the app. */
const toMeta = () => meta.filter((m) => m.url.includes('graph.facebook.com') && !m.url.includes('/debug_token'));
const lastSent = () => [...meta].reverse().find((m) => m.url.includes('/messages'))!;
const connect = (over: Record<string, unknown> = {}) => inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: TOKEN, ...over }, ctx));
const chat360Ready = () => inCo(async () => {
  await t.secret('CHAT360_API_KEY', 'AbCd.key');
  await t.secret('CHAT360_LOGIN_PASSWORD', 'pw');
  await settingSet('chat360BusinessNumber', '919000000000', 'test');
  await settingSet('chat360LoginEmail', 'a@b.example', 'test');
});
const webhook = (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  const sig = signature ?? 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return handleMetaWebhookPost(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), (fn) => void fn());
};
const messageEvent = (value: Record<string, unknown>, numberId = NUMBER_ID) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: numberId }, ...value } }] }] });
const hello = (id = 'wamid.in1', over: Record<string, unknown> = {}) => messageEvent({ contacts: [{ wa_id: CUSTOMER, profile: { name: 'Meera' } }], messages: [{ id, from: CUSTOMER, timestamp: '1793000000', type: 'text', text: { body: 'Hi, is 2BHK available?' }, ...over }] });

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = SECRET;
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.APP_URL;
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { chat360: true, whatsappDirect: true });
  meta = [];
  chat360 = [];
  sendAnswer = null;
  templates = [APPROVED];
  vi.stubGlobal('fetch', vi.fn(fake));
});
afterEach(() => vi.unstubAllGlobals());

describe('Chat360 stays as it is', () => {
  it('without the plan switch: sends by Chat360, and Meta is never called or even asked about', async () => {
    await t.reset();
    await t.company('test', { chat360: true });
    await chat360Ready();
    await inCo(() => send({ phone: CUSTOMER, text: 'Hello' }, ctx));
    expect(chat360.some((b) => b?.text?.body === 'Hello')).toBe(true);
    expect(toMeta()).toEqual([]);
    expect(await inCo(() => isConnected())).toBe(false);
    expect((await inCo(() => settingsPublic())) as any).toMatchObject({ chat360Configured: true, whatsappDirect: false });
  });

  it('the plan switch alone changes nothing until a number is connected', async () => {
    await chat360Ready();
    await inCo(() => send({ phone: CUSTOMER, text: 'Hello' }, ctx));
    expect(chat360.some((b) => b?.text?.body === 'Hello')).toBe(true);
    expect(lastSent()).toBeUndefined();
  });

  it('once connected, sends by Meta and not Chat360; disconnecting goes straight back', async () => {
    await chat360Ready();
    await connect();
    await inCo(() => send({ phone: CUSTOMER, text: 'By Meta' }, ctx));
    expect(lastSent().body).toMatchObject({ to: CUSTOMER, type: 'text', text: { body: 'By Meta' } });
    expect(chat360.some((b) => b?.text?.body === 'By Meta')).toBe(false);
    await inCo(() => disconnectDirect(ctx));
    meta = [];
    await inCo(() => send({ phone: CUSTOMER, text: 'Back' }, ctx));
    expect(chat360.some((b) => b?.text?.body === 'Back')).toBe(true);
    expect(lastSent()).toBeUndefined();
  });

  it('refuses the number Chat360 is using', async () => {
    await inCo(() => settingSet('chat360BusinessNumber', '919000011111', 'test'));
    await expect(connect()).rejects.toThrow(/Chat360 number/);
    expect(await inCo(() => isConnected())).toBe(false);
    expect(await (await plat()).collection('whatsappNumbers').countDocuments({})).toBe(0);
  });

  it('a company without the switch gets no direct actions at all', async () => {
    await t.reset();
    await t.company('test', { chat360: true });
    const token = await inCo(async () => {
      await createUser({ name: 'Boss', email: 'boss@x.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null);
      return (await login('boss@x.test', 'long-enough-pw', { userAgent: 'v', ip: '1.1.1.1' })).token;
    });
    expect(((await inCo(() => dispatch('waDirectGet', {}, { userAgent: 'v', ip: '1.1.1.1', token }))) as any).status).toBe(403);
  });
});

describe('connecting', () => {
  it('keeps the token encrypted and never hands it back', async () => {
    const r = await connect();
    expect(r).toEqual({ displayPhone: '+91 90000 11111', verifiedName: 'Amaya Test', webhookSubscribed: true });
    const raw = await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'whatsappDirect' }));
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    const view = await inCo(() => getDirect());
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view).toMatchObject({ connected: true, displayPhone: '+91 90000 11111', quality: 'GREEN', webhookUrl: 'https://crm.example.com/api/webhooks/meta' });
  });

  it('sends the token in a header, never in the address', async () => {
    await connect();
    for (const m of toMeta()) {
      expect(m.url).not.toContain(TOKEN);
      expect(m.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('subscribes the account so messages arrive, and reads its templates', async () => {
    await connect();
    expect(toMeta().some((m) => m.url.includes(`/${WABA}/subscribed_apps`) && m.method === 'POST')).toBe(true);
    expect(await inCo(async () => (await col<any>('whatsappTemplates')).countDocuments({}))).toBe(1);
  });

  it('refuses a number that is not in that account', async () => {
    await expect(connect({ phoneNumberId: '99999' })).rejects.toThrow(/not in that WhatsApp account/);
  });

  it('refuses letters, an empty token and a bad PIN', async () => {
    await expect(connect({ phoneNumberId: 'abc' })).rejects.toThrow(/only digits/);
    await expect(connect({ token: '' })).rejects.toThrow(/access token/);
    await expect(connect({ pin: '12' })).rejects.toThrow(/6 digits/);
  });

  it('a number belongs to one company', async () => {
    await connect();
    await t.company('other', { chat360: true, whatsappDirect: true });
    await expect(inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: TOKEN }, ctx), 'CMP-other')).rejects.toThrow(/another company/);
  });

  it('can be saved again without retyping the token, and registers only when a PIN is given', async () => {
    await connect();
    expect(toMeta().some((m) => m.url.includes('/register'))).toBe(false);
    await connect({ token: '', pin: '123456' });
    expect(toMeta().find((m) => m.url.includes('/register'))?.body).toEqual({ messaging_product: 'whatsapp', pin: '123456' });
    expect(toMeta().every((m) => m.auth === `Bearer ${TOKEN}`)).toBe(true);
  });
});

describe('sending', () => {
  beforeEach(async () => { await connect(); });

  it('saves the message to the chat, ready for the same screen', async () => {
    const { message } = await inCo(() => sendDirect({ phone: CUSTOMER, text: 'Hello' }, ctx));
    expect(message).toMatchObject({ direction: 'Outbound', text: 'Hello', status: 'sent', agent: 'Asha' });
    expect((await inCo(() => messages(CUSTOMER))).map((m: any) => m.text)).toEqual(['Hello']);
  });

  it('fills an approved template', async () => {
    await inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'welcome', params: ['Meera', 'Sunday'] }, ctx));
    expect(lastSent().body.template).toEqual({ name: 'welcome', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Meera' }, { type: 'text', text: 'Sunday' }] }] });
  });

  it('names the values of a template that uses names', async () => {
    templates = [{ ...APPROVED, name: 'named', components: [{ type: 'BODY', text: 'Hello {{first_name}}!' }] }];
    await inCo(() => syncTemplates());
    await inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'named', params: ['Meera'] }, ctx));
    expect(lastSent().body.template.components[0].parameters[0]).toEqual({ type: 'text', text: 'Meera', parameter_name: 'first_name' });
  });

  it('stops before sending when the values do not fit', async () => {
    const before = meta.length;
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'welcome', params: ['Meera'] }, ctx))).rejects.toThrow(/needs 2 values, and 1 was given/);
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'welcome', params: ['Meera', ' '] }, ctx))).rejects.toThrow(/Fill in every value/);
    expect(meta.length).toBe(before);
  });

  it('will not send what is not approved, or what it cannot fill', async () => {
    templates = [{ ...APPROVED, status: 'PENDING' }, { ...APPROVED, name: 'pic', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }] }];
    await inCo(() => syncTemplates());
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'welcome', params: ['a', 'b'] }, ctx))).rejects.toThrow(/not approved yet/);
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'pic' }, ctx))).rejects.toThrow(/header/);
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'ghost' }, ctx))).rejects.toThrow(/no template called ghost/);
  });

  it('finds a template approved a moment ago', async () => {
    templates = [{ ...APPROVED, name: 'fresh', components: [{ type: 'BODY', text: 'Hi' }] }];
    await inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'fresh' }, ctx));
    expect(lastSent().body.template.name).toBe('fresh');
  });

  it('explains a refusal, and never sends twice', async () => {
    sendAnswer = json(400, { error: { code: 131030, message: 'not allowed' } });
    const before = meta.filter((m) => m.url.includes('/messages')).length;
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, text: 'Hi' }, ctx))).rejects.toThrow(/allowed recipients/);
    expect(meta.filter((m) => m.url.includes('/messages')).length).toBe(before + 1);
    sendAnswer = json(500, { error: { code: 1, message: 'boom' } });
    await expect(inCo(() => sendDirect({ phone: CUSTOMER, text: 'Hi' }, ctx))).rejects.toThrow(/WhatsApp refused it: boom/);
    expect(meta.filter((m) => m.url.includes('/messages')).length).toBe(before + 2);
  });

  it('asks for a new token when the old one is dead', () => {
    expect(explainMetaError({ metaCode: 190, message: 'x' })).toMatch(/expired/);
  });

  it('does not send a bad number or nothing', async () => {
    await expect(inCo(() => sendDirect({ phone: '12', text: 'x' }, ctx))).rejects.toThrow(/valid phone/);
    await expect(inCo(() => sendDirect({ phone: CUSTOMER }, ctx))).rejects.toThrow(/required/);
  });
});

describe('templates', () => {
  const good = { name: 'site_visit', category: 'UTILITY', language: 'en', body: 'Hello {{1}}, see you on {{2}}.', footer: '', examples: ['Meera', 'Sunday'] };
  it('finds the values, by number or name, once each', () => {
    expect(templateParams('Hi {{1}} and {{2}} and {{1}}')).toEqual(['1', '2']);
    expect(templateParams('Hi {{ first_name }}')).toEqual(['first_name']);
    expect(templateParams('')).toEqual([]);
  });
  it("catches what Meta would reject, before it's sent", () => {
    expect(templateProblem(good)).toBe('');
    expect(templateProblem({ ...good, name: 'Site Visit' })).toMatch(/small letters/);
    expect(templateProblem({ ...good, category: 'AUTHENTICATION' })).toMatch(/Marketing or Utility/);
    expect(templateProblem({ ...good, body: 'Hi {{2}} there {{1}} now' })).toMatch(/in order/);
    expect(templateProblem({ ...good, body: '{{1}} hello', examples: ['x'] })).toMatch(/start or end/);
    expect(templateProblem({ ...good, body: 'hello {{1}}', examples: ['x'] })).toMatch(/start or end/);
    expect(templateProblem({ ...good, examples: ['Meera'] })).toMatch(/each of the 2 values/);
    expect(templateProblem({ ...good, body: 'x'.repeat(1025), examples: [] })).toMatch(/1,024/);
    expect(templateProblem({ ...good, body: 'plain', examples: [] })).toBe('');
  });
  it('flags what cannot be filled from here', () => {
    expect(readTemplate({ name: 'a', components: [{ type: 'BODY', text: 'Hi' }] }).sendable).toBe(true);
    expect(readTemplate({ name: 'a', components: [{ type: 'HEADER', format: 'TEXT', text: 'Plain' }, { type: 'BODY', text: 'Hi' }] }).sendable).toBe(true);
    expect(readTemplate({ name: 'a', components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Hi' }] }).sendable).toBe(false);
    expect(readTemplate({ name: 'a', components: [{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, { type: 'BODY', text: 'Hi' }] }).sendable).toBe(false);
    expect(readTemplate({ name: 'a', components: [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x/{{1}}' }] }] }).sendable).toBe(false);
  });
  it('creates one for review, with examples, and tracks its approval from the webhook', async () => {
    await connect();
    expect(await inCo(() => createTemplate(good, ctx))).toEqual({ status: 'PENDING' });
    const made = toMeta().find((m) => m.method === 'POST' && m.url.includes('message_templates'))!;
    expect(made.body.components[0]).toEqual({ type: 'BODY', text: good.body, example: { body_text: [good.examples] } });
    expect(await webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: 'site_visit', message_template_language: 'en', reason: 'NONE' } }] }] })).toMatchObject({ status: 200 });
    const saved = await inCo(async () => (await col<any>('whatsappTemplates')).findOne({ _id: 'site_visit:en' }));
    expect(saved).toMatchObject({ status: 'APPROVED', reason: '' });
  });
  it('sync drops what is gone, and delete removes every language', async () => {
    await connect();
    templates = [];
    await inCo(() => syncTemplates());
    expect(await inCo(async () => (await col<any>('whatsappTemplates')).countDocuments({}))).toBe(0);
    await inCo(() => createTemplate(good, ctx));
    await inCo(() => deleteTemplate({ name: 'site_visit' }, ctx));
    expect(await inCo(async () => (await col<any>('whatsappTemplates')).countDocuments({}))).toBe(0);
  });
});

describe('what customers send', () => {
  beforeEach(async () => { await connect(); });
  const contact = () => inCo(async () => (await col<any>(CFG.COLL.CHAT_CONTACTS)).findOne({ phoneLast10: '9876501234' }));
  const leads = () => inCo(async () => (await col<any>(CFG.COLL.LEADS)).find({}).toArray());

  it('a new customer becomes a lead with a chat and an unread count', async () => {
    expect((await webhook(hello())).status).toBe(200);
    const [lead] = await leads();
    expect(lead).toMatchObject({ name: 'Meera', phoneLast10: '9876501234', source: 'Chat360' });
    expect(await contact()).toMatchObject({ unreadCount: 1, leadId: lead._id, lastMessage: 'Hi, is 2BHK available?' });
    expect((await inCo(() => messages(CUSTOMER)))[0]).toMatchObject({ direction: 'Inbound', text: 'Hi, is 2BHK available?', leadId: lead._id });
  });

  it('a repeat delivery changes nothing', async () => {
    await webhook(hello());
    await webhook(hello());
    expect(await inCo(() => messages(CUSTOMER))).toHaveLength(1);
    expect((await contact()).unreadCount).toBe(1);
    expect(await leads()).toHaveLength(1);
  });

  it('a known customer stays one lead', async () => {
    const { id } = await inCo(() => addLead({ 'Prospect Name': 'Meera Rao', 'Phone Number': '+919876501234' } as any, ctx));
    await webhook(hello());
    expect(await leads()).toHaveLength(1);
    expect((await contact()).leadId).toBe(id);
    expect((await leads())[0].name).toBe('Meera Rao');
  });

  it('keeps a photo, sending the token only to Meta', async () => {
    await webhook(hello('wamid.pic', { type: 'image', text: undefined, image: { id: 'media1', mime_type: 'image/jpeg', caption: 'The view' } }));
    const [m] = await inCo(() => messages(CUSTOMER));
    expect(m.mediaUrl).toMatch(/^\/api\/files\//);
    expect(m).toMatchObject({ messageType: 'image', text: 'The view' });
  });

  it('never sends the token to a host that is not Meta, and keeps the message', async () => {
    const fetchSpy = vi.mocked(fetch);
    await webhook(hello('wamid.evil', { type: 'image', text: undefined, image: { id: 'evil', mime_type: 'image/jpeg' } }));
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('evil.example.com'))).toBe(false);
    const [m] = await inCo(() => messages(CUSTOMER));
    expect(m.text).toMatch(/could not be saved/);
    expect(m.mediaUrl).toBe('');
  });

  it('turns every kind of message into something readable', () => {
    expect(inboundText({ type: 'button', button: { text: 'Yes' } }).text).toBe('Yes');
    expect(inboundText({ type: 'interactive', interactive: { list_reply: { title: '2BHK' } } }).text).toBe('2BHK');
    expect(inboundText({ type: 'location', location: { latitude: 1, longitude: 2 } }).text).toBe('📍 1, 2');
    expect(inboundText({ type: 'document', document: { id: 'd', filename: 'plan.pdf', caption: 'Here' } })).toMatchObject({ text: '📄 plan.pdf\nHere', mediaId: 'd', filename: 'plan.pdf' });
    expect(inboundText({ type: 'something_new' }).text).toMatch(/could not show/);
    expect(inboundText({ type: 'reaction' }).type).toBe('reaction');
  });

  it('a reaction is not a new message', async () => {
    await webhook(hello('wamid.r', { type: 'reaction', text: undefined, reaction: { emoji: '👍' } }));
    expect(await inCo(() => messages(CUSTOMER))).toEqual([]);
    expect(await leads()).toEqual([]);
  });

  it('an unknown number, or a company switched off, is ignored', async () => {
    expect((await webhook(hello('wamid.x'))).status).toBe(200);
    await webhook(messageEvent({ messages: [{ id: 'wamid.y', from: CUSTOMER, type: 'text', text: { body: 'x' } }] }, '555'));
    expect(await inCo(() => messages(CUSTOMER))).toHaveLength(1);
    await t.company('test', { chat360: true, whatsappDirect: false });
    invalidateTenant();
    await webhook(hello('wamid.z'));
    expect(await inCo(() => messages(CUSTOMER))).toHaveLength(1);
  });

  it('refuses a forged webhook', async () => {
    expect((await webhook(hello(), 'sha256=' + 'a'.repeat(64))).status).toBe(401);
    expect(await inCo(() => messages(CUSTOMER))).toEqual([]);
  });

  it('asks Meta to deliver again if saving fails', async () => {
    const spy = vi.spyOn(await import('../server/modules/whatsappDirect'), 'handleWhatsappWebhook').mockRejectedValueOnce(new Error('db down'));
    expect((await webhook(hello())).status).toBe(500);
    spy.mockRestore();
  });
});

describe('delivery receipts', () => {
  beforeEach(async () => { await connect(); });
  const status = (id: string, s: string, extra: Record<string, unknown> = {}) => webhook(messageEvent({ statuses: [{ id, status: s, recipient_id: CUSTOMER, ...extra }] }));
  const sent = async () => (await inCo(() => sendDirect({ phone: CUSTOMER, text: 'Hi' }, ctx))).message.id;
  const row = (id: string) => inCo(async () => (await col<any>(CFG.COLL.CHAT_MESSAGES)).findOne({ _id: id }));

  it('move forward only, whatever order they arrive in', async () => {
    const id = await sent();
    await status(id, 'read');
    await status(id, 'delivered');
    await status(id, 'sent');
    expect((await row(id)).status).toBe('read');
  });

  it('a failure shows why, once', async () => {
    const id = await sent();
    await status(id, 'failed', { errors: [{ code: 131047, title: 'Re-engagement' }] });
    await status(id, 'failed', { errors: [{ code: 131047, title: 'Re-engagement' }] });
    const [m] = await inCo(() => messages(CUSTOMER));
    expect(m.status).toBe('failed');
    expect(m.error).toMatch(/last 24 hours/);
    expect(await inCo(async () => (await col<any>(CFG.COLL.EVENTS)).countDocuments({ type: 'chat_failed' }))).toBe(1);
  });

  it('keeps what Meta says each message costs, ready for credits', async () => {
    const id = await sent();
    await status(id, 'delivered', { pricing: { billable: true, category: 'utility', pricing_model: 'PMP' } });
    expect(await row(id)).toMatchObject({ billable: true, pricingCategory: 'utility', status: 'delivered' });
  });
});

describe("Meta's webhook still works for leads", () => {
  it('a lead form event goes to the lead queue as before', async () => {
    const r = await webhook({ object: 'page', entry: [{ id: 'P1', changes: [{ field: 'leadgen', value: { leadgen_id: '777', page_id: 'P1', form_id: 'F1' } }] }] });
    expect(r.status).toBe(200);
    expect(await (await plat()).collection('metaLeadQueue').countDocuments({ _id: '777' as any })).toBe(1);
  });
});
