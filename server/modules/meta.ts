/**
 * Meta (Facebook / Instagram) Lead Ads — company side (contract and design: server/core/metaTypes.ts).
 *
 * Source  = a lead source of type 'meta' per connected Facebook Page (collection leadSources, config.meta).
 *           The Page access token is stored AES-GCM encrypted in `secret.pageToken` on the source document;
 *           toSource() (server/modules/leadSources.ts) never serialises it.
 * Claims  = platform `metaPages` { _id: pageId, companyId, sourceId }: one company per Page (CONFLICT otherwise).
 * Connect = GET /api/integrations/meta/connect → Facebook OAuth with a signed `state`
 *           (base64url JSON {c: companyId, u: userId, n: nonce, exp} + '.' + HMAC-SHA256, key derived from
 *           SECRETS_ENCRYPTION_KEY) and the nonce in the httpOnly cookie `meta_oauth_nonce` →
 *           GET /api/integrations/meta/callback (state, nonce cookie and the CRM session must all match) →
 *           long-lived user token → /me/accounts → pending connection (company `metaConnections`, TTL 30 min,
 *           Page tokens encrypted, visible only to the user who logged in) →
 *           redirect `/settings?section=leadSources&metaConnect=<id>` (or `&metaError=<message>`) →
 *           getMetaPendingConnection / connectMetaPages.
 * Leads   = mapMetaLead() turns a Graph lead into intake fields; ingestLead() with idempotency key
 *           `meta:<leadgen_id>` (webhook queue: server/modules/metaQueue.ts; backfill: backfillMetaSource).
 *
 * canReadLeads: reading leads (leads_retrieval) needs a Page task that grants lead access. We treat the Page tasks
 * MANAGE (full admin) or ADVERTISE (advertiser) as sufficient; MODERATE / CREATE_CONTENT / ANALYZE alone are not.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { col, nextSeq } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { logError } from '../core/events';
import type { MetaActions, MetaPendingPage, MetaSourceConfig, MetaStatus } from '../core/metaTypes';
import type { LeadSourceConfig } from '../core/leadSourceTypes';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { requireTenant, runWithTenant } from '../core/tenant';
import { randomToken, truncate } from '../core/utils';
import {
  exchangeCodeForToken, getPage, isPageSubscribed, listFormLeads, listForms, listPages, loadMetaConfig, longLivedUserToken,
  MAX_BACKFILL_LEADS, MetaApiError, requireMetaConfig, subscribePage, TOKEN_EXPIRED_MSG, unsubscribePage,
  type GraphLead, type MetaConfig,
} from '../integrations/meta';
import { mapLimit, pc } from '../platform/base';
import { PCOLL } from '../platform/registry';
import { ingestLead, normKey, sourcesCol, type IngestResult, type SourceDoc } from './intake';
import { defaultConfig, mergeConfig, toSource } from './leadSources';

type Req<K extends keyof MetaActions> = MetaActions[K]['req'];
type Res<K extends keyof MetaActions> = MetaActions[K]['res'];

export const COLL_CONNECTIONS = 'metaConnections';
export const NONCE_COOKIE = 'meta_oauth_nonce';
export const CONNECT_PATH = '/api/integrations/meta/connect';
export const CALLBACK_PATH = '/api/integrations/meta/callback';
const STATE_TTL_S = 600;
const PENDING_TTL_MS = 30 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const LEAD_TASKS = ['MANAGE', 'ADVERTISE'];

const actorName = (ctx: Ctx | null) => (ctx?.user ? ctx.user.name + (ctx.user.email ? ` <${ctx.user.email}>` : '') : 'System');
export const errMsg = (e: any) => (e instanceof ApiError ? e.message : 'Internal error: ' + truncate(e?.message || String(e), 200));

/* --------------------------------- shapes -------------------------------- */

/** A meta lead source as stored: the Page token lives beside the public fields and is never serialised. */
export type MetaSourceDoc = SourceDoc & { secret?: { pageToken?: string }; backfillLockUntil?: Date | null };

export interface MetaPageClaim {
  _id: string; // Facebook Page id
  companyId: string;
  sourceId: string;
  claimedAt: Date;
}

interface PendingPage {
  id: string;
  name: string;
  tasks: string[];
  token: string; // encrypted Page token
  forms: Array<{ id: string; name: string; status: string }>;
}

export interface MetaConnectionDoc {
  _id: string;
  pages: PendingPage[];
  createdBy: string; // user id
  createdAt: Date;
  expiresAt: Date;
}

export const metaPagesCol = () => pc<MetaPageClaim>(PCOLL.META_PAGES);
export const connectionsCol = () => col<MetaConnectionDoc>(COLL_CONNECTIONS);
const metaSources = async () => (await sourcesCol()) as unknown as import('mongodb').Collection<MetaSourceDoc>;

export function defaultMetaSourceConfig(): MetaSourceConfig {
  return { pageId: '', pageName: '', formIds: [], forms: [], connectedBy: '', connectedAt: '', subscribed: false, lastLeadAt: '', lastBackfillAt: '', lastError: '' };
}

const ID_RE = /^\d{1,30}$/;

/** A list of lead-form ids (digits), de-duplicated, at most 200. */
export function validFormIds(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw fail('VALIDATION', 'formIds must be a list of lead form ids');
  const ids = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (ids.length > 200) throw fail('VALIDATION', 'At most 200 lead forms');
  const bad = ids.find((x) => !ID_RE.test(x));
  if (bad) throw fail('VALIDATION', `"${truncate(bad, 40)}" is not a lead form id`);
  return ids;
}

function validPageId(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!ID_RE.test(s)) throw fail('VALIDATION', 'A Facebook Page id is a number');
  return s;
}

/** The decrypted Page token of a source ('' when missing or undecryptable). */
export function pageTokenOf(src: MetaSourceDoc): string {
  const blob = src.secret?.pageToken || '';
  return blob ? decryptSecret(blob) : '';
}

const metaOf = (src: SourceDoc): MetaSourceConfig => ({ ...defaultMetaSourceConfig(), ...(src.config?.meta || {}) });

async function setMeta(sourceId: string, set: Partial<MetaSourceConfig>, extra: Record<string, unknown> = {}) {
  const $set: Record<string, unknown> = { ...extra };
  for (const [k, v] of Object.entries(set)) $set['config.meta.' + k] = v;
  await (await sourcesCol()).updateOne({ _id: sourceId, type: 'meta' }, { $set });
}

/* --------------------------------- status -------------------------------- */

export const oauthRedirectUri = () => `${appUrl()}${CALLBACK_PATH}`;

export function statusOf(cfg: MetaConfig): MetaStatus {
  return {
    configured: cfg.configured,
    appId: cfg.appId,
    graphVersion: cfg.graphVersion,
    webhookUrl: `${appUrl()}/api/webhooks/meta`,
    oauthRedirectUri: oauthRedirectUri(),
    source: cfg.source,
  };
}

export async function metaStatus(): Promise<Res<'metaStatus'>> {
  return { ...statusOf(await loadMetaConfig()), connectUrl: CONNECT_PATH };
}

/* ------------------------------- OAuth state ----------------------------- */

// Shared with the Google connect flow (server/core/oauthState.ts); re-exported for existing callers.
import { readCookie, resolveCrmSession, signState, verifyState } from '../core/oauthState';
export { readCookie, resolveCrmSession, signState, verifyState, type OAuthState } from '../core/oauthState';

/* ------------------------------ connect flow ----------------------------- */

/** Settings URL the browser returns to (absolute, on APP_URL). */
export function settingsRedirect(params: Record<string, string>): string {
  const q = new URLSearchParams({ section: 'leadSources', ...params });
  return `${appUrl()}/settings?${q.toString()}`;
}

export interface ConnectStart {
  /** Where to send the browser. */
  redirect: string;
  /** Set as the httpOnly `meta_oauth_nonce` cookie when present. */
  nonce?: string;
}

/** GET /api/integrations/meta/connect — core logic (the route only reads cookies and writes the redirect). */
export async function startMetaConnect(input: { sessionCookie: string; nowMs?: number }): Promise<ConnectStart> {
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  if (!can(sess.user, 'settings.edit')) return { redirect: settingsRedirect({ metaError: 'Only an administrator can connect Facebook Pages.' }) };
  if (!sess.tenant.features.metaLeads) return { redirect: settingsRedirect({ metaError: "Meta (Facebook / Instagram) Lead Ads are not included in your company's plan." }) };
  const cfg = await loadMetaConfig();
  if (!cfg.appId || !cfg.appSecret) return { redirect: settingsRedirect({ metaError: 'Meta Lead Ads is not set up on this platform yet. Ask your platform administrator.' }) };
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S });
  const q = new URLSearchParams({ client_id: cfg.appId, redirect_uri: oauthRedirectUri(), state, response_type: 'code' });
  if (cfg.loginConfigId) q.set('config_id', cfg.loginConfigId);
  else q.set('scope', 'pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval,pages_manage_ads,business_management');
  return { redirect: `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?${q.toString()}`, nonce };
}

/**
 * GET /api/integrations/meta/callback — core logic. Always answers with a redirect to Settings:
 * `metaConnect=<pendingId>` on success, `metaError=<message>` otherwise (never a token in the URL).
 */
export async function finishMetaConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const p = input.params;
  const error = p.get('error') || '';
  if (error) {
    const reason = p.get('error_reason') || '';
    const msg = reason === 'user_denied' || error === 'access_denied' ? 'Facebook login was cancelled.' : truncate(`Facebook login failed: ${p.get('error_description') || error}`, 300);
    return { redirect: settingsRedirect({ metaError: msg }) };
  }
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs);
  if (!v.ok) return { redirect: settingsRedirect({ metaError: 'The Facebook login could not be verified (it expired or was started in another session). Please try again.' }) };
  if (!can(sess.user, 'settings.edit') || !sess.tenant.features.metaLeads) return { redirect: settingsRedirect({ metaError: 'You cannot connect Facebook Pages.' }) };
  const code = p.get('code') || '';
  if (!code) return { redirect: settingsRedirect({ metaError: 'Facebook did not return an authorisation code. Please try again.' }) };
  try {
    const id = await runWithTenant(sess.tenant, async () => {
      const cfg = await requireMetaConfig();
      const short = await exchangeCodeForToken(code, oauthRedirectUri(), cfg);
      const userToken = await longLivedUserToken(short, cfg);
      const pages = (await listPages(userToken, cfg)).filter((pg) => pg.access_token);
      if (!pages.length) throw fail('VALIDATION', 'Facebook returned no Pages. Choose at least one Page in the Facebook dialog (you must be an admin of it).');
      const withForms: PendingPage[] = await mapLimit(pages, 4, async (pg) => {
        let forms: PendingPage['forms'] = [];
        try {
          forms = await listForms(pg.id, pg.access_token, cfg);
        } catch {
          /* best effort: forms can be loaded later (checkMetaSource) */
        }
        return { id: pg.id, name: truncate(pg.name, 200), tasks: pg.tasks.slice(0, 20), token: encryptSecret(pg.access_token), forms: forms.slice(0, 200) };
      });
      const now = new Date(input.nowMs ?? Date.now());
      const doc: MetaConnectionDoc = { _id: 'mc_' + randomToken(12), pages: withForms, createdBy: sess.user.id, createdAt: now, expiresAt: new Date(now.getTime() + PENDING_TTL_MS) };
      await (await connectionsCol()).insertOne(doc);
      return doc._id;
    });
    return { redirect: settingsRedirect({ metaConnect: id }) };
  } catch (e: any) {
    if (!(e instanceof ApiError)) console.error('[meta:callback]', e?.message);
    return { redirect: settingsRedirect({ metaError: truncate(errMsg(e), 300) }) };
  }
}

/* ---------------------------- pending connection ------------------------- */

async function findConnection(pendingId: unknown, ctx: Ctx): Promise<MetaConnectionDoc> {
  const id = String(pendingId ?? '').trim();
  const doc = id && ctx.user ? await (await connectionsCol()).findOne({ _id: id, createdBy: ctx.user.id }) : null;
  if (!doc || new Date(doc.expiresAt).getTime() < Date.now()) throw fail('NOT_FOUND', 'This Facebook login has expired — connect with Facebook again.');
  return doc;
}

export async function getMetaPendingConnection(d: Req<'getMetaPendingConnection'>, ctx: Ctx): Promise<Res<'getMetaPendingConnection'>> {
  const conn = await findConnection(d?.pendingId, ctx);
  const tenant = requireTenant();
  const claims = await (await metaPagesCol()).find({ _id: { $in: conn.pages.map((p) => p.id) } }).toArray();
  const byId = new Map(claims.map((c) => [c._id, c]));
  const pages: MetaPendingPage[] = conn.pages.map((p) => {
    const c = byId.get(p.id);
    return {
      id: p.id,
      name: p.name,
      canReadLeads: p.tasks.some((t) => LEAD_TASKS.includes(String(t).toUpperCase())),
      claimedElsewhere: !!c && c.companyId !== tenant.id,
      alreadyConnected: !!c && c.companyId === tenant.id,
      forms: p.forms,
    };
  });
  return { pages, expiresAt: new Date(conn.expiresAt).toISOString() };
}

/* ------------------------------- connecting ------------------------------ */

const CONFLICT_MSG = 'This Facebook Page is already connected to another workspace';

export interface ConnectPageInput {
  pageId: string;
  pageName: string;
  pageToken: string;
  forms: Array<{ id: string; name: string; status: string }>;
  formIds: string[];
  config: LeadSourceConfig;
  ctx: Ctx | null;
  cfg: MetaConfig;
}

/**
 * Claim the Page, subscribe the app to its `leadgen` field and create the source (or, when this company already
 * has the Page, refresh its token/forms — used to reconnect after the token expired).
 */
export async function connectPage(input: ConnectPageInput): Promise<{ sourceId: string; reconnected: boolean }> {
  const tenant = requireTenant();
  const claims = await metaPagesCol();
  const formIds = validFormIds(input.formIds);
  if (input.forms.length && formIds.some((f) => !input.forms.some((x) => x.id === f))) throw fail('VALIDATION', 'A chosen lead form does not belong to this Page');
  const existing = await claims.findOne({ _id: input.pageId });
  if (existing && existing.companyId !== tenant.id) throw fail('CONFLICT', CONFLICT_MSG);
  const now = new Date();
  const metaBase = { pageId: input.pageId, pageName: truncate(input.pageName, 200), forms: input.forms.slice(0, 200), connectedBy: actorName(input.ctx), connectedAt: now.toISOString() };

  const current = existing ? await (await metaSources()).findOne({ _id: existing.sourceId, type: 'meta' }) : null;
  if (current) {
    await subscribePage(input.pageId, input.pageToken, input.cfg);
    await setMeta(current._id, { ...metaBase, ...(formIds.length ? { formIds } : {}), subscribed: true, lastError: '' }, { 'secret.pageToken': encryptSecret(input.pageToken), updatedAt: now });
    return { sourceId: current._id, reconnected: true };
  }

  const sourceId = await nextSeq('SRC', 4);
  if (existing) await claims.updateOne({ _id: input.pageId, companyId: tenant.id }, { $set: { sourceId, claimedAt: now } }); // stale claim of ours
  else {
    try {
      await claims.updateOne({ _id: input.pageId }, { $setOnInsert: { companyId: tenant.id, sourceId, claimedAt: now } }, { upsert: true });
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
    }
    const c = await claims.findOne({ _id: input.pageId });
    if (!c || c.companyId !== tenant.id) throw fail('CONFLICT', CONFLICT_MSG);
    if (c.sourceId !== sourceId) throw fail('CONFLICT', 'This Page is being connected right now. Try again in a minute.');
  }
  const release = () => claims.deleteOne({ _id: input.pageId, companyId: tenant.id, sourceId });
  try {
    await subscribePage(input.pageId, input.pageToken, input.cfg);
  } catch (e) {
    await release();
    throw e;
  }
  const doc: MetaSourceDoc = {
    _id: sourceId,
    type: 'meta',
    name: truncate(`Facebook: ${input.pageName || input.pageId}`, 80),
    status: 'Active',
    keyPrefix: '',
    config: { ...input.config, meta: { ...defaultMetaSourceConfig(), ...metaBase, formIds, subscribed: true } },
    stats: { received: 0, created: 0, duplicates: 0, rejected: 0, failed: 0, lastReceivedAt: null, lastError: '' },
    createdAt: now,
    createdBy: actorName(input.ctx),
    updatedAt: now,
    secret: { pageToken: encryptSecret(input.pageToken) },
  };
  delete doc.config.sheet;
  try {
    await (await metaSources()).insertOne(doc);
  } catch (e) {
    await release();
    throw e;
  }
  return { sourceId, reconnected: false };
}

/** Default config of new meta sources (+ the optional defaults from the connect dialog, validated). */
async function connectConfig(defaults: unknown): Promise<LeadSourceConfig> {
  const base = defaultConfig('meta');
  if (!defaults || typeof defaults !== 'object') return base;
  const d = defaults as Record<string, unknown>;
  const pick: Record<string, unknown> = {};
  for (const k of ['sourceLabel', 'assignment', 'duplicates', 'defaultStage']) if (d[k] !== undefined) pick[k] = d[k];
  return mergeConfig(base, pick);
}

export async function connectMetaPages(d: Req<'connectMetaPages'>, ctx: Ctx): Promise<Res<'connectMetaPages'>> {
  const conn = await findConnection(d?.pendingId, ctx);
  if (!Array.isArray(d?.pages) || !d.pages.length) throw fail('VALIDATION', 'Choose at least one Page');
  if (d.pages.length > 50) throw fail('VALIDATION', 'At most 50 Pages at once');
  const config = await connectConfig(d?.defaults);
  const cfg = await requireMetaConfig();
  const created: string[] = [];
  const skipped: Array<{ pageId: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const req of d.pages) {
    const pageId = String(req?.pageId ?? '').trim();
    if (!pageId || seen.has(pageId)) continue;
    seen.add(pageId);
    const p = conn.pages.find((x) => x.id === pageId);
    if (!p) {
      skipped.push({ pageId, reason: 'This Page was not part of the Facebook login' });
      continue;
    }
    const token = decryptSecret(p.token);
    if (!token) {
      skipped.push({ pageId, reason: 'The Page token could not be read — connect with Facebook again' });
      continue;
    }
    try {
      const r = await connectPage({ pageId, pageName: p.name, pageToken: token, forms: p.forms, formIds: req?.formIds as string[], config, ctx, cfg });
      created.push(r.sourceId);
      await auditLog(ctx, r.reconnected ? 'Meta Page Reconnected' : 'Lead Source Created', 'Settings', r.sourceId, `Facebook Page ${p.name} (${pageId})`);
    } catch (e: any) {
      if (!(e instanceof ApiError)) await logError('meta:connect', 'INTERNAL', e?.message, e?.stack, actorName(ctx));
      skipped.push({ pageId, reason: errMsg(e) });
    }
  }
  await (await connectionsCol()).deleteOne({ _id: conn._id });
  return { created, skipped };
}

/* ------------------------------ health check ----------------------------- */

export async function findMetaSource(id: unknown): Promise<MetaSourceDoc> {
  const s = await (await metaSources()).findOne({ _id: String(id || '') });
  if (!s) throw fail('NOT_FOUND', 'Lead source not found');
  if (s.type !== 'meta' || !s.config?.meta?.pageId) throw fail('VALIDATION', 'This lead source is not a Facebook Page');
  return s;
}

export async function checkMetaSource(d: Req<'checkMetaSource'>, ctx: Ctx | null): Promise<Res<'checkMetaSource'>> {
  const src = await findMetaSource(d?.sourceId);
  const meta = metaOf(src);
  const token = pageTokenOf(src);
  if (!token) {
    await setMeta(src._id, { lastError: TOKEN_EXPIRED_MSG });
    return { ok: false, message: TOKEN_EXPIRED_MSG, forms: meta.forms, subscribed: meta.subscribed };
  }
  try {
    const cfg = await requireMetaConfig();
    const page = await getPage(meta.pageId, token, cfg);
    const forms = (await listForms(meta.pageId, token, cfg)).slice(0, 200);
    let subscribed = await isPageSubscribed(meta.pageId, token, cfg);
    if (!subscribed) subscribed = await subscribePage(meta.pageId, token, cfg);
    await setMeta(src._id, { pageName: truncate(page.name || meta.pageName, 200), forms, subscribed, lastError: '' });
    const message = `Connected to "${page.name || meta.pageName}" — ${forms.length} lead form${forms.length === 1 ? '' : 's'}; ${subscribed ? 'receiving new leads' : 'NOT subscribed to new leads'}.`;
    if (ctx) await auditLog(ctx, 'Meta Page Checked', 'Settings', src._id, message);
    return { ok: subscribed, message, forms, subscribed };
  } catch (e: any) {
    const message = errMsg(e);
    if (!(e instanceof ApiError)) await logError('meta:check:' + src._id, 'INTERNAL', e?.message, e?.stack, src.name);
    await setMeta(src._id, { lastError: truncate(message, 300) });
    return { ok: false, message, forms: meta.forms, subscribed: meta.subscribed };
  }
}

/* ------------------------------- lead mapping ---------------------------- */

const STANDARD = new Set(['full_name', 'first_name', 'last_name', 'phone_number', 'email']);
const LABELS: Record<string, string> = {
  city: 'City', state: 'State', province: 'Province', country: 'Country', zip_code: 'ZIP code', post_code: 'Post code', street_address: 'Address',
  company_name: 'Company', job_title: 'Job title', work_email: 'Work e-mail', work_phone_number: 'Work phone', date_of_birth: 'Date of birth',
  gender: 'Gender', marital_status: 'Marital status', relationship_status: 'Relationship status', military_status: 'Military status',
};

/** 'what_is_your_budget?' → 'What is your budget?' */
export function questionLabel(key: string): string {
  const s = String(key || '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

const PLATFORM: Record<string, string> = { fb: 'Facebook', facebook: 'Facebook', ig: 'Instagram', instagram: 'Instagram', an: 'Audience Network', msgr: 'Messenger', messenger: 'Messenger', wa: 'WhatsApp' };

/** Graph lead → intake fields (standard contact fields + a `message` with answers and ad details). */
export function mapMetaLead(lead: GraphLead, source: Pick<SourceDoc, 'config'>): Record<string, string> {
  const fieldMap = source.config?.fieldMap || {};
  const mapped = (k: string) => fieldMap[k] !== undefined || fieldMap[normKey(k)] !== undefined;
  const out: Record<string, string> = {};
  const notes: string[] = [];
  let workEmail = '', workPhone = '';
  for (const f of Array.isArray(lead.field_data) ? lead.field_data : []) {
    const name = String(f?.name ?? '').trim();
    const value = (Array.isArray(f?.values) ? f.values : []).map((v) => String(v ?? '').trim()).filter(Boolean).join(', ');
    if (!name || !value) continue;
    const k = name.toLowerCase();
    if (mapped(name)) {
      out[name.replace(/^[_$]+/, '').replace(/\./g, ' ')] = value;
      continue;
    }
    if (STANDARD.has(k)) {
      out[k] = value;
      continue;
    }
    if (k === 'work_email') workEmail = value;
    if (k === 'work_phone_number') workPhone = value;
    notes.push(`${LABELS[k] || questionLabel(name)}: ${truncate(value, 300)}`);
  }
  if (!out.email && workEmail) out.email = workEmail;
  if (!out.phone_number && workPhone) out.phone_number = workPhone;

  const formName = metaOf(source as SourceDoc).forms.find((x) => x.id === lead.form_id)?.name || '';
  const ad: string[] = [];
  if (lead.ad_name || lead.ad_id) ad.push(`Ad: ${lead.ad_name || lead.ad_id}`);
  if (lead.adset_name) ad.push(`Ad set: ${lead.adset_name}`);
  if (lead.campaign_name) ad.push(`Campaign: ${lead.campaign_name}`);
  if (lead.form_id) ad.push(`Form: ${formName ? `${formName} (${lead.form_id})` : lead.form_id}`);
  const plat = String(lead.platform || '').toLowerCase();
  if (plat) ad.push(`Platform: ${PLATFORM[plat] || lead.platform}`);
  if (lead.is_organic) ad.push('Organic lead (not from a paid ad)');
  const message = [...notes, ...ad].join('\n');
  if (message) out.message = message;
  // kept in the intake log only (keys starting with "_" are not mapped)
  out._leadgen_id = String(lead.id || '');
  if (lead.form_id) out._form_id = String(lead.form_id);
  if (lead.ad_id) out._ad_id = String(lead.ad_id);
  if (lead.created_time) out._created_time = String(lead.created_time);
  return out;
}

/** Ingest one Graph lead into a meta source (idempotent by leadgen id). */
export async function ingestMetaLead(src: SourceDoc, lead: GraphLead): Promise<IngestResult> {
  const source: SourceDoc = { ...src, config: toSource(src).config };
  return ingestLead(source, mapMetaLead(lead, source), { origin: 'meta', idempotencyKey: `meta:${lead.id}` });
}

/* --------------------------------- backfill ------------------------------ */

async function withBackfillLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const c = await metaSources();
  const now = new Date();
  const got = await c.findOneAndUpdate(
    { _id: id, $or: [{ backfillLockUntil: { $exists: false } }, { backfillLockUntil: null }, { backfillLockUntil: { $lt: now } }] },
    { $set: { backfillLockUntil: new Date(now.getTime() + LOCK_MS) } }
  );
  if (!got) throw fail('CONFLICT', 'A backfill of this Page is already running. Try again in a minute.');
  try {
    return await fn();
  } finally {
    await c.updateOne({ _id: id }, { $unset: { backfillLockUntil: '' } });
  }
}

/** Pull leads of the last `days` days from the source's forms (all Page forms when none are chosen). */
export async function runBackfill(src: MetaSourceDoc, days: number, nowMs = Date.now()): Promise<Res<'backfillMetaSource'>> {
  return withBackfillLock(src._id, async () => {
    const meta = metaOf(src);
    const tally = { created: 0, duplicates: 0, rejected: 0, failed: 0, replayed: 0 };
    try {
      const token = pageTokenOf(src);
      if (!token) throw fail('VALIDATION', TOKEN_EXPIRED_MSG);
      const cfg = await requireMetaConfig();
      let formIds = meta.formIds;
      if (!formIds.length) {
        const forms = (await listForms(meta.pageId, token, cfg)).slice(0, 200);
        await setMeta(src._id, { forms });
        formIds = forms.map((f) => f.id);
        src = { ...src, config: { ...src.config, meta: { ...meta, forms } } };
      }
      const since = Math.floor(nowMs / 1000) - days * 86400;
      let budget = MAX_BACKFILL_LEADS;
      for (const formId of formIds) {
        if (budget <= 0) break;
        const leads = await listFormLeads(formId, token, since, budget, cfg);
        budget -= leads.length;
        for (const lead of leads) {
          if (!lead?.id) continue;
          const r = await ingestMetaLead(src, { ...lead, form_id: lead.form_id || formId });
          if (r.replay) tally.replayed++;
          else if (r.status === 'created') tally.created++;
          else if (r.status === 'duplicate') tally.duplicates++;
          else if (r.status === 'rejected') tally.rejected++;
          else tally.failed++;
        }
      }
      const parts = [
        tally.created ? `${tally.created} new` : '',
        tally.duplicates ? `${tally.duplicates} duplicate${tally.duplicates === 1 ? '' : 's'}` : '',
        tally.rejected ? `${tally.rejected} rejected` : '',
        tally.failed ? `${tally.failed} failed` : '',
        tally.replayed ? `${tally.replayed} already imported` : '',
      ].filter(Boolean);
      let message = parts.length ? parts.join(', ') : `No leads in the last ${days} day${days === 1 ? '' : 's'}`;
      if (budget <= 0) message += ` (stopped at ${MAX_BACKFILL_LEADS} leads — run it again to continue)`;
      await setMeta(src._id, { lastBackfillAt: new Date(nowMs).toISOString(), lastError: '', ...(tally.created ? { lastLeadAt: new Date(nowMs).toISOString() } : {}) });
      const { replayed: _r, ...counts } = tally;
      return { ...counts, message };
    } catch (e: any) {
      const message = errMsg(e);
      if (!(e instanceof ApiError)) await logError('meta:backfill:' + src._id, 'INTERNAL', e?.message, e?.stack, src.name);
      await setMeta(src._id, { lastBackfillAt: new Date(nowMs).toISOString(), lastError: truncate(message, 300) });
      throw e;
    }
  });
}

export async function backfillMetaSource(d: Req<'backfillMetaSource'>, ctx: Ctx | null): Promise<Res<'backfillMetaSource'>> {
  const src = await findMetaSource(d?.sourceId);
  const raw = d?.days === undefined || d?.days === null ? 7 : Number(d.days);
  if (!Number.isInteger(raw) || raw < 1 || raw > 30) throw fail('VALIDATION', 'days must be a whole number from 1 to 30');
  const r = await runBackfill(src, raw);
  if (ctx) await auditLog(ctx, 'Meta Leads Backfilled', 'Settings', src._id, `${src.name}: ${r.message}`);
  return r;
}

/* -------------------------------- disconnect ----------------------------- */

/** Unsubscribe (best effort), release the Page claim, delete the token and the source. */
export async function disconnectMetaSourceDoc(src: MetaSourceDoc, ctx: Ctx | null): Promise<void> {
  const tenant = requireTenant();
  const meta = metaOf(src);
  const token = pageTokenOf(src);
  let note = '';
  // one Page belongs to one source of one company (claim), so nobody else needs the subscription
  if (token && meta.pageId) {
    try {
      await unsubscribePage(meta.pageId, token);
    } catch (e: any) {
      note = `; unsubscribe failed: ${errMsg(e)}`;
    }
  }
  if (meta.pageId) await (await metaPagesCol()).deleteOne({ _id: meta.pageId, companyId: tenant.id, sourceId: src._id });
  await (await sourcesCol()).deleteOne({ _id: src._id });
  await auditLog(ctx, 'Lead Source Deleted', 'Settings', src._id, truncate(`${src.name} (meta, Page ${meta.pageId})${note}`, 500));
}

export async function disconnectMetaSource(d: Req<'disconnectMetaSource'>, ctx: Ctx | null): Promise<Res<'disconnectMetaSource'>> {
  await disconnectMetaSourceDoc(await findMetaSource(d?.sourceId), ctx);
  return { ok: true };
}

/** Company deletion: unsubscribe every connected Page (best effort). Claims are removed by the caller. */
export async function unsubscribeAllPages(): Promise<number> {
  let n = 0;
  const rows = await (await metaSources()).find({ type: 'meta' }).toArray();
  for (const s of rows) {
    const token = pageTokenOf(s);
    const pageId = s.config?.meta?.pageId;
    if (!token || !pageId) continue;
    try {
      await unsubscribePage(pageId, token);
      n++;
    } catch {
      /* best effort */
    }
  }
  return n;
}

/* --------------------------------- actions ------------------------------- */

export const actions: ActionMap = {
  metaStatus: { fn: () => metaStatus(), perm: 'settings.view' },
  getMetaPendingConnection: { fn: (d, ctx) => getMetaPendingConnection(d, ctx), perm: 'settings.edit' },
  connectMetaPages: { fn: (d, ctx) => connectMetaPages(d, ctx), perm: 'settings.edit' },
  checkMetaSource: { fn: (d, ctx) => checkMetaSource(d, ctx), perm: 'settings.edit' },
  backfillMetaSource: { fn: (d, ctx) => backfillMetaSource(d, ctx), perm: 'settings.edit' },
  disconnectMetaSource: { fn: (d, ctx) => disconnectMetaSource(d, ctx), perm: 'settings.edit' },
};
