'use client';

import React, { useMemo, useState } from 'react';
import type { Lead } from '@/src/types/crm';
import type { PipelineData } from '@/src/core/api';
import { F } from '@/src/core/config';
import { DashboardView } from '@/src/modules/dashboard/DashboardView';
import { MisView } from '@/src/modules/mis/MisView';
import { PerformanceView } from '@/src/modules/mis/PerformanceView';

const IDLE = { status: 'idle' as const, hasLoadedOnce: true };
const noop = () => {};
const reload = () => window.location.reload();
type Tab = 'dashboard' | 'mis' | 'performance';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'mis', label: 'Sales MIS' },
  { id: 'performance', label: 'YTD / MTD' },
];

export function PublicAnalytics({ company, leads, sources }: { company: string; leads: Lead[]; sources: string[]; pipeline?: PipelineData }) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const rmOptions = useMemo(() => [...new Set(leads.map((l) => String(l[F.RM] || '').trim()).filter(Boolean))].sort(), [leads]);
  return (
    <div className="min-h-screen bg-[#F2F7FB]">
      <header className="sticky top-0 z-10 border-b border-[#D3E3F0] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2.5">
          <span className="text-sm font-bold text-[#0B2A44]">{company}</span>
          <nav className="flex flex-wrap gap-1" role="tablist" aria-label="Views">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${tab === t.id ? 'bg-[#1A73E8] text-white' : 'text-[#5F6368] hover:bg-[#F1F3F4]'}`}>{t.label}</button>
            ))}
          </nav>
          <span className="ml-auto hidden text-[11px] text-[#7E93A6] sm:inline">Live · refreshes on its own · read-only, no contact details</span>
        </div>
      </header>
      <main>
        {tab === 'dashboard' && <DashboardView leads={leads} tasks={[]} rmOptions={rmOptions} sync={IDLE} userName={company} onRefresh={reload} onFilterClick={noop} onOpenLead={noop} publicView />}
        {tab === 'mis' && <MisView leads={leads} sources={sources} sync={IDLE} canSeeCalls={false} onRefresh={reload} onShowLeads={noop} canSeeSpend={false} canEditSpend={false} canSeeAdResults={false} />}
        {tab === 'performance' && <PerformanceView leads={leads} sync={IDLE} onRefresh={reload} onShowLeads={noop} />}
      </main>
    </div>
  );
}
