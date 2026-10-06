/**
 * Google service-account authentication (no googleapis dependency: node:crypto + global fetch).
 *
 * Credential (first found wins):
 *   1. platform storage: PCOLL.PLATFORM_SETTINGS doc { _id: 'google', serviceAccount: <AES-GCM encrypted JSON>,
 *      projectId, clientEmail, updatedAt, updatedBy } — set by the super admin (server/platform/sheets.ts);
 *   2. env GOOGLE_SERVICE_ACCOUNT_JSON (the raw JSON key, or base64 of it).
 *
 * Access tokens: an RS256 JWT (iss = client_email, scope spreadsheets, aud = token endpoint, 1 h) is exchanged
 * at https://oauth2.googleapis.com/token; the token is cached in memory until 5 minutes before it expires.
 * Every Google call has a 20 s timeout and is retried once on 429/5xx (and once with a fresh token on 401).
 * Tokens and private keys are never logged, stored unencrypted or returned by any API.
 *
 * "Connect with Google" (OAuth): the platform OAuth client (Client ID + encrypted Client Secret) lives in the same
 * doc (oauthClientId, oauthClientSecret, oauthUpdatedAt, oauthUpdatedBy); env fallback GOOGLE_OAUTH_CLIENT_ID /
 * GOOGLE_OAUTH_CLIENT_SECRET (a stored client wins). Per-company connections and their refresh tokens:
 * server/modules/googleConnect.ts. Every Sheets call receives a SheetAccess (token provider) resolved in the
 * company context from the import/export's SheetAuth.
 */
import crypto from 'node:crypto';
import { ApiError, fail } from '../core/errors';
import { decryptSecret } from '../core/settings';
import { safeJsonParse, sha256Hex, truncate } from '../core/utils';
import { pc } from '../platform/base';
import { PCOLL } from '../platform/registry';
import type { GoogleStatus } from '../core/sheetTypes';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TIMEOUT_MS = 20000;
const EARLY_REFRESH_MS = 5 * 60 * 1000;
let retryDelayMs = 800;

/** Test hook: shorten the 429/5xx back-off. */
export function __setGoogleRetryDelay(ms: number) {
  retryDelayMs = ms;
}

export interface ServiceAccount {
  type: 'service_account';
  client_email: string;
  private_key: string;
  project_id: string;
}

export interface GoogleSettingsDoc {
  _id: 'google';
  serviceAccount?: string; // encrypted JSON
  projectId?: string;
  clientEmail?: string;
  updatedAt?: Date;
  updatedBy?: string;
  /** "Connect with Google" OAuth client. */
  oauthClientId?: string;
  oauthClientSecret?: string; // encrypted
  oauthUpdatedAt?: Date;
  oauthUpdatedBy?: string;
}

export const OAUTH_CONNECT_PATH = '/api/integrations/google/connect';
export const OAUTH_CALLBACK_PATH = '/api/integrations/google/callback';
export const OAUTH_CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export const googleSettingsCol = () => pc<GoogleSettingsDoc>(PCOLL.PLATFORM_SETTINGS);

/* ------------------------------ credential ------------------------------- */

/** Parse + validate a service-account key (raw JSON or base64 of it). Throws VALIDATION with a safe message. */
export function parseServiceAccount(input: string): ServiceAccount {
  let text = String(input ?? '').trim();
  if (!text) throw fail('VALIDATION', 'Paste the service-account JSON key');
  if (!text.startsWith('{')) {
    const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) text = decoded;
  }
  const j = safeJsonParse<Record<string, unknown>>(text, null);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw fail('VALIDATION', 'The key is not valid JSON (paste the whole .json file downloaded from Google Cloud)');
  if (j.type !== 'service_account') throw fail('VALIDATION', 'This JSON is not a service-account key ("type" must be "service_account")');
  const email = String(j.client_email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail('VALIDATION', 'The key has no valid "client_email"');
  const key = String(j.private_key || '');
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(key)) throw fail('VALIDATION', 'The key has no "private_key"');
  try {
    crypto.createPrivateKey(key);
  } catch {
    throw fail('VALIDATION', 'The "private_key" of this JSON cannot be read');
  }
  return { type: 'service_account', client_email: email, private_key: key, project_id: String(j.project_id || '').trim() };
}

function envServiceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    return parseServiceAccount(raw);
  } catch (e: any) {
    console.error('[google] GOOGLE_SERVICE_ACCOUNT_JSON is invalid:', e?.message);
    return null;
  }
}

/** The active credential and where it came from (null = not configured). */
export async function loadServiceAccount(): Promise<{ sa: ServiceAccount; source: 'platform' | 'env' } | null> {
  const doc = await (await googleSettingsCol()).findOne({ _id: 'google' });
  if (doc?.serviceAccount) {
    const plain = decryptSecret(doc.serviceAccount);
    if (plain) {
      try {
        return { sa: parseServiceAccount(plain), source: 'platform' };
      } catch {
        /* fall through to env */
      }
    } else console.error('[google] the stored service account cannot be decrypted (SECRETS_ENCRYPTION_KEY changed?)');
  }
  const env = envServiceAccount();
  return env ? { sa: env, source: 'env' } : null;
}

/** The "Connect with Google" OAuth client (stored wins over env), or null when not configured. */
export async function loadOAuthClient(): Promise<{ clientId: string; clientSecret: string; source: 'platform' | 'env' } | null> {
  const doc = await (await googleSettingsCol()).findOne({ _id: 'google' });
  if (doc?.oauthClientId && doc.oauthClientSecret) {
    const secret = decryptSecret(doc.oauthClientSecret);
    if (secret) return { clientId: doc.oauthClientId, clientSecret: secret, source: 'platform' };
    console.error('[google] the stored OAuth client secret cannot be decrypted (SECRETS_ENCRYPTION_KEY changed?)');
  }
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || '';
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || '';
  return id && secret ? { clientId: id, clientSecret: secret, source: 'env' } : null;
}

export async function googleStatus(): Promise<GoogleStatus> {
  const [c, oauth] = await Promise.all([loadServiceAccount(), loadOAuthClient()]);
  const sa = c ? { configured: true, serviceAccountEmail: c.sa.client_email, source: c.source } : { configured: false, serviceAccountEmail: '', source: 'none' as const };
  return { ...sa, oauthConfigured: !!oauth, connectUrl: OAUTH_CONNECT_PATH };
}

/* --------------------------------- tokens -------------------------------- */

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Signed RS256 JWT assertion for the token endpoint. */
export function buildJwt(sa: Pick<ServiceAccount, 'client_email' | 'private_key'>, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SHEETS_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const cacheKey = (sa: ServiceAccount) => sha256Hex(sa.client_email + '\n' + sa.private_key);

/** Forget cached access tokens (after the key changed; tests). */
export function resetGoogleTokenCache() {
  tokenCache.clear();
}

const NOT_CONFIGURED_MSG = 'Google Sheets is not set up on this platform yet (no Google service account). Ask your platform administrator.';

/** A valid access token + the service-account e-mail. Throws NOT_CONFIGURED / SERVER. */
export async function getAccessToken(opts: { force?: boolean } = {}): Promise<{ token: string; email: string }> {
  const cred = await loadServiceAccount();
  if (!cred) throw fail('NOT_CONFIGURED', NOT_CONFIGURED_MSG);
  const key = cacheKey(cred.sa);
  const hit = tokenCache.get(key);
  if (!opts.force && hit && hit.expiresAt - EARLY_REFRESH_MS > Date.now()) return { token: hit.token, email: cred.sa.client_email };

  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(cred.sa) });
  const res = await fetchWithRetry(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.access_token) {
    const why = truncate([j?.error, j?.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`, 200);
    throw fail('SERVER', `Google rejected the service-account key (${why}). Check the key in Platform settings and that it was not deleted in Google Cloud.`);
  }
  const ttl = Math.max(60, Number(j.expires_in) || 3600) * 1000;
  tokenCache.set(key, { token: String(j.access_token), expiresAt: Date.now() + ttl });
  return { token: String(j.access_token), email: cred.sa.client_email };
}

/* ---------------------------------- HTTP --------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with a 20 s timeout; one retry on 429/5xx (after a back-off) and on network errors/timeouts of idempotent reads. */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const method = String(init.method || 'GET').toUpperCase();
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e: any) {
      if (attempt === 0 && method === 'GET') {
        await sleep(retryDelayMs);
        continue;
      }
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw fail('SERVER', timeout ? 'Google did not answer within 20 seconds. Please try again.' : 'Could not reach Google. Please try again.');
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : retryDelayMs);
      continue;
    }
    return res;
  }
}

/** An error answer of a Google API (status + Google's own message, which never contains credentials). */
export class GoogleApiError extends ApiError {
  constructor(public httpStatus: number, public googleMessage: string, message?: string) {
    super(httpStatus === 400 || httpStatus === 403 || httpStatus === 404 ? 'VALIDATION' : 'SERVER', message || `Google API error ${httpStatus}: ${truncate(googleMessage, 200)}`, { googleStatus: httpStatus });
  }
}

/**
 * How one import/export reaches Google: a token provider plus the account e-mail (for messages).
 * Built by serviceAccountAccess() or, for OAuth connections, by server/modules/googleConnect.ts (company context).
 */
export interface SheetAccess {
  mode: 'service_account' | 'oauth';
  /** A valid access token; force = bypass the cache (after a 401). */
  token(force?: boolean): Promise<string>;
  /** The Google account used ('' when unknown). Never throws. */
  email(): Promise<string>;
}

export function serviceAccountAccess(): SheetAccess {
  return {
    mode: 'service_account',
    token: async (force) => (await getAccessToken({ force })).token,
    email: async () => {
      try {
        return (await getAccessToken()).email;
      } catch {
        return '';
      }
    },
  };
}

/**
 * Authorised JSON call to a Google API. Returns the parsed body; throws GoogleApiError for 4xx/5xx answers.
 * A 401 (token revoked/expired early) is retried once with a fresh token.
 */
export async function googleJson<T = any>(access: SheetAccess, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await access.token(attempt > 0);
    const res = await fetchWithRetry(url, {
      method: init.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 401 && attempt === 0) continue;
    const text = await res.text();
    const j = text ? safeJsonParse<any>(text, null) : {};
    if (!res.ok) throw new GoogleApiError(res.status, String(j?.error?.message || j?.error_description || res.statusText || ''));
    return (j ?? {}) as T;
  }
}
