/**
 * GET /api/integrations/meta/callback — Facebook OAuth redirect URI (add it under Facebook Login › Valid OAuth
 * Redirect URIs). Verifies the signed state, the `meta_oauth_nonce` cookie and that the CRM session is the same
 * user/company, exchanges the code, stores a pending connection and redirects to
 * /settings?section=leadSources&metaConnect=<id> (or &metaError=<message>). The nonce cookie is always cleared.
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { finishMetaConnect, NONCE_COOKIE, readCookie, settingsRedirect } from '@/server/modules/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const cookie = req.headers.get('cookie');
  let target: string;
  try {
    target = (await finishMetaConnect({
      params: new URL(req.url).searchParams,
      sessionCookie: readCookie(cookie, CFG.SESSION_COOKIE),
      nonceCookie: readCookie(cookie, NONCE_COOKIE),
    })).redirect;
  } catch (e: any) {
    console.error('[meta:callback]', e?.message);
    target = settingsRedirect({ metaError: 'Something went wrong while connecting Facebook. Please try again.' });
  }
  const res = NextResponse.redirect(target, 302);
  res.headers.set('Cache-Control', 'no-store');
  res.cookies.set(NONCE_COOKIE, '', { httpOnly: true, path: '/api/integrations/meta', maxAge: 0 });
  return res;
}
