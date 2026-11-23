/**
 * Public, no-login dashboard: /p/<slug>/<token>. The slug finds the company; the secret token is verified against the
 * company's revocable share settings. Shows the real Dashboard, Sales MIS, YTD/MTD and Pipeline screens, read-only,
 * with customer names masked and phone/e-mail removed. Recomputed on every load; the tab auto-refreshes. Never indexed.
 */
import type { Metadata } from 'next';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantBySlug } from '@/server/platform/registry';
import { publicAnalyticsByToken } from '@/server/modules/pipelineShare';
import { PublicAnalytics } from '../../_components/PublicAnalytics';
import { AutoRefresh } from '../../_components/AutoRefresh';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dashboard', robots: { index: false, follow: false } };

function NotAvailable() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F2F7FB] p-6">
      <div className="max-w-md rounded-2xl border border-[#D3E3F0] bg-white p-8 text-center">
        <h1 className="text-lg font-bold text-[#0B2A44]">Dashboard not available</h1>
        <p className="mt-2 text-sm text-[#5E778C]">This link is no longer active. Please ask for an up-to-date link.</p>
      </div>
    </div>
  );
}

export default async function PublicDashboardPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const tenant = await getTenantBySlug(String(slug || '').toLowerCase());
  if (!tenant || tenant.status !== 'Active') return <NotAvailable />;
  try {
    const data = await runWithTenant(tenant, () => publicAnalyticsByToken(String(token || '')));
    return (<><AutoRefresh /><PublicAnalytics {...data} /></>);
  } catch {
    return <NotAvailable />;
  }
}
