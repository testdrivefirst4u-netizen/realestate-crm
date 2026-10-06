/**
 * GET /api/cron/sheets — every 5 minutes (Vercel Cron). Needs `Authorization: Bearer $CRON_SECRET`.
 * For every active company whose plan has `googleSheets`: due Google Sheet imports (interval elapsed) and due
 * exports (interval elapsed AND the company's data changed since the last export). Errors are isolated per
 * company and per link (recorded on the link: lastSyncResult / lastError) — e.g. a revoked "Connect with Google"
 * connection fails only the links that use it, with the reconnect message. Skips everything when the platform
 * has neither a Google service account nor an OAuth client.
 */
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { listActiveTenants } from '@/server/platform/registry';
import { googleStatus } from '@/server/integrations/google';
import { runDueSheetJobs } from '@/server/modules/sheets';
import { safeEqual } from '@/server/core/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Stop starting new jobs after this long, so the invocation finishes inside maxDuration. */
const BUDGET_MS = 240_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get('authorization') || '', `Bearer ${secret}`)) {
    return NextResponse.json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Unauthorized' }, { status: 401 });
  }
  const google = await googleStatus();
  // links reach Google through the service account or a company's OAuth connection (needs the OAuth client)
  if (!google.configured && !google.oauthConfigured) {
    return NextResponse.json({ status: 'success', data: { skipped: 'Google is not configured (no service account and no OAuth client)', companies: 0, failed: 0, results: {} } });
  }
  const deadline = Date.now() + BUDGET_MS;
  const results: Record<string, unknown> = {};
  let failed = 0;
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.googleSheets) continue;
    try {
      results[tenant.slug] = await runWithTenant(tenant, () => runDueSheetJobs({ deadline }));
    } catch (e: any) {
      failed++;
      results[tenant.slug] = { error: 'failed' };
      console.error(`[cron:sheets] ${tenant.slug}`, e);
    }
  }
  return NextResponse.json({ status: failed ? 'error' : 'success', data: { companies: Object.keys(results).length, failed, results } }, { status: failed ? 500 : 200 });
}
