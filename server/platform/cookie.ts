/** The super admin session cookie (httpOnly, SameSite=Strict) — written by /api/platform/rpc and the unified /api/auth/login. */
import type { NextResponse } from 'next/server';

export const PLATFORM_COOKIE = 'platform_session';

export function setPlatformSessionCookie(res: NextResponse, session: { token: string; expiresAt: string }) {
  res.cookies.set(PLATFORM_COOKIE, session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: new Date(session.expiresAt),
  });
}

export function clearPlatformSessionCookie(res: NextResponse) {
  res.cookies.set(PLATFORM_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
}
