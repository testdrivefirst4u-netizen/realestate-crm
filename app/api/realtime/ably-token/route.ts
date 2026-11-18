/**
 * GET /api/realtime/ably-token — the browser's Ably SDK calls this (as its authUrl) to get a short-lived, subscribe-only
 * token scoped to the signed-in user's company channel. The secret ABLY_API_KEY never leaves the server. 404 when
 * realtime is not configured (the client then stays on the 30s poll); 401 when not signed in.
 */
import { NextResponse } from 'next/server';
import { CFG } from '@/server/core/config';
import { readCookie, resolveCrmSession } from '@/server/core/oauthState';
import { ablyTokenRequest, realtimeEnabled } from '@/server/core/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!realtimeEnabled()) return NextResponse.json({ error: 'realtime not configured' }, { status: 404 });
  const sess = await resolveCrmSession(readCookie(req.headers.get('cookie'), CFG.SESSION_COOKIE));
  if (!sess) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const tokenRequest = await ablyTokenRequest(sess.tenant.id, `${sess.tenant.id}:${sess.user.id}`);
  if (!tokenRequest) return NextResponse.json({ error: 'realtime not configured' }, { status: 404 });
  return NextResponse.json(tokenRequest, { headers: { 'Cache-Control': 'no-store' } });
}
