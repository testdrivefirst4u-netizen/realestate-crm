/** GET /api/integrations/linkedin/connect — "Connect LinkedIn" of Settings › Social accounts (settings.edit). */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { readCookie } from '@/server/core/oauthState';
import { SOCIAL_COOKIE_PATH, SOCIAL_NONCE_COOKIE } from '@/server/modules/socialOAuth';
import { startLinkedInConnect } from '@/server/modules/linkedin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  let r;
  try {
    r = await startLinkedInConnect({ sessionCookie: readCookie(req.headers.get('cookie'), CFG.SESSION_COOKIE), leads: new URL(req.url).searchParams.get('leads') === '1' });
  } catch (e: any) {
    console.error('[linkedin:connect]', e?.message);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Could not start the LinkedIn sign-in' }, { status: 500 });
  }
  const res = NextResponse.redirect(r.redirect, 302);
  res.headers.set('Cache-Control', 'no-store');
  if (r.nonce) res.cookies.set(SOCIAL_NONCE_COOKIE, r.nonce, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: SOCIAL_COOKIE_PATH, maxAge: 600 });
  return res;
}
