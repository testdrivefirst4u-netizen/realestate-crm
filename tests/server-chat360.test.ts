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
import { settingSet } from '../server/core/settings';
import type { Ctx } from '../server/core/auth';
import * as leads from '../server/modules/leads';
import { contacts, handleWebhook, mapContact, markRead, messages, send, test as chatTest } from '../server/modules/chat360';
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message_id: 'wamid.out1' }), { status: 200 }));
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

describe('outbound', () => {
  it('sends text through the configured endpoint with the auth header and a timeout', async () => {
    vi.mocked(leads.findLeadByPhone).mockResolvedValue(LEAD);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { message_id: 'wamid.X' } }), { status: 200 }));
    const { message } = await send({ phone: '98765 43210', text: 'Hello' }, ctx);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.chat360.io/api/v1/messages/send');
    expect((init.headers as any).Authorization).toBe('Bearer c360-key');
    expect(JSON.parse(String(init.body))).toEqual({ to: '919876543210', type: 'text', text: 'Hello', message: 'Hello' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(message).toMatchObject({ id: 'wamid.X', direction: 'Outbound', leadId: 'ENQ-0007', contactName: 'Meera Rao', agent: 'Ravi', status: 'sent' });
    expect(await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId: 'ENQ-0007', type: 'chat_sent' })).toBe(1);
    expect(await (await col(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'WhatsApp Sent' })).toBe(1);
    expect((await contacts())[0].lastMessage).toBe('Hello');
  });

  it('sends templates to the template path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const { message } = await send({ phone: '9876543210', templateName: 'welcome', params: ['Meera', 'Sat'] }, ctx);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.chat360.io/api/v1/messages/template');
    expect(message.text).toBe('[Template: welcome] Meera | Sat');
    expect(message.messageType).toBe('template');
  });

  it('validates input, requires a key and reports upstream rejection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad token', { status: 401 }));
    await expect(send({ phone: '123', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(send({ phone: '9876543210' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(send({ phone: '9876543210', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'SERVER', message: expect.stringContaining('HTTP 401') });
    expect(await (await col(CFG.COLL.CHAT_MESSAGES)).countDocuments({})).toBe(0);
    await t.secret('CHAT360_API_KEY', '');
    fetchMock.mockClear();
    await expect(send({ phone: '9876543210', text: 'x' }, ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await chatTest()).ok).toBe(false);
  });

  it('test() reports reachability', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    const r = await chatTest();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Webhook secret set');
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
