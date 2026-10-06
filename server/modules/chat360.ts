/**
 * Chat360 (WhatsApp) — port of apps-script/17_Chat360.gs. Webhook: app/api/webhooks/chat360/route.ts.
 *
 * Inbound : POST /api/webhooks/chat360 (secret in `x-webhook-secret` header or `?secret=`).
 *           Events: message_received, session_message_sent, template_message_sent, sent_message_delivered,
 *           sent_message_read, lead capture. De-duplicated on event_response_id / m_id through the unique
 *           `dedupeKey` index (a duplicate insert = a Chat360 retry).
 * Outbound: fetch to the configured base URL + path (https on chat360.io, validated on save) with the API key.
 * Mapping : contacts ↔ leads by the last 10 digits of the phone; new WhatsApp customers become enquiries
 *           when chat360AutoCreateLeads is on, never duplicating a known phone.
 */
import type { ActionMap } from '../core/actions';
import { assertLeadAccess } from '../core/scope';
import { assertPhoneAccess, filterContacts } from '../core/scopeGuards';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col } from '../core/db';
import { ApiErrorCode, fail } from '../core/errors';
import { tenantKey } from '../core/tenant';
import { addEvent, addTimeline, logError } from '../core/events';
import { getSecret, settingsAll } from '../core/settings';
import { bool, digits, e164, last10, maskSecret, num, parseDate, safeJsonParse, shortId, str, toIso, truncate } from '../core/utils';
import { addLead, findLeadByPhone, getLead, type UiLead } from './leads';

const L = CFG.LEAD;
const FETCH_TIMEOUT_MS = 20_000;
const RAW_MAX = 4000;
const upstream = (message: string) => fail('SERVER', message);

/* --------------------------------- config -------------------------------- */

async function chatCfg() {
  const s = await settingsAll();
  const D = CFG.SETTING_DEFAULTS;
  return {
    apiKey: await getSecret('CHAT360_API_KEY'),
    baseUrl: String(s.chat360BaseUrl || D.chat360BaseUrl).replace(/\/+$/, ''),
    sendPath: s.chat360SendPath || D.chat360SendPath,
    templatePath: s.chat360TemplatePath || D.chat360TemplatePath,
    authHeader: s.chat360AuthHeader || D.chat360AuthHeader,
    authPrefix: s.chat360AuthPrefix !== undefined ? s.chat360AuthPrefix : D.chat360AuthPrefix,
    autoCreate: bool(s.chat360AutoCreateLeads === undefined || s.chat360AutoCreateLeads === '' ? D.chat360AutoCreateLeads : s.chat360AutoCreateLeads),
    defaultRM: s.chat360DefaultRM || '',
    defaultSource: s.chat360DefaultSource || 'Chat360',
  };
}
type ChatCfg = Awaited<ReturnType<typeof chatCfg>>;

/** Join base URL and a configured path, refusing anything that would leave the base host. */
function joinUrl(base: string, path: string) {
  const p = String(path || '');
  if (/^[a-z]+:\/\//i.test(p) || p.startsWith('//')) throw fail('VALIDATION', 'Chat360 endpoint paths must be relative (e.g. /api/v1/messages/send)');
  return base + (p.startsWith('/') ? p : '/' + p);
}

function headersFor(cfg: ChatCfg) {
  const name = String(cfg.authHeader || 'Authorization').trim();
  if (!/^[A-Za-z0-9-]+$/.test(name)) throw fail('VALIDATION', 'Invalid Chat360 auth header name');
  return { 'Content-Type': 'application/json', [name]: (cfg.authPrefix || '') + cfg.apiKey } as Record<string, string>;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ serialization ----------------------------- */

const msgs = () => col<any>(CFG.COLL.CHAT_MESSAGES);
const contactsCol = () => col<any>(CFG.COLL.CHAT_CONTACTS);

function serializeMsg(r: any) {
  return {
    id: str(r._id), eventId: str(r.eventId), direction: (str(r.direction) || 'Inbound') as 'Inbound' | 'Outbound', phone: str(r.phone),
    contactName: str(r.contactName), leadId: str(r.leadId), messageType: str(r.messageType), text: str(r.text),
    mediaUrl: str(r.mediaUrl), status: str(r.status), timestamp: toIso(r.timestamp), agent: str(r.agent),
  };
}

function serializeContact(r: any) {
  return {
    phone: str(r.phone), contactName: str(r.contactName), leadId: str(r.leadId), lastMessageAt: toIso(r.lastMessageAt),
    lastMessage: str(r.lastMessage), unreadCount: num(r.unreadCount), assignedRM: str(r.assignedRM), status: str(r.status),
  };
}

/* --------------------------------- reads --------------------------------- */

export async function contacts(): Promise<any[]> {
  const rows = await (await contactsCol()).find({}).sort({ lastMessageAt: -1 }).limit(5000).toArray();
  return rows.map(serializeContact).filter((c) => c.phone);
}

export async function messages(phone: string): Promise<any[]> {
  const key = last10(phone);
  if (!key) return [];
  // newest 2000, returned oldest → newest
  const rows = await (await msgs()).find({ phoneLast10: key }).sort({ timestamp: -1 }).limit(2000).toArray();
  return rows.reverse().map(serializeMsg);
}

/* --------------------------------- contacts -------------------------------- */

/** Upsert the contact for a phone; `inc` adds to counters atomically. Returns the contact after the write. */
async function upsertContact(phone: string, patch: Record<string, any>, inc?: Record<string, number>) {
  const key = last10(phone);
  if (!key) throw fail('VALIDATION', 'A valid phone number is required');
  const c = await contactsCol();
  const $set = { ...patch, updatedAt: new Date() };
  const $setOnInsert: Record<string, any> = { phone: e164(phone), status: 'Open', unreadCount: 0, createdAt: new Date() };
  for (const k of [...Object.keys($set), ...Object.keys(inc || {})]) delete $setOnInsert[k];
  const update: any = { $set, $setOnInsert };
  if (inc) update.$inc = inc;
  for (let attempt = 0; ; attempt++) {
    try {
      return await c.findOneAndUpdate({ phoneLast10: key }, update, { upsert: true, returnDocument: 'after' });
    } catch (e: any) {
      if (e?.code === 11000 && attempt === 0) continue; // concurrent upsert of a new contact — retry as an update
      throw e;
    }
  }
}

export async function markRead(phone: string): Promise<void> {
  if (!last10(phone)) throw fail('VALIDATION', 'phone is required');
  await upsertContact(phone, { unreadCount: 0 });
}

export async function mapContact(phone: string, leadId: string, ctx: Ctx): Promise<void> {
  const key = last10(phone);
  if (!key || key.length < 10) throw fail('VALIDATION', 'A valid phone number is required');
  if (!leadId) throw fail('VALIDATION', 'leadId is required');
  const lead = await getLead(String(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  await upsertContact(phone, { leadId: String(leadId), contactName: lead[L.NAME] || '', assignedRM: lead[L.RM] || '' });
  // back-fill the lead id on earlier messages
  await (await msgs()).updateMany({ phoneLast10: key, $or: [{ leadId: '' }, { leadId: { $exists: false } }, { leadId: null }] }, { $set: { leadId: String(leadId) } });
  await addTimeline(String(leadId), 'chat_linked', 'WhatsApp contact linked', e164(phone), ctx.user?.name, 'Chat', phone);
  await auditLog(ctx, 'Chat Contact Mapped', 'Chat', phone, String(leadId));
  await bumpVersion();
}

/* ------------------------------ lead resolution ----------------------------- */

/** Per-phone in-process lock: parallel webhook deliveries for one customer must not double-create a lead. */
const phoneLocks = new Map<string, Promise<unknown>>();
async function withPhoneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = phoneLocks.get(tenantKey(key)) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  phoneLocks.set(tenantKey(key), tail);
  try {
    return await run;
  } finally {
    if (phoneLocks.get(tenantKey(key)) === tail) phoneLocks.delete(tenantKey(key));
  }
}

const chat360Ctx = (): Ctx => ({ ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: 'Chat360' }, action: 'chat360.webhook' });

async function resolveLead(phone: string, contactName: string, cfg: ChatCfg): Promise<UiLead | null> {
  return withPhoneLock(last10(phone), async () => {
    const existing = await findLeadByPhone(phone);
    if (existing) return existing;
    if (!cfg.autoCreate) return null;
    const obj: UiLead = {
      [L.NAME]: contactName || 'WhatsApp ' + e164(phone),
      [L.PHONE]: '+' + e164(phone),
      [L.STAGE]: CFG.STAGES.NEW,
      [L.SOURCE]: cfg.defaultSource,
      [L.RM]: cfg.defaultRM,
      [L.BROCHURE]: 'No',
      [L.SITE_VISIT_STATUS]: CFG.SITE_VISIT.PROSPECT,
    };
    try {
      const res = await addLead(obj, chat360Ctx(), { returnExisting: true, actor: 'Chat360', eventSource: 'chat360' });
      return res.lead;
    } catch (e: any) {
      // A concurrent request (or another instance) may have created it — use that one.
      const again = await findLeadByPhone(phone);
      if (again) return again;
      throw e;
    }
  });
}

/* ---------------------------- payload extraction ---------------------------- */

export function deepFind(obj: any, keys: string[], depth = 0): any {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const found = deepFind(v, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function extractText(p: any): string {
  const wr = p.wab_response || p.message || p.data || p;
  const candidates = [deepFind(wr, ['body']), deepFind(wr, ['text']), deepFind(wr, ['caption']), deepFind(p, ['message_text', 'msg', 'content'])];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (c && typeof c === 'object' && typeof c.body === 'string') return c.body;
  }
  return '';
}

function extractPhone(p: any, inbound: boolean): string {
  const keys = inbound
    ? ['sender_num', 'from', 'user_num', 'customer_num', 'wa_id', 'mobile', 'phone', 'receiver_num']
    : ['receiver_num', 'to', 'user_num', 'customer_num', 'wa_id', 'mobile', 'phone'];
  const v = deepFind(p, keys);
  const d = digits(v === undefined || typeof v === 'object' ? '' : String(v));
  return d.length >= 10 && d.length <= 15 ? d : '';
}

function extractName(p: any): string {
  const v = deepFind(p, ['profile_name', 'contact_name', 'name', 'customer_name', 'user_name']);
  return truncate(typeof v === 'string' ? v.trim() : v && v.name ? String(v.name) : '', 120);
}

function extractMedia(p: any): string {
  const v = deepFind(p, ['media_url', 'url', 'link', 'file_url']);
  return typeof v === 'string' && /^https?:\/\//.test(v) ? truncate(v, 2000) : '';
}

/* --------------------------------- records --------------------------------- */

interface RecordIn {
  id?: string; eventId?: string; dedupeKey?: string; direction: 'Inbound' | 'Outbound'; phone: string; contactName?: string; leadId?: string;
  text?: string; mediaUrl?: string; status?: string; agent?: string; type?: string; raw?: unknown; ts?: unknown;
}

/** Insert a message. Returns null when `dedupeKey` (or the provider id) was already stored — i.e. a retry. */
async function record(m: RecordIn) {
  const doc: Record<string, any> = {
    _id: m.id || shortId('MSG'),
    eventId: m.eventId || '',
    direction: m.direction,
    phone: e164(m.phone),
    phoneLast10: last10(m.phone),
    contactName: m.contactName || '',
    leadId: m.leadId || '',
    messageType: truncate(String(m.type || 'text'), 60),
    text: truncate(m.text || '', 4000),
    mediaUrl: m.mediaUrl || '',
    status: m.status || '',
    timestamp: parseDate(m.ts) || new Date(),
    agent: m.agent || '',
    raw: m.raw ? truncate(JSON.stringify(m.raw), RAW_MAX) : '',
    createdAt: new Date(),
  };
  if (m.dedupeKey) doc.dedupeKey = m.dedupeKey;
  try {
    await (await msgs()).insertOne(doc);
  } catch (e: any) {
    if (e?.code === 11000) return null;
    throw e;
  }
  return serializeMsg(doc);
}

/* --------------------------------- webhook --------------------------------- */

/** Process one inbound webhook payload (already authenticated by the route). */
export async function handleWebhook(payload: any): Promise<unknown> {
  if (!payload || typeof payload !== 'object') return { ok: true, ignored: 'empty' };
  const cfg = await chatCfg();
  const type = String(payload.event_type || payload.event || payload.type || '').toLowerCase();
  const providerKey = str(payload.event_response_id || payload.m_id || payload.message_id);
  const eventId = providerKey || shortId('C360');

  const inbound = type === 'message_received' || type === 'incoming_message' || type === 'message' || /lead/.test(type);
  const statusEvent = /delivered|read|sent/.test(type) && !inbound;
  const phone = extractPhone(payload, inbound);
  if (!phone) {
    await logError('chat360.webhook', 'VALIDATION', `No phone number in payload (${type})`, '', 'webhook', { keys: Object.keys(payload).slice(0, 40) });
    return { ok: true, ignored: 'no-phone' };
  }

  // Status updates for messages we sent (idempotent, so not subject to de-duplication).
  if (statusEvent) {
    const mid = str(payload.m_id || payload.message_id);
    const status = /read/.test(type) ? 'read' : /deliver/.test(type) ? 'delivered' : 'sent';
    let changed = false;
    let known = false;
    if (mid) {
      const r = await (await msgs()).updateOne({ $or: [{ _id: mid }, { eventId: mid }] }, { $set: { status } });
      known = r.matchedCount > 0;
      changed = r.modifiedCount > 0;
    }
    if ((type === 'template_message_sent' || type === 'session_message_sent') && !known) {
      // an agent sent a message from the Chat360 console — log it as outbound (once)
      const rec = await record({
        id: mid || undefined, eventId, dedupeKey: providerKey || undefined, direction: 'Outbound', phone, text: extractText(payload),
        mediaUrl: extractMedia(payload), status: 'sent', agent: 'Chat360 Console', type: payload.msg_type || payload.template_name || 'text',
        raw: payload, ts: payload.created,
      });
      if (!rec) return { ok: true, duplicate: true };
      changed = true;
    }
    if (changed) await bumpVersion();
    return { ok: true };
  }

  const name = extractName(payload);
  const text = extractText(payload) || (/lead/.test(type) ? '[Lead captured]' : '[Message]');

  // Claim the event first: a Chat360 retry stops here before touching leads or unread counts.
  const rec = await record({
    eventId, dedupeKey: providerKey || undefined, direction: 'Inbound', phone, contactName: name, text,
    mediaUrl: extractMedia(payload), status: 'received',
    type: payload.msg_type || deepFind(payload.wab_response || {}, ['type']) || 'text', raw: payload, ts: payload.created,
  });
  if (!rec) return { ok: true, duplicate: true };

  let lead: UiLead | null = null;
  try {
    lead = await resolveLead(phone, name, cfg);
  } catch (e: any) {
    await logError('chat360.resolveLead', e?.code || 'INTERNAL', e?.message, e?.stack, 'webhook', { phone: last10(phone) });
  }
  const leadId = lead ? lead[L.ID] || '' : '';
  const displayName = name || (lead ? lead[L.NAME] || '' : '');
  if (lead) await (await msgs()).updateOne({ _id: rec.id as any }, { $set: { leadId, contactName: displayName } });

  await upsertContact(
    phone,
    { contactName: displayName, leadId, lastMessageAt: new Date(), lastMessage: truncate(text, 200), assignedRM: lead ? lead[L.RM] || '' : '', status: 'Open' },
    { unreadCount: 1 }
  );

  if (leadId) await addTimeline(leadId, 'chat_received', 'WhatsApp message received', truncate(text, 300), name || 'Customer', 'Chat', rec.id);
  await addEvent('chat_received', 'Chat', phone, 'WhatsApp from ' + (displayName || e164(phone)), truncate(text, 140), 'Chat360', { leadId });
  await bumpVersion();
  return { ok: true, leadId: leadId || null };
}

/* --------------------------------- outbound -------------------------------- */

export async function send(d: any, ctx: Ctx): Promise<{ message: any }> {
  const cfg = await chatCfg();
  if (!cfg.apiKey) throw fail('NOT_CONFIGURED', 'Chat360 API key is not configured. Add it under Settings → Integrations → Chat360.');
  d = d || {};
  const phone = e164(d.phone);
  if (!phone || phone.length < 11 || phone.length > 15) throw fail('VALIDATION', 'A valid phone number is required');
  const text = String(d.text || '').trim();
  const templateName = d.templateName ? String(d.templateName).trim() : '';
  const isTemplate = !!templateName;
  if (!text && !isTemplate) throw fail('VALIDATION', 'Message text or template is required');
  if (text.length > 4096) throw fail('VALIDATION', 'Message is too long (max 4096 characters)');
  const params: string[] = Array.isArray(d.params) ? d.params.slice(0, 20).map((p: unknown) => truncate(String(p ?? ''), 1000)) : [];

  const body = isTemplate
    ? { to: phone, template_name: templateName, parameters: params, language: d.language || 'en' }
    : { to: phone, type: 'text', text, message: text };
  const url = joinUrl(cfg.baseUrl, isTemplate ? cfg.templatePath : cfg.sendPath);

  let code = 0;
  let bodyText = '';
  try {
    const res = await fetchWithTimeout(url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(body) });
    code = res.status;
    bodyText = await res.text();
  } catch (e: any) {
    await logError('chat360.send', 'NETWORK', e?.message, e?.stack, ctx.user?.email || '', { url });
    throw upstream(e?.name === 'AbortError' ? 'Chat360 did not respond within 20 seconds. Please try again.' : 'Could not reach Chat360: ' + (e?.message || e));
  }
  if (code < 200 || code >= 300) {
    await logError('chat360.send', 'UPSTREAM_' + code, truncate(bodyText, 500), '', ctx.user?.email || '', { url });
    throw upstream(`Chat360 rejected the message (HTTP ${code}). Check the endpoint path and API key in Settings. ${truncate(bodyText, 200)}`);
  }
  const parsed = safeJsonParse<any>(bodyText, {}) || {};
  const providerId = truncate(str(parsed.message_id || parsed.m_id || parsed.id || (parsed.data && (parsed.data.message_id || parsed.data.id)) || ''), 200);
  const lead = d.leadId ? await getLead(String(d.leadId)) : await findLeadByPhone(phone);
  const msgText = isTemplate ? `[Template: ${templateName}] ${params.join(' | ')}` : text;
  let msg = await record({
    id: providerId || undefined, eventId: providerId, dedupeKey: providerId || undefined, direction: 'Outbound', phone,
    contactName: lead ? lead[L.NAME] || '' : truncate(String(d.contactName || ''), 120), leadId: lead ? lead[L.ID] || '' : '',
    text: msgText, status: 'sent', agent: ctx.user?.name || '', type: isTemplate ? 'template' : 'text', raw: parsed,
  });
  if (!msg) {
    // The provider id was already recorded (e.g. its webhook arrived first) — return that row.
    const existing = await (await msgs()).findOne({ $or: [{ _id: providerId }, { dedupeKey: providerId }] });
    msg = existing ? serializeMsg(existing) : serializeMsg({ _id: providerId, eventId: providerId, direction: 'Outbound', phone, text: msgText, status: 'sent', timestamp: new Date() });
  }
  await upsertContact(phone, { lastMessageAt: new Date(), lastMessage: truncate(msg.text, 200), contactName: msg.contactName, leadId: msg.leadId, assignedRM: lead ? lead[L.RM] || '' : '' });
  if (lead && lead[L.ID]) await addTimeline(lead[L.ID], 'chat_sent', 'WhatsApp message sent', truncate(msg.text, 300), ctx.user?.name, 'Chat', msg.id);
  await auditLog(ctx, 'WhatsApp Sent', 'Chat', phone, truncate(msg.text, 100));
  await bumpVersion();
  return { message: msg };
}

export async function test(): Promise<{ ok: boolean; message: string }> {
  const cfg = await chatCfg();
  if (!cfg.apiKey) return { ok: false, message: 'No API key saved. Paste your Chat360 API key (Chat360 dashboard → Settings → API Key).' };
  try {
    // Chat360 publishes no public ping endpoint: a GET to the base URL with the auth header is what we can verify.
    const res = await fetchWithTimeout(cfg.baseUrl, { method: 'GET', headers: headersFor(cfg) });
    const code = res.status;
    const webhook = (await getSecret('CHAT360_WEBHOOK_SECRET')) ? 'Webhook secret set.' : 'Webhook secret NOT set — generate one in Settings.';
    if (code >= 200 && code < 500) return { ok: true, message: `Chat360 reachable (HTTP ${code}). API key stored (${maskSecret(cfg.apiKey)}). ${webhook}` };
    return { ok: false, message: `Chat360 responded with HTTP ${code}. Check the Base URL.` };
  } catch (e: any) {
    return { ok: false, message: `Could not reach ${cfg.baseUrl}: ${e?.name === 'AbortError' ? 'timed out after 20 s' : e?.message || e}` };
  }
}

export const actions: ActionMap = {
  chat360GetContacts: { fn: async (_d, ctx) => filterContacts(ctx.user, await contacts()), perm: 'chat.view' },
  chat360GetMessages: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); return messages(d.phone); }, perm: 'chat.view' },
  chat360Send: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); await assertLeadAccess(ctx, d.leadId); return send(d, ctx); }, perm: 'chat.send' },
  chat360Test: { fn: () => test(), perm: 'settings.view' },
  chat360MapContact: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); await assertLeadAccess(ctx, d.leadId); return mapContact(d.phone, d.leadId, ctx); }, perm: 'chat.send' },
  chat360MarkRead: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); return markRead(d.phone); }, perm: 'chat.view' },
};
