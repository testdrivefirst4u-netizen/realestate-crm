/**
 * GET /api/cron/campaigns — one batch of WhatsApp campaign sending for every company that has some, then hands over to the next
 * batch while work remains. Started when a campaign starts; needs `Authorization: Bearer $CRON_SECRET`.
 */
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { safeEqual } from '@/server/core/utils';
import { listActiveTenants } from '@/server/platform/registry';
import { nudgeWorker, runCampaignsDue } from '@/server/modules/whatsappCampaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BUDGET_MS = 45000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !safeEqual(req.headers.get('authorization') || '', `Bearer ${secret}`)) {
    return NextResponse.json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Unauthorized' }, { status: 401 });
  }
  let sent = 0;
  let more = false;
  const tenants = (await listActiveTenants()).filter((t) => (t.features as any)?.whatsappCampaigns);
  const started = Date.now();
  for (const tenant of tenants) {
    const left = BUDGET_MS - (Date.now() - started);
    if (left < 2000) { more = true; break; }
    try {
      const r = await runWithTenant(tenant, () => runCampaignsDue(left));
      sent += r.sent;
      more = more || r.more;
    } catch (e: any) {
      console.error(`[cron:campaigns] ${tenant.slug}`, e?.message);
    }
  }
  // only while progress is being made, so a stuck campaign cannot keep calling itself forever
  if (more && sent > 0) await nudgeWorker();
  return NextResponse.json({ status: 'success', data: { sent, more } });
}
