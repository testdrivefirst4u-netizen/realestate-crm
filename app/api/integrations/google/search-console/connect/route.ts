/**
 * GET /api/integrations/google/search-console/connect — "Connect Search Console" of Settings › Google. Asks Google only
 * for Search Console (read only). Sets the `google_oauth_nonce` cookie and redirects to Google's consent screen; Google
 * returns to the shared /api/integrations/google/callback.
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { GOOGLE_COOKIE_PATH, GOOGLE_NONCE_COOKIE, readCookie } from '@/server/modules/googleConnect';
import { startSearchConsoleConnect } from '@/server/modules/searchConsole';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  let r;
  try {
    r = await startSearchConsoleConnect({ sessionCookie: readCookie(req.headers.get('cookie'), CFG.SESSION_COOKIE) });
  } catch (e: any) {
    console.error('[gsc:connect]', e?.message);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Could not start the Google sign-in' }, { status: 500 });
  }
  const res = NextResponse.redirect(r.redirect, 302);
  res.headers.set('Cache-Control', 'no-store');
  if (r.nonce) res.cookies.set(GOOGLE_NONCE_COOKIE, r.nonce, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: GOOGLE_COOKIE_PATH, maxAge: 600 });
  return res;
}
