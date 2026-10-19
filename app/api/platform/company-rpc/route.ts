/**
 * POST /api/platform/company-rpc  { companyId, action, data }  →  the CRM action's envelope
 *
 * Company settings inside the Super Admin console (Companies › a company › Settings) — no trip into the company's
 * CRM. The super admin's console session is checked on every call; the action then runs in that company as its
 * hidden "Platform support" account (the same 2-hour session "Open company settings" used to start, so changes are
 * still audited under the super admin's name). Only settings actions are allowed. The support token lives in an
 * httpOnly cookie scoped to this path and is renewed automatically when it expires.
 */
import { NextResponse } from 'next/server';
import { dispatch } from '@/server/router';
import { errEnvelope } from '@/server/core/errors';
import { PLATFORM_COOKIE } from '@/server/platform/cookie';
import { validateSaSession } from '@/server/platform/superAdmins';
import { openCompanySupport } from '@/server/platform/companies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PATH = '/api/platform/company-rpc';
const COOKIE = 'company_support';
const MAX_BODY = 2 * 1024 * 1024;

/** CRM actions the console's company settings may run. */
const COMPANY_SETTINGS_ACTIONS = new Set([
  'getSettings', 'updateSettings', 'setSecret', 'aiTest', 'chat360Test', 'listUsers',
  'metaSyncReport', 'retryMetaLeads', 'backfillMetaSource',
  'listLeadBackups', 'getLeadBackup', 'createLeadBackup', 'verifyLeadBackup',
]);

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

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json(errEnvelope('FORBIDDEN', 'Cross-origin request rejected'), 403);
  let body: any;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(errEnvelope('VALIDATION', 'Request is too large'), 413);
    body = JSON.parse(text);
  } catch {
    return json(errEnvelope('VALIDATION', 'Invalid JSON body'), 400);
  }
  const companyId = String(new URL(req.url).searchParams.get('company') || body?.companyId || '');
  const action = String(body?.action || '');
  if (!companyId || !action) return json(errEnvelope('VALIDATION', 'company and action are required'), 400);
  if (!COMPANY_SETTINGS_ACTIONS.has(action)) return json(errEnvelope('FORBIDDEN', 'This action is not available from the console'), 403);

  const saToken = readCookie(req, PLATFORM_COOKIE);
  const sa = saToken ? await validateSaSession(saToken) : null;
  if (!sa) return json(errEnvelope('AUTH_REQUIRED', 'Your console session has ended — sign in again'), 401);

  const fwd = req.headers.get('x-forwarded-for') || '';
  const meta = { userAgent: req.headers.get('user-agent') || '', ip: (fwd.split(',')[0] || req.headers.get('x-real-ip') || '').trim() };
  const run = (token: string) => dispatch(action, body?.data || {}, { companyId, token, ...meta });

  const [cookieCompany, cookieToken] = readCookie(req, COOKIE).split('.');
  let minted: { token: string; expiresAt: string } | null = null;
  let result = cookieCompany === companyId && cookieToken ? await run(cookieToken) : null;
  if (!result || (result.body as any).code === 'AUTH_REQUIRED') {
    try {
      const r = await openCompanySupport({ companyId }, { sa: sa.user, token: saToken, expiresAt: sa.expiresAt, ...meta });
      minted = { token: r.token, expiresAt: r.expiresAt };
    } catch (e: any) {
      const code = e?.code || 'INTERNAL';
      return json(errEnvelope(code, code === 'INTERNAL' ? 'Could not open the company' : e.message), code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' ? 400 : 500);
    }
    result = await run(minted.token);
  }

  const res = json(result.body, result.status);
  if (minted) {
    res.cookies.set(COOKIE, `${companyId}.${minted.token}`, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: PATH, expires: new Date(minted.expiresAt),
    });
  }
  return res;
}
