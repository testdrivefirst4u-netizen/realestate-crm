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

/** Why leads were lost — the disqualified / lost stages with counts, from the server-computed pipeline. */
const DisqualReasons: React.FC<{ rows: PipelineData['byDisqualReason'] }> = ({ rows }) => {
  if (!rows?.length) return null;
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="mx-auto max-w-[1320px] px-4 pb-6 sm:px-6">
      <div className="rounded-2xl border border-[#E3EDF5] bg-white p-4 sm:p-5">
        <h3 className="text-[15px] font-bold text-[#0B2A44]">Why leads were disqualified</h3>
        <p className="mb-3 mt-0.5 text-xs text-[#5E778C]">The disqualified and lost stages, with how many leads are in each ({total} in total).</p>
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="truncate text-[#2B4A63]">{r.label}</span>
                <span className="flex-none tabular-nums text-[#5E778C]"><b className="text-[#0B2A44]">{r.count}</b> · {Math.round((r.count / total) * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-[#F4E3E3]"><div className="h-full rounded-full" style={{ width: `${Math.max(3, (r.count / max) * 100)}%`, background: '#C5221F' }} /></div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'mis', label: 'Sales MIS' },
  { id: 'performance', label: 'YTD / MTD' },
];

export function PublicAnalytics({ company, leads, sources, pipeline }: { company: string; leads: Lead[]; sources: string[]; pipeline?: PipelineData }) {
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
        {tab === 'dashboard' && <><DashboardView leads={leads} tasks={[]} rmOptions={rmOptions} sync={IDLE} userName={company} onRefresh={reload} onFilterClick={noop} onOpenLead={noop} publicView />{pipeline && <DisqualReasons rows={pipeline.byDisqualReason} />}</>}
        {tab === 'mis' && <MisView leads={leads} sources={sources} sync={IDLE} canSeeCalls={false} onRefresh={reload} onShowLeads={noop} canSeeSpend={false} canEditSpend={false} canSeeAdResults={false} />}
        {tab === 'performance' && <PerformanceView leads={leads} sync={IDLE} onRefresh={reload} onShowLeads={noop} />}
      </main>
    </div>
  );
}
