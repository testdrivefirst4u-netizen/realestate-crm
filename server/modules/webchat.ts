/**
 * Website chatbot + live chat: the same bot engine (src/core/botEngine.ts) answers visitors through an embeddable
 * widget, and when the bot hands off, an available agent is connected and can chat with the visitor in real time.
 *
 * Public (no sign-in) runtime: a visitor has no phone, so chats are keyed by a random visitor id. Captured answers
 * become a CRM lead (source "Website"). On handoff the chat switches to "agent" mode: the visitor keeps talking,
 * the assigned agent replies from the CRM, and the widget polls for new messages. Shared knowledge/AI/lead/agent
 * logic lives in botRuntime.ts. Nothing here touches the WhatsApp bot code, Chat360 or the live number.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addEvent, logError } from '../core/events';
import { currentTenant, tenantKey } from '../core/tenant';
import { randomToken, shortId, str, truncate } from '../core/utils';
import { activeBotFilter, assignAvailableAgent, availableAgents, botContext, bumpDailyCount, mergeKnowledge, myChatAvailability, setChatAvailability, upsertBotLead } from './botRuntime';
import { replyToChat, startChat, type BotStep, type ChatState, type ChatStatus, type Effect, type Outgoing, type StepResult } from './whatsappBotEngine';

const DAY_MS = 86400000;
const MAX_TRANSCRIPT = 120;
const SESSIONS_PER_DAY = 5000; // per-company cap on new website chats a day (abuse / DB-bloat guard)
const LEADS_PER_DAY = 500; // per-company cap on website-chat leads a day (junk-lead guard)

export type WidgetMsg = Outgoing & { from?: 'bot' | 'agent' };
type ChatMode = 'bot' | 'agent';

/** A TTL index so finished website chats are cleaned up automatically (45 days), per company. */
const webchatIndex = new Map<string, Promise<unknown>>();
async function ensureWebchatIndex(): Promise<void> {
  const k = tenantKey();
  if (!webchatIndex.has(k)) webchatIndex.set(k, sessionsCol().then((c) => c.createIndex({ lastAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 45 })).catch((e) => { webchatIndex.delete(k); console.error('[webchat] index', e?.message); }));
  await webchatIndex.get(k);
}

interface BotDoc { _id: string; name: string; status: 'draft' | 'active' | 'paused'; steps: BotStep[]; knowledge: string }
interface TranscriptLine { role: 'bot' | 'user' | 'agent'; text: string; at: Date; seq: number }
interface WebSessionDoc {
  _id: string; botId: string; botName: string; visitorId: string; leadId: string; steps: BotStep[]; knowledge: string; state: ChatState;
  status: ChatStatus; mode: ChatMode; assignedAgent: string; assignedAgentId: string; endReason: string; captured: Record<string, string>; transcript: TranscriptLine[]; seq: number;
  origin: string; ip: string; visits: number; answers: number; startedAt: Date; lastAt: Date; endedAt?: Date;
}

const botsCol = () => col<BotDoc>('whatsappBots');
const sessionsCol = () => col<WebSessionDoc>('webchatSessions');
const locksCol = () => col<{ _id: string; until: Date }>('webchatLocks');

const featureOn = () => !!(currentTenant()?.features as any)?.whatsappBots;

/** Serverless: two instances can get a visitor's two quick clicks. One at a time, or the chat would skip a step. */
async function withChatLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const locks = await locksCol();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await locks.updateOne({ _id: key, until: { $lt: new Date() } }, { $set: { until: new Date(Date.now() + 15000) } }, { upsert: true });
      if (r.modifiedCount || r.upsertedCount) {
        try { return await fn(); } finally { await locks.deleteOne({ _id: key }); }
      }
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  return null;
}

function applyCaptured(session: WebSessionDoc, effects: Effect[]): { visits: number; answers: number } {
  const done = { visits: 0, answers: 0 };
  for (const e of effects) {
    if (e.type === 'save') { done.answers++; session.captured[e.field] = e.value; }
    else { done.visits++; session.captured.visit = e.label; }
  }
  return done;
}

const textOf = (o: Outgoing) => o.text;

/** The visitor's name/email/phone for the team, if the bot captured any. */
function who(captured: Record<string, string>): string {
  const bits = [captured.name, captured.email, captured.phone].filter(Boolean);
  return bits.length ? bits.join(' · ') : 'a website visitor';
}

async function tellTeam(session: WebSessionDoc, reason: string) {
  const summary = [reason, Object.entries(session.captured).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')].filter(Boolean).join(' — ');
  await addEvent('webchat_handoff', 'Chat', session.leadId || session._id, `Website chat needs a person: ${who(session.captured)}`, truncate(summary, 180), 'Website bot', { leadId: session.leadId || undefined }).catch(() => undefined);
}

/** Turn the chat's captured answers into a CRM lead once there is contact info; keep it updated after. */
async function syncLead(session: WebSessionDoc): Promise<void> {
  const c = session.captured;
  try {
    if (!session.leadId && (c.phone || c.email)) {
      if (await bumpDailyCount('webchatLeads') > LEADS_PER_DAY) return; // stop making new leads once the daily cap is hit
      session.leadId = await upsertBotLead({ captured: c, source: 'Website', actor: 'Website bot', eventSource: 'webchat' });
    } else if (session.leadId) {
      await upsertBotLead({ captured: c, source: 'Website', actor: 'Website bot', eventSource: 'webchat', existingLeadId: session.leadId });
    }
  } catch (e: any) {
    await logError('webchat.lead', e?.code || 'INTERNAL', e?.message, e?.stack, 'webhook', { sessionId: session._id });
  }
}

export interface WebchatTurn { sessionId: string; messages: WidgetMsg[]; status: ChatStatus; mode: ChatMode; done: boolean; company: string; seq: number }

/** New bot+agent messages the widget has not seen (seq > since). The visitor's own lines are left out — they already have them. */
function pollResult(session: WebSessionDoc, since: number, company: string): WebchatTurn {
  const messages: WidgetMsg[] = (session.transcript || []).filter((t) => t.seq > since && (t.role === 'bot' || t.role === 'agent')).map((t) => ({ kind: 'text', text: t.text, from: t.role === 'agent' ? 'agent' : 'bot' }));
  return { sessionId: session._id, messages, status: session.status, mode: session.mode || 'bot', done: session.status !== 'active', company, seq: session.seq || 0 };
}

/** One turn of a website chat. No sessionId (or an ended/unknown one) starts a fresh chat. `poll` fetches new messages. Never throws past the feature gate. */
export async function webchatTurn(i: { sessionId?: string; text?: string; replyId?: string; visitorId?: string; origin?: string; ip?: string; poll?: boolean; since?: number }, now = new Date()): Promise<WebchatTurn> {
  if (!featureOn()) throw fail('FORBIDDEN', 'Website chatbot is not included in this plan.');
  void ensureWebchatIndex();
  const company = str(currentTenant()?.name);
  const text = str(i.text).slice(0, 500);
  const replyId = str(i.replyId).slice(0, 60);
  const sessions = await sessionsCol();
  const existing = str(i.sessionId) ? await sessions.findOne({ _id: str(i.sessionId) }) : null;

  // polling: just return what the visitor has not seen yet (no lock needed)
  if (existing && i.poll) return pollResult(existing, Number(i.since) || 0, company);

  // an ended chat (and not live with an agent): report its state; the widget offers to start again
  if (existing && existing.mode !== 'agent' && (existing.status !== 'active' || now.getTime() - existing.lastAt.getTime() > DAY_MS)) {
    return { sessionId: existing._id, messages: [], status: existing.status === 'active' ? 'done' : existing.status, mode: 'bot', done: true, company, seq: existing.seq || 0 };
  }

  const lockKey = `web:${existing ? existing._id : i.visitorId || shortId('WV')}`;
  const result = await withChatLock(lockKey, async (): Promise<WebchatTurn> => {
    if (existing) {
      // a live agent is handling this chat: record the visitor's message, don't run the bot
      if (existing.mode === 'agent') {
        const seq = (existing.seq || 0) + 1;
        if (text) await sessions.updateOne({ _id: existing._id }, { $push: { transcript: { $each: [{ role: 'user', text, at: now, seq }], $slice: -MAX_TRANSCRIPT } }, $set: { seq, lastAt: now } } as any);
        return { sessionId: existing._id, messages: [], status: 'active', mode: 'agent', done: false, company, seq };
      }
      const ctx = await botContext(existing.knowledge, company, now);
      const r = await replyToChat({ steps: existing.steps }, existing.state, { text, replyId }, ctx);
      return persist(existing, r, text, now, company);
    }
    // a new chat: run the live bot for the website channel
    const bot = await (await botsCol()).findOne(activeBotFilter('website'));
    if (!bot) throw fail('NOT_FOUND', 'No chatbot is live for this website yet.');
    if (await bumpDailyCount('webchatSessions') > SESSIONS_PER_DAY) throw fail('RATE_LIMIT', 'Chat is busy right now — please try again shortly.');
    const knowledge = bot.steps.some((s) => s.type === 'ai') ? await mergeKnowledge(bot.knowledge) : bot.knowledge;
    const session: WebSessionDoc = {
      // an unguessable session id: this is the only token that lets a request continue a chat
      _id: `wc_${randomToken(16)}`, botId: bot._id, botName: bot.name, visitorId: str(i.visitorId).slice(0, 60) || shortId('WV'), leadId: '',
      steps: bot.steps, knowledge, state: { stepId: '', phase: '', day: '', retries: 0, aiReplies: 0, sent: 0, vars: {} },
      status: 'active', mode: 'bot', assignedAgent: '', assignedAgentId: '', endReason: '', captured: {}, transcript: [], seq: 0,
      origin: str(i.origin).slice(0, 200), ip: str(i.ip).slice(0, 60), visits: 0, answers: 0, startedAt: now, lastAt: now,
    };
    const r = startChat({ steps: bot.steps }, await botContext(knowledge, company, now), {});
    await sessions.insertOne(session);
    return persist(session, r, '', now, company);
  });
  if (result) return result;
  // the lock was busy: ask the visitor to resend rather than skip a step
  return { sessionId: existing?._id || '', messages: [{ kind: 'text', text: 'One moment — please send that again.' }], status: 'active', mode: existing?.mode || 'bot', done: false, company, seq: existing?.seq || 0 };
}

async function persist(session: WebSessionDoc, r: StepResult, userText: string, now: Date, company: string): Promise<WebchatTurn> {
  const done = applyCaptured(session, r.effects);
  if (r.effects.length) await syncLead(session);
  let seq = session.seq || 0;
  const lines: TranscriptLine[] = [];
  const outMsgs: WidgetMsg[] = [];
  if (userText) lines.push({ role: 'user', text: userText, at: now, seq: ++seq });
  for (const o of r.out) { lines.push({ role: 'bot', text: truncate(textOf(o), 1000), at: now, seq: ++seq }); outMsgs.push({ ...o, from: 'bot' }); }

  let mode: ChatMode = session.mode || 'bot';
  let assignedAgent = session.assignedAgent || '';
  let assignedAgentId = session.assignedAgentId || '';
  let status: ChatStatus = r.status;
  let endReason = r.reason;

  // handoff → the chat stays open in agent mode so a person can reply (even if nobody is available right now)
  if (r.status === 'handoff' && mode !== 'agent') {
    mode = 'agent'; status = 'active'; endReason = '';
    const agent = await assignAvailableAgent({ leadId: session.leadId, channel: 'website', title: `Website chat: ${who(session.captured)}`, url: '/webchat' }).catch(() => null);
    let note: string;
    if (agent) {
      assignedAgent = agent.name; assignedAgentId = agent.id;
      note = `You're now connected with ${(agent.name || 'our team').split(' ')[0]}. How can we help?`;
    } else {
      await tellTeam({ ...session, state: r.state }, r.reason).catch((e) => logError('webchat.handoff', 'INTERNAL', e?.message));
      note = 'Thanks! Please hold on a moment — connecting you with our team.';
    }
    lines.push({ role: 'agent', text: note, at: now, seq: ++seq }); outMsgs.push({ kind: 'text', text: note, from: 'agent' });
  }

  const transcript = [...session.transcript, ...lines].slice(-MAX_TRANSCRIPT);
  const ended = status !== 'active';
  await (await sessionsCol()).updateOne({ _id: session._id }, {
    $set: { state: { ...r.state, sent: (session.state.sent || 0) + r.out.length }, status, mode, assignedAgent, assignedAgentId, seq, lastAt: now, transcript, captured: session.captured, leadId: session.leadId, endReason, ...(ended ? { endedAt: now } : {}) },
    $inc: { visits: done.visits, answers: done.answers },
  });
  return { sessionId: session._id, messages: outMsgs, status, mode, done: ended, company, seq };
}

/* ------------------------------- CRM-side ------------------------------ */

/** An agent replies to a website chat from the CRM; it appears in the visitor's widget on their next poll. */
export async function webchatAgentReply(d: { sessionId: string; text: string }, ctx: Ctx): Promise<{ ok: true; seq: number }> {
  const text = str(d?.text).slice(0, 2000);
  if (!text) throw fail('VALIDATION', 'Write a reply first.');
  const sessions = await sessionsCol();
  const session = await sessions.findOne({ _id: str(d?.sessionId) });
  if (!session) throw fail('NOT_FOUND', 'This chat is no longer here.');
  const now = new Date();
  const seq = (session.seq || 0) + 1;
  await sessions.updateOne({ _id: session._id }, {
    $push: { transcript: { $each: [{ role: 'agent', text, at: now, seq }], $slice: -MAX_TRANSCRIPT } },
    $set: { seq, mode: 'agent', status: 'active', assignedAgent: ctx.user?.name || session.assignedAgent, assignedAgentId: ctx.user?.id || session.assignedAgentId, lastAt: now },
  } as any);
  await auditLog(ctx, 'Website Chat Reply', 'Chatbot', session._id, '');
  return { ok: true, seq };
}

/** New messages in one website chat since `since` — for the agent's reply view to poll. */
export async function botChatThread(d: { sessionId: string; since?: number }): Promise<{ status: ChatStatus; mode: ChatMode; seq: number; messages: Array<{ role: string; text: string; at: string; seq: number }> }> {
  const s = await (await sessionsCol()).findOne({ _id: str(d?.sessionId) });
  if (!s) throw fail('NOT_FOUND', 'This chat is no longer here.');
  const since = Number(d?.since) || 0;
  return { status: s.status, mode: s.mode || 'bot', seq: s.seq || 0, messages: (s.transcript || []).filter((t) => t.seq > since).map((t) => ({ role: t.role, text: t.text, at: t.at?.toISOString?.() || '', seq: t.seq })) };
}

export interface BotChatRow { id: string; channel: string; botName: string; who: string; status: ChatStatus; mode: ChatMode; assignedAgent: string; leadId: string; messages: number; answers: number; visits: number; startedAt: string; lastAt: string; origin: string; transcript: Array<{ role: string; text: string; at: string; seq: number }>; captured: Record<string, string> }

/** Recent website + social chatbot sessions for the CRM, newest first. */
export async function botChatsList(d: { limit?: number } = {}): Promise<BotChatRow[]> {
  const limit = Math.min(Math.max(Number(d?.limit) || 60, 1), 200);
  const web = await (await sessionsCol()).find({}).sort({ startedAt: -1 }).limit(limit).toArray();
  const soc = await (await col<any>('socialBotSessions')).find({}).sort({ startedAt: -1 }).limit(limit).toArray();
  const line = (t: any) => ({ role: t.role, text: t.text, at: t.at?.toISOString?.() || '', seq: t.seq || 0 });
  const rows: BotChatRow[] = [
    ...web.map((s) => ({ id: s._id, channel: 'website', botName: s.botName, who: who(s.captured || {}), status: s.status, mode: s.mode || 'bot', assignedAgent: s.assignedAgent || '', leadId: s.leadId || '', messages: (s.transcript || []).length, answers: s.answers || 0, visits: s.visits || 0, startedAt: s.startedAt?.toISOString?.() || '', lastAt: s.lastAt?.toISOString?.() || '', origin: s.origin || '', transcript: (s.transcript || []).map(line), captured: s.captured || {} })),
    ...soc.map((s: any) => ({ id: s._id, channel: s.platform === 'instagram' ? 'instagram' : 'facebook', botName: s.botName, who: who(s.captured || {}) === 'a website visitor' ? (s.authorName || 'a visitor') : who(s.captured || {}), status: s.status, mode: 'bot' as ChatMode, assignedAgent: '', leadId: s.leadId || '', messages: (s.transcript || []).length, answers: s.answers || 0, visits: s.visits || 0, startedAt: s.startedAt?.toISOString?.() || '', lastAt: s.lastAt?.toISOString?.() || '', origin: s.thread || '', transcript: (s.transcript || []).map(line), captured: s.captured || {} })),
  ].sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')).slice(0, limit);
  return rows;
}

/** What the CRM needs to show the website-widget install snippet: the app's public URL and this company's slug. */
export function webchatEmbed(): { base: string; slug: string } {
  const base = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return { base, slug: str(currentTenant()?.slug) };
}

export const actions: ActionMap = {
  botChatsList: { fn: async (d, ctx: Ctx) => { await auditLog(ctx, 'Bot Chats Viewed', 'Chatbot', '', ''); return botChatsList(d); }, perm: 'marketing.bots' },
  botChatThread: { fn: async (d) => botChatThread(d), perm: 'marketing.bots' },
  botChatReply: { fn: async (d, ctx: Ctx) => webchatAgentReply(d, ctx), perm: 'chat.send' },
  webchatEmbed: { fn: async () => webchatEmbed(), perm: 'marketing.bots' },
  chatPresence: { fn: async (_d, ctx: Ctx) => ({ available: await myChatAvailability(ctx.user!.id), agents: await availableAgents() }), perm: 'chat.view' },
  chatPresenceSet: { fn: async (d, ctx: Ctx) => { await setChatAvailability(ctx.user!.id, ctx.user!.name, !!d?.available); return { available: !!d?.available }; }, perm: 'chat.view' },
};
