/**
 * GET /api/integrations/google/callback — Google OAuth redirect URI (add `${APP_URL}/api/integrations/google/callback`
 * under the OAuth client's "Authorised redirect URIs"). Verifies the signed state, the `google_oauth_nonce` cookie
 * and that the CRM session is the same user/company, exchanges the code, stores the connection (refresh token
 * encrypted) and redirects to /settings?section=googleSheets&googleConnected=<id> (or &googleError=<message>).
 * The nonce cookie is always cleared.
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { finishGoogleConnect, GOOGLE_COOKIE_PATH, GOOGLE_NONCE_COOKIE, googleSettingsRedirect, readCookie } from '@/server/modules/googleConnect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const cookie = req.headers.get('cookie');
  let target: string;
  try {
    target = (await finishGoogleConnect({
      params: new URL(req.url).searchParams,
      sessionCookie: readCookie(cookie, CFG.SESSION_COOKIE),
      nonceCookie: readCookie(cookie, GOOGLE_NONCE_COOKIE),
    })).redirect;
  } catch (e: any) {
    console.error('[google:callback]', e?.message);
    target = googleSettingsRedirect({ googleError: 'Something went wrong while connecting Google. Please try again.' });
  }
  const res = NextResponse.redirect(target, 302);
  res.headers.set('Cache-Control', 'no-store');
  res.cookies.set(GOOGLE_NONCE_COOKIE, '', { httpOnly: true, path: GOOGLE_COOKIE_PATH, maxAge: 0 });
  return res;
}
