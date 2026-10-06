/**
 * GET /api/integrations/meta/connect — starts "Connect with Facebook" for the signed-in CRM admin
 * (settings.edit, plan metaLeads). Sets the short-lived httpOnly cookie `meta_oauth_nonce` and redirects to the
 * Facebook OAuth dialog with a signed `state`. Problems redirect to /settings?section=leadSources&metaError=….
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { NONCE_COOKIE, readCookie, startMetaConnect } from '@/server/modules/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const cookie = req.headers.get('cookie');
  let r;
  try {
    r = await startMetaConnect({ sessionCookie: readCookie(cookie, CFG.SESSION_COOKIE) });
  } catch (e: any) {
    console.error('[meta:connect]', e?.message);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Could not start the Facebook login' }, { status: 500 });
  }
  const res = NextResponse.redirect(r.redirect, 302);
  res.headers.set('Cache-Control', 'no-store');
  if (r.nonce) {
    res.cookies.set(NONCE_COOKIE, r.nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/integrations/meta',
      maxAge: 600,
    });
  }
  return res;
}
