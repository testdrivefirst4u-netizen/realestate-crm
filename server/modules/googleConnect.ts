/**
 * "Connect with Google" (OAuth, no key file) — company side. Contract: server/core/sheetTypes.ts.
 *
 * Connections = company collection `googleConnections` { _id: GCN-0001, email, refreshToken (AES-GCM encrypted),
 *               scopes, status 'Active' | 'Error', lastError, connectedBy, connectedAt }. One per Google account:
 *               reconnecting the same e-mail updates the token of the existing connection and clears its error.
 * Connect     = GET /api/integrations/google/connect (startGoogleConnect) → Google consent screen
 *               (scope 'openid email …/auth/spreadsheets', access_type=offline, prompt=consent, signed state +
 *               httpOnly nonce cookie `google_oauth_nonce`, see server/core/oauthState.ts) →
 *               GET /api/integrations/google/callback (finishGoogleConnect) → code exchange → refresh token required,
 *               spreadsheets scope required → redirect `/settings?section=googleSheets&googleConnected=<id>`
 *               or `&googleError=<message>`.
 * Tokens      = sheetAccessFor(auth) builds the token provider of one import/export inside the company context:
 *               OAuth → refresh_token grant, access token cached in memory per connection (and refresh token) until
 *               5 minutes before it expires; `invalid_grant` marks the connection 'Error' with RECONNECT_MSG.
 *               Service account (or auth missing) → the platform service account (server/integrations/google.ts).
 *
 * The e-mail is read from the id_token returned by the token endpoint. Its signature is NOT verified: the token was
 * received directly from Google's token endpoint over TLS in exchange for our client secret, which OpenID Connect
 * Core §3.1.3.7 accepts as validation of the issuer. The userinfo endpoint is the fallback.
 */
import type { Ctx } from '../core/auth';
import { auditLog, can } from '../core/auth';
import { col, nextSeq } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { randomToken, sha256Hex, truncate } from '../core/utils';
import { readCookie, resolveCrmSession, signState, verifyState } from '../core/oauthState';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { requireTenant, runWithTenant } from '../core/tenant';
import type { GoogleConnection, SheetAuth } from '../core/sheetTypes';
import {
  fetchWithRetry, GOOGLE_TOKEN_URL, loadOAuthClient, loadServiceAccount, OAUTH_CALLBACK_PATH, serviceAccountAccess, SHEETS_SCOPE,
  type SheetAccess,
} from '../integrations/google';

export { readCookie };

export const COLL_GOOGLE_CONNECTIONS = 'googleConnections';
export const GOOGLE_NONCE_COOKIE = 'google_oauth_nonce';
export const GOOGLE_COOKIE_PATH = '/api/integrations/google';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const CONNECT_SCOPE = `openid email ${SHEETS_SCOPE}`;
const STATE_PURPOSE = 'google';
const STATE_TTL_S = 600;
const EARLY_REFRESH_MS = 5 * 60 * 1000;

export const RECONNECT_MSG = 'Google access was revoked or expired — reconnect the Google account';
export const NO_OFFLINE_MSG = 'Google did not return offline access — remove the app at myaccount.google.com/permissions and connect again';
export const NO_SHEETS_SCOPE_MSG = 'Google Sheets access was not granted. Connect again and tick the permission to see and edit your Google Sheets spreadsheets.';
export const CANCELLED_MSG = 'Google sign-in was cancelled.';
export const NOT_VERIFIED_MSG = 'The Google sign-in could not be verified (it expired or was started in another session). Please try again.';
export const REMOVED_MSG = 'The Google account connection used by this sheet was removed — choose another account in Settings › Google Sheets';

export interface GoogleConnectionDoc {
  _id: string; // GCN-0001
  email: string;
  refreshToken: string; // encrypted
  scopes: string[];
  status: 'Active' | 'Error';
  lastError: string;
  connectedBy: string;
  connectedAt: Date;
  updatedAt: Date;
}

export const googleConnectionsCol = () => col<GoogleConnectionDoc>(COLL_GOOGLE_CONNECTIONS);

export function toConnection(d: GoogleConnectionDoc, usedBy = 0): GoogleConnection {
  return {
    id: d._id,
    email: d.email,
    status: d.status === 'Error' ? 'Error' : 'Active',
    lastError: d.lastError || '',
    connectedBy: d.connectedBy || '',
    connectedAt: d.connectedAt ? new Date(d.connectedAt).toISOString() : '',
    usedBy,
  };
}

export const googleRedirectUri = () => `${appUrl()}${OAUTH_CALLBACK_PATH}`;

/** Settings URL the browser returns to (absolute, on APP_URL). */
export function googleSettingsRedirect(params: { googleConnected: string } | { googleError: string }): string {
  const q = new URLSearchParams({ section: 'googleSheets', ...params });
  return `${appUrl()}/settings?${q.toString()}`;
}

/* ---------------------------- auth of a link ----------------------------- */

/**
 * Default auth when an import/export does not say: the company's only Active connection when the platform has no
 * service account; otherwise the service account.
 */
export async function defaultSheetAuth(): Promise<SheetAuth> {
  const active = await (await googleConnectionsCol()).find({ status: 'Active' }, { projection: { _id: 1 } }).limit(2).toArray();
  if (active.length === 1 && !(await loadServiceAccount())) return { mode: 'oauth', connectionId: active[0]._id };
  return { mode: 'service_account' };
}

/**
 * Validate a SheetAuth from a request (undefined/null → default). oauth needs an Active connection of THIS company;
 * an explicit service_account needs the platform service account to be configured.
 */
export async function validateSheetAuth(input: unknown): Promise<SheetAuth> {
  if (input === undefined || input === null) return defaultSheetAuth();
  if (typeof input !== 'object' || Array.isArray(input)) throw fail('VALIDATION', 'auth must be { mode: "service_account" } or { mode: "oauth", connectionId }');
  const a = input as Record<string, unknown>;
  if (a.mode === 'service_account') {
    // chosen explicitly: the platform must have one (the implicit default may still fall back to it)
    if (!(await loadServiceAccount())) throw fail('VALIDATION', 'The platform Google service account is not set up — connect a Google account instead, or ask your platform administrator.');
    return { mode: 'service_account' };
  }
  if (a.mode !== 'oauth') throw fail('VALIDATION', 'auth.mode must be "service_account" or "oauth"');
  const id = String(a.connectionId ?? '').trim();
  if (!id) throw fail('VALIDATION', 'Choose the connected Google account to use');
  const c = await (await googleConnectionsCol()).findOne({ _id: id });
  if (!c) throw fail('VALIDATION', 'That Google account is not connected to this workspace. Connect it first (Settings › Google Sheets).');
  if (c.status !== 'Active') throw fail('VALIDATION', `The Google account ${c.email} must be reconnected first: ${c.lastError || RECONNECT_MSG}`);
  return { mode: 'oauth', connectionId: c._id };
}

/* -------------------------------- tokens --------------------------------- */

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Forget cached OAuth access tokens (tests; after disconnect). */
export function resetGoogleOAuthTokenCache() {
  tokenCache.clear();
}

async function markConnectionError(id: string, message: string) {
  await (await googleConnectionsCol()).updateOne({ _id: id }, { $set: { status: 'Error', lastError: message, updatedAt: new Date() } });
}

/** A valid access token of one company connection (refresh_token grant, cached). Company context required. */
export async function oauthAccessToken(connectionId: string, force = false): Promise<string> {
  const t = requireTenant();
  const doc = await (await googleConnectionsCol()).findOne({ _id: connectionId });
  if (!doc) throw fail('VALIDATION', REMOVED_MSG);
  if (doc.status === 'Error') throw fail('VALIDATION', doc.lastError || RECONNECT_MSG);
  const refresh = decryptSecret(doc.refreshToken || '');
  if (!refresh) {
    await markConnectionError(doc._id, RECONNECT_MSG);
    throw fail('VALIDATION', RECONNECT_MSG);
  }
  const key = `${t.id}:${doc._id}:${sha256Hex(refresh).slice(0, 16)}`;
  const hit = tokenCache.get(key);
  if (!force && hit && hit.expiresAt - EARLY_REFRESH_MS > Date.now()) return hit.token;

  const client = await loadOAuthClient();
  if (!client) throw fail('NOT_CONFIGURED', '"Connect with Google" is not set up on this platform (no OAuth client). Ask your platform administrator.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client.clientId, client_secret: client.clientSecret });
  const res = await fetchWithRetry(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j: any = await res.json().catch(() => ({}));
  if (j?.error === 'invalid_grant') {
    tokenCache.delete(key);
    await markConnectionError(doc._id, RECONNECT_MSG);
    throw fail('VALIDATION', RECONNECT_MSG);
  }
  if (!res.ok || !j?.access_token) {
    const why = truncate([j?.error, j?.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`, 200);
    throw fail('SERVER', `Google refused to refresh the access of ${doc.email} (${why}).`);
  }
  const ttl = Math.max(60, Number(j.expires_in) || 3600) * 1000;
  tokenCache.set(key, { token: String(j.access_token), expiresAt: Date.now() + ttl });
  return String(j.access_token);
}

/** How an import/export with this auth reaches Google (lazy: no Google call until a token is needed). */
export function sheetAccessFor(auth: SheetAuth | undefined | null): SheetAccess {
  if (auth?.mode === 'oauth') {
    const id = auth.connectionId;
    return {
      mode: 'oauth',
      token: (force) => oauthAccessToken(id, !!force),
      email: async () => {
        try {
          return (await (await googleConnectionsCol()).findOne({ _id: id }))?.email || '';
        } catch {
          return '';
        }
      },
    };
  }
  return serviceAccountAccess();
}

/** Access token for a SheetAuth, resolved in the current company. */
export const resolveSheetToken = (auth: SheetAuth | undefined | null) => sheetAccessFor(auth).token();

/** Best-effort revoke of a (refresh) token at Google. Never throws. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Revoke every connection of the current company (company deletion). Returns how many were revoked. */
export async function revokeAllGoogleConnections(): Promise<number> {
  const docs = await (await googleConnectionsCol()).find({}).toArray();
  let n = 0;
  for (const d of docs) if (await revokeGoogleToken(decryptSecret(d.refreshToken || ''))) n++;
  resetGoogleOAuthTokenCache();
  return n;
}

/* ------------------------------ connect flow ----------------------------- */

export interface GoogleConnectStart {
  redirect: string;
  /** Set as the httpOnly `google_oauth_nonce` cookie when present. */
  nonce?: string;
}

/** GET /api/integrations/google/connect — core logic (the route only reads cookies and writes the redirect). */
export async function startGoogleConnect(input: { sessionCookie: string; nowMs?: number }): Promise<GoogleConnectStart> {
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  if (!can(sess.user, 'settings.edit')) return { redirect: googleSettingsRedirect({ googleError: 'Only an administrator can connect a Google account.' }) };
  if (!sess.tenant.features.googleSheets) return { redirect: googleSettingsRedirect({ googleError: "Google Sheets sync is not included in your company's plan." }) };
  const client = await loadOAuthClient();
  if (!client) return { redirect: googleSettingsRedirect({ googleError: '"Connect with Google" is not set up on this platform yet. Ask your platform administrator.' }) };
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S }, STATE_PURPOSE);
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: CONNECT_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return { redirect: `${GOOGLE_AUTH_URL}?${q.toString()}`, nonce };
}

/** Payload of a JWT (no signature check — see the header comment). */
function jwtPayload(jwt: unknown): Record<string, unknown> | null {
  const part = String(jwt || '').split('.')[1];
  if (!part) return null;
  try {
    const p = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

async function emailOf(tokenAnswer: any): Promise<string> {
  const p = jwtPayload(tokenAnswer?.id_token);
  let email = typeof p?.email === 'string' ? p.email : '';
  if (!email && tokenAnswer?.access_token) {
    try {
      const r = await fetchWithRetry(GOOGLE_USERINFO_URL, { method: 'GET', headers: { Authorization: `Bearer ${tokenAnswer.access_token}` } });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && typeof j?.email === 'string') email = j.email;
    } catch {
      /* fall through */
    }
  }
  return email.trim().toLowerCase();
}

/** Store (or refresh) the connection of a Google account. Returns its id. Company context required. */
export async function upsertGoogleConnection(input: { email: string; refreshToken: string; scopes: string[]; ctx: Ctx; now?: Date }): Promise<{ id: string; reconnected: boolean }> {
  const c = await googleConnectionsCol();
  const now = input.now || new Date();
  const by = input.ctx.user ? input.ctx.user.name + (input.ctx.user.email ? ` <${input.ctx.user.email}>` : '') : 'System';
  const fields = { refreshToken: encryptSecret(input.refreshToken), scopes: input.scopes, status: 'Active' as const, lastError: '', connectedBy: by, connectedAt: now, updatedAt: now };
  const cur = await c.findOne({ email: input.email });
  if (cur) {
    await c.updateOne({ _id: cur._id }, { $set: fields });
    resetGoogleOAuthTokenCache();
    await auditLog(input.ctx, 'Google Account Reconnected', 'Settings', cur._id, input.email);
    return { id: cur._id, reconnected: true };
  }
  const doc: GoogleConnectionDoc = { _id: await nextSeq('GCN', 4), email: input.email, ...fields };
  await c.insertOne(doc);
  await auditLog(input.ctx, 'Google Account Connected', 'Settings', doc._id, input.email);
  return { id: doc._id, reconnected: false };
}

/**
 * GET /api/integrations/google/callback — core logic. Always answers with a redirect: to `/` when not signed in,
 * otherwise to Settings with `googleConnected=<id>` or `googleError=<message>` (never a token in the URL).
 */
export async function finishGoogleConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const p = input.params;
  const err = (googleError: string) => ({ redirect: googleSettingsRedirect({ googleError: truncate(googleError, 300) }) });
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  const error = p.get('error') || '';
  if (error) return err(error === 'access_denied' ? CANCELLED_MSG : `Google sign-in failed: ${p.get('error_description') || error}`);
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs, STATE_PURPOSE);
  if (!v.ok) return err(NOT_VERIFIED_MSG);
  if (!can(sess.user, 'settings.edit') || !sess.tenant.features.googleSheets) return err('You cannot connect a Google account.');
  const code = p.get('code') || '';
  if (!code) return err('Google did not return an authorisation code. Please try again.');
  try {
    const id = await runWithTenant(sess.tenant, async () => {
      const client = await loadOAuthClient();
      if (!client) throw fail('NOT_CONFIGURED', '"Connect with Google" is not set up on this platform yet. Ask your platform administrator.');
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: googleRedirectUri() });
      const res = await fetchWithRetry(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j?.access_token) throw fail('VALIDATION', `Google sign-in failed: ${truncate(j?.error_description || j?.error || `HTTP ${res.status}`, 200)}`);
      const refresh = typeof j.refresh_token === 'string' ? j.refresh_token : '';
      if (!refresh) throw fail('VALIDATION', NO_OFFLINE_MSG);
      const scopes = String(j.scope || '').split(/\s+/).filter(Boolean);
      if (!scopes.includes(SHEETS_SCOPE)) {
        await revokeGoogleToken(refresh);
        throw fail('VALIDATION', NO_SHEETS_SCOPE_MSG);
      }
      const email = await emailOf(j);
      if (!email) throw fail('VALIDATION', 'Google did not return the e-mail of the account. Please try again.');
      const ctx: Ctx = { user: sess.user, session: null, token: '', userAgent: '', ip: '', action: 'googleConnect' };
      return (await upsertGoogleConnection({ email, refreshToken: refresh, scopes, ctx, now: new Date(input.nowMs ?? Date.now()) })).id;
    });
    return { redirect: googleSettingsRedirect({ googleConnected: id }) };
  } catch (e: any) {
    if (!(e instanceof ApiError)) console.error('[google:callback]', e?.message);
    return err(e instanceof ApiError ? e.message : 'Something went wrong while connecting Google. Please try again.');
  }
}
