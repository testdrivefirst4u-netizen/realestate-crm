/**
 * JustConnect calls → CRM (step 2). Every call on the company's numbers — made from the CRM, from the JustConnect app,
 * or coming in — is saved as a CRM call: Call History, the lead's Calls tab and timeline.
 *
 * Two ways in, same result (idempotent by the JustConnect call id):
 *  - webhook (app/api/webhooks/justconnect): call_log.started / ringing / answered / ended, seconds after they happen;
 *  - sync (cron every few minutes, and "Sync now"): GET /call-logs?updatedSince=… catches anything missed.
 * When an answered call has ended: the recording is copied into the CRM's file storage, then the AI transcribes it and
 * writes the summary, key points, next steps and a Hot / Warm / Cold read of the lead (calls.transcribe). Missed
 * incoming calls notify the RM and ask for a call-back.
 */
import { listUsers, SYSTEM_CTX, type Ctx, type PublicUser } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { addEvent, addTimeline, logError } from '../core/events';
import { getSecret, settingSet, settingsAll } from '../core/settings';
import { last10, truncate } from '../core/utils';
import { jc, jcKey, JC_BASE, type JcAgent } from '../integrations/justconnect';
import { logCall, transcribe, updateCall } from './calls';
import { findLeadByPhone, getLead } from './leads';
import { idsByName, sendPush } from './push';
import { saveFile } from './storage';
import { agentFor } from './justconnect';

const L = CFG.LEAD;
export const PROVIDER = 'JustConnect';
const RECORDING_MAX = 25 * 1024 * 1024;
/** Answered calls shorter than this are not sent to the AI (voicemail greetings, wrong numbers). */
const AI_MIN_TALK_SEC = 20;

export interface JcCall {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  status: string;
  customer: string | null;
  businessNumber?: string;
  agent?: { id: string; name: string; extension?: string } | null;
  rang?: Array<{ id: string; name: string; extension?: string }>;
  startedAt?: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  talkSeconds?: number;
  durationSeconds?: number;
  recording?: { url: string } | null;
  voicemail?: { url: string; seconds?: number } | null;
  outcome?: string | null;
  notes?: string | null;
  ref?: string | null;
  updatedAt?: string;
}

/** JustConnect status → CRM call status. */
export function crmStatus(c: Pick<JcCall, 'status' | 'direction'>): string {
  switch (c.status) {
    case 'answered': return 'Completed';
    case 'in-progress': return 'In Progress';
    case 'missed': return c.direction === 'outbound' ? 'No Answer' : 'Missed';
    case 'abandoned': return 'Missed';
    case 'busy': return 'Busy';
    case 'voicemail': return 'Voicemail';
    case 'cancelled': return 'No Answer';
    case 'failed': return 'Failed';
    default: return 'Completed';
  }
}

/** Who in the CRM handled it: the user linked to the JustConnect agent, else the agent's name. */
interface People { users: PublicUser[]; links: Map<string, string>; agents: JcAgent[] }
async function people(): Promise<People> {
  const users = (await listUsers()).filter((u) => u.status !== 'Disabled');
  const links = new Map((await (await col<{ _id: string; jcAgent?: string }>(CFG.COLL.USERS)).find({}, { projection: { jcAgent: 1 } }).toArray()).map((u) => [u._id, u.jcAgent || '']));
  let agents: JcAgent[] = [];
  try {
    agents = (await jc<{ items: JcAgent[] }>('/agents')).items || [];
  } catch { /* names still work without the list */ }
  return { users, links, agents };
}
function crmUserFor(agent: { id: string; name: string } | null | undefined, p: People): PublicUser | null {
  if (!agent) return null;
  return p.users.find((u) => agentFor(u, p.links.get(u.id), p.agents)?.id === agent.id) || null;
}

let outcomeLabels: { at: number; map: Map<string, string> } | null = null;
async function outcomeLabel(code: string | null | undefined): Promise<string> {
  if (!code) return '';
  if (!outcomeLabels || Date.now() - outcomeLabels.at > 10 * 60_000) {
    try {
      const r = await jc<{ items: Array<{ code: string; label: string }> }>('/outcomes');
      outcomeLabels = { at: Date.now(), map: new Map((r.items || []).map((o) => [o.code, o.label])) };
    } catch {
      outcomeLabels = { at: Date.now(), map: new Map() };
    }
  }
  return outcomeLabels.map.get(code) || code;
}

const callsCol = () => col<any>(CFG.COLL.CALLS);

/**
 * Save one JustConnect call (new or changed) as a CRM call. Fast: no recording download or AI here — those run in
 * finishCall(). Returns the CRM call id, or '' when the call is not for the CRM (internal, no customer number).
 */
export async function ingestJcCall(c: JcCall, p?: People, ringing?: { id: string; name: string } | null): Promise<{ callId: string; created: boolean; ended: boolean }> {
  if (!c?.id || c.direction === 'internal' || !last10(c.customer || '')) return { callId: '', created: false, ended: false };
  const ppl = p || (await people());
  const agentUser = crmUserFor(c.agent, ppl);
  const user = agentUser || crmUserFor(c.rang?.[0], ppl);
  // for the call window (jcMyCall): whose phone rang, who took it, when it was answered
  const ringIds = [...new Set([...(c.rang || []), ...(ringing ? [ringing] : [])].map((a) => crmUserFor(a, ppl)?.id).filter(Boolean) as string[])];
  const live = (doc: Record<string, unknown>) => ({
    $set: { ...doc, jcAnsweredAt: c.answeredAt || '', jcLiveAt: new Date(), ...(agentUser ? { jcAgentUserId: agentUser.id } : {}) },
    ...(ringIds.length ? { $addToSet: { jcRingingUserIds: { $each: ringIds } } } : {}),
  });
  const actor = user?.name || c.agent?.name || PROVIDER;
  const ctx: Ctx = { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: actor }, action: 'justconnect' };
  const status = crmStatus(c);
  const ended = c.status !== 'in-progress';
  const outcome = await outcomeLabel(c.outcome);
  const fields: Record<string, unknown> = {
    status,
    startTime: c.startedAt || new Date().toISOString(),
    endTime: c.endedAt || '',
    durationSec: c.talkSeconds || 0,
    ...(outcome ? { outcome } : {}),
    ...(c.notes ? { notes: truncate(c.notes, 5000) } : {}),
  };

  const existing = await (await callsCol()).findOne({ provider: PROVIDER, providerCallId: c.id });
  if (existing) {
    await updateCall(String(existing._id), fields, ctx);
    await (await callsCol()).updateOne({ _id: existing._id }, live({ jcRecording: !!c.recording, jcVoicemail: !!c.voicemail, jcUpdatedAt: c.updatedAt || '' }));
    return { callId: String(existing._id), created: false, ended };
  }
  // the lead: our own reference for calls started from the CRM, else the customer's number
  const byRef = c.ref ? await getLead(c.ref).catch(() => null) : null;
  const lead = byRef || (await findLeadByPhone(c.customer || ''));
  const call = await logCall({
    leadId: lead ? lead[L.ID] : '',
    phone: c.customer,
    customerName: lead ? lead[L.NAME] : '',
    direction: c.direction === 'inbound' ? 'Inbound' : 'Outbound',
    provider: PROVIDER,
    providerCallId: c.id,
    loggedBy: actor,
    ...fields,
  }, ctx);
  await (await callsCol()).updateOne({ _id: call.id }, live({ jcRecording: !!c.recording, jcVoicemail: !!c.voicemail, jcUpdatedAt: c.updatedAt || '', jcAgentUserId: user?.id || '' }));
  return { callId: call.id, created: true, ended };
}

/** Download a JustConnect recording or voicemail (WAV, needs the key). */
async function fetchAudio(jcCallId: string, kind: 'recording' | 'voicemail'): Promise<Buffer> {
  const key = await jcKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${JC_BASE}/call-logs/${encodeURIComponent(jcCallId)}/${kind}`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`JustConnect ${kind} HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > RECORDING_MAX) throw new Error(`${kind} larger than 25 MB`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > RECORDING_MAX) throw new Error(`${kind} larger than 25 MB`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * After a call ended: copy the recording into the CRM, run the AI (transcript, summary, Hot / Warm / Cold), and for a
 * missed incoming call tell the RM. Each step runs once per call (flags on the call). Never throws.
 */
export async function finishCall(callId: string): Promise<{ recording: boolean; ai: boolean; missed: boolean; remark?: boolean }> {
  const out: { recording: boolean; ai: boolean; missed: boolean; remark?: boolean } = { recording: false, ai: false, missed: false };
  try {
    const c = await callsCol();
    const doc = await c.findOne({ _id: callId });
    if (!doc || doc.provider !== PROVIDER || doc.status === 'In Progress') return out;
    const ctx: Ctx = { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: doc.loggedBy || PROVIDER }, action: 'justconnect' };

    // 1. recording (or voicemail) into the CRM's file storage — also for a caller who is not a lead yet (it moves to
    //    the lead when the call is linked: calls.attachToLead)
    const kind = doc.jcRecording ? 'recording' : doc.jcVoicemail ? 'voicemail' : '';
    if (kind && !doc.recordingFileId && !doc.jcAudioTried) {
      await c.updateOne({ _id: callId }, { $set: { jcAudioTried: true } });
      try {
        const data = await fetchAudio(String(doc.providerCallId), kind);
        const file = await saveFile({ leadId: doc.leadId || '', category: 'Call Recordings', name: `${callId}_${kind}.wav`, mime: 'audio/wav', data, uploadedBy: doc.loggedBy || PROVIDER, description: `${kind === 'voicemail' ? 'Voicemail' : 'Recording'} of ${callId} (JustConnect)` });
        await updateCall(callId, { recordingUrl: file.url, recordingFileId: file.fileId }, ctx);
        if (doc.leadId) await addTimeline(doc.leadId, 'call_recording', kind === 'voicemail' ? 'Voicemail saved' : 'Call recording saved', 'From JustConnect', doc.loggedBy || PROVIDER, 'Call', callId);
        out.recording = true;
      } catch (e: any) {
        await c.updateOne({ _id: callId }, { $unset: { jcAudioTried: '' } }); // try again on the next sync
        await logError('justconnect.recording', 'SERVER', e?.message, e?.stack, '', { callId });
      }
    }

    // 2. AI: transcript, summary, next steps and Hot / Warm / Cold (answered calls long enough to say something)
    const fresh = await c.findOne({ _id: callId });
    if (fresh?.recordingFileId && !fresh.transcript && !fresh.jcAiTried && (fresh.status === 'Completed' || fresh.status === 'Voicemail') && (fresh.durationSec || 0) >= AI_MIN_TALK_SEC) {
      await c.updateOne({ _id: callId }, { $set: { jcAiTried: true } });
      try {
        await transcribe(callId, ctx);
        out.ai = true;
      } catch (e: any) {
        if (e?.code !== 'NOT_CONFIGURED') await logError('justconnect.ai', e?.code || 'INTERNAL', e?.message, e?.stack, '', { callId });
      }
    }

    // 3. the outcome the agent filed in JustConnect → a remark on the lead (once)
    try {
      const { remarkFromJcOutcome } = await import('./jcSync');
      if (await remarkFromJcOutcome(callId)) out.remark = true;
    } catch { /* non-fatal */ }

    // 4. missed incoming call → RM is told, call-back asked
    if (fresh && fresh.direction === 'Inbound' && ['Missed', 'Voicemail'].includes(fresh.status) && !fresh.jcMissedNotified) {
      await c.updateOne({ _id: callId }, { $set: { jcMissedNotified: true } });
      const lead = fresh.leadId ? await getLead(fresh.leadId) : null;
      const who = lead ? String(lead[L.NAME] || fresh.phone) : String(fresh.phone);
      const users = await listUsers();
      const ids = [...new Set([...(lead && lead[L.RM] ? idsByName([String(lead[L.RM])], users) : []), ...(fresh.jcAgentUserId ? [fresh.jcAgentUserId] : [])])];
      if (ids.length) {
        await sendPush(ids, {
          title: `Missed call: ${who}`,
          body: `${fresh.status === 'Voicemail' ? 'They left a voicemail. ' : ''}Call back ${fresh.phone}`,
          url: lead ? `/leads?lead=${encodeURIComponent(String(lead[L.ID]))}` : '/calls',
          tag: `missed-${callId}`,
        });
      }
      if (lead) {
        await addTimeline(String(lead[L.ID]), 'call', `Missed call — call back`, `${fresh.phone}${fresh.status === 'Voicemail' ? ' · voicemail left' : ''}`, PROVIDER, 'Call', callId);
        await addEvent('call_missed', 'Lead', String(lead[L.ID]), `Missed call: ${who}`, `Call back ${fresh.phone}`, PROVIDER);
      }
      out.missed = true;
    }
  } catch (e: any) {
    await logError('justconnect.finish', 'INTERNAL', e?.message, e?.stack, '', { callId });
  }
  return out;
}

/** Someone's phone is ringing for a call: tell them who it is (phone notification + in-app note just for them). */
export async function announceRinging(c: JcCall, ringing: { id: string; name: string } | null | undefined) {
  try {
    if (!ringing || c.direction !== 'inbound' || !last10(c.customer || '')) return;
    const ppl = await people();
    const user = crmUserFor(ringing, ppl);
    if (!user) return;
    const lead = await findLeadByPhone(c.customer || '');
    const title = lead ? `Incoming call: ${lead[L.NAME]}` : `Incoming call: ${c.customer}`;
    const body = lead ? [lead[L.STAGE], lead[L.UNIT_TYPE], lead[L.ID]].filter(Boolean).join(' · ') : 'Not in the CRM yet';
    await sendPush([user.id], { title, body, url: lead ? `/leads?lead=${encodeURIComponent(String(lead[L.ID]))}` : '/calls', tag: `ring-${c.id}` });
    await addEvent('incoming_call', lead ? 'Lead' : 'Call', lead ? String(lead[L.ID]) : c.id, title, body, PROVIDER, { forUser: user.id });
  } catch (e: any) {
    await logError('justconnect.ringing', 'INTERNAL', e?.message, e?.stack);
  }
}

/** How long an ended call stays in the caller's call window, and how long an unfinished one is believed. */
const ENDED_SHOW_MS = 2 * 60_000;
const LIVE_MAX_MS = 2 * 3600_000;

export interface MyCall {
  id: string;
  /** ringing: it rings (incoming) or the customer is being rung; live: talking; ended: over (missed or done). */
  phase: 'ringing' | 'live' | 'ended';
  direction: 'Inbound' | 'Outbound';
  status: string;
  phone: string;
  leadId: string;
  customerName: string;
  startTime: string;
  answeredAt: string;
  durationSec: number;
  outcome: string;
  notes: string;
  aiSummary: string;
  aiTemperature: string;
  aiTemperatureReason: string;
  /** The recording is (or will be) sent to the AI, so a summary is on its way. */
  aiPending: boolean;
  /** Muted from the CRM (the customer cannot hear the agent). */
  muted: boolean;
}

/**
 * The call window's "what is my phone doing": the newest JustConnect call that rings for, or is handled by, this user —
 * while it rings or is in progress, and for two minutes after it ended. With `id`: that call (if it is theirs), however old,
 * so the window can wait for the AI summary. Kept cheap: the CRM asks every few seconds while it is open.
 */
export async function jcMyCall(d: { id?: string } | undefined, ctx: Ctx): Promise<MyCall | null> {
  const me = ctx.user?.id;
  if (!me) return null;
  const c = await callsCol();
  const mine = { $or: [{ jcAgentUserId: me }, { jcRingingUserIds: me }] };
  const rows = d?.id
    ? await c.find({ _id: String(d.id), provider: PROVIDER, ...mine }).limit(1).toArray()
    : await c.find({ provider: PROVIDER, jcLiveAt: { $gte: new Date(Date.now() - LIVE_MAX_MS) }, ...mine }).sort({ jcLiveAt: -1 }).limit(3).toArray();
  for (const r of rows) {
    const ended = r.status !== 'In Progress';
    if (!d?.id && ended && Date.now() - new Date(r.jcLiveAt).getTime() > ENDED_SHOW_MS) continue;
    // a colleague took it: not my call any more
    if (r.jcAgentUserId && r.jcAgentUserId !== me && (r.jcAnsweredAt || r.status === 'Completed')) continue;
    const aiPending = ended && !r.transcript && !r.jcAiTried && r.status === 'Completed' && (r.durationSec || 0) >= AI_MIN_TALK_SEC && !!(r.jcRecording || r.recordingFileId);
    return {
      id: String(r._id),
      phase: ended ? 'ended' : r.jcAnsweredAt ? 'live' : 'ringing',
      direction: r.direction === 'Inbound' ? 'Inbound' : 'Outbound',
      status: String(r.status || ''),
      phone: String(r.phone || ''),
      leadId: String(r.leadId || ''),
      customerName: String(r.customerName || ''),
      startTime: r.startTime ? new Date(r.startTime).toISOString() : '',
      answeredAt: r.jcAnsweredAt ? new Date(r.jcAnsweredAt).toISOString() : '',
      durationSec: Number(r.durationSec) || 0,
      outcome: String(r.outcome || ''),
      notes: String(r.notes || ''),
      aiSummary: String(r.aiSummary || ''),
      aiTemperature: String(r.aiTemperature || ''),
      aiTemperatureReason: String(r.aiTemperatureReason || ''),
      aiPending,
      muted: !!r.jcMuted && !ended,
    };
  }
  return null;
}

/** Calls that ended but still wait for their recording / AI / missed-call step (retries after a failure). */
async function pendingFinish(limit = 20): Promise<string[]> {
  const since = new Date(Date.now() - 3 * 86400000);
  const rows = await (await callsCol())
    .find({
      provider: PROVIDER, status: { $ne: 'In Progress' }, createdAt: { $gte: since },
      $or: [
        { jcRecording: true, recordingFileId: { $in: [null, ''] }, jcAudioTried: { $ne: true } },
        { jcVoicemail: true, recordingFileId: { $in: [null, ''] }, jcAudioTried: { $ne: true } },
        { direction: 'Inbound', status: { $in: ['Missed', 'Voicemail'] }, jcMissedNotified: { $ne: true } },
        { outcome: { $nin: ['', null] }, leadId: { $nin: ['', null] }, jcRemarkDone: { $ne: true } },
      ],
    }, { projection: { _id: 1 } })
    .limit(limit)
    .toArray();
  return rows.map((r) => String(r._id));
}

/**
 * Catch up with JustConnect's call log: every call changed since the last sync (first time: the last 3 days), then the
 * pending recordings / AI / missed-call steps. Stops at `deadline`. Safe to run often and in parallel with the webhook.
 */
export async function syncJcCalls(opts: { deadline?: number; finish?: boolean } = {}): Promise<{ saved: number; created: number; finished: number; skipped?: string }> {
  const out = { saved: 0, created: 0, finished: 0 };
  if (!(await getSecret('JUSTCONNECT_API_KEY'))) return { ...out, skipped: 'not connected' };
  const deadline = opts.deadline || Date.now() + 45_000;
  const s = await settingsAll();
  const since = s.jcCallsCursor || new Date(Date.now() - 3 * 86400000).toISOString();
  const ppl = await people();
  let cursor = since;
  const toFinish: string[] = [];
  for (let page = 1; page <= 50 && Date.now() < deadline; page++) {
    const r = await jc<{ items: JcCall[]; hasMore: boolean }>(`/call-logs?updatedSince=${encodeURIComponent(since)}&limit=100&page=${page}`);
    for (const c of r.items || []) {
      const res = await ingestJcCall(c, ppl);
      if (res.callId) {
        out.saved++;
        if (res.created) out.created++;
        if (res.ended) toFinish.push(res.callId);
      }
      if (c.updatedAt && c.updatedAt > cursor) cursor = c.updatedAt;
    }
    if (!r.hasMore) break;
  }
  if (cursor !== since) await settingSet('jcCallsCursor', cursor, 'System');
  if (opts.finish !== false) {
    const ids = [...new Set([...toFinish, ...(await pendingFinish())])];
    for (const id of ids) {
      if (Date.now() > deadline) break;
      const r = await finishCall(id);
      if (r.recording || r.ai || r.missed || r.remark) out.finished++;
    }
  }
  return out;
}

