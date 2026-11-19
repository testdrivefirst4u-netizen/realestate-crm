/**
 * Bot Analytics (/botanalytics): one dashboard that aggregates every bot conversation across channels —
 * website chats (webchatSessions), Instagram/Facebook DMs (socialBotSessions) and WhatsApp bot chats
 * (whatsappBotSessions) — into KPIs, a sessions-by-channel trend, a channel mix and per-channel figures,
 * for a chosen date range. Read-only; all numbers are real (no WhatsApp live/Chat360 messages here, which
 * are a separate system). Each collection is already per-company, so no tenant filter is needed in queries.
 */
import type { ActionMap } from '../core/actions';
import { CFG } from '../core/config';
import { col } from '../core/db';

const DAY = 86400000;
const MAX_SPAN = 180 * DAY; // guard: never aggregate more than ~6 months in one call
const TZ = 'Asia/Kolkata'; // CRM wall-clock, so day buckets line up with the rest of the app

type ChannelKey = 'website' | 'whatsapp' | 'instagram' | 'facebook';

export interface BotAnalyticsChannel {
  channel: ChannelKey;
  sessions: number;
  uniqueUsers: number;
  repeatUsers: number;
  handoffs: number;
  leads: number;
  avgSessionSec: number;
  botMessages: number;
  userMessages: number;
  agentMessages: number;
  prevSessions: number;
}
export interface BotAnalyticsData {
  range: { from: string; to: string; days: number };
  kpis: {
    totalSessions: number; activeNow: number; uniqueUsers: number; repeatUsers: number;
    handoffs: number; handoffRate: number; avgSessionSec: number;
    botMessages: number; userMessages: number; agentMessages: number;
    leads: number; leadRate: number;
  };
  prev: { totalSessions: number; uniqueUsers: number; handoffs: number; avgSessionSec: number; leads: number };
  /** How far conversations get: started → got an answer → finished the flow, with handoffs and drop-offs. */
  funnel: { started: number; answered: number; finished: number; handedOff: number; stopped: number };
  channels: BotAnalyticsChannel[];
  daily: Array<{ date: string; website: number; whatsapp: number; instagram: number; facebook: number }>;
  /** Sessions started per weekday (0=Sun..6=Sat) × hour of day (0..23), in CRM time — the "busy times" heatmap. */
  heatmap: number[][];
  /** WhatsApp live-chat (Chat360) message volume in range — a separate system from the bots, shown for context. */
  waLive: { inbound: number; outbound: number };
}

interface Spec { channel: ChannelKey; coll: string; idField: string; match: Record<string, unknown>; hasTranscript: boolean; handoff: Record<string, unknown> }
const SPECS: Spec[] = [
  // website: count only real chats — a visitor who just opened the widget (bot greeting only, no reply) is excluded
  { channel: 'website', coll: 'webchatSessions', idField: 'visitorId', match: { $or: [{ 'transcript.role': 'user' }, { mode: 'agent' }] }, hasTranscript: true, handoff: { $or: [{ mode: 'agent' }, { status: 'handoff' }] } },
  { channel: 'whatsapp', coll: 'whatsappBotSessions', idField: 'phoneLast10', match: {}, hasTranscript: false, handoff: { status: 'handoff' } },
  { channel: 'instagram', coll: 'socialBotSessions', idField: 'authorId', match: { platform: 'instagram' }, hasTranscript: true, handoff: { status: 'handoff' } },
  { channel: 'facebook', coll: 'socialBotSessions', idField: 'authorId', match: { platform: 'facebook' }, hasTranscript: true, handoff: { status: 'handoff' } },
];

interface Agg { sessions: number; uniqueUsers: number; repeatUsers: number; handoffs: number; leads: number; answered: number; finished: number; stopped: number; durSum: number; durCount: number; bot: number; user: number; agent: number; daily: Map<string, number> }

/** One channel's figures for one window, computed in the database (no documents pulled into Node). */
async function aggregate(spec: Spec, from: Date, to: Date, botId?: string): Promise<Agg> {
  const c = await col<Record<string, unknown>>(spec.coll);
  const match: Record<string, unknown> = { ...spec.match, startedAt: { $gte: from, $lt: to }, ...(botId ? { botId } : {}) };
  const roleSum = (role: string) => ({ $sum: { $size: { $ifNull: [{ $filter: { input: '$transcript', as: 't', cond: { $eq: ['$$t.role', role] } } }, []] } } });
  const facet: Record<string, unknown[]> = {
    total: [{ $count: 'n' }],
    uniq: [{ $group: { _id: `$${spec.idField}` } }, { $count: 'n' }],
    repeat: [{ $group: { _id: `$${spec.idField}`, c: { $sum: 1 } } }, { $match: { c: { $gt: 1 } } }, { $count: 'n' }],
    handoff: [{ $match: spec.handoff }, { $count: 'n' }],
    leads: [{ $match: { leadId: { $nin: ['', null] } } }, { $count: 'n' }],
    answered: [{ $match: { answers: { $gt: 0 } } }, { $count: 'n' }],
    finished: [{ $match: { status: 'done' } }, { $count: 'n' }],
    stopped: [{ $match: { status: 'stopped' } }, { $count: 'n' }],
    dur: [{ $project: { s: { $divide: [{ $subtract: [{ $ifNull: ['$endedAt', '$lastAt'] }, '$startedAt'] }, 1000] } } }, { $match: { s: { $gt: 0 } } }, { $group: { _id: null, sum: { $sum: '$s' }, n: { $sum: 1 } } }],
    daily: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: TZ } }, n: { $sum: 1 } } }],
  };
  if (spec.hasTranscript) facet.msgs = [{ $group: { _id: null, bot: roleSum('bot'), user: roleSum('user'), agent: roleSum('agent') } }];

  const res = (await c.aggregate([{ $match: match }, { $facet: facet }]).toArray())[0] as Record<string, Array<Record<string, number>>> | undefined || {};
  const num = (a: Array<Record<string, number>> | undefined, k = 'n') => (a && a[0] ? a[0][k] || 0 : 0);
  const daily = new Map<string, number>();
  for (const row of (res.daily as unknown as Array<{ _id: string; n: number }> | undefined) || []) daily.set(row._id, row.n);
  const m = res.msgs?.[0];
  return {
    sessions: num(res.total), uniqueUsers: num(res.uniq), repeatUsers: num(res.repeat), handoffs: num(res.handoff),
    leads: num(res.leads), answered: num(res.answered), finished: num(res.finished), stopped: num(res.stopped),
    durSum: num(res.dur, 'sum'), durCount: num(res.dur, 'n'),
    bot: m?.bot || 0, user: m?.user || 0, agent: m?.agent || 0, daily,
  };
}

/** Chats open right now: status "active" and seen within the last 15 minutes, across all three stores. */
async function countActiveNow(botId?: string): Promise<number> {
  const since = new Date(Date.now() - 15 * 60000);
  let n = 0;
  for (const coll of ['webchatSessions', 'whatsappBotSessions', 'socialBotSessions']) {
    const c = await col<Record<string, unknown>>(coll);
    n += await c.countDocuments({ status: 'active', lastAt: { $gte: since }, ...(botId ? { botId } : {}) });
  }
  return n;
}

/** Sessions by weekday (0=Sun..6=Sat) × hour (0..23) in CRM time, across all bot stores. */
const HEAT_COLLS: Array<{ coll: string; match: Record<string, unknown> }> = [
  { coll: 'webchatSessions', match: { $or: [{ 'transcript.role': 'user' }, { mode: 'agent' }] } },
  { coll: 'whatsappBotSessions', match: {} },
  { coll: 'socialBotSessions', match: {} },
];
async function busyGrid(from: Date, to: Date, botId?: string): Promise<number[][]> {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0) as number[]);
  for (const c of HEAT_COLLS) {
    const coll = await col<Record<string, unknown>>(c.coll);
    const rows = await coll.aggregate([
      { $match: { ...c.match, startedAt: { $gte: from, $lt: to }, ...(botId ? { botId } : {}) } },
      { $group: { _id: { d: { $dayOfWeek: { date: '$startedAt', timezone: TZ } }, h: { $hour: { date: '$startedAt', timezone: TZ } } }, n: { $sum: 1 } } },
    ]).toArray() as Array<{ _id: { d: number; h: number }; n: number }>;
    for (const r of rows) { const d = (r._id.d || 1) - 1, h = r._id.h || 0; if (grid[d] && typeof grid[d][h] === 'number') grid[d][h] += r.n; }
  }
  return grid;
}

/** WhatsApp live-chat message volume in the window, by direction (Chat360 — not a bot system). */
async function waLiveCounts(from: Date, to: Date): Promise<{ inbound: number; outbound: number }> {
  try {
    const c = await col<Record<string, unknown>>(CFG.COLL.CHAT_MESSAGES);
    const rows = await c.aggregate([{ $match: { timestamp: { $gte: from, $lt: to } } }, { $group: { _id: '$direction', n: { $sum: 1 } } }]).toArray() as Array<{ _id: string; n: number }>;
    let inbound = 0, outbound = 0;
    for (const r of rows) { if (r._id === 'Inbound') inbound = r.n; else if (r._id === 'Outbound') outbound = r.n; }
    return { inbound, outbound };
  } catch { return { inbound: 0, outbound: 0 }; }
}

const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
/** Every CRM-day in [from, to], so the trend line has no gaps. */
function dayRange(from: Date, to: Date): string[] {
  const endKey = dayKey(to);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let t = from.getTime(); t <= to.getTime() + DAY; t += DAY / 4) {
    const k = dayKey(new Date(t));
    if (k > endKey) break;
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

export async function botAnalytics(d: { from?: string; to?: string; botId?: string } | undefined): Promise<BotAnalyticsData> {
  const botId = d?.botId ? String(d.botId) : '';
  let to = d?.to ? new Date(d.to) : new Date();
  let from = d?.from ? new Date(d.from) : new Date(to.getTime() - 30 * DAY);
  if (isNaN(to.getTime())) to = new Date();
  if (isNaN(from.getTime()) || from.getTime() >= to.getTime()) from = new Date(to.getTime() - 30 * DAY);
  if (to.getTime() - from.getTime() > MAX_SPAN) from = new Date(to.getTime() - MAX_SPAN);
  const span = to.getTime() - from.getTime();
  const days = Math.max(1, Math.round(span / DAY));
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - span);

  const [cur, prev, activeNow, waLive, heatmap] = await Promise.all([
    Promise.all(SPECS.map((s) => aggregate(s, from, to, botId))),
    Promise.all(SPECS.map((s) => aggregate(s, prevFrom, prevTo, botId))),
    countActiveNow(botId),
    botId ? Promise.resolve({ inbound: 0, outbound: 0 }) : waLiveCounts(from, to),
    busyGrid(from, to, botId),
  ]);

  const sum = (f: (a: Agg) => number, arr: Agg[]) => arr.reduce((t, a) => t + f(a), 0);
  const channels: BotAnalyticsChannel[] = SPECS.map((s, i) => {
    const a = cur[i];
    return {
      channel: s.channel, sessions: a.sessions, uniqueUsers: a.uniqueUsers, repeatUsers: a.repeatUsers, handoffs: a.handoffs, leads: a.leads,
      avgSessionSec: a.durCount ? Math.round(a.durSum / a.durCount) : 0,
      botMessages: a.bot, userMessages: a.user, agentMessages: a.agent, prevSessions: prev[i].sessions,
    };
  });

  const totalSessions = sum((a) => a.sessions, cur);
  const handoffs = sum((a) => a.handoffs, cur);
  const leads = sum((a) => a.leads, cur);
  const durSum = sum((a) => a.durSum, cur), durCount = sum((a) => a.durCount, cur);
  const prevDurSum = sum((a) => a.durSum, prev), prevDurCount = sum((a) => a.durCount, prev);

  const daily = dayRange(from, to).map((date) => ({
    date, website: cur[0].daily.get(date) || 0, whatsapp: cur[1].daily.get(date) || 0, instagram: cur[2].daily.get(date) || 0, facebook: cur[3].daily.get(date) || 0,
  }));

  return {
    range: { from: from.toISOString(), to: to.toISOString(), days },
    kpis: {
      totalSessions, activeNow,
      uniqueUsers: sum((a) => a.uniqueUsers, cur), repeatUsers: sum((a) => a.repeatUsers, cur),
      handoffs, handoffRate: totalSessions ? Math.round((handoffs / totalSessions) * 1000) / 10 : 0,
      avgSessionSec: durCount ? Math.round(durSum / durCount) : 0,
      botMessages: sum((a) => a.bot, cur), userMessages: sum((a) => a.user, cur), agentMessages: sum((a) => a.agent, cur),
      leads, leadRate: totalSessions ? Math.round((leads / totalSessions) * 1000) / 10 : 0,
    },
    prev: {
      totalSessions: sum((a) => a.sessions, prev), uniqueUsers: sum((a) => a.uniqueUsers, prev),
      handoffs: sum((a) => a.handoffs, prev), avgSessionSec: prevDurCount ? Math.round(prevDurSum / prevDurCount) : 0,
      leads: sum((a) => a.leads, prev),
    },
    funnel: {
      started: totalSessions, answered: sum((a) => a.answered, cur), finished: sum((a) => a.finished, cur),
      handedOff: handoffs, stopped: sum((a) => a.stopped, cur),
    },
    channels, daily, heatmap, waLive,
  };
}

export const actions: ActionMap = {
  botAnalytics: { fn: async (d) => botAnalytics(d as { from?: string; to?: string }), perm: 'marketing.bots' },
};
