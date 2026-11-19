/**
 * Public, no-login Client Report: /r/<slug>/<token> (optional ?m=YYYY-MM). The slug finds the company; the secret
 * token is verified against the company's (revocable) share settings. Turning sharing off or rotating the token
 * breaks the link immediately. Never indexed.
 */
import type { Metadata } from 'next';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantBySlug } from '@/server/platform/registry';
import { clientReportByToken } from '@/server/modules/clientReport';
import { ReportDocument } from '../../_components/ReportDocument';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Marketing Report', robots: { index: false, follow: false } };

const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

function NotAvailable() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F2F7FB] p-6">
      <div className="max-w-md rounded-2xl border border-[#D3E3F0] bg-white p-8 text-center">
        <h1 className="text-lg font-bold text-[#0B2A44]">Report not available</h1>
        <p className="mt-2 text-sm text-[#5E778C]">This link is no longer active. Please ask for an up-to-date link.</p>
      </div>
    </div>
  );
}

export default async function PublicReportPage({ params, searchParams }: { params: Promise<{ slug: string; token: string }>; searchParams: Promise<{ m?: string }> }) {
  const { slug, token } = await params;
  const { m } = await searchParams;
  const month = isMonth(m) ? m : new Date().toISOString().slice(0, 7);

  const tenant = await getTenantBySlug(String(slug || '').toLowerCase());
  if (!tenant || tenant.status !== 'Active') return <NotAvailable />;

  try {
    const data = await runWithTenant(tenant, () => clientReportByToken(String(token || ''), month));
    return <main className="min-h-screen bg-[#F2F7FB]"><ReportDocument r={data} /></main>;
  } catch {
    return <NotAvailable />;
  }
}
