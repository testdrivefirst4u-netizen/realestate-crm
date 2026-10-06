/**
 * POST /api/rpc  { action, data }  →  { status: 'success', data } | { status: 'error', code, message }
 *
 * Single entry point for the CRM screens (replaces the Apps Script /exec URL).
 * The session token lives only in an httpOnly cookie: login/createFirstAdmin set it,
 * logout clears it, and it is stripped from every JSON response.
 */
import { NextResponse } from 'next/server';
import { dispatch } from '@/server/router';
import { clearSessionCookie, isSameOrigin, requestBase, setSessionCookie } from '@/server/core/request';
import { errEnvelope } from '@/server/core/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_BODY = 60 * 1024 * 1024; // base64 uploads up to ~45 MB

export async function POST(req: Request) {
  if (!(await isSameOrigin())) return NextResponse.json(errEnvelope('FORBIDDEN', 'Cross-origin request rejected'), { status: 403 });
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return NextResponse.json(errEnvelope('VALIDATION', 'Request is too large'), { status: 413 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(errEnvelope('VALIDATION', 'Invalid JSON body'), { status: 400 });
  }
  const action = String(body?.action || '');
  if (!action) return NextResponse.json(errEnvelope('VALIDATION', 'action is required'), { status: 400 });

  const base = await requestBase();
  const result = await dispatch(action, body.data || {}, base);

  // Move a freshly issued session token into the cookie and keep it out of the JSON.
  const data: any = (result.body as any).data;
  let issued: { token: string; expiresAt: string } | null = null;
  if (result.status === 200 && data && typeof data === 'object' && typeof data.token === 'string' && data.token && (action === 'login' || action === 'createFirstAdmin')) {
    issued = { token: data.token, expiresAt: data.expiresAt };
    (result.body as any).data = { ...data, token: 'cookie' };
  }

  const res = NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  if (issued && result.companyId) setSessionCookie(res, result.companyId, issued.token, issued.expiresAt);
  if (action === 'logout' || (result.body as any).code === 'AUTH_REQUIRED') clearSessionCookie(res);
  return res;
}
