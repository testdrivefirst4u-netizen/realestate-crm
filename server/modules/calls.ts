/**
 * Calls & recordings — port of apps-script/18_Calls.gs. Webhook: app/api/webhooks/telephony/route.ts.
 *
 * Sources of call records:
 *  1. Logged from the CRM (click-to-dial + in-app call timer + outcome form).
 *  2. Recording upload from the CRM → GridFS ('Call Recordings') → transcription on demand.
 *  3. Telephony provider webhook: POST /api/webhooks/telephony?provider=zoho|exotel|… (secret in header or ?secret=).
 *     Field names are mapped through the `telephonyFieldMap` setting. The webhook only stores/updates the call;
 *     transcription is started by a user (it can take minutes and costs AI quota).
 */
import type { ActionMap } from '../core/actions';
import { assertLeadAccess } from '../core/scope';
import { assertCallAccess, filterCalls } from '../core/scopeGuards';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, nextSeq } from '../core/db';
import { ApiErrorCode, fail } from '../core/errors';
import { tenantKey } from '../core/tenant';
import { addEvent, addTimeline, logError } from '../core/events';
import { settingsAll } from '../core/settings';
import { last10, num, parseDate, safeJsonParse, str, toIso, truncate } from '../core/utils';
import { findLeadByPhone, getLead, updateLead, type UiLead } from './leads';
import { readFile, saveFile } from './storage';
import { saveRecord } from './records';
import { generateText, transcribeAudio } from './ai';
import { deepFind } from './chat360';

const L = CFG.LEAD;
const RECORDING_FETCH_MAX = 25 * 1024 * 1024;
const TRANSCRIBE_MAX = 19 * 1024 * 1024;
const upstream = (message: string) => fail('SERVER', message);
const STATUSES = ['Completed', 'Missed', 'No Answer', 'Busy', 'Voicemail', 'Failed', 'In Progress'];

const calls = () => col<any>(CFG.COLL.CALLS);

/* ------------------------------ serialization ----------------------------- */

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const s = str(v);
  if (!s) return [];
  const p = safeJsonParse<unknown>(s, null);
  return Array.isArray(p) ? p.map(String) : s.split('\n').map((x) => x.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
}

function serialize(r: any) {
  return {
    id: str(r._id), leadId: str(r.leadId), customerName: str(r.customerName), phone: str(r.phone),
    direction: str(r.direction) || 'Outbound', callDate: toIso(r.callDate), startTime: toIso(r.startTime), endTime: toIso(r.endTime),
    durationSec: num(r.durationSec), status: str(r.status) || 'Completed', outcome: str(r.outcome), provider: str(r.provider),
    providerCallId: str(r.providerCallId), recordingUrl: str(r.recordingUrl), recordingFileId: str(r.recordingFileId),
    transcriptFileId: str(r.transcriptFileId), transcript: str(r.transcript), aiSummary: str(r.aiSummary),
    keyPoints: list(r.keyPoints), followupActions: list(r.followupActions), loggedBy: str(r.loggedBy), createdAt: toIso(r.createdAt), notes: str(r.notes),
  } as Record<string, any>;
}

/** Whitelisted, normalised fields from a client/provider patch (port of Calls_toCells). */
function toFields(c: any) {
  const f: Record<string, any> = {};
  const s = (v: unknown, n = 500) => truncate(str(v), n);
  if (c.leadId !== undefined) f.leadId = s(c.leadId, 40);
  if (c.customerName !== undefined) f.customerName = s(c.customerName, 200);
  if (c.phone !== undefined) {
    f.phone = s(c.phone, 40);
    f.phoneLast10 = last10(c.phone);
  }
  if (c.direction !== undefined) f.direction = str(c.direction) === 'Inbound' ? 'Inbound' : 'Outbound';
  if (c.callDate !== undefined) f.callDate = parseDate(c.callDate);
  if (c.startTime !== undefined) f.startTime = parseDate(c.startTime);
  if (c.endTime !== undefined) f.endTime = parseDate(c.endTime);
  if (c.durationSec !== undefined) f.durationSec = Math.max(0, Math.round(num(c.durationSec)));
  if (c.status !== undefined) f.status = STATUSES.includes(str(c.status)) ? str(c.status) : mapStatus(c.status) || 'Completed';
  if (c.outcome !== undefined) f.outcome = s(c.outcome, 200);
  if (c.provider !== undefined) f.provider = s(c.provider, 60);
  if (c.providerCallId !== undefined) f.providerCallId = s(c.providerCallId, 200);
  if (c.recordingUrl !== undefined) f.recordingUrl = s(c.recordingUrl, 2000);
  if (c.recordingFileId !== undefined) f.recordingFileId = s(c.recordingFileId, 100);
  if (c.transcriptFileId !== undefined) f.transcriptFileId = s(c.transcriptFileId, 100);
  if (c.transcript !== undefined) f.transcript = truncate(str(c.transcript), 45000);
  if (c.aiSummary !== undefined) f.aiSummary = truncate(str(c.aiSummary), 5000);
  if (c.keyPoints !== undefined) f.keyPoints = list(c.keyPoints).slice(0, 50).map((x) => truncate(x, 500));
  if (c.followupActions !== undefined) f.followupActions = list(c.followupActions).slice(0, 50).map((x) => truncate(x, 500));
  if (c.notes !== undefined) f.notes = truncate(str(c.notes), 5000);
  return f;
}

const minutes = (sec: number) => (sec ? Math.round(sec / 60) + ' min' : '');

/* ---------------------------------- reads --------------------------------- */

export async function listCalls(leadId?: string): Promise<any[]> {
  const q = leadId ? { leadId: String(leadId) } : {};
  const rows = (await (await calls()).find(q).sort({ startTime: -1, callDate: -1 }).limit(5000).toArray()).map(serialize).filter((c) => c.id);
  if (!leadId) {
    // Calls without a lead (webhook / logged by number) are matched to an enquiry by phone; the match is a
    // suggestion (matchedLeadId) until the user links it.
    const keys = [...new Set(rows.filter((c) => !c.leadId && last10(c.phone).length === 10).map((c) => last10(c.phone)))].slice(0, 500);
    const byPhone: Record<string, UiLead> = {};
    for (let i = 0; i < keys.length; i += 20) {
      const batch = keys.slice(i, i + 20);
      const found = await Promise.all(batch.map((k) => findLeadByPhone(k).catch(() => null)));
      batch.forEach((k, j) => {
        const lead = found[j];
        if (lead && lead[L.STAGE] !== CFG.STAGES.DELETED) byPhone[k] = lead;
      });
    }
    for (const c of rows) {
      const m = !c.leadId ? byPhone[last10(c.phone)] : undefined;
      if (m) Object.assign(c, { matchedLeadId: m[L.ID] || '', matchedName: m[L.NAME] || '', matchedStage: m[L.STAGE] || '', matchedRM: m[L.RM] || '' });
    }
  }
  const t = (c: any) => new Date(c.startTime || c.callDate).getTime() || 0;
  return rows.sort((a, b) => t(b) - t(a));
}

async function getCall(id: string) {
  if (!id) return null;
  const r = await (await calls()).findOne({ _id: String(id) });
  return r ? serialize(r) : null;
}

/* ---------------------------------- writes -------------------------------- */

const actorOf = (ctx: Ctx | null | undefined, fallback = 'System') => ctx?.user?.name || fallback;

export async function logCall(data: any, ctx: Ctx): Promise<any> {
  if (!data || typeof data !== 'object') throw fail('VALIDATION', 'Call data required');
  const actor = actorOf(ctx, data.loggedBy || 'System');
  let lead: UiLead | null = data.leadId ? await getLead(String(data.leadId)) : null;
  if (!lead && data.phone) lead = await findLeadByPhone(String(data.phone));
  if (!lead && !data.phone) throw fail('VALIDATION', 'Either leadId or phone is required');

  const c = await calls();
  const wanted = typeof data.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(data.id) ? data.id : '';
  const id = wanted && !(await c.findOne({ _id: wanted }, { projection: { _id: 1 } })) ? wanted : await nextSeq('CALL', 5);
  const start = parseDate(data.startTime) || new Date();
  const end = parseDate(data.endTime);
  const duration = data.durationSec !== undefined && data.durationSec !== '' ? num(data.durationSec) : end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000)) : 0;
  const fields = toFields({
    ...data,
    leadId: lead ? lead[L.ID] || '' : '',
    customerName: data.customerName || (lead ? lead[L.NAME] : '') || '',
    phone: data.phone || (lead ? lead[L.PHONE] : '') || '',
    callDate: start, startTime: start, endTime: end || '', durationSec: duration,
    status: data.status || (end ? 'Completed' : 'In Progress'),
    direction: data.direction || 'Outbound',
    provider: data.provider || 'Manual',
  });
  const doc = { ...fields, _id: id, loggedBy: actor, createdAt: new Date() };
  await c.insertOne(doc);
  const call = serialize(doc);
  if (call.leadId) {
    await addTimeline(call.leadId, 'call',
      (call.direction === 'Inbound' ? 'Incoming call' : 'Call made') + (call.status !== 'In Progress' ? ' · ' + call.status : ''),
      minutes(duration) + (call.outcome ? ' · ' + call.outcome : '') + (call.notes ? ' · ' + truncate(call.notes, 200) : ''), actor, 'Call', id);
    if (call.status !== 'In Progress') {
      await addEvent('call_logged', 'Lead', call.leadId, 'Call with ' + call.customerName, (call.outcome || call.status) + (duration ? ' · ' + minutes(duration) : ''), actor);
    }
  }
  await auditLog(ctx, 'Call Logged', 'Call', id, call.customerName);
  await bumpVersion();
  return call;
}

export async function updateCall(id: string, patch: any, ctx: Ctx): Promise<any> {
  const actor = actorOf(ctx);
  const c = await calls();
  const raw = await c.findOne({ _id: String(id || '') });
  if (!raw) throw fail('NOT_FOUND', 'Call not found: ' + id);
  const before = serialize(raw);
  patch = patch && typeof patch === 'object' ? patch : {};
  const fields = toFields(patch);
  if (patch.endTime && !patch.durationSec && before.startTime) {
    const e = parseDate(patch.endTime);
    if (e) fields.durationSec = Math.max(0, Math.round((e.getTime() - new Date(before.startTime).getTime()) / 1000));
    if (!patch.status) fields.status = 'Completed';
  }
  if (Object.keys(fields).length) await c.updateOne({ _id: before.id }, { $set: { ...fields, updatedAt: new Date() } });
  const call = serialize((await c.findOne({ _id: before.id }))!);
  if (before.status === 'In Progress' && call.status !== 'In Progress' && call.leadId) {
    await addTimeline(call.leadId, 'call', 'Call ended · ' + call.status, minutes(call.durationSec) + (call.outcome ? ' · ' + call.outcome : ''), actor, 'Call', call.id);
    await addEvent('call_logged', 'Lead', call.leadId, 'Call with ' + call.customerName, (call.outcome || call.status) + (call.durationSec ? ' · ' + minutes(call.durationSec) : ''), actor);
  }
  await bumpVersion();
  return call;
}

/* -------------------------------- recordings -------------------------------- */

export async function uploadRecording(d: { callId: string; name: string; mime: string; base64: string }, ctx: Ctx): Promise<any> {
  const call = await getCall(d?.callId);
  if (!call) throw fail('NOT_FOUND', 'Call not found');
  if (!call.leadId) throw fail('VALIDATION', 'Link the call to a lead before uploading a recording');
  const b64 = String(d.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!b64) throw fail('VALIDATION', 'Recording data is required');
  const data = Buffer.from(b64, 'base64');
  if (!data.length) throw fail('VALIDATION', 'Recording data is empty');
  const mime = String(d.mime || 'audio/webm');
  if (!/^(audio|video)\//i.test(mime)) throw fail('VALIDATION', 'Recordings must be an audio or video file');
  const name = truncate(String(d.name || call.id + '.webm').replace(/[\\/]/g, '_'), 200);
  const file = await saveFile({ leadId: call.leadId, category: 'Call Recordings', name, mime, data, uploadedBy: actorOf(ctx), description: 'Recording of ' + call.id });
  const updated = await updateCall(call.id, { recordingUrl: file.url, recordingFileId: file.fileId }, ctx);
  await addTimeline(call.leadId, 'call_recording', 'Call recording added', file.name, actorOf(ctx), 'Call', call.id);
  try {
    await saveRecord('documents', { leadId: call.leadId, name: file.name, category: 'Call Recording', fileUrl: file.url, driveFileId: file.fileId, description: 'Recording of ' + call.id }, ctx);
  } catch (e: any) {
    await logError('calls.uploadRecording', 'INTERNAL', 'Could not add the recording to Documents: ' + e?.message, e?.stack, ctx.user?.email || '', { callId: call.id });
  }
  return updated;
}

function allowedRecordingUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return CFG.RECORDING_HOST_ALLOWLIST.some((re) => re.test(u.hostname)) ? u : null;
}

/** Download a provider recording: https + allow-listed host only (re-checked on every redirect), ≤ 25 MB. */
async function downloadRecording(url: string): Promise<{ data: Buffer; mime: string; name: string }> {
  let current = allowedRecordingUrl(url);
  if (!current) throw fail('VALIDATION', 'The recording URL is not on an allowed telephony host (https only).');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(current.toString(), { redirect: 'manual', signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        const next = loc ? allowedRecordingUrl(new URL(loc, current).toString()) : null;
        if (!next) throw fail('VALIDATION', 'The recording URL redirected to a host that is not allowed.');
        current = next;
        continue;
      }
      if (res.status >= 300 || res.status < 200) throw upstream(`Could not download the recording (HTTP ${res.status})`);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > RECORDING_FETCH_MAX) throw fail('VALIDATION', 'Recording is larger than 25 MB.');
      const chunks: Buffer[] = [];
      let total = 0;
      if (res.body) {
        const reader = (res.body as any).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > RECORDING_FETCH_MAX) {
            try { await reader.cancel(); } catch { /* ignore */ }
            throw fail('VALIDATION', 'Recording is larger than 25 MB.');
          }
          chunks.push(Buffer.from(value));
        }
      }
      const mime = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim() || 'audio/mpeg';
      const name = decodeURIComponent(current.pathname.split('/').pop() || '') || 'recording';
      return { data: Buffer.concat(chunks), mime: /^(audio|video)\//.test(mime) ? mime : 'audio/mpeg', name };
    }
    throw upstream('Too many redirects while downloading the recording.');
  } catch (e: any) {
    if (e?.name === 'AbortError') throw upstream('Downloading the recording timed out.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Transcribe the stored recording with Gemini and save transcript + summary. */
export async function transcribe(callId: string, ctx: Ctx): Promise<any> {
  const call = await getCall(callId);
  if (!call) throw fail('NOT_FOUND', 'Call not found');
  const actor = actorOf(ctx);
  let audio: { data: Buffer; mime: string; name: string };
  const localId = call.recordingFileId || (/^\/api\/files\/([A-Za-z0-9_-]+)$/.exec(call.recordingUrl || '') || [])[1] || '';
  if (localId) {
    const f = await readFile(localId);
    if (!f) throw fail('NOT_FOUND', 'The recording file could not be found');
    audio = { data: f.data, mime: f.mime, name: f.name };
  } else if (call.recordingUrl && /^https?:\/\//i.test(call.recordingUrl)) {
    audio = await downloadRecording(call.recordingUrl);
    if (audio.data.length > TRANSCRIBE_MAX) throw fail('VALIDATION', 'Recording is larger than 19 MB; compress it (e.g. to MP3/OGG) before transcription.');
    // keep a copy so the history is permanent
    if (call.leadId) {
      const saved = await saveFile({ leadId: call.leadId, category: 'Call Recordings', name: truncate(call.id + '_' + audio.name, 200), mime: audio.mime, data: audio.data, uploadedBy: actor, description: 'Recording of ' + call.id });
      await updateCall(call.id, { recordingFileId: saved.fileId, recordingUrl: saved.url }, ctx);
    }
  } else {
    throw fail('VALIDATION', 'This call has no recording to transcribe');
  }
  if (audio.data.length > TRANSCRIBE_MAX) throw fail('VALIDATION', 'Recording is larger than 19 MB; compress it (e.g. to MP3/OGG) before transcription.');
  const mime = /^(audio|video)\//.test(audio.mime) ? audio.mime : 'audio/mpeg';
  const { transcription } = await transcribeAudio(audio.data.toString('base64'), mime, ctx);
  if (!transcription) throw upstream('The AI returned an empty transcript. Please try again.');

  let transcriptFileId = '';
  if (call.leadId) {
    try {
      const f = await saveFile({ leadId: call.leadId, category: 'Call Transcripts', name: call.id + '_transcript.txt', mime: 'text/plain', data: Buffer.from(transcription, 'utf8'), uploadedBy: actor, description: 'Transcript of ' + call.id });
      transcriptFileId = f.fileId;
    } catch (e: any) {
      await logError('calls.transcribe', 'INTERNAL', 'Could not store transcript file: ' + e?.message, e?.stack, ctx.user?.email || '', { callId: call.id });
    }
  }
  await updateCall(call.id, { transcript: transcription, transcriptFileId }, ctx);
  if (call.leadId) await addTimeline(call.leadId, 'call_transcript', 'Call transcript generated', truncate(transcription, 300), actor, 'Call', call.id);
  return summarize(call.id, ctx);
}

/* --------------------------------- summary --------------------------------- */

const OUTCOMES = ['Interested', 'Site Visit Planned', 'Needs Follow-up', 'Not Interested', 'No Answer', 'Booked', 'Other'];

/** Structured summary of a transcript (port of AI_summarizeTranscript). */
async function summarizeTranscript(transcript: string, lead: UiLead | null, ctx: Ctx) {
  const context = lead ? `Lead: ${lead[L.NAME]}, stage ${lead[L.STAGE]}, interested in ${lead[L.UNIT_TYPE] || 'unspecified unit'}. ` : '';
  const prompt = context + 'Below is the transcript of a sales call for Amaya by Vera Vita (senior living residences, Hyderabad). ' +
    'Return STRICT JSON with keys: summary (3-5 sentences), keyPoints (array of short strings: requirements, budget, family, timeline, objections), ' +
    'followupActions (array of short imperative strings), outcome (one of: ' + OUTCOMES.join(', ') + '), ' +
    'nextFollowup (ISO-8601 date-time in Asia/Kolkata if a specific follow-up time was agreed, else null).\n\nTRANSCRIPT:\n' + truncate(transcript, 60000);
  const text = await generateText(prompt, ctx, { json: true, maxOutputTokens: 1024, temperature: 0.1 });
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed = safeJsonParse<any>(cleaned, null) || {};
  const next = parsed.nextFollowup ? parseDate(parsed.nextFollowup) : null;
  return {
    summary: String(parsed.summary || (typeof parsed === 'object' && Object.keys(parsed).length ? '' : text) || '').trim(),
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String) : [],
    followupActions: Array.isArray(parsed.followupActions) ? parsed.followupActions.map(String) : [],
    outcome: parsed.outcome ? truncate(String(parsed.outcome), 60) : '',
    nextFollowup: next ? next.toISOString() : '',
  };
}

export async function summarize(callId: string, ctx: Ctx): Promise<any> {
  const call = await getCall(callId);
  if (!call) throw fail('NOT_FOUND', 'Call not found');
  if (!call.transcript) throw fail('VALIDATION', 'Transcribe the call first');
  const lead = call.leadId ? await getLead(call.leadId) : null;
  const result = await summarizeTranscript(call.transcript, lead, ctx);
  const updated = await updateCall(call.id, {
    aiSummary: result.summary, keyPoints: result.keyPoints, followupActions: result.followupActions, outcome: call.outcome || result.outcome || '',
  }, ctx);
  if (call.leadId) {
    await addTimeline(call.leadId, 'call_summary', 'AI call summary', result.summary, actorOf(ctx), 'Call', call.id);
    if (result.nextFollowup) {
      try {
        await updateLead(call.leadId, { [L.NEXT_FOLLOWUP]: result.nextFollowup }, ctx);
      } catch { /* non-fatal */ }
    }
  }
  return updated;
}

/* ------------------------------ provider webhook ------------------------------ */

export function mapStatus(s: unknown) {
  const v = String(s || '').toLowerCase();
  if (!v) return '';
  if (/no[-_ ]?answer|unanswer|not[-_ ]?answered/.test(v)) return 'No Answer';
  if (/miss/.test(v)) return 'Missed';
  if (/complete|answer|success|connected/.test(v)) return 'Completed';
  if (/busy/.test(v)) return 'Busy';
  if (/voicemail/.test(v)) return 'Voicemail';
  if (/fail|error|cancel/.test(v)) return 'Failed';
  return 'Completed';
}

/** Serialise deliveries per provider call id inside this process (provider retries arrive in parallel). */
const callLocks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const prev = callLocks.get(tenantKey(key)) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  callLocks.set(tenantKey(key), tail);
  try {
    return await run;
  } finally {
    if (callLocks.get(tenantKey(key)) === tail) callLocks.delete(tenantKey(key));
  }
}

/** Process one telephony webhook payload (already authenticated by the route). */
export async function handleWebhook(payload: any, provider: string): Promise<unknown> {
  payload = payload && typeof payload === 'object' ? payload : {};
  const providerName = truncate(String(provider || '').replace(/[^\w .-]/g, '').trim(), 60) || 'Telephony';
  const ctx: Ctx = { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: providerName }, action: 'telephony.webhook' };
  const map = safeJsonParse<Record<string, string>>((await settingsAll()).telephonyFieldMap || CFG.SETTING_DEFAULTS.telephonyFieldMap, {}) || {};
  const pick = (key: string): any => {
    const field = map[key] || key;
    const v = deepFind(payload, [field, key]);
    return v === undefined || (v && typeof v === 'object') ? '' : v;
  };
  const providerCallId = truncate(str(pick('callId')), 200);

  return withLock(providerName + '|' + providerCallId, async () => {
    if (providerCallId) {
      const existing = await (await calls()).findOne({ provider: providerName, providerCallId });
      if (existing) {
        // update (e.g. recording ready after the call ended)
        const patch: Record<string, any> = {};
        if (pick('recordingUrl')) patch.recordingUrl = String(pick('recordingUrl'));
        if (pick('endTime')) patch.endTime = pick('endTime');
        if (pick('duration')) patch.durationSec = num(pick('duration'));
        if (pick('status')) patch.status = mapStatus(pick('status'));
        await updateCall(String(existing._id), patch, ctx);
        return { ok: true, callId: String(existing._id), updated: true };
      }
    }
    const from = str(pick('from')), to = str(pick('to'));
    // 'Outgoing' contains 'in' — decide on 'out' first, then inbound/missed, default Outbound.
    const dirRaw = str(pick('direction')).toLowerCase();
    const direction = /out/.test(dirRaw) ? 'Outbound' : /in|missed|received/.test(dirRaw) ? 'Inbound' : 'Outbound';
    const customerPhone = direction === 'Inbound' ? from : to;
    if (!last10(customerPhone)) return { ok: true, ignored: 'no-phone' };
    const call = await logCall({
      phone: customerPhone, direction, provider: providerName, providerCallId,
      startTime: pick('startTime') || new Date().toISOString(), endTime: pick('endTime') || '',
      durationSec: pick('duration') ? num(pick('duration')) : undefined,
      status: mapStatus(pick('status')) || (pick('endTime') ? 'Completed' : 'In Progress'),
      recordingUrl: str(pick('recordingUrl')),
    }, ctx);
    return { ok: true, callId: call.id };
  });
}

/** Stored-file references are set only by the server (upload/transcribe), never by a browser patch. */
function clientPatch(p: any) {
  if (!p || typeof p !== 'object') return p;
  const { recordingFileId: _r, transcriptFileId: _t, loggedBy: _l, createdAt: _c, ...rest } = p;
  return rest;
}

export const actions: ActionMap = {
  getCalls: { fn: async (d, ctx) => { await assertLeadAccess(ctx, d.leadId); return filterCalls(ctx.user, await listCalls(d.leadId)); }, perm: 'calls.view' },
  logCall: { fn: async (d, ctx) => { await assertLeadAccess(ctx, d.data?.leadId); return logCall(clientPatch(d.data), ctx); }, perm: 'calls.log' },
  updateCall: { fn: async (d, ctx) => { await assertCallAccess(ctx, d.id); if (d.data?.leadId) await assertLeadAccess(ctx, d.data.leadId); return updateCall(d.id, clientPatch(d.data), ctx); }, perm: 'calls.log' },
  uploadCallRecording: { fn: async (d, ctx) => { await assertCallAccess(ctx, d.callId); return uploadRecording(d, ctx); }, perm: 'calls.log' },
  transcribeCall: { fn: async (d, ctx) => { await assertCallAccess(ctx, d.callId); return transcribe(d.callId, ctx); }, perm: 'calls.log' },
  summarizeCall: { fn: async (d, ctx) => { await assertCallAccess(ctx, d.callId); return summarize(d.callId, ctx); }, perm: 'calls.log' },
};
