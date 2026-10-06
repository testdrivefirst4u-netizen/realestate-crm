'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Building2, CheckCircle2, Database, PauseCircle, Plus, Users, Target } from 'lucide-react';
import { call, useResource } from '../_lib/api';
import { fmtMB, fmtNum } from '../_lib/format';
import { AuditTable } from '../_components/AuditTable';
import { CompaniesTable } from '../_components/CompaniesTable';
import { useAdmin } from '../_components/ConsoleShell';
import { Card, LinkButton, CardHeader, EmptyState, ErrorBox, PageHeader, Skeleton, TableSkeleton, cx, focusRing } from '../_components/ui';

function Stat({ label, value, icon, tone = 'navy', sub }: { label: string; value: ReactNode; icon: ReactNode; tone?: 'navy' | 'brass' | 'green' | 'amber'; sub?: string }) {
  const tones = {
    navy: 'bg-[#E8EDF2] text-[#1D2F3F]',
    brass: 'bg-[#F4EEE7] text-[#8F6C49]',
    green: 'bg-[#ECFDF3] text-[#067647]',
    amber: 'bg-[#FFFAEB] text-[#B54708]',
  };
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-[#6B6158]">{label}</p>
        <span aria-hidden className={cx('flex h-8 w-8 items-center justify-center rounded-lg', tones[tone])}>
          {icon}
        </span>
      </div>
      <p className="mt-2 text-[1.6rem] font-semibold leading-none tracking-tight text-[#14202B] tabular-nums">{value}</p>
      {sub && <p className="mt-1.5 text-[12.5px] text-[#7A6F64]">{sub}</p>}
    </Card>
  );
}

export function DashboardClient() {
  const admin = useAdmin();
  const dash = useResource(() => call('dashboard', {}), []);
  const plans = useResource(() => call('listPlans', {}), []);
  const d = dash.data;
  const firstName = admin?.name.split(/\s+/)[0] || '';

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Dashboard'}
        description="An overview of every company on the platform."
        actions={
          <LinkButton href="/superadmin/companies/new" icon={<Plus className="h-4 w-4" aria-hidden />}>
            New company
          </LinkButton>
        }
      />
      <ErrorBox message={dash.error} onRetry={dash.reload} className="mb-6" />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
        {!d && dash.loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="mt-4 h-7 w-16" />
              </Card>
            ))
          : d && (
              <>
                <Stat label="Companies" value={fmtNum(d.companies.total)} icon={<Building2 className="h-4 w-4" />} />
                <Stat label="Active" value={fmtNum(d.companies.active)} icon={<CheckCircle2 className="h-4 w-4" />} tone="green" />
                <Stat label="Suspended" value={fmtNum(d.companies.suspended)} icon={<PauseCircle className="h-4 w-4" />} tone="amber" />
                <Stat label="Users" value={fmtNum(d.users)} icon={<Users className="h-4 w-4" />} tone="brass" sub="Across all companies" />
                <Stat label="Leads" value={fmtNum(d.leads)} icon={<Target className="h-4 w-4" />} tone="brass" />
                <Stat label="Storage" value={fmtMB(d.storageMB)} icon={<Database className="h-4 w-4" />} />
              </>
            )}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3" aria-labelledby="dash-recent-companies">
          <CardHeader
            id="dash-recent-companies"
            title="Recent companies"
            actions={
              <Link href="/superadmin/companies" className={cx('inline-flex items-center gap-1 rounded text-[13.5px] font-medium text-[#8F6C49] hover:underline underline-offset-2', focusRing)}>
                View all <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
          />
          {!d && dash.loading ? (
            <TableSkeleton rows={4} />
          ) : d && d.recentCompanies.length > 0 ? (
            <CompaniesTable companies={d.recentCompanies} plans={plans.data} compact />
          ) : (
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
          )}
        </Card>
        <Card className="xl:col-span-2" aria-labelledby="dash-recent-audit">
          <CardHeader
            id="dash-recent-audit"
            title="Recent activity"
            actions={
              <Link href="/superadmin/audit" className={cx('inline-flex items-center gap-1 rounded text-[13.5px] font-medium text-[#8F6C49] hover:underline underline-offset-2', focusRing)}>
                Audit log <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
          />
          <AuditTable entries={d?.recentAudit ?? null} loading={dash.loading} compact />
        </Card>
      </div>
    </>
  );
}
