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
import { runConversionsCron } from '@/server/modules/adConversions';
import { runInboxCron } from '@/server/modules/socialInbox';
import { runLinkedInCron } from '@/server/modules/linkedin';
import { runPostsCron } from '@/server/modules/socialPosts';

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
    const meta = await runMetaCron({ deadline: Date.now() + BUDGET_MS });
    // lead results that could not be sent to Meta at once (no Meta app needed for these)
    const conversions = await runConversionsCron().catch((e) => { console.error('[cron:meta] conversions', e); return { error: 'failed' }; });
    // Google reviews for the social inbox
    const inbox = await runInboxCron().catch((e) => { console.error('[cron:meta] inbox', e); return { error: 'failed' }; });
    // LinkedIn Lead Gen Form leads
    const linkedin = await runLinkedInCron().catch((e) => { console.error('[cron:meta] linkedin', e); return { error: 'failed' }; });
    // scheduled social posts that are due
    const posts = await runPostsCron().catch((e) => { console.error('[cron:meta] posts', e); return { error: 'failed' }; });
    const extra = { ...(Object.keys(conversions).length ? { conversions } : {}), ...(Object.keys(inbox).length ? { inbox } : {}), ...(Object.keys(linkedin).length ? { linkedin } : {}), ...(Object.keys(posts).length ? { posts } : {}) };
    const data = Object.keys(extra).length ? { ...meta, ...extra } : meta;
    await recordJobRun('meta', started, true, summarize(data));
    return NextResponse.json({ status: 'success', data });
  } catch (e: any) {
    console.error('[cron:meta]', e);
    await recordJobRun('meta', started, false, 'Meta cron failed', e?.message || String(e));
    return NextResponse.json({ status: 'error', code: 'INTERNAL', message: 'Meta cron failed' }, { status: 500 });
  }
}
