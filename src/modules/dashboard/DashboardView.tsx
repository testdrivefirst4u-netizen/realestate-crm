import React, { useMemo, useState } from 'react';
import {
  Users, Flame, Sun, CheckCircle2, Building2, CalendarCheck, Clock, AlertTriangle, ListChecks, RefreshCw, TrendingUp, Target, Sparkles, PhoneCall, Trophy, UserX,
} from 'lucide-react';
import { Lead, TaskItem, SyncState } from '../../types/crm';
import { F } from '../../core/config';
import { computeKpis, monthlySeries, availableMonths } from '../../core/analytics';
import { formatDateTime, formatRelative, formatTime, getPresetRange, listMonths, currentMonthKey, previousMonthKey, monthLabel } from '../../core/dates';
import { formatHours, formatPercent, pctChange } from '../../core/format';
import { Bar, Button, Card, DateFilterValue, DateRangeFilter, EmptyState, ErrorState, KpiTile, Select, resolveDateFilter, StageBadge } from '../../components/ui';
import { PageSkeleton } from '../../components/Skeletons';

interface Props {
  leads: Lead[];
  tasks: TaskItem[];
  rmOptions: string[];
  sync: SyncState;
  greeting?: string;
  onRefresh: () => void;
  onFilterClick: (label: string, ids: string[]) => void;
  onOpenLead: (id: string) => void;
}

const PRESETS = [
  { id: 'today' as const, label: 'Today' },
  { id: 'yesterday' as const, label: 'Yesterday' },
  { id: 'this_week' as const, label: 'This Week' },
  { id: 'this_month' as const, label: 'This Month' },
  { id: 'last_month' as const, label: 'Last Month' },
  { id: 'this_quarter' as const, label: 'This Quarter' },
  { id: 'this_year' as const, label: 'This Year' },
  { id: 'all' as const, label: 'All Time' },
];

export const DashboardView: React.FC<Props> = ({ leads, tasks, rmOptions, sync, greeting, onRefresh, onFilterClick, onOpenLead }) => {
  const [filter, setFilter] = useState<DateFilterValue>({ preset: 'this_month' });
  const [rm, setRm] = useState('');
  const range = useMemo(() => resolveDateFilter(filter), [filter]);

  const kpi = useMemo(() => computeKpis(leads, tasks, range, { rm: rm || undefined }), [leads, tasks, range, rm]);
  const live = useMemo(() => computeKpis(leads, tasks, null, { rm: rm || undefined }), [leads, tasks, rm]); // all-time, for "now" numbers
  const today = useMemo(() => computeKpis(leads, tasks, getPresetRange('today'), { rm: rm || undefined }), [leads, tasks, rm]);

  // Previous comparable period for trend arrows (only for calendar presets)
  const prevKpi = useMemo(() => {
    const map: Record<string, any> = { today: 'yesterday', this_week: 'last_week', this_month: 'last_month', this_quarter: 'last_quarter' };
    const prevPreset = filter.preset !== 'custom' ? map[filter.preset] : undefined;
    if (!prevPreset) return null;
    return computeKpis(leads, tasks, getPresetRange(prevPreset), { rm: rm || undefined });
  }, [leads, tasks, filter.preset, rm]);
  const trend = (k: keyof typeof kpi, lowerIsBetter = false) =>
    prevKpi ? { value: pctChange(Number(prevKpi[k] || 0), Number(kpi[k] || 0)), lowerIsBetter } : undefined;

  const months = useMemo(() => {
    const all = availableMonths(leads, tasks);
    const end = currentMonthKey();
    let start = end;
    for (let i = 0; i < 5; i++) start = previousMonthKey(start);
    const list = listMonths(start, end);
    return all.length > list.length ? list : list; // always show last 6 months (even if empty)
  }, [leads, tasks]);
  const series = useMemo(() => monthlySeries(leads, tasks, months, { rm: rm || undefined }), [leads, tasks, months, rm]);

  const dueToday = useMemo(() => {
    const ids = new Set(today.ids.followupsDue);
    return leads.filter((l) => ids.has(l[F.ID])).sort((a, b) => String(a[F.NEXT_FOLLOWUP]).localeCompare(String(b[F.NEXT_FOLLOWUP])));
  }, [leads, today]);

  /* ----------------------------- states --------------------------------- */
  const noData = leads.length === 0 && tasks.length === 0;
  if (noData && (sync.status === 'loading' || (!sync.hasLoadedOnce && sync.status === 'syncing'))) return <PageSkeleton variant="dashboard" label="Loading live CRM data…" />;
  if (noData && (sync.status === 'error' || sync.status === 'offline' || sync.status === 'auth')) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <ErrorState title={sync.status === 'offline' ? 'You are offline' : 'Dashboard could not load'} message={sync.lastError || 'The backend did not respond. Check your connection and try again.'} onRetry={onRefresh} />
      </div>
    );
  }
  if (noData && sync.hasLoadedOnce) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <EmptyState title="No enquiries yet" description="The Enquiry Log is empty. Create the first enquiry with “New Enquiry”, import a CSV, or connect Chat360 to capture WhatsApp leads automatically." icon={<Users size={22} />} action={<Button variant="secondary" onClick={onRefresh} icon={<RefreshCw size={13} />}>Refresh</Button>} />
        </Card>
      </div>
    );
  }

  const rangeLabel = kpi.rangeLabel;
  const stale = sync.status === 'error' || sync.status === 'offline';

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">{greeting || 'Sales Dashboard'}</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5 flex items-center gap-2 flex-wrap">
            <span>Live from the CRM server</span>
            <span className="text-[#9E948D]">·</span>
            <span className={stale ? 'text-[#B06A55] font-semibold' : ''}>
              {sync.status === 'syncing' ? 'Syncing…' : sync.lastSyncAt ? `Updated ${formatRelative(sync.lastSyncAt)}` : 'Not synced yet'}
              {stale && ' (showing last known data)'}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DateRangeFilter value={filter} onChange={setFilter} presets={PRESETS} />
          <Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" />
          <Button variant="secondary" onClick={onRefresh} loading={sync.status === 'syncing'} icon={<RefreshCw size={13} />}>Refresh</Button>
        </div>
      </div>

      {stale && sync.lastError && <ErrorState compact title={sync.status === 'offline' ? 'Offline — live updates paused' : 'Last sync failed'} message={sync.lastError} onRetry={onRefresh} />}

      {/* Row 1 — Enquiries & pipeline */}
      <Card title={`Enquiries · ${rangeLabel}`} subtitle="Counts by current stage of the enquiries received in this period" actions={<span className="text-xs text-[#6B5F57]">Total: <strong className="text-[#1D2F3F]">{kpi.totalEnquiries}</strong></span>}>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <KpiTile label="Total Enquiries" value={kpi.totalEnquiries} tone="navy" icon={<Users size={12} />} trend={trend('totalEnquiries')} onClick={() => onFilterClick(`${rangeLabel} · Enquiries`, kpi.ids.enquiries)} />
          <KpiTile label="New" value={kpi.newLeads} tone="light" icon={<Sparkles size={12} />} onClick={() => onFilterClick(`${rangeLabel} · New`, kpi.ids.enquiries.filter((id) => leads.find((l) => l[F.ID] === id)?.[F.STAGE] === 'New'))} />
          <KpiTile label="Open Leads" value={kpi.openLeads} tone="white" icon={<Target size={12} />} trend={trend('openLeads')} onClick={() => onFilterClick(`${rangeLabel} · Open pipeline`, kpi.ids.open)} />
          <KpiTile label="Hot" value={kpi.hotLeads} tone="rust" icon={<Flame size={12} />} trend={trend('hotLeads')} onClick={() => onFilterClick(`${rangeLabel} · Hot`, kpi.ids.hot)} />
          <KpiTile label="Warm" value={kpi.warmLeads} tone="gold" icon={<Sun size={12} />} trend={trend('warmLeads')} onClick={() => onFilterClick(`${rangeLabel} · Warm`, kpi.ids.warm)} />
          <KpiTile label="Qualified" value={kpi.qualifiedLeads} tone="white" icon={<CheckCircle2 size={12} />} trend={trend('qualifiedLeads')} onClick={() => onFilterClick(`${rangeLabel} · Qualified`, kpi.ids.qualified)} />
          <KpiTile label="Bookings" value={kpi.bookings} tone="sage" icon={<Trophy size={12} />} trend={trend('bookings')} onClick={() => onFilterClick(`${rangeLabel} · Booked`, kpi.ids.booked)} />
          <KpiTile label="Lost / DQ" value={kpi.lostLeads} tone="white" icon={<UserX size={12} />} trend={trend('lostLeads', true)} onClick={() => onFilterClick(`${rangeLabel} · Lost`, kpi.ids.lost)} />
        </div>
      </Card>

      {/* Row 2 — Site visits, follow-ups, tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title={`Site Visits · ${rangeLabel}`} subtitle="By site-visit date (older rows fall back to enquiry date)">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiTile label="Site Visits" value={kpi.siteVisitsTotal} tone="navy" icon={<Building2 size={12} />} hint={`${formatPercent(kpi.siteVisitRate, 0)} of enquiries`} onClick={() => onFilterClick(`${rangeLabel} · Site visits`, [...kpi.ids.svScheduled, ...kpi.ids.svCompleted])} />
            <KpiTile label="Scheduled" value={kpi.siteVisitsScheduled} tone="gold" icon={<CalendarCheck size={12} />} trend={trend('siteVisitsScheduled')} onClick={() => onFilterClick(`${rangeLabel} · Visits scheduled`, kpi.ids.svScheduled)} />
            <KpiTile label="Completed" value={kpi.siteVisitsCompleted} tone="sage" icon={<CheckCircle2 size={12} />} trend={trend('siteVisitsCompleted')} onClick={() => onFilterClick(`${rangeLabel} · Visits completed`, kpi.ids.svCompleted)} />
            <KpiTile label="Prospects" value={kpi.siteVisitProspects} tone="light" icon={<Users size={12} />} onClick={() => onFilterClick(`${rangeLabel} · Site visit prospects`, kpi.ids.svProspects)} />
          </div>
        </Card>
        <Card title="Follow-ups & Tasks" subtitle={`Due in ${rangeLabel.toLowerCase()} · overdue is as of now`}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiTile label="Follow-ups Due" value={kpi.followupsDue} tone="gold" icon={<Clock size={12} />} onClick={() => onFilterClick(`${rangeLabel} · Follow-ups due`, kpi.ids.followupsDue)} />
            <KpiTile label="Overdue Now" value={live.followupsOverdue} tone="rust" icon={<AlertTriangle size={12} />} onClick={() => onFilterClick('Overdue follow-ups', live.ids.followupsOverdue)} />
            <KpiTile label="Follow-ups Done" value={kpi.followupsCompleted} tone="sage" icon={<PhoneCall size={12} />} trend={trend('followupsCompleted')} />
            <KpiTile label="Tasks" value={`${kpi.pendingTasks} / ${kpi.completedTasks}`} tone="white" icon={<ListChecks size={12} />} hint="pending / completed" />
          </div>
        </Card>
      </div>

      {/* Row 3 — rates + follow-ups today */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card title="Conversion" subtitle={rangeLabel} className="lg:col-span-1">
          <div className="grid grid-cols-2 gap-3">
            <KpiTile label="Conversion Rate" value={formatPercent(kpi.conversionRate, 1)} tone="sage" hint={`${kpi.bookings} bookings / ${kpi.totalEnquiries} enquiries`} trend={trend('conversionRate')} />
            <KpiTile label="Qualification" value={formatPercent(kpi.qualificationRate, 1)} tone="white" hint="Qualified + Booked" />
            <KpiTile label="Visit Rate" value={formatPercent(kpi.siteVisitRate, 1)} tone="white" hint="completed visits / enquiries" />
            <KpiTile label="Avg First Response" value={formatHours(kpi.avgResponseHours)} tone="white" hint="enquiry → first follow-up" />
          </div>
        </Card>

        <Card title={`Follow-ups due today (${dueToday.length})`} subtitle={formatDateTime(new Date()).slice(0, 11)} className="lg:col-span-2" padded>
          {dueToday.length === 0 ? (
            <EmptyState title="Nothing due today" description="Schedule the next follow-up from a lead's profile and it will appear here." icon={<Clock size={20} />} className="py-6" />
          ) : (
            <div className="divide-y divide-[#ECE8E1] max-h-64 overflow-y-auto -mx-2">
              {dueToday.map((l) => (
                <button key={l[F.ID]} onClick={() => onOpenLead(l[F.ID])} className="w-full flex items-center justify-between gap-3 px-2 py-2.5 hover:bg-[#F4F0EB] text-left">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#1D2F3F] truncate">{l[F.NAME]} <span className="text-[10px] font-mono text-[#A9825A] ml-1">{l[F.ID]}</span></div>
                    <div className="text-[11px] text-[#6B5F57] truncate">{l[F.UNIT_TYPE] || '—'} · RM {l[F.RM] || '—'} · {l[F.PHONE]}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs font-bold text-[#A9825A]">{formatTime(l[F.NEXT_FOLLOWUP])}</div>
                    <StageBadge stage={l[F.STAGE]} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Row 4 — trends */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title="Monthly enquiry trend" subtitle="Enquiries received vs bookings, last 6 months" actions={<TrendingUp size={16} className="text-[#A9825A]" />}>
          <MonthlyBars series={series} />
        </Card>
        <Card title="Monthly conversion trend" subtitle="Bookings ÷ enquiries per month">
          <ConversionBars series={series} />
        </Card>
      </div>

      {/* Row 5 — sources, stages, RMs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card title="Source-wise enquiries" subtitle={rangeLabel}>
          <Breakdown rows={kpi.bySource.map((s) => ({ key: s.key, label: s.label, count: s.count, extra: `${s.bookings} booked`, pct: s.percent }))} onClick={(key) => onFilterClick(`${rangeLabel} · Source ${key}`, kpi.ids.enquiries.filter((id) => (leads.find((l) => l[F.ID] === id)?.[F.SOURCE] || 'Unspecified') === key))} />
        </Card>
        <Card title="Lead-stage distribution" subtitle={rangeLabel}>
          <StageStack rows={kpi.byStage} total={kpi.totalEnquiries} onClick={(stage) => onFilterClick(`${rangeLabel} · ${stage}`, kpi.ids.enquiries.filter((id) => (leads.find((l) => l[F.ID] === id)?.[F.STAGE] || 'New') === stage))} />
        </Card>
        <Card title="RM-wise performance" subtitle={rangeLabel} padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase font-bold text-[#6B5F57] border-b border-[#ECE8E1]">
                  <th className="text-left px-5 pb-2">RM</th><th className="pb-2 text-center">Enq</th><th className="pb-2 text-center">Hot</th><th className="pb-2 text-center">Visits</th><th className="pb-2 text-center">Booked</th><th className="pb-2 text-right px-5">Conv.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ECE8E1]">
                {kpi.byRM.length === 0 && <tr><td colSpan={6} className="px-5 py-6 text-center text-[#9E948D]">No data in this period</td></tr>}
                {kpi.byRM.map((r) => (
                  <tr key={r.rm} className="hover:bg-[#FAF7F2]">
                    <td className="px-5 py-2.5 font-semibold text-[#1D2F3F] truncate max-w-[140px]">{r.rm}</td>
                    <td className="py-2.5 text-center">{r.enquiries}</td>
                    <td className="py-2.5 text-center">{r.hot}</td>
                    <td className="py-2.5 text-center">{r.siteVisits}</td>
                    <td className="py-2.5 text-center font-bold text-[#2E7D32]">{r.bookings}</td>
                    <td className="py-2.5 text-right px-5 font-semibold">{formatPercent(r.conversionRate, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
};

/* ------------------------------- charts --------------------------------- */

const MonthlyBars: React.FC<{ series: ReturnType<typeof monthlySeries> }> = ({ series }) => {
  const max = Math.max(1, ...series.map((p) => p.enquiries));
  return (
    <div>
      <div className="h-40 flex items-end gap-2 border-b border-[#ECE8E1] pb-1">
        {series.map((p) => (
          <div key={p.key} className="flex-1 flex flex-col items-center justify-end h-full group relative">
            <div className="absolute -top-12 opacity-0 group-hover:opacity-100 transition pointer-events-none bg-[#1D2F3F] text-white p-2 rounded text-[10px] whitespace-nowrap z-10">
              <div className="font-bold text-[#E7D8C6]">{p.label}</div><div>{p.enquiries} enquiries · {p.bookings} booked</div><div>{p.siteVisits} visits · {p.qualified} qualified</div>
            </div>
            <div className="w-full flex items-end gap-0.5 h-full">
              <div className="flex-1 rounded-t bg-[#1D2F3F]" style={{ height: `${Math.max(3, (p.enquiries / max) * 100)}%` }} title={`${p.enquiries} enquiries`} />
              <div className="flex-1 rounded-t bg-[#7C8B78]" style={{ height: `${Math.max(2, (p.bookings / max) * 100)}%` }} title={`${p.bookings} bookings`} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-1">
        {series.map((p) => <div key={p.key} className="flex-1 text-center text-[10px] text-[#6B5F57] truncate">{p.label.slice(0, 3)}<div className="font-bold text-[#1D2F3F]">{p.enquiries}</div></div>)}
      </div>
      <div className="flex items-center gap-4 text-[10px] text-[#6B5F57] mt-2"><span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#1D2F3F]" />Enquiries</span><span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#7C8B78]" />Bookings</span></div>
    </div>
  );
};

const ConversionBars: React.FC<{ series: ReturnType<typeof monthlySeries> }> = ({ series }) => {
  const max = Math.max(5, ...series.map((p) => p.conversionRate));
  return (
    <div>
      <div className="h-40 flex items-end gap-2 border-b border-[#ECE8E1] pb-1">
        {series.map((p) => (
          <div key={p.key} className="flex-1 flex flex-col items-center justify-end h-full">
            <div className="text-[10px] font-bold text-[#A9825A] mb-1">{p.enquiries ? formatPercent(p.conversionRate, 0) : '—'}</div>
            <div className="w-2/3 rounded-t bg-[#A9825A]" style={{ height: `${Math.max(3, (p.conversionRate / max) * 85)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-1">{series.map((p) => <div key={p.key} className="flex-1 text-center text-[10px] text-[#6B5F57]">{p.label.slice(0, 3)}</div>)}</div>
    </div>
  );
};

const Breakdown: React.FC<{ rows: Array<{ key: string; label: string; count: number; extra?: string; pct: number }>; onClick?: (key: string) => void }> = ({ rows, onClick }) => {
  if (!rows.length) return <EmptyState title="No data" className="py-6" />;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2.5">
      {rows.slice(0, 8).map((r) => (
        <button key={r.key} onClick={onClick ? () => onClick(r.key) : undefined} className="w-full text-left group">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="font-semibold text-[#1D2F3F] truncate group-hover:text-[#A9825A]">{r.label}</span>
            <span className="text-[#6B5F57] flex-shrink-0"><strong className="text-[#1D2F3F]">{r.count}</strong> · {formatPercent(r.pct, 0)}{r.extra ? ` · ${r.extra}` : ''}</span>
          </div>
          <Bar value={r.count} max={max} />
        </button>
      ))}
    </div>
  );
};

const STAGE_COLORS: Record<string, string> = { New: '#1D2F3F', Open: '#3A5D7C', Warm: '#A9825A', Hot: '#B06A55', Qualified: '#7C8B78', Booked: '#2E7D32', 'Not Responding': '#D97706', DND: '#9E948D', Junk: '#9E948D' };
const StageStack: React.FC<{ rows: Array<{ key: string; label: string; count: number; percent: number }>; total: number; onClick?: (stage: string) => void }> = ({ rows, total, onClick }) => {
  if (!rows.length) return <EmptyState title="No data" className="py-6" />;
  return (
    <div>
      <div className="w-full h-4 rounded-full overflow-hidden flex bg-[#EBE5DC]">
        {rows.map((r) => <div key={r.key} style={{ width: `${r.percent}%`, backgroundColor: STAGE_COLORS[r.key] || '#9E948D' }} title={`${r.label}: ${r.count}`} />)}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {rows.map((r) => (
          <button key={r.key} onClick={onClick ? () => onClick(r.key) : undefined} className="flex items-center justify-between text-xs hover:bg-[#F4F0EB] rounded px-1 py-0.5">
            <span className="inline-flex items-center gap-1.5 truncate"><span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: STAGE_COLORS[r.key] || '#9E948D' }} /><span className="truncate text-[#3D3530]">{r.label}</span></span>
            <span className="font-bold text-[#1D2F3F] ml-2">{r.count}</span>
          </button>
        ))}
      </div>
      <div className="text-[10px] text-[#9E948D] mt-2">{total} enquiries</div>
    </div>
  );
};
