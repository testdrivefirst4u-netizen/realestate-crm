/**
 * GET /api/integrations/meta/conversions/connect — "Connect with Facebook" of Settings › Ad conversions (settings.edit,
 * plan adConversions). Sets the short-lived httpOnly `meta_oauth_nonce` cookie and redirects to the Facebook dialog;
 * Facebook returns to the shared /api/integrations/meta/callback (no extra redirect URI to register).
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { NONCE_COOKIE, readCookie } from '@/server/modules/meta';
import { startCapiConnect } from '@/server/modules/adConversions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  let r;
  try {
    r = await startCapiConnect({ sessionCookie: readCookie(req.headers.get('cookie'), CFG.SESSION_COOKIE) });
  } catch (e: any) {
    console.error('[meta:capi-connect]', e?.message);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Could not start the Facebook login' }, { status: 500 });
  }
  const res = NextResponse.redirect(r.redirect, 302);
  res.headers.set('Cache-Control', 'no-store');
  if (r.nonce) {
    res.cookies.set(NONCE_COOKIE, r.nonce, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/integrations/meta', maxAge: 600 });
  }
  return res;
}
