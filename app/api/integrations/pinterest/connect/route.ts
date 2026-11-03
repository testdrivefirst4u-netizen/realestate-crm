/** GET /api/integrations/pinterest/connect — "Connect Pinterest" of Settings › Social accounts (settings.edit). */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { readCookie } from '@/server/core/oauthState';
import { SOCIAL_COOKIE_PATH, SOCIAL_NONCE_COOKIE } from '@/server/modules/socialOAuth';
import { startPinterestConnect } from '@/server/modules/pinterest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  let r;
  try {
    r = await startPinterestConnect({ sessionCookie: readCookie(req.headers.get('cookie'), CFG.SESSION_COOKIE) });
  } catch (e: any) {
    console.error('[pinterest:connect]', e?.message);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Could not start the Pinterest sign-in' }, { status: 500 });
  }
  const res = NextResponse.redirect(r.redirect, 302);
  res.headers.set('Cache-Control', 'no-store');
  if (r.nonce) res.cookies.set(SOCIAL_NONCE_COOKIE, r.nonce, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: SOCIAL_COOKIE_PATH, maxAge: 600 });
  return res;
}
