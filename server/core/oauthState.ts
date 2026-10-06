/**
 * Shared helpers for "Connect with …" OAuth flows started from the CRM (Facebook: server/modules/meta.ts,
 * Google: server/modules/googleConnect.ts).
 *
 * State = base64url JSON {c: companyId, u: userId, n: nonce, exp} + '.' + HMAC-SHA256 of it. The HMAC key is
 * derived from SECRETS_ENCRYPTION_KEY and a per-provider `purpose` ('meta', 'google'), so a state issued for one
 * provider is never accepted by another. The nonce is also put into a short-lived httpOnly cookie by the connect
 * route; the callback requires state signature + expiry + nonce cookie + the same CRM session (company and user).
 */
import crypto from 'node:crypto';
import { validateSession, type PublicUser } from './auth';
import { fail } from './errors';
import { parseSessionCookie } from './request';
import { runWithTenant, type Tenant } from './tenant';
import { safeEqual } from './utils';
import { getTenantById } from '../platform/registry';

export interface OAuthState { c: string; u: string; n: string; exp: number }

function stateKey(purpose: string): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (raw) return crypto.createHash('sha256').update(`${purpose}-oauth-state\n` + raw).digest();
  if (process.env.NODE_ENV !== 'production') return crypto.createHash('sha256').update(`${purpose}-oauth-state\namaya-dev-only-key`).digest();
  throw fail('NOT_CONFIGURED', 'SECRETS_ENCRYPTION_KEY is not set on the server, so sign-ins with other services cannot be verified.');
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Signed state for the OAuth redirect. `purpose` separates providers (default 'meta' for compatibility). */
export function signState(p: OAuthState, purpose = 'meta'): string {
  const body = b64url(JSON.stringify({ c: p.c, u: p.u, n: p.n, exp: p.exp }));
  return `${body}.${b64url(crypto.createHmac('sha256', stateKey(purpose)).update(body).digest())}`;
}

/** Verify signature, expiry, nonce (cookie) and that the session is the same company + user. */
export function verifyState(
  state: string,
  expect: { nonce: string; companyId: string; userId: string },
  nowMs = Date.now(),
  purpose = 'meta'
): { ok: true; state: OAuthState } | { ok: false; reason: string } {
  const [body, sig, extra] = String(state || '').split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'malformed state' };
  const want = crypto.createHmac('sha256', stateKey(purpose)).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'bad signature' };
  let p: OAuthState;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed state' };
  }
  if (!p || typeof p !== 'object' || typeof p.exp !== 'number') return { ok: false, reason: 'malformed state' };
  if (p.exp * 1000 < nowMs) return { ok: false, reason: 'expired' };
  if (!expect.nonce || !safeEqual(String(p.n || ''), expect.nonce)) return { ok: false, reason: 'nonce mismatch' };
  if (p.c !== expect.companyId || p.u !== expect.userId) return { ok: false, reason: 'different session' };
  return { ok: true, state: p };
}

/** Cookie header → value of one cookie. */
export function readCookie(header: string | null | undefined, name: string): string {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return part.slice(i + 1).trim();
      }
    }
  }
  return '';
}

/** The CRM user of a session cookie value (`<companyId>.<token>`), or null. */
export async function resolveCrmSession(sessionCookie: string): Promise<{ tenant: Tenant; user: PublicUser } | null> {
  const { companyId, token } = parseSessionCookie(sessionCookie);
  if (!companyId || !token) return null;
  const tenant = await getTenantById(companyId);
  if (!tenant || tenant.status !== 'Active') return null;
  const s = await runWithTenant(tenant, () => validateSession(token));
  return s ? { tenant, user: s.user } : null;
}
