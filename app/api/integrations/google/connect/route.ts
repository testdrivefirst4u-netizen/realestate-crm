/**
 * GET /api/integrations/google/connect — starts "Connect with Google" for the signed-in CRM admin
 * (settings.edit, plan googleSheets, platform OAuth client configured). Sets the short-lived httpOnly cookie
 * `google_oauth_nonce` and redirects to Google's consent screen with a signed `state`.
 * Problems redirect to /settings?section=googleSheets&googleError=…; not signed in → `/`.
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { GOOGLE_COOKIE_PATH, GOOGLE_NONCE_COOKIE, readCookie, startGoogleConnect } from '@/server/modules/googleConnect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const cookie = req.headers.get('cookie');
  let r;
  try {
    r = await startGoogleConnect({ sessionCookie: readCookie(cookie, CFG.SESSION_COOKIE) });
  } catch (e: any) {
    console.error('[google:connect]', e?.message);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Could not start the Google sign-in' }, { status: 500 });
  }
  const res = NextResponse.redirect(r.redirect, 302);
  res.headers.set('Cache-Control', 'no-store');
  if (r.nonce) {
    res.cookies.set(GOOGLE_NONCE_COOKIE, r.nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: GOOGLE_COOKIE_PATH,
      maxAge: 600,
    });
  }
  return res;
}
