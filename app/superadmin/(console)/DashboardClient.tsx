'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, Building2, Plus, Search } from 'lucide-react';
import type { CompanySummary, Plan } from '@/server/platform/contract';
import { call, useResource } from '../_lib/api';
import { fmtMB, fmtNum, initials, planName } from '../_lib/format';
import { AuditTable } from '../_components/AuditTable';
import { useAdmin } from '../_components/ConsoleShell';
import { Card, CardHeader, EmptyState, ErrorBox, LinkButton, Pill, Skeleton, StatusBadge, cx, focusRing } from '../_components/ui';

/** One company: status, seats used against the plan limit, leads and plan. The whole card opens the company. */
function CompanyCard({ c, plans }: { c: CompanySummary; plans: Plan[] | null }) {
  const href = `/superadmin/companies/${encodeURIComponent(c.id)}`;
  const limited = c.maxUsers > 0;
  const pct = limited ? Math.min(100, Math.round((c.activeUsers / c.maxUsers) * 100)) : 0;
  const full = limited && c.activeUsers >= c.maxUsers;
  return (
    <article className="relative flex flex-col gap-3.5 rounded-2xl border border-[#E4DCD2] bg-white p-[18px] transition-shadow hover:shadow-[0_6px_20px_rgba(29,47,63,0.08)]">
      <div className="flex items-center gap-3">
        <div aria-hidden className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-[10px] bg-[#1D2F3F] text-[15px] font-bold text-white">
          {initials(c.name)}
        </div>
        <div className="min-w-0 flex-1">
          {/* The link covers the card (after:inset-0), so the whole card is one keyboard stop. */}
          <Link href={href} className={cx('block truncate rounded text-[16px] font-semibold text-[#14202B] after:absolute after:inset-0 after:rounded-2xl', focusRing)}>
            {c.name}
          </Link>
          <span className="block truncate font-mono text-[12px] text-[#7A6F64]">{c.slug}</span>
        </div>
        <StatusBadge status={c.status} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between text-[13px] text-[#6B6158]">
          <span>Seats</span>
          <span className={cx('tabular-nums', full && 'font-medium text-[#B54708]')}>
            {limited ? `${fmtNum(c.activeUsers)} of ${fmtNum(c.maxUsers)}` : `${fmtNum(c.activeUsers)} · no limit`}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#EFE8DF]" aria-hidden>
          {limited && <div className={cx('h-1.5 rounded-full', full ? 'bg-[#C9781F]' : 'bg-[#A9825A]')} style={{ width: `${Math.max(pct, 4)}%` }} />}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-[#F1EBE3] pt-3 text-[13px] text-[#6B6158]">
        <span>
          <strong className="font-semibold tabular-nums text-[#14202B]">{fmtNum(c.leads)}</strong> leads · {fmtMB(c.storageMB)}
        </span>
        <Pill>{planName(plans, c.plan)}</Pill>
      </div>
    </article>
  );
}

export function DashboardClient() {
  const admin = useAdmin();
  const dash = useResource(() => call('dashboard', {}), []);
  const companies = useResource(() => call('listCompanies', {}), []);
  const plans = useResource(() => call('listPlans', {}), []);
  const [q, setQ] = useState('');
  const d = dash.data;
  const firstName = admin?.name.split(/\s+/)[0] || '';

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = companies.data || [];
    return term ? list.filter((c) => c.name.toLowerCase().includes(term) || c.slug.toLowerCase().includes(term)) : list;
  }, [companies.data, q]);

  const totals = d
    ? [
        { label: 'Users', value: fmtNum(d.users) },
        { label: 'Leads', value: fmtNum(d.leads) },
        { label: 'Storage', value: fmtMB(d.storageMB) },
        { label: 'Plans', value: plans.data ? fmtNum(plans.data.length) : '—' },
      ]
    : null;

  return (
    <>
      {/* Summary strip */}
      <div className="border-b border-[#E4DCD2] bg-[#F4F0EB]">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-6 px-4 py-8 sm:px-8">
          <div>
            <h1 className="text-[1.75rem] font-semibold leading-tight text-[#14202B] sm:text-[1.9rem]">{firstName ? `Welcome back, ${firstName}` : 'Dashboard'}</h1>
            <div className="mt-1.5 text-[15px] text-[#5E534B]">
              {d ? `${fmtNum(d.companies.total)} companies · ${fmtNum(d.companies.active)} active · ${fmtNum(d.companies.suspended)} suspended` : <Skeleton className="inline-block h-4 w-56 align-middle" />}
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-4">
            {(totals || Array.from({ length: 4 }, (_, i) => ({ label: String(i), value: '' }))).map((t) => (
              <div key={t.label} className="flex flex-col-reverse gap-0.5">
                <dt className="text-[13px] text-[#6B6158]">{totals ? t.label : <Skeleton className="h-3.5 w-12" />}</dt>
                <dd className="text-[1.6rem] font-semibold leading-tight tabular-nums text-[#14202B]">{totals ? t.value : <Skeleton className="h-7 w-14" />}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-4 pb-10 pt-7 sm:px-8">
        <ErrorBox message={dash.error || companies.error} onRetry={() => (dash.error ? dash.reload() : companies.reload())} />

        <section aria-labelledby="dash-companies" className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="dash-companies" className="text-[20px] font-semibold text-[#14202B]">
              Companies
            </h2>
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative">
                <label htmlFor="dash-search" className="sr-only">
                  Search companies
                </label>
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A7F77]" aria-hidden />
                <input
                  id="dash-search"
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search companies"
                  className="h-11 w-64 max-w-full rounded-[10px] border border-[#C9BEB2] bg-white pl-10 pr-3.5 text-[14px] text-[#26211E] placeholder:text-[#8A7F77] focus:border-[#A9825A] focus:outline-none focus:ring-2 focus:ring-[#A9825A]/40"
                />
              </div>
              <LinkButton href="/superadmin/companies/new" icon={<Plus className="h-4 w-4" aria-hidden />}>
                New company
              </LinkButton>
            </div>
          </div>

          {!companies.data && companies.loading ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="p-5">
                  <Skeleton className="h-10 w-40" />
                  <Skeleton className="mt-5 h-2 w-full" />
                  <Skeleton className="mt-5 h-4 w-28" />
                </Card>
              ))}
            </div>
          ) : shown.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((c) => (
                <CompanyCard key={c.id} c={c} plans={plans.data} />
              ))}
            </div>
          ) : companies.data && companies.data.length > 0 ? (
            <Card>
              <EmptyState icon={<Search className="h-5 w-5" aria-hidden />} title="No matching companies" description={`Nothing matches “${q.trim()}”.`} />
            </Card>
          ) : (
            companies.data && (
              <Card>
                <EmptyState
                  icon={<Building2 className="h-5 w-5" aria-hidden />}
                  title="No companies yet"
                  description="Create the first company to give its team a CRM workspace."
                  action={
                    <Link href="/superadmin/companies/new" className={cx('rounded text-[14px] font-medium text-[#8F6C49] underline underline-offset-2', focusRing)}>
                      Create a company
                    </Link>
                  }
                />
              </Card>
            )
          )}
        </section>

        <Card aria-labelledby="dash-recent-audit">
          <CardHeader
            id="dash-recent-audit"
            title="Recent activity"
            actions={
              <Link href="/superadmin/audit" className={cx('inline-flex items-center gap-1 rounded text-[13.5px] font-medium text-[#8F6C49] hover:underline underline-offset-2', focusRing)}>
                Audit log <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
          />
          <AuditTable entries={d ? d.recentAudit.slice(0, 5) : null} loading={dash.loading} compact />
        </Card>
      </div>
    </>
  );
}
