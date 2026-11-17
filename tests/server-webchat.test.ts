/** Website chatbot: the shared engine driving a public, phone-less chat, captured answers, and the CRM read. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { connectDirect } from '../server/modules/whatsappDirect';
import { type BotStep } from '../server/modules/whatsappBotEngine';
import { saveBot, setBotStatus, simulateBot } from '../server/modules/whatsappBots';
import { botChatsList, webchatAgentReply, webchatTurn } from '../server/modules/webchat';

const SECRET = 'app-secret';
const NUMBER_ID = '10001';
const WABA = '20002';
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
const generate = vi.hoisted(() => vi.fn(async () => 'The clubhouse is open.'));
vi.mock('../server/modules/ai', async (orig) => ({ ...(await orig<any>()), generateText: generate }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fake(input: any): Promise<Response> {
  const path = new URL(String(input)).pathname.replace(/^\/v\d+\.\d+\//, '/');
  if (path === `/${WABA}/phone_numbers`) return json(200, { data: [{ id: NUMBER_ID, display_phone_number: '+91 90000 11111', verified_name: 'Test' }] });
  if (path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
  if (path === `/${WABA}/message_templates`) return json(200, { data: [] });
  return json(404, { error: { message: `unexpected ${path}` } });
}

let t: Awaited<ReturnType<typeof startTestDb>>;
const inCo = async <X>(fn: () => Promise<X>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const step = (id: string, type: BotStep['type'], over: Partial<BotStep> = {}): BotStep => ({ id, type, text: `${id} text`, next: '', saveTo: '', validate: 'text', options: [], days: 3, times: ['11:00'], ...over });
const opt = (id: string, label: string, next = '') => ({ id, label, next });
const FLOW = [
  step('hi', 'message', { text: 'Hello from {company}' }),
  step('name', 'question', { text: 'Your name?', saveTo: 'name' }),
  step('unit', 'choice', { text: 'Which, {first_name}?', saveTo: 'unit', options: [opt('a', '2 BHK', 'bye'), opt('b', '3 BHK', 'bye')] }),
  step('bye', 'end', { text: 'Thanks! We will be in touch.' }),
];

async function finishTest(id: string) {
  let r: any = await inCo(() => simulateBot({ id }));
  for (let i = 0; r.status === 'active' && i < 20; i++) {
    const o = r.out[r.out.length - 1];
    r = await inCo(() => simulateBot({ id, state: r.state, text: o?.options ? o.options[0].label : 'Asha', replyId: o?.options ? o.options[0].id : '' }));
  }
}
async function liveBot(steps = FLOW) {
  const { id } = await inCo(() => saveBot({ name: 'Website enquiry', steps }, ctx));
  await finishTest(id);
  await inCo(() => setBotStatus({ id, status: 'active' }, ctx));
  return id;
}

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
  await t.company('test', { whatsappDirect: true, whatsappBots: true, aiCopilot: true });
  generate.mockReset();
  generate.mockImplementation(async () => 'The clubhouse is open.');
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: 'TOKEN' }, ctx));
});
afterEach(() => vi.unstubAllGlobals());

describe('website chatbot', () => {
  it('starts a fresh chat on the live bot and greets with the first question', async () => {
    await liveBot();
    const r = await inCo(() => webchatTurn({ visitorId: 'v1' }));
    expect(r.sessionId).toMatch(/^wc_[0-9a-f]{32}$/); // an unguessable public session token
    expect(r.status).toBe('active');
    expect(r.done).toBe(false);
    expect(r.messages.map((m) => m.text)).toEqual(['Hello from Test Co', 'Your name?']);
  });

  it('captures a typed answer, then offers the choice as buttons', async () => {
    await liveBot();
    const start = await inCo(() => webchatTurn({ visitorId: 'v1' }));
    const r = await inCo(() => webchatTurn({ sessionId: start.sessionId, text: 'Meera Rao', visitorId: 'v1' }));
    expect(r.status).toBe('active');
    const choice = r.messages.find((m) => m.kind === 'buttons') as any;
    expect(choice).toBeTruthy();
    expect(choice.options.map((o: any) => o.label)).toEqual(['2 BHK', '3 BHK']);
  });

  it('follows a button click to the end and records the captured answers', async () => {
    await liveBot();
    const start = await inCo(() => webchatTurn({ visitorId: 'v1' }));
    await inCo(() => webchatTurn({ sessionId: start.sessionId, text: 'Meera Rao', visitorId: 'v1' }));
    const end = await inCo(() => webchatTurn({ sessionId: start.sessionId, text: '2 BHK', replyId: 'a', visitorId: 'v1' }));
    expect(end.status).toBe('done');
    expect(end.done).toBe(true);
    const list = await inCo(() => botChatsList({}));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ channel: 'website', status: 'done', captured: { name: 'Meera Rao', unit: '2 BHK' } });
  });

  it('refuses when a sessionId points at an ended chat (widget then starts over)', async () => {
    await liveBot();
    const start = await inCo(() => webchatTurn({ visitorId: 'v1' }));
    await inCo(() => webchatTurn({ sessionId: start.sessionId, text: 'Meera Rao', visitorId: 'v1' }));
    await inCo(() => webchatTurn({ sessionId: start.sessionId, text: '2 BHK', replyId: 'a', visitorId: 'v1' }));
    const again = await inCo(() => webchatTurn({ sessionId: start.sessionId, text: 'hi again', visitorId: 'v1' }));
    expect(again.done).toBe(true);
    expect(again.messages).toHaveLength(0);
  });

  it('creates a CRM lead when the website chat captures contact details', async () => {
    const flow = [
      step('hi', 'message', { text: 'Hi' }),
      step('em', 'question', { text: 'Your email?', saveTo: 'email' }),
      step('bye', 'end', { text: 'Thanks' }),
    ];
    await liveBot(flow);
    const start = await inCo(() => webchatTurn({ visitorId: 'v9' }));
    const end = await inCo(() => webchatTurn({ sessionId: start.sessionId, text: 'meera@example.com', visitorId: 'v9' }));
    expect(end.status).toBe('done');
    const list = await inCo(() => botChatsList({}));
    const leadId = list[0].leadId;
    expect(leadId).toBeTruthy();
    const lead = await inCo(async () => (await col<any>(CFG.COLL.LEADS)).findOne({ _id: leadId }));
    expect(lead).toBeTruthy();
    expect(lead.source).toBe('Website');
    expect(lead.email).toBe('meera@example.com');
  });

  it('only answers on the website when the bot is turned on for that channel', async () => {
    const { id } = await inCo(() => saveBot({ name: 'IG only', steps: FLOW, channels: ['instagram'] }, ctx));
    await finishTest(id);
    await inCo(() => setBotStatus({ id, status: 'active' }, ctx));
    await expect(inCo(() => webchatTurn({ visitorId: 'vx' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets an agent take over: the agent replies, the visitor polls and sees it, and the bot stops', async () => {
    const flow = [step('hi', 'message', { text: 'Hello' }), step('q', 'question', { text: 'Your name?', saveTo: 'name' })];
    await liveBot(flow);
    const start = await inCo(() => webchatTurn({ visitorId: 'vA' }));
    expect(start.status).toBe('active');
    const r = await inCo(() => webchatAgentReply({ sessionId: start.sessionId, text: 'Hi, Asha from the team here.' }, ctx));
    expect(r.ok).toBe(true);
    const poll = await inCo(() => webchatTurn({ sessionId: start.sessionId, poll: true, since: start.seq }));
    expect(poll.mode).toBe('agent');
    expect(poll.messages.some((m) => m.text.includes('Asha'))).toBe(true);
    const v = await inCo(() => webchatTurn({ sessionId: start.sessionId, text: 'okay thanks', since: 0 }));
    expect(v.mode).toBe('agent');
    expect(v.messages).toHaveLength(0);
  });

  it('is blocked without the plan feature', async () => {
    await t.company('nofeature', { whatsappBots: false });
    invalidateTenant();
    await expect(runWithTenant((await getTenantById('CMP-nofeature'))!, () => webchatTurn({ visitorId: 'v1' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
