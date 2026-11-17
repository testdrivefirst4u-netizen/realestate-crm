/**
 * Website chatbot: the same bot engine (src/core/botEngine.ts) that runs on WhatsApp, answering visitors on a
 * company's website through an embeddable widget. It runs the one active bot (collection `whatsappBots`), so a
 * company builds and tests a bot once and it can answer on both surfaces.
 *
 * This is a separate, public (no sign-in) runtime from the WhatsApp one: a website visitor has no phone number,
 * so chats are keyed by a random visitor id. Captured answers become a CRM lead (source "Website") as soon as
 * contact details arrive, and the team is told when a chat needs a person. Shared knowledge/AI/lead logic lives
 * in botRuntime.ts. Nothing here touches the WhatsApp bot code, Chat360 or the live number.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addEvent, logError } from '../core/events';
import { currentTenant } from '../core/tenant';
import { shortId, str, truncate } from '../core/utils';
import { activeBotFilter, botContext, mergeKnowledge, upsertBotLead } from './botRuntime';
import { replyToChat, startChat, type BotStep, type ChatState, type ChatStatus, type Effect, type Outgoing, type StepResult } from './whatsappBotEngine';

const DAY_MS = 86400000;
const MAX_TRANSCRIPT = 80;

interface BotDoc { _id: string; name: string; status: 'draft' | 'active' | 'paused'; steps: BotStep[]; knowledge: string }
interface TranscriptLine { role: 'bot' | 'user'; text: string; at: Date }
interface WebSessionDoc {
  _id: string; botId: string; botName: string; visitorId: string; leadId: string; steps: BotStep[]; knowledge: string; state: ChatState;
  status: ChatStatus; endReason: string; captured: Record<string, string>; transcript: TranscriptLine[];
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
      session.leadId = await upsertBotLead({ captured: c, source: 'Website', actor: 'Website bot', eventSource: 'webchat' });
    } else if (session.leadId) {
      await upsertBotLead({ captured: c, source: 'Website', actor: 'Website bot', eventSource: 'webchat', existingLeadId: session.leadId });
    }
  } catch (e: any) {
    await logError('webchat.lead', e?.code || 'INTERNAL', e?.message, e?.stack, 'webhook', { sessionId: session._id });
  }
}

export interface WebchatTurn { sessionId: string; messages: Outgoing[]; status: ChatStatus; done: boolean; company: string }

/** One turn of a website chat. No sessionId (or an ended/unknown one) starts a fresh chat on the active bot. Never throws past the feature gate: a bot problem must not break the page. */
export async function webchatTurn(i: { sessionId?: string; text?: string; replyId?: string; visitorId?: string; origin?: string; ip?: string }, now = new Date()): Promise<WebchatTurn> {
  if (!featureOn()) throw fail('FORBIDDEN', 'Website chatbot is not included in this plan.');
  const company = str(currentTenant()?.name);
  const text = str(i.text).slice(0, 500);
  const replyId = str(i.replyId).slice(0, 60);
  const sessions = await sessionsCol();

  const existing = str(i.sessionId) ? await sessions.findOne({ _id: str(i.sessionId) }) : null;

  // an ended chat: report its state; the widget offers to start again (which arrives with no sessionId)
  if (existing && (existing.status !== 'active' || now.getTime() - existing.lastAt.getTime() > DAY_MS)) {
    return { sessionId: existing._id, messages: [], status: existing.status === 'active' ? 'done' : existing.status, done: true, company };
  }

  const lockKey = `web:${existing ? existing._id : i.visitorId || shortId('WV')}`;
  const result = await withChatLock(lockKey, async (): Promise<WebchatTurn> => {
    if (existing) {
      const ctx = await botContext(existing.knowledge, company, now);
      const r = await replyToChat({ steps: existing.steps }, existing.state, { text, replyId }, ctx);
      return persist(existing, r, text, now, company);
    }
    // a new chat: run the live bot for the website channel
    const bot = await (await botsCol()).findOne(activeBotFilter('website'));
    if (!bot) throw fail('NOT_FOUND', 'No chatbot is live for this website yet.');
    const knowledge = bot.steps.some((s) => s.type === 'ai') ? await mergeKnowledge(bot.knowledge) : bot.knowledge;
    const vars: Record<string, string> = {};
    const session: WebSessionDoc = {
      _id: shortId('WC'), botId: bot._id, botName: bot.name, visitorId: str(i.visitorId).slice(0, 60) || shortId('WV'), leadId: '',
      steps: bot.steps, knowledge, state: { stepId: '', phase: '', day: '', retries: 0, aiReplies: 0, sent: 0, vars },
      status: 'active', endReason: '', captured: {}, transcript: [], origin: str(i.origin).slice(0, 200), ip: str(i.ip).slice(0, 60),
      visits: 0, answers: 0, startedAt: now, lastAt: now,
    };
    const r = startChat({ steps: bot.steps }, await botContext(knowledge, company, now), vars);
    await sessions.insertOne(session);
    return persist(session, r, '', now, company);
  });
  if (result) return result;
  // the lock was busy: ask the visitor to resend rather than skip a step
  return { sessionId: existing?._id || '', messages: [{ kind: 'text', text: 'One moment — please send that again.' }], status: 'active', done: false, company };
}

async function persist(session: WebSessionDoc, r: StepResult, userText: string, now: Date, company: string): Promise<WebchatTurn> {
  const done = applyCaptured(session, r.effects);
  if (r.effects.length) await syncLead(session);
  const lines: TranscriptLine[] = [];
  if (userText) lines.push({ role: 'user', text: userText, at: now });
  for (const o of r.out) lines.push({ role: 'bot', text: truncate(textOf(o), 1000), at: now });
  const transcript = [...session.transcript, ...lines].slice(-MAX_TRANSCRIPT);
  const ended = r.status !== 'active';
  const sent = session.state.sent + r.out.length;
  await (await sessionsCol()).updateOne({ _id: session._id }, {
    $set: {
      state: { ...r.state, sent }, status: r.status, lastAt: now, transcript, captured: session.captured, leadId: session.leadId,
      ...(ended ? { endedAt: now, endReason: r.reason } : {}),
    },
    $inc: { visits: done.visits, answers: done.answers },
  });
  if (r.status === 'handoff') await tellTeam({ ...session, state: r.state }, r.reason).catch((e) => logError('webchat.handoff', 'INTERNAL', e?.message));
  return { sessionId: session._id, messages: r.out, status: r.status, done: ended, company };
}

/* ------------------------------- CRM-side read ------------------------------ */

export interface BotChatRow { id: string; channel: string; botName: string; who: string; status: ChatStatus; leadId: string; messages: number; answers: number; visits: number; startedAt: string; lastAt: string; origin: string; transcript: TranscriptLine[]; captured: Record<string, string> }

/** Recent website + social chatbot sessions for the CRM, newest first. */
export async function botChatsList(d: { limit?: number } = {}): Promise<BotChatRow[]> {
  const limit = Math.min(Math.max(Number(d?.limit) || 60, 1), 200);
  const web = await (await sessionsCol()).find({}).sort({ startedAt: -1 }).limit(limit).toArray();
  const soc = await (await col<any>('socialBotSessions')).find({}).sort({ startedAt: -1 }).limit(limit).toArray();
  const rows: BotChatRow[] = [
    ...web.map((s) => ({ id: s._id, channel: 'website', botName: s.botName, who: who(s.captured || {}), status: s.status, leadId: s.leadId || '', messages: (s.transcript || []).length, answers: s.answers || 0, visits: s.visits || 0, startedAt: s.startedAt?.toISOString?.() || '', lastAt: s.lastAt?.toISOString?.() || '', origin: s.origin || '', transcript: (s.transcript || []).map((t: any) => ({ role: t.role, text: t.text, at: t.at })), captured: s.captured || {} })),
    ...soc.map((s: any) => ({ id: s._id, channel: s.platform === 'instagram' ? 'instagram' : 'facebook', botName: s.botName, who: who(s.captured || {}) === 'a website visitor' ? (s.authorName || 'a visitor') : who(s.captured || {}), status: s.status, leadId: s.leadId || '', messages: (s.transcript || []).length, answers: s.answers || 0, visits: s.visits || 0, startedAt: s.startedAt?.toISOString?.() || '', lastAt: s.lastAt?.toISOString?.() || '', origin: s.thread || '', transcript: (s.transcript || []).map((t: any) => ({ role: t.role, text: t.text, at: t.at })), captured: s.captured || {} })),
  ].sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')).slice(0, limit);
  return rows;
}

export const actions: ActionMap = {
  botChatsList: { fn: async (d, ctx: Ctx) => { await auditLog(ctx, 'Bot Chats Viewed', 'Chatbot', '', ''); return botChatsList(d); }, perm: 'marketing.bots' },
};
