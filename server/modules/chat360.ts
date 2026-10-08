/**
 * Chat360 (WhatsApp) — port of apps-script/17_Chat360.gs. Webhook: app/api/webhooks/chat360/route.ts.
 *
 * Inbound : POST /api/webhooks/chat360 (secret in `x-webhook-secret` header or `?secret=`).
 *           Events: message_received, session_message_sent, template_message_sent, sent_message_delivered,
 *           sent_message_read, lead capture. De-duplicated on event_response_id / m_id through the unique
 *           `dedupeKey` index (a duplicate insert = a Chat360 retry).
 * Outbound: Chat360's published API (https://api.chat360.io/) — templates with `Api-Key <key>`, typed replies
 *           (session messages) with an access token from a CRM login, refreshed when it expires.
 * Mapping : contacts ↔ leads by the last 10 digits of the phone; new WhatsApp customers become enquiries
 *           when chat360AutoCreateLeads is on, never duplicating a known phone.
 */
import { createHash } from 'node:crypto';
import type { ActionMap } from '../core/actions';
import { assertLeadAccess } from '../core/scope';
import { assertPhoneAccess, filterContacts } from '../core/scopeGuards';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col } from '../core/db';
import { ApiError, ApiErrorCode, fail } from '../core/errors';
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

/**
 * Values the CRM used to ship as defaults before it followed Chat360's published API (they never worked);
 * a company that saved them gets today's defaults instead.
 */
const LEGACY_DEFAULTS = new Set(['https://api.chat360.io', '/api/v1/messages/send', '/api/v1/messages/template']);
const orDefault = (v: string | undefined, d: string) => (v && !LEGACY_DEFAULTS.has(v.replace(/\/+$/, '')) ? v : d);

/** Chat360 endpoints that are not configurable (documented at https://api.chat360.io/). */
const LOGIN_PATH = '/api/auth/login';
const TEMPLATE_LIST_PATH = '/service/template/data';

async function chatCfg() {
  const s = await settingsAll();
  const D = CFG.SETTING_DEFAULTS;
  return {
    /** Chat360 dashboard → Settings → API Key: sent as `Authorization: Api-Key <key>` (template messages). */
    apiKey: await getSecret('CHAT360_API_KEY'),
    baseUrl: orDefault(s.chat360BaseUrl, D.chat360BaseUrl).replace(/\/+$/, ''),
    sendPath: orDefault(s.chat360SendPath, D.chat360SendPath),
    templatePath: orDefault(s.chat360TemplatePath, D.chat360TemplatePath),
    /** The company's WhatsApp number in Chat360 (country code + number, digits only). */
    businessNumber: s.chat360BusinessNumber ? e164(s.chat360BusinessNumber) : '',
    /** A Chat360 login: typed replies need a short-lived access token, which only a login gives. */
    loginEmail: String(s.chat360LoginEmail || '').trim(),
    loginPassword: await getSecret('CHAT360_LOGIN_PASSWORD'),
    autoCreate: bool(s.chat360AutoCreateLeads === undefined || s.chat360AutoCreateLeads === '' ? D.chat360AutoCreateLeads : s.chat360AutoCreateLeads),
    defaultRM: s.chat360DefaultRM || '',
    defaultSource: s.chat360DefaultSource || 'Chat360',
  };
}
type ChatCfg = Awaited<ReturnType<typeof chatCfg>>;

/** Join base URL and a configured path, refusing anything that would leave the base host. */
function joinUrl(base: string, path: string) {
  const p = String(path || '');
  if (/^[a-z]+:\/\//i.test(p) || p.startsWith('//')) throw fail('VALIDATION', 'Chat360 endpoint paths must be relative (e.g. /service/v1/task)');
  return base + (p.startsWith('/') ? p : '/' + p);
}

const apiKeyHeaders = (cfg: ChatCfg): Record<string, string> => ({ 'Content-Type': 'application/json', Authorization: `Api-Key ${cfg.apiKey}` });
const bearerHeaders = (token: string): Record<string, string> => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

/* ------------------------------ access token ------------------------------ */

/** Access tokens per company + login, reused until a minute before they expire. */
const tokenCache = new Map<string, { token: string; exp: number }>();
const TOKEN_FALLBACK_MS = 10 * 60_000;

/** Expiry (ms) from a JWT's `exp`, or 0 when it cannot be read. */
function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

const tokenKey = (cfg: ChatCfg) =>
  tenantKey(`${cfg.baseUrl}|${cfg.loginEmail.toLowerCase()}|${createHash('sha256').update(cfg.loginPassword).digest('hex').slice(0, 12)}`);

/** Sign in to Chat360 (or reuse a live token). `fresh` forces a new sign-in, e.g. after Chat360 answered 401. */
async function accessToken(cfg: ChatCfg, fresh = false): Promise<string> {
  if (!cfg.loginEmail || !cfg.loginPassword) {
    throw fail('NOT_CONFIGURED', 'Typed WhatsApp replies need a Chat360 login. Add the login e-mail and password under Settings → Integrations → Chat360.');
  }
  const key = tokenKey(cfg);
  const hit = tokenCache.get(key);
  if (!fresh && hit && hit.exp - 60_000 > Date.now()) return hit.token;
  let res: Response;
  try {
    res = await fetchWithTimeout(joinUrl(cfg.baseUrl, LOGIN_PATH), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cfg.loginEmail, password: cfg.loginPassword }) });
  } catch (e: any) {
    throw upstream(e?.name === 'AbortError' ? 'Chat360 did not respond to the sign-in within 20 seconds.' : 'Could not reach Chat360 to sign in: ' + (e?.message || e));
  }
  const body = safeJsonParse<any>(await res.text(), {}) || {};
  const token = str(body.access || body.access_token || body.token || body.data?.access);
  if (!res.ok || !token) {
    tokenCache.delete(key);
    await logError('chat360.login', 'UPSTREAM_' + res.status, truncate(str(body.detail || body.message || ''), 300), '', '', { email: cfg.loginEmail });
    throw fail('NOT_CONFIGURED', `Chat360 did not accept the CRM's login (HTTP ${res.status}). Check the Chat360 login e-mail and password under Settings → Integrations → Chat360.`);
  }
  tokenCache.set(key, { token, exp: jwtExpiry(token) || Date.now() + TOKEN_FALLBACK_MS });
  return token;
}

/* -------------------------------- templates ------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const templateIdCache = new Map<string, { id: string; at: number }>();

/** The first object anywhere in `node` whose name is `name` and which carries a template id (UUID). */
function findTemplateId(node: unknown, name: string, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 6) return '';
  if (Array.isArray(node)) {
    for (const x of node) {
      const id = findTemplateId(x, name, depth + 1);
      if (id) return id;
    }
    return '';
  }
  const o = node as Record<string, unknown>;
  const named = ['name', 'template_name', 'element_name'].some((k) => typeof o[k] === 'string' && (o[k] as string).toLowerCase() === name.toLowerCase());
  if (named) {
    const id = ['template_id', 'id', 'uuid'].map((k) => str(o[k])).find((v) => UUID_RE.test(v));
    if (id) return id;
  }
  for (const v of Object.values(o)) {
    const id = findTemplateId(v, name, depth + 1);
    if (id) return id;
  }
  return '';
}

/** Chat360 sends templates by id; the CRM lets people type the template's name and looks the id up. */
async function templateIdFor(cfg: ChatCfg, nameOrId: string): Promise<string> {
  if (UUID_RE.test(nameOrId)) return nameOrId;
  const key = tenantKey('tpl:' + nameOrId.toLowerCase());
  const hit = templateIdCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
  const list = (headers: Record<string, string>) => fetchWithTimeout(joinUrl(cfg.baseUrl, TEMPLATE_LIST_PATH), { method: 'GET', headers });
  let res: Response;
  try {
    res = await list(apiKeyHeaders(cfg));
    // The template list may only take a signed-in user: use the CRM's login when there is one.
    if ((res.status === 401 || res.status === 403) && cfg.loginEmail && cfg.loginPassword) res = await list(bearerHeaders(await accessToken(cfg)));
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    throw upstream('Could not reach Chat360 to look up the template: ' + (e?.name === 'AbortError' ? 'timed out' : e?.message || e));
  }
  if (res.status === 401 || res.status === 403) {
    throw fail('NOT_CONFIGURED', `Chat360 would not list your templates (HTTP ${res.status}). Paste the template ID instead (Chat360 → Campaigns → Templates), or check the API key.`);
  }
  const id = findTemplateId(safeJsonParse<any>(await res.text(), null), nameOrId);
  if (!id) throw fail('VALIDATION', `Chat360 has no approved template called “${nameOrId}”. Check the name, or paste the template ID from Chat360 → Campaigns → Templates.`);
  templateIdCache.set(key, { id, at: Date.now() });
  return id;
}

/**
 * Template variables: Chat360 names them (`{"first_name": "Meera"}`). `name=value` entries keep their name;
 * plain entries are numbered 1, 2, 3… in order.
 */
export function templateParamData(params: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  params.forEach((p, i) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*=(.*)$/s.exec(p);
    if (m) out[m[1]] = m[2].trim();
    else out[String(i + 1)] = p;
  });
  return out;
}

/** Chat360 sometimes answers 200 with an error in the body. */
function bodyError(parsed: any): string {
  if (!parsed || typeof parsed !== 'object') return '';
  if (parsed.success === false || parsed.status === false || /^(error|fail(ed|ure)?)$/i.test(str(parsed.status))) {
    return str(parsed.message || parsed.detail || parsed.error || 'Chat360 reported an error');
  }
  return parsed.error && typeof parsed.error === 'string' ? parsed.error : '';
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
  if (!cfg.businessNumber) throw fail('NOT_CONFIGURED', 'Add your business WhatsApp number (as registered in Chat360) under Settings → Integrations → Chat360.');
  d = d || {};
  const phone = e164(d.phone);
  if (!phone || phone.length < 11 || phone.length > 15) throw fail('VALIDATION', 'A valid phone number is required');
  const text = String(d.text || '').trim();
  const templateName = d.templateName ? String(d.templateName).trim() : '';
  const isTemplate = !!templateName;
  if (!text && !isTemplate) throw fail('VALIDATION', 'Message text or template is required');
  if (text.length > 4096) throw fail('VALIDATION', 'Message is too long (max 4096 characters)');
  const params: string[] = Array.isArray(d.params) ? d.params.slice(0, 20).map((p: unknown) => truncate(String(p ?? ''), 1000)) : [];

  // Chat360's two send APIs (https://api.chat360.io/):
  //  - template → /service/v1/task with `Authorization: Api-Key <key>` and the template's id;
  //  - typed text (a "session message", only inside WhatsApp's 24-hour window after the customer's last
  //    message) → /api/whatsapp/whatsapp-session-messages with a login access token.
  const url = joinUrl(cfg.baseUrl, isTemplate ? cfg.templatePath : cfg.sendPath);
  const body = isTemplate
    ? {
        task_name: 'whatsapp_push_notification', extra: '',
        task_body: [{ client_number: cfg.businessNumber, receiver_number: phone, template_data: { template_id: await templateIdFor(cfg, templateName), param_data: templateParamData(params), button_param_data: {} } }],
      }
    : { api_key: cfg.apiKey, from: cfg.businessNumber, recipient_type: 'individual', to: phone, type: 'text', text: { body: text } };

  const post = async (headers: Record<string, string>) => {
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { code: res.status, text: await res.text() };
  };
  let code = 0;
  let bodyText = '';
  try {
    let r = await post(isTemplate ? apiKeyHeaders(cfg) : bearerHeaders(await accessToken(cfg)));
    if (!isTemplate && r.code === 401) r = await post(bearerHeaders(await accessToken(cfg, true))); // token expired early: sign in again once
    ({ code, text: bodyText } = r);
  } catch (e: any) {
    if (e instanceof ApiError) throw e; // a configuration or sign-in problem, already explained
    await logError('chat360.send', 'NETWORK', e?.message, e?.stack, ctx.user?.email || '', { url });
    throw upstream(e?.name === 'AbortError' ? 'Chat360 did not respond within 20 seconds. Please try again.' : 'Could not reach Chat360: ' + (e?.message || e));
  }
  const parsed = safeJsonParse<any>(bodyText, {}) || {};
  const rejected = code < 200 || code >= 300 ? truncate(str(parsed.detail || parsed.message || parsed.error || bodyText), 200) : bodyError(parsed);
  if (rejected) {
    await logError('chat360.send', 'UPSTREAM_' + code, truncate(bodyText, 500), '', ctx.user?.email || '', { url });
    if (isTemplate && (code === 401 || code === 403)) throw fail('NOT_CONFIGURED', `Chat360 did not accept the API key (HTTP ${code}). Copy it again from Chat360 → Settings → API Key.`);
    const hint = isTemplate ? '' : ' Typed replies only reach customers who messaged you in the last 24 hours — after that, send an approved template.';
    throw upstream(`Chat360 rejected the message (HTTP ${code}): ${rejected}.${hint}`);
  }
  const providerId = truncate(str(parsed.message_id || parsed.m_id || parsed.messages?.[0]?.id || parsed.id || (parsed.data && (parsed.data.message_id || parsed.data.id)) || ''), 200);
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

/**
 * What is visibly wrong with a saved API key, if anything. Chat360 API keys look like `AbCd1234.xxxxxxxx`
 * (a short prefix, a dot, a long secret); a login token (`eyJ…`) is a common wrong paste.
 */
export function apiKeyShapeProblem(key: string): string {
  const k = String(key || '');
  if (!k) return '';
  if (/^(bearer|api-key|token)\s/i.test(k)) return 'The saved key starts with a word such as “Bearer” — save only the key itself.';
  if (/^eyJ/.test(k)) return 'The saved value is a login token (it starts with “eyJ”), not Chat360’s API key.';
  if (/\s/.test(k)) return 'The saved key contains spaces or line breaks.';
  if (!k.includes('.')) return 'It does not look like a Chat360 API key, which has a dot in it (like AbCd1234.xxxxxxxx).';
  return '';
}

/** Checks everything outgoing messages need, for real: the API key, the business number and the login. */
export async function test(): Promise<{ ok: boolean; message: string }> {
  const cfg = await chatCfg();
  const lines: string[] = [];
  let ok = true;

  const shape = apiKeyShapeProblem(cfg.apiKey);
  if (!cfg.apiKey) {
    ok = false;
    lines.push('✗ API key: not saved (Chat360 dashboard → Settings → API Key).');
  } else {
    try {
      // Ask the template-send endpoint with an empty task list: nothing is sent, but Chat360 checks the key
      // first (401 = not accepted; anything else = the key got through).
      const res = await fetchWithTimeout(joinUrl(cfg.baseUrl, cfg.templatePath), {
        method: 'POST', headers: apiKeyHeaders(cfg), body: JSON.stringify({ task_name: 'whatsapp_push_notification', extra: '', task_body: [] }),
      });
      if (res.status !== 401 && res.status !== 403) lines.push(`✓ API key accepted (${maskSecret(cfg.apiKey)}) — template messages can be sent.`);
      else {
        ok = false;
        lines.push(`✗ API key rejected by Chat360 (HTTP ${res.status}).${shape ? ' ' + shape : ''} Copy the key again from Chat360 → Settings → API Key and save it here.`);
      }
    } catch (e: any) {
      ok = false;
      lines.push(`✗ Could not reach ${cfg.baseUrl}: ${e?.name === 'AbortError' ? 'timed out after 20 s' : e?.message || e}`);
    }
  }

  if (cfg.businessNumber) lines.push(`✓ Business number: +${cfg.businessNumber}.`);
  else {
    ok = false;
    lines.push('✗ Business WhatsApp number: not set.');
  }

  if (!cfg.loginEmail || !cfg.loginPassword) {
    ok = false;
    lines.push('✗ Chat360 login: not set — typed replies need it.');
  } else {
    try {
      await accessToken(cfg, true);
      lines.push(`✓ Signed in to Chat360 as ${cfg.loginEmail} — typed replies can be sent.`);
    } catch (e: any) {
      ok = false;
      lines.push('✗ ' + (e?.message || 'Chat360 sign-in failed.'));
    }
  }

  lines.push((await getSecret('CHAT360_WEBHOOK_SECRET')) ? '✓ Webhook secret set (incoming messages).' : '• Webhook secret not set — generate one to receive messages.');
  return { ok, message: lines.join('\n') };
}

export const actions: ActionMap = {
  chat360GetContacts: { fn: async (_d, ctx) => filterContacts(ctx.user, await contacts()), perm: 'chat.view' },
  chat360GetMessages: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); return messages(d.phone); }, perm: 'chat.view' },
  chat360Send: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); await assertLeadAccess(ctx, d.leadId); return send(d, ctx); }, perm: 'chat.send' },
  chat360Test: { fn: () => test(), perm: 'settings.view' },
  chat360MapContact: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); await assertLeadAccess(ctx, d.leadId); return mapContact(d.phone, d.leadId, ctx); }, perm: 'chat.send' },
  chat360MarkRead: { fn: async (d, ctx) => { await assertPhoneAccess(ctx, d.phone); return markRead(d.phone); }, perm: 'chat.view' },
};
