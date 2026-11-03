/**
 * Website analytics (/analytics, plan feature websiteAnalytics; server: modules/websiteAnalytics.ts): GA4 visitors
 * next to the CRM's enquiries, site visits and bookings for the same days.
 * Charts: one series each (visitors per day, enquiries per day) on their own axis; hover shows the day's value.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type WebsiteAnalytics } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { Card, InlineNotice, Tabs, cx } from '../../components/ui';

type Range = '7' | '30' | '90';
const ACCENT = '#1E6FB0';
const num = (n: number) => Math.round(n).toLocaleString('en-IN');
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(a / b < 0.1 ? 1 : 0)}%` : '—');
const shortDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A single-series daily bar chart: bars from a shared baseline, a hover tooltip, first / middle / last day labels. */
const DailyBars: React.FC<{ title: string; unit: string; points: Array<{ day: string; value: number }> }> = ({ title, unit, points }) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((t, p) => t + p.value, 0);
  const ticks = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  return (
    <Card title={title} subtitle={`${num(total)} ${unit} in ${points.length} days`}>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <div className="flex items-end h-40 gap-[2px] border-b border-[#D3E3F0]" role="img" aria-label={`${title}: ${points.map((p) => `${shortDay(p.day)} ${p.value}`).join(', ')}`}>
          {points.map((p, i) => (
            <div key={p.day} className="relative flex-1 h-full flex items-end" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
              <div className="w-full rounded-t-[4px] transition-opacity" style={{ height: `${Math.max(p.value ? 2 : 0, (p.value / max) * 100)}%`, background: ACCENT, opacity: hover === null || hover === i ? 1 : 0.45 }} />
            </div>
          ))}
        </div>
        <span className="absolute -top-1 left-0 text-[10px] text-[#7E93A6] tabular-nums">{num(max)}</span>
        <div className="relative h-5 text-[10.5px] text-[#7E93A6]">
          {[...new Set(ticks)].map((i) => (
            <span key={i} className="absolute top-1 -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / points.length) * 100}%` }}>{points[i] ? shortDay(points[i].day) : ''}</span>
          ))}
        </div>
        {hover !== null && points[hover] && (
          <div className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 rounded-md bg-[#0B2A44] px-2 py-1 text-[11px] text-white shadow whitespace-nowrap" style={{ left: `${((hover + 0.5) / points.length) * 100}%` }}>
            {shortDay(points[hover].day)}: <b className="tabular-nums">{num(points[hover].value)}</b> {unit}
          </div>
        )}
      </div>
    </Card>
  );
};

/** Horizontal bars for a ranked list (one hue; the value is printed in text ink beside the bar). */
const RankBars: React.FC<{ rows: Array<{ name: string; value: number; note?: string }>; empty: string }> = ({ rows, empty }) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-xs text-[#7E93A6]">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.name} className="text-xs" title={`${r.name}: ${num(r.value)}${r.note ? ' · ' + r.note : ''}`}>
          <div className="flex justify-between gap-2"><span className="truncate text-[#0B2A44]">{r.name}</span><span className="tabular-nums text-[#2B4A63]">{num(r.value)}{r.note && <span className="text-[#7E93A6]"> · {r.note}</span>}</span></div>
          <div className="mt-1 h-2 rounded-full bg-[#EEF4F9]"><div className="h-2 rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: ACCENT }} /></div>
        </li>
      ))}
    </ul>
  );
};

const Tile: React.FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <div className="rounded-xl border border-[#E3EDF5] bg-white p-3">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#7E93A6]">{label}</p>
    <p className="text-2xl font-bold text-[#0B2A44] tabular-nums mt-0.5">{value}</p>
    {note && <p className="text-[11px] text-[#5E778C]">{note}</p>}
  </div>
);

export const AnalyticsView: React.FC = () => {
  const [range, setRange] = useState<Range>('30');
  const [data, setData] = useState<WebsiteAnalytics | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setData(await api.analytics.get(Number(range) as 7 | 30 | 90, refresh));
      setError('');
    } catch (e) {
      setError(toAppError(reportError('analytics.get', e)).userMessage);
    } finally {
      setLoading(false);
    }
  }, [range]);
  useEffect(() => void load(), [load]);

  const w = data?.web, c = data?.crm;
  const funnel = w && c ? [
    { name: 'Website visitors', value: w.visitors },
    { name: 'Enquiries', value: c.enquiries, note: pct(c.enquiries, w.visitors) + ' of visitors' },
    { name: 'Site visits done', value: c.siteVisits, note: pct(c.siteVisits, c.enquiries) + ' of enquiries' },
    { name: 'Bookings', value: c.bookings, note: pct(c.bookings, c.siteVisits) + ' of site visits' },
  ] : [];

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs<Range> value={range} onChange={setRange} tabs={[{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }]} />
        <span className="text-xs text-[#5E778C]">{data ? `${shortDay(data.from)} – ${shortDay(data.to)}${data.property ? ` · ${data.property.name}` : ''}` : ''}</span>
        <button type="button" onClick={() => void load(true)} className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B5E9C] hover:underline"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh</button>
      </div>
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}
      {data?.error && <InlineNotice tone="info">{data.error} The CRM figures below still show.</InlineNotice>}
      {!data ? <p className="text-xs text-[#5E778C]">Loading…</p> : (
        <>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Website visitors" value={w ? num(w.visitors) : '—'} note={w ? `${num(w.newVisitors)} new` : 'Google Analytics'} />
            <Tile label="Sessions" value={w ? num(w.sessions) : '—'} />
            <Tile label="Enquiries" value={num(c!.enquiries)} note="All sources, from the CRM" />
            <Tile label="Visitor → enquiry" value={w ? pct(c!.enquiries, w.visitors) : '—'} />
            <Tile label="Site visits done" value={num(c!.siteVisits)} note={pct(c!.siteVisits, c!.enquiries) + ' of enquiries'} />
            <Tile label="Bookings" value={num(c!.bookings)} note={pct(c!.bookings, c!.siteVisits) + ' of site visits'} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {w ? <DailyBars title="Website visitors per day" unit="visitors" points={w.daily.map((d) => ({ day: d.day, value: d.visitors }))} /> : <Card title="Website visitors per day"><p className="text-xs text-[#7E93A6]">Connect Google Analytics to see visitors.</p></Card>}
            <DailyBars title="Enquiries per day" unit="enquiries" points={c!.daily.map((d) => ({ day: d.day, value: d.enquiries }))} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="From visit to booking" subtitle="Each step as a share of the step before.">
              {w ? <RankBars rows={funnel} empty="" /> : <p className="text-xs text-[#7E93A6]">Needs Google Analytics for the visitors step.</p>}
            </Card>
            <Card title="Enquiries by source (CRM)" subtitle="Leads created in these days, with their site visits and bookings.">
              {c!.bySource.length ? (
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[10.5px] uppercase tracking-wide text-[#7E93A6]"><th className="py-1 font-semibold">Source</th><th className="py-1 font-semibold text-right">Enquiries</th><th className="py-1 font-semibold text-right">Site visits</th><th className="py-1 font-semibold text-right">Bookings</th></tr></thead>
                  <tbody className="divide-y divide-[#EEF4F9]">
                    {c!.bySource.slice(0, 12).map((s) => <tr key={s.name}><td className="py-1.5 text-[#0B2A44]">{s.name}</td><td className="py-1.5 text-right tabular-nums">{num(s.enquiries)}</td><td className="py-1.5 text-right tabular-nums">{num(s.siteVisits)}</td><td className="py-1.5 text-right tabular-nums">{num(s.bookings)}</td></tr>)}
                  </tbody>
                </table>
              ) : <p className="text-xs text-[#7E93A6]">No enquiries in these days.</p>}
            </Card>
          </div>
          {w && (
            <div className="grid gap-5 lg:grid-cols-3">
              <Card title="Visitors by channel" subtitle="How people reached the website (sessions)."><RankBars rows={w.channels.map((x) => ({ name: x.name, value: x.sessions }))} empty="No visits recorded." /></Card>
              <Card title="Top sources" subtitle="Source / medium (sessions)."><RankBars rows={w.sources.map((x) => ({ name: x.name, value: x.sessions }))} empty="No visits recorded." /></Card>
              <Card title="Top landing pages" subtitle="The first page of a visit (sessions)."><RankBars rows={w.pages.map((x) => ({ name: x.path, value: x.sessions }))} empty="No visits recorded." /></Card>
            </div>
          )}
          <p className={cx('text-[11px] text-[#7E93A6]')}>Website figures come from Google Analytics and are refreshed every 15 minutes; Google can take up to a day to finish counting the latest day.</p>
        </>
      )}
    </div>
  );
};
