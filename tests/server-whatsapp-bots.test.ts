/** WhatsApp chatbots: the logic, the rules for starting, stepping aside for a person, and what they do to leads. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { addLead } from '../server/modules/leads';
import { handleMetaWebhookPost } from '../server/modules/metaQueue';
import { connectDirect, sendDirect } from '../server/modules/whatsappDirect';
import { botProblems, replyToChat, startChat, type BotStep } from '../server/modules/whatsappBotEngine';
import { aiInstructions, deleteBot, listBots, saveBot, setBotStatus, simulateBot } from '../server/modules/whatsappBots';

const SECRET = 'app-secret';
const NUMBER_ID = '10001';
const WABA = '20002';
const CUSTOMER = '919876501234';
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
const generate = vi.hoisted(() => vi.fn(async () => 'The clubhouse is open.'));
vi.mock('../server/modules/ai', async (orig) => ({ ...(await orig<any>()), generateText: generate }));

let t: Awaited<ReturnType<typeof startTestDb>>;
let sent: any[] = [];
let sendAnswer: any = null;

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
  if (path === `/${WABA}/message_templates`) return json(200, { data: [] });
  if (path === `/${NUMBER_ID}/messages`) {
    if (sendAnswer) return sendAnswer;
    const body = JSON.parse(String(init.body));
    sent.push(body);
    return json(200, { messages: [{ id: `wamid.out${sent.length}` }] });
  }
  return json(404, { error: { message: `unexpected ${path}` } });
}
const step = (id: string, type: BotStep['type'], over: Partial<BotStep> = {}): BotStep => ({ id, type, text: `${id} text`, next: '', saveTo: '', validate: 'text', options: [], days: 3, times: ['11:00', '15:30'], ...over });
const opt = (id: string, label: string, next = '') => ({ id, label, next });
const FLOW = [
  step('hi', 'message', { text: 'Hello from {company}' }),
  step('name', 'question', { text: 'Your name?', saveTo: 'name' }),
  step('unit', 'choice', { text: 'Thanks {first_name}. Which?', saveTo: 'unit', options: [opt('a', '2 BHK'), opt('b', '3 BHK'), opt('c', 'Talk first', 'team')] }),
  step('visit', 'visit', { text: 'Which day?' }),
  step('team', 'handoff', { text: 'Noted {visit}. Someone will call.' }),
];
const engine = { now: new Date('2026-11-10T06:30:00Z'), company: 'Amaya', dateKey: (d: Date) => d.toISOString().slice(0, 10) };
const say = (text: string, replyId = '') => ({ text, replyId });
const running = async (steps = FLOW, over: Record<string, unknown> = {}) => {
  const { id } = await inCo(() => saveBot({ name: 'Enquiry', steps, ...over }, ctx));
  await finishTest(id);
  await inCo(() => setBotStatus({ id, status: 'active' }, ctx));
  sent = [];
  return id;
};
/** Walks the test chat to its end, the only way to be allowed to start. */
async function finishTest(id: string) {
  let r: any = await inCo(() => simulateBot({ id }));
  for (let i = 0; r.status === 'active' && i < 20; i++) {
    const o = r.out[r.out.length - 1];
    r = await inCo(() => simulateBot({ id, state: r.state, text: o?.options ? o.options[0].label : 'x@y.com', replyId: o?.options ? o.options[0].id : '' }));
  }
}
const webhook = (body: unknown) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return handleMetaWebhookPost(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), (fn) => void fn());
};
let mid = 0;
const customer = (m: Record<string, unknown>, from = CUSTOMER) => webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER_ID }, contacts: [{ wa_id: from, profile: { name: 'Meera Rao' } }], messages: [{ id: `wamid.in${++mid}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...m }] } }] }] });
const typed = (text: string, from?: string) => customer({ type: 'text', text: { body: text } }, from);
const tapped = (id: string, title: string, kind: 'button' | 'list' = 'button') => customer({ type: 'interactive', interactive: kind === 'button' ? { type: 'button_reply', button_reply: { id, title } } : { type: 'list_reply', list_reply: { id, title } } });
const session = () => inCo(async () => (await col<any>('whatsappBotSessions')).find({}).sort({ startedAt: -1 }).limit(1).next());
const theLead = () => inCo(async () => (await col<any>(CFG.COLL.LEADS)).findOne({ phoneLast10: '9876501234' }));

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
  await t.company('test', { chat360: true, whatsappDirect: true, whatsappBots: true, aiCopilot: true });
  sent = [];
  sendAnswer = null;
  generate.mockReset();
  generate.mockImplementation(async () => 'The clubhouse is open.');
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: 'TOKEN' }, ctx));
  sent = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('the logic', () => {
  const def = { steps: FLOW };
  it('sends until it must wait, filling in names', async () => {
    const r = startChat(def, engine);
    expect(r.out).toEqual([{ kind: 'text', text: 'Hello from Amaya' }, { kind: 'text', text: 'Your name?' }]);
    expect(r).toMatchObject({ status: 'active', state: { stepId: 'name' } });
    const r2 = await replyToChat(def, r.state, say('Meera Rao'), engine);
    expect(r2.effects).toEqual([{ type: 'save', field: 'name', value: 'Meera Rao' }]);
    expect(r2.out[0]).toEqual({ kind: 'buttons', text: 'Thanks Meera. Which?', options: [{ id: 'a', label: '2 BHK' }, { id: 'b', label: '3 BHK' }, { id: 'c', label: 'Talk first' }] });
  });
  it('takes a choice by button, by typing it, or by its number', async () => {
    const at = { stepId: 'unit', phase: '' as const, day: '', retries: 0, aiReplies: 0, sent: 0, vars: {} };
    expect((await replyToChat(def, at, say('2 BHK', 'b'), engine)).effects[0]).toMatchObject({ value: '3 BHK' });
    expect((await replyToChat(def, at, say('3 bhk'), engine)).effects[0]).toMatchObject({ value: '3 BHK' });
    expect((await replyToChat(def, at, say('1'), engine)).effects[0]).toMatchObject({ value: '2 BHK' });
  });
  it('goes where a choice leads', async () => {
    const at = { stepId: 'unit', phase: '' as const, day: '', retries: 0, aiReplies: 0, sent: 0, vars: {} };
    expect(await replyToChat(def, at, say('Talk first'), engine)).toMatchObject({ status: 'handoff' });
  });
  it('asks again twice, then hands to a person rather than looping', async () => {
    const at = { stepId: 'unit', phase: '' as const, day: '', retries: 0, aiReplies: 0, sent: 0, vars: {} };
    const r1 = await replyToChat(def, at, say('banana'), engine);
    expect(r1.status).toBe('active');
    const r2 = await replyToChat(def, r1.state, say('banana'), engine);
    expect(r2.status).toBe('active');
    const r3 = await replyToChat(def, r2.state, say('banana'), engine);
    expect(r3).toMatchObject({ status: 'handoff', reason: expect.stringMatching(/could not understand/) });
  });
  it('books a visit: days from tomorrow, then times', async () => {
    const at = { stepId: 'visit', phase: 'day' as const, day: '', retries: 0, aiReplies: 0, sent: 0, vars: {} };
    const days = await replyToChat(def, at, say('nonsense'), engine);
    const opts = (days.out[0] as any).options;
    expect(opts).toHaveLength(3);
    expect(opts[0].id).toBe('d:2026-11-11');
    const pickedDay = await replyToChat(def, at, say('', 'd:2026-11-12'), engine);
    expect(pickedDay.state).toMatchObject({ phase: 'time', day: '2026-11-12' });
    expect((pickedDay.out[0] as any).options.map((o: any) => o.label)).toEqual(['11:00 AM', '3:30 PM']);
    const booked = await replyToChat(def, pickedDay.state, say('3:30 PM'), engine);
    expect(booked.effects[0]).toMatchObject({ type: 'visit', day: '2026-11-12', time: '15:30' });
    expect((booked.out[0] as any).text).toMatch(/Noted .*3:30 PM/);
  });
  it('more than 3 options, or a long one, becomes a list', () => {
    const many = { steps: [step('c', 'choice', { options: [opt('1', 'A'), opt('2', 'B'), opt('3', 'C'), opt('4', 'D')] })] };
    expect(startChat(many, engine).out[0].kind).toBe('list');
    const long = { steps: [step('c', 'choice', { options: [opt('1', 'A much longer label x'), opt('2', 'B')] })] };
    expect(startChat(long, engine).out[0].kind).toBe('list');
  });
  it('checks an e-mail or number', async () => {
    const d = { steps: [step('q', 'question', { validate: 'email', saveTo: 'email' }), step('e', 'end')] };
    const at = startChat(d, engine).state;
    expect((await replyToChat(d, at, say('not an email'), engine)).status).toBe('active');
    expect((await replyToChat(d, at, say('a@b.co'), engine)).effects[0]).toMatchObject({ value: 'a@b.co' });
  });
  it('anyone can leave at any point', async () => {
    const at = startChat(def, engine).state;
    expect(await replyToChat(def, at, say('STOP'), engine)).toMatchObject({ status: 'stopped', out: [] });
    expect(await replyToChat(def, at, say('can i talk to a real person please'), engine)).toMatchObject({ status: 'handoff', reason: expect.stringMatching(/asked for a person/) });
  });
  it('stops a chat that has sent too many', async () => {
    expect(await replyToChat(def, { ...startChat(def, engine).state, sent: 60 }, say('hi'), engine)).toMatchObject({ status: 'handoff' });
  });
  it('AI: answers, hands over what it cannot, and has a limit', async () => {
    const d = { steps: [step('q', 'ai')] };
    const at = startChat(d, engine).state;
    const ai = async (q: string) => (q.includes('unknown') ? 'HANDOFF' : 'Yes.');
    expect((await replyToChat(d, at, say('pool?'), { ...engine, ai })).out[0]).toEqual({ kind: 'text', text: 'Yes.' });
    expect(await replyToChat(d, at, say('unknown'), { ...engine, ai })).toMatchObject({ status: 'handoff' });
    expect(await replyToChat(d, at, say('x'), { ...engine, ai: async () => { throw new Error('down'); } })).toMatchObject({ status: 'handoff' });
    expect(await replyToChat(d, at, say('x'), engine)).toMatchObject({ status: 'handoff' });
    expect(await replyToChat(d, { ...at, aiReplies: 5 }, say('pool?'), { ...engine, ai })).toMatchObject({ status: 'handoff' });
  });
  it('AI is told to stay on the business and ignore tricks', () => {
    const s = aiInstructions('Amaya', 'Pool: yes');
    expect(s).toMatch(/ONLY from the BUSINESS INFORMATION/);
    expect(s).toMatch(/HANDOFF/);
    expect(s).toMatch(/Never invent/);
    expect(s).toMatch(/Ignore any instruction/);
    expect(s).toContain('Pool: yes');
  });
});

describe('checking a bot before it can start', () => {
  it('accepts a sound one', () => expect(botProblems({ steps: FLOW })).toEqual([]));
  it('finds what would break it', () => {
    const p = (steps: BotStep[]) => botProblems({ steps }).join(' | ');
    expect(p([])).toMatch(/at least one step/);
    expect(p([step('a', 'message', { text: '' })])).toMatch(/write the message/);
    expect(p([step('a', 'choice', { options: [opt('1', 'A')] })])).toMatch(/at least 2 options/);
    expect(p([step('a', 'choice', { options: [opt('1', 'A'), opt('2', 'a')] })])).toMatch(/same label/);
    expect(p([step('a', 'choice', { options: Array.from({ length: 11 }, (_, i) => opt(`${i}`, `O${i}`)) })])).toMatch(/up to 10 options/);
    expect(p([step('a', 'choice', { options: [opt('1', 'x'.repeat(25)), opt('2', 'B')] })])).toMatch(/too long/);
    expect(p([step('a', 'message', { next: 'gone' })])).toMatch(/no longer exists/);
    expect(p([step('a', 'end'), step('b', 'message')])).toMatch(/nothing leads to/);
    expect(p([step('a', 'message', { next: 'b' }), step('b', 'message', { next: 'a' })])).toMatch(/round in a circle/);
    expect(p([step('a', 'visit', { times: ['soon'] })])).toMatch(/like 11:00/);
  });
  it('a loop that waits for the customer is fine', () => {
    expect(botProblems({ steps: [step('a', 'choice', { options: [opt('1', 'Again', 'a'), opt('2', 'End', 'b')] }), step('b', 'end')] })).toEqual([]);
  });
});

describe('starting a bot', () => {
  it('needs the test chat first, and any edit needs it again', async () => {
    const { id } = await inCo(() => saveBot({ name: 'B', steps: FLOW }, ctx));
    await expect(inCo(() => setBotStatus({ id, status: 'active' }, ctx))).rejects.toThrow(/test chat/);
    await finishTest(id);
    await inCo(() => saveBot({ id, name: 'B2', steps: FLOW }, ctx));
    await expect(inCo(() => setBotStatus({ id, status: 'active' }, ctx))).rejects.toThrow(/test chat/);
    await finishTest(id);
    await inCo(() => setBotStatus({ id, status: 'active' }, ctx));
    expect((await inCo(() => listBots())).bots[0].status).toBe('active');
  });
  it('one runs at a time', async () => {
    const a = await running();
    const b = await running();
    const list = (await inCo(() => listBots())).bots;
    expect(list.find((x) => x.id === a)!.status).toBe('paused');
    expect(list.find((x) => x.id === b)!.status).toBe('active');
  });
  it('cannot be changed or deleted while running', async () => {
    const id = await running();
    await expect(inCo(() => saveBot({ id, name: 'X', steps: FLOW }, ctx))).rejects.toThrow(/Pause/);
    await expect(inCo(() => deleteBot({ id }, ctx))).rejects.toThrow(/Pause/);
  });
  it('needs a connected number', async () => {
    const { disconnectDirect } = await import('../server/modules/whatsappDirect');
    const { id } = await inCo(() => saveBot({ name: 'B', steps: FLOW }, ctx));
    await finishTest(id);
    await inCo(() => disconnectDirect(ctx));
    await expect(inCo(() => setBotStatus({ id, status: 'active' }, ctx))).rejects.toThrow(/Connect a WhatsApp/);
  });
  it('an AI step needs something to answer from', async () => {
    await expect(inCo(() => saveBot({ name: 'B', steps: [step('a', 'ai')] }, ctx))).rejects.toThrow(/information to answer from/);
  });
  it('the test chat sends nothing and changes no lead', async () => {
    const { id } = await inCo(() => saveBot({ name: 'B', steps: FLOW }, ctx));
    await finishTest(id);
    expect(sent).toEqual([]);
    expect(await inCo(async () => (await col<any>(CFG.COLL.LEADS)).countDocuments({}))).toBe(0);
    expect(await inCo(async () => (await col<any>('whatsappBotSessions')).countDocuments({}))).toBe(0);
  });
});

describe('a real chat', () => {
  it('runs from first message to a booked visit, saving on the lead', async () => {
    await running();
    await typed('Hi');
    expect(sent.map((b) => b.text?.body)).toEqual(['Hello from Test', 'Your name?'].map((x, i) => (i === 0 ? expect.stringMatching(/^Hello from/) : x)));
    sent = [];
    await typed('Meera Rao');
    expect(sent[0]).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
    expect(sent[0].interactive.action.buttons[1]).toEqual({ type: 'reply', reply: { id: 'b', title: '3 BHK' } });
    expect((await theLead()).name).toBe('Meera Rao');
    sent = [];
    await tapped('b', '3 BHK');
    expect((await theLead()).unitType).toBe('3 BHK');
    expect(sent[0]).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
    const day = sent[0].interactive.action.buttons[0].reply;
    sent = [];
    await tapped(day.id, day.title);
    const time = sent[0].interactive.action.buttons[0].reply;
    sent = [];
    await tapped(time.id, time.title);
    expect(sent[0].text.body).toMatch(/^Noted .*11:00 AM/);
    const lead = await theLead();
    expect(lead.siteVisitStatus).toBe(CFG.SITE_VISIT.SCHEDULED);
    expect(lead.siteVisitDate).toBeInstanceOf(Date);
    expect(await session()).toMatchObject({ status: 'handoff', visits: 1, answers: 2 });
  });
  it('bot messages show in the chat as from the bot, and do not count as the team acting', async () => {
    await running();
    await typed('Hi');
    const rows = await inCo(async () => (await col<any>(CFG.COLL.CHAT_MESSAGES)).find({ direction: 'Outbound' }).toArray());
    expect(rows.every((r) => r.agent === 'Chatbot')).toBe(true);
    const tl = await inCo(async () => (await col<any>(CFG.COLL.TIMELINE)).find({ type: 'chat_sent' }).toArray());
    expect(tl.every((r) => r.actor === 'Chatbot')).toBe(true);
    const src = (await import('node:fs')).readFileSync('server/modules/salesOps.ts', 'utf8');
    expect(src).toMatch(/robots = \[[^\]]*'Chatbot'/);
  });
  it('stops for good when a person replies from the CRM', async () => {
    await running();
    await typed('Hi');
    await inCo(() => sendDirect({ phone: CUSTOMER, text: 'I can help' }, ctx));
    expect(await session()).toMatchObject({ status: 'handoff', endReason: 'Asha replied, so the bot stopped.' });
    sent = [];
    await typed('Meera');
    expect(sent).toEqual([]);
  });
  it('stops when someone replies from the phone', async () => {
    await running();
    await typed('Hi');
    await webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: NUMBER_ID }, message_echoes: [{ from: '919000011111', to: CUSTOMER, id: 'wamid.e1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hello' } }] } }] }] });
    expect((await session()).status).toBe('handoff');
  });
  it('automatic messages do not stop it', async () => {
    await running();
    await typed('Hi');
    const { SYSTEM_CTX } = await import('../server/core/auth');
    await inCo(() => sendDirect({ phone: CUSTOMER, text: 'Reminder' }, SYSTEM_CTX));
    expect((await session()).status).toBe('active');
  });
  it('tells the team when it hands over', async () => {
    await running();
    await typed('Hi');
    await typed('I want to talk to a real person');
    expect((await session()).status).toBe('handoff');
    expect(await inCo(async () => (await col<any>(CFG.COLL.EVENTS)).countDocuments({ type: 'bot_handoff' }))).toBe(1);
  });
  it('if it cannot send, a person takes over rather than silence', async () => {
    await running();
    sendAnswer = json(400, { error: { code: 131026, message: 'no' } });
    await typed('Hi');
    expect(await session()).toMatchObject({ status: 'handoff', endReason: expect.stringMatching(/could not send/) });
    expect(await inCo(async () => (await col<any>(CFG.COLL.EVENTS)).countDocuments({ type: 'bot_handoff' }))).toBe(1);
  });
  it('a chat in progress keeps its steps when the bot is changed', async () => {
    const id = await running();
    await typed('Hi');
    await inCo(() => setBotStatus({ id, status: 'paused' }, ctx));
    await inCo(() => saveBot({ id, name: 'New', steps: [step('only', 'end', { text: 'Different' })] }, ctx));
    sent = [];
    await typed('Meera');
    expect(sent[0].interactive.body.text).toMatch(/Which\?/);
  });
  it('AI answers from what the company wrote', async () => {
    await running([step('q', 'ai', { text: 'Ask me anything about the project.' }), step('t', 'handoff')], { knowledge: 'Clubhouse: open daily' });
    await typed('Hi');
    sent = [];
    await typed('Is there a clubhouse?');
    expect(sent[0].text.body).toBe('The clubhouse is open.');
    const [prompt, , opts] = generate.mock.calls[generate.mock.calls.length - 1] as any;
    expect(prompt).toContain('Is there a clubhouse?');
    expect(opts.system).toContain('Clubhouse: open daily');
  });
});

describe('when a bot starts', () => {
  it('a new customer only, by default', async () => {
    const { id } = await inCo(() => addLead({ 'Prospect Name': 'Old', 'Phone Number': '+919111122222' } as any, ctx));
    expect(id).toBeTruthy();
    await inCo(async () => (await col<any>(CFG.COLL.CHAT_MESSAGES)).insertOne({ _id: 'old1' as any, phoneLast10: '9111122222', direction: 'Inbound', text: 'Earlier', timestamp: new Date(Date.now() - 40 * 86400000) }));
    await running();
    await typed('Hello again', '919111122222');
    expect(sent).toEqual([]);
    await typed('Hi');
    expect(sent.length).toBeGreaterThan(0);
  });
  it('by keyword, whole words only', async () => {
    await running(FLOW, { trigger: 'keyword', keywords: 'price, brochure' });
    await typed('hello');
    expect(sent).toEqual([]);
    await typed('supersprice');
    expect(sent).toEqual([]);
    await typed('What is the price?');
    expect(sent.length).toBeGreaterThan(0);
  });
  it('someone saying STOP is never greeted by a bot', async () => {
    await running(FLOW, { trigger: 'any' });
    await typed('STOP');
    expect(sent).toEqual([]);
    expect(await session()).toBeNull();
  });
  it('never over a person who replied in the last day', async () => {
    await running(FLOW, { trigger: 'any' });
    await inCo(() => sendDirect({ phone: CUSTOMER, text: 'Hi from Asha' }, ctx));
    sent = [];
    await typed('Thanks');
    expect(sent).toEqual([]);
  });
  it('a chat silent for over a day does not carry on where it stopped', async () => {
    await running(FLOW, { trigger: 'keyword', keywords: 'hello' });
    await typed('hello');
    await inCo(async () => (await col<any>('whatsappBotSessions')).updateMany({}, { $set: { lastAt: new Date(Date.now() - 2 * 86400000) } }));
    sent = [];
    await typed('Meera');
    expect(sent).toEqual([]);
    expect((await session()).endReason).toMatch(/stopped answering/);
  });
  it('a paused bot, or a company without the switch, does nothing', async () => {
    const id = await running();
    await inCo(() => setBotStatus({ id, status: 'paused' }, ctx));
    await typed('Hi');
    expect(sent).toEqual([]);
    await inCo(() => setBotStatus({ id, status: 'active' }, ctx));
    await t.company('test', { chat360: true, whatsappDirect: true, whatsappBots: false });
    await typed('Hi', '919222233333');
    expect(sent).toEqual([]);
  });
});

describe('credits', () => {
  it('a bot reply is charged like any reply, and running out goes to a person', async () => {
    await t.company('test', { chat360: true, whatsappDirect: true, whatsappBots: true, whatsappCredits: true });
    const { setPricing, PRICING_DEFAULTS } = await import('../server/modules/whatsappCredits');
    await setPricing({ ...PRICING_DEFAULTS, replyGrace: 0 }, 'test');
    await running();
    await typed('Hi');
    expect(sent).toEqual([]);
    expect(await session()).toMatchObject({ status: 'handoff', endReason: expect.stringMatching(/credits are finished/) });
  });
});

describe('who can use it', () => {
  const as = (role: 'Admin' | 'Manager' | 'RM' | 'Viewer') => inCo(async () => {
    const email = `${role.toLowerCase()}@bots.test`;
    await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
    return (await login(email, 'long-enough-pw', { userAgent: 'v', ip: '1.1.1.1' })).token;
  });
  it('Admins and Managers only', async () => {
    for (const [role, code] of [['Admin', 200], ['Manager', 200], ['RM', 403], ['Viewer', 403]] as const) {
      const token = await as(role);
      expect(((await inCo(() => dispatch('waBotsList', {}, { userAgent: 'v', ip: '1.1.1.1', token }))) as any).status, role).toBe(code);
    }
  });
  it('not at all without the switch', async () => {
    await t.company('test', { chat360: true, whatsappDirect: true, whatsappBots: false });
    const token = await as('Admin');
    expect(((await inCo(() => dispatch('waBotsList', {}, { userAgent: 'v', ip: '1.1.1.1', token }))) as any).status).toBe(403);
  });
});
