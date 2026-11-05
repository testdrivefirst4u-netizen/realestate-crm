/**
 * Website analytics (/analytics; server: modules/analyticsReports.ts): the standard Google Analytics reports in the same
 * order, each with its figures against the days before, a chart and a table; "Website vs CRM" (AnalyticsView.tsx) adds
 * what only the CRM knows. Charts: one metric on one axis, the earlier days as a dashed line, hover shows the day.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, RefreshCw, Search } from 'lucide-react';
import { api, type AnalyticsCard, type AnalyticsDay, type AnalyticsMetric, type AnalyticsReport } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';
import { useFeature } from '../../core/tenant';
import { AnalyticsView } from './AnalyticsView';
import { LineChart, shortDay, show } from './analyticsCharts';
import { SearchConsoleReport } from './SearchConsoleReport';

const BLUE = '#1A73E8';
const NAV: Array<{ group: string; items: Array<{ id: string; label: string }> }> = [
  { group: '', items: [{ id: 'snapshot', label: 'Reports snapshot' }, { id: 'realtime', label: 'Realtime' }] },
  { group: 'Acquisition', items: [{ id: 'userAcquisition', label: 'User acquisition' }, { id: 'trafficAcquisition', label: 'Traffic acquisition' }] },
  { group: 'Engagement', items: [{ id: 'events', label: 'Events' }, { id: 'pages', label: 'Pages and screens' }, { id: 'landingPages', label: 'Landing page' }] },
  { group: 'User', items: [{ id: 'demographics', label: 'Demographic details' }, { id: 'tech', label: 'Tech details' }] },
  { group: 'Google Search', items: [{ id: 'search', label: 'Search Console' }] },
  { group: 'CRM', items: [{ id: 'crm', label: 'Website vs CRM' }] },
];
const PRESETS = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'last7', label: 'Last 7 days' }, { id: 'last28', label: 'Last 28 days' }, { id: 'last30', label: 'Last 30 days' },
  { id: 'last90', label: 'Last 90 days' }, { id: 'last365', label: 'Last 12 months' }, { id: 'custom', label: 'Custom' },
];
const PAGE = 25;
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

/** Change against the days before, with an arrow as well as the colour. */
const Delta: React.FC<{ now: number; before: number | undefined }> = ({ now, before }) => {
  if (before === undefined) return null;
  if (before === 0) return <span className="text-[11px] text-[#5F6368]">{now ? 'new' : 'no change'}</span>;
  const change = ((now - before) / before) * 100;
  if (Math.abs(change) < 0.05) return <span className="text-[11px] text-[#5F6368]">no change</span>;
  return <span className={cx('inline-flex items-center gap-0.5 text-[11px] font-medium', change > 0 ? 'text-[#137333]' : 'text-[#A50E0E]')}>{change > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(change).toFixed(1)}%</span>;
};

/** The figures across the top; choosing one puts it on the chart. */
const MetricTabs: React.FC<{ data: AnalyticsReport; chosen: string; onChoose: (id: string) => void; max?: number }> = ({ data, chosen, onChoose, max = 5 }) => (
  <div role="tablist" aria-label="Metric on the chart" className="flex flex-wrap border-b border-[#E8EAED]">
    {data.metrics.slice(0, max).map((m) => (
      <button key={m.id} type="button" role="tab" aria-selected={chosen === m.id} onClick={() => onChoose(m.id)} className={cx('-mb-px min-w-[120px] flex-1 border-b-2 px-3 py-2.5 text-left', chosen === m.id ? 'border-[#1A73E8] bg-[#F8FBFF]' : 'border-transparent hover:bg-[#F8F9FA]')}>
        <span className="block truncate text-[11px] text-[#5F6368]">{m.label}</span>
        <span className="mt-0.5 flex flex-wrap items-baseline gap-1.5"><b className="text-[19px] font-medium text-[#202124]">{show(data.totals[m.id] || 0, m, data.currency)}</b><Delta now={data.totals[m.id] || 0} before={data.prevTotals?.[m.id]} /></span>
      </button>
    ))}
  </div>
);

/** A small table with a bar behind each value. */
const SummaryCard: React.FC<{ card: AnalyticsCard; currency: string }> = ({ card, currency }) => {
  const top = Math.max(1, ...card.rows.map((r) => r.values[card.metric.id] || 0));
  return (
    <section className="rounded-lg border border-[#DADCE0] bg-white p-4">
      <h3 className="text-[13px] font-medium text-[#202124]">{card.title}</h3>
      <div className="mt-2 flex justify-between border-b border-[#E8EAED] pb-1 text-[10.5px] uppercase tracking-wide text-[#5F6368]"><span>{card.dimension}</span><span>{card.metric.label}</span></div>
      {card.error ? <p className="mt-2 text-xs text-[#A50E0E]">{card.error}</p> : !card.rows.length ? <p className="mt-2 text-xs text-[#5F6368]">No data for these days.</p> : (
        <ul className="mt-1">
          {card.rows.map((r) => (
            <li key={r.name} className="py-1 text-xs text-[#202124]">
              <div className="flex justify-between gap-3"><span className="truncate" title={r.name}>{r.name}</span><span className="tabular-nums">{show(r.values[card.metric.id] || 0, card.metric, currency)}</span></div>
              <div className="mt-1 h-1 rounded-full bg-[#F1F3F4]"><div className="h-1 rounded-full" style={{ width: `${((r.values[card.metric.id] || 0) / top) * 100}%`, background: BLUE }} /></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const RealtimeCard: React.FC<{ rt: NonNullable<AnalyticsReport['realtime']> }> = ({ rt }) => {
  const top = Math.max(1, ...rt.perMinute.map((m) => m.users));
  return (
    <section className="rounded-lg border border-[#DADCE0] bg-white p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-[#5F6368]">Active users in the last 30 minutes</h3>
      <b className="mt-1 block text-3xl font-medium text-[#202124]">{rt.activeUsers.toLocaleString('en-IN')}</b>
      <div className="mt-3 flex h-20 items-end gap-[2px] border-b border-[#DADCE0]" role="img" aria-label={`Active users per minute over the last 30 minutes, ${rt.activeUsers} in all`}>
        {rt.perMinute.map((m) => <div key={m.minutesAgo} title={`${m.minutesAgo} minutes ago: ${m.users}`} className="flex-1 rounded-t-[2px]" style={{ height: `${m.users ? Math.max(4, (m.users / top) * 100) : 0}%`, background: BLUE }} />)}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-[#5F6368]"><span>30 minutes ago</span><span>Now</span></div>
    </section>
  );
};

/** The report's table: its dimension, search, sort, pages, and Google's own total on top. */
const ReportTable: React.FC<{ data: AnalyticsReport; onDimension: (id: string) => void }> = ({ data, onDimension }) => {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ id: string; desc: boolean }>({ id: data.metrics[0]?.id || '', desc: true });
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); setSearch(''); }, [data.dimension, data.report]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data.rows.filter((r) => !q || r.name.toLowerCase().includes(q));
    return [...list].sort((a, b) => (sort.id === '__name' ? a.name.localeCompare(b.name) : (a.values[sort.id] || 0) - (b.values[sort.id] || 0)) * (sort.desc ? -1 : 1));
  }, [data.rows, search, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  const label = data.dimensions.find((d) => d.id === data.dimension)?.label || '';
  const head = (id: string, text: string, right: boolean) => (
    <th className={cx('whitespace-nowrap px-3 py-2 text-[11px] font-medium text-[#5F6368]', right ? 'text-right' : 'text-left')} aria-sort={sort.id === id ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-[#1A73E8]" onClick={() => setSort((s) => (s.id === id ? { id, desc: !s.desc } : { id, desc: id !== '__name' }))}>{text}{sort.id === id && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}</button>
    </th>
  );
  return (
    <section className="rounded-lg border border-[#DADCE0] bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#E8EAED] p-3">
        <label className="relative min-w-[180px] flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5F6368]" />
          <input className={cx(inputCls, 'pl-8')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Search" aria-label={`Search ${label}`} />
        </label>
        {data.dimensions.length > 1 && (
          <select className={cx(inputCls, 'w-auto')} value={data.dimension} onChange={(e) => onDimension(e.target.value)} aria-label="Dimension">
            {data.dimensions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        )}
        <span className="text-[11px] text-[#5F6368]">{data.rowCount > data.rows.length ? `Top ${data.rows.length} of ${data.rowCount.toLocaleString('en-IN')} rows` : `${rows.length} row${rows.length === 1 ? '' : 's'}`}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[#E8EAED]">{head('__name', label, false)}{data.metrics.map((m) => <React.Fragment key={m.id}>{head(m.id, m.label, true)}</React.Fragment>)}</tr>
            <tr className="border-b border-[#DADCE0] bg-[#F8F9FA]">
              <td className="px-3 py-2 text-xs font-medium text-[#202124]">Total</td>
              {data.metrics.map((m) => <td key={m.id} className="whitespace-nowrap px-3 py-2 text-right text-xs font-medium tabular-nums text-[#202124]">{show(data.totals[m.id] || 0, m, data.currency)}</td>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1F3F4]">
            {!shown.length ? <tr><td colSpan={data.metrics.length + 1} className="p-6 text-center text-xs text-[#5F6368]">No data for these days.</td></tr> : shown.map((r, i) => (
              <tr key={r.name} className="hover:bg-[#F8F9FA]">
                <td className="max-w-[340px] truncate px-3 py-2 text-xs text-[#202124]" title={r.name}><span className="mr-2 text-[#80868B]">{page * PAGE + i + 1}</span>{r.name}</td>
                {data.metrics.map((m) => <td key={m.id} className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-[#202124]">{show(r.values[m.id] || 0, m, data.currency)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-[#E8EAED] p-2 text-[11px] text-[#5F6368]">
          <Button variant="secondary" size="xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {page + 1} of {pages}</span>
          <Button variant="secondary" size="xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </section>
  );
};

export const AnalyticsReports: React.FC<{ canCheckPages?: boolean }> = ({ canCheckPages = false }) => {
  const analyticsOn = useFeature('websiteAnalytics');
  const searchOn = useFeature('searchConsole');
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter((i) => (i.id === 'search' ? searchOn : analyticsOn)) })).filter((g) => g.items.length);
  const [report, setReport] = useState(analyticsOn ? 'snapshot' : 'search');
  const [dimension, setDimension] = useState('');
  const [preset, setPreset] = useState('last28');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [compare, setCompare] = useState(true);
  const [data, setData] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [metric, setMetric] = useState('');
  const latest = useRef(0);
  const custom = preset === 'custom';

  const load = useCallback(async (refresh = false) => {
    if (report === 'crm' || report === 'search' || (custom && (!from || !to))) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.analytics.report({ report, dimension: dimension || undefined, compare, refresh, ...(custom ? { from, to } : { preset }) });
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('analytics.report', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [report, dimension, preset, from, to, compare, custom]);
  useEffect(() => void load(), [load]);
  // realtime moves by itself
  useEffect(() => {
    if (report !== 'realtime') return;
    const t = setInterval(() => void load(), 60000);
    return () => clearInterval(t);
  }, [report, load]);

  const open = (id: string) => { setReport(id); setDimension(''); setMetric(''); setData(null); setFailed(''); };
  const current = data && data.report === report ? data : null;
  const chosen = current?.metrics.find((m) => m.id === metric) || current?.metrics[0];
  const cards = (current?.cards || []);

  return (
    <div className="flex min-h-full flex-col bg-[#F8F9FA] lg:flex-row">
      <nav aria-label="Reports" className="hidden w-52 flex-none border-r border-[#DADCE0] bg-white p-2 lg:block">
        {nav.map((g) => (
          <div key={g.group || 'top'} className="mb-2">
            {g.group && <h3 className="px-3 pb-1 pt-2 text-[11px] font-medium text-[#5F6368]">{g.group}</h3>}
            {g.items.map((i) => <button key={i.id} type="button" aria-current={report === i.id ? 'page' : undefined} onClick={() => open(i.id)} className={cx('block w-full rounded-r-full px-3 py-1.5 text-left text-[13px]', report === i.id ? 'bg-[#E8F0FE] font-medium text-[#1967D2]' : 'text-[#202124] hover:bg-[#F1F3F4]')}>{i.label}</button>)}
          </div>
        ))}
      </nav>

      <main className="min-w-0 flex-1 space-y-3 p-3 sm:p-5">
        <select className={cx(inputCls, 'lg:hidden')} value={report} onChange={(e) => open(e.target.value)} aria-label="Report">
          {nav.flatMap((g) => g.items).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>

        {report === 'search' ? <SearchConsoleReport canCheck={canCheckPages} /> : report === 'crm' ? <AnalyticsView /> : (
          <>
            <header className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-[20px] font-normal text-[#202124]">{NAV.flatMap((g) => g.items).find((i) => i.id === report)?.label}</h2>
                {current?.property && <p className="truncate text-[11px] text-[#5F6368]">{current.property.name}{report === 'realtime' ? ' · updates every minute' : current.from ? ` · ${shortDay(current.from)} to ${shortDay(current.to)}` : ''}</p>}
              </div>
              {report !== 'realtime' && (
                <>
                  <select className={cx(inputCls, 'w-auto')} value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
                    {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  {custom && (
                    <>
                      <input type="date" className={cx(inputCls, 'w-auto')} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                      <input type="date" className={cx(inputCls, 'w-auto')} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To" />
                    </>
                  )}
                  <label className="inline-flex items-center gap-1.5 text-xs text-[#202124]"><input type="checkbox" className="h-4 w-4 accent-[#1A73E8]" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare</label>
                </>
              )}
              <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load(true)}>Refresh</Button>
            </header>

            {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
            {current?.error && <InlineNotice tone="warning">{current.error}</InlineNotice>}
            {current?.notes.map((n) => <InlineNotice key={n} tone="info">{n}</InlineNotice>)}
            {!current && !failed && <p className="text-xs text-[#5F6368]">Loading…</p>}

            {current && !current.error && report === 'snapshot' && (
              <>
                <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
                  <section className="rounded-lg border border-[#DADCE0] bg-white">
                    <MetricTabs data={current} chosen={chosen?.id || ''} onChoose={setMetric} max={6} />
                    <div className="p-3">{chosen && <LineChart days={current.daily} metric={chosen} currency={current.currency} compare={compare} />}</div>
                  </section>
                  {current.realtime && <RealtimeCard rt={current.realtime} />}
                </div>
                <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">{cards.map((c) => <SummaryCard key={c.title} card={c} currency={current.currency} />)}</div>
              </>
            )}

            {current && !current.error && report === 'realtime' && (
              <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                {current.realtime && <RealtimeCard rt={current.realtime} />}
                {cards.map((c) => <SummaryCard key={c.title} card={c} currency={current.currency} />)}
              </div>
            )}

            {current && !current.error && report !== 'snapshot' && report !== 'realtime' && (
              <>
                <section className="rounded-lg border border-[#DADCE0] bg-white">
                  <MetricTabs data={current} chosen={chosen?.id || ''} onChoose={setMetric} />
                  <div className="p-3">{chosen && <LineChart days={current.daily} metric={chosen} currency={current.currency} compare={compare} />}</div>
                </section>
                <ReportTable data={current} onDimension={setDimension} />
              </>
            )}
            {current?.timeZone && <p className="text-[10.5px] text-[#80868B]">Figures from Google Analytics, in the property's time zone ({current.timeZone}). Google can take 24–48 hours to finish processing recent days.</p>}
          </>
        )}
      </main>
    </div>
  );
};
