/**
 * POST /api/platform/rpc  { action, data }  →  { status: 'success', data } | { status: 'error', code, message }
 *
 * Super Admin console API (server/platform/contract.ts). The session lives only in the httpOnly,
 * SameSite=Strict cookie `platform_session`: saLogin/saSetup set it, saLogout and AUTH_REQUIRED clear it,
 * and the token never appears in JSON. Everything is read from the Request itself (no next/headers),
 * so the handler is directly testable.
 */
import { NextResponse } from 'next/server';
import { platformDispatch } from '@/server/platform/router';
import { errEnvelope } from '@/server/core/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PLATFORM_COOKIE = 'platform_session';
const MAX_BODY = 1024 * 1024; // 1 MB (logos are ≤ 48 KB)

/** Same rule as core/request.ts → isSameOrigin, evaluated on this request's headers. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readCookie(req: Request, name: string): string {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json(errEnvelope('FORBIDDEN', 'Cross-origin request rejected'), 403);
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json(errEnvelope('VALIDATION', 'Request is too large'), 413);

  let body: any;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(errEnvelope('VALIDATION', 'Request is too large'), 413);
    body = JSON.parse(text);
  } catch {
    return json(errEnvelope('VALIDATION', 'Invalid JSON body'), 400);
  }
  const action = String(body?.action || '');
  if (!action) return json(errEnvelope('VALIDATION', 'action is required'), 400);

  const fwd = req.headers.get('x-forwarded-for') || '';
  const result = await platformDispatch(action, body.data || {}, {
    token: readCookie(req, PLATFORM_COOKIE),
    userAgent: req.headers.get('user-agent') || '',
    ip: (fwd.split(',')[0] || req.headers.get('x-real-ip') || '').trim(),
  });

  const res = json(result.body, result.status);
  if (result.session && !result.clearSession) {
    res.cookies.set(PLATFORM_COOKIE, result.session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      expires: new Date(result.session.expiresAt),
    });
  } else if (result.clearSession) {
    res.cookies.set(PLATFORM_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
  }
  return res;
}
