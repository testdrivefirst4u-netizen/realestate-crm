/**
 * GET /api/cron/meta — every 5 minutes (Vercel Cron). Needs `Authorization: Bearer $CRON_SECRET`.
 * Processes due Meta lead-queue items (pending, and failed whose back-off elapsed; ≤ 200 per run) and, once a day
 * per connected Page, backfills the last 2 days (idempotent). Skips everything when no Meta app is configured.
 */
import { NextResponse } from 'next/server';
import { safeEqual } from '@/server/core/utils';
import { runMetaCron } from '@/server/modules/metaQueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Stop starting new work after this long, so the invocation finishes inside maxDuration. */
const BUDGET_MS = 240_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get('authorization') || '', `Bearer ${secret}`)) {
    return NextResponse.json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Unauthorized' }, { status: 401 });
  }
  try {
    const data = await runMetaCron({ deadline: Date.now() + BUDGET_MS });
    return NextResponse.json({ status: 'success', data });
  } catch (e: any) {
    console.error('[cron:meta]', e);
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Meta cron failed' }, { status: 500 });
  }
}
