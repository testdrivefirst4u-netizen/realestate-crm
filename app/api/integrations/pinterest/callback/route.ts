/**
 * GET /api/integrations/pinterest/callback — Pinterest OAuth redirect URI (Super admin › Settings › Marketing apps shows it).
 * Always redirects to Settings › Social accounts; the nonce cookie is cleared.
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { readCookie } from '@/server/core/oauthState';
import { SOCIAL_COOKIE_PATH, SOCIAL_NONCE_COOKIE, socialSettingsRedirect } from '@/server/modules/socialOAuth';
import { finishPinterestConnect } from '@/server/modules/pinterest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const cookie = req.headers.get('cookie');
  let target: string;
  try {
    target = (await finishPinterestConnect({ params: new URL(req.url).searchParams, sessionCookie: readCookie(cookie, CFG.SESSION_COOKIE), nonceCookie: readCookie(cookie, SOCIAL_NONCE_COOKIE) })).redirect;
  } catch (e: any) {
    console.error('[pinterest:callback]', e?.message);
    target = socialSettingsRedirect({ pinterestError: 'Something went wrong while connecting Pinterest. Please try again.' });
  }
  const res = NextResponse.redirect(target, 302);
  res.headers.set('Cache-Control', 'no-store');
  res.cookies.set(SOCIAL_NONCE_COOKIE, '', { httpOnly: true, path: SOCIAL_COOKIE_PATH, maxAge: 0 });
  return res;
}
