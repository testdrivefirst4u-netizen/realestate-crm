'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { CompanyDetail, CompanyUser } from '@/server/platform/contract';
import { call, useResource } from '../../../_lib/api';
import { initials, planName } from '../../../_lib/format';
import { AuditTable } from '../../../_components/AuditTable';
import { Card, ErrorBox, Pill, Skeleton, StatusBadge, cx, focusRing } from '../../../_components/ui';
import { DangerTab } from '../_components/DangerTab';
import { FeaturesTab } from '../_components/FeaturesTab';
import { IntegrationsTab } from '../_components/IntegrationsTab';
import { OverviewTab } from '../_components/OverviewTab';
import { Tabs, type TabDef } from '../_components/Tabs';
import { UsersTab } from '../_components/UsersTab';

type TabId = 'overview' | 'features' | 'integrations' | 'users' | 'audit' | 'danger';
const TABS: TabDef<TabId>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'features', label: 'Features' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit' },
  { id: 'danger', label: 'Danger zone', danger: true },
];

function CompanyAudit({ id }: { id: string }) {
  const audit = useResource(() => call('auditLog', { companyId: id, limit: 200 }), [id]);
  return (
    <Card>
      <ErrorBox message={audit.error} onRetry={audit.reload} className="m-4" />
      <AuditTable entries={audit.data} loading={audit.loading} hideCompany />
    </Card>
  );
}

export function CompanyDetailClient() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params?.id ?? ''));
  const company = useResource(() => call('getCompany', { id }), [id]);
  const plans = useResource(() => call('listPlans', {}), []);
  const [tab, setTab] = useState<TabId>('overview');

  // Deep-link to a tab with #users, #features, …
  useEffect(() => {
    const h = window.location.hash.slice(1) as TabId;
    if (TABS.some((t) => t.id === h)) setTab(h);
  }, []);
  const selectTab = (t: TabId) => {
    setTab(t);
    window.history.replaceState(null, '', `#${t}`);
  };

  const c = company.data;
  useEffect(() => {
    if (c) document.title = `${c.name} · Super Admin`;
  }, [c]);

  const onSaved = (updated: CompanyDetail) => company.setData(updated);
  const onUsers = (users: CompanyUser[]) => {
    if (!c) return;
    company.setData({ ...c, users, activeUsers: users.filter((u) => u.status === 'Active').length });
  };

  const back = (
    <Link href="/superadmin/companies" className={cx('inline-flex items-center gap-1.5 rounded text-[13.5px] font-medium text-[#6B6158] hover:text-[#1D2F3F]', focusRing)}>
      <ArrowLeft className="h-4 w-4" aria-hidden /> Companies
    </Link>
  );

  if (!c) {
    return (
      <>
        <div className="mb-3">{back}</div>
        {company.error ? (
          <ErrorBox message={company.error} onRetry={company.reload} />
        ) : (
          <div role="status" aria-label="Loading company" className="space-y-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-14 w-14 rounded-xl" />
              <div className="space-y-2">
                <Skeleton className="h-6 w-56" />
                <Skeleton className="h-4 w-32" />
              </div>
            </div>
            <Skeleton className="h-10 w-full max-w-lg" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="mb-3">{back}</div>
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[#E4DCD2] bg-white">
          {c.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.logo} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <span aria-hidden className="text-[17px] font-semibold text-[#8F6C49]">
              {initials(c.name)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[1.5rem]">{c.name}</h1>
            <StatusBadge status={c.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-[#6B6158]">
            <span className="font-mono">{c.slug}</span>
            <span aria-hidden>·</span>
            <span>
              Plan <Pill>{planName(plans.data, c.plan)}</Pill>
            </span>
            {c.tagline && (
              <>
                <span aria-hidden>·</span>
                <span className="italic">{c.tagline}</span>
              </>
            )}
          </p>
        </div>
      </header>

      {c.status === 'Suspended' && (
        <div role="status" className="mb-5 rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-[14px] text-[#93370D]">
          This company is suspended — its users cannot sign in. Reactivate it from the Danger zone tab.
        </div>
      )}
      <ErrorBox message={company.error} onRetry={company.reload} className="mb-4" />

      <Tabs tabs={TABS} value={tab} onChange={selectTab} idPrefix="co" />
      <div role="tabpanel" id={`co-panel-${tab}`} aria-labelledby={`co-tab-${tab}`} tabIndex={-1} className="pt-6 outline-none">
        {tab === 'overview' && <OverviewTab company={c} plans={plans.data || []} onSaved={onSaved} />}
        {tab === 'features' && <FeaturesTab company={c} plans={plans.data || []} onSaved={onSaved} />}
        {tab === 'integrations' && <IntegrationsTab company={c} onSaved={onSaved} />}
        {tab === 'users' && <UsersTab company={c} onChange={onUsers} />}
        {tab === 'audit' && <CompanyAudit id={c.id} />}
        {tab === 'danger' && <DangerTab company={c} onSaved={onSaved} />}
      </div>
    </>
  );
}
