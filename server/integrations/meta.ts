/**
 * Meta (Facebook) Graph API client and platform app configuration (contract: server/core/metaTypes.ts).
 * No SDK: node:crypto + global fetch.
 *
 * Configuration (stored values win over env, field by field):
 *   platform PCOLL.PLATFORM_SETTINGS { _id: 'meta', appId, appSecret (AES-GCM encrypted), verifyToken (encrypted),
 *   graphVersion, loginConfigId, updatedAt, updatedBy } — set by the super admin (server/platform/meta.ts);
 *   env META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN, META_GRAPH_VERSION (default v23.0), META_LOGIN_CONFIG_ID.
 *
 * Graph calls: https://graph.facebook.com/<version>/<path>, 20 s timeout, `appsecret_proof` =
 * HMAC-SHA256(key = app secret, data = access token) on every call made with a token, one retry on 5xx/429 and on
 * Graph rate-limit codes (4, 17, 32, 613). Errors become MetaApiError with a message safe to show; tokens, the
 * app secret and request URLs are never logged nor put into messages.
 */
import crypto from 'node:crypto';
import { ApiError, fail } from '../core/errors';
import { decryptSecret } from '../core/settings';
import { truncate } from '../core/utils';
import { pc } from '../platform/base';
import { PCOLL } from '../platform/registry';

export const GRAPH_HOST = 'https://graph.facebook.com';
export const DEFAULT_GRAPH_VERSION = 'v23.0';
export const OAUTH_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'leads_retrieval', 'pages_manage_ads', 'business_management'];
/** Graph fields of a lead (webhook fetch and backfill). */
export const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id,platform,is_organic';
export const MAX_BACKFILL_LEADS = 1000;
const TIMEOUT_MS = 20000;
let retryDelayMs = 800;

/** Test hook: shorten the retry back-off. */
export function __setMetaRetryDelay(ms: number) {
  retryDelayMs = ms;
}

/* ------------------------------- configuration --------------------------- */

export interface MetaSettingsDoc {
  _id: 'meta';
  appId: string;
  appSecret: string; // encrypted
  verifyToken: string; // encrypted
  graphVersion: string;
  loginConfigId: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface MetaConfig {
  appId: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
  loginConfigId: string;
  /** Where the app id / secret come from. */
  source: 'platform' | 'env' | 'none';
  configured: boolean;
}

export const metaSettingsCol = () => pc<MetaSettingsDoc>(PCOLL.PLATFORM_SETTINGS);

const env = (k: string) => process.env[k]?.trim() || '';

/** The active configuration: each stored value wins over its env fallback. */
export async function loadMetaConfig(): Promise<MetaConfig> {
  const doc = await (await metaSettingsCol()).findOne({ _id: 'meta' });
  const storedSecret = doc?.appSecret ? decryptSecret(doc.appSecret) : '';
  if (doc?.appSecret && !storedSecret) console.error('[meta] the stored app secret cannot be decrypted (SECRETS_ENCRYPTION_KEY changed?)');
  const storedVerify = doc?.verifyToken ? decryptSecret(doc.verifyToken) : '';
  const appId = doc?.appId || env('META_APP_ID');
  const appSecret = storedSecret || env('META_APP_SECRET');
  const verifyToken = storedVerify || env('META_VERIFY_TOKEN');
  const graphVersion = doc?.graphVersion || env('META_GRAPH_VERSION') || DEFAULT_GRAPH_VERSION;
  const loginConfigId = doc?.loginConfigId || env('META_LOGIN_CONFIG_ID');
  const source: MetaConfig['source'] = doc?.appId || storedSecret ? 'platform' : appId || appSecret ? 'env' : 'none';
  return { appId, appSecret, verifyToken, graphVersion, loginConfigId, source, configured: !!(appId && appSecret && verifyToken) };
}

const NOT_CONFIGURED_MSG = 'Meta Lead Ads is not set up on this platform yet (no Meta app). Ask your platform administrator.';

export async function requireMetaConfig(): Promise<MetaConfig> {
  const c = await loadMetaConfig();
  if (!c.appId || !c.appSecret) throw fail('NOT_CONFIGURED', NOT_CONFIGURED_MSG);
  return c;
}

/** HMAC-SHA256(appSecret, token) hex — proves the call comes from the app's server. */
export function appSecretProof(token: string, appSecret: string) {
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex');
}

/** Constant-time check of an X-Hub-Signature-256 header ('sha256=<hex>') over the raw body. */
export function verifyHubSignature(rawBody: string | Buffer, header: string | null | undefined, appSecret: string): boolean {
  const h = String(header || '').trim();
  if (!appSecret || !h.startsWith('sha256=')) return false;
  const given = Buffer.from(h.slice(7), 'hex');
  const expected = crypto.createHmac('sha256', appSecret).update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody).digest();
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/* ---------------------------------- errors ------------------------------- */

export const TOKEN_EXPIRED_MSG = 'The Facebook connection expired — reconnect the Page';
const RATE_CODES = new Set([4, 17, 32, 613]);

/** An error answer of the Graph API (message safe to show). */
export class MetaApiError extends ApiError {
  constructor(public httpStatus: number, public fbCode: number, public fbMessage: string, message: string, code: ApiError['code'] = 'SERVER') {
    super(code, message, { metaCode: fbCode, metaStatus: httpStatus });
  }
  /** Token expired / revoked / password changed (Graph code 190). */
  get tokenExpired() {
    return this.fbCode === 190;
  }
}

function toMetaError(httpStatus: number, err: any): MetaApiError {
  const code = Number(err?.code) || 0;
  const msg = String(err?.message || err?.error_user_msg || '').replace(/access_token=[^&\s]+/gi, 'access_token=…');
  const short = truncate(msg, 200);
  if (code === 190 || code === 102 || code === 463 || code === 467) return new MetaApiError(httpStatus, 190, msg, TOKEN_EXPIRED_MSG, 'VALIDATION');
  if (RATE_CODES.has(code) || httpStatus === 429) return new MetaApiError(httpStatus, code, msg, 'Facebook is rate-limiting requests right now. It will be retried automatically.', 'RATE_LIMIT');
  const permissionText = /permission|not authori[sz]ed|leads_retrieval|pages_|business_management|manage|does not have/i.test(msg);
  if (code === 10 || (code >= 200 && code <= 299) || (code === 100 && permissionText)) {
    return new MetaApiError(httpStatus, code, msg, `Facebook refused access: ${short || 'missing permission'}. The person who connected the Page needs admin (or advertiser) access to it and the app needs leads_retrieval / pages permissions; in Meta Business Suite › Leads Access the CRM app must be allowed.`, 'VALIDATION');
  }
  if (code === 100 || code === 803) return new MetaApiError(httpStatus, code, msg, `Facebook did not find it: ${short || 'unknown object'}`, 'VALIDATION');
  if (httpStatus >= 500 || code === 1 || code === 2) return new MetaApiError(httpStatus, code, msg, 'Facebook is temporarily unavailable. Please try again later.', 'SERVER');
  return new MetaApiError(httpStatus, code, msg, `Facebook refused the request: ${short || 'HTTP ' + httpStatus}`, httpStatus >= 400 && httpStatus < 500 ? 'VALIDATION' : 'SERVER');
}

/* ----------------------------------- HTTP -------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GraphOptions {
  token?: string;
  params?: Record<string, string | number | boolean | undefined>;
  method?: 'GET' | 'POST' | 'DELETE';
  /** Use this config instead of loading it (avoids a database read in loops). */
  config?: MetaConfig;
}

/** Call the Graph API. Returns the parsed JSON body; throws MetaApiError (or SERVER on network failure). */
export async function graph<T = any>(path: string, opts: GraphOptions = {}): Promise<T> {
  const cfg = opts.config || (await loadMetaConfig());
  const method = opts.method || 'GET';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.params || {})) if (v !== undefined && v !== null) params.set(k, String(v));
  if (opts.token) {
    if (!cfg.appSecret) throw fail('NOT_CONFIGURED', NOT_CONFIGURED_MSG);
    params.set('access_token', opts.token);
    params.set('appsecret_proof', appSecretProof(opts.token, cfg.appSecret));
  }
  const url = `${GRAPH_HOST}/${cfg.graphVersion || DEFAULT_GRAPH_VERSION}/${String(path).replace(/^\/+/, '')}`;
  const init: RequestInit = method === 'POST'
    ? { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
    : { method };
  const target = method === 'POST' ? url : `${url}?${params.toString()}`;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(target, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e: any) {
      if (attempt === 0 && method === 'GET') {
        await sleep(retryDelayMs);
        continue;
      }
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw fail('SERVER', timeout ? 'Facebook did not answer within 20 seconds. Please try again.' : 'Could not reach Facebook. Please try again.');
    }
    const text = await res.text().catch(() => '');
    let j: any = null;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = null;
    }
    if (res.ok && j && !j.error) return j as T;
    const err = toMetaError(res.status, j?.error || {});
    const retryable = res.status === 429 || res.status >= 500 || RATE_CODES.has(err.fbCode);
    if (retryable && attempt === 0) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : retryDelayMs);
      continue;
    }
    throw err;
  }
}

/* --------------------------------- helpers ------------------------------- */

export interface GraphPage { id: string; name: string; access_token: string; tasks: string[] }
export interface GraphForm { id: string; name: string; status: string }
export interface GraphLead {
  id: string;
  created_time?: string;
  field_data?: Array<{ name: string; values?: unknown[] }>;
  ad_id?: string;
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
}

/** OAuth code → short-lived user token. */
export async function exchangeCodeForToken(code: string, redirectUri: string, config?: MetaConfig): Promise<string> {
  const cfg = config || (await requireMetaConfig());
  const j = await graph<{ access_token?: string }>('oauth/access_token', { config: cfg, params: { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: redirectUri, code } });
  if (!j.access_token) throw fail('SERVER', 'Facebook did not return an access token');
  return j.access_token;
}

/** Short-lived → long-lived (~60 days) user token; Page tokens derived from it do not expire. */
export async function longLivedUserToken(token: string, config?: MetaConfig): Promise<string> {
  const cfg = config || (await requireMetaConfig());
  const j = await graph<{ access_token?: string }>('oauth/access_token', { config: cfg, params: { grant_type: 'fb_exchange_token', client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: token } });
  return j.access_token || token;
}

/** Follow `paging.cursors.after` (at most `maxPages` requests). */
async function paged<T>(path: string, token: string, params: Record<string, string | number>, cap: number, maxPages = 20, config?: MetaConfig): Promise<T[]> {
  const out: T[] = [];
  let after = '';
  for (let i = 0; i < maxPages && out.length < cap; i++) {
    const j = await graph<{ data?: T[]; paging?: { next?: string; cursors?: { after?: string } } }>(path, { token, config, params: { ...params, ...(after ? { after } : {}) } });
    out.push(...(j.data || []));
    after = j.paging?.cursors?.after || '';
    if (!j.paging?.next || !after) break;
  }
  return out.slice(0, cap);
}

/** Pages the user manages, with Page tokens and the user's tasks on each. */
export async function listPages(userToken: string, config?: MetaConfig): Promise<GraphPage[]> {
  const rows = await paged<any>('me/accounts', userToken, { fields: 'id,name,access_token,tasks', limit: 100 }, 500, 10, config);
  return rows.map((p) => ({ id: String(p.id || ''), name: String(p.name || ''), access_token: String(p.access_token || ''), tasks: Array.isArray(p.tasks) ? p.tasks.map(String) : [] })).filter((p) => p.id);
}

export async function listForms(pageId: string, pageToken: string, config?: MetaConfig): Promise<GraphForm[]> {
  const rows = await paged<any>(`${pageId}/leadgen_forms`, pageToken, { fields: 'id,name,status', limit: 100 }, 500, 10, config);
  return rows.map((f) => ({ id: String(f.id || ''), name: String(f.name || ''), status: String(f.status || '') })).filter((f) => f.id);
}

export async function subscribePage(pageId: string, pageToken: string, config?: MetaConfig): Promise<boolean> {
  const j = await graph<{ success?: boolean }>(`${pageId}/subscribed_apps`, { token: pageToken, config, method: 'POST', params: { subscribed_fields: 'leadgen' } });
  return j.success !== false;
}

export async function unsubscribePage(pageId: string, pageToken: string, config?: MetaConfig): Promise<boolean> {
  const j = await graph<{ success?: boolean }>(`${pageId}/subscribed_apps`, { token: pageToken, config, method: 'DELETE' });
  return j.success !== false;
}

/** Whether this app is subscribed to the Page's `leadgen` field. */
export async function isPageSubscribed(pageId: string, pageToken: string, config?: MetaConfig): Promise<boolean> {
  const cfg = config || (await requireMetaConfig());
  const j = await graph<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(`${pageId}/subscribed_apps`, { token: pageToken, config: cfg });
  return (j.data || []).some((a) => String(a.id) === cfg.appId && (!a.subscribed_fields || a.subscribed_fields.includes('leadgen')));
}

export async function getPage(pageId: string, pageToken: string, config?: MetaConfig): Promise<{ id: string; name: string }> {
  const j = await graph<{ id?: string; name?: string }>(pageId, { token: pageToken, config, params: { fields: 'id,name' } });
  return { id: String(j.id || ''), name: String(j.name || '') };
}

export async function getLead(leadgenId: string, pageToken: string, config?: MetaConfig): Promise<GraphLead> {
  return graph<GraphLead>(leadgenId, { token: pageToken, config, params: { fields: LEAD_FIELDS } });
}

/** Leads of a form created after `sinceUnix` (seconds), newest first, at most `cap`. */
export async function listFormLeads(formId: string, pageToken: string, sinceUnix: number, cap = MAX_BACKFILL_LEADS, config?: MetaConfig): Promise<GraphLead[]> {
  const filtering = JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(sinceUnix) }]);
  return paged<GraphLead>(`${formId}/leads`, pageToken, { fields: LEAD_FIELDS, filtering, limit: 100 }, Math.max(0, Math.min(cap, MAX_BACKFILL_LEADS)), 20, config);
}

/** Check the app id + secret by requesting an app access token (client_credentials). */
export async function checkAppToken(config?: MetaConfig): Promise<void> {
  const cfg = config || (await requireMetaConfig());
  const j = await graph<{ access_token?: string }>('oauth/access_token', { config: cfg, params: { client_id: cfg.appId, client_secret: cfg.appSecret, grant_type: 'client_credentials' } });
  if (!j.access_token) throw fail('SERVER', 'Facebook did not return an app access token');
}
