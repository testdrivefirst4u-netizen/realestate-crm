/**
 * GET /api/integrations/meta/social/connect — "Connect with Facebook" of Settings › Social accounts (Pages and their
 * Instagram accounts for the social inbox and post scheduler; settings.edit). Facebook returns to the shared
 * /api/integrations/meta/callback.
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { NONCE_COOKIE, readCookie } from '@/server/modules/meta';
import { startSocialConnect } from '@/server/modules/socialAccounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  let r;
  try {
    r = await startSocialConnect({ sessionCookie: readCookie(req.headers.get('cookie'), CFG.SESSION_COOKIE) });
  } catch (e: any) {
    console.error('[meta:social-connect]', e?.message);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Could not start the Facebook login' }, { status: 500 });
  }
  const res = NextResponse.redirect(r.redirect, 302);
  res.headers.set('Cache-Control', 'no-store');
  if (r.nonce) res.cookies.set(NONCE_COOKIE, r.nonce, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/integrations/meta', maxAge: 600 });
  return res;
}
