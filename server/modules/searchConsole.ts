/**
 * Search Console (plan feature searchConsole, off by default; screen /searchconsole): Google search clicks, impressions, CTR
 * and position of the company's website, its sitemaps, and which of its pages Google has indexed.
 *
 * Connect  = its own step, asking only for webmasters.readonly, so the verified "Connect with Google" of Settings › Google
 *            is not changed. Returns to the shared /api/integrations/google/callback, told apart by the signed state.
 *            Doc `searchConsole` in `integrations`: { connectionId, email, sites, siteUrl }.
 * Figures  = POST webmasters/v3/sites/<site>/searchAnalytics/query. Kept 15 minutes. Recent days are not final, so the
 *            ranges end 2 days ago, and Google hides some rare searches for privacy.
 * Indexing = Google has no count of indexed pages in its API, so the pages of the sitemaps (else the pages with search
 *            impressions) are checked one by one with urlInspection (verdict PASS = valid) and kept in `searchConsolePages`.
 *            Google allows 2000 checks a day per site; "Check pages" does a batch and carries on from there at the next click.
 * Sitemaps are fetched from the website itself: only from the verified site's own public address.
 */
import dns from 'dns/promises';
import net from 'net';
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { resolveCrmSession, signState, stateSignedFor, verifyState } from '../core/oauthState';
import { appUrl } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { randomToken, truncate } from '../core/utils';
import { fetchWithRetry, GOOGLE_TOKEN_URL, loadOAuthClient } from '../integrations/google';
import { googleConnectionsCol, googleRedirectUri, oauthAccessToken, resetGoogleOAuthTokenCache, upsertGoogleConnection } from './googleConnect';
import { connectionUsage } from './sheets';

export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GSC_CONNECT_PATH = '/api/integrations/google/search-console/connect';
export const GSC_PURPOSE = 'googleSearchConsole';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/webmasters/v3';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const STATE_TTL_S = 600;
const DAY_MS = 86400000;
const LAG_DAYS = 2;
const CACHE_MS = 15 * 60000;
const ROWS = 250;
const MAX_PAGES = 2000;
const MAX_CHILD_SITEMAPS = 20;
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
const SITEMAPS_MS = 60000;
export const inspectLimits = { perDay: 1900, perRun: 100, parallel: 5, runMs: 120000 };
const RECHECK_MS = 7 * DAY_MS;
const cache = new Map<string, { at: number; data: SearchPerformance }>();

interface GscDoc { _id: 'searchConsole'; connectionId: string; email: string; scopes: string[]; sites: string[]; siteUrl: string; updatedAt?: Date; updatedBy?: string; setupError?: string; inspected?: { day: string; count: number } }
interface GscPage { _id: string; site: string; url: string; verdict: string; coverage: string; lastCrawl: string; checkedAt: Date | null; error: string }

const docCol = () => col<GscDoc>(CFG.COLL.INTEGRATIONS);
const loadDoc = async () => (await docCol()).findOne({ _id: 'searchConsole' });
const pagesCol = () => col<GscPage>('searchConsolePages');
const redirectTo = (params: Record<string, string>) => `${appUrl()}/settings?${new URLSearchParams({ section: 'google', ...params }).toString()}`;

/* -------------------------------- connect -------------------------------- */

export async function startSearchConsoleConnect(input: { sessionCookie: string; nowMs?: number }): Promise<{ redirect: string; nonce?: string }> {
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  if (!can(sess.user, 'integrations.connect')) return { redirect: redirectTo({ gscError: 'Only an administrator can connect Search Console.' }) };
  if (!(sess.tenant.features as any).searchConsole) return { redirect: redirectTo({ gscError: "Search Console is not included in your company's plan." }) };
  const client = await loadOAuthClient();
  if (!client) return { redirect: redirectTo({ gscError: '"Connect with Google" is not set up on this platform yet (Super admin › Settings › Google).' }) };
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S }, GSC_PURPOSE);
  const q = new URLSearchParams({
    client_id: client.clientId, redirect_uri: googleRedirectUri(), response_type: 'code',
    scope: `openid email ${SEARCH_CONSOLE_SCOPE}`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return { redirect: `${GOOGLE_AUTH_URL}?${q.toString()}`, nonce };
}

export const isSearchConsoleCallback = (params: URLSearchParams) => stateSignedFor(params.get('state') || '', GSC_PURPOSE);

function emailOf(idToken: unknown): string {
  try {
    const p = JSON.parse(Buffer.from(String(idToken || '').split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof p?.email === 'string' ? p.email.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

export async function finishSearchConsoleConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const p = input.params;
  const err = (m: string) => ({ redirect: redirectTo({ gscError: truncate(m, 300) }) });
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  const error = p.get('error') || '';
  if (error) return err(error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${p.get('error_description') || error}`);
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs, GSC_PURPOSE);
  if (!v.ok) return err('The Google sign-in could not be verified (it expired or was started in another session). Please try again.');
  if (!can(sess.user, 'integrations.connect') || !(sess.tenant.features as any).searchConsole) return err('You cannot connect Search Console here.');
  const code = p.get('code') || '';
  if (!code) return err('Google did not return an authorisation code. Please try again.');
  const ctx: Ctx = { user: sess.user, session: null, token: '', userAgent: '', ip: '', action: 'searchConsoleConnect' };
  try {
    await runWithTenant(sess.tenant, async () => {
      const client = await loadOAuthClient();
      if (!client) throw fail('NOT_CONFIGURED', '"Connect with Google" is not set up on this platform yet.');
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: googleRedirectUri() });
      const res = await fetchWithRetry(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j?.access_token) throw fail('VALIDATION', `Google sign-in failed: ${truncate(j?.error_description || j?.error || `HTTP ${res.status}`, 200)}`);
      const refresh = typeof j.refresh_token === 'string' ? j.refresh_token : '';
      if (!refresh) throw fail('VALIDATION', 'Google did not return offline access. Please connect again.');
      const scopes = String(j.scope || '').split(/\s+/).filter(Boolean);
      // never revoked here: the same Google grant can also serve Ads, Analytics or Sheets
      if (!scopes.includes(SEARCH_CONSOLE_SCOPE)) throw fail('VALIDATION', 'Search Console access was not granted. Connect again and tick the permission.');
      const email = emailOf(j.id_token);
      if (!email) throw fail('VALIDATION', 'Google did not return the e-mail of the account. Please try again.');
      const { id } = await upsertGoogleConnection({ email, refreshToken: refresh, scopes, ctx, now: new Date(input.nowMs ?? Date.now()) });
      await (await docCol()).updateOne({ _id: 'searchConsole' }, { $set: { connectionId: id, email, scopes, setupError: '', updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' }, $setOnInsert: { sites: [], siteUrl: '' } }, { upsert: true });
      await auditLog(ctx, 'Search Console Connected', 'Settings', 'searchConsole', email);
      await refreshSites();
    });
    return { redirect: redirectTo({ gscConnected: '1' }) };
  } catch (e: any) {
    if (!(e instanceof ApiError)) console.error('[gsc:callback]', e?.message);
    return err(e instanceof ApiError ? e.message : 'Something went wrong while connecting Search Console. Please try again.');
  }
}

/* --------------------------------- Google --------------------------------- */

async function call<T = any>(url: string, connectionId: string, body?: unknown): Promise<T> {
  const token = await oauthAccessToken(connectionId);
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'VALIDATION' : 'SERVER', truncate(`Search Console: ${j?.error?.message || `answered ${res.status}`}`, 300));
  return j as T;
}

async function refreshSites(): Promise<void> {
  const d = await loadDoc();
  if (!d?.connectionId) return;
  try {
    const j = await call<{ siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> }>(`${API}/sites`, d.connectionId);
    const sites = (j.siteEntry || []).filter((s) => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser').map((s) => String(s.siteUrl)).slice(0, 100);
    const siteUrl = sites.includes(d.siteUrl) ? d.siteUrl : sites.length === 1 ? sites[0] : '';
    await (await docCol()).updateOne({ _id: 'searchConsole' }, { $set: { sites, siteUrl, setupError: sites.length ? '' : 'This Google account has no verified website in Search Console.' } });
  } catch (e: any) {
    await (await docCol()).updateOne({ _id: 'searchConsole' }, { $set: { setupError: truncate(String(e?.message || e), 300) } });
  }
}

export interface SearchConsoleView { connected: boolean; email: string; sites: string[]; siteUrl: string; setupError: string; connectUrl: string }

export async function getSearchConsole(): Promise<SearchConsoleView> {
  const d = await loadDoc();
  return { connected: !!d?.connectionId, email: d?.email || '', sites: d?.sites || [], siteUrl: d?.siteUrl || '', setupError: d?.setupError || '', connectUrl: GSC_CONNECT_PATH };
}

export async function saveSearchConsole(d: any, ctx: Ctx): Promise<SearchConsoleView> {
  const doc = await loadDoc();
  const siteUrl = String(d?.siteUrl || '');
  if (!doc?.connectionId) throw fail('VALIDATION', 'Connect Search Console first.');
  if (siteUrl && !doc.sites.includes(siteUrl)) throw fail('VALIDATION', 'Choose one of the websites of this Google account.');
  await (await docCol()).updateOne({ _id: 'searchConsole' }, { $set: { siteUrl, updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' } });
  await auditLog(ctx, 'Search Console Website Chosen', 'Settings', 'searchConsole', siteUrl);
  clearSearchConsoleCache();
  return getSearchConsole();
}

/** Removes the stored access too, unless Ads, Analytics or Sheets here still use this Google account. Not revoked at Google: that would end this account's access for every use and company. */
export async function disconnectSearchConsole(ctx: Ctx): Promise<SearchConsoleView> {
  const doc = await loadDoc();
  await (await docCol()).deleteOne({ _id: 'searchConsole' });
  if (doc?.connectionId) {
    const marketing = await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'google', connectionId: doc.connectionId } as any);
    const sheets = await connectionUsage(doc.connectionId);
    if (!marketing && !sheets.imports.length && !sheets.exports.length) {
      await (await googleConnectionsCol()).deleteOne({ _id: doc.connectionId });
      resetGoogleOAuthTokenCache();
    }
  }
  await (await pagesCol()).deleteMany({});
  await auditLog(ctx, 'Search Console Disconnected', 'Settings', 'searchConsole', '');
  clearSearchConsoleCache();
  return getSearchConsole();
}

/* -------------------------------- performance ------------------------------ */

export interface SearchRow { name: string; clicks: number; impressions: number; ctr: number; position: number }
export interface SearchPerformance {
  error: string; siteUrl: string; from: string; to: string; prevFrom: string; prevTo: string;
  totals: SearchRow | null; prevTotals: SearchRow | null;
  daily: Array<{ day: string; prevDay: string; values: Record<string, number>; prev: Record<string, number> | null }>;
  queries: SearchRow[]; pages: SearchRow[]; countries: SearchRow[]; devices: SearchRow[];
  sitemaps: Array<{ path: string; lastSubmitted: string; lastDownloaded: string; errors: number; warnings: number; submitted: number; pending: boolean }>;
  sitemapsError: string; fetchedAt: string;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last whole days with final figures, and the same number before them. */
export function searchRange(d: any, now = new Date()): { from: string; to: string; prevFrom: string; prevTo: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let from: string;
  let to: string;
  if (d?.from || d?.to) {
    from = String(d?.from || '');
    to = String(d?.to || '');
    if (!re.test(from) || !re.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) throw fail('VALIDATION', 'Choose a start date on or before the end date.');
  } else {
    const days = ({ last7: 7, last28: 28, last90: 90, last180: 180, last365: 365 } as Record<string, number>)[String(d?.preset || 'last28')];
    if (!days) throw fail('VALIDATION', 'Choose a date range.');
    const end = now.getTime() - LAG_DAYS * DAY_MS;
    to = ymd(end);
    from = ymd(end - (days - 1) * DAY_MS);
  }
  const length = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  const prevTo = ymd(Date.parse(from) - DAY_MS);
  return { from, to, prevTo, prevFrom: ymd(Date.parse(prevTo) - (length - 1) * DAY_MS) };
}

const rowOf = (r: any): SearchRow => ({ name: String(r?.keys?.[0] ?? ''), clicks: Number(r?.clicks) || 0, impressions: Number(r?.impressions) || 0, ctr: Number(r?.ctr) || 0, position: Number(r?.position) || 0 });

export async function getSearchPerformance(d: any = {}, now = new Date()): Promise<SearchPerformance> {
  const range = searchRange(d, now);
  const doc = await loadDoc();
  const empty: SearchPerformance = { error: '', siteUrl: doc?.siteUrl || '', ...range, totals: null, prevTotals: null, daily: [], queries: [], pages: [], countries: [], devices: [], sitemaps: [], sitemapsError: '', fetchedAt: now.toISOString() };
  if (!doc?.connectionId) return { ...empty, error: 'Connect Search Console in Settings › Google.' };
  if (!doc.siteUrl) return { ...empty, error: 'Choose your website in Settings › Google.' };
  const key = `${currentTenant()?.id || ''}:${doc.siteUrl}:${range.from}:${range.to}`;
  const hit = cache.get(key);
  if (!d?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const site = encodeURIComponent(doc.siteUrl);
  const query = (startDate: string, endDate: string, dimensions: string[], rowLimit = ROWS) => call<{ rows?: any[] }>(`${API}/sites/${site}/searchAnalytics/query`, doc.connectionId, { startDate, endDate, dimensions, rowLimit, type: 'web' });
  try {
    const [total, prevTotal, days, prevDays, queries, pages, countries, devices] = await Promise.all([
      query(range.from, range.to, []),
      query(range.prevFrom, range.prevTo, []).catch(() => null),
      query(range.from, range.to, ['date'], 1000),
      query(range.prevFrom, range.prevTo, ['date'], 1000).catch(() => null),
      query(range.from, range.to, ['query']),
      query(range.from, range.to, ['page']),
      query(range.from, range.to, ['country']),
      query(range.from, range.to, ['device']),
    ]);
    const map = (rows: any[] | undefined) => new Map((rows || []).map((r) => [String(r.keys?.[0]), rowOf(r)]));
    const nowDays = map(days?.rows);
    const before = prevDays ? map(prevDays.rows) : null;
    const values = (r?: SearchRow) => ({ clicks: r?.clicks || 0, impressions: r?.impressions || 0, ctr: r?.ctr || 0, position: r?.position || 0 });
    const length = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY_MS) + 1;
    const daily = Array.from({ length }, (_, i) => {
      const day = ymd(Date.parse(range.from) + i * DAY_MS);
      const prevDay = ymd(Date.parse(range.prevFrom) + i * DAY_MS);
      return { day, prevDay, values: values(nowDays.get(day)), prev: before ? values(before.get(prevDay)) : null };
    });
    let sitemaps: SearchPerformance['sitemaps'] = [];
    let sitemapsError = '';
    try {
      const s = await call<{ sitemap?: any[] }>(`${API}/sites/${site}/sitemaps`, doc.connectionId);
      sitemaps = (s.sitemap || []).map((x) => ({
        path: String(x.path || ''), lastSubmitted: String(x.lastSubmitted || ''), lastDownloaded: String(x.lastDownloaded || ''), errors: Number(x.errors) || 0, warnings: Number(x.warnings) || 0,
        submitted: (x.contents || []).reduce((t: number, c: any) => t + (Number(c?.submitted) || 0), 0), pending: !!x.isPending,
      }));
    } catch (e: any) {
      sitemapsError = truncate(String(e?.message || e), 240);
    }
    const data: SearchPerformance = {
      ...empty,
      totals: total?.rows?.[0] ? rowOf(total.rows[0]) : { name: '', clicks: 0, impressions: 0, ctr: 0, position: 0 },
      prevTotals: prevTotal ? (prevTotal.rows?.[0] ? rowOf(prevTotal.rows[0]) : { name: '', clicks: 0, impressions: 0, ctr: 0, position: 0 }) : null,
      daily, queries: (queries.rows || []).map(rowOf), pages: (pages.rows || []).map(rowOf), countries: (countries.rows || []).map(rowOf), devices: (devices.rows || []).map(rowOf), sitemaps, sitemapsError,
    };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e: any) {
    const msg = String(e?.message || e);
    return { ...empty, error: /insufficient|scope|permission/i.test(msg) ? `${truncate(msg, 240)} Connect Search Console again, and check this Google account can see the website.` : truncate(msg, 300) };
  }
}

export function clearSearchConsoleCache() {
  cache.clear();
}

/* --------------------------------- indexing -------------------------------- */

/** Only addresses of the verified site itself: a domain property covers its subdomains, a URL property its own host. */
export function belongsToSite(url: string, siteUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
    return u.hostname === domain || u.hostname.endsWith(`.${domain}`);
  }
  try {
    const s = new URL(siteUrl);
    return u.hostname === s.hostname && u.pathname.startsWith(s.pathname);
  } catch {
    return false;
  }
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:');
}

/** The sitemap, from the site's public address only; no redirects, a size limit. */
async function fetchSitemap(url: string, siteUrl: string): Promise<string> {
  if (!belongsToSite(url, siteUrl)) throw new Error('not on this website');
  const host = new URL(url).hostname;
  if (net.isIP(host)) throw new Error('not a public address');
  const found = await dns.lookup(host, { all: true });
  if (!found.length || found.some((a) => isPrivateAddress(a.address))) throw new Error('not a public address');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/xml,text/xml' } });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > MAX_SITEMAP_BYTES) throw new Error('too large');
  const text = await res.text();
  if (text.length > MAX_SITEMAP_BYTES) throw new Error('too large');
  return text;
}

const decodeXml = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
export const locsOf = (xml: string) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));

/** Pages to check: the sitemaps' pages (one level of sitemap index), else those with search impressions. */
async function pagesToCheck(doc: GscDoc): Promise<{ urls: string[]; note: string; source: 'sitemap' | 'search' }> {
  const site = encodeURIComponent(doc.siteUrl);
  const urls = new Set<string>();
  let note = '';
  try {
    const list = await call<{ sitemap?: any[] }>(`${API}/sites/${site}/sitemaps`, doc.connectionId);
    const queue = (list.sitemap || []).map((x) => String(x.path || '')).filter(Boolean);
    let opened = 0;
    const until = Date.now() + SITEMAPS_MS;
    while (queue.length && opened < MAX_CHILD_SITEMAPS && urls.size < MAX_PAGES && Date.now() < until) {
      const path = queue.shift() as string;
      opened += 1;
      if (/\.gz($|\?)/i.test(path)) { note = 'Compressed sitemaps (.gz) were skipped.'; continue; }
      try {
        const xml = await fetchSitemap(path, doc.siteUrl);
        const locs = locsOf(xml);
        if (/<sitemapindex/i.test(xml)) queue.push(...locs);
        else locs.filter((u) => belongsToSite(u, doc.siteUrl)).slice(0, MAX_PAGES - urls.size).forEach((u) => urls.add(u));
      } catch (e: any) {
        note = `The sitemap ${truncate(path, 120)} could not be read: ${truncate(String(e?.message || e), 120)}.`;
      }
    }
  } catch (e: any) {
    note = truncate(String(e?.message || e), 240);
  }
  if (urls.size) return { urls: [...urls], note, source: 'sitemap' };
  const now = Date.now();
  const r = await call<{ rows?: any[] }>(`${API}/sites/${site}/searchAnalytics/query`, doc.connectionId, { startDate: ymd(now - 92 * DAY_MS), endDate: ymd(now - LAG_DAYS * DAY_MS), dimensions: ['page'], rowLimit: MAX_PAGES, type: 'web' });
  return { urls: (r.rows || []).map((x) => String(x.keys?.[0] || '')).filter((u) => belongsToSite(u, doc.siteUrl)), note: [note, 'No sitemap could be read, so only pages already seen in Google search are listed.'].filter(Boolean).join(' '), source: 'search' };
}

export interface IndexingSummary {
  total: number; checked: number; indexed: number; notIndexed: number; unchecked: number; failed: number; lastChecked: string;
  reasons: Array<{ reason: string; pages: number }>;
  rows: Array<{ url: string; verdict: string; coverage: string; lastCrawl: string; checkedAt: string; error: string }>;
  usedToday: number; dailyLimit: number;
}

export async function getIndexing(now = new Date()): Promise<IndexingSummary> {
  const doc = await loadDoc();
  const all = doc?.siteUrl ? await (await pagesCol()).find({ site: doc.siteUrl }).toArray() : [];
  const checked = all.filter((p) => p.checkedAt && !p.error);
  const indexed = checked.filter((p) => p.verdict === 'PASS');
  const reasons = new Map<string, number>();
  for (const p of checked) if (p.verdict !== 'PASS') reasons.set(p.coverage || 'Reason not given', (reasons.get(p.coverage || 'Reason not given') || 0) + 1);
  const latest = checked.reduce((m, p) => Math.max(m, p.checkedAt!.getTime()), 0);
  const rank = (p: GscPage) => (p.error ? 0 : !p.checkedAt ? 2 : p.verdict === 'PASS' ? 3 : 1);
  return {
    total: all.length, checked: checked.length, indexed: indexed.length, notIndexed: checked.length - indexed.length, unchecked: all.filter((p) => !p.checkedAt && !p.error).length, failed: all.filter((p) => p.error).length,
    lastChecked: latest ? new Date(latest).toISOString() : '',
    reasons: [...reasons.entries()].map(([reason, pages]) => ({ reason, pages })).sort((a, b) => b.pages - a.pages),
    rows: [...all].sort((a, b) => rank(a) - rank(b) || a.url.localeCompare(b.url)).slice(0, 500).map((p) => ({ url: p.url, verdict: p.verdict, coverage: p.coverage, lastCrawl: p.lastCrawl, checkedAt: p.checkedAt ? p.checkedAt.toISOString() : '', error: p.error })),
    usedToday: doc?.inspected?.day === ymd(now.getTime()) ? doc.inspected.count : 0, dailyLimit: inspectLimits.perDay,
  };
}

/** One batch of page checks: pages not checked yet, then the oldest, within Google's daily limit. */
export async function checkIndexing(_d: any, ctx: Ctx, now = new Date()): Promise<IndexingSummary & { justChecked: number; note: string; more: boolean }> {
  const doc = await loadDoc();
  if (!doc?.connectionId) throw fail('VALIDATION', 'Connect Search Console in Settings › Google.');
  if (!doc.siteUrl) throw fail('VALIDATION', 'Choose your website in Settings › Google.');
  const c = await pagesCol();
  const found = await pagesToCheck(doc);
  if (found.urls.length) {
    await c.bulkWrite(found.urls.map((url) => ({ updateOne: { filter: { _id: `${doc.siteUrl}|${url}` }, update: { $setOnInsert: { site: doc.siteUrl, url, verdict: '', coverage: '', lastCrawl: '', checkedAt: null, error: '' } }, upsert: true } })), { ordered: false });
    // only when the list was read properly: a sitemap failing for a moment must not lose the results
    if (found.source === 'sitemap') await c.deleteMany({ site: doc.siteUrl, url: { $nin: found.urls } });
  }
  const today = ymd(now.getTime());
  let used = doc.inspected?.day === today ? doc.inspected.count : 0;
  const room = Math.min(inspectLimits.perRun, inspectLimits.perDay - used);
  const stale = new Date(now.getTime() - RECHECK_MS);
  const due = room > 0 ? await c.find({ site: doc.siteUrl, $or: [{ checkedAt: null }, { checkedAt: { $lt: stale } }, { error: { $ne: '' } }] }).sort({ checkedAt: 1 }).limit(room).toArray() : [];
  const until = Date.now() + inspectLimits.runMs;
  let done = 0;
  let stopped = '';
  for (let i = 0; i < due.length && !stopped && Date.now() < until; i += inspectLimits.parallel) {
    await Promise.all(due.slice(i, i + inspectLimits.parallel).map(async (p) => {
      try {
        const j = await call<any>(INSPECT_URL, doc.connectionId, { inspectionUrl: p.url, siteUrl: doc.siteUrl });
        const r = j?.inspectionResult?.indexStatusResult || {};
        await c.updateOne({ _id: p._id }, { $set: { verdict: String(r.verdict || ''), coverage: truncate(String(r.coverageState || ''), 160), lastCrawl: String(r.lastCrawlTime || ''), checkedAt: now, error: '' } });
        done += 1;
      } catch (e: any) {
        const msg = truncate(String(e?.message || e), 240);
        await c.updateOne({ _id: p._id }, { $set: { error: msg } });
        stopped = stopped || msg;
      }
    }));
  }
  used += done;
  await (await docCol()).updateOne({ _id: 'searchConsole' }, { $set: { inspected: { day: today, count: used } } });
  await auditLog(ctx, 'Search Console Pages Checked', 'Settings', 'searchConsole', `${done} checked`);
  const summary = await getIndexing(now);
  const remaining = await c.countDocuments({ site: doc.siteUrl, $or: [{ checkedAt: null }, { checkedAt: { $lt: stale } }] });
  const limitNote = room <= 0 ? "Today's check limit is used up. Try again tomorrow." : '';
  return { ...summary, justChecked: done, note: [stopped && `Google said: ${stopped}`, limitNote, found.note].filter(Boolean).join(' '), more: remaining > 0 && room > 0 && !stopped };
}

const feature = () => {
  if (!(currentTenant()?.features as any)?.searchConsole) throw fail('FORBIDDEN', "Search Console is not included in your company's plan.");
};

export const actions: ActionMap = {
  getSearchConsole: { fn: () => { feature(); return getSearchConsole(); }, perm: 'integrations.connect' },
  saveSearchConsole: { fn: (d, ctx) => { feature(); return saveSearchConsole(d, ctx); }, perm: 'integrations.connect' },
  refreshSearchConsole: { fn: async () => { feature(); await refreshSites(); return getSearchConsole(); }, perm: 'integrations.connect' },
  disconnectSearchConsole: { fn: (_d, ctx) => { feature(); return disconnectSearchConsole(ctx); }, perm: 'integrations.connect' },
  getSearchPerformance: { fn: (d) => { feature(); return getSearchPerformance(d); }, perm: 'reports.view' },
  getSearchIndexing: { fn: () => { feature(); return getIndexing(); }, perm: 'reports.view' },
  checkSearchIndexing: { fn: (d, ctx) => { feature(); return checkIndexing(d, ctx); }, perm: 'marketing.manage' },
};
