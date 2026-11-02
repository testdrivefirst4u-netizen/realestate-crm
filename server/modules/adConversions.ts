/**
 * Ad conversions (plan feature `adConversions`, Settings › Ad conversions).
 *
 * When a lead reaches a step the company chose (e.g. Qualified, site visit completed, Booked), the CRM tells the
 * company's own Meta dataset through the Conversions API, so its Facebook / Instagram ads learn which enquiries
 * become buyers (Meta "conversion leads" optimisation). No App Review: the token is made in Events Manager.
 *
 * Config  = company `integrations` { _id: 'metaCapi', enabled, datasetId, token (AES-256-GCM), testCode, rules }.
 * Connect = "Connect with Facebook" (GET /api/integrations/meta/conversions/connect → the shared Meta callback, told
 *           apart by the state's signing purpose 'metaCapi'): Facebook Login for Business with the platform's ad
 *           conversions configuration (a system-user token that does not expire) or, without one, the permissions
 *           ads_management + business_management. One dataset is saved at once; several wait 30 minutes for the
 *           admin to pick one ({ _id: 'metaCapiPending' }). The dataset ID and token can also be typed in by hand.
 * Queue   = company `adConversions` { _id: 'meta:<leadId>:<event>' }: each event at most once per lead, ever.
 *           updateLead → queueConversions (insert, duplicates ignored) → sent after the response (next/server
 *           `after`); a failure retries with back-off from the Meta cron (every 10 min) and the daily cron while
 *           the event is under 7 days old (Meta refuses older ones).
 * Payload = action_source 'system_generated', user_data { lead_id (Facebook lead forms), ph / em as SHA-256 },
 *           custom_data { event_source 'crm', lead_event_source }. Phone and e-mail are never sent in plain text.
 */
import crypto from 'crypto';
import { after } from 'next/server';
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { logError } from '../core/events';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { randomToken } from '../core/utils';
import { resolveCrmSession, signState, stateSignedFor, verifyState } from '../core/oauthState';
import { currentTenant, runWithTenant, type Tenant } from '../core/tenant';
import { listActiveTenants } from '../platform/registry';
import { DEFAULT_GRAPH_VERSION, exchangeCodeForToken, graph, GRAPH_HOST, loadMetaConfig, longLivedUserToken, type MetaConfig } from '../integrations/meta';
import { oauthRedirectUri } from './meta';
import { inboundCol } from './intake';
import { getLead } from './leads';

const L = CFG.LEAD;
const DAY_MS = 86400000;
const MAX_AGE_MS = 7 * DAY_MS;
const LEAD_EVENT_SOURCE = 'BroaddCast CRM';

export type ConversionTrigger = 'stage' | 'siteVisit';
/** `value`: a stage, a site visit status, or 'done' (site visit Completed or Walk-In). */
export interface ConversionRule { event: string; when: ConversionTrigger; value: string }

const VISIT_DONE: string[] = [CFG.SITE_VISIT.COMPLETED, CFG.SITE_VISIT.WALK_IN];
const ruleMatches = (r: ConversionRule, change: { stage?: string; siteVisit?: string }) =>
  r.when === 'stage' ? !!change.stage && change.stage === r.value : !!change.siteVisit && (r.value === 'done' ? VISIT_DONE.includes(change.siteVisit) : change.siteVisit === r.value);

export const DEFAULT_RULES: ConversionRule[] = [
  { event: 'Qualified', when: 'stage', value: CFG.STAGES.QUALIFIED },
  { event: 'Site Visit Done', when: 'siteVisit', value: 'done' },
  { event: 'Booked', when: 'stage', value: CFG.STAGES.BOOKED },
];

interface ConfigDoc {
  _id: 'metaCapi';
  enabled: boolean;
  datasetId: string;
  token: string; // encrypted
  testCode: string;
  rules: ConversionRule[];
  /** How the dataset and token were set: Facebook login, or typed in. */
  connectedVia?: 'facebook' | 'manual';
  datasetName?: string;
  /** null: the token does not expire (system-user token). */
  tokenExpiresAt?: Date | null;
  updatedAt?: Date;
  updatedBy?: string;
}

interface PendingDoc {
  _id: 'metaCapiPending';
  token: string; // encrypted
  tokenExpiresAt: Date | null;
  datasets: MetaDataset[];
  createdBy: string; // user id
  expiresAt: Date;
}
export interface MetaDataset { id: string; name: string; account: string }

export type ConversionStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'expired';
interface QueueDoc {
  _id: string;
  platform: 'meta';
  leadId: string;
  event: string;
  status: ConversionStatus;
  attempts: number;
  eventTime: Date;
  createdAt: Date;
  nextAt: Date | null;
  sentAt?: Date;
  matchedBy?: string;
  error?: string;
}

const configCol = () => col<ConfigDoc>(CFG.COLL.INTEGRATIONS);
const pendingCol = () => col<PendingDoc>(CFG.COLL.INTEGRATIONS);
const queueCol = () => col<QueueDoc>(CFG.COLL.CONVERSIONS);

async function loadConfig(): Promise<(Omit<ConfigDoc, 'token'> & { token: string }) | null> {
  const doc = await (await configCol()).findOne({ _id: 'metaCapi' });
  if (!doc) return null;
  return { ...doc, token: doc.token ? decryptSecret(doc.token) : '', rules: Array.isArray(doc.rules) ? doc.rules : DEFAULT_RULES };
}

/* ------------------------------ hashing --------------------------------- */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Digits with the country code (Meta's format): 98765 01234 → 919876501234. '' when it is not a usable number. */
export function normalisePhone(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = '91' + d;
  return d.length >= 8 && d.length <= 15 ? d : '';
}

export function normaliseEmail(raw: string): string {
  const e = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

/* ------------------------------- queue ---------------------------------- */

/**
 * Called by updateLead after a save: queue the events whose step the lead just reached, and send them after the
 * response. Never throws (a lead save must not fail because of ads).
 */
export async function queueConversions(leadId: string, change: { stage?: string; siteVisit?: string }): Promise<number> {
  try {
    const tenant = currentTenant();
    if (!tenant?.features.adConversions || (!change.stage && !change.siteVisit)) return 0;
    const cfg = await loadConfig();
    if (!cfg?.enabled || !cfg.datasetId || !cfg.token) return 0;
    const hits = cfg.rules.filter((r) => ruleMatches(r, change));
    if (!hits.length) return 0;
    const now = new Date();
    const queued: string[] = [];
    for (const r of hits) {
      const _id = `meta:${leadId}:${r.event}`;
      try {
        await (await queueCol()).insertOne({ _id, platform: 'meta', leadId, event: r.event, status: 'pending', attempts: 0, eventTime: now, createdAt: now, nextAt: now });
        queued.push(_id);
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // already reported for this lead
      }
    }
    if (queued.length) scheduleSend(tenant, queued);
    return queued.length;
  } catch (e: any) {
    await logError('adConversions.queue', e?.code || 'INTERNAL', `Lead ${leadId}: ${e?.message}`, e?.stack, '', { leadId }).catch(() => undefined);
    return 0;
  }
}

function scheduleSend(tenant: Tenant, ids: string[]) {
  const task = () => runWithTenant(tenant, () => sendDue({ ids })).then(() => undefined, () => undefined);
  try {
    after(task);
  } catch {
    void task(); // outside a request (tests, scripts)
  }
}

const backoff = (attempts: number) => Math.min(6 * 3600000, 10 * 60000 * 2 ** Math.max(0, attempts - 1));

/** Send queued events (the given ones, or every due one): returns how many ended in each status. */
export async function sendDue(opts: { ids?: string[]; now?: Date; limit?: number } = {}): Promise<Record<string, number>> {
  const now = opts.now || new Date();
  const out: Record<string, number> = {};
  const q = await queueCol();
  const filter = opts.ids ? { _id: { $in: opts.ids }, status: { $in: ['pending', 'failed'] as ConversionStatus[] } } : { status: { $in: ['pending', 'failed'] as ConversionStatus[] }, nextAt: { $lte: now } };
  const due = await q.find(filter as any).sort({ createdAt: 1 }).limit(opts.limit || 100).toArray();
  if (!due.length) return out;
  const cfg = await loadConfig();
  for (const d of due) {
    let status: ConversionStatus;
    const set: Partial<QueueDoc> = {};
    if (now.getTime() - d.eventTime.getTime() > MAX_AGE_MS) {
      status = 'expired';
      set.error = 'Not sent within 7 days (Meta accepts events up to 7 days old).';
    } else if (!cfg?.enabled || !cfg.datasetId || !cfg.token) {
      status = 'failed';
      set.error = 'Ad conversions are switched off or the dataset / token is missing.';
    } else {
      const r = await sendOne(d, cfg);
      status = r.status;
      if (r.error) set.error = r.error;
      if (r.matchedBy) set.matchedBy = r.matchedBy;
      if (status === 'sent') set.sentAt = now;
    }
    const attempts = d.attempts + 1;
    await q.updateOne({ _id: d._id }, { $set: { ...set, status, attempts, nextAt: status === 'failed' ? new Date(now.getTime() + backoff(attempts)) : null } });
    out[status] = (out[status] || 0) + 1;
  }
  return out;
}

/** The Facebook lead id behind a lead (lead forms only), from the intake log. */
async function facebookLeadId(leadId: string): Promise<string> {
  const log = await (await inboundCol()).findOne({ leadId, idempotencyKey: { $regex: '^meta:' } } as any, { projection: { idempotencyKey: 1 } });
  const id = String(log?.idempotencyKey || '').slice('meta:'.length);
  return /^\d{5,20}$/.test(id) ? id : '';
}

interface SendResult { status: ConversionStatus; error?: string; matchedBy?: string }

async function sendOne(d: QueueDoc, cfg: { datasetId: string; token: string; testCode: string }): Promise<SendResult> {
  const lead = await getLead(d.leadId);
  if (!lead) return { status: 'skipped', error: 'The lead no longer exists.' };
  const user: Record<string, unknown> = {};
  const by: string[] = [];
  const fbId = await facebookLeadId(d.leadId);
  if (fbId) { user.lead_id = Number(fbId); by.push('Facebook lead'); }
  const ph = normalisePhone(lead[L.PHONE]);
  if (ph) { user.ph = [sha256(ph)]; by.push('phone'); }
  const em = normaliseEmail(lead[L.EMAIL]);
  if (em) { user.em = [sha256(em)]; by.push('e-mail'); }
  if (!by.length) return { status: 'skipped', error: 'No Facebook lead id, phone or e-mail to match with.' };
  const event = {
    event_name: d.event,
    event_time: Math.floor(d.eventTime.getTime() / 1000),
    event_id: sha256(d._id).slice(0, 40),
    action_source: 'system_generated',
    user_data: user,
    custom_data: { event_source: 'crm', lead_event_source: LEAD_EVENT_SOURCE },
  };
  const r = await postEvents(cfg, [event]);
  return r.ok ? { status: 'sent', matchedBy: by.join(' + ') } : { status: 'failed', error: r.error, matchedBy: by.join(' + ') };
}

async function postEvents(cfg: { datasetId: string; token: string; testCode: string }, data: unknown[], testCode?: string): Promise<{ ok: boolean; error?: string; received?: number }> {
  const version = process.env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  const body: Record<string, unknown> = { data, access_token: cfg.token };
  const code = testCode ?? cfg.testCode;
  if (code) body.test_event_code = code;
  try {
    const res = await fetch(`${GRAPH_HOST}/${version}/${encodeURIComponent(cfg.datasetId)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) return { ok: false, error: String(json?.error?.error_user_msg || json?.error?.message || `Meta answered ${res.status}`).slice(0, 300) };
    return { ok: true, received: Number(json?.events_received) || 0 };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'TimeoutError' ? 'Meta did not answer in time.' : String(e?.message || e).slice(0, 300) };
  }
}

/** Cron (Meta cron every 10 min, and daily): retry due events for every company with the feature. */
export async function runConversionsCron(now = new Date()): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.adConversions) continue;
    try {
      const r = await runWithTenant(tenant, () => sendDue({ now }));
      if (Object.keys(r).length) out[tenant.slug] = r;
    } catch (e: any) {
      out[tenant.slug] = { error: 1 };
      console.error(`[cron:conversions] ${tenant.slug}`, e?.message);
    }
  }
  return out;
}

/* ------------------------------ settings -------------------------------- */

export interface AdConversionsView {
  enabled: boolean;
  datasetId: string;
  tokenSet: boolean;
  testCode: string;
  rules: ConversionRule[];
  updatedAt: string;
  updatedBy: string;
  connectedVia: 'facebook' | 'manual' | '';
  datasetName: string;
  /** '' when it does not expire. */
  tokenExpiresAt: string;
  /** The platform has a Meta app, so "Connect with Facebook" can be offered. */
  connectAvailable: boolean;
  connectUrl: string;
  /** Datasets found by this admin's Facebook login, waiting for a choice. */
  pending: MetaDataset[] | null;
  last30: Record<ConversionStatus, number>;
  recent: Array<{ id: string; leadId: string; leadName: string; event: string; status: ConversionStatus; at: string; matchedBy: string; error: string }>;
}

export async function getAdConversions(ctx?: Ctx | null): Promise<AdConversionsView> {
  const doc = await (await configCol()).findOne({ _id: 'metaCapi' });
  const meta = await loadMetaConfig().catch(() => null);
  const pend = ctx?.user ? await (await pendingCol()).findOne({ _id: 'metaCapiPending', createdBy: ctx.user.id }) : null;
  const q = await queueCol();
  const since = new Date(Date.now() - 30 * DAY_MS);
  const last30: Record<ConversionStatus, number> = { pending: 0, sent: 0, failed: 0, skipped: 0, expired: 0 };
  for (const g of await q.aggregate<{ _id: ConversionStatus; n: number }>([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()) last30[g._id] = g.n;
  const rows = await q.find({}).sort({ createdAt: -1 }).limit(30).toArray();
  const names = new Map<string, string>();
  if (rows.length) {
    for (const l of await (await col<{ _id: string; name?: string }>(CFG.COLL.LEADS)).find({ _id: { $in: [...new Set(rows.map((r) => r.leadId))] } }, { projection: { name: 1 } }).toArray()) names.set(l._id, String(l.name || ''));
  }
  return {
    enabled: !!doc?.enabled,
    datasetId: doc?.datasetId || '',
    tokenSet: !!doc?.token,
    testCode: doc?.testCode || '',
    rules: Array.isArray(doc?.rules) ? doc!.rules : DEFAULT_RULES,
    updatedAt: doc?.updatedAt ? doc.updatedAt.toISOString() : '',
    updatedBy: doc?.updatedBy || '',
    connectedVia: doc?.token ? doc.connectedVia || 'manual' : '',
    datasetName: doc?.datasetName || '',
    tokenExpiresAt: doc?.token && doc.tokenExpiresAt ? doc.tokenExpiresAt.toISOString() : '',
    connectAvailable: !!(meta?.appId && meta.appSecret),
    connectUrl: CAPI_CONNECT_PATH,
    pending: pend && pend.expiresAt.getTime() > Date.now() ? pend.datasets : null,
    last30,
    recent: rows.map((r) => ({
      id: r._id, leadId: r.leadId, leadName: names.get(r.leadId) || '', event: r.event, status: r.status,
      at: (r.sentAt || r.createdAt).toISOString(), matchedBy: r.matchedBy || '', error: r.error || '',
    })),
  };
}

const EVENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

export async function saveAdConversions(d: any, ctx: Ctx): Promise<AdConversionsView> {
  const c = await configCol();
  const cur = await c.findOne({ _id: 'metaCapi' });
  const datasetId = String(d?.datasetId ?? cur?.datasetId ?? '').trim();
  if (datasetId && !/^\d{5,20}$/.test(datasetId)) throw fail('VALIDATION', 'The dataset (Pixel) ID is a number, e.g. 1234567890123456 (Events Manager › Settings).');
  const newToken = String(d?.token || '').trim();
  if (newToken && (newToken.length < 20 || newToken.length > 1000 || /\s/.test(newToken))) throw fail('VALIDATION', 'That does not look like a Conversions API access token.');
  const token = d?.clearToken ? '' : newToken ? encryptSecret(newToken) : cur?.token || '';
  const typedIn = !!newToken || (!!datasetId && datasetId !== cur?.datasetId);
  const via = { connectedVia: typedIn ? 'manual' : cur?.connectedVia || 'manual', datasetName: typedIn ? '' : cur?.datasetName || '', tokenExpiresAt: typedIn ? null : cur?.tokenExpiresAt ?? null };
  const testCode = String(d?.testCode ?? cur?.testCode ?? '').trim();
  if (testCode && !/^TEST\d{2,10}$/i.test(testCode)) throw fail('VALIDATION', 'The test code looks like TEST12345 (Events Manager › Test events). Leave it empty for real events.');
  const rawRules = Array.isArray(d?.rules) ? d.rules : cur?.rules || DEFAULT_RULES;
  if (rawRules.length > 10) throw fail('VALIDATION', 'Up to 10 events.');
  const rules: ConversionRule[] = rawRules.map((r: any) => ({ event: String(r?.event || '').trim(), when: r?.when === 'siteVisit' ? 'siteVisit' : 'stage', value: String(r?.value || '').trim() } as ConversionRule));
  for (const r of rules) {
    if (!EVENT_RE.test(r.event)) throw fail('VALIDATION', `Event name "${r.event}": letters, numbers, spaces, - and _ only (up to 40).`);
    if (!r.value || r.value.length > 80) throw fail('VALIDATION', `Choose when "${r.event}" is sent.`);
  }
  if (new Set(rules.map((r) => r.event.toLowerCase())).size !== rules.length) throw fail('VALIDATION', 'Each event name can be used once.');
  const enabled = d?.enabled === undefined ? !!cur?.enabled : !!d.enabled;
  if (enabled && (!datasetId || !token)) throw fail('VALIDATION', 'Add the dataset ID and the access token before switching this on.');
  const by = ctx.user?.name || 'System';
  await c.updateOne({ _id: 'metaCapi' }, { $set: { enabled, datasetId, token, testCode, rules, ...via, updatedAt: new Date(), updatedBy: by } as Partial<ConfigDoc> }, { upsert: true });
  await auditLog(ctx, 'Ad Conversions Updated', 'Settings', 'metaCapi', `${enabled ? 'On' : 'Off'} · dataset ${datasetId || '—'}${newToken ? ' · new token' : d?.clearToken ? ' · token removed' : ''}${testCode ? ' · test mode' : ''}`);
  return getAdConversions(ctx);
}

/* --------------------------- Connect with Facebook ----------------------- */

export const CAPI_CONNECT_PATH = '/api/integrations/meta/conversions/connect';
export const CAPI_PURPOSE = 'metaCapi';
const STATE_TTL_S = 600;
const PENDING_TTL_MS = 30 * 60000;
const CAPI_SCOPES = 'ads_management,business_management';

/** Settings › Ad conversions with a result for the page to show (never a token in the URL). */
export const conversionsRedirect = (params: Record<string, string>) => `${appUrl()}/settings?${new URLSearchParams({ section: 'adConversions', ...params }).toString()}`;

/** GET /api/integrations/meta/conversions/connect — core logic (the route sets the nonce cookie and redirects). */
export async function startCapiConnect(input: { sessionCookie: string; nowMs?: number }): Promise<{ redirect: string; nonce?: string }> {
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  if (!can(sess.user, 'settings.edit')) return { redirect: conversionsRedirect({ capiError: 'Only Platform support can connect Facebook.' }) };
  if (!sess.tenant.features.adConversions) return { redirect: conversionsRedirect({ capiError: "Ad conversions are not included in your company's plan." }) };
  const cfg = await loadMetaConfig();
  if (!cfg.appId || !cfg.appSecret) return { redirect: conversionsRedirect({ capiError: 'Facebook is not set up on this platform yet. Ask your platform administrator, or enter the dataset ID and token by hand.' }) };
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S }, CAPI_PURPOSE);
  const q = new URLSearchParams({ client_id: cfg.appId, redirect_uri: oauthRedirectUri(), state, response_type: 'code' });
  if (cfg.capiConfigId) q.set('config_id', cfg.capiConfigId);
  else q.set('scope', CAPI_SCOPES);
  return { redirect: `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?${q.toString()}`, nonce };
}

/** Is this callback the return from "Connect with Facebook" of Ad conversions (not of lead Pages)? */
export const isCapiCallback = (params: URLSearchParams) => stateSignedFor(params.get('state') || '', CAPI_PURPOSE);

/** When the token stops working ('' = never), from Graph's debug_token; null when Facebook does not say. */
async function tokenExpiry(token: string, cfg: MetaConfig): Promise<Date | null> {
  try {
    const j = await graph<{ data?: { expires_at?: number; data_access_expires_at?: number } }>('debug_token', { config: cfg, params: { input_token: token, access_token: `${cfg.appId}|${cfg.appSecret}` } });
    const at = [j.data?.expires_at, j.data?.data_access_expires_at].filter((x): x is number => typeof x === 'number' && x > 0);
    return at.length ? new Date(Math.min(...at) * 1000) : null;
  } catch {
    return null;
  }
}

/** Datasets (Pixels) the token reaches: through its ad accounts, and the businesses it belongs to. */
export async function listDatasets(token: string, cfg: MetaConfig): Promise<MetaDataset[]> {
  const out = new Map<string, MetaDataset>();
  const add = (id: unknown, name: unknown, account: string) => {
    const k = String(id || '');
    if (/^\d{5,20}$/.test(k) && !out.has(k)) out.set(k, { id: k, name: String(name || 'Dataset ' + k).slice(0, 120), account: account.slice(0, 120) });
  };
  let reached = false;
  try {
    const acc = await graph<{ data?: any[] }>('me/adaccounts', { token, config: cfg, params: { fields: 'name,account_id,adspixels.limit(50){id,name}', limit: 50 } });
    reached = true;
    for (const a of acc.data || []) for (const p of a?.adspixels?.data || []) add(p.id, p.name, String(a.name || a.account_id || ''));
  } catch { /* try businesses */ }
  try {
    const biz = await graph<{ data?: any[] }>('me/businesses', { token, config: cfg, params: { fields: 'name,owned_pixels.limit(50){id,name}', limit: 50 } });
    reached = true;
    for (const b of biz.data || []) for (const p of b?.owned_pixels?.data || []) add(p.id, p.name, String(b.name || ''));
  } catch { /* none */ }
  if (!reached) throw fail('SERVER', 'Facebook did not let the CRM read your ad accounts. Allow access to the ad account and its dataset in the Facebook window.');
  return [...out.values()].slice(0, 100);
}

async function saveConnected(ds: MetaDataset, token: string, tokenExpiresAt: Date | null, ctx: Ctx) {
  const by = ctx.user?.name || 'System';
  await (await configCol()).updateOne(
    { _id: 'metaCapi' },
    {
      $set: { datasetId: ds.id, datasetName: ds.name, token, tokenExpiresAt, connectedVia: 'facebook', updatedAt: new Date(), updatedBy: by },
      $setOnInsert: { enabled: false, testCode: '', rules: DEFAULT_RULES },
    },
    { upsert: true }
  );
  await (await pendingCol()).deleteOne({ _id: 'metaCapiPending' });
  await auditLog(ctx, 'Ad Conversions Connected', 'Settings', 'metaCapi', `Facebook · dataset ${ds.name} (${ds.id})${tokenExpiresAt ? ' · token valid until ' + tokenExpiresAt.toISOString().slice(0, 10) : ' · token does not expire'}`);
}

/** The Facebook callback for Ad conversions: always a redirect to Settings › Ad conversions. */
export async function finishCapiConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const p = input.params;
  const error = p.get('error') || '';
  if (error) {
    const cancelled = p.get('error_reason') === 'user_denied' || error === 'access_denied';
    return { redirect: conversionsRedirect({ capiError: cancelled ? 'Facebook login was cancelled.' : `Facebook login failed: ${p.get('error_description') || error}`.slice(0, 300) }) };
  }
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs, CAPI_PURPOSE);
  if (!v.ok) return { redirect: conversionsRedirect({ capiError: 'The Facebook login could not be verified (it expired or was started in another session). Please try again.' }) };
  if (!can(sess.user, 'settings.edit') || !sess.tenant.features.adConversions) return { redirect: conversionsRedirect({ capiError: 'You cannot connect Facebook here.' }) };
  const code = p.get('code') || '';
  if (!code) return { redirect: conversionsRedirect({ capiError: 'Facebook did not return an authorisation code. Please try again.' }) };
  const ctx = { user: sess.user } as Ctx;
  try {
    const result = await runWithTenant(sess.tenant, async () => {
      const cfg = await loadMetaConfig();
      let token = await exchangeCodeForToken(code, oauthRedirectUri(), cfg);
      // a system-user token (configuration) does not expire; a plain login token is swapped for the ~60-day one
      if (!cfg.capiConfigId) token = await longLivedUserToken(token, cfg);
      const datasets = await listDatasets(token, cfg);
      if (!datasets.length) throw fail('VALIDATION', 'Facebook returned no dataset (Pixel). In the Facebook window choose the ad account and its dataset, or create a dataset in Events Manager first.');
      const expires = await tokenExpiry(token, cfg);
      if (datasets.length === 1) {
        await saveConnected(datasets[0], encryptSecret(token), expires, ctx);
        return { capiConnected: datasets[0].name };
      }
      const now = new Date(input.nowMs ?? Date.now());
      await (await pendingCol()).replaceOne(
        { _id: 'metaCapiPending' },
        { token: encryptSecret(token), tokenExpiresAt: expires, datasets, createdBy: sess.user.id, expiresAt: new Date(now.getTime() + PENDING_TTL_MS) } as any,
        { upsert: true }
      );
      return { capiChoose: String(datasets.length) };
    });
    return { redirect: conversionsRedirect(result) };
  } catch (e: any) {
    if (e?.code !== 'VALIDATION') console.error('[meta:capi-callback]', e?.message);
    return { redirect: conversionsRedirect({ capiError: String(e?.message || 'Could not connect Facebook.').slice(0, 300) }) };
  }
}

/** The admin picks one of the datasets their Facebook login found. */
export async function chooseAdConversionDataset(d: any, ctx: Ctx): Promise<AdConversionsView> {
  const pend = ctx.user ? await (await pendingCol()).findOne({ _id: 'metaCapiPending', createdBy: ctx.user.id }) : null;
  if (!pend || pend.expiresAt.getTime() < Date.now()) throw fail('NOT_FOUND', 'This Facebook login has expired. Connect with Facebook again.');
  const ds = pend.datasets.find((x) => x.id === String(d?.datasetId || ''));
  if (!ds) throw fail('VALIDATION', 'Choose one of the datasets Facebook returned.');
  await saveConnected(ds, pend.token, pend.tokenExpiresAt, ctx);
  return getAdConversions(ctx);
}

/** Forget the token (and switch sending off). Facebook access can also be removed in Business settings. */
export async function disconnectAdConversions(ctx: Ctx): Promise<AdConversionsView> {
  await (await configCol()).updateOne({ _id: 'metaCapi' }, { $set: { enabled: false, token: '', datasetName: '', connectedVia: 'manual', tokenExpiresAt: null, updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' } });
  await (await pendingCol()).deleteOne({ _id: 'metaCapiPending' });
  await auditLog(ctx, 'Ad Conversions Disconnected', 'Settings', 'metaCapi', 'Token removed; sending switched off');
  return getAdConversions(ctx);
}

/** One sample event with the test code, shown in Events Manager › Test events (nothing is counted as a real conversion). */
export async function testAdConversion(d: any, ctx: Ctx): Promise<{ ok: boolean; message: string }> {
  const cfg = await loadConfig();
  if (!cfg?.datasetId || !cfg.token) throw fail('VALIDATION', 'Save the dataset ID and the access token first.');
  const code = String(d?.testCode || cfg.testCode || '').trim();
  if (!/^TEST\d{2,10}$/i.test(code)) throw fail('VALIDATION', 'Copy the test code from Events Manager › Test events (it looks like TEST12345).');
  const r = await postEvents(cfg, [{
    event_name: cfg.rules[0]?.event || 'Qualified',
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'system_generated',
    user_data: { em: [sha256('test@example.com')] },
    custom_data: { event_source: 'crm', lead_event_source: LEAD_EVENT_SOURCE },
  }], code);
  await auditLog(ctx, 'Ad Conversions Test', 'Settings', 'metaCapi', r.ok ? 'Test event accepted' : `Failed: ${r.error}`);
  return r.ok
    ? { ok: true, message: 'Meta accepted the test event. It shows in Events Manager › Test events within a minute.' }
    : { ok: false, message: `Meta refused it: ${r.error}` };
}

export const actions: ActionMap = {
  getAdConversions: { fn: (_d, ctx) => getAdConversions(ctx), perm: 'settings.view' },
  chooseAdConversionDataset: { fn: (d, ctx) => chooseAdConversionDataset(d, ctx), perm: 'settings.edit' },
  disconnectAdConversions: { fn: (_d, ctx) => disconnectAdConversions(ctx), perm: 'settings.edit' },
  saveAdConversions: { fn: (d, ctx) => saveAdConversions(d, ctx), perm: 'settings.edit' },
  testAdConversion: { fn: (d, ctx) => testAdConversion(d, ctx), perm: 'settings.edit' },
};
