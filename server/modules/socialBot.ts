/**
 * Instagram & Facebook Messenger chatbot: the same engine (src/core/botEngine.ts) and the one active bot that runs
 * on WhatsApp and the website, now answering Instagram and Facebook DMs. It hooks the social inbox: every new
 * inbound DM (socialInbox.store) is offered to the active bot, which replies through the inbox's own sender
 * (replyInbox → Meta Graph), so replies also appear in the CRM inbox. IG/FB have no button UI, so the engine's
 * buttons/list degrade to numbered text (the engine already matches a reply by its number or label).
 *
 * Captured answers become a CRM lead (source "Instagram" / "Facebook"). Shared knowledge/AI/lead logic lives in
 * botRuntime.ts. It never talks over a person: a human reply in the thread stops the bot there.
 */
import { SYSTEM_CTX, type Ctx } from '../core/auth';
import { col } from '../core/db';
import { addEvent, logError } from '../core/events';
import { currentTenant, tenantKey } from '../core/tenant';
import { dateKey, shortId, str, truncate } from '../core/utils';
import { activeBotFilter, botContext, mergeKnowledge, upsertBotLead } from './botRuntime';
import { inboxCol, replyInbox, type InboxItem } from './socialInbox';
import { replyToChat, startChat, STOP_WORDS, type BotStep, type ChatState, type ChatStatus, type Effect, type Outgoing, type StepResult } from './whatsappBotEngine';

const DAY_MS = 86400000;
const MAX_TRANSCRIPT = 80;
const BOT_NAME = 'Social bot';
const SOCIAL_CTX: Ctx = { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: BOT_NAME }, action: 'socialBot' };

interface BotDoc { _id: string; name: string; status: 'draft' | 'active' | 'paused'; trigger: 'new' | 'keyword' | 'any'; keywords: string[]; steps: BotStep[]; knowledge: string }
interface TranscriptLine { role: 'bot' | 'user'; text: string; at: Date }
interface SocialSessionDoc {
  _id: string; botId: string; botName: string; thread: string; platform: InboxItem['platform']; account: string; authorId: string; authorName: string; leadId: string;
  steps: BotStep[]; knowledge: string; state: ChatState; status: ChatStatus; endReason: string; captured: Record<string, string>; transcript: TranscriptLine[];
  visits: number; answers: number; startedAt: Date; lastAt: Date; endedAt?: Date;
}

const botsCol = () => col<BotDoc>('whatsappBots');
const sessionsCol = () => col<SocialSessionDoc>('socialBotSessions');
const locksCol = () => col<{ _id: string; until: Date }>('socialBotLocks');

/** A TTL index so finished social chats are cleaned up automatically (45 days), per company. */
const socialIndex = new Map<string, Promise<unknown>>();
async function ensureSocialIndex(): Promise<void> {
  const k = tenantKey();
  if (!socialIndex.has(k)) socialIndex.set(k, sessionsCol().then((c) => c.createIndex({ lastAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 45 })).catch((e) => { socialIndex.delete(k); console.error('[socialBot] index', e?.message); }));
  await socialIndex.get(k);
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const locks = await locksCol();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await locks.updateOne({ _id: key, until: { $lt: new Date() } }, { $set: { until: new Date(Date.now() + 20000) } }, { upsert: true });
      if (r.modifiedCount || r.upsertedCount) {
        try { return await fn(); } finally { await locks.deleteOne({ _id: key }); }
      }
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}

/** Buttons/lists have no native UI on IG/FB: show the prompt with its options numbered, which the engine matches back. */
function flatten(o: Outgoing): string {
  if (o.kind === 'text') return o.text;
  const opts = o.options.map((x, i) => `${i + 1}. ${x.label}`).join('\n');
  return [o.text, opts].filter(Boolean).join('\n');
}

const matchesKeyword = (text: string, words: string[]) => {
  const said = str(text).trim().toLowerCase();
  return words.some((w) => said === w || new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i').test(said));
};

async function shouldStart(bot: BotDoc, item: InboxItem): Promise<boolean> {
  if (bot.trigger === 'any') return true;
  if (bot.trigger === 'keyword') return matchesKeyword(item.text, bot.keywords || []);
  // 'new': only on the very first inbound message of this thread (the one just stored)
  const n = await (await inboxCol()).countDocuments({ thread: item.thread, kind: 'message', direction: 'in' });
  return n <= 1;
}

function applyCaptured(session: SocialSessionDoc, effects: Effect[]): { visits: number; answers: number } {
  const done = { visits: 0, answers: 0 };
  for (const e of effects) {
    if (e.type === 'save') { done.answers++; session.captured[e.field] = e.value; }
    else { done.visits++; session.captured.visit = e.label; }
  }
  return done;
}

/** Turn captured answers into a CRM lead and link the conversation to it in the inbox. */
async function syncLead(session: SocialSessionDoc): Promise<void> {
  const source = session.platform === 'instagram' ? 'Instagram' : 'Facebook';
  const c = session.captured;
  try {
    if (!session.leadId && (c.phone || c.email || c.name)) {
      session.leadId = await upsertBotLead({ captured: c, source, actor: `${source} bot`, eventSource: 'social' });
      if (session.leadId) await (await inboxCol()).updateMany({ thread: session.thread }, { $set: { leadId: session.leadId } });
    } else if (session.leadId) {
      await upsertBotLead({ captured: c, source, actor: `${source} bot`, eventSource: 'social', existingLeadId: session.leadId });
    }
  } catch (e: any) {
    await logError('socialBot.lead', e?.code || 'INTERNAL', e?.message, e?.stack, 'webhook', { thread: session.thread });
  }
}

async function advance(session: SocialSessionDoc, r: StepResult, item: InboxItem, now: Date) {
  const done = applyCaptured(session, r.effects);
  if (r.effects.length) await syncLead(session);
  let status = r.status;
  let reason = r.reason;
  const lines: TranscriptLine[] = item.text ? [{ role: 'user', text: truncate(item.text, 1000), at: now }] : [];
  let sent = 0;
  for (const o of r.out) {
    const text = flatten(o);
    try {
      await replyInbox({ thread: session.thread, text }, SOCIAL_CTX);
      sent++;
      lines.push({ role: 'bot', text: truncate(text, 1000), at: now });
    } catch (e: any) {
      // can't reach the customer (Meta's 24-hour window, or a refusal): a person must take this chat
      status = 'handoff';
      reason = `The bot could not reply: ${truncate(e?.message || 'unknown', 160)}`;
      await logError('socialBot.send', e?.code || 'UPSTREAM', e?.message, '', 'webhook', { thread: session.thread });
      break;
    }
  }
  const transcript = [...session.transcript, ...lines].slice(-MAX_TRANSCRIPT);
  const ended = status !== 'active';
  await (await sessionsCol()).updateOne({ _id: session._id }, {
    $set: { state: { ...r.state, sent: r.state.sent + sent }, status, lastAt: now, transcript, captured: session.captured, leadId: session.leadId, ...(ended ? { endedAt: now, endReason: reason } : {}) },
    $inc: { visits: done.visits, answers: done.answers },
  });
  if (status === 'handoff') {
    const summary = [reason, Object.entries(session.captured).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')].filter(Boolean).join(' — ');
    await addEvent('socialbot_handoff', 'Chat', session.leadId || session.thread, `${session.platform === 'instagram' ? 'Instagram' : 'Facebook'} chat needs a person: ${session.authorName || 'a visitor'}`, truncate(summary, 180), `${session.platform === 'instagram' ? 'Instagram' : 'Facebook'} bot`, { leadId: session.leadId || undefined }).catch(() => undefined);
  }
}

/**
 * A new inbound Instagram/Facebook DM, already stored in the inbox. Called (awaited, in tenant context) from
 * socialInbox.store. Never throws: a bot problem must not lose the message or break the webhook.
 */
export async function onSocialMessage(item: InboxItem): Promise<void> {
  try {
    if (item.kind !== 'message' || item.direction !== 'in') return;
    if (item.platform !== 'facebook' && item.platform !== 'instagram') return;
    if (STOP_WORDS.test(item.text || '')) return;
    const bot = await (await botsCol()).findOne(activeBotFilter(item.platform));
    if (!bot) return;
    void ensureSocialIndex();
    const company = str(currentTenant()?.name);
    const now = new Date();
    await withLock(`soc:${item.thread}`, async () => {
      const sessions = await sessionsCol();
      const current = await sessions.findOne({ thread: item.thread, status: 'active' });
      if (current && now.getTime() - current.lastAt.getTime() <= DAY_MS) {
        const ctx = await botContext(current.knowledge, company, now);
        const r = await replyToChat({ steps: current.steps }, current.state, { text: item.text || '', replyId: '' }, ctx);
        await advance(current, r, item, now);
        return;
      }
      if (current) await sessions.updateOne({ _id: current._id }, { $set: { status: 'done', endedAt: now, endReason: 'The customer stopped answering.' } });
      // never start over a person: a human reply in this thread in the last day keeps the bot out
      const dayAgo = new Date(now.getTime() - DAY_MS);
      if (await (await inboxCol()).findOne({ thread: item.thread, direction: 'out', by: { $nin: [BOT_NAME, '', null] }, at: { $gte: dayAgo } }, { projection: { _id: 1 } })) return;
      if (!(await shouldStart(bot, item))) return;
      const knowledge = bot.steps.some((s) => s.type === 'ai') ? await mergeKnowledge(bot.knowledge) : bot.knowledge;
      const vars: Record<string, string> = {};
      if (item.authorName) vars.name = item.authorName;
      const session: SocialSessionDoc = {
        _id: shortId('SB'), botId: bot._id, botName: bot.name, thread: item.thread, platform: item.platform, account: item.account, authorId: item.authorId, authorName: item.authorName || '', leadId: '',
        steps: bot.steps, knowledge, state: { stepId: '', phase: '', day: '', retries: 0, aiReplies: 0, sent: 0, vars },
        status: 'active', endReason: '', captured: {}, transcript: [], visits: 0, answers: 0, startedAt: now, lastAt: now,
      };
      await sessions.insertOne(session);
      const r = startChat({ steps: bot.steps }, await botContext(knowledge, company, now), vars);
      await advance(session, r, item, now);
    });
  } catch (e: any) {
    await logError('socialBot', e?.code || 'INTERNAL', e?.message, e?.stack, 'webhook', { thread: item.thread, day: dateKey(new Date()) });
  }
}

/** A person replied from the CRM inbox or the app: the bot leaves this thread for good. Called when a human sends. */
export async function stopSocialBot(thread: string, now = new Date()): Promise<void> {
  await (await sessionsCol()).updateMany({ thread, status: 'active' }, { $set: { status: 'handoff', endedAt: now, lastAt: now, endReason: 'A person replied, so the bot stopped.' } }).catch(() => undefined);
}
