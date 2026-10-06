import React, { useId, useMemo, useState } from 'react';
import { AlertTriangle, CalendarCheck, Clock, MapPin, RefreshCw, Trophy, Users } from 'lucide-react';
import { Lead, TaskItem, SyncState } from '../../types/crm';
import { DEFAULT_CUSTOMIZATION, F } from '../../core/config';
import { computeKpis, monthlySeries } from '../../core/analytics';
import { formatRelative, formatTime, getPresetRange, listMonths, currentMonthKey, previousMonthKey } from '../../core/dates';
import { formatHours, formatPercent, pctChange } from '../../core/format';
import { Button, Card, DateFilterValue, DateRangeFilter, EmptyState, ErrorState, LoadingState, Select, resolveDateFilter } from '../../components/ui';
import { useCompany } from '../../core/tenant';

interface Props {
  leads: Lead[];
  tasks: TaskItem[];
  rmOptions: string[];
  sync: SyncState;
  greeting?: string;
  /** Signed-in user's display name (first name is used in the greeting). */
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

/* Soft-bento palette */
const INK = '#1D2F3F';
const SAND = '#F1ECE4';
const CLAY = '#B5794A';
const SAGE = '#8FA48A';
const AVATARS = ['#B5794A', '#3E5468', '#8FA48A', '#7A5B37', '#6F8BA3'];
const STAGE_COLORS: Record<string, string> = {
  New: '#D9CFC2', Open: '#9FB0BF', Warm: SAGE, Hot: CLAY, Qualified: '#3E5468', Booked: INK,
  'Not Responding': '#E0B98F', DND: '#BDB4AA', Junk: '#BDB4AA',
};
const stageColor = (k: string) => STAGE_COLORS[k] || (/^Disqualified/.test(k) ? '#CFC5BA' : '#BDB4AA');
const initialsOf = (s: string) => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** A white bento card (a labelled section for screen readers). */
const Tile: React.FC<{ className?: string; children: React.ReactNode; label?: string }> = ({ className = '', children, label }) => (
  <section aria-label={label} className={`rounded-[26px] bg-white p-6 shadow-[0_8px_30px_rgba(60,48,36,0.06)] ${className}`}>{children}</section>
);

export const DashboardView: React.FC<Props> = ({ leads, tasks, rmOptions, sync, greeting, userName, onRefresh, onFilterClick, onOpenLead }) => {
  const company = useCompany();
  const [filter, setFilter] = useState<DateFilterValue>({ preset: 'this_month' });
  const [rm, setRm] = useState('');
  const range = useMemo(() => resolveDateFilter(filter), [filter]);
  const opts = useMemo(() => ({ rm: rm || undefined }), [rm]);

  const kpi = useMemo(() => computeKpis(leads, tasks, range, opts), [leads, tasks, range, opts]);
  const live = useMemo(() => computeKpis(leads, tasks, null, opts), [leads, tasks, opts]); // all-time, for "now" numbers
  const today = useMemo(() => computeKpis(leads, tasks, getPresetRange('today'), opts), [leads, tasks, opts]);

  // Previous comparable period for the trend chip (calendar presets only)
  const prevKpi = useMemo(() => {
    const map: Record<string, any> = { today: 'yesterday', this_week: 'last_week', this_month: 'last_month', this_quarter: 'last_quarter' };
    const prevPreset = filter.preset !== 'custom' ? map[filter.preset] : undefined;
    return prevPreset ? computeKpis(leads, tasks, getPresetRange(prevPreset), opts) : null;
  }, [leads, tasks, filter.preset, opts]);
  const enquiryChange = prevKpi ? pctChange(prevKpi.totalEnquiries, kpi.totalEnquiries) : null;

  const months = useMemo(() => {
    const end = currentMonthKey();
    let start = end;
    for (let i = 0; i < 5; i++) start = previousMonthKey(start);
    return listMonths(start, end); // always the last 6 months (even if empty)
  }, []);
  const series = useMemo(() => monthlySeries(leads, tasks, months, opts), [leads, tasks, months, opts]);

  const dueToday = useMemo(() => {
    const ids = new Set(today.ids.followupsDue);
    return leads.filter((l) => ids.has(l[F.ID])).sort((a, b) => String(a[F.NEXT_FOLLOWUP]).localeCompare(String(b[F.NEXT_FOLLOWUP])));
  }, [leads, today]);

  /* ----------------------------- states --------------------------------- */
  const noData = leads.length === 0 && tasks.length === 0;
  if (noData && (sync.status === 'loading' || (!sync.hasLoadedOnce && sync.status === 'syncing'))) return <LoadingState label="Loading live CRM data…" />;
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
          <EmptyState title="No enquiries yet" description="The Enquiry Log is empty. Create the first enquiry with “New Enquiry”, import a CSV, or connect a lead source to capture leads automatically." icon={<Users size={22} />} action={<Button variant="secondary" onClick={onRefresh} icon={<RefreshCw size={13} />}>Refresh</Button>} />
        </Card>
      </div>
    );
  }

  const rangeLabel = kpi.rangeLabel;
  const stale = sync.status === 'error' || sync.status === 'offline';
  const firstName = String(userName || '').trim().split(/\s+/)[0];
  // The built-in default greeting is not a choice anyone made: greet the user by name instead.
  const custom = greeting && greeting !== DEFAULT_CUSTOMIZATION.dashboardGreeting ? greeting : '';
  const title = custom || (firstName ? `Hello, ${firstName}` : 'Dashboard');
  const companyName = company?.name || 'your team';
  const overdue = live.followupsOverdue;

  const tiles: Array<{ label: string; value: React.ReactNode; note: string; icon: React.ReactNode; cls: string; sub: string; chip: string; onClick?: () => void }> = [
    {
      label: 'Site visits', value: kpi.siteVisitsTotal, note: `${formatPercent(kpi.siteVisitRate, 0)} of enquiries`, icon: <MapPin size={17} />,
      cls: 'bg-white text-[#1D2F3F]', sub: 'text-[#6E665E]', chip: 'bg-[#EEF1F4]',
      onClick: () => onFilterClick(`${rangeLabel} · Site visits`, [...kpi.ids.svScheduled, ...kpi.ids.svCompleted]),
    },
    {
      label: 'Bookings', value: kpi.bookings, note: `${formatPercent(kpi.conversionRate, 1)} conversion`, icon: <Trophy size={17} />,
      cls: 'bg-[#1D2F3F] text-white', sub: 'text-[#B8C4CF]', chip: 'bg-white/10',
      onClick: () => onFilterClick(`${rangeLabel} · Booked`, kpi.ids.booked),
    },
    {
      label: 'First response', value: formatHours(kpi.avgResponseHours), note: 'Enquiry → first follow-up', icon: <Clock size={17} />,
      cls: 'bg-[#E3EBDF] text-[#24452D]', sub: 'text-[#4E6A55]', chip: 'bg-white/60',
    },
    {
      label: 'Due today', value: dueToday.length, note: overdue ? `${overdue} overdue now` : 'Nothing overdue', icon: <AlertTriangle size={17} />,
      cls: 'bg-[#F6E3D6] text-[#7A3B14]', sub: 'text-[#8E5431]', chip: 'bg-white/60',
      onClick: () => onFilterClick(overdue ? 'Overdue follow-ups' : 'Follow-ups due today', overdue ? live.ids.followupsOverdue : today.ids.followupsDue),
    },
  ];

  const glance: Array<{ label: string; value: React.ReactNode; onClick?: () => void }> = [
    { label: 'New', value: kpi.newLeads, onClick: () => onFilterClick(`${rangeLabel} · New`, kpi.ids.enquiries.filter((id) => leads.find((l) => l[F.ID] === id)?.[F.STAGE] === 'New')) },
    { label: 'Hot', value: kpi.hotLeads, onClick: () => onFilterClick(`${rangeLabel} · Hot`, kpi.ids.hot) },
    { label: 'Warm', value: kpi.warmLeads, onClick: () => onFilterClick(`${rangeLabel} · Warm`, kpi.ids.warm) },
    { label: 'Qualified', value: kpi.qualifiedLeads, onClick: () => onFilterClick(`${rangeLabel} · Qualified`, kpi.ids.qualified) },
    { label: 'Lost / DQ', value: kpi.lostLeads, onClick: () => onFilterClick(`${rangeLabel} · Lost`, kpi.ids.lost) },
    { label: 'Visits scheduled', value: kpi.siteVisitsScheduled, onClick: () => onFilterClick(`${rangeLabel} · Visits scheduled`, kpi.ids.svScheduled) },
    { label: 'Visits completed', value: kpi.siteVisitsCompleted, onClick: () => onFilterClick(`${rangeLabel} · Visits completed`, kpi.ids.svCompleted) },
    { label: 'Qualification', value: formatPercent(kpi.qualificationRate, 0) },
    { label: 'Follow-ups done', value: kpi.followupsCompleted },
    { label: 'Tasks open / done', value: `${kpi.pendingTasks} / ${kpi.completedTasks}` },
  ];

  return (
    <div className="min-h-full bg-[#F1ECE4]">
      <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6 lg:p-8">
        {/* Header */}
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <h2 className="text-[26px] font-semibold leading-tight text-[#1D2F3F] sm:text-[30px]">{title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[14.5px] text-[#6E665E]">
              <span>Here is how {companyName} is doing · {rangeLabel}</span>
              <span className={`text-[13px] ${stale ? 'font-semibold text-[#B06A55]' : 'text-[#8A8178]'}`}>
                {sync.status === 'syncing' ? 'Syncing…' : sync.lastSyncAt ? `Updated ${formatRelative(sync.lastSyncAt)}` : 'Not synced yet'}
                {stale && ' (showing last known data)'}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeFilter value={filter} onChange={setFilter} presets={PRESETS} />
            <Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" aria-label="Filter by RM" />
            <Button variant="secondary" onClick={onRefresh} loading={sync.status === 'syncing'} icon={<RefreshCw size={13} />}>Refresh</Button>
          </div>
        </div>

        {stale && sync.lastError && <ErrorState compact title={sync.status === 'offline' ? 'Offline — live updates paused' : 'Last sync failed'} message={sync.lastError} onRetry={onRefresh} />}

        <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 xl:grid-cols-4">
          {/* Hero: enquiries + 6-month trend */}
          <Tile label="Enquiries" className="flex flex-col gap-2 sm:col-span-2 xl:row-span-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-medium text-[#6E665E]">Enquiries · {rangeLabel}</h3>
                <div className="mt-1.5 flex items-baseline gap-3">
                  <button
                    type="button"
                    onClick={() => onFilterClick(`${rangeLabel} · Enquiries`, kpi.ids.enquiries)}
                    className="rounded-lg text-[54px] font-semibold leading-none text-[#1D2F3F] hover:text-[#B5794A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B5794A]"
                    title="Show these leads"
                  >
                    {kpi.totalEnquiries}
                  </button>
                  {enquiryChange !== null && (
                    <span className={`rounded-full px-2.5 py-1 text-[13px] font-semibold ${enquiryChange >= 0 ? 'bg-[#E3EBDF] text-[#2F5A3A]' : 'bg-[#F6E3D6] text-[#8E3B14]'}`}>
                      {enquiryChange >= 0 ? '+' : ''}{Math.round(enquiryChange)}%
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[13px] text-[#6E665E]">{kpi.openLeads} open · {kpi.bookings} booked</p>
              </div>
            </div>
            <TrendChart series={series} />
          </Tile>

          {/* Four tiles */}
          {tiles.map((t) => {
            const body = (
              <>
                <div className="flex items-center justify-between">
                  <span className={`text-[14px] ${t.sub}`}>{t.label}</span>
                  <span className={`flex h-[34px] w-[34px] items-center justify-center rounded-xl ${t.chip}`} aria-hidden>{t.icon}</span>
                </div>
                <div className="text-[34px] font-semibold leading-none sm:text-[38px]">{t.value}</div>
                <div className={`text-[13px] ${t.sub}`}>{t.note}</div>
              </>
            );
            const cls = `flex flex-col gap-2.5 rounded-[26px] p-[22px] text-left shadow-[0_8px_30px_rgba(60,48,36,0.06)] ${t.cls}`;
            return t.onClick ? (
              <button key={t.label} type="button" onClick={t.onClick} className={`${cls} transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B5794A]`}>
                {body}
              </button>
            ) : (
              <div key={t.label} className={cls}>{body}</div>
            );
          })}

          {/* Pipeline ring */}
          <Tile label="Pipeline" className="flex flex-col gap-4">
            <h3 className="text-[16px] font-semibold text-[#1D2F3F]">Pipeline</h3>
            <PipelineRing rows={kpi.byStage} center={kpi.openLeads} onClick={(stage) => onFilterClick(`${rangeLabel} · ${stage}`, kpi.ids.enquiries.filter((id) => (leads.find((l) => l[F.ID] === id)?.[F.STAGE] || 'New') === stage))} />
          </Tile>

          {/* Today's follow-ups */}
          <Tile label="Today's follow-ups" className="sm:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[16px] font-semibold text-[#1D2F3F]">
                Today&rsquo;s follow-ups
                {overdue > 0 && (
                  <button type="button" onClick={() => onFilterClick('Overdue follow-ups', live.ids.followupsOverdue)} className="rounded-full bg-[#FBE9E2] px-2.5 py-0.5 text-[12px] font-semibold text-[#9A3412] hover:bg-[#F8DCCF]">
                    {overdue} overdue
                  </button>
                )}
              </h3>
              {dueToday.length > 0 && (
                <button type="button" onClick={() => onFilterClick('Follow-ups due today', today.ids.followupsDue)} className="text-[14px] font-medium text-[#5C6B57] hover:underline">
                  View all {dueToday.length}
                </button>
              )}
            </div>
            {dueToday.length === 0 ? (
              <EmptyState title="Nothing due today" description="Schedule the next follow-up from a lead's profile and it will appear here." icon={<CalendarCheck size={20} />} className="py-6" />
            ) : (
              <ul className="mt-3 max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {dueToday.map((l, i) => (
                  <li key={l[F.ID]}>
                    <button type="button" onClick={() => onOpenLead(l[F.ID])} className="flex w-full items-center gap-3.5 rounded-2xl bg-[#FAF7F2] px-3 py-2.5 text-left hover:bg-[#F4EEE5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B5794A]">
                      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[14px] text-[14px] font-semibold text-white" style={{ background: AVATARS[i % AVATARS.length] }} aria-hidden>
                        {initialsOf(l[F.NAME])}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium text-[#1D2F3F]">{l[F.NAME]}</span>
                        <span className="block truncate text-[13px] text-[#6E665E]">{l[F.STAGE] || 'New'} · {l[F.UNIT_TYPE] || '—'} · RM {l[F.RM] || '—'}</span>
                      </span>
                      <span className="flex-none text-[13px] font-semibold text-[#1D2F3F]">{formatTime(l[F.NEXT_FOLLOWUP])}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Tile>

          {/* Sources */}
          <Tile label="Sources">
            <h3 className="text-[16px] font-semibold text-[#1D2F3F]">Sources</h3>
            {kpi.bySource.length === 0 ? (
              <EmptyState title="No data" className="py-6" />
            ) : (
              <ul className="mt-3.5 space-y-3">
                {kpi.bySource.slice(0, 7).map((s) => {
                  const max = Math.max(1, ...kpi.bySource.map((x) => x.count));
                  return (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => onFilterClick(`${rangeLabel} · Source ${s.key}`, kpi.ids.enquiries.filter((id) => (leads.find((l) => l[F.ID] === id)?.[F.SOURCE] || 'Unspecified') === s.key))}
                        className="group w-full text-left"
                        title={`${s.count} enquiries · ${formatPercent(s.percent, 0)} · ${s.bookings} booked`}
                      >
                        <span className="flex justify-between text-[13.5px]">
                          <span className="truncate group-hover:text-[#B5794A]">{s.label}</span>
                          <strong className="ml-2 text-[#1D2F3F]">{s.count}</strong>
                        </span>
                        <span className="mt-1.5 block h-2 rounded-full bg-[#F1ECE4]">
                          <span className="block h-2 rounded-full bg-[#8FA48A]" style={{ width: `${Math.max(3, (s.count / max) * 100)}%` }} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Tile>

          {/* At a glance */}
          <Tile label="At a glance" className="sm:col-span-2 xl:col-span-4">
            <h3 className="text-[16px] font-semibold text-[#1D2F3F]">At a glance · {rangeLabel}</h3>
            <div className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
              {glance.map((g) => {
                const inner = (
                  <>
                    <span className="block text-[22px] font-semibold leading-tight text-[#1D2F3F]">{g.value}</span>
                    <span className="block text-[12.5px] text-[#6E665E]">{g.label}</span>
                  </>
                );
                return g.onClick ? (
                  <button key={g.label} type="button" onClick={g.onClick} className="rounded-2xl bg-[#FAF7F2] px-4 py-3 text-left hover:bg-[#F4EEE5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B5794A]">{inner}</button>
                ) : (
                  <div key={g.label} className="rounded-2xl bg-[#FAF7F2] px-4 py-3">{inner}</div>
                );
              })}
            </div>
          </Tile>

          {/* Team */}
          <Tile label="Team" className="sm:col-span-2 xl:col-span-4">
            <h3 className="text-[16px] font-semibold text-[#1D2F3F]">Team · {rangeLabel}</h3>
            {kpi.byRM.length === 0 ? (
              <EmptyState title="No data in this period" className="py-6" />
            ) : (
              <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
                {kpi.byRM.map((r, i) => (
                  <button
                    key={r.rm}
                    type="button"
                    onClick={() => setRm(rmOptions.includes(r.rm) ? r.rm : '')}
                    title={rmOptions.includes(r.rm) ? `Show only ${r.rm}` : undefined}
                    className="flex items-center gap-3.5 rounded-[18px] bg-[#FAF7F2] p-4 text-left hover:bg-[#F4EEE5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B5794A]"
                  >
                    <span className="flex h-[46px] w-[46px] flex-none items-center justify-center rounded-full font-semibold text-white" style={{ background: AVATARS[i % AVATARS.length] }} aria-hidden>
                      {initialsOf(r.rm)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-[#1D2F3F]">{r.rm}</span>
                      <span className="block truncate text-[13px] text-[#6E665E]">{r.enquiries} enquiries · {r.siteVisits} visits</span>
                      <span className="block truncate text-[13px] text-[#6E665E]">{r.hot} hot · {formatPercent(r.conversionRate, 0)} conversion</span>
                    </span>
                    <span className="flex-none text-right">
                      <span className="block text-[24px] font-semibold leading-none text-[#1D2F3F]">{r.bookings}</span>
                      <span className="block text-[12px] text-[#6E665E]">booked</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Tile>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------- charts --------------------------------- */

/** Smooth area line of enquiries for the last 6 months; bookings shown under each month. */
const TrendChart: React.FC<{ series: ReturnType<typeof monthlySeries> }> = ({ series }) => {
  const gid = useId().replace(/:/g, '');
  const W = 600, H = 220, top = 20, bottom = 200;
  const max = Math.max(1, ...series.map((p) => p.enquiries));
  const step = series.length > 1 ? (W - 40) / (series.length - 1) : 0;
  const pts = series.map((p, i) => [20 + i * step, bottom - (p.enquiries / max) * (bottom - top)] as const);
  // Catmull-Rom → cubic Bézier for a soft curve
  const d = pts.reduce((acc, [x, y], i) => {
    if (i === 0) return `M${x},${y.toFixed(1)}`;
    const [x0, y0] = pts[i - 2] || pts[i - 1];
    const [x1, y1] = pts[i - 1];
    const [x3, y3] = pts[i + 1] || [x, y];
    // Control points never go below the baseline (or above the top): a count cannot dip under zero.
    const clampY = (v: number) => Math.min(bottom, Math.max(top, v));
    const c1x = x1 + (x - x0) / 6, c1y = clampY(y1 + (y - y0) / 6);
    const c2x = x - (x3 - x1) / 6, c2y = clampY(y - (y3 - y1) / 6);
    return `${acc} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${x},${y.toFixed(1)}`;
  }, '');
  const area = pts.length ? `${d} L${pts[pts.length - 1][0]},${H - 10} L${pts[0][0]},${H - 10} Z` : '';
  return (
    <div className="mt-2 flex flex-1 flex-col">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[220px] w-full flex-1" role="img" aria-label={`Enquiries per month: ${series.map((p) => `${p.label} ${p.enquiries}`).join(', ')}`}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={CLAY} stopOpacity="0.28" />
            <stop offset="1" stopColor={CLAY} stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <path d={area} fill={`url(#${gid})`} />}
        {d && <path d={d} fill="none" stroke={CLAY} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
        {pts.map(([x, y], i) => (
          <circle key={series[i].key} cx={x} cy={y} r="5" fill="#fff" stroke={CLAY} strokeWidth="3">
            <title>{`${series[i].label}: ${series[i].enquiries} enquiries · ${series[i].bookings} booked`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between px-1">
        {series.map((p) => (
          <div key={p.key} className="flex-1 text-center">
            <div className="text-[13px] text-[#8A8178]">{p.label.slice(0, 3)}</div>
            <div className="text-[12px] font-semibold text-[#1D2F3F]">{p.enquiries}<span className="font-normal text-[#8A8178]"> · {p.bookings} bk</span></div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Donut of lead stages with the open-lead count in the middle; the legend drills down. */
const PipelineRing: React.FC<{ rows: Array<{ key: string; label: string; count: number; percent: number }>; center: number; onClick: (stage: string) => void }> = ({ rows, center, onClick }) => {
  if (!rows.length) return <EmptyState title="No data" className="py-6" />;
  const total = Math.max(1, rows.reduce((a, r) => a + r.count, 0));
  const R = 46, C = 2 * Math.PI * R;
  let acc = 0;
  const arcs = rows.map((r) => {
    const len = (r.count / total) * C;
    const arc = { key: r.key, color: stageColor(r.key), dash: `${Math.max(0, len - (rows.length > 1 ? 1.5 : 0)).toFixed(1)} ${C.toFixed(1)}`, offset: (-acc).toFixed(1) };
    acc += len;
    return arc;
  });
  return (
    <>
      <div className="relative mx-auto h-[170px] w-[170px]">
        <svg viewBox="0 0 120 120" className="h-[170px] w-[170px] -rotate-90" aria-hidden>
          <circle cx="60" cy="60" r={R} fill="none" stroke={SAND} strokeWidth="16" />
          {arcs.map((a) => <circle key={a.key} cx="60" cy="60" r={R} fill="none" stroke={a.color} strokeWidth="16" strokeDasharray={a.dash} strokeDashoffset={a.offset} />)}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[30px] font-semibold text-[#1D2F3F]">{center}</span>
          <span className="text-[12px] text-[#6E665E]">open leads</span>
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">
        {rows.map((r) => (
          <li key={r.key}>
            <button type="button" onClick={() => onClick(r.key)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[#FAF7F2]" title={`${r.label}: ${r.count} (${formatPercent(r.percent, 0)})`}>
              <span className="h-[9px] w-[9px] flex-none rounded-[3px]" style={{ background: stageColor(r.key) }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <strong className="text-[#1D2F3F]">{r.count}</strong>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
};
