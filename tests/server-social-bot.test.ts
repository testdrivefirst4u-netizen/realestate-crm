/** Instagram / Facebook chatbot: a new inbound DM drives the shared engine, replies go out, answers become a lead. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { type BotStep } from '../server/modules/whatsappBotEngine';

const generate = vi.hoisted(() => vi.fn(async () => 'An answer.'));
vi.mock('../server/modules/ai', async (orig) => ({ ...(await orig<any>()), generateText: generate }));

// stub the Graph sender: record what the bot sends and drop an outbound item in the thread (so the human-guard works)
const sent = vi.hoisted(() => [] as string[]);
vi.mock('../server/modules/socialInbox', async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    replyInbox: vi.fn(async (d: any, ctx: any) => {
      sent.push(String(d.text));
      await (await actual.inboxCol()).updateOne({ _id: `instagram:out${sent.length}` }, { $setOnInsert: { platform: 'instagram', kind: 'message', thread: d.thread, account: 'acc', externalId: '', authorId: '', authorName: ctx.user?.name || '', text: d.text, direction: 'out', at: new Date(), read: true, by: ctx.user?.name || '' } }, { upsert: true });
      return { ok: true };
    }),
  };
});

import { onSocialMessage } from '../server/modules/socialBot';
import { inboxCol } from '../server/modules/socialInbox';

const THREAD = 'ig:dm:acc:u1';
const ctxUser: any = { user: { name: 'Asha', role: 'Admin' } };
let t: Awaited<ReturnType<typeof startTestDb>>;
const inCo = async <X>(fn: () => Promise<X>) => { invalidateTenant(); return runWithTenant((await getTenantById('CMP-test'))!, fn); };
const step = (id: string, type: BotStep['type'], over: Partial<BotStep> = {}): BotStep => ({ id, type, text: `${id} text`, next: '', saveTo: '', validate: 'text', options: [], days: 3, times: ['11:00'], ...over });

const FLOW: BotStep[] = [
  step('hi', 'message', { text: 'Hello' }),
  step('nm', 'question', { text: 'Your name?', saveTo: 'name' }),
  step('em', 'question', { text: 'Your email?', saveTo: 'email' }),
  step('bye', 'end', { text: 'Thanks' }),
];

async function activeBot(steps = FLOW, trigger: 'new' | 'keyword' | 'any' = 'any', keywords: string[] = [], channels: string[] = ['whatsapp', 'website', 'instagram', 'facebook']) {
  await inCo(async () => (await col<any>('whatsappBots')).insertOne({ _id: 'BOT1', name: 'Enquiry', status: 'active', trigger, keywords, channels, steps, knowledge: '', tested: true, rev: 1, createdBy: 'System', createdAt: new Date(), updatedAt: new Date() }));
}
let mid = 0;
async function dm(text: string) {
  mid++;
  const item: any = { _id: `instagram:m${mid}`, platform: 'instagram', kind: 'message', thread: THREAD, account: 'acc', externalId: `m${mid}`, authorId: 'u1', authorName: '', text, direction: 'in', at: new Date(), read: false };
  await inCo(async () => { await (await inboxCol()).insertOne(item); });
  await inCo(() => onSocialMessage(item));
}

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await t.company('test', { socialInbox: true, aiCopilot: true });
  sent.length = 0;
  mid = 0;
  generate.mockReset();
  generate.mockImplementation(async () => 'An answer.');
});
afterEach(() => vi.clearAllMocks());

describe('Instagram / Facebook chatbot', () => {
  it('starts on the first DM, walks the flow, and makes a lead from captured answers', async () => {
    await activeBot();
    await dm('hi');
    expect(sent).toEqual(['Hello', 'Your name?']);
    await dm('Meera');
    expect(sent).toContain('Your email?');
    await dm('meera@ig.com');
    expect(sent).toContain('Thanks');

    const session = await inCo(async () => (await col<any>('socialBotSessions')).findOne({ thread: THREAD }));
    expect(session).toMatchObject({ status: 'done', platform: 'instagram', captured: { name: 'Meera', email: 'meera@ig.com' } });
    expect(session.leadId).toBeTruthy();
    const lead = await inCo(async () => (await col<any>(CFG.COLL.LEADS)).findOne({ _id: session.leadId }));
    expect(lead.source).toBe('Instagram');
    expect(lead.email).toBe('meera@ig.com');
  });

  it('does not start over a human who already replied in the thread', async () => {
    await activeBot();
    // a human reply in the thread (by someone other than the bot) within the last day
    await inCo(async () => (await inboxCol()).insertOne({ _id: 'instagram:human1', platform: 'instagram', kind: 'message', thread: THREAD, account: 'acc', externalId: 'h1', authorId: '', authorName: 'Asha', text: 'hi there', direction: 'out', at: new Date(), read: true, by: 'Asha' } as any));
    await dm('hello?');
    expect(sent).toEqual([]);
  });

  it('does not answer Instagram when the bot is turned on for the website only', async () => {
    await activeBot(FLOW, 'any', [], ['website']);
    await dm('hi');
    expect(sent).toEqual([]);
  });

  it('shows choice options as numbered text and matches a number back', async () => {
    const opt = (id: string, label: string, next = '') => ({ id, label, next });
    const flow: BotStep[] = [
      step('pick', 'choice', { text: 'Which budget?', saveTo: 'budget', options: [opt('a', 'Under 1 Cr', 'bye'), opt('b', '1-2 Cr', 'bye')] }),
      step('bye', 'end', { text: 'Noted' }),
    ];
    await activeBot(flow);
    await dm('hi');
    expect(sent.join('\n')).toContain('1. Under 1 Cr');
    expect(sent.join('\n')).toContain('2. 1-2 Cr');
    await dm('2');
    const session = await inCo(async () => (await col<any>('socialBotSessions')).findOne({ thread: THREAD }));
    expect(session.captured.budget).toBe('1-2 Cr');
  });
});
