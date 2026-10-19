'use client';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, ArrowRight, Building2, CheckCircle2, CircleDollarSign, Database, Plus, Receipt, Search, ServerCrash, Users, UserX, Zap } from 'lucide-react';
import type { CompanySummary, Plan } from '@/server/platform/contract';
import { call, useResource } from '../_lib/api';
import { fmtMB, fmtNum, fmtPrice, initials, planName } from '../_lib/format';
import { AuditTable } from '../_components/AuditTable';
import { useAdmin } from '../_components/ConsoleShell';
import { Card, CardHeader, EmptyState, ErrorBox, LinkButton, Pill, Skeleton, StatCard, StatusBadge, cx, focusRing } from '../_components/ui';

const AVATAR = ['#0B6BB0', '#0E8A7D', '#5B4BC4', '#C2410C', '#0A1F33', '#9D174D'];
const tint = (name: string) => AVATAR[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR.length];

/** One company: status, seats against the plan limit, leads, storage and plan. The whole card opens the company. */
function CompanyCard({ c, plans }: { c: CompanySummary; plans: Plan[] | null }) {
  const href = `/superadmin/companies/${encodeURIComponent(c.id)}`;
  const limited = c.maxUsers > 0;
  const pct = limited ? Math.min(100, Math.round((c.activeUsers / c.maxUsers) * 100)) : 0;
  const full = limited && c.activeUsers >= c.maxUsers;
  return (
    <article className="group relative flex flex-col gap-4 rounded-2xl border border-[#DCE8F2] bg-white p-5 shadow-[0_1px_3px_rgba(10,31,51,0.05)] transition-all hover:-translate-y-0.5 hover:border-[#B9D9F2] hover:shadow-[0_14px_30px_-14px_rgba(10,31,51,0.25)]">
      <div className="flex items-center gap-3">
        <div aria-hidden className="flex h-11 w-11 flex-none items-center justify-center rounded-xl text-[15px] font-bold text-white" style={{ background: tint(c.name) }}>
          {initials(c.name)}
        </div>
        <div className="min-w-0 flex-1">
          {/* The link covers the card (after:inset-0), so the whole card is one keyboard stop. */}
          <Link href={href} className={cx('block truncate rounded text-[16px] font-semibold text-[#0A1F33] after:absolute after:inset-0 after:rounded-2xl', focusRing)}>
            {c.name}
          </Link>
          <span className="block truncate font-mono text-[12px] text-[#5E778C]">{c.slug}</span>
        </div>
        <StatusBadge status={c.status} />
      </div>
      <dl className="grid grid-cols-3 gap-2 rounded-xl bg-[#F5F9FC] p-3">
        <div>
          <dt className="text-[11.5px] font-medium text-[#5E778C]">Leads</dt>
          <dd className="text-[16px] font-bold tabular-nums text-[#0A1F33]">{fmtNum(c.leads)}</dd>
        </div>
        <div>
          <dt className="text-[11.5px] font-medium text-[#5E778C]">Users</dt>
          <dd className={cx('text-[16px] font-bold tabular-nums', full ? 'text-[#B54708]' : 'text-[#0A1F33]')}>
            {fmtNum(c.activeUsers)}
            {limited && <span className="text-[12px] font-medium text-[#5E778C]">/{fmtNum(c.maxUsers)}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-[11.5px] font-medium text-[#5E778C]">Storage</dt>
          <dd className="text-[16px] font-bold tabular-nums text-[#0A1F33]">{fmtMB(c.storageMB)}</dd>
        </div>
      </dl>
      {limited && (
        <div className="h-1.5 overflow-hidden rounded-full bg-[#E3EDF5]" aria-hidden>
          <div className={cx('h-1.5 rounded-full', full ? 'bg-[#E08A2C]' : 'bg-[#36B3F2]')} style={{ width: `${Math.max(pct, 4)}%` }} />
        </div>
      )}
      <div className="flex items-center justify-between text-[13px] text-[#4E6779]">
        <Pill>{planName(plans, c.plan)}</Pill>
        <span className="inline-flex items-center gap-1 font-medium text-[#0B6BB0] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
          Open <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </article>
  );
}

interface Attention { key: string; tone: 'red' | 'amber'; icon: ReactNode; title: string; detail: string; href: string }

export function DashboardClient() {
  const admin = useAdmin();
  const dash = useResource(() => call('dashboard', {}), []);
  const companies = useResource(() => call('listCompanies', {}), []);
  const plans = useResource(() => call('listPlans', {}), []);
  const health = useResource(() => call('platformHealth', {}), []);
  const billing = useResource(() => call('billingOverview', {}), []);
  const [q, setQ] = useState('');
  const d = dash.data;
  const firstName = admin?.name.split(/\s+/)[0] || '';
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = companies.data || [];
    return term ? list.filter((c) => c.name.toLowerCase().includes(term) || c.slug.toLowerCase().includes(term)) : list;
  }, [companies.data, q]);

  // what needs a look: failing / late jobs, stuck Facebook leads, overdue invoices, suspended or full companies
  const attention = useMemo<Attention[]>(() => {
    const out: Attention[] = [];
    for (const j of health.data?.jobs || []) {
      if (j.status === 'failing' || j.status === 'late') {
        out.push({ key: 'job-' + j.id, tone: j.status === 'failing' ? 'red' : 'amber', icon: <ServerCrash className="h-4 w-4" />, title: `${j.label} ${j.status === 'failing' ? 'is failing' : 'is running late'}`, detail: j.lastError || 'Check the scheduled jobs', href: '/superadmin/health' });
      }
    }
    const mq = health.data?.metaQueue;
    if (mq && mq.failed > 0) out.push({ key: 'meta', tone: 'red', icon: <Zap className="h-4 w-4" />, title: `${fmtNum(mq.failed)} Facebook lead${mq.failed === 1 ? '' : 's'} not imported`, detail: 'Retried automatically; open a company › Settings › Facebook sync to check', href: '/superadmin/health' });
    const b = billing.data;
    if (b && b.overdueCount > 0) out.push({ key: 'overdue', tone: 'red', icon: <Receipt className="h-4 w-4" />, title: `${b.overdueCount} overdue invoice${b.overdueCount === 1 ? '' : 's'}`, detail: `${fmtPrice(b.overdue, b.currency)} outstanding`, href: '/superadmin/billing' });
    if (b && b.trialsEnding > 0) out.push({ key: 'trials', tone: 'amber', icon: <CircleDollarSign className="h-4 w-4" />, title: `${b.trialsEnding} trial${b.trialsEnding === 1 ? '' : 's'} ending soon`, detail: 'Follow up before they lapse', href: '/superadmin/billing' });
    for (const c of companies.data || []) {
      if (c.status === 'Suspended') out.push({ key: 'sus-' + c.id, tone: 'amber', icon: <UserX className="h-4 w-4" />, title: `${c.name} is suspended`, detail: 'Its users cannot sign in', href: `/superadmin/companies/${encodeURIComponent(c.id)}` });
      else if (c.maxUsers > 0 && c.activeUsers >= c.maxUsers) out.push({ key: 'full-' + c.id, tone: 'amber', icon: <Users className="h-4 w-4" />, title: `${c.name} has used every seat`, detail: `${c.activeUsers} of ${c.maxUsers} users — raise the limit or change plan`, href: `/superadmin/companies/${encodeURIComponent(c.id)}` });
    }
    const errs = health.data?.errors.length || 0;
    if (errs > 0) out.push({ key: 'errors', tone: 'amber', icon: <AlertTriangle className="h-4 w-4" />, title: `${errs} recent error${errs === 1 ? '' : 's'} across companies`, detail: 'See the latest in Platform health', href: '/superadmin/health' });
    return out;
  }, [health.data, billing.data, companies.data]);
  const attentionLoading = (health.loading && !health.data) || (billing.loading && !billing.data);

  return (
    <div className="flex flex-col gap-6">
      {/* Welcome */}
      <section className="relative overflow-hidden rounded-3xl bg-[#0A1F33] px-6 py-7 text-white shadow-[0_18px_40px_-20px_rgba(10,31,51,0.6)] sm:px-8">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full border-[40px] border-[#36B3F2]/10" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 right-40 h-56 w-56 rounded-full border-[32px] border-white/5" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-[#36B3F2]">{today}</div>
            <h1 className="mt-1.5 text-[1.8rem] font-bold leading-tight tracking-tight !text-white sm:text-[2.1rem]">{firstName ? `Welcome back, ${firstName}` : 'Dashboard'}</h1>
            <p className="mt-1.5 text-[15px] text-[#B9D4EA]">
              {d ? `${fmtNum(d.companies.active)} active compan${d.companies.active === 1 ? 'y' : 'ies'} · ${fmtNum(d.users)} users · ${fmtNum(d.leads)} leads on the platform` : <Skeleton className="inline-block h-4 w-64 bg-white/10 align-middle" />}
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <LinkButton href="/superadmin/health" variant="secondary" className="!border-white/15 !bg-white/10 !text-white hover:!bg-white/15" icon={<Activity className="h-4 w-4" aria-hidden />}>
              Platform health
            </LinkButton>
            <LinkButton href="/superadmin/companies/new" variant="sky" icon={<Plus className="h-4 w-4" aria-hidden />}>
              New company
            </LinkButton>
          </div>
        </div>
      </section>

      <ErrorBox message={dash.error || companies.error} onRetry={() => (dash.error ? dash.reload() : companies.reload())} />

      {/* Key numbers */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard label="Companies" icon={<Building2 className="h-[18px] w-[18px]" />} loading={!d} href="/superadmin/companies"
          value={d ? fmtNum(d.companies.total) : ''} note={d ? `${fmtNum(d.companies.active)} active · ${fmtNum(d.companies.suspended)} suspended` : ''} />
        <StatCard label="Monthly revenue" icon={<CircleDollarSign className="h-[18px] w-[18px]" />} tone="green" loading={!billing.data && billing.loading} href="/superadmin/billing"
          value={billing.data ? fmtPrice(billing.data.mrr, billing.data.currency) : '—'} note={billing.data ? `${billing.data.payingCompanies} paying compan${billing.data.payingCompanies === 1 ? 'y' : 'ies'}` : 'Billing not available'} />
        <StatCard label="Leads in all CRMs" icon={<Users className="h-[18px] w-[18px]" />} tone="navy" loading={!d}
          value={d ? fmtNum(d.leads) : ''} note={d ? `${fmtNum(d.users)} users signed up` : ''} />
        <StatCard label="Storage used" icon={<Database className="h-[18px] w-[18px]" />} tone="amber" loading={!d}
          value={d ? fmtMB(d.storageMB) : ''} note={plans.data ? `${fmtNum(plans.data.length)} plan${plans.data.length === 1 ? '' : 's'} on offer` : ''} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Companies */}
        <section aria-labelledby="dash-companies" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="dash-companies" className="text-[19px] font-bold text-[#0A1F33]">
              Companies
            </h2>
            <div className="relative">
              <label htmlFor="dash-search" className="sr-only">Search companies</label>
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7E93A6]" aria-hidden />
              <input
                id="dash-search"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search companies"
                className="h-11 w-64 max-w-full rounded-xl border border-[#C4D6E6] bg-white pl-10 pr-3.5 text-[14px] text-[#0F2233] placeholder:text-[#7E93A6] focus:border-[#0B6BB0] focus:outline-none focus:ring-2 focus:ring-[#0B6BB0]/30"
              />
            </div>
          </div>

          {!companies.data && companies.loading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="p-5">
                  <Skeleton className="h-11 w-44" />
                  <Skeleton className="mt-4 h-16 w-full" />
                  <Skeleton className="mt-4 h-4 w-24" />
                </Card>
              ))}
            </div>
          ) : shown.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {shown.map((c) => <CompanyCard key={c.id} c={c} plans={plans.data} />)}
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
                  action={<LinkButton href="/superadmin/companies/new" variant="sky" icon={<Plus className="h-4 w-4" aria-hidden />}>Create a company</LinkButton>}
                />
              </Card>
            )
          )}
        </section>

        {/* Needs attention */}
        <aside aria-labelledby="dash-attention" className="flex min-w-0 flex-col gap-4">
          <h2 id="dash-attention" className="text-[19px] font-bold text-[#0A1F33]">Needs attention</h2>
          <Card>
            {attentionLoading ? (
              <div className="space-y-3 p-5">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : attention.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#E7F7EF] text-[#067647]"><CheckCircle2 className="h-6 w-6" aria-hidden /></span>
                <p className="text-[15px] font-semibold text-[#0A1F33]">All clear</p>
                <p className="text-[13px] text-[#5E778C]">Jobs are running, no Facebook leads are stuck and no invoices are overdue.</p>
              </div>
            ) : (
              <ul className="divide-y divide-[#EEF4F9]">
                {attention.slice(0, 8).map((a) => (
                  <li key={a.key}>
                    <Link href={a.href} className={cx('flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-[#F7FAFD]', focusRing)}>
                      <span aria-hidden className={cx('mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg', a.tone === 'red' ? 'bg-[#FEF0EE] text-[#B42318]' : 'bg-[#FFF4E0] text-[#B54708]')}>{a.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-semibold text-[#0A1F33]">{a.title}</span>
                        <span className="block truncate text-[12.5px] text-[#5E778C]">{a.detail}</span>
                      </span>
                      <ArrowRight className="mt-2 h-4 w-4 flex-none text-[#7E93A6]" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

        </aside>
      </div>

        <Card aria-labelledby="dash-recent-audit">
          <CardHeader
            id="dash-recent-audit"
            title="Recent activity"
            actions={
              <Link href="/superadmin/audit" className={cx('inline-flex items-center gap-1 rounded text-[13.5px] font-medium text-[#0B5E9C] underline-offset-2 hover:underline', focusRing)}>
                Audit log <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
          />
          <AuditTable entries={d ? d.recentAudit.slice(0, 5) : null} loading={dash.loading} compact />
        </Card>
    </div>
  );
}
