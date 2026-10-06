/** GET /api/cron/daily — daily housekeeping + digest e-mail (Vercel Cron). Needs `Authorization: Bearer $CRON_SECRET`. */
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { listActiveTenants } from '@/server/platform/registry';
import { runDaily } from '@/server/modules/jobs';
import { safeEqual } from '@/server/core/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get('authorization') || '', `Bearer ${secret}`)) {
    return NextResponse.json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Unauthorized' }, { status: 401 });
  }
  // Run the job once per active company, each inside its own database.
  const results: Record<string, unknown> = {};
  let failed = 0;
  for (const tenant of await listActiveTenants()) {
    try {
      results[tenant.slug] = await runWithTenant(tenant, () => runDaily());
    } catch (e: any) {
      failed++;
      results[tenant.slug] = { error: 'failed' };
      console.error(`[cron] ${tenant.slug}`, e);
    }
  }
  return NextResponse.json({ status: failed ? 'error' : 'success', data: { companies: Object.keys(results).length, failed, results } }, { status: failed ? 500 : 200 });
}
