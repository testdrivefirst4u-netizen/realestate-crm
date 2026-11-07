/**
 * WhatsApp directly through Meta's Cloud API (plan feature whatsappDirect, off by default). A separate way out for a company
 * that was deliberately switched: Chat360 stays exactly as it was for everyone else, and a company with the feature off never
 * reaches this file (chat360.ts asks first). Messages and contacts land in the same store, so the WhatsApp screen, drip
 * campaigns, reminders and lead timelines work the same either way.
 *
 * Connection: phone number id, WhatsApp account id and a token from Meta, saved by an Admin. One number belongs to one company
 * (platform claim), and the company's Chat360 number is refused, since a number can only be on one of the two.
 * Inbound: the platform's one Meta webhook (metaQueue.ts) hands over `whatsapp_business_account` bodies, signature checked.
 *
 * Two ways to connect: Meta's signup popup (finishSignup), or typing the details in (connectDirect, for testing). A number can
 * also stay on the WhatsApp Business app, which Meta calls coexistence: what is sent from the phone arrives here as an echo, and
 * old chats can be brought in once, within 24 hours. Old chats never create leads: a phone's history includes family and vendors.
 */
import crypto from 'node:crypto';
import type { ActionMap } from '../core/actions';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col } from '../core/db';
import { fail } from '../core/errors';
import { addEvent, addTimeline, logError } from '../core/events';
import { decryptSecret, encryptSecret, settingsAll } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { bool, e164, last10, safeJsonParse, str, truncate } from '../core/utils';
import { DEFAULT_GRAPH_VERSION, GRAPH_HOST, appSecretProof, graph, loadMetaConfig } from '../integrations/meta';
import { mapLimit, pc } from '../platform/base';
import { getTenantById, PCOLL } from '../platform/registry';
import { notifyAdmins } from './adminAlerts';
import { WHATSAPP_FILE_CATEGORY, WHATSAPP_FILE_KINDS, isPlaceholderName, record, upsertContact, withPhoneLock } from './chat360';
import { addLead, findLeadByPhone, getLead, updateLead, type UiLead } from './leads';
import { creditsOn, holdForSend, keepLateStatus, normalizeCategory, releaseMessage, releaseUnits, settleMessage, takeLateStatuses, type Category } from './whatsappCredits';
import { deleteFile, saveFile, statFile } from './storage';

const L = CFG.LEAD;
const DOC_ID = 'whatsappDirect';
const TIMEOUT_MS = 20_000;
const MEDIA_MAX = 16 * 1024 * 1024;
const MAX_TEMPLATE_PAGES = 5;
/** Where Meta serves media from: the token is only ever sent to these. */
const MEDIA_HOSTS = /(^|\.)(fbcdn\.net|whatsapp\.net|fbsbx\.com|facebook\.com)$/i;

type ConnectMode = 'manual' | 'cloud' | 'coexistence';
interface SyncState { contactsAt?: Date; contactsRequestId?: string; historyAt?: Date; historyRequestId?: string; progress?: number; declined?: boolean; error?: string }
interface ConnectionDoc { _id: typeof DOC_ID; phoneNumberId: string; wabaId: string; token: string; displayPhone: string; verifiedName: string; connectedAt: Date; connectedBy: string; mode?: ConnectMode; pin?: string; sync?: SyncState }
interface NumberClaim { _id: string; companyId: string; wabaId: string; claimedAt: Date }
interface TemplateDoc { _id: string; name: string; language: string; status: string; category: string; body: string; paramNames: string[]; sendable: boolean; notSendable: string; reason: string; syncedAt: Date; headerMedia?: string; headerText?: string; footer?: string; buttons?: Array<{ type: string; text: string }> }

const connectionCol = () => col<ConnectionDoc>(CFG.COLL.INTEGRATIONS);
const templatesCol = () => col<TemplateDoc>('whatsappTemplates');
const claimsCol = () => pc<NumberClaim>(PCOLL.WHATSAPP_NUMBERS);
const msgs = () => col<any>(CFG.COLL.CHAT_MESSAGES);
const bookCol = () => col<{ _id: string; name: string; phone: string; at: Date }>('whatsappAddressBook');
const contactsCol = () => col<any>(CFG.COLL.CHAT_CONTACTS);
const featureOn = () => !!(currentTenant()?.features as any)?.whatsappDirect;

async function connection(): Promise<ConnectionDoc | null> {
  return (await connectionCol()).findOne({ _id: DOC_ID });
}

/** Does this company send through Meta? No: nothing is even read for a company without the feature. */
export async function isConnected(): Promise<boolean> {
  return featureOn() && !!(await connection());
}

/* ------------------------------- Meta's API -------------------------------- */

export class WhatsappApiError extends Error {
  constructor(public status: number, public metaCode: number, message: string) { super(message); }
}

/** One call, JSON both ways, never retried: a send that timed out may have gone through, and a retry would message the customer twice. */
async function call<T = any>(path: string, token: string, opts: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; params?: Record<string, string> } = {}): Promise<T> {
  const cfg = await loadMetaConfig();
  const q = new URLSearchParams(opts.params || {});
  if (cfg.appSecret) q.set('appsecret_proof', appSecretProof(token, cfg.appSecret));
  const url = `${GRAPH_HOST}/${cfg.graphVersion || DEFAULT_GRAPH_VERSION}/${path.replace(/^\/+/, '')}${q.size ? `?${q}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new WhatsappApiError(0, 0, e?.name === 'TimeoutError' ? 'Meta did not answer within 20 seconds.' : 'Could not reach Meta.');
  }
  const j = safeJsonParse<any>(await res.text().catch(() => ''), {}) || {};
  if (res.ok && !j.error) return j as T;
  const code = Number(j?.error?.code) || 0;
  const detail = str(j?.error?.error_data?.details) || str(j?.error?.message) || `HTTP ${res.status}`;
  throw new WhatsappApiError(res.status, code, truncate(detail, 300));
}

/** What Meta's refusal means for the person looking at it. */
export function explainMetaError(e: { metaCode: number; message: string }): string {
  switch (e.metaCode) {
    case 190: return 'The WhatsApp token has expired or was revoked. An Admin can save a new one in Settings › WhatsApp direct.';
    case 131030: return "Meta's test number can only message numbers added as allowed recipients in the Meta app.";
    case 131047: return 'This customer has not written in the last 24 hours, so WhatsApp only delivers an approved template.';
    case 131026: return 'This number cannot receive the message. It may not be on WhatsApp.';
    case 131056: return 'Too many messages to this customer too quickly. Wait a little and try again.';
    case 130429: case 80007: case 4: return 'Meta is limiting how fast this number can send. Try again in a few minutes.';
    case 132000: return "The template's values do not match it. Check how many values it needs.";
    case 132001: return 'This template does not exist in that language on WhatsApp. Refresh the templates in Settings.';
    case 133010: return 'This number is not registered with WhatsApp yet. An Admin can reconnect it with its PIN.';
    case 368: return 'Meta has restricted this WhatsApp account. Check it in WhatsApp Manager.';
    default: return `WhatsApp refused it: ${e.message}`;
  }
}

/* --------------------------------- connect --------------------------------- */

const digitsId = (v: unknown, what: string) => {
  const s = str(v);
  if (!/^\d{5,30}$/.test(s)) throw fail('VALIDATION', `Enter the ${what} from Meta: only digits.`);
  return s;
};

const refused = (e: any, doing: string) => (e instanceof WhatsappApiError ? fail('VALIDATION', `${doing}: ${e.metaCode === 190 ? 'Meta did not accept this token.' : e.message}`) : e);

export async function connectDirect(d: any, ctx: Ctx, opts: { mode?: ConnectMode; keepPin?: boolean } = {}): Promise<{ displayPhone: string; verifiedName: string; webhookSubscribed: boolean }> {
  const t = currentTenant();
  if (!t) throw fail('AUTH_REQUIRED', 'Please sign in');
  const phoneNumberId = digitsId(d?.phoneNumberId, 'phone number ID');
  const wabaId = digitsId(d?.wabaId, 'WhatsApp account ID');
  const saved = await connection();
  const typed = str(d?.token);
  const token = typed || (saved && saved.phoneNumberId === phoneNumberId ? decryptSecret(saved.token) : '');
  if (!token) throw fail('VALIDATION', 'Paste the access token from Meta.');
  const pin = str(d?.pin);
  if (pin && !/^\d{6}$/.test(pin)) throw fail('VALIDATION', 'The PIN has 6 digits.');

  // the number must really be in that account, on this token
  let info: any;
  try {
    const list = await call<{ data: any[] }>(`${wabaId}/phone_numbers`, token, { params: { fields: 'id,display_phone_number,verified_name', limit: '100' } });
    info = (list.data || []).find((n) => String(n.id) === phoneNumberId);
  } catch (e) {
    throw refused(e, 'Meta did not allow this');
  }
  if (!info) throw fail('VALIDATION', 'That phone number ID is not in that WhatsApp account. Check both in the Meta app.');
  const displayPhone = str(info.display_phone_number);

  // never the number Chat360 is using: one number can only be on one of them
  const chat360Number = str((await settingsAll()).chat360BusinessNumber);
  if (chat360Number && last10(chat360Number) === last10(displayPhone)) {
    throw fail('VALIDATION', `${displayPhone} is this company's Chat360 number. Connecting it here could stop Chat360 working, so use a spare number.`);
  }

  // one number, one company
  const claims = await claimsCol();
  try {
    await claims.insertOne({ _id: phoneNumberId, companyId: t.id, wabaId, claimedAt: new Date() });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const other = await claims.findOne({ _id: phoneNumberId });
    if (other && other.companyId !== t.id) throw fail('VALIDATION', 'This number is already connected to another company.');
    await claims.updateOne({ _id: phoneNumberId }, { $set: { wabaId } });
  }

  if (pin) {
    try {
      await call(`${phoneNumberId}/register`, token, { method: 'POST', body: { messaging_product: 'whatsapp', pin } });
    } catch (e) {
      if (!saved || saved.phoneNumberId !== phoneNumberId) await claims.deleteOne({ _id: phoneNumberId, companyId: t.id });
      throw refused(e, 'Meta did not register this number');
    }
  }
  // a different number replaces the old one, whose claim is released
  if (saved && saved.phoneNumberId !== phoneNumberId) await claims.deleteOne({ _id: saved.phoneNumberId, companyId: t.id });

  await (await connectionCol()).updateOne(
    { _id: DOC_ID },
    { $set: { phoneNumberId, wabaId, token: encryptSecret(token), displayPhone, verifiedName: str(info.verified_name), connectedAt: new Date(), connectedBy: ctx.user?.name || 'System', mode: opts.mode || 'manual', ...(opts.keepPin && pin ? { pin: encryptSecret(pin) } : {}), sync: {} } },
    { upsert: true }
  );
  // incoming messages reach the app only once the account is subscribed to it
  let webhookSubscribed = true;
  try {
    await call(`${wabaId}/subscribed_apps`, token, { method: 'POST' });
  } catch (e: any) {
    webhookSubscribed = false;
    await logError('whatsappDirect.subscribe', 'UPSTREAM', e?.message, '', ctx.user?.email || '');
  }
  await syncTemplates().catch((e) => logError('whatsappDirect.templates', 'UPSTREAM', e?.message, '', ctx.user?.email || ''));
  await auditLog(ctx, 'WhatsApp Direct Connected', 'Settings', DOC_ID, displayPhone);
  await bumpVersion();
  return { displayPhone, verifiedName: str(info.verified_name), webhookSubscribed };
}

/* ---------------------------------- signup --------------------------------- */

/** What the browser needs for Meta's popup. None of it is secret. */
export async function signupConfig() {
  const cfg = await loadMetaConfig();
  return { ready: !!(cfg.appId && cfg.appSecret && cfg.whatsappConfigId), appId: cfg.appId, configId: cfg.whatsappConfigId, version: cfg.graphVersion || DEFAULT_GRAPH_VERSION, solutionId: cfg.whatsappSolutionId };
}

/** The ids, when the popup's message did not arrive: what Meta says this token may manage. */
async function wabaFromToken(token: string, cfg: Awaited<ReturnType<typeof loadMetaConfig>>): Promise<string> {
  const r = await graph<any>('debug_token', { config: cfg, params: { input_token: token, access_token: `${cfg.appId}|${cfg.appSecret}` } });
  const scope = (r?.data?.granular_scopes || []).find((s: any) => s?.scope === 'whatsapp_business_management');
  return str(scope?.target_ids?.[0]);
}

export async function finishSignup(d: any, ctx: Ctx): Promise<{ displayPhone: string; verifiedName: string; webhookSubscribed: boolean; sync: SyncState | null }> {
  const cfg = await loadMetaConfig();
  if (!cfg.appId || !cfg.appSecret) throw fail('NOT_CONFIGURED', 'The Meta app is not set up on this platform yet.');
  const code = str(d?.code);
  if (code.length < 10 || code.length > 2000) throw fail('VALIDATION', 'Meta did not finish connecting. Please try again.');
  const keepApp = d?.keepApp === true;
  let token = '';
  try {
    token = str((await graph<any>('oauth/access_token', { config: cfg, params: { client_id: cfg.appId, client_secret: cfg.appSecret, code } })).access_token);
  } catch (e: any) {
    await logError('whatsappDirect.signup', 'UPSTREAM', e?.message, '', ctx.user?.email || '');
  }
  if (!token) throw fail('VALIDATION', 'Meta did not accept the signup, which can happen if it took too long. Please connect again.');

  const wabaId = str(d?.wabaId) || (await wabaFromToken(token, cfg).catch(() => ''));
  if (!/^\d{5,30}$/.test(wabaId)) throw fail('VALIDATION', 'Meta did not say which WhatsApp account was connected. Please connect again.');
  let phoneNumberId = str(d?.phoneNumberId);
  if (!phoneNumberId) {
    let list: any[] = [];
    try {
      list = (await call<{ data: any[] }>(`${wabaId}/phone_numbers`, token, { params: { fields: 'id', limit: '100' } })).data || [];
    } catch (e) {
      throw refused(e, 'Meta did not allow this');
    }
    if (list.length !== 1) throw fail('VALIDATION', list.length ? 'This WhatsApp account has several numbers. Connect again and choose one during signup.' : 'No phone number was added during signup. Connect again and add one.');
    phoneNumberId = str(list[0].id);
  }

  // a number kept on the Business app is already registered; so may be one reconnecting
  let pin = '';
  if (!keepApp) {
    const info = await call<any>(phoneNumberId, token, { params: { fields: 'platform_type' } }).catch(() => null);
    if (str(info?.platform_type) !== 'CLOUD_API') pin = String(crypto.randomInt(100000, 1000000));
  }
  const r = await connectDirect({ phoneNumberId, wabaId, token, pin }, ctx, { mode: keepApp ? 'coexistence' : 'cloud', keepPin: true });
  return { ...r, sync: keepApp ? await requestPastChats() : null };
}

const SYNC_WINDOW_MS = 24 * 3600000;

/** Ask Meta for the phone's contacts, then its chats. Each can only ever be asked once, so what succeeded is remembered. */
export async function requestPastChats(now = new Date()): Promise<SyncState> {
  const c = await connection();
  if (!c) throw fail('NOT_CONFIGURED', 'WhatsApp direct is not connected.');
  if (c.mode !== 'coexistence') throw fail('VALIDATION', 'Past chats can only be brought in for a number kept on the WhatsApp Business app.');
  const sync: SyncState = { ...c.sync };
  if (now.getTime() - c.connectedAt.getTime() > SYNC_WINDOW_MS && (!sync.contactsAt || !sync.historyAt)) throw fail('VALIDATION', 'Meta only allows this within 24 hours of connecting. To try again, the number must be disconnected and connected again.');
  const token = decryptSecret(c.token);
  sync.error = '';
  for (const [type, at, id] of [['smb_app_state_sync', 'contactsAt', 'contactsRequestId'], ['history', 'historyAt', 'historyRequestId']] as const) {
    if (sync[at]) continue;
    try {
      const r = await call<any>(`${c.phoneNumberId}/smb_app_data`, token, { method: 'POST', body: { messaging_product: 'whatsapp', sync_type: type } });
      sync[at] = now;
      sync[id] = str(r.request_id);
    } catch (e: any) {
      sync.error = e instanceof WhatsappApiError ? e.message : 'Could not reach Meta.';
      await logError('whatsappDirect.sync', 'UPSTREAM', e?.message, '', '', { type });
      break;
    }
  }
  await (await connectionCol()).updateOne({ _id: DOC_ID }, { $set: { sync } });
  return sync;
}

const syncView = (s: SyncState | undefined) => ({ contactsAsked: !!s?.contactsAt, historyAsked: !!s?.historyAt, progress: Number(s?.progress) || 0, declined: !!s?.declined, error: s?.error || '' });

/** Back to Chat360 (if the company has it). Chats already here stay. */
export async function disconnectDirect(ctx: Ctx): Promise<{ ok: true }> {
  const c = await connection();
  if (c) {
    // best effort: stop Meta sending this number's messages here; ones that still come are ignored
    await call(`${c.wabaId}/subscribed_apps`, decryptSecret(c.token), { method: 'DELETE' }).catch(() => undefined);
    await (await claimsCol()).deleteOne({ _id: c.phoneNumberId, companyId: currentTenant()?.id });
    await (await connectionCol()).deleteOne({ _id: DOC_ID });
    await (await templatesCol()).deleteMany({});
    await auditLog(ctx, 'WhatsApp Direct Disconnected', 'Settings', DOC_ID, c.displayPhone);
    await bumpVersion();
  }
  return { ok: true };
}

const templateView = (t: TemplateDoc) => ({ name: t.name, language: t.language, status: t.status, category: t.category, body: t.body, paramNames: t.paramNames, sendable: t.sendable, notSendable: t.notSendable, reason: t.reason, headerMedia: t.headerMedia || '', headerText: t.headerText || '', footer: t.footer || '', buttons: t.buttons || [] });

export async function getDirect() {
  const c = await connection();
  const appUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const webhookUrl = appUrl ? `${appUrl}/api/webhooks/meta` : '';
  const signup = await signupConfig();
  if (!c) return { connected: false as const, webhookUrl, signup };
  const lastIn = await (await msgs()).find({ channel: 'direct', direction: 'Inbound' }, { projection: { timestamp: 1 } }).sort({ timestamp: -1 }).limit(1).next();
  let live: { quality: string; platform: string; problem: string } = { quality: '', platform: '', problem: '' };
  try {
    const r = await call<any>(c.phoneNumberId, decryptSecret(c.token), { params: { fields: 'quality_rating,platform_type' } });
    live = { quality: str(r.quality_rating), platform: str(r.platform_type), problem: '' };
  } catch (e: any) {
    live.problem = e instanceof WhatsappApiError ? explainMetaError(e) : 'Could not ask Meta about this number.';
  }
  return {
    connected: true as const, webhookUrl, signup, mode: c.mode || 'manual', sync: syncView(c.sync), syncOpen: Date.now() - c.connectedAt.getTime() <= SYNC_WINDOW_MS, phoneNumberId: c.phoneNumberId, wabaId: c.wabaId, displayPhone: c.displayPhone, verifiedName: c.verifiedName,
    connectedAt: c.connectedAt.toISOString(), connectedBy: c.connectedBy, lastInboundAt: lastIn?.timestamp ? new Date(lastIn.timestamp).toISOString() : '', ...live,
    templates: (await (await templatesCol()).find({}).sort({ name: 1, language: 1 }).toArray()).map(templateView),
  };
}

/* -------------------------------- templates -------------------------------- */

/** The names of a template's values in order: {{1}} {{2}}, or {{first_name}}. */
export function templateParams(body: string): string[] {
  const out: string[] = [];
  for (const m of String(body || '').matchAll(/\{\{\s*([\w]+)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** What the CRM can fill today: words in the body. A picture in the header or a value in a button needs more than that. */
export function readTemplate(raw: any): Omit<TemplateDoc, '_id' | 'syncedAt'> & { headerMedia: string; headerText: string; footer: string; buttons: Array<{ type: string; text: string }> } {
  const parts: any[] = Array.isArray(raw?.components) ? raw.components : [];
  const body = str(parts.find((c) => c.type === 'BODY')?.text);
  const header = parts.find((c) => c.type === 'HEADER');
  const buttons: any[] = parts.find((c) => c.type === 'BUTTONS')?.buttons || [];
  let notSendable = '';
  let headerMedia = '';
  const format = String(header?.format || '').toUpperCase();
  if (parts.some((c) => !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(c.type))) notSendable = 'This kind of template, such as a carousel, cannot be sent from here yet.';
  else if (format === 'LOCATION') notSendable = 'It has a location in its header, which cannot be sent from here yet.';
  else if (header && format === 'TEXT' && templateParams(header.text).length) notSendable = 'Its header has a value to fill, which cannot be sent from here yet.';
  else if (buttons.some((b) => templateParams(b.url || '').length)) notSendable = 'A button has a value to fill, which cannot be sent from here yet.';
  else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
    // a campaign can supply this; a quick send from a chat cannot
    headerMedia = format.toLowerCase();
    notSendable = `It has a ${headerMedia} in its header. Send it from WhatsApp Campaigns.`;
  }
  return { name: str(raw?.name), language: str(raw?.language), status: str(raw?.status), category: str(raw?.category), body, paramNames: templateParams(body), sendable: !notSendable, notSendable, headerMedia, headerText: format === 'TEXT' ? str(header?.text) : '', footer: str(parts.find((c) => c.type === 'FOOTER')?.text), buttons: buttons.map((b) => ({ type: str(b.type), text: str(b.text) })).filter((b) => b.text), reason: str(raw?.rejected_reason) === 'NONE' ? '' : str(raw?.rejected_reason) };
}

const templateId = (name: string, language: string) => `${name}:${language}`;

export async function syncTemplates(): Promise<{ templates: number }> {
  const c = await connection();
  if (!c) throw fail('NOT_CONFIGURED', 'WhatsApp direct is not connected.');
  const token = decryptSecret(c.token);
  const found: any[] = [];
  let after = '';
  for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
    const r = await call<any>(`${c.wabaId}/message_templates`, token, { params: { fields: 'name,language,status,category,components,rejected_reason', limit: '100', ...(after ? { after } : {}) } });
    found.push(...(r.data || []));
    after = r.paging?.next ? str(r.paging?.cursors?.after) : '';
    if (!after) break;
  }
  const coll = await templatesCol();
  const now = new Date();
  for (const raw of found) {
    const t = readTemplate(raw);
    if (t.name && t.language) await coll.replaceOne({ _id: templateId(t.name, t.language) }, { ...t, syncedAt: now }, { upsert: true });
  }
  await coll.deleteMany({ syncedAt: { $lt: now } }); // gone from WhatsApp
  return { templates: found.length };
}

export async function syncTemplatesAction(): Promise<{ templates: number }> {
  try {
    return await syncTemplates();
  } catch (e) {
    throw refused(e, 'Could not read templates from Meta');
  }
}

const TEMPLATE_LANGUAGES = ['en', 'en_US', 'en_GB', 'hi', 'te', 'ta', 'kn', 'ml', 'mr', 'gu', 'bn', 'pa'];

/** Meta's own rules, checked here so an Admin gets the reason now and not a rejection later. */
export function templateProblem(d: { name: string; category: string; language: string; body: string; footer: string; examples: string[] }): string {
  if (!/^[a-z0-9_]{1,512}$/.test(d.name)) return 'The name can only have small letters, numbers and underscores, like site_visit_reminder.';
  if (!['MARKETING', 'UTILITY'].includes(d.category)) return 'Choose Marketing or Utility.';
  if (!TEMPLATE_LANGUAGES.includes(d.language)) return 'Choose a language.';
  if (!d.body.trim()) return 'Write the message.';
  if (d.body.length > 1024) return 'The message can be up to 1,024 characters.';
  if (d.footer.length > 60) return 'The footer can be up to 60 characters.';
  const names = templateParams(d.body);
  if (names.some((n, i) => n !== String(i + 1))) return 'Number the values in order: {{1}}, then {{2}}, and so on.';
  if (/^\s*\{\{/.test(d.body) || /\}\}\s*$/.test(d.body)) return 'WhatsApp does not allow a value at the very start or end of the message. Add words around it.';
  if (d.examples.length !== names.length || d.examples.some((x) => !x.trim())) return `Give an example for ${names.length === 1 ? 'the value' : `each of the ${names.length} values`}, so Meta can review it.`;
  return '';
}

const SAMPLE_MIME: Record<string, RegExp> = { image: /^image\/(jpeg|png)$/, video: /^video\/mp4$/, document: /^application\/pdf$/ };
const SAMPLE_MAX = 3 * 1024 * 1024;

/** Meta wants an example of the file for its review, sent through its upload service. It returns a handle to put in the template. */
async function uploadSample(sample: any, kind: string, token: string): Promise<string> {
  const mime = str(sample?.mime).toLowerCase();
  if (!SAMPLE_MIME[kind]?.test(mime)) throw fail('VALIDATION', kind === 'image' ? 'Use a JPG or PNG picture as the example.' : kind === 'video' ? 'Use an MP4 video as the example.' : 'Use a PDF as the example.');
  const data = Buffer.from(str(sample?.base64), 'base64');
  if (!data.length) throw fail('VALIDATION', `Add an example ${kind}.`);
  if (data.length > SAMPLE_MAX) throw fail('VALIDATION', 'The example is larger than 3 MB. Make it smaller first.');
  const cfg = await loadMetaConfig();
  const base = `${GRAPH_HOST}/${cfg.graphVersion || DEFAULT_GRAPH_VERSION}`;
  const q = new URLSearchParams({ file_name: truncate(str(sample?.name) || 'example', 100), file_length: String(data.length), file_type: mime });
  const started = await fetch(`${base}/${cfg.appId}/uploads?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json()).catch(() => null);
  const session = str(started?.id);
  if (!session) throw fail('SERVER', 'Meta did not accept the example file. Please try again.');
  const done = await fetch(`${base}/${session}`, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_offset: '0' }, body: data, signal: AbortSignal.timeout(60000) }).then((r) => r.json()).catch(() => null);
  const handle = str(done?.h);
  if (!handle) throw fail('SERVER', 'Meta did not accept the example file. Please try again.');
  return handle;
}

export async function createTemplate(d: any, ctx: Ctx): Promise<{ status: string }> {
  const c = await connection();
  if (!c) throw fail('NOT_CONFIGURED', 'WhatsApp direct is not connected.');
  const t = { name: str(d?.name).toLowerCase(), category: str(d?.category).toUpperCase(), language: str(d?.language) || 'en', body: String(d?.body ?? '').trim(), footer: str(d?.footer), examples: (Array.isArray(d?.examples) ? d.examples : []).map((x: unknown) => str(x)) };
  const problem = templateProblem(t);
  if (problem) throw fail('VALIDATION', problem);
  const headerMedia = ['image', 'video', 'document'].includes(str(d?.headerMedia)) ? str(d.headerMedia) : '';
  const components: any[] = [{ type: 'BODY', text: t.body, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) }];
  if (headerMedia) {
    const handle = await uploadSample(d?.sample, headerMedia, decryptSecret(c.token));
    components.unshift({ type: 'HEADER', format: headerMedia.toUpperCase(), example: { header_handle: [handle] } });
  }
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
  let r: any;
  try {
    r = await call(`${c.wabaId}/message_templates`, decryptSecret(c.token), { method: 'POST', body: { name: t.name, category: t.category, language: t.language, parameter_format: 'POSITIONAL', components } });
  } catch (e) {
    throw refused(e, 'Meta did not accept this template');
  }
  const status = str(r.status) || 'PENDING';
  await (await templatesCol()).replaceOne({ _id: templateId(t.name, t.language) }, { name: t.name, language: t.language, status, category: str(r.category) || t.category, body: t.body, paramNames: templateParams(t.body), sendable: !headerMedia, notSendable: headerMedia ? `It has a ${headerMedia} in its header. Send it from WhatsApp Campaigns.` : '', headerMedia, footer: t.footer, reason: '', syncedAt: new Date() }, { upsert: true });
  await auditLog(ctx, 'WhatsApp Template Created', 'Settings', t.name, t.category);
  return { status };
}

/** Meta deletes a template in all its languages. */
export async function deleteTemplate(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const c = await connection();
  if (!c) throw fail('NOT_CONFIGURED', 'WhatsApp direct is not connected.');
  const name = str(d?.name);
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw fail('VALIDATION', 'Choose a template.');
  try {
    await call(`${c.wabaId}/message_templates`, decryptSecret(c.token), { method: 'DELETE', params: { name } });
  } catch (e) {
    throw refused(e, 'Meta did not delete this template');
  }
  await (await templatesCol()).deleteMany({ name });
  await auditLog(ctx, 'WhatsApp Template Deleted', 'Settings', name, '');
  return { ok: true };
}

/** For the chat screen: what an agent can send now. */
export async function approvedTemplates() {
  if (!(await connection())) return [];
  const rows = await (await templatesCol()).find({ status: 'APPROVED', sendable: true }).sort({ name: 1, language: 1 }).toArray();
  return rows.map(templateView);
}

async function templateToSend(name: string, language: string, withHeader = false): Promise<TemplateDoc> {
  const pick = async () => {
    const list = await (await templatesCol()).find({ name, ...(language ? { language } : {}) }).toArray();
    return list.find((t) => t.status === 'APPROVED') || list[0] || null;
  };
  let t = await pick();
  if (t?.status !== 'APPROVED') {
    // made in WhatsApp Manager or approved a moment ago
    await syncTemplates().catch(() => undefined);
    t = await pick();
  }
  if (!t) throw fail('VALIDATION', `There is no template called ${name} on this WhatsApp account.`);
  if (t.status !== 'APPROVED') throw fail('VALIDATION', `The template ${name} is not approved yet (${t.status.toLowerCase()}).`);
  if (!t.sendable && !(withHeader && t.headerMedia)) throw fail('VALIDATION', `The template ${name} cannot be sent. ${t.notSendable}`);
  return t;
}

/** The filled-in parts of a template: the file at the top, if it has one, and the words. */
async function templateComponents(t: TemplateDoc, params: string[], named: boolean, headerFileId: string) {
  const components: any[] = [];
  if (t.headerMedia) {
    const file = await statFile(headerFileId);
    if (!file || file.category !== WHATSAPP_FILE_CATEGORY || WHATSAPP_FILE_KINDS[file.mime] !== t.headerMedia) throw fail('VALIDATION', `Add the ${t.headerMedia} for this template again.`);
    const { publicMediaUrl } = await import('./socialPosts');
    components.push({ type: 'header', parameters: [{ type: t.headerMedia, [t.headerMedia]: { link: publicMediaUrl(headerFileId), ...(t.headerMedia === 'document' ? { filename: file.name } : {}) } }] });
  }
  if (params.length) components.push({ type: 'body', parameters: params.map((p, i) => ({ type: 'text', text: p, ...(named ? { parameter_name: t.paramNames[i] } : {}) })) });
  return components.length ? { components } : {};
}

/* ---------------------------------- send ----------------------------------- */

/** The same promise as Chat360's send: the message goes out, is saved to the chat and the lead's timeline, and comes back. */
export async function sendDirect(d: any, ctx: Ctx): Promise<{ message: any }> {
  const c = await connection();
  if (!c) throw fail('NOT_CONFIGURED', 'WhatsApp direct is not connected.');
  d = d || {};
  const phone = e164(d.phone);
  if (!phone || phone.length < 11 || phone.length > 15) throw fail('VALIDATION', 'A valid phone number is required');
  // buttons or a list from the chatbot
  const interactive = d.interactive && (d.interactive.kind === 'buttons' || d.interactive.kind === 'list') ? d.interactive : null;
  const text = String((interactive ? interactive.text : d.text) || '').trim();
  const templateName = d.templateName ? String(d.templateName).trim() : '';
  const isTemplate = !!templateName;
  const fileId = !isTemplate && d.fileId ? String(d.fileId) : '';
  const file = fileId ? await statFile(fileId) : null;
  if (fileId && (!file || file.category !== WHATSAPP_FILE_CATEGORY || !WHATSAPP_FILE_KINDS[file.mime])) throw fail('VALIDATION', 'Attach the file again.');
  const fileKind = file ? WHATSAPP_FILE_KINDS[file.mime] : '';
  if (!text && !isTemplate && !file) throw fail('VALIDATION', 'Message text or template is required');
  if (text.length > 4096) throw fail('VALIDATION', 'Message is too long (max 4096 characters)');
  const params: string[] = Array.isArray(d.params) ? d.params.slice(0, 20).map((p: unknown) => truncate(String(p ?? ''), 1000)) : [];

  const body: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone };
  let expected: Category = 'service';
  if (isTemplate) {
    const headerFileId = str(d.headerFileId);
    const t = await templateToSend(templateName, str(d.templateLanguage), !!headerFileId);
    expected = normalizeCategory(t.category);
    if (params.length !== t.paramNames.length) throw fail('VALIDATION', `The template ${t.name} needs ${t.paramNames.length} value${t.paramNames.length === 1 ? '' : 's'}, and ${params.length} ${params.length === 1 ? 'was' : 'were'} given.`);
    if (params.some((p) => !p.trim())) throw fail('VALIDATION', `Fill in every value of the template ${t.name}.`);
    const named = t.paramNames.some((n) => !/^\d+$/.test(n));
    body.type = 'template';
    body.template = {
      name: t.name, language: { code: t.language },
      ...(await templateComponents(t, params, named, headerFileId)),
    };
  } else if (file) {
    const { publicMediaUrl } = await import('./socialPosts');
    body.type = fileKind;
    body[fileKind] = { link: publicMediaUrl(fileId), ...(text ? { caption: text } : {}), ...(fileKind === 'document' ? { filename: file.name } : {}) };
  } else if (interactive) {
    const options: Array<{ id: string; label: string }> = interactive.options || [];
    body.type = 'interactive';
    body.interactive = interactive.kind === 'buttons'
      ? { type: 'button', body: { text }, action: { buttons: options.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.label } })) } }
      : { type: 'list', body: { text }, action: { button: interactive.button || 'Choose', sections: [{ rows: options.map((o) => ({ id: o.id, title: o.label })) }] } };
  } else {
    body.type = 'text';
    body.text = { body: text, preview_url: false };
  }

  // credits are checked last, once nothing else can refuse it: a company without them is not touched
  const hold = creditsOn() ? await holdForSend(expected, phone) : null;
  let parsed: any;
  try {
    parsed = await call(`${c.phoneNumberId}/messages`, decryptSecret(c.token), { method: 'POST', body });
  } catch (e: any) {
    if (hold) await releaseUnits(hold.units);
    if (!(e instanceof WhatsappApiError)) throw e;
    await logError('whatsappDirect.send', `UPSTREAM_${e.metaCode || e.status}`, e.message, '', ctx.user?.email || '');
    throw fail(e.metaCode === 190 ? 'NOT_CONFIGURED' : 'SERVER', explainMetaError(e), { metaCode: e.metaCode });
  }
  // only the campaign engine can tie a message to a campaign
  const campaignId = ctx.user?.id === 'SYSTEM' ? str(d.campaignId) : '';
  const providerId = truncate(str(parsed?.messages?.[0]?.id), 200);
  const lead = d.leadId ? await getLead(String(d.leadId)) : await findLeadByPhone(phone);
  const msgText = interactive ? [text, ...(interactive.options || []).map((o: any) => `• ${o.label}`)].join('\n') : isTemplate ? `[Template: ${templateName}] ${params.join(' | ')}` : file ? [fileKind === 'document' ? `📄 ${file.name}` : '', text].filter(Boolean).join('\n') : text;
  const msg = await record({
    id: providerId || undefined, eventId: providerId, dedupeKey: providerId || undefined, direction: 'Outbound', phone,
    contactName: lead ? lead[L.NAME] || '' : truncate(String(d.contactName || ''), 120), leadId: lead ? lead[L.ID] || '' : '',
    text: msgText, status: 'sent', agent: ctx.user?.name || '', type: isTemplate ? 'template' : fileKind || 'text', mediaUrl: fileId ? `/api/files/${fileId}` : '', raw: parsed,
    extra: { channel: 'direct', ...(campaignId ? { campaignId } : {}), ...(hold ? { creditTracked: true, creditHold: hold.units, creditCategory: expected, creditTemplate: templateName || (ctx.user?.name === 'Chatbot' ? 'Chatbot' : '') } : {}) },
  });
  const saved = msg || { id: providerId, eventId: providerId, direction: 'Outbound', phone, text: msgText, status: 'sent', timestamp: new Date().toISOString(), contactName: lead ? lead[L.NAME] || '' : '', leadId: lead ? lead[L.ID] || '' : '' };
  await upsertContact(phone, { lastMessageAt: new Date(), lastMessage: truncate(saved.text, 200), contactName: saved.contactName, leadId: saved.leadId, assignedRM: lead ? lead[L.RM] || '' : '' });
  if (lead && lead[L.ID]) await addTimeline(lead[L.ID], 'chat_sent', 'WhatsApp message sent', truncate(saved.text, 300), ctx.user?.name, 'Chat', saved.id);
  // a campaign is logged once, not thousands of times, and refreshes screens when a batch ends
  if (!campaignId) await auditLog(ctx, 'WhatsApp Sent', 'Chat', phone, truncate(saved.text, 100));
  // a person replied: the bot leaves this chat for good. Automatic messages do not count.
  if (ctx.user?.id !== 'SYSTEM' && (currentTenant()?.features as any)?.whatsappBots) await (await import('./whatsappBots')).stopBotInChat(phone, ctx.user?.name || 'A team member');
  // a receipt that beat this save
  if (hold && providerId) for (const s of await takeLateStatuses(providerId)) await handleStatus(s);
  if (!campaignId) await bumpVersion();
  return { message: saved };
}

/* --------------------------------- incoming -------------------------------- */

const directCtx = (): Ctx => ({ ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: 'WhatsApp' }, action: 'whatsappDirect.webhook' });

async function leadFor(phone: string, name: string): Promise<UiLead | null> {
  return withPhoneLock(last10(phone), async () => {
    const existing = await findLeadByPhone(phone);
    if (existing) return existing;
    const s = await settingsAll();
    const D = CFG.SETTING_DEFAULTS;
    if (!bool(s.chat360AutoCreateLeads === undefined || s.chat360AutoCreateLeads === '' ? D.chat360AutoCreateLeads : s.chat360AutoCreateLeads)) return null;
    // the CRM keeps one source for WhatsApp leads (leadShape.ts merges "WhatsApp" into it), so reports stay comparable
    const source = s.chat360DefaultSource || 'Chat360';
    const obj: UiLead = { [L.NAME]: name || 'WhatsApp ' + e164(phone), [L.PHONE]: '+' + e164(phone), [L.STAGE]: CFG.STAGES.NEW, [L.SOURCE]: source, [L.RM]: s.chat360DefaultRM || '', [L.BROCHURE]: 'No' };
    try {
      return (await addLead(obj, directCtx(), { returnExisting: true, actor: 'WhatsApp', eventSource: 'whatsapp' })).lead;
    } catch (e) {
      const again = await findLeadByPhone(phone);
      if (again) return again;
      throw e;
    }
  });
}

/** What the customer sent, in words. Empty for what is not a message to show (a reaction). */
export function inboundText(m: any): { text: string; type: string; mediaId: string; mime: string; filename: string; replyId?: string } {
  const type = str(m?.type);
  const media = (k: string) => m?.[k] || {};
  const out = (text: string, t = type, mediaId = '', mime = '', filename = '') => ({ text, type: t, mediaId, mime, filename });
  if ((m?.errors || []).some((e: any) => Number(e?.code) === 131060)) return out('This message could not come through here. Please check the WhatsApp Business app on the phone.', 'text');
  switch (type) {
    case 'text': return out(str(m.text?.body), 'text');
    case 'media_placeholder': return out('📎 A photo or file from before connecting. See it on the phone.', 'text');
    case 'button': return out(str(m.button?.text), 'text');
    case 'interactive': return { ...out(str(m.interactive?.button_reply?.title || m.interactive?.list_reply?.title), 'text'), replyId: str(m.interactive?.button_reply?.id || m.interactive?.list_reply?.id) };
    case 'image': return out(str(media('image').caption), 'image', str(media('image').id), str(media('image').mime_type));
    case 'video': return out(str(media('video').caption), 'video', str(media('video').id), str(media('video').mime_type));
    case 'audio': return out('🎤 Voice message', 'audio', str(media('audio').id), str(media('audio').mime_type));
    case 'sticker': return out('', 'image', str(media('sticker').id), str(media('sticker').mime_type));
    case 'document': {
      const name = str(media('document').filename) || 'Document';
      return out([`📄 ${name}`, str(media('document').caption)].filter(Boolean).join('\n'), 'document', str(media('document').id), str(media('document').mime_type), name);
    }
    case 'location': return out(`📍 ${[m.location?.name, m.location?.address].filter(Boolean).join(', ') || `${m.location?.latitude}, ${m.location?.longitude}`}`, 'text');
    case 'contacts': return out(`👤 ${(m.contacts || []).map((c: any) => [c?.name?.formatted_name, c?.phones?.[0]?.phone].filter(Boolean).join(' ')).join(', ')}`, 'text');
    case 'reaction': return out('', 'reaction');
    default: return out('A message WhatsApp could not show here.', 'text');
  }
}

/** Keep a customer's file: Meta's own link stops working soon. The token goes to Meta's hosts and nowhere else. */
async function saveInboundMedia(token: string, mediaId: string, fallbackMime: string, filename: string, leadId: string): Promise<string> {
  const info = await call<any>(mediaId, token);
  const size = Number(info.file_size) || 0;
  if (size > MEDIA_MAX) throw new Error('too large');
  const url = new URL(str(info.url));
  if (url.protocol !== 'https:' || !MEDIA_HOSTS.test(url.hostname)) throw new Error('unexpected media host');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`media HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MEDIA_MAX) throw new Error('too large');
  const mime = str(info.mime_type || fallbackMime).split(';')[0] || 'application/octet-stream';
  const ext = (mime.split('/')[1] || 'bin').replace(/[^\w]/g, '').slice(0, 5);
  const saved = await saveFile({ category: WHATSAPP_FILE_CATEGORY, name: filename || `whatsapp-${mediaId}.${ext}`, mime, data, uploadedBy: 'WhatsApp', leadId });
  return saved.fileId;
}

async function handleInbound(c: ConnectionDoc, m: any, contactList: any[]) {
  const id = truncate(str(m?.id), 200);
  const phone = str(m?.from);
  if (!id || !phone) return;
  const content = inboundText(m);
  if (content.type === 'reaction') return;
  // a repeat delivery stops here, before touching leads or unread counts
  if (await (await msgs()).findOne({ dedupeKey: id }, { projection: { _id: 1 } })) return;
  const name = truncate(str(contactList.find((x) => str(x?.wa_id) === phone)?.profile?.name || contactList[0]?.profile?.name), 120);

  let lead: UiLead | null = null;
  try {
    lead = await leadFor(phone, name);
  } catch (e: any) {
    await logError('whatsappDirect.lead', e?.code || 'INTERNAL', e?.message, e?.stack, 'webhook', { phone: last10(phone) });
  }
  const leadId = lead ? lead[L.ID] || '' : '';
  if (lead && name && isPlaceholderName(lead[L.NAME], phone)) {
    try {
      await updateLead(leadId, { [L.NAME]: name }, directCtx());
      lead = { ...lead, [L.NAME]: name };
    } catch (e: any) {
      await logError('whatsappDirect.leadName', e?.code || 'INTERNAL', e?.message, e?.stack, 'webhook', { leadId });
    }
  }
  const displayName = (lead && !isPlaceholderName(lead[L.NAME], phone) ? lead[L.NAME] : '') || name || (lead ? lead[L.NAME] || '' : '');

  // a file that cannot be kept must not lose the message around it
  let fileId = '';
  let text = content.text;
  if (content.mediaId) {
    try {
      fileId = await saveInboundMedia(decryptSecret(c.token), content.mediaId, content.mime, content.filename, leadId);
    } catch (e: any) {
      await logError('whatsappDirect.media', 'UPSTREAM', e?.message, '', 'webhook', { type: content.type });
      text = [text, 'A file came with this message, but it could not be saved. Ask the customer to send it again.'].filter(Boolean).join('\n');
    }
  }
  const when = Number(m.timestamp) ? new Date(Number(m.timestamp) * 1000).toISOString() : undefined;
  const rec = await record({
    id, eventId: id, dedupeKey: id, direction: 'Inbound', phone, contactName: displayName, leadId, text, mediaUrl: fileId ? `/api/files/${fileId}` : '',
    status: 'received', type: content.type, raw: m, ts: when, extra: { channel: 'direct', ...(m.referral ? { fromAd: true } : {}) },
  });
  if (!rec) {
    if (fileId) await deleteFile(fileId).catch(() => undefined); // delivered twice at once
    return;
  }
  const preview = text || (content.type === 'image' ? '📷 Photo' : content.type === 'video' ? '🎥 Video' : 'Message');
  await upsertContact(phone, { contactName: displayName, leadId, lastMessageAt: new Date(), lastMessage: truncate(preview, 200), assignedRM: lead ? lead[L.RM] || '' : '', status: 'Open' }, { unreadCount: 1 });
  if (leadId) await addTimeline(leadId, 'chat_received', 'WhatsApp message received', truncate(preview, 300), name || 'Customer', 'Chat', rec.id);
  await addEvent('chat_received', 'Chat', phone, 'WhatsApp from ' + (displayName || e164(phone)), truncate(preview, 140), 'WhatsApp', { leadId });
  await bumpVersion();
  if ((currentTenant()?.features as any)?.whatsappCampaigns) await (await import('./whatsappCampaigns')).noteCampaignReply(phone, content.text).catch((e) => logError('whatsappCampaign.reply', 'INTERNAL', e?.message));
  if ((currentTenant()?.features as any)?.whatsappBots) await (await import('./whatsappBots')).onCustomerMessage({ phone: e164(phone), messageId: id, text: content.text, replyId: content.replyId || '', lead, name });
}

/** Typed on the phone in the WhatsApp Business app. Free, so no credits; it shows in the chat, and counts as the team having replied. */
async function handleEcho(c: ConnectionDoc, e: any) {
  const id = truncate(str(e?.id), 200);
  const phone = str(e?.to);
  if (!id || !phone) return;
  const content = inboundText(e);
  if (content.type === 'reaction') return;
  if (await (await msgs()).findOne({ dedupeKey: id }, { projection: { _id: 1 } })) return;
  const lead = await findLeadByPhone(phone);
  const leadId = lead ? lead[L.ID] || '' : '';
  let fileId = '';
  let text = content.text;
  if (content.mediaId) {
    try {
      fileId = await saveInboundMedia(decryptSecret(c.token), content.mediaId, content.mime, content.filename, leadId);
    } catch (err: any) {
      await logError('whatsappDirect.media', 'UPSTREAM', err?.message, '', 'webhook', { type: content.type });
      text = text || 'A file sent from the phone. See it in the WhatsApp Business app.';
    }
  }
  const when = Number(e.timestamp) ? new Date(Number(e.timestamp) * 1000).toISOString() : undefined;
  const rec = await record({ id, eventId: id, dedupeKey: id, direction: 'Outbound', phone, contactName: lead ? lead[L.NAME] || '' : '', leadId, text, mediaUrl: fileId ? `/api/files/${fileId}` : '', status: 'sent', agent: 'WhatsApp app', type: content.type, ts: when, extra: { channel: 'direct', fromApp: true } });
  if (!rec) {
    if (fileId) await deleteFile(fileId).catch(() => undefined);
    return;
  }
  const preview = text || (content.type === 'image' ? '📷 Photo' : content.type === 'video' ? '🎥 Video' : 'Message');
  await upsertContact(phone, { lastMessageAt: new Date(), lastMessage: truncate(preview, 200), ...(lead ? { contactName: lead[L.NAME] || '', leadId, assignedRM: lead[L.RM] || '' } : {}) });
  if (leadId) await addTimeline(leadId, 'chat_sent', 'WhatsApp message sent from the phone', truncate(preview, 300), 'WhatsApp app', 'Chat', rec.id);
  if ((currentTenant()?.features as any)?.whatsappBots) await (await import('./whatsappBots')).stopBotInChat(phone, 'Someone on the phone');
  await bumpVersion();
}

const HISTORY_STATUS: Record<string, string> = { READ: 'read', PLAYED: 'read', DELIVERED: 'delivered', SENT: 'sent', PENDING: 'sent', ERROR: 'failed' };

/** Old chats, in chunks and in any order. They join the chat list quietly: nothing unread, no alerts, no new leads, and a newer last message stays. */
async function handleHistory(value: any) {
  const conn = await connectionCol();
  for (const h of Array.isArray(value?.history) ? value.history : []) {
    if ((h?.errors || []).some((e: any) => Number(e?.code) === 2593109)) await conn.updateOne({ _id: DOC_ID }, { $set: { 'sync.declined': true } });
    const progress = Number(h?.metadata?.progress);
    if (Number.isFinite(progress)) await conn.updateOne({ _id: DOC_ID, $or: [{ 'sync.progress': { $lt: progress } }, { 'sync.progress': { $exists: false } }] } as any, { $set: { 'sync.progress': progress } });
    for (const thread of Array.isArray(h?.threads) ? h.threads : []) {
      const phone = str(thread?.context?.wa_id || thread?.id);
      if (last10(phone).length < 10) continue;
      const lead = await findLeadByPhone(phone);
      const leadId = lead ? lead[L.ID] || '' : '';
      const saved = await (await bookCol()).findOne({ _id: last10(phone) });
      const name = (lead ? lead[L.NAME] : '') || saved?.name || str(thread?.context?.username);
      let newest = 0;
      let newestText = '';
      await mapLimit(Array.isArray(thread?.messages) ? thread.messages : [], 10, async (m: any) => {
        const id = truncate(str(m?.id), 200);
        if (!id) return;
        const content = inboundText(m);
        if (content.type === 'reaction') return;
        const inbound = last10(str(m.from)) === last10(phone);
        const ms = Number(m.timestamp) * 1000 || 0;
        const text = content.text || (content.type === 'image' ? '📷 Photo' : 'Message');
        const rec = await record({ id, eventId: id, dedupeKey: id, direction: inbound ? 'Inbound' : 'Outbound', phone, contactName: name, leadId, text, status: inbound ? 'received' : HISTORY_STATUS[str(m.history_context?.status).toUpperCase()] || 'sent', agent: inbound ? '' : 'WhatsApp app', type: content.mediaId ? 'text' : content.type, ts: ms ? new Date(ms).toISOString() : undefined, extra: { channel: 'direct', fromHistory: true } });
        if (rec && ms > newest) { newest = ms; newestText = text; }
      });
      if (!newest) continue;
      const contact = await (await contactsCol()).findOne({ phoneLast10: last10(phone) });
      const seen = contact?.lastMessageAt ? new Date(contact.lastMessageAt).getTime() : 0;
      if (newest > seen) await upsertContact(phone, { lastMessageAt: new Date(newest), lastMessage: truncate(newestText, 200), contactName: name || contact?.contactName || '', leadId: leadId || contact?.leadId || '', assignedRM: lead ? lead[L.RM] || '' : contact?.assignedRM || '' });
    }
  }
  await bumpVersion();
}

/** The phone's address book: used for names only. It never adds anyone to the chat list. */
async function handleContacts(value: any) {
  const book = await bookCol();
  for (const s of Array.isArray(value?.state_sync) ? value.state_sync : []) {
    if (s?.type !== 'contact') continue;
    const key = last10(str(s.contact?.phone_number));
    if (key.length < 10) continue;
    if (s.action === 'remove') {
      await book.deleteOne({ _id: key });
      continue;
    }
    const name = truncate(str(s.contact?.full_name || s.contact?.first_name), 120);
    if (!name) continue;
    await book.updateOne({ _id: key }, { $set: { name, phone: str(s.contact?.phone_number), at: new Date() } }, { upsert: true });
    await (await contactsCol()).updateOne({ phoneLast10: key, $or: [{ contactName: '' }, { contactName: null }, { contactName: { $exists: false } }] }, { $set: { contactName: name } });
  }
}

/** The business removed this app in Meta: stop using a connection that no longer works, and say so. */
async function handlePartnerRemoved(c: ConnectionDoc) {
  await (await claimsCol()).deleteOne({ _id: c.phoneNumberId, companyId: currentTenant()?.id });
  await (await connectionCol()).deleteOne({ _id: DOC_ID });
  await (await templatesCol()).deleteMany({});
  await auditLog(SYSTEM_CTX, 'WhatsApp Direct Removed In Meta', 'Settings', DOC_ID, c.displayPhone);
  await notifyAdmins('whatsapp-removed', 'WhatsApp was disconnected in Meta', `${c.displayPhone} removed this CRM's access in Meta, so WhatsApp messages have stopped going through it. An Admin can connect it again in Settings.`);
  await bumpVersion();
}

const AFTER: Record<string, string[]> = { sent: ['delivered', 'read'], delivered: ['read'], read: [] };

/** Receipts can arrive out of order: "delivered" after "read" changes nothing, and a repeat is harmless. */
async function handleStatus(s: any) {
  const mid = str(s?.id);
  const status = str(s?.status);
  if (!mid || !status) return;
  if ((currentTenant()?.features as any)?.whatsappCampaigns) {
    const err = s.errors?.[0] || {};
    await (await import('./whatsappCampaigns')).noteCampaignStatus(mid, status, status === 'failed' ? explainMetaError({ metaCode: Number(err.code) || 0, message: str(err.error_data?.details || err.title || err.message) || 'No reason given.' }) : '', Number(err.code) || 0);
  }
  const coll = await msgs();
  const mine = { $or: [{ _id: mid }, { eventId: mid }] };
  // what Meta says this message costs
  if (s.pricing) await coll.updateOne(mine, { $set: { billable: s.pricing.billable !== false, pricingCategory: str(s.pricing.category) } });
  const tracked = creditsOn();
  const current = tracked ? await coll.findOne(mine) : null;
  if (tracked && !current) {
    await keepLateStatus(mid, s);
    return;
  }
  if (status === 'failed') {
    const err = s.errors?.[0] || {};
    const reason = explainMetaError({ metaCode: Number(err.code) || 0, message: str(err.error_data?.details || err.title || err.message) || 'No reason given.' });
    const row = await coll.findOneAndUpdate({ ...mine, status: { $ne: 'failed' } }, { $set: { status: 'failed', error: reason } });
    if (row) {
      if (row.leadId) await addTimeline(row.leadId, 'chat_failed', 'WhatsApp message not delivered', truncate(reason, 300), 'WhatsApp', 'Chat', mid);
      await addEvent('chat_failed', 'Chat', str(row.phone), `WhatsApp not delivered to ${row.contactName || row.phone}`, truncate(reason, 140), 'WhatsApp', { leadId: row.leadId || '' });
      await bumpVersion();
    }
    if (current) await releaseMessage(current);
    return;
  }
  if (!(status in AFTER)) return;
  const r = await coll.updateOne({ ...mine, status: { $nin: [...AFTER[status], status, 'failed'] } }, { $set: { status } });
  // charged on delivery; a read receipt also proves it, if "delivered" never came
  if (current && (status === 'delivered' || status === 'read')) await settleMessage(current, s.pricing);
  if (r.modifiedCount) await bumpVersion();
}

async function tenantOf(claim: NumberClaim | null) {
  if (!claim) return null;
  const tenant = await getTenantById(claim.companyId);
  return tenant && tenant.status === 'Active' && (tenant.features as any)?.whatsappDirect ? tenant : null;
}

/** A verified webhook body. Throws on a real failure, so Meta delivers it again; repeats are harmless. Numbers nobody here connected are ignored. */
export async function handleWhatsappWebhook(body: any): Promise<void> {
  const claims = await claimsCol();
  for (const entry of Array.isArray(body?.entry) ? body.entry.slice(0, 100) : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value || {};
      if (ch?.field === 'messages' || ch?.field === 'smb_message_echoes' || ch?.field === 'history' || ch?.field === 'smb_app_state_sync') {
        const numberId = str(v.metadata?.phone_number_id);
        const claim = numberId ? await claims.findOne({ _id: numberId }) : await claims.findOne({ wabaId: str(entry?.id) });
        const tenant = await tenantOf(claim);
        if (!tenant) continue;
        await runWithTenant(tenant, async () => {
          const c = await connection();
          if (!c || c.phoneNumberId !== claim!._id) return;
          if (ch.field === 'messages') {
            for (const m of Array.isArray(v.messages) ? v.messages : []) await handleInbound(c, m, Array.isArray(v.contacts) ? v.contacts : []);
            for (const s of Array.isArray(v.statuses) ? v.statuses : []) await handleStatus(s);
          } else if (ch.field === 'smb_message_echoes') {
            for (const e of Array.isArray(v.message_echoes) ? v.message_echoes : []) await handleEcho(c, e);
          } else if (ch.field === 'history') {
            await handleHistory(v);
          } else {
            await handleContacts(v);
          }
        });
      } else if (ch?.field === 'account_update') {
        if (str(v.event) !== 'PARTNER_REMOVED') continue;
        const waba = str(v.waba_info?.waba_id || entry?.id);
        const tenant = await tenantOf(await claims.findOne({ wabaId: waba }));
        if (!tenant) continue;
        await runWithTenant(tenant, async () => {
          const c = await connection();
          if (c && c.wabaId === waba) await handlePartnerRemoved(c);
        });
      } else if (ch?.field === 'message_template_status_update') {
        const tenant = await tenantOf(await claims.findOne({ wabaId: str(entry?.id) }));
        if (!tenant) continue;
        await runWithTenant(tenant, async () => {
          const reason = str(v.reason);
          await (await templatesCol()).updateMany({ name: str(v.message_template_name), language: str(v.message_template_language) }, { $set: { status: str(v.event).toUpperCase(), reason: reason === 'NONE' ? '' : reason } });
        });
      }
    }
  }
}

export const actions: ActionMap = {
  waDirectGet: { fn: () => getDirect(), perm: 'integrations.connect' },
  waDirectConnect: { fn: (d, ctx) => connectDirect(d, ctx), perm: 'integrations.connect' },
  waDirectFinishSignup: { fn: (d, ctx) => finishSignup(d, ctx), perm: 'integrations.connect' },
  waDirectPastChats: { fn: () => requestPastChats(), perm: 'integrations.connect' },
  waDirectDisconnect: { fn: (_d, ctx) => disconnectDirect(ctx), perm: 'integrations.connect' },
  // Managers run campaigns, so they manage templates too
  waDirectSyncTemplates: { fn: () => syncTemplatesAction(), perm: 'marketing.campaigns' },
  waDirectCreateTemplate: { fn: (d, ctx) => createTemplate(d, ctx), perm: 'marketing.campaigns' },
  waDirectDeleteTemplate: { fn: (d, ctx) => deleteTemplate(d, ctx), perm: 'marketing.campaigns' },
  waDirectAllTemplates: { fn: async () => (await (await templatesCol()).find({}).sort({ name: 1, language: 1 }).toArray()).map(templateView), perm: 'marketing.campaigns' },
  waDirectApprovedTemplates: { fn: () => approvedTemplates(), perm: 'chat.send' },
};
