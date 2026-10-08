/** Chat360 (WhatsApp): webhook ingest + de-duplication + lead mapping, outbound send, contacts, webhook route auth. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/modules/leads', () => ({
  findLeadByPhone: vi.fn(async () => null),
  getLead: vi.fn(async () => null),
  addLead: vi.fn(),
  updateLead: vi.fn(),
  actions: {},
}));
vi.mock('../server/modules/storage', () => ({ saveFile: vi.fn(), readFile: vi.fn(), actions: {} }));
vi.mock('../server/modules/records', () => ({ saveRecord: vi.fn(), actions: {} }));

import { startTestDb } from './helpers/mongo';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { getSettings, settingSet, updateSettings } from '../server/core/settings';
import type { Ctx } from '../server/core/auth';
import * as leads from '../server/modules/leads';
import { apiKeyShapeProblem, businessNumberFrom, contacts, handleWebhook, mapContact, markRead, messages, send, templateParamData, test as chatTest } from '../server/modules/chat360';
import { POST as webhookPOST } from '../app/api/webhooks/chat360/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
let ctx: Ctx;

const LEAD = { 'Enquiry ID': 'ENQ-0007', 'Prospect Name': 'Meera Rao', 'Phone Number': '+919876543210', 'Assigned RM': 'Asha', 'Lead Stage': 'Warm' };
const inbound = (over: Record<string, any> = {}) => ({
  event_type: 'message_received', event_response_id: 'evt-1', m_id: 'wamid.in1', sender_num: '919876543210', profile_name: 'Meera',
  wab_response: { type: 'text', text: { body: 'Hello, is a 2 BHK available?' } }, created: '2026-10-01T10:00:00Z', ...over,
});

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  vi.mocked(leads.findLeadByPhone).mockReset().mockResolvedValue(null);
  vi.mocked(leads.getLead).mockReset().mockResolvedValue(null);
  vi.mocked(leads.addLead).mockReset().mockImplementation(async (data: any) => ({ id: 'ENQ-0100', lead: { ...data, 'Enquiry ID': 'ENQ-0100' }, version: '1' }));
  await settingSet('chat360AutoCreateLeads', 'true', 'test');
  await settingSet('chat360DefaultRM', 'Asha', 'test');
  await settingSet('chat360DefaultSource', 'Chat360', 'test');
  await t.company();
  await t.secret('CHAT360_API_KEY', 'c360-key');
  await t.secret('CHAT360_WEBHOOK_SECRET', 'hook-secret');
  ctx = await t.ctx('RM', 'Ravi');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhook ingest', () => {
  it('auto-creates a lead, stores the message once, counts unread and logs timeline/event', async () => {
    const r: any = await handleWebhook(inbound());
    expect(r).toEqual({ ok: true, leadId: 'ENQ-0100' });
    expect(leads.addLead).toHaveBeenCalledTimes(1);
    const [data, actor] = vi.mocked(leads.addLead).mock.calls[0] as any[];
    expect(data).toMatchObject({ 'Prospect Name': 'Meera', 'Phone Number': '+919876543210', 'Enquiry Source': 'Chat360', 'Assigned RM': 'Asha', 'Lead Stage': 'New', 'Brochure Shared': 'No' });
    expect(actor.user.name).toBe('Chat360');

    // Chat360 retry with the same event id → duplicate, nothing changes
    expect(await handleWebhook(inbound())).toEqual({ ok: true, duplicate: true });
    expect(leads.addLead).toHaveBeenCalledTimes(1);

    const msgs = await messages('9876543210');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'Inbound', text: 'Hello, is a 2 BHK available?', leadId: 'ENQ-0100', contactName: 'Meera', status: 'received', timestamp: '2026-10-01T10:00:00.000Z' });
    const cs = await contacts();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ phone: '919876543210', leadId: 'ENQ-0100', unreadCount: 1, status: 'Open' });

    await handleWebhook(inbound({ event_response_id: 'evt-2', m_id: 'wamid.in2' }));
    expect((await contacts())[0].unreadCount).toBe(2);
    expect(await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId: 'ENQ-0100', type: 'chat_received' })).toBe(2);
    expect(await (await col(CFG.COLL.EVENTS)).countDocuments({ type: 'chat_received' })).toBe(2);

    await markRead('+91 98765 43210');
    expect((await contacts())[0].unreadCount).toBe(0);
  });

  it('parallel deliveries of the same event are stored once', async () => {
    const results: any[] = await Promise.all([handleWebhook(inbound()), handleWebhook(inbound()), handleWebhook(inbound())]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(2);
    expect(await (await col(CFG.COLL.CHAT_MESSAGES)).countDocuments({})).toBe(1);
    expect((await contacts())[0].unreadCount).toBe(1);
  });

  it('links to an existing lead and never creates one when auto-create is off', async () => {
    vi.mocked(leads.findLeadByPhone).mockResolvedValue(LEAD);
    const r: any = await handleWebhook(inbound());
    expect(r.leadId).toBe('ENQ-0007');
    expect(leads.addLead).not.toHaveBeenCalled();
    expect((await contacts())[0]).toMatchObject({ leadId: 'ENQ-0007', assignedRM: 'Asha' });

    vi.mocked(leads.findLeadByPhone).mockResolvedValue(null);
    await settingSet('chat360AutoCreateLeads', 'false', 'test');
    const r2: any = await handleWebhook(inbound({ event_response_id: 'evt-9', sender_num: '918888777766' }));
    expect(r2).toEqual({ ok: true, leadId: null });
    expect(leads.addLead).not.toHaveBeenCalled();
  });

  it('keeps only a truncated raw payload and ignores payloads without a phone', async () => {
    await handleWebhook(inbound({ padding: 'x'.repeat(20000) }));
    const doc: any = await (await col(CFG.COLL.CHAT_MESSAGES)).findOne({});
    expect(doc.raw.length).toBeLessThanOrEqual(4000);
    expect(await handleWebhook({ event_type: 'message_received', event_response_id: 'z' })).toEqual({ ok: true, ignored: 'no-phone' });
  });

  it('applies delivery/read status to messages we sent and logs console-sent messages', async () => {
    await settingSet('chat360BusinessNumber', '919000000001', 'test');
    await settingSet('chat360LoginEmail', 'crm@amaya.test', 'test');
    await t.secret('CHAT360_LOGIN_PASSWORD', 'pw-status');
    fakeChat360({ session: () => new Response(JSON.stringify({ message_id: 'wamid.out1' }), { status: 200 }) });
    await send({ phone: '9876543210', text: 'Hi Meera' }, ctx);
    await handleWebhook({ event_type: 'sent_message_read', event_response_id: 'evt-r', m_id: 'wamid.out1', receiver_num: '919876543210' });
    expect((await messages('9876543210'))[0].status).toBe('read');
    // console message (not sent from the CRM) is recorded once
    const console1 = { event_type: 'session_message_sent', event_response_id: 'evt-c', m_id: 'wamid.c1', receiver_num: '919876543210', wab_response: { text: { body: 'From console' } } };
    await handleWebhook(console1);
    await handleWebhook(console1);
    const all = await messages('9876543210');
    expect(all.filter((m) => m.agent === 'Chat360 Console')).toHaveLength(1);
    // our own CRM-sent message echoed back as session_message_sent is not duplicated
    await handleWebhook({ event_type: 'session_message_sent', event_response_id: 'evt-o', m_id: 'wamid.out1', receiver_num: '919876543210' });
    expect((await messages('9876543210')).filter((m) => m.direction === 'Outbound')).toHaveLength(2);
  });
});

/* ------------------------------- outbound -------------------------------- */

/** A JWT whose expiry the CRM can read (signature irrelevant here). */
const jwt = (secondsFromNow = 3600) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ token_type: 'access', exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString('base64url')}.sig`;
const TEMPLATE_ID = '14d78939-1111-4222-8333-6bef933da888';

/**
 * A fake Chat360: answers by URL like the real API (https://api.chat360.io/). Override any endpoint;
 * every call is kept in `calls`.
 */
function fakeChat360(over: Partial<Record<'login' | 'session' | 'task' | 'templates', (init: RequestInit) => Response>> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/auth/login')) return over.login ? over.login(init) : json({ user: { id: 1 }, access: jwt(), refresh: jwt(86400) });
    if (url.endsWith('/api/whatsapp/whatsapp-session-messages')) return over.session ? over.session(init) : json({ messages: [{ id: 'wamid.S1' }] });
    if (url.endsWith('/service/v1/task')) return over.task ? over.task(init) : json({ message_id: 'wamid.T1' });
    if (url.endsWith('/service/template/data')) return over.templates ? over.templates(init) : json({ data: [{ name: 'other', template_id: '00000000-0000-4000-8000-000000000000' }, { name: 'welcome', template_id: TEMPLATE_ID }] });
    return json({ detail: 'not found' }, 404);
  });
  const to = (path: string) => calls.filter((c) => c.url.endsWith(path));
  return { fetchMock, calls, to };
}

describe('outbound', () => {
  beforeEach(async () => {
    await settingSet('chat360BusinessNumber', '919000000001', 'test');
    await settingSet('chat360LoginEmail', 'crm@amaya.test', 'test');
    // a fresh password per test → a fresh sign-in (tokens are cached per login)
    await t.secret('CHAT360_LOGIN_PASSWORD', 'pw-' + Math.random().toString(36).slice(2));
  });

  it('sends typed replies as session messages with a login token, reusing the token', async () => {
    vi.mocked(leads.findLeadByPhone).mockResolvedValue(LEAD);
    const c = fakeChat360();
    const { message } = await send({ phone: '98765 43210', text: 'Hello' }, ctx);
    expect(c.to('/api/auth/login')).toHaveLength(1);
    expect(JSON.parse(String(c.to('/api/auth/login')[0].init.body))).toMatchObject({ email: 'crm@amaya.test' });
    const [sent] = c.to('/api/whatsapp/whatsapp-session-messages');
    expect(sent.url).toBe('https://app.chat360.io/api/whatsapp/whatsapp-session-messages');
    expect((sent.init.headers as any).Authorization).toMatch(/^Bearer eyJ/);
    expect(JSON.parse(String(sent.init.body))).toEqual({ api_key: 'c360-key', from: '919000000001', recipient_type: 'individual', to: '919876543210', type: 'text', text: { body: 'Hello' } });
    expect(sent.init.signal).toBeInstanceOf(AbortSignal);
    expect(message).toMatchObject({ id: 'wamid.S1', direction: 'Outbound', leadId: 'ENQ-0007', contactName: 'Meera Rao', agent: 'Ravi', status: 'sent' });
    expect(await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId: 'ENQ-0007', type: 'chat_sent' })).toBe(1);
    expect(await (await col(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'WhatsApp Sent' })).toBe(1);
    expect((await contacts())[0].lastMessage).toBe('Hello');

    await send({ phone: '9876543210', text: 'Second' }, ctx);
    expect(c.to('/api/auth/login')).toHaveLength(1); // token reused
  });

  it('signs in again once when Chat360 says the token expired', async () => {
    let first = true;
    const c = fakeChat360({
      session: () => {
        if (first) { first = false; return new Response(JSON.stringify({ code: 'token_not_valid' }), { status: 401 }); }
        return new Response(JSON.stringify({ message_id: 'wamid.S2' }), { status: 200 });
      },
    });
    const { message } = await send({ phone: '9876543210', text: 'Hi' }, ctx);
    expect(message.id).toBe('wamid.S2');
    expect(c.to('/api/auth/login')).toHaveLength(2);
  });

  it('sends templates as tasks with the API key, looking the id up by name', async () => {
    const c = fakeChat360();
    const { message } = await send({ phone: '9876543210', templateName: 'welcome', params: ['customer_name=Meera', 'Sat'] }, ctx);
    expect((c.to('/service/template/data')[0].init.headers as any).Authorization).toBe('Api-Key c360-key');
    const [task] = c.to('/service/v1/task');
    expect(task.url).toBe('https://app.chat360.io/service/v1/task');
    expect((task.init.headers as any).Authorization).toBe('Api-Key c360-key');
    expect(JSON.parse(String(task.init.body))).toEqual({
      task_name: 'whatsapp_push_notification', extra: '',
      task_body: [{ client_number: '919000000001', receiver_number: '919876543210', template_data: { template_id: TEMPLATE_ID, param_data: { customer_name: 'Meera', '2': 'Sat' }, button_param_data: {} } }],
    });
    expect(c.to('/api/auth/login')).toHaveLength(0); // templates need no login
    expect(message).toMatchObject({ id: 'wamid.T1', text: '[Template: welcome] customer_name=Meera | Sat', messageType: 'template' });

    // a template id is used as is; an unknown name is explained
    await send({ phone: '9876543210', templateName: TEMPLATE_ID }, ctx);
    expect(c.to('/service/template/data')).toHaveLength(1);
    await expect(send({ phone: '9876543210', templateName: 'nope' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('no approved template called “nope”') });
  });

  it('explains what is missing or rejected', async () => {
    const c = fakeChat360({ session: () => new Response(JSON.stringify({ detail: 'Session expired for this user' }), { status: 400 }) });
    await expect(send({ phone: '123', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(send({ phone: '9876543210' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(send({ phone: '9876543210', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'SERVER', message: expect.stringMatching(/HTTP 400\): Session expired for this user\..*24 hours/) });
    expect(await (await col(CFG.COLL.CHAT_MESSAGES)).countDocuments({})).toBe(0);

    // 200 with an error in the body is still a rejection
    c.fetchMock.mockRestore();
    fakeChat360({ task: () => new Response(JSON.stringify({ success: false, message: 'Template paused' }), { status: 200 }) });
    await expect(send({ phone: '9876543210', templateName: TEMPLATE_ID }, ctx)).rejects.toMatchObject({ code: 'SERVER', message: expect.stringContaining('Template paused') });

    // a wrong login is reported as a settings problem
    vi.restoreAllMocks();
    await t.secret('CHAT360_LOGIN_PASSWORD', 'wrong-' + Math.random());
    fakeChat360({ login: () => new Response(JSON.stringify({ detail: 'No active account found with the given credentials' }), { status: 401 }) });
    await expect(send({ phone: '9876543210', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('login e-mail and password') });

    // missing pieces: no call to Chat360 at all
    vi.restoreAllMocks();
    const none = fakeChat360();
    await t.secret('CHAT360_LOGIN_PASSWORD', '');
    await expect(send({ phone: '9876543210', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('Chat360 login') });
    await settingSet('chat360BusinessNumber', '', 'test');
    await expect(send({ phone: '9876543210', templateName: TEMPLATE_ID }, ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('business WhatsApp number') });
    await t.secret('CHAT360_API_KEY', '');
    await expect(send({ phone: '9876543210', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(none.calls).toHaveLength(0);
  });

  it('ignores the old, never-working addresses a company may have saved', async () => {
    await settingSet('chat360BaseUrl', 'https://api.chat360.io', 'test');
    await settingSet('chat360SendPath', '/api/v1/messages/send', 'test');
    const c = fakeChat360();
    await send({ phone: '9876543210', text: 'Hi' }, ctx);
    expect(c.to('/api/whatsapp/whatsapp-session-messages')[0].url).toBe('https://app.chat360.io/api/whatsapp/whatsapp-session-messages');
  });

  it('settings check the business number and login e-mail, and keep the password secret', async () => {
    const support = await t.ctx('Developer', 'Support');
    await expect(updateSettings({ chat360BusinessNumber: '12345' }, support)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ chat360LoginEmail: 'not-an-email' }, support)).rejects.toMatchObject({ code: 'VALIDATION' });
    const s: any = await updateSettings({ chat360BusinessNumber: '98765 00001', chat360LoginEmail: ' crm@amaya.test ' }, support);
    expect(s).toMatchObject({ chat360BusinessNumber: '919876500001', chat360LoginEmail: 'crm@amaya.test', chat360LoginPasswordSet: true });
    expect(JSON.stringify(s)).not.toContain('pw-');
  });

  it('finds the business number in incoming messages when Settings has none', async () => {
    await settingSet('chat360BusinessNumber', '', 'test');
    // an older message already stored, before this feature
    await handleWebhook(inbound({ event_response_id: 'evt-old', sender_num: '918888777766', receiver_num: '919000000777' }));
    expect(businessNumberFrom({ sender_num: '919876543210', receiver_num: '919876543210' }, '919876543210')).toBe(''); // never the customer
    fakeChat360();
    await chatTest();
    const s: any = await getSettings(await t.ctx('Developer', 'Support'));
    expect(s.chat360BusinessNumber).toBe('919000000777');

    // a set number is never overwritten by a webhook
    await settingSet('chat360BusinessNumber', '919000000001', 'test');
    await handleWebhook(inbound({ event_response_id: 'evt-new', sender_num: '917777666655', receiver_num: '919111111111' }));
    expect((await getSettings(await t.ctx('Developer', 'Support2')) as any).chat360BusinessNumber).toBe('919000000001');
  });

  it('sends with a number learned from stored messages', async () => {
    await settingSet('chat360BusinessNumber', '', 'test');
    await handleWebhook(inbound({ event_response_id: 'evt-l', sender_num: '918888777766', receiver_num: '919000000555' }));
    await settingSet('chat360BusinessNumber', '', 'test'); // pretend it was not learned at the time
    const c = fakeChat360();
    await send({ phone: '9876543210', text: 'Hi' }, ctx);
    expect(JSON.parse(String(c.to('/api/whatsapp/whatsapp-session-messages')[0].init.body)).from).toBe('919000000555');
  });

  it('templateParamData names or numbers the variables', () => {
    expect(templateParamData(['first_name=Meera', 'Sat', ' unit = 2 BHK '])).toEqual({ first_name: 'Meera', '2': 'Sat', unit: '2 BHK' });
  });

  it('test() checks the key (sending nothing), the number and the login for real', async () => {
    // Chat360 checks the key before the body: a 400 for the empty task list means the key got through
    const c = fakeChat360({ task: () => new Response('{"detail":"task_body is empty"}', { status: 400 }) });
    const good = await chatTest();
    expect(good.ok).toBe(true);
    expect(good.message).toContain('API key accepted');
    expect(good.message).toContain('Signed in to Chat360 as crm@amaya.test');
    expect(good.message).toContain('Webhook secret set');
    const [probe] = c.to('/service/v1/task');
    expect((probe.init.headers as any).Authorization).toBe('Api-Key c360-key');
    expect(JSON.parse(String(probe.init.body)).task_body).toEqual([]); // nothing to send

    vi.restoreAllMocks();
    await t.secret('CHAT360_API_KEY', 'eyJhbGciOiJIUzI1NiJ9.e30.x');
    fakeChat360({ task: () => new Response('{"detail":"Authentication credentials were not provided."}', { status: 401 }) });
    const bad = await chatTest();
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('API key rejected');
    expect(bad.message).toContain('login token');

    await t.secret('CHAT360_API_KEY', '');
    expect((await chatTest()).ok).toBe(false);
  });

  it('spots API keys that were pasted wrongly', () => {
    expect(apiKeyShapeProblem('PNBcxRB2.abcdefghijklmnop')).toBe('');
    expect(apiKeyShapeProblem('eyJhbGciOiJIUzI1NiJ9.e30.x')).toContain('login token');
    expect(apiKeyShapeProblem('Api-Key PNBcxRB2.abc')).toContain('only the key itself');
    expect(apiKeyShapeProblem('PNBcxRB2 abc')).toContain('spaces');
    expect(apiKeyShapeProblem('abcdefghijklmnop')).toContain('dot');
  });

  it('looks templates up with the login when the API key is not enough for the list', async () => {
    const c = fakeChat360({
      templates: (init) => ((init.headers as any).Authorization.startsWith('Bearer')
        ? new Response(JSON.stringify([{ template_name: 'welcome_v2', id: TEMPLATE_ID }]), { status: 200 })
        : new Response('{"detail":"Authentication credentials were not provided."}', { status: 401 })),
    });
    await send({ phone: '9876543210', templateName: 'welcome_v2' }, ctx);
    expect(c.to('/service/template/data')).toHaveLength(2);
    expect(JSON.parse(String(c.to('/service/v1/task')[0].init.body)).task_body[0].template_data.template_id).toBe(TEMPLATE_ID);
  });
});

describe('mapContact', () => {
  it('links the contact and back-fills earlier messages', async () => {
    await settingSet('chat360AutoCreateLeads', 'false', 'test');
    await handleWebhook(inbound());
    vi.mocked(leads.getLead).mockResolvedValue(LEAD);
    await mapContact('9876543210', 'ENQ-0007', ctx);
    expect((await messages('9876543210'))[0].leadId).toBe('ENQ-0007');
    expect((await contacts())[0]).toMatchObject({ leadId: 'ENQ-0007', contactName: 'Meera Rao' });
    vi.mocked(leads.getLead).mockResolvedValue(null);
    await expect(mapContact('9876543210', 'ENQ-404', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('webhook route', () => {
  const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('rejects a missing or wrong secret with 403', async () => {
    expect((await webhookPOST(req('http://x/api/webhooks/chat360?company=test', inbound()))).status).toBe(403);
    expect((await webhookPOST(req('http://x/api/webhooks/chat360?company=test&secret=nope', inbound()))).status).toBe(403);
    await t.secret('CHAT360_WEBHOOK_SECRET', '');
    expect((await webhookPOST(req('http://x/api/webhooks/chat360?company=test&secret=', inbound()))).status).toBe(403);
  });

  it('accepts the secret in the header or query, JSON or form bodies, and always answers 200', async () => {
    const a = await webhookPOST(req('http://x/api/webhooks/chat360?company=test', inbound(), { 'x-webhook-secret': 'hook-secret' }));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ status: 'success', data: { ok: true, leadId: 'ENQ-0100' } });

    const form = new URLSearchParams({ event_type: 'message_received', event_response_id: 'evt-form', sender_num: '918888777766', message_text: 'form hello' }).toString();
    const b = await webhookPOST(new Request('http://x/api/webhooks/chat360?company=test&secret=hook-secret', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }));
    expect((await b.json()).status).toBe('success');
    expect((await messages('8888777766'))[0].text).toBe('form hello');

    // a lead-lookup failure is logged but the message is still stored
    vi.mocked(leads.findLeadByPhone).mockRejectedValue(new Error('db down'));
    const c = await webhookPOST(req('http://x/api/webhooks/chat360?company=test&secret=hook-secret', inbound({ event_response_id: 'evt-err', sender_num: '917777666655' })));
    expect(await c.json()).toEqual({ status: 'success', data: { ok: true, leadId: null } });
    expect(await (await col(CFG.COLL.ERROR_LOG)).countDocuments({ scope: 'chat360.resolveLead' })).toBe(1);

    // processing errors still answer 200 (no provider retry storm) and are logged
    const d = await webhookPOST(req('http://x/api/webhooks/chat360?company=test&secret=hook-secret', { pad: 'x'.repeat(1100 * 1024) }));
    expect(d.status).toBe(200);
    expect((await d.json()).status).toBe('error');
    expect(await (await col(CFG.COLL.ERROR_LOG)).countDocuments({ scope: 'webhook:chat360' })).toBe(1);
  });
});
