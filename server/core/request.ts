/** Helpers shared by route handlers: request context from cookies/headers, the session cookie, company context. */
import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { CFG } from './config';
import { errEnvelope } from './errors';
import { runWithTenant } from './tenant';
import { getTenantById } from '../platform/registry';
import type { Ctx } from './auth';

export type RequestBase = Omit<Ctx, 'user' | 'session' | 'action'> & { companyId: string };

/**
 * The session cookie holds `<companyId>.<token>`: the company part only routes the request to the right
 * database; the token is what authenticates (random 256-bit, stored hashed in that company's database).
 */
export function parseSessionCookie(raw: string | undefined | null): { companyId: string; token: string } {
  const v = String(raw || '');
  const i = v.indexOf('.');
  if (i <= 0) return { companyId: '', token: v };
  return { companyId: v.slice(0, i), token: v.slice(i + 1) };
}

export async function requestBase(): Promise<RequestBase> {
  const c = await cookies();
  const h = await headers();
  const fwd = h.get('x-forwarded-for') || '';
  const { companyId, token } = parseSessionCookie(c.get(CFG.SESSION_COOKIE)?.value);
  return {
    companyId,
    token,
    userAgent: h.get('user-agent') || '',
    ip: (fwd.split(',')[0] || h.get('x-real-ip') || '').trim(),
  };
}

export function setSessionCookie(res: NextResponse, companyId: string, token: string, expiresAt: string) {
  res.cookies.set(CFG.SESSION_COOKIE, `${companyId}.${token}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(CFG.SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/**
 * Run a route handler inside the signed-in user's company (from the session cookie).
 * Answers 401 when there is no company or it is suspended — the handler still validates the session itself.
 */
export async function withRequestTenant(fn: (base: RequestBase) => Promise<Response>): Promise<Response> {
  const base = await requestBase();
  const tenant = base.companyId ? await getTenantById(base.companyId) : null;
  if (!tenant || tenant.status !== 'Active') {
    return NextResponse.json(errEnvelope('AUTH_REQUIRED', 'Please sign in'), { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return runWithTenant(tenant, () => fn(base));
}

/** Same-origin check for state-changing requests (defence in depth on top of SameSite=Lax). */
export async function isSameOrigin(): Promise<boolean> {
  const h = await headers();
  const origin = h.get('origin');
  if (!origin) return true; // same-origin fetches from older browsers / server-to-server
  const host = h.get('x-forwarded-host') || h.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
