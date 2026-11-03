/**
 * Google for marketing (Settings › Google): one "Connect with Google" for Google Ads and Google Business Profile,
 * plus the company's GA4 Measurement Protocol keys.
 *
 * Connect  = GET /api/integrations/google/marketing/connect → Google consent (scopes adwords + business.manage,
 *            offline) → the shared /api/integrations/google/callback (told apart by the state's signing purpose
 *            'googleMkt') → the refresh token is stored as a company Google connection (googleConnect.ts, which
 *            refreshes access tokens) and its id kept in `integrations` { _id: 'google' }.
 * Google Ads = REST (googleads.googleapis.com/<version>) with the platform developer token (Super admin › Settings ›
 *            Marketing apps). The connected Google account must have access to the company's ad account; when it
 *            reaches it through the platform's manager account the call is retried with login-customer-id.
 *   - lead results: uploadClickConversions to the conversion action chosen per event (gclid when the lead has one,
 *     and the hashed e-mail / phone for enhanced conversions for leads);
 *   - spend: campaign cost per month (this and last month) into the campaign spend of Sales MIS (source 'google');
 *     campaign names are kept so Google lead form leads show the campaign's name.
 * GA4      = Measurement Protocol (measurement id + API secret): one event per lead result, for leads whose website
 *            form sent the visitor's _ga cookie (client id); others are skipped.
 * Business Profile = accounts / locations (v1) and reviews / local posts (v4), used by the social inbox and posts.
 * Analytics = with analytics.readonly the GA4 properties the account sees (Admin API) are listed; the chosen one is
 *            read by the Website analytics screen (modules/websiteAnalytics.ts).
 */
import crypto from 'crypto';
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { resolveCrmSession, signState, stateSignedFor, verifyState } from '../core/oauthState';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { randomToken, truncate } from '../core/utils';
import { fetchWithRetry, GOOGLE_TOKEN_URL, loadOAuthClient } from '../integrations/google';
import { listActiveTenants } from '../platform/registry';
import { loadMarketingApps } from '../platform/marketingApps';
import { googleConnectionsCol, googleRedirectUri, oauthAccessToken, revokeGoogleToken, upsertGoogleConnection } from './googleConnect';
import { inboundCol } from './intake';
import { replaceSpend } from './salesOps';

export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const GMKT_CONNECT_PATH = '/api/integrations/google/marketing/connect';
export const GMKT_PURPOSE = 'googleMkt';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_TTL_S = 600;
const IST_MS = 330 * 60000;

export interface GoogleAdsCustomer { id: string; name: string; currency: string; manager: boolean }
export interface GbpLocation { name: string; title: string; account: string }

interface GoogleMktDoc {
  _id: 'google';
  connectionId: string;
  email: string;
  scopes: string[];
  adsCustomers?: GoogleAdsCustomer[];
  adsCustomerId?: string;
  adsLoginCustomerId?: string;
  adsConversions?: { enabled: boolean; actions: Record<string, string> };
  ga4?: { enabled: boolean; measurementId: string; apiSecret: string };
  gbpLocations?: GbpLocation[];
  gbpLocation?: GbpLocation | null;
  ga4Properties?: Array<{ id: string; name: string }>;
  ga4PropertyId?: string;
  campaignNames?: Record<string, string>;
  spendSyncedAt?: Date | null;
  spendError?: string;
  spendSummary?: { months: Record<string, number>; currency: string };
  setupError?: string;
  updatedAt?: Date;
  updatedBy?: string;
}

const docCol = () => col<GoogleMktDoc>(CFG.COLL.INTEGRATIONS);
const loadDoc = async () => (await docCol()).findOne({ _id: 'google' });
const by = (ctx: Ctx | null) => ctx?.user?.name || 'System';

export const googleMktRedirect = (params: Record<string, string>) => `${appUrl()}/settings?${new URLSearchParams({ section: 'google', ...params }).toString()}`;

/** Which plan features use this connection. */
export const usesGoogleMarketing = (f: Record<string, boolean>) => !!(f.googleConversions || f.googleAdsSpend || f.socialInbox || f.socialPosts || f.adsControl || f.websiteAnalytics);

/* -------------------------------- connect -------------------------------- */

export async function startGoogleMktConnect(input: { sessionCookie: string; nowMs?: number }): Promise<{ redirect: string; nonce?: string }> {
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  if (!can(sess.user, 'integrations.connect')) return { redirect: googleMktRedirect({ gmktError: 'Only an administrator can connect Google.' }) };
  if (!usesGoogleMarketing(sess.tenant.features as any)) return { redirect: googleMktRedirect({ gmktError: "Google marketing features are not included in your company's plan." }) };
  const client = await loadOAuthClient();
  if (!client) return { redirect: googleMktRedirect({ gmktError: '"Connect with Google" is not set up on this platform yet (Super admin › Settings › Google).' }) };
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S }, GMKT_PURPOSE);
  const q = new URLSearchParams({
    client_id: client.clientId, redirect_uri: googleRedirectUri(), response_type: 'code',
    scope: `openid email ${ADWORDS_SCOPE} ${BUSINESS_SCOPE} ${ANALYTICS_SCOPE}`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return { redirect: `${GOOGLE_AUTH_URL}?${q.toString()}`, nonce };
}

export const isGoogleMktCallback = (params: URLSearchParams) => stateSignedFor(params.get('state') || '', GMKT_PURPOSE);

function emailFromIdToken(idToken: unknown): string {
  try {
    const p = JSON.parse(Buffer.from(String(idToken || '').split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof p?.email === 'string' ? p.email.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

export async function finishGoogleMktConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const p = input.params;
  const err = (m: string) => ({ redirect: googleMktRedirect({ gmktError: truncate(m, 300) }) });
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  const error = p.get('error') || '';
  if (error) return err(error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${p.get('error_description') || error}`);
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs, GMKT_PURPOSE);
  if (!v.ok) return err('The Google sign-in could not be verified (it expired or was started in another session). Please try again.');
  if (!can(sess.user, 'integrations.connect') || !usesGoogleMarketing(sess.tenant.features as any)) return err('You cannot connect Google here.');
  const code = p.get('code') || '';
  if (!code) return err('Google did not return an authorisation code. Please try again.');
  const ctx: Ctx = { user: sess.user, session: null, token: '', userAgent: '', ip: '', action: 'googleMktConnect' };
  try {
    await runWithTenant(sess.tenant, async () => {
      const client = await loadOAuthClient();
      if (!client) throw fail('NOT_CONFIGURED', '"Connect with Google" is not set up on this platform yet.');
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: googleRedirectUri() });
      const res = await fetchWithRetry(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j?.access_token) throw fail('VALIDATION', `Google sign-in failed: ${truncate(j?.error_description || j?.error || `HTTP ${res.status}`, 200)}`);
      const refresh = typeof j.refresh_token === 'string' ? j.refresh_token : '';
      if (!refresh) throw fail('VALIDATION', 'Google did not return offline access. Remove the app at myaccount.google.com/permissions and connect again.');
      const scopes = String(j.scope || '').split(/\s+/).filter(Boolean);
      if (![ADWORDS_SCOPE, BUSINESS_SCOPE, ANALYTICS_SCOPE].some((x) => scopes.includes(x))) {
        await revokeGoogleToken(refresh);
        throw fail('VALIDATION', 'No Google Ads, Business Profile or Analytics access was granted. Connect again and tick the permissions.');
      }
      const email = emailFromIdToken(j.id_token);
      if (!email) throw fail('VALIDATION', 'Google did not return the e-mail of the account. Please try again.');
      const { id } = await upsertGoogleConnection({ email, refreshToken: refresh, scopes, ctx, now: new Date(input.nowMs ?? Date.now()) });
      await (await docCol()).updateOne({ _id: 'google' }, { $set: { connectionId: id, email, scopes, setupError: '', updatedAt: new Date(), updatedBy: by(ctx) } }, { upsert: true });
      await auditLog(ctx, 'Google Marketing Connected', 'Settings', 'google', email);
      await refreshGoogleAssets(); // best effort: ad accounts and Business Profile locations
    });
    return { redirect: googleMktRedirect({ gmktConnected: '1' }) };
  } catch (e: any) {
    if (!(e instanceof ApiError)) console.error('[google-mkt:callback]', e?.message);
    return err(e instanceof ApiError ? e.message : 'Something went wrong while connecting Google. Please try again.');
  }
}

/** Access token of the company's marketing connection (company context). */
async function accessToken(): Promise<string> {
  const d = await loadDoc();
  if (!d?.connectionId) throw fail('VALIDATION', 'Connect with Google first (Settings › Google).');
  return oauthAccessToken(d.connectionId);
}

/* ------------------------------- Google Ads ------------------------------ */

const cid = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** One Google Ads REST call; retried through the platform manager account when access is via the manager. */
export async function adsCall<T = any>(path: string, body?: unknown, opts: { method?: string; loginCustomerId?: string } = {}): Promise<T> {
  const apps = await loadMarketingApps();
  if (!apps.googleAdsDeveloperToken) throw fail('NOT_CONFIGURED', 'The Google Ads developer token is not set on this platform yet (Super admin › Settings › Marketing apps).');
  const token = await accessToken();
  const doc = await loadDoc();
  const login = opts.loginCustomerId ?? doc?.adsLoginCustomerId ?? '';
  const send = async (loginId: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'developer-token': apps.googleAdsDeveloperToken, 'Content-Type': 'application/json' };
    if (loginId) headers['login-customer-id'] = loginId;
    const res = await fetch(`https://googleads.googleapis.com/${apps.googleAdsApiVersion}/${path.replace(/^\/+/, '')}`, {
      method: opts.method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const j: any = await res.json().catch(() => ({}));
    return { res, j };
  };
  let { res, j } = await send(login);
  if (!res.ok && res.status === 403 && !login && apps.googleAdsLoginCustomerId) {
    ({ res, j } = await send(apps.googleAdsLoginCustomerId));
    if (res.ok) await (await docCol()).updateOne({ _id: 'google' }, { $set: { adsLoginCustomerId: apps.googleAdsLoginCustomerId } });
  }
  if (!res.ok) {
    const detail = j?.error?.details?.[0]?.errors?.[0]?.message || j?.error?.message || `Google Ads answered ${res.status}`;
    throw fail(res.status === 401 || res.status === 403 ? 'VALIDATION' : 'SERVER', truncate(`Google Ads: ${detail}`, 300));
  }
  return j as T;
}

/** GAQL search (all pages, at most 20). */
export async function adsSearch(customerId: string, query: string): Promise<any[]> {
  const out: any[] = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const j = await adsCall<{ results?: any[]; nextPageToken?: string }>(`customers/${cid(customerId)}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) });
    out.push(...(j.results || []));
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

async function listAdsCustomers(): Promise<GoogleAdsCustomer[]> {
  const j = await adsCall<{ resourceNames?: string[] }>('customers:listAccessibleCustomers');
  const out: GoogleAdsCustomer[] = [];
  for (const rn of (j.resourceNames || []).slice(0, 30)) {
    const id = cid(rn);
    try {
      const [r] = await adsSearch(id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1');
      out.push({ id, name: String(r?.customer?.descriptiveName || id), currency: String(r?.customer?.currencyCode || ''), manager: !!r?.customer?.manager });
    } catch {
      out.push({ id, name: id, currency: '', manager: false });
    }
  }
  return out;
}

/* ---------------------------- Business Profile --------------------------- */

/** A Google API call with the marketing connection's access token. */
export async function gbpFetch<T = any>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return googleApiFetch<T>(url, init, /analytics/.test(url) ? 'Google Analytics' : 'Google Business Profile');
}

export async function googleApiFetch<T = any>(url: string, init: { method?: string; body?: unknown } = {}, label = 'Google'): Promise<T> {
  const token = await accessToken();
  const res = await fetch(url, {
    method: init.method || (init.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'VALIDATION' : 'SERVER', truncate(`${label}: ${j?.error?.message || `answered ${res.status}`}`, 300));
  return j as T;
}

async function listGbpLocations(): Promise<GbpLocation[]> {
  const acc = await gbpFetch<{ accounts?: Array<{ name: string }> }>('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const out: GbpLocation[] = [];
  for (const a of (acc.accounts || []).slice(0, 10)) {
    const l = await gbpFetch<{ locations?: Array<{ name: string; title?: string }> }>(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title&pageSize=100`);
    for (const x of l.locations || []) out.push({ name: x.name, title: String(x.title || x.name), account: a.name });
  }
  return out;
}

/** The chosen Business Profile location as the v4 path (accounts/1/locations/2), or null. */
export async function gbpLocationPath(): Promise<{ path: string; title: string } | null> {
  const d = await loadDoc();
  const l = d?.gbpLocation;
  if (!l?.name || !l.account) return null;
  return { path: `${l.account}/${l.name}`, title: l.title };
}

/** Ad accounts and Business Profile locations the connection reaches (each best effort). */
export async function refreshGoogleAssets(): Promise<void> {
  const d = await loadDoc();
  if (!d) return;
  const set: Partial<GoogleMktDoc> = {};
  const errs: string[] = [];
  if (d.scopes.includes(ADWORDS_SCOPE)) {
    try {
      set.adsCustomers = await listAdsCustomers();
      const leaf = set.adsCustomers.filter((c) => !c.manager);
      if (!d.adsCustomerId && leaf.length === 1) set.adsCustomerId = leaf[0].id;
    } catch (e: any) { errs.push(e?.message || 'Google Ads accounts could not be read'); }
  }
  if (d.scopes.includes(BUSINESS_SCOPE)) {
    try {
      set.gbpLocations = await listGbpLocations();
      if (!d.gbpLocation && set.gbpLocations.length === 1) set.gbpLocation = set.gbpLocations[0];
    } catch (e: any) {
      // a project without approved Business Profile API access has a quota of 0 requests: say so plainly
      errs.push(/quota/i.test(e?.message || '') ? 'Business Profile access is waiting for Google’s approval (the API access request). Click Refresh accounts after Google approves.' : e?.message || 'Business Profile locations could not be read');
    }
  }
  if (d.scopes.includes(ANALYTICS_SCOPE)) {
    try {
      const j = await googleApiFetch<{ accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property: string; displayName?: string }> }> }>('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', {}, 'Google Analytics');
      set.ga4Properties = (j.accountSummaries || []).flatMap((a) => (a.propertySummaries || []).map((p) => ({ id: p.property.replace(/^properties\//, ''), name: `${p.displayName || p.property}${a.displayName ? ' · ' + a.displayName : ''}` })));
      if (!d.ga4PropertyId && set.ga4Properties.length === 1) set.ga4PropertyId = set.ga4Properties[0].id;
    } catch (e: any) { errs.push(e?.message || 'Google Analytics properties could not be read'); }
  }
  await (await docCol()).updateOne({ _id: 'google' }, { $set: { ...set, setupError: errs.join(' · ').slice(0, 400) } });
}

/* -------------------------- lead results to Google ------------------------ */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** E.164 for Google (+919876501234), '' when unusable. */
export function e164(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = '91' + d;
  return d.length >= 8 && d.length <= 15 ? '+' + d : '';
}
const normEmail = (raw: string) => {
  const e = String(raw || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '';
  const [u, dom] = e.split('@');
  return dom === 'gmail.com' || dom === 'googlemail.com' ? `${u.replace(/\./g, '')}@${dom}` : e;
};

/** gclid / GA client id of a lead, from the intake log (website forms, Google lead forms). */
async function intakeIds(leadId: string): Promise<{ gclid: string; gaClient: string }> {
  const logs = await (await inboundCol()).find({ leadId }, { projection: { payload: 1 } }).sort({ receivedAt: 1 }).limit(5).toArray();
  let gclid = '', ga = '';
  for (const l of logs) {
    const p = (l.payload || {}) as Record<string, string>;
    gclid ||= String(p._gclid || p.gclid || p.GCLID || '').trim();
    ga ||= String(p._ga || p.ga_client_id || p.client_id || '').trim();
  }
  const m = ga.match(/(\d+\.\d+)$/);
  return { gclid: gclid.slice(0, 300), gaClient: m ? m[1] : '' };
}

/** Which Google targets are switched on for this company (conversion actions per event, GA4). */
export async function googleConversionTargets(): Promise<{ ads: Record<string, string> | null; ga4: boolean }> {
  const d = await loadDoc();
  const ads = d?.connectionId && d.adsCustomerId && d.adsConversions?.enabled ? d.adsConversions.actions || {} : null;
  const ga4 = !!(d?.ga4?.enabled && d.ga4.measurementId && d.ga4.apiSecret);
  return { ads: ads && Object.keys(ads).length ? ads : null, ga4 };
}

export interface ConversionSendResult { status: 'sent' | 'failed' | 'skipped'; error?: string; matchedBy?: string }
type LeadLike = Record<string, string>;

const istStamp = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 19).replace('T', ' ') + '+05:30';

export async function sendGoogleAdsConversion(q: { leadId: string; event: string; eventTime: Date }, lead: LeadLike): Promise<ConversionSendResult> {
  const d = await loadDoc();
  const action = d?.adsConversions?.actions?.[q.event];
  if (!d?.adsCustomerId || !action) return { status: 'skipped', error: `No Google Ads conversion action is chosen for "${q.event}".` };
  const { gclid } = await intakeIds(q.leadId);
  const ids: Array<Record<string, string>> = [];
  const em = normEmail(lead[CFG.LEAD.EMAIL]);
  const ph = e164(lead[CFG.LEAD.PHONE]);
  if (em) ids.push({ hashedEmail: sha256(em) });
  if (ph) ids.push({ hashedPhoneNumber: sha256(ph) });
  if (!gclid && !ids.length) return { status: 'skipped', error: 'No Google click id, phone or e-mail to match with.' };
  const conv: Record<string, unknown> = { conversionAction: action, conversionDateTime: istStamp(q.eventTime) };
  if (gclid) conv.gclid = gclid;
  if (ids.length) conv.userIdentifiers = ids;
  const matchedBy = [gclid ? 'Google click' : '', em ? 'e-mail' : '', ph ? 'phone' : ''].filter(Boolean).join(' + ');
  try {
    const j = await adsCall<{ partialFailureError?: { message?: string } }>(`customers/${cid(d.adsCustomerId)}:uploadClickConversions`, { conversions: [conv], partialFailure: true });
    if (j.partialFailureError?.message) return { status: 'failed', error: truncate(`Google Ads: ${j.partialFailureError.message}`, 300), matchedBy };
    return { status: 'sent', matchedBy };
  } catch (e: any) {
    return { status: 'failed', error: truncate(e?.message || String(e), 300), matchedBy };
  }
}

/** GA4 event names: letters, digits and _ (starting with a letter), up to 40. */
export const ga4EventName = (event: string) => (String(event).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'e_$1') || 'lead_result').slice(0, 40);

export async function sendGa4Event(q: { leadId: string; event: string }): Promise<ConversionSendResult> {
  const d = await loadDoc();
  const secret = d?.ga4?.apiSecret ? decryptSecret(d.ga4.apiSecret) : '';
  if (!d?.ga4?.measurementId || !secret) return { status: 'skipped', error: 'Google Analytics is not set up.' };
  const { gaClient } = await intakeIds(q.leadId);
  if (!gaClient) return { status: 'skipped', error: 'No Google Analytics visitor id (the website form did not send the _ga cookie).' };
  try {
    const res = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(d.ga4.measurementId)}&api_secret=${encodeURIComponent(secret)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ client_id: gaClient, events: [{ name: ga4EventName(q.event), params: { event_source: 'crm', crm_event: q.event } }] }),
    });
    return res.ok ? { status: 'sent', matchedBy: 'website visitor' } : { status: 'failed', error: `Google Analytics answered ${res.status}` };
  } catch (e: any) {
    return { status: 'failed', error: truncate(e?.message || String(e), 300) };
  }
}

/* ---------------------------- Google Ads spend ---------------------------- */

export function spendWindowIst(now = new Date()) {
  const today = new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
  const [y, m] = today.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { since: `${prev}-01`, until: today, months: [prev, today.slice(0, 7)] };
}

/** Google lead form leads: "Google Ads campaign <id>" → the campaign's name (when known). */
export async function googleCampaignName(id: string): Promise<string> {
  const d = await loadDoc();
  return d?.campaignNames?.[id] || '';
}

export async function syncGoogleSpend(opts: { now?: Date; actor?: string } = {}): Promise<{ campaigns: number; months: Record<string, number> }> {
  const c = await docCol();
  const d = await loadDoc();
  if (!d?.adsCustomerId) throw fail('VALIDATION', 'Connect with Google and choose the Google Ads account first.');
  const win = spendWindowIst(opts.now);
  try {
    const rows = await adsSearch(d.adsCustomerId, `SELECT campaign.id, campaign.name, segments.month, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${win.since}' AND '${win.until}' AND metrics.cost_micros > 0`);
    const names: Record<string, string> = { ...(d.campaignNames || {}) };
    const sums = new Map<string, { campaign: string; month: string; amount: number }>();
    for (const r of rows) {
      const id = String(r?.campaign?.id || ''), name = String(r?.campaign?.name || '').trim().slice(0, 200);
      const month = String(r?.segments?.month || '').slice(0, 7);
      const amount = Number(r?.metrics?.costMicros || 0) / 1e6;
      if (id && name) names[id] = name;
      if (!name || !win.months.includes(month) || amount <= 0) continue;
      const k = month + '\u0000' + name;
      const cur = sums.get(k);
      if (cur) cur.amount += amount;
      else sums.set(k, { campaign: name, month, amount });
    }
    const out = [...sums.values()];
    await replaceSpend('google', win.months, out, opts.actor || 'Google Ads spend');
    const months = Object.fromEntries(win.months.map((m) => [m, Math.round(out.filter((r) => r.month === m).reduce((t, r) => t + r.amount, 0) * 100) / 100]));
    const currency = d.adsCustomers?.find((x) => x.id === d.adsCustomerId)?.currency || '';
    await c.updateOne({ _id: 'google' }, { $set: { campaignNames: names, spendSyncedAt: opts.now || new Date(), spendError: '', spendSummary: { months, currency } } });
    return { campaigns: out.length, months };
  } catch (e: any) {
    await c.updateOne({ _id: 'google' }, { $set: { spendError: truncate(e?.message || String(e), 300) } });
    throw e;
  }
}

export async function runGoogleSpendCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.googleAdsSpend) continue;
    try {
      out[tenant.slug] = await runWithTenant(tenant, async () => ((await loadDoc())?.adsCustomerId ? syncGoogleSpend({ now }) : { skipped: 'not connected' }));
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

/* -------------------------------- settings -------------------------------- */

export interface GoogleMarketingView {
  available: boolean;
  developerTokenSet: boolean;
  connectUrl: string;
  connected: boolean;
  email: string;
  adsAccess: boolean;
  businessAccess: boolean;
  setupError: string;
  adsCustomers: GoogleAdsCustomer[];
  adsCustomerId: string;
  adsConversions: { enabled: boolean; actions: Record<string, string> };
  ga4: { enabled: boolean; measurementId: string; secretSet: boolean };
  gbpLocations: GbpLocation[];
  gbpLocation: GbpLocation | null;
  analyticsAccess: boolean;
  ga4Properties: Array<{ id: string; name: string }>;
  ga4PropertyId: string;
  spend: { syncedAt: string; error: string; months: Array<{ month: string; total: number }>; currency: string };
}

export async function getGoogleMarketing(): Promise<GoogleMarketingView> {
  const [d, client, apps] = await Promise.all([loadDoc(), loadOAuthClient().catch(() => null), loadMarketingApps()]);
  const conn = d?.connectionId ? await (await googleConnectionsCol()).findOne({ _id: d.connectionId }) : null;
  return {
    available: !!client,
    developerTokenSet: !!apps.googleAdsDeveloperToken,
    connectUrl: GMKT_CONNECT_PATH,
    connected: !!conn && conn.status !== 'Error',
    email: d?.email || '',
    adsAccess: !!d?.scopes?.includes(ADWORDS_SCOPE),
    businessAccess: !!d?.scopes?.includes(BUSINESS_SCOPE),
    setupError: conn?.status === 'Error' ? conn.lastError || 'Google access expired. Connect again.' : d?.setupError || '',
    adsCustomers: d?.adsCustomers || [],
    adsCustomerId: d?.adsCustomerId || '',
    adsConversions: { enabled: !!d?.adsConversions?.enabled, actions: d?.adsConversions?.actions || {} },
    ga4: { enabled: !!d?.ga4?.enabled, measurementId: d?.ga4?.measurementId || '', secretSet: !!d?.ga4?.apiSecret },
    gbpLocations: d?.gbpLocations || [],
    gbpLocation: d?.gbpLocation || null,
    analyticsAccess: !!d?.scopes?.includes(ANALYTICS_SCOPE),
    ga4Properties: d?.ga4Properties || [],
    ga4PropertyId: d?.ga4PropertyId || '',
    spend: {
      syncedAt: d?.spendSyncedAt ? d.spendSyncedAt.toISOString() : '',
      error: d?.spendError || '',
      months: Object.entries(d?.spendSummary?.months || {}).sort(([a], [b]) => b.localeCompare(a)).map(([month, total]) => ({ month, total })),
      currency: d?.spendSummary?.currency || '',
    },
  };
}

export async function saveGoogleMarketing(input: any, ctx: Ctx): Promise<GoogleMarketingView> {
  const c = await docCol();
  const d = await loadDoc();
  const set: Partial<GoogleMktDoc> = {};
  if (input?.adsCustomerId !== undefined) {
    const id = cid(input.adsCustomerId);
    if (id && !(d?.adsCustomers || []).some((x) => x.id === id)) throw fail('VALIDATION', 'Choose one of the Google Ads accounts the connection reaches.');
    set.adsCustomerId = id;
  }
  if (input?.adsConversions !== undefined) {
    const actions: Record<string, string> = {};
    for (const [ev, rn] of Object.entries(input.adsConversions?.actions || {})) {
      const v = String(rn || '').trim();
      if (!v) continue;
      if (!/^customers\/\d+\/conversionActions\/\d+$/.test(v)) throw fail('VALIDATION', `"${ev}": choose a conversion action from the list.`);
      actions[String(ev).slice(0, 40)] = v;
    }
    const enabled = !!input.adsConversions?.enabled;
    if (enabled && (!(set.adsCustomerId ?? d?.adsCustomerId) || !Object.keys(actions).length)) throw fail('VALIDATION', 'Choose the Google Ads account and at least one conversion action before switching this on.');
    set.adsConversions = { enabled, actions };
  }
  if (input?.ga4 !== undefined) {
    const measurementId = String(input.ga4?.measurementId ?? d?.ga4?.measurementId ?? '').trim().toUpperCase();
    if (measurementId && !/^G-[A-Z0-9]{4,15}$/.test(measurementId)) throw fail('VALIDATION', 'The GA4 measurement ID looks like G-ABC123XYZ (Admin › Data streams).');
    const secretIn = String(input.ga4?.apiSecret || '').trim();
    if (secretIn && !/^[A-Za-z0-9_-]{10,64}$/.test(secretIn)) throw fail('VALIDATION', 'That does not look like a Measurement Protocol API secret.');
    const apiSecret = secretIn ? encryptSecret(secretIn) : d?.ga4?.apiSecret || '';
    const enabled = !!input.ga4?.enabled;
    if (enabled && (!measurementId || !apiSecret)) throw fail('VALIDATION', 'Add the measurement ID and the API secret before switching Google Analytics on.');
    set.ga4 = { enabled, measurementId, apiSecret };
  }
  if (input?.gbpLocation !== undefined) {
    const name = String(input.gbpLocation || '');
    const loc = name ? (d?.gbpLocations || []).find((l) => l.name === name) : null;
    if (name && !loc) throw fail('VALIDATION', 'Choose one of the Business Profile locations the connection reaches.');
    set.gbpLocation = loc || null;
  }
  if (input?.ga4PropertyId !== undefined) {
    const id = String(input.ga4PropertyId || '');
    if (id && !(d?.ga4Properties || []).some((p) => p.id === id)) throw fail('VALIDATION', 'Choose one of the Google Analytics properties the connection reaches.');
    set.ga4PropertyId = id;
  }
  if (!Object.keys(set).length) return getGoogleMarketing();
  await c.updateOne({ _id: 'google' }, { $set: { ...set, updatedAt: new Date(), updatedBy: by(ctx) } }, { upsert: true });
  await auditLog(ctx, 'Google Marketing Updated', 'Settings', 'google', Object.keys(set).join(', '));
  return getGoogleMarketing();
}

export async function listGoogleConversionActions(): Promise<Array<{ resourceName: string; name: string; type: string }>> {
  const d = await loadDoc();
  if (!d?.adsCustomerId) throw fail('VALIDATION', 'Choose the Google Ads account first.');
  const rows = await adsSearch(d.adsCustomerId, "SELECT conversion_action.resource_name, conversion_action.name, conversion_action.type FROM conversion_action WHERE conversion_action.status = 'ENABLED'");
  return rows.map((r) => ({ resourceName: String(r?.conversionAction?.resourceName || ''), name: String(r?.conversionAction?.name || ''), type: String(r?.conversionAction?.type || '') })).filter((x) => x.resourceName);
}

export async function disconnectGoogleMarketing(ctx: Ctx): Promise<GoogleMarketingView> {
  await (await docCol()).updateOne({ _id: 'google' }, { $set: { connectionId: '', email: '', scopes: [], adsCustomers: [], gbpLocations: [], adsConversions: { enabled: false, actions: {} }, updatedAt: new Date(), updatedBy: by(ctx) } });
  await auditLog(ctx, 'Google Marketing Disconnected', 'Settings', 'google', '');
  return getGoogleMarketing();
}

/** Validate the GA4 keys with Google's debug endpoint (nothing is recorded). */
export async function testGa4(): Promise<{ ok: boolean; message: string }> {
  const d = await loadDoc();
  const secret = d?.ga4?.apiSecret ? decryptSecret(d.ga4.apiSecret) : '';
  if (!d?.ga4?.measurementId || !secret) throw fail('VALIDATION', 'Save the measurement ID and API secret first.');
  const res = await fetch(`https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(d.ga4.measurementId)}&api_secret=${encodeURIComponent(secret)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ client_id: '123.456', events: [{ name: 'crm_test', params: { event_source: 'crm' } }] }),
  });
  const j: any = await res.json().catch(() => ({}));
  const msgs = (j?.validationMessages || []).map((m: any) => m?.description).filter(Boolean);
  return msgs.length ? { ok: false, message: msgs.join(' ').slice(0, 300) } : { ok: res.ok, message: res.ok ? 'Google Analytics accepted the keys.' : `Google Analytics answered ${res.status}` };
}

const tenantFeatures = () => (currentTenant()?.features || {}) as Record<string, boolean>;

export const actions: ActionMap = {
  getGoogleMarketing: { fn: () => getGoogleMarketing(), perm: 'integrations.connect' },
  saveGoogleMarketing: { fn: (d, ctx) => saveGoogleMarketing(d, ctx), perm: 'integrations.connect' },
  refreshGoogleMarketing: { fn: async () => { await refreshGoogleAssets(); return getGoogleMarketing(); }, perm: 'integrations.connect' },
  listGoogleConversionActions: { fn: () => listGoogleConversionActions(), perm: 'integrations.connect' },
  disconnectGoogleMarketing: { fn: (_d, ctx) => disconnectGoogleMarketing(ctx), perm: 'integrations.connect' },
  testGa4: { fn: () => testGa4(), perm: 'integrations.connect' },
  syncGoogleSpend: { fn: async (_d, ctx) => { if (!tenantFeatures().googleAdsSpend) throw fail('FORBIDDEN', "Ad spend from Google Ads is not included in your company's plan."); await syncGoogleSpend({ actor: ctx.user?.name }); return getGoogleMarketing(); }, perm: 'integrations.connect' },
};
