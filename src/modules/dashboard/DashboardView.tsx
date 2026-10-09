import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Users } from 'lucide-react';
import { Lead, TaskItem, SyncState } from '../../types/crm';
import { F } from '../../core/config';
import { computeKpis, monthlySeries, siteVisitDate } from '../../core/analytics';
import { formatRelative, formatTime, getPresetRange, listMonths, currentMonthKey, previousMonthKey } from '../../core/dates';
import { formatHours, formatPercent, pctChange } from '../../core/format';
import { Button, Card, DateFilterValue, DateRangeFilter, EmptyState, ErrorState, Select, resolveDateFilter, StageBadge } from '../../components/ui';
import { PageSkeleton } from '../../components/Skeletons';

interface Props {
  leads: Lead[];
  tasks: TaskItem[];
  rmOptions: string[];
  sync: SyncState;
  /** Dashboard title from Settings (shown under the greeting). */
  greeting?: string;
  /** Signed-in user's name, for the greeting. */
  userName?: string;
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

/* Ocean palette */
const C = {
  navy: '#0B2A44', blue: '#0B6BB0', mid: '#1B86C9', sea: '#36B3F2', sky: '#7FD0F7', teal: '#0E9F9A', amber: '#F6B84B', coral: '#FF8A65', slate: '#8EA3B5', mist: '#B5C8D8',
  text: '#0F2233', sub: '#5E778C', line: '#DCE8F2', soft: '#EEF4F9', bg: '#F2F7FB',
};
const STAGE_COLORS: Record<string, string> = { New: C.sky, Open: C.mid, Warm: C.amber, Hot: C.coral, Qualified: C.sea, Booked: C.teal, 'Not Responding': C.mist, Lost: C.slate, DND: C.slate, Junk: C.slate };
const SOURCE_COLORS = [C.blue, C.sea, C.teal, C.amber, C.coral, C.slate, C.sky, C.mid];

const Panel: React.FC<{ title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; className?: string; flush?: boolean; children: React.ReactNode }> = ({ title, subtitle, actions, className = '', flush, children }) => (
  <section className={`bg-white border border-[#DCE8F2] rounded-2xl min-w-0 ${flush ? 'pt-5 pb-2' : 'p-5'} ${className}`}>
    <div className={`flex items-start justify-between gap-3 mb-4 ${flush ? 'px-5' : ''}`}>
      <div className="min-w-0">
        <h2 className="text-base font-extrabold text-[#0F2233] leading-tight">{title}</h2>
        {subtitle && <p className="text-xs text-[#5E778C] mt-0.5">{subtitle}</p>}
      </div>
      {actions}
    </div>
    {children}
  </section>
);

/** ▲ 12% / ▼ 3 — green when the change is good. */
const Delta: React.FC<{ value: number | null | undefined; lowerIsBetter?: boolean; suffix?: string }> = ({ value, lowerIsBetter, suffix = '%' }) => {
  if (value === undefined) return null;
  if (value === null) return <span className="text-[11px] font-extrabold rounded-md px-1.5 py-px bg-[#E0F0FF] text-[#0B5E9C]">new</span>;
  const good = lowerIsBetter ? value < 0 : value > 0;
  const flat = Math.abs(value) < 0.05;
  const cls = flat ? 'bg-[#EEF4F9] text-[#5E778C]' : good ? 'bg-[#E1F5EA] text-[#14653F]' : 'bg-[#FDE8E3] text-[#A1301A]';
  return <span className={`text-[11px] font-extrabold rounded-md px-1.5 py-px whitespace-nowrap ${cls}`}>{flat ? '•' : value > 0 ? '▲' : '▼'} {Math.abs(value).toFixed(suffix === ' pt' ? 1 : 0)}{suffix}</span>;
};

function greetingFor(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export const DashboardView: React.FC<Props> = ({ leads, tasks, rmOptions, sync, greeting, userName, onRefresh, onFilterClick, onOpenLead }) => {
  const [filter, setFilter] = useState<DateFilterValue>({ preset: 'this_month' });
  const [rm, setRm] = useState('');
  const range = useMemo(() => resolveDateFilter(filter), [filter]);

  const kpi = useMemo(() => computeKpis(leads, tasks, range, { rm: rm || undefined }), [leads, tasks, range, rm]);
  const live = useMemo(() => computeKpis(leads, tasks, null, { rm: rm || undefined }), [leads, tasks, rm]); // all-time, for "now" numbers
  const today = useMemo(() => computeKpis(leads, tasks, getPresetRange('today'), { rm: rm || undefined }), [leads, tasks, rm]);

  // Previous comparable period for the change chips (calendar presets only)
  const prevKpi = useMemo(() => {
    const map: Record<string, any> = { today: 'yesterday', this_week: 'last_week', this_month: 'last_month', this_quarter: 'last_quarter' };
    const prevPreset = filter.preset !== 'custom' ? map[filter.preset] : undefined;
    if (!prevPreset) return null;
    return computeKpis(leads, tasks, getPresetRange(prevPreset), { rm: rm || undefined });
  }, [leads, tasks, filter.preset, rm]);
  const trend = (k: keyof typeof kpi) => (prevKpi ? pctChange(Number(prevKpi[k] || 0), Number(kpi[k] || 0)) : undefined);

  const months = useMemo(() => {
    const end = currentMonthKey();
    let start = end;
    for (let i = 0; i < 5; i++) start = previousMonthKey(start);
    return listMonths(start, end); // always the last 6 months, even when empty
  }, []);
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
  const leadById = (id: string) => leads.find((l) => l[F.ID] === id);
  const idsWhere = (field: string, value: string, fallback: string) => kpi.ids.enquiries.filter((id) => (leadById(id)?.[field] || fallback) === value);
  const firstName = String(userName || '').trim().split(/\s+/)[0];
  const convDeltaPt = prevKpi ? kpi.conversionRate - prevKpi.conversionRate : undefined;

  const funnel = [
    { label: 'Enquiries', value: kpi.totalEnquiries, color: C.blue, fg: '#fff', note: prevKpi ? <Delta value={trend('totalEnquiries')} /> : `${rangeLabel}`, ids: kpi.ids.enquiries },
    { label: 'Open pipeline', value: kpi.openLeads, color: C.mid, fg: '#fff', note: `${formatPercent(kpi.totalEnquiries ? (kpi.openLeads / kpi.totalEnquiries) * 100 : 0, 0)} of enquiries`, ids: kpi.ids.open },
    { label: 'Site visits', value: kpi.siteVisitsTotal, color: C.sea, fg: '#04263D', note: `${kpi.siteVisitsCompleted} completed`, ids: [...kpi.ids.svScheduled, ...kpi.ids.svCompleted] },
    { label: 'Qualified', value: kpi.qualifiedLeads, color: C.sky, fg: '#04263D', note: `Qualification ${formatPercent(kpi.qualificationRate, 1)}`, ids: kpi.ids.qualified },
    { label: 'Booked', value: kpi.bookings, color: C.teal, fg: '#fff', note: `Conversion ${formatPercent(kpi.conversionRate, 1)}`, ids: kpi.ids.booked },
  ];

  const tiles: Array<{ label: string; value: number; color: string; delta?: number | null; lower?: boolean; onClick: () => void }> = [
    { label: 'Total Enquiries', value: kpi.totalEnquiries, color: C.blue, delta: trend('totalEnquiries'), onClick: () => onFilterClick(`${rangeLabel} · Enquiries`, kpi.ids.enquiries) },
    { label: 'New', value: kpi.newLeads, color: C.sky, delta: trend('newLeads'), onClick: () => onFilterClick(`${rangeLabel} · New`, idsWhere(F.STAGE, 'New', '')) },
    { label: 'Open Leads', value: kpi.openLeads, color: C.mid, delta: trend('openLeads'), onClick: () => onFilterClick(`${rangeLabel} · Open pipeline`, kpi.ids.open) },
    { label: 'Hot', value: kpi.hotLeads, color: C.coral, delta: trend('hotLeads'), onClick: () => onFilterClick(`${rangeLabel} · Hot`, kpi.ids.hot) },
    { label: 'Warm', value: kpi.warmLeads, color: C.amber, delta: trend('warmLeads'), onClick: () => onFilterClick(`${rangeLabel} · Warm`, kpi.ids.warm) },
    { label: 'Qualified', value: kpi.qualifiedLeads, color: C.sea, delta: trend('qualifiedLeads'), onClick: () => onFilterClick(`${rangeLabel} · Qualified`, kpi.ids.qualified) },
    { label: 'Bookings', value: kpi.bookings, color: C.teal, delta: trend('bookings'), onClick: () => onFilterClick(`${rangeLabel} · Booked`, kpi.ids.booked) },
    { label: 'Lost / DQ', value: kpi.lostLeads, color: C.slate, delta: trend('lostLeads'), lower: true, onClick: () => onFilterClick(`${rangeLabel} · Lost`, kpi.ids.lost) },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1320px] mx-auto">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-[26px] font-extrabold text-[#0B2A44] tracking-tight">{greetingFor()}{firstName ? `, ${firstName}` : ''}</h1>
          <p className="text-[13px] text-[#5E778C] mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>{greeting || 'Sales Dashboard'}</span><span aria-hidden>·</span><span>Live from the CRM server</span><span aria-hidden>·</span>
            <span className={stale ? 'text-[#A1301A] font-semibold' : ''}>
              {sync.status === 'syncing' ? 'Syncing…' : sync.lastSyncAt ? `Updated ${formatRelative(sync.lastSyncAt)}` : 'Not synced yet'}
              {stale && ' (showing last known data)'}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DateRangeFilter value={filter} onChange={setFilter} presets={PRESETS} />
          <Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" aria-label="Filter by RM" />
          <Button variant="secondary" onClick={onRefresh} loading={sync.status === 'syncing'} icon={<RefreshCw size={13} />}>Refresh</Button>
        </div>
      </div>

      {stale && sync.lastError && <ErrorState compact title={sync.status === 'offline' ? 'Offline — live updates paused' : 'Last sync failed'} message={sync.lastError} onRetry={onRefresh} />}

      {/* Funnel */}
      <Panel title={`Conversion funnel · ${rangeLabel}`} subtitle="From first enquiry to a booked home · click a row to open those leads"
        actions={<span className="text-xs font-extrabold rounded-lg px-2.5 py-1 bg-[#E1F5EA] text-[#14653F] whitespace-nowrap">Conversion {formatPercent(kpi.conversionRate, 1)}{convDeltaPt !== undefined ? ` · ${convDeltaPt >= 0 ? '+' : '−'}${Math.abs(convDeltaPt).toFixed(1)} pt` : ''}</span>}>
        <div className="space-y-2.5">
          {funnel.map((f) => {
            const w = kpi.totalEnquiries ? Math.max(f.value ? 6 : 0, (f.value / kpi.totalEnquiries) * 100) : 0;
            return (
              <button key={f.label} type="button" onClick={() => onFilterClick(`${rangeLabel} · ${f.label}`, f.ids)} className="w-full grid grid-cols-[110px_minmax(0,1fr)] sm:grid-cols-[140px_minmax(0,1fr)_170px] items-center gap-3 text-left group">
                <span className="text-sm font-bold text-[#0F2233] group-hover:text-[#0B6BB0]">{f.label}</span>
                <span className="h-9 rounded-[10px] bg-[#EEF4F9] overflow-hidden block">
                  <span className="h-full rounded-[10px] flex items-center pl-3 text-sm font-extrabold transition-[filter] group-hover:brightness-110" style={{ width: `${w}%`, minWidth: f.value ? 40 : 0, background: f.color, color: f.fg }}>{f.value}</span>
                </span>
                <span className="hidden sm:block text-xs text-[#5E778C] text-right">{f.note}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <button key={t.label} type="button" onClick={t.onClick} className="bg-white border border-[#DCE8F2] rounded-2xl px-4 py-3.5 text-left hover:shadow-md hover:-translate-y-px transition min-w-0" style={{ borderTop: `4px solid ${t.color}` }}>
            <div className="text-[12.5px] font-semibold text-[#5E778C] truncate">{t.label}</div>
            <div className="flex items-baseline justify-between gap-2 mt-1">
              <span className="text-[28px] font-extrabold text-[#0B2A44] leading-none">{t.value}</span>
              <Delta value={t.delta} lowerIsBetter={t.lower} />
            </div>
          </button>
        ))}
      </div>

      {/* Trend + calendar */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)] gap-5">
        <Panel title="Monthly enquiry trend" subtitle="Enquiries (area) and bookings (bars) · conversion per month below"
          actions={<div className="hidden sm:flex gap-3 text-xs text-[#5E778C]"><Legend color={C.sea} label="Enquiries" /><Legend color={C.navy} label="Bookings" /></div>}>
          <TrendChart series={series} />
        </Panel>
        <VisitCalendar leads={leads} rm={rm} onOpenLead={onOpenLead} counts={{ total: kpi.siteVisitsTotal, scheduled: kpi.siteVisitsScheduled, completed: kpi.siteVisitsCompleted, prospects: kpi.siteVisitProspects }} />
      </div>

      {/* Sources · stages · follow-ups */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel title="Source-wise enquiries" subtitle={rangeLabel}>
          <SourceDonut rows={kpi.bySource} total={kpi.totalEnquiries} onClick={(key) => onFilterClick(`${rangeLabel} · Source ${key}`, idsWhere(F.SOURCE, key, 'Unspecified'))} />
        </Panel>
        <Panel title="Lead-stage distribution" subtitle={`${kpi.totalEnquiries} enquiries`}>
          <StageBars rows={kpi.byStage} onClick={(stage) => onFilterClick(`${rangeLabel} · ${stage}`, idsWhere(F.STAGE, stage, 'New'))} />
        </Panel>
        <Panel title="Follow-ups & tasks" subtitle={`Due in ${rangeLabel.toLowerCase()} · overdue is as of now`}>
          <div className="grid grid-cols-2 gap-2.5">
            <StatBox label="Due" value={kpi.followupsDue} onClick={() => onFilterClick(`${rangeLabel} · Follow-ups due`, kpi.ids.followupsDue)} />
            <StatBox label="Overdue now" value={live.followupsOverdue} tone="alert" onClick={() => onFilterClick('Overdue follow-ups', live.ids.followupsOverdue)} />
            <StatBox label="Done" value={kpi.followupsCompleted} tone="good" />
            <StatBox label="Tasks pending / done" value={`${kpi.pendingTasks} / ${kpi.completedTasks}`} />
          </div>
          <p className="text-xs text-[#5E778C] mt-3">Qualification {formatPercent(kpi.qualificationRate, 1)} · Visit rate {formatPercent(kpi.siteVisitRate, 1)} · First response {formatHours(kpi.avgResponseHours)}</p>
        </Panel>
      </div>

      {/* Due today · RM performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel flush title={`Follow-ups due today (${dueToday.length})`} subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}>
          {dueToday.length === 0 ? (
            <EmptyState title="Nothing due today" description="Schedule the next follow-up from a lead's profile and it will appear here." className="py-6" />
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {dueToday.map((l) => (
                <button key={l[F.ID]} type="button" onClick={() => onOpenLead(l[F.ID])} className="w-full flex items-center gap-3 px-5 py-3 border-t border-[#EEF4F9] hover:bg-[#F7FAFD] text-left">
                  <span className="w-[70px] flex-shrink-0 text-sm font-extrabold text-[#0B5E9C]">{formatTime(l[F.NEXT_FOLLOWUP])}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-bold text-[#0F2233] truncate">{l[F.NAME]} <span className="text-[11px] font-semibold text-[#5E778C]">{l[F.ID]}</span></span>
                    <span className="block text-xs text-[#5E778C] truncate">{l[F.UNIT_TYPE] || '—'} · RM {l[F.RM] || '—'}</span>
                  </span>
                  <StageBadge stage={l[F.STAGE]} />
                </button>
              ))}
            </div>
          )}
        </Panel>
        <Panel flush title="RM-wise performance" subtitle={rangeLabel}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide font-bold text-[#5E778C]">
                  <th className="text-left px-5 pb-2.5">RM</th><th className="text-right px-3 pb-2.5">Enq</th><th className="text-right px-3 pb-2.5">Hot</th><th className="text-right px-3 pb-2.5">Visits</th><th className="text-right px-3 pb-2.5">Booked</th><th className="text-right px-5 pb-2.5">Conv.</th>
                </tr>
              </thead>
              <tbody>
                {kpi.byRM.length === 0 && <tr><td colSpan={6} className="px-5 py-6 text-center text-[#7E93A6] border-t border-[#EEF4F9]">No data in this period</td></tr>}
                {kpi.byRM.map((r) => (
                  <tr key={r.rm} className="border-t border-[#EEF4F9] hover:bg-[#F7FAFD]">
                    <td className="px-5 py-3 font-bold text-[#0F2233] truncate max-w-[160px]">{r.rm}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.enquiries}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.hot}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.siteVisits}</td>
                    <td className="px-3 py-3 text-right tabular-nums font-extrabold text-[#14653F]">{r.bookings}</td>
                    <td className="px-5 py-3 text-right tabular-nums font-extrabold">{formatPercent(r.conversionRate, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
};

/* ------------------------------- pieces --------------------------------- */

const Legend: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: color }} />{label}</span>
);

const StatBox: React.FC<{ label: string; value: React.ReactNode; tone?: 'alert' | 'good'; onClick?: () => void }> = ({ label, value, tone, onClick }) => {
  const cls = tone === 'alert' ? 'bg-[#FDE8E3] text-[#A1301A]' : tone === 'good' ? 'bg-[#E1F5EA] text-[#14653F]' : 'bg-[#F2F7FB] text-[#5E778C]';
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`rounded-xl p-3 text-left ${cls} ${onClick ? 'hover:brightness-95' : ''}`}>
      <div className="text-[12.5px]">{label}</div>
      <div className={`text-[26px] font-extrabold leading-tight ${tone ? '' : 'text-[#0F2233]'}`}>{value}</div>
    </Tag>
  );
};

const TrendChart: React.FC<{ series: ReturnType<typeof monthlySeries> }> = ({ series }) => {
  const max = Math.max(5, ...series.map((p) => p.enquiries)) * 1.15;
  const maxB = Math.max(3, ...series.map((p) => p.bookings)) * 2.2;
  const W = 600, H = 230;
  const pts = series.map((p, i) => [12 + (i + 0.5) * ((W - 24) / series.length), H - (p.enquiries / max) * H]);
  const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return (
    <div>
      <div className="relative h-[230px] border-b border-[#DCE8F2]" style={{ background: 'repeating-linear-gradient(to top, transparent 0 56px, #EEF4F9 56px 57px)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden>
          <polygon points={`12,${H} ${line} ${W - 12},${H}`} fill="#D6EEFC" />
          <polyline points={line} fill="none" stroke={C.sea} strokeWidth={3} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="absolute inset-0 flex items-end px-[2%]">
          {series.map((p) => (
            <div key={p.key} className="flex-1 h-full flex flex-col items-center justify-end group relative" title={`${p.label}: ${p.enquiries} enquiries · ${p.bookings} booked · ${p.siteVisits} visits`}>
              <span className="text-xs font-extrabold text-[#0F2233] mb-1">{p.bookings}</span>
              <span className="w-[18px] rounded-t-[5px]" style={{ height: `${Math.max(p.bookings ? 4 : 0, (p.bookings / maxB) * 100)}%`, background: C.navy }} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex px-[2%] mt-2 text-[12.5px] text-[#5E778C] text-center">
        {series.map((p) => (
          <span key={p.key} className="flex-1 min-w-0">
            {p.label.slice(0, 3)} · <strong className="text-[#0F2233]">{p.enquiries}</strong>
            <span className="block text-[11.5px]">{p.enquiries ? formatPercent(p.conversionRate, 1) : '—'} conv.</span>
          </span>
        ))}
      </div>
    </div>
  );
};

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Site visits by day for one month; today's visits listed underneath. */
const VisitCalendar: React.FC<{ leads: Lead[]; rm: string; onOpenLead: (id: string) => void; counts: { total: number; scheduled: number; completed: number; prospects: number } }> = ({ leads, rm, onOpenLead, counts }) => {
  const now = new Date();
  const [offset, setOffset] = useState(0);
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const visits = useMemo(() => {
    const byDay = new Map<string, Lead[]>();
    for (const l of leads) {
      if (rm && l[F.RM] !== rm) continue;
      const d = siteVisitDate(l);
      if (!d || !l[F.SITE_VISIT_DATE]) continue;
      const k = dayKey(d);
      byDay.set(k, [...(byDay.get(k) || []), l]);
    }
    return byDay;
  }, [leads, rm]);
  const first = (month.getDay() + 6) % 7; // Monday first
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<{ n: number; muted: boolean; date: Date }> = [];
  for (let i = 0; i < Math.ceil((first + daysIn) / 7) * 7; i++) {
    const date = new Date(month.getFullYear(), month.getMonth(), i - first + 1);
    cells.push({ n: date.getDate(), muted: date.getMonth() !== month.getMonth(), date });
  }
  const todays = (visits.get(dayKey(now)) || []).slice().sort((a, b) => (siteVisitDate(a)?.getTime() || 0) - (siteVisitDate(b)?.getTime() || 0));
  const title = month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <Panel title={`Site visits · ${title}`} subtitle={`${counts.total} this period · ${counts.scheduled} scheduled · ${counts.completed} completed · ${counts.prospects} prospects`}
      actions={<div className="flex gap-1.5">
        <button type="button" onClick={() => setOffset(offset - 1)} className="w-8 h-8 rounded-lg border border-[#DCE8F2] flex items-center justify-center text-[#0F2233] hover:bg-[#F2F7FB]" aria-label="Previous month"><ChevronLeft size={15} /></button>
        <button type="button" onClick={() => setOffset(offset + 1)} className="w-8 h-8 rounded-lg border border-[#DCE8F2] flex items-center justify-center text-[#0F2233] hover:bg-[#F2F7FB]" aria-label="Next month"><ChevronRight size={15} /></button>
      </div>}>
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => <div key={w} className="text-[11px] font-bold text-[#5E778C] py-1">{w}</div>)}
        {cells.map((c, i) => {
          const n = visits.get(dayKey(c.date))?.length || 0;
          const isToday = dayKey(c.date) === dayKey(now);
          const cls = isToday ? 'bg-[#0B6BB0] text-white font-extrabold' : c.muted ? 'text-[#B5C8D8]' : n ? 'bg-[#E0F0FF] text-[#0B5E9C] font-extrabold' : 'text-[#0F2233]';
          return <div key={i} className={`text-[13px] py-2 rounded-[10px] ${cls}`} title={n ? `${n} site visit${n > 1 ? 's' : ''}` : undefined}>{c.n}</div>;
        })}
      </div>
      <div className="mt-3 rounded-xl bg-[#F2F7FB] px-3 py-2.5 text-[12.5px]">
        {todays.length === 0 ? <span className="text-[#5E778C]">No site visits today</span> : (
          <>
            <strong className="text-[#0F2233]">Today:</strong>{' '}
            {todays.map((l, i) => (
              <React.Fragment key={l[F.ID]}>
                {i > 0 && ' · '}
                <button type="button" onClick={() => onOpenLead(l[F.ID])} className="text-[#0B5E9C] font-semibold hover:underline">{l[F.NAME]} {formatTime(l[F.SITE_VISIT_DATE])}</button>
              </React.Fragment>
            ))}
          </>
        )}
      </div>
    </Panel>
  );
};

const SourceDonut: React.FC<{ rows: Array<{ key: string; label: string; count: number; bookings?: number }>; total: number; onClick: (key: string) => void }> = ({ rows, total, onClick }) => {
  if (!rows.length) return <EmptyState title="No data" className="py-6" />;
  const shown = rows.slice(0, 8);
  let acc = 0;
  const stops = shown.map((r, i) => { const a = acc; acc += total ? (r.count / total) * 100 : 0; return `${SOURCE_COLORS[i % SOURCE_COLORS.length]} ${a.toFixed(2)}% ${acc.toFixed(2)}%`; });
  if (acc < 100) stops.push(`${C.soft} ${acc.toFixed(2)}% 100%`);
  return (
    <div className="flex items-center gap-4">
      <div className="w-[130px] h-[130px] rounded-full flex-none flex items-center justify-center" style={{ background: `conic-gradient(${stops.join(', ')})` }} role="img" aria-label={`${total} enquiries by source`}>
        <div className="w-[84px] h-[84px] rounded-full bg-white flex items-center justify-center text-[22px] font-extrabold text-[#0B2A44]">{total}</div>
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        {shown.map((r, i) => (
          <button key={r.key} type="button" onClick={() => onClick(r.key)} className="w-full flex items-center gap-2 text-[13px] rounded-md px-1 py-0.5 hover:bg-[#F2F7FB] text-left">
            <span className="w-2.5 h-2.5 rounded-[3px] flex-none" style={{ background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} />
            <span className="flex-1 truncate text-[#0F2233]">{r.label}</span>
            <span className="text-[11.5px] text-[#7E93A6] whitespace-nowrap">{r.bookings || 0} bkd</span>
            <strong className="w-8 text-right text-[#0F2233]">{r.count}</strong>
          </button>
        ))}
      </div>
    </div>
  );
};

const StageBars: React.FC<{ rows: Array<{ key: string; label: string; count: number }>; onClick: (stage: string) => void }> = ({ rows, onClick }) => {
  if (!rows.length) return <EmptyState title="No data" className="py-6" />;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <button key={r.key} type="button" onClick={() => onClick(r.key)} className="w-full grid grid-cols-[110px_minmax(0,1fr)_32px] items-center gap-2.5 text-[13px] rounded-md px-1 py-0.5 hover:bg-[#F2F7FB] text-left">
          <span className="truncate text-[#0F2233]">{r.label}</span>
          <span className="h-2.5 rounded-full bg-[#EEF4F9] block"><span className="h-full rounded-full block" style={{ width: `${(r.count / max) * 100}%`, background: STAGE_COLORS[r.key] || C.slate }} /></span>
          <strong className="text-right text-[#0F2233]">{r.count}</strong>
        </button>
      ))}
    </div>
  );
};
