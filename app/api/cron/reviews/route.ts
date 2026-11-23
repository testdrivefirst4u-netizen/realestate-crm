/**
 * GET /api/cron/reviews — near-instant AI auto-reply to new Google reviews (Vercel Cron, every ~10 min).
 * Needs `Authorization: Bearer $CRON_SECRET`. For each active company it calls autoReplyReviews(), which is cheap and
 * returns at once unless that company has turned Auto-reply on (default off) — only then does it read Google and post.
 */
import { NextResponse } from 'next/server';
import { recordJobRejected, recordJobRun, summarize } from '@/server/platform/health';
import { runWithTenant } from '@/server/core/tenant';
import { listActiveTenants } from '@/server/platform/registry';
import { autoReplyReviews } from '@/server/modules/businessReviews';
import { safeEqual } from '@/server/core/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get('authorization') || '', `Bearer ${secret}`)) {
    await recordJobRejected('reviews');
    return NextResponse.json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Unauthorized' }, { status: 401 });
  }
  const started = Date.now();
  const results: Record<string, unknown> = {};
  let failed = 0;
  let replied = 0;
  for (const tenant of await listActiveTenants()) {
    try {
      const r = await runWithTenant(tenant, () => autoReplyReviews());
      if (r.replied) { results[tenant.slug] = r; replied += r.replied; }
    } catch (e: any) {
      failed++;
      results[tenant.slug] = { error: 'failed' };
      console.error(`[cron:reviews] ${tenant.slug}`, e);
    }
  }
  const data = { replied, failed, results };
  await recordJobRun('reviews', started, !failed, summarize(data));
  return NextResponse.json({ status: failed ? 'error' : 'success', data }, { status: failed ? 500 : 200 });
}
