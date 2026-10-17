/**
 * GET /api/cron/meta — every 10 minutes (Vercel Cron on Pro, or an external scheduler such as cron-job.org).
 * Needs `Authorization: Bearer $CRON_SECRET`. Processes due Meta lead-queue items (pending, and failed whose back-off
 * elapsed; ≤ 200 per run), then per connected Page a quick check of the last 2 hours or, once a day, a 7-day deep
 * check (idempotent). Skips everything when no Meta app is configured.
 */
import { NextResponse } from 'next/server';
import { recordJobRejected, recordJobRun, summarize } from '@/server/platform/health';
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
    await recordJobRejected('meta');
    return NextResponse.json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Unauthorized' }, { status: 401 });
  }
  const started = Date.now();
  try {
    const data = await runMetaCron({ deadline: Date.now() + BUDGET_MS });
    await recordJobRun('meta', started, true, summarize(data));
    return NextResponse.json({ status: 'success', data });
  } catch (e: any) {
    console.error('[cron:meta]', e);
    await recordJobRun('meta', started, false, 'Meta cron failed', e?.message || String(e));
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Meta cron failed' }, { status: 500 });
  }
}
