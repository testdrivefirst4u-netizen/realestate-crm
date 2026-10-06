/**
 * AI (Gemini) — port of apps-script/19_AI.gs. The key never leaves the server.
 *
 *  aiChat      : generateContent passthrough used by the Copilot's function-calling loop (contents / tools /
 *                toolConfig / systemInstruction). Hardened: only the configured models may be requested,
 *                maxOutputTokens ≤ 8192, request size capped, per-user daily quota.
 *  aiReframe   : polish a follow-up remark (fast model).
 *  aiTranscribe: speech → text (voice notes, call recordings).
 *  generateText: plain prompt → text (call summaries).
 *  aiSummarizeLead: narrative history of one lead (timeline + calls + WhatsApp).
 *
 * Transient failures (429 / 5xx / network) are retried once per model, then the fallback chain is walked,
 * all inside a total time budget (~60 s by default) so a request never hangs the serverless function.
 */
import type { ActionMap } from '../core/actions';
import { assertLeadAccess } from '../core/scope';
import type { Ctx } from '../core/auth';
import { auditLog } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { ApiErrorCode, fail } from '../core/errors';
import { logError, serializeTimeline } from '../core/events';
import { getSecret, settingsAll } from '../core/settings';
import { dateKey, fmtHuman, safeJsonParse, truncate } from '../core/utils';
import { getLead } from './leads';
import { listCalls } from './calls';
import { messages as chatMessages } from './chat360';

/* --------------------------------- config -------------------------------- */

export const AI_USAGE_COLL = 'aiUsage';
const FALLBACK_CHAIN = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const MAX_OUTPUT_TOKENS = 8192;
const MAX_CONTENTS_BYTES = 200 * 1024;
const MAX_TOOLS_BYTES = 200 * 1024;
const MAX_SYSTEM_CHARS = 100 * 1024;
const DEFAULT_BUDGET_MS = 60_000;
const TRANSCRIBE_BUDGET_MS = 150_000; // audio is slow; the UI waits up to 180 s
const MAX_AUDIO_B64 = 26 * 1024 * 1024; // ~19 MB of audio (Gemini inline-data limit is 20 MB per request)

/** Upstream failure whose message the user should see (the browser knows the 'SERVER' code; the router passes it through). */
const upstream = (message: string) => fail('SERVER', message);

async function apiKey() {
  const k = await getSecret('GEMINI_API_KEY');
  if (!k) throw fail('NOT_CONFIGURED', 'Gemini API key is not configured. Add it under Settings → Integrations → AI.');
  return k;
}

async function modelFor(kind: 'chat' | 'fast' | 'transcribe') {
  const s = await settingsAll();
  if (kind === 'transcribe') return s.aiTranscribeModel || CFG.SETTING_DEFAULTS.aiTranscribeModel;
  if (kind === 'fast') return s.aiFastModel || CFG.SETTING_DEFAULTS.aiFastModel;
  return s.aiModel || CFG.SETTING_DEFAULTS.aiModel;
}

export function fallbackChain(preferred: string) {
  const out = [preferred];
  for (const m of FALLBACK_CHAIN) if (!out.includes(m)) out.push(m);
  return out;
}

const isTransient = (code: number) => code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
const endpoint = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- quota --------------------------------- */

export function dailyLimit() {
  const n = parseInt(process.env.AI_DAILY_LIMIT || '', 10);
  return n > 0 ? n : 300;
}

/** Count one AI request against the user's daily quota (atomic). System/webhook contexts are not metered. */
export async function consumeQuota(ctx: Ctx | null | undefined) {
  const userId = ctx?.user?.id;
  if (!userId || userId === 'SYSTEM') return;
  const day = dateKey(new Date());
  const c = await col<{ _id: string; count: number }>(AI_USAGE_COLL);
  const res = await c.findOneAndUpdate(
    { _id: `${userId}:${day}` },
    { $inc: { count: 1 }, $setOnInsert: { userId, date: day, createdAt: new Date() } as any },
    { upsert: true, returnDocument: 'after' }
  );
  const limit = dailyLimit();
  if ((res?.count || 0) > limit) {
    throw fail('RATE_LIMIT', `Daily AI limit reached (${limit} requests per user per day). It resets at midnight.`);
  }
}

/* ------------------------------ low-level call ----------------------------- */

interface GenOpts { noFallback?: boolean; budgetMs?: number }

/**
 * POST generateContent. Returns the parsed response with `_model` = the model that answered.
 * Retries a transient failure once on the same model, then moves down the fallback chain, within budgetMs.
 */
async function generate(model: string, body: unknown, opts: GenOpts = {}): Promise<any> {
  const key = await apiKey();
  const models = opts.noFallback ? [model] : fallbackChain(model);
  const deadline = Date.now() + (opts.budgetMs || DEFAULT_BUDGET_MS);
  const payload = JSON.stringify(body);
  let lastErr: Error | null = null;

  outer: for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1000) break outer;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), remaining);
      let code = 0;
      let text = '';
      try {
        const res = await fetch(endpoint(m), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: payload,
          signal: ctrl.signal,
        });
        code = res.status;
        text = await res.text();
      } catch (e: any) {
        clearTimeout(timer);
        const timedOut = e?.name === 'AbortError';
        lastErr = upstream(timedOut ? 'Gemini did not answer in time. Please try again.' : 'Could not reach Gemini: ' + (e?.message || e));
        if (timedOut) break outer; // budget exhausted
        if (attempt === 0) {
          await sleep(400);
          continue;
        }
        break;
      }
      clearTimeout(timer);

      if (code >= 200 && code < 300) {
        const out = safeJsonParse<any>(text, {}) || {};
        out._model = m;
        if (m !== model) await logError('ai.fallback', 'INFO', `Answered by ${m} because ${model} was unavailable`, '', '', { requested: model, used: m });
        return out;
      }
      const parsed = safeJsonParse<any>(text, {}) || {};
      const msg = parsed?.error?.message ? String(parsed.error.message) : text;
      if ((code === 400 || code === 401 || code === 403) && /API key/i.test(msg)) {
        throw fail('NOT_CONFIGURED', 'Gemini rejected the API key. Re-enter it in Settings → Integrations → AI.');
      }
      if (code === 404) {
        lastErr = fail('NOT_CONFIGURED', `Gemini model "${m}" was not found. Choose another model in Settings → AI.`);
        break; // next model
      }
      if (isTransient(code)) {
        lastErr = code === 429
          ? fail('RATE_LIMIT', `Gemini is busy right now (HTTP 429). ${truncate(msg, 160)}`)
          : upstream(`Gemini is busy right now (HTTP ${code}). ${truncate(msg, 160)}`);
        if (attempt === 0) {
          await sleep(Math.min(code === 429 ? 1200 : 600, Math.max(0, deadline - Date.now() - 1000)));
          continue;
        }
        break; // second failure → next model
      }
      await logError('ai.generate', 'UPSTREAM_' + code, msg, '', '', { model: m });
      throw upstream(`Gemini error (HTTP ${code}): ${truncate(msg, 300)}`);
    }
  }
  await logError('ai.generate', 'UNAVAILABLE', lastErr ? lastErr.message : 'all models failed', '', '', { models });
  throw lastErr || upstream('The AI service is unavailable right now.');
}

export function textOf(resp: any): string {
  try {
    const parts: any[] = resp.candidates[0].content.parts || [];
    return parts.map((p) => (p && !p.thought && p.text) || '').join('').trim();
  } catch {
    return '';
  }
}

/* ---------------------------------- chat --------------------------------- */

const GEN_KEYS = ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stopSequences', 'responseMimeType', 'responseSchema', 'thinkingConfig', 'presencePenalty', 'frequencyPenalty', 'seed'];

function sanitizeGenerationConfig(input: any) {
  const out: Record<string, any> = { temperature: 0.2, maxOutputTokens: 2048 };
  if (input && typeof input === 'object') for (const k of GEN_KEYS) if (input[k] !== undefined) out[k] = input[k];
  const max = Number(out.maxOutputTokens);
  out.maxOutputTokens = Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), MAX_OUTPUT_TOKENS) : 2048;
  const t = Number(out.temperature);
  out.temperature = Number.isFinite(t) ? Math.min(Math.max(t, 0), 2) : 0.2;
  return out;
}

const byteLen = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

export async function chat(d: any, ctx: Ctx): Promise<{ candidates: any[]; model: string; usage?: any }> {
  if (!d || !Array.isArray(d.contents) || !d.contents.length) throw fail('VALIDATION', 'contents[] is required');
  const contents = d.contents.slice(-40);
  if (!contents.every((c: any) => c && typeof c === 'object' && Array.isArray(c.parts))) throw fail('VALIDATION', 'Each content needs a parts[] array');
  if (byteLen(contents) > MAX_CONTENTS_BYTES) throw fail('VALIDATION', 'The conversation is too long. Start a new chat.');
  if (d.tools !== undefined && (!Array.isArray(d.tools) || byteLen(d.tools) > MAX_TOOLS_BYTES)) throw fail('VALIDATION', 'Invalid tools');
  if (d.systemInstruction && String(d.systemInstruction).length > MAX_SYSTEM_CHARS) throw fail('VALIDATION', 'System instruction is too long');

  const s = await settingsAll();
  const allowed = [s.aiModel || CFG.SETTING_DEFAULTS.aiModel, s.aiFastModel || CFG.SETTING_DEFAULTS.aiFastModel];
  const model = typeof d.model === 'string' && allowed.includes(d.model) ? d.model : allowed[0];

  const body: Record<string, any> = { contents, generationConfig: sanitizeGenerationConfig(d.generationConfig) };
  if (d.systemInstruction) body.systemInstruction = { parts: [{ text: String(d.systemInstruction) }] };
  if (Array.isArray(d.tools) && d.tools.length) body.tools = d.tools;
  if (d.toolConfig && typeof d.toolConfig === 'object') body.toolConfig = d.toolConfig;

  await consumeQuota(ctx);
  const resp = await generate(model, body);
  const candidates = (resp.candidates || []).map((c: any) => ({ content: c.content, finishReason: c.finishReason, groundingMetadata: c.groundingMetadata }));
  return { candidates, model: resp._model || model, usage: resp.usageMetadata || null };
}

/* --------------------------------- reframe -------------------------------- */

export async function reframe(text: string, ctx: Ctx): Promise<{ result: string; model?: string }> {
  const t = String(text || '').trim();
  if (!t) throw fail('VALIDATION', 'Text is required');
  if (t.length > 8000) throw fail('VALIDATION', 'Text is too long to reframe (max 8000 characters)');
  await consumeQuota(ctx);
  const resp = await generate(await modelFor('fast'), {
    contents: [{ role: 'user', parts: [{ text: 'Correct grammar, spelling and punctuation. Rewrite this real-estate sales follow-up remark so it is warm, concise and human, in British English. Preserve every fact, date, number and name exactly. Return only the rewritten remark.\n\n' + t }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: Math.min(400, Math.max(80, Math.ceil(t.length / 2))) },
  });
  return { result: textOf(resp) || t, model: resp._model };
}

/* ------------------------------- transcription ----------------------------- */

/** Transcribe audio bytes (base64). Used by aiTranscribe and by calls.transcribe. */
export async function transcribeAudio(audioBase64: string, mimeType: string, ctx: Ctx): Promise<{ transcription: string }> {
  const clean = String(audioBase64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!clean) throw fail('VALIDATION', 'audioBase64 is required');
  if (clean.length > MAX_AUDIO_B64) throw fail('VALIDATION', 'Audio is too large (max ~19 MB).');
  const mime = String(mimeType || 'audio/webm').split(';')[0].trim().toLowerCase() || 'audio/webm';
  if (!/^(audio|video)\/[a-z0-9.+-]+$/.test(mime)) throw fail('VALIDATION', 'Unsupported audio type: ' + truncate(mime, 60));
  await consumeQuota(ctx);
  const resp = await generate(await modelFor('transcribe'), {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: mime, data: clean } },
      { text: 'Transcribe this audio accurately. Speakers may mix English, Hindi and Telugu; transcribe each sentence in the language spoken (Roman script for Hindi/Telugu is acceptable). Do not add commentary.' },
    ] }],
    generationConfig: { temperature: 0 },
  }, { budgetMs: TRANSCRIBE_BUDGET_MS });
  return { transcription: textOf(resp) };
}

/* ------------------------------- text generation --------------------------- */

/** Plain text generation with the configured model (used by call summaries, lead summaries). */
export async function generateText(
  prompt: string,
  ctx: Ctx,
  opts?: { fast?: boolean; system?: string; maxOutputTokens?: number; json?: boolean; temperature?: number }
): Promise<string> {
  const p = String(prompt || '');
  if (!p.trim()) throw fail('VALIDATION', 'Prompt is required');
  await consumeQuota(ctx);
  const generationConfig: Record<string, any> = {
    temperature: opts?.temperature ?? 0.2,
    maxOutputTokens: Math.min(Math.max(1, opts?.maxOutputTokens || 1024), MAX_OUTPUT_TOKENS),
  };
  if (opts?.json) generationConfig.responseMimeType = 'application/json';
  const body: Record<string, any> = { contents: [{ role: 'user', parts: [{ text: p }] }], generationConfig };
  if (opts?.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  const resp = await generate(await modelFor(opts?.fast ? 'fast' : 'chat'), body);
  return textOf(resp);
}

/* ------------------------------- lead summary ------------------------------ */

/** Narrative summary of a lead's full history (timeline + calls + chats). */
export async function summarizeLead(leadId: string, ctx: Ctx): Promise<{ summary: string }> {
  if (!leadId) throw fail('VALIDATION', 'leadId is required');
  const lead = await getLead(String(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const L = CFG.LEAD;

  const tlRows = await (await col(CFG.COLL.TIMELINE)).find({ leadId: String(leadId) }).sort({ timestamp: -1 }).limit(60).toArray();
  const timeline = tlRows.map(serializeTimeline).reverse();
  const lines = timeline.map((e) => `- ${fmtHuman(e.timestamp)} · ${e.title}${e.details ? ': ' + truncate(e.details, 200) : ''}`);

  let calls: string[] = [];
  try {
    calls = (await listCalls(String(leadId))).slice(0, 5).map((c: any) => `- Call ${fmtHuman(c.startTime || c.callDate)} ${c.status}${c.aiSummary ? ': ' + truncate(c.aiSummary, 300) : ''}`);
  } catch { /* non-fatal */ }
  let chats: string[] = [];
  try {
    if (lead[L.PHONE]) chats = (await chatMessages(lead[L.PHONE])).slice(-15).map((m: any) => `- ${m.direction === 'Inbound' ? 'Customer' : 'RM'} (${fmtHuman(m.timestamp)}): ${truncate(m.text, 200)}`);
  } catch { /* non-fatal */ }

  const prompt =
    "You are the CRM assistant for Amaya by Vera Vita (senior living, Medchal, Hyderabad). Summarise this customer's history for a relationship manager in 5-8 short bullet points, then one line \"Recommended next step:\". British English, warm but precise, no marketing fluff.\n\n" +
    'LEAD: ' + JSON.stringify({
      id: lead[L.ID], name: lead[L.NAME], stage: lead[L.STAGE], source: lead[L.SOURCE], unit: lead[L.UNIT_TYPE], siteVisit: lead[L.SITE_VISIT_STATUS],
      rm: lead[L.RM], enquiredFor: lead[L.ENQUIRED_FOR], notes: lead[L.NOTES], nextFollowup: fmtHuman(lead[L.NEXT_FOLLOWUP]),
    }) +
    '\n\nTIMELINE:\n' + lines.join('\n') + (calls.length ? '\n\nCALLS:\n' + calls.join('\n') : '') + (chats.length ? '\n\nWHATSAPP:\n' + chats.join('\n') : '');

  await consumeQuota(ctx);
  const resp = await generate(await modelFor('chat'), { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 800 } });
  const summary = textOf(resp);
  await auditLog(ctx, 'AI Lead Summary', 'Lead', String(leadId), '');
  return { summary };
}

/* ---------------------------------- test ---------------------------------- */

export async function test(): Promise<{ ok: boolean; message: string; model: string }> {
  const model = await modelFor('chat');
  try {
    const resp = await generate(model, { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 5 } }, { noFallback: true, budgetMs: 30_000 });
    return { ok: true, message: `Gemini responded (${truncate(textOf(resp), 20)}) using ${model}`, model };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e), model };
  }
}

export const actions: ActionMap = {
  aiChat: { fn: (d, ctx) => chat(d, ctx), perm: 'ai.use' },
  aiReframe: { fn: (d, ctx) => reframe(d.text, ctx), perm: 'ai.use' },
  aiTranscribe: { fn: (d, ctx) => transcribeAudio(d.audioBase64, d.mimeType, ctx), perm: 'ai.use' },
  aiSummarizeLead: { fn: async (d, ctx) => { await assertLeadAccess(ctx, d.leadId); return summarizeLead(d.leadId, ctx); }, perm: 'ai.use' },
  aiTest: { fn: () => test(), perm: 'settings.view' },
};
