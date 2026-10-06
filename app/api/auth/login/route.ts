/**
 * POST /api/auth/login  { email, password }  →  { status: 'success', data: { area, redirect, user } } | error envelope
 *
 * The one sign-in form (/login) for everybody:
 * - a super admin e-mail with the console password → `platform_session` cookie, area 'superadmin' (/superadmin);
 * - otherwise a company user (company found from the e-mail) → company session cookie, area 'crm' (/dashboard).
 * An e-mail that is both tries the console password first, then the CRM password. Each side keeps its own
 * throttling and audit; a wrong password answers the same "Invalid email or password" either way.
 */
import { NextResponse } from 'next/server';
import { dispatch } from '@/server/router';
import { platformDispatch } from '@/server/platform/router';
import { isSuperAdminEmail } from '@/server/platform/superAdmins';
import { setPlatformSessionCookie } from '@/server/platform/cookie';
import { isSameOrigin, requestBase, setSessionCookie } from '@/server/core/request';
import { errEnvelope } from '@/server/core/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  if (!(await isSameOrigin())) return json(errEnvelope('FORBIDDEN', 'Cross-origin request rejected'), 403);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(errEnvelope('VALIDATION', 'Invalid JSON body'), 400);
  }
  const email = String(body?.email || '').trim();
  const password = String(body?.password || '');
  if (!email || !password) return json(errEnvelope('VALIDATION', 'Enter your email and password'), 400);

  const base = await requestBase();

  if (await isSuperAdminEmail(email)) {
    const sa = await platformDispatch('saLogin', { email, password }, { token: '', userAgent: base.userAgent, ip: base.ip });
    if (sa.status === 200 && sa.session) {
      const res = json({ status: 'success', data: { area: 'superadmin', redirect: '/superadmin', user: (sa.body as any).data?.user } }, 200);
      setPlatformSessionCookie(res, sa.session);
      return res;
    }
    // Wrong console password (or console sign-in locked): the same e-mail may still be a CRM user.
  }

  const crm = await dispatch('login', { email, password }, base);
  const data: any = (crm.body as any).data;
  if (crm.status !== 200 || !data?.token || !crm.companyId) return json(crm.body, crm.status);
  const res = json({ status: 'success', data: { area: 'crm', redirect: '/dashboard', user: data.user, expiresAt: data.expiresAt, token: 'cookie' } }, 200);
  setSessionCookie(res, crm.companyId, data.token, data.expiresAt);
  return res;
}
