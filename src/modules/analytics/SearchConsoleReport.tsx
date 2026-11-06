/**
 * Search Console, /searchconsole (server: modules/searchConsole.ts): clicks, impressions, CTR and position, the top
 * searches, pages, countries and devices, sitemaps, and which pages Google has indexed. Google gives no total of indexed
 * pages, so that figure counts the pages checked one by one, and the screen says what it covers.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, RefreshCw, Search } from 'lucide-react';
import { api, type AnalyticsDay, type AnalyticsMetric, type IndexingSummary, type SearchPerformance, type SearchRow } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';
import { LineChart } from './analyticsCharts';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const METRICS: AnalyticsMetric[] = [
  { id: 'clicks', label: 'Total clicks', format: 'number' }, { id: 'impressions', label: 'Total impressions', format: 'number' },
  { id: 'ctr', label: 'Average CTR', format: 'percent' }, { id: 'position', label: 'Average position', format: 'decimal' },
];
const PRESETS = [{ id: 'last7', label: 'Last 7 days' }, { id: 'last28', label: 'Last 28 days' }, { id: 'last90', label: 'Last 3 months' }, { id: 'last180', label: 'Last 6 months' }, { id: 'last365', label: 'Last 12 months' }];
const TABLES = [{ id: 'queries', label: 'Queries' }, { id: 'pages', label: 'Pages' }, { id: 'countries', label: 'Countries' }, { id: 'devices', label: 'Devices' }, { id: 'indexing', label: 'Indexing' }, { id: 'sitemaps', label: 'Sitemaps' }] as const;
type TableId = (typeof TABLES)[number]['id'];
type RowKey = 'clicks' | 'impressions' | 'ctr' | 'position';
const n = (v: number) => Math.round(v).toLocaleString('en-IN');
const fmt = (id: string, v: number) => (id === 'ctr' ? `${(v * 100).toFixed(1)}%` : id === 'position' ? v.toFixed(1) : n(v));

const Change: React.FC<{ id: string; now: number; before?: number }> = ({ id, now, before }) => {
  if (before === undefined || before === 0) return null;
  const change = ((now - before) / before) * 100;
  if (Math.abs(change) < 0.05) return <span className="text-[11px] text-[#5F6368]">no change</span>;
  // a lower position number is better
  const good = id === 'position' ? change < 0 : change > 0;
  return <span className={cx('inline-flex items-center gap-0.5 text-[11px] font-medium', good ? 'text-[#137333]' : 'text-[#A50E0E]')}>{change > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(change).toFixed(1)}%</span>;
};

const RowsTable: React.FC<{ rows: SearchRow[]; label: string; upper?: boolean }> = ({ rows, label, upper }) => {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ id: RowKey; desc: boolean }>({ id: 'clicks', desc: true });
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => !term || r.name.toLowerCase().includes(term)).sort((a, b) => (a[sort.id] - b[sort.id]) * (sort.desc ? -1 : 1));
  }, [rows, q, sort]);
  const head = (id: RowKey, text: string) => (
    <th className="whitespace-nowrap px-3 py-2 text-right text-[11px] font-medium text-[#5F6368]" aria-sort={sort.id === id ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-[#1A73E8]" onClick={() => setSort((s) => (s.id === id ? { id, desc: !s.desc } : { id, desc: true }))}>{text}{sort.id === id && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}</button>
    </th>
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-[#E8EAED] p-3">
        <label className="relative min-w-[180px] flex-1"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5F6368]" /><input className={cx(inputCls, 'pl-8')} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${label}`} /></label>
        <span className="text-[11px] text-[#5F6368]">{shown.length} rows{rows.length >= 250 ? ' (top 250)' : ''}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead><tr className="border-b border-[#E8EAED]"><th className="px-3 py-2 text-left text-[11px] font-medium text-[#5F6368]">{label}</th>{head('clicks', 'Clicks')}{head('impressions', 'Impressions')}{head('ctr', 'CTR')}{head('position', 'Position')}</tr></thead>
          <tbody className="divide-y divide-[#F1F3F4]">
            {!shown.length ? <tr><td colSpan={5} className="p-6 text-center text-xs text-[#5F6368]">No data for these days.</td></tr> : shown.map((r) => (
              <tr key={r.name} className="text-xs text-[#202124] hover:bg-[#F8F9FA]">
                <td className={cx('max-w-[420px] truncate px-3 py-2', upper && 'uppercase')} title={r.name}>{r.name || '(not set)'}</td>
                {(['clicks', 'impressions', 'ctr', 'position'] as RowKey[]).map((k) => <td key={k} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{fmt(k, r[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

const IndexingPanel: React.FC<{ canCheck: boolean }> = ({ canCheck }) => {
  const [data, setData] = useState<IndexingSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.searchConsole.indexing().then(setData).catch((e) => toast('Could not load indexing', errText('gsc.indexing', e), 'alert'));
  }, []);
  const check = async () => {
    setBusy(true);
    try {
      const r = await api.searchConsole.checkIndexing();
      setData(r);
      setNote(r.note);
      setMore(r.more);
      toast(`${r.justChecked} page${r.justChecked === 1 ? '' : 's'} checked`, undefined, r.justChecked ? 'success' : 'info');
    } catch (e) {
      toast('Could not check pages', errText('gsc.check', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  const rows = (data?.rows || []).filter((r) => !q.trim() || r.url.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-[#5F6368]">Google gives no total of indexed pages, so each page in your sitemaps is checked one by one. Google allows about 2,000 checks a day per site{data ? `, ${n(data.usedToday)} used today` : ''}. This can differ from Google's Pages report, and is as of each page's check.</p>
        {canCheck && <Button size="sm" loading={busy} icon={<RefreshCw size={13} />} onClick={() => void check()}>{more ? 'Check more pages' : 'Check pages'}</Button>}
      </div>
      {note && <InlineNotice tone="warning">{note}</InlineNotice>}
      {data && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['Indexed', data.indexed], ['Not indexed', data.notIndexed], ['Not checked yet', data.unchecked], ['Pages listed', data.total]].map(([label, v]) => (
            <div key={label as string} className="rounded-lg border border-[#E8EAED] p-3"><dt className="text-[11px] text-[#5F6368]">{label}</dt><dd className="text-[22px] font-medium text-[#202124]">{n(v as number)}</dd></div>
          ))}
        </dl>
      )}
      {data && data.failed > 0 && <p className="text-xs text-[#A50E0E]">{data.failed} page{data.failed === 1 ? '' : 's'} could not be checked, and will be tried again.</p>}
      {data && !data.total && <p className="text-xs text-[#5F6368]">No pages checked yet.{canCheck ? ' Click Check pages to start.' : ''}</p>}
      {data && data.reasons.length > 0 && (
        <div>
          <h3 className="text-[13px] font-medium text-[#202124]">Why pages aren't indexed</h3>
          <ul className="mt-1 divide-y divide-[#F1F3F4]">{data.reasons.map((r) => <li key={r.reason} className="flex justify-between gap-3 py-1.5 text-xs text-[#202124]"><span className="min-w-0 break-words">{r.reason}</span><span className="tabular-nums">{n(r.pages)}</span></li>)}</ul>
        </div>
      )}
      {data && data.total > 0 && (
        <>
          <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages" aria-label="Search pages" />
          <div className="overflow-x-auto rounded-lg border border-[#E8EAED]">
            <table className="w-full min-w-[620px] border-collapse">
              <thead><tr className="border-b border-[#E8EAED] text-left text-[11px] font-medium text-[#5F6368]"><th className="px-3 py-2 font-medium">Page</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Last crawled</th><th className="px-3 py-2 font-medium">Checked</th></tr></thead>
              <tbody className="divide-y divide-[#F1F3F4]">
                {rows.map((r) => (
                  <tr key={r.url} className="align-top text-xs text-[#202124]">
                    <td className="max-w-[360px] truncate px-3 py-2" title={r.url}>{r.url}</td>
                    <td className="px-3 py-2">{r.error ? <span className="text-[#A50E0E]" title={r.error}>Could not check</span> : !r.checkedAt ? <span className="text-[#5F6368]">Not checked yet</span> : r.verdict === 'PASS' ? <span className="font-medium text-[#137333]">Indexed</span> : <span>{r.coverage || 'Not indexed'}</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2">{r.lastCrawl ? new Date(r.lastCrawl).toLocaleDateString() : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">{r.checkedAt ? new Date(r.checkedAt).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > data.rows.length && <p className="text-[11px] text-[#5F6368]">Showing the first {data.rows.length} of {n(data.total)} pages.</p>}
        </>
      )}
    </div>
  );
};

export const SearchConsoleReport: React.FC<{ canCheck: boolean }> = ({ canCheck }) => {
  const [preset, setPreset] = useState('last28');
  const [data, setData] = useState<SearchPerformance | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [metric, setMetric] = useState('clicks');
  const [table, setTable] = useState<TableId>('queries');
  const latest = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.searchConsole.performance({ preset, refresh });
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('gsc.performance', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [preset]);
  useEffect(() => void load(), [load]);

  const chosen = METRICS.find((m) => m.id === metric) || METRICS[0];
  const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          {data?.siteUrl && <p className="truncate text-[11px] text-[#5F6368]">{data.siteUrl.replace(/^sc-domain:/, '')} · {shortDate(data.from)} to {shortDate(data.to)}</p>}
        </div>
        <select className={cx(inputCls, 'w-auto')} value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load(true)}>Refresh</Button>
      </header>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {data?.error && <InlineNotice tone="warning">{data.error}</InlineNotice>}
      {!data && !failed && <p className="text-xs text-[#5F6368]">Loading…</p>}
      {data && !data.error && data.totals && (
        <>
          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <div role="tablist" aria-label="Metric on the chart" className="flex flex-wrap border-b border-[#E8EAED]">
              {METRICS.map((m) => {
                const v = data.totals![m.id as RowKey];
                return (
                  <button key={m.id} type="button" role="tab" aria-selected={metric === m.id} onClick={() => setMetric(m.id)} className={cx('-mb-px min-w-[120px] flex-1 border-b-2 px-3 py-2.5 text-left', metric === m.id ? 'border-[#1A73E8] bg-[#F8FBFF]' : 'border-transparent hover:bg-[#F8F9FA]')}>
                    <span className="block truncate text-[11px] text-[#5F6368]">{m.label}</span>
                    <span className="mt-0.5 flex flex-wrap items-baseline gap-1.5"><b className="text-[19px] font-medium text-[#202124]">{fmt(m.id, v)}</b><Change id={m.id} now={v} before={data.prevTotals?.[m.id as RowKey]} /></span>
                  </button>
                );
              })}
            </div>
            <div className="p-3"><LineChart days={data.daily as AnalyticsDay[]} metric={chosen} currency="" compare={!!data.prevTotals} /></div>
          </section>

          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <div role="tablist" aria-label="Report" className="flex flex-wrap border-b border-[#E8EAED]">
              {TABLES.map((t) => <button key={t.id} type="button" role="tab" aria-selected={table === t.id} onClick={() => setTable(t.id)} className={cx('-mb-px border-b-2 px-3.5 py-2.5 text-[13px] font-medium', table === t.id ? 'border-[#1A73E8] text-[#1967D2]' : 'border-transparent text-[#5F6368] hover:bg-[#F8F9FA]')}>{t.label}</button>)}
            </div>
            {table === 'queries' && <RowsTable rows={data.queries} label="Top searches" />}
            {table === 'pages' && <RowsTable rows={data.pages} label="Top pages" />}
            {table === 'countries' && <RowsTable rows={data.countries} label="Country" upper />}
            {table === 'devices' && <RowsTable rows={data.devices} label="Device" upper />}
            {table === 'indexing' && <IndexingPanel canCheck={canCheck} />}
            {table === 'sitemaps' && (
              <div className="p-3">
                {data.sitemapsError && <InlineNotice tone="warning">{data.sitemapsError}</InlineNotice>}
                {!data.sitemaps.length && !data.sitemapsError ? <p className="text-xs text-[#5F6368]">No sitemap submitted to Google for this website.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[620px] border-collapse">
                      <thead><tr className="border-b border-[#E8EAED] text-left text-[11px] text-[#5F6368]"><th className="px-3 py-2 font-medium">Sitemap</th><th className="px-3 py-2 font-medium">Submitted</th><th className="px-3 py-2 font-medium">Last read</th><th className="px-3 py-2 text-right font-medium">Pages</th><th className="px-3 py-2 text-right font-medium">Errors</th><th className="px-3 py-2 text-right font-medium">Warnings</th></tr></thead>
                      <tbody className="divide-y divide-[#F1F3F4]">
                        {data.sitemaps.map((s) => (
                          <tr key={s.path} className="text-xs text-[#202124]">
                            <td className="max-w-[320px] truncate px-3 py-2" title={s.path}>{s.path}</td>
                            <td className="whitespace-nowrap px-3 py-2">{s.lastSubmitted ? new Date(s.lastSubmitted).toLocaleDateString() : '—'}</td>
                            <td className="whitespace-nowrap px-3 py-2">{s.pending ? 'Pending' : s.lastDownloaded ? new Date(s.lastDownloaded).toLocaleDateString() : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{n(s.submitted)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{n(s.errors)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{n(s.warnings)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
          <p className="text-[10.5px] text-[#80868B]">From Google Search Console. Figures end 2 days ago, because recent days are not final. Google hides some rare searches for privacy, so rows can add up to less than the total.</p>
        </>
      )}
    </div>
  );
};
