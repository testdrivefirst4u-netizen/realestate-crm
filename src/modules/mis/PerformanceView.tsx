/**
 * YTD / MTD — the management summary on one report date: for the day (FTD), month to date (MTD), year to date (YTD)
 * and the pipeline overall. Counted with the Sales MIS rules (misData: perfRow, pipelineNow), so both screens agree.
 */
import React, { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Lead, SyncState } from '../../types/crm';
import { F } from '../../core/config';
import { dateKey } from '../../core/dates';
import { Button, Select } from '../../components/ui';
import { PageSkeleton } from '../../components/Skeletons';
import { BLANK, UNASSIGNED, fmtKey, perfRanges, perfRow, pipelineNow, toMisLeads, uniq, type MisLead } from './misData';

export interface PerformanceViewProps {
  leads: Lead[];
  sync: SyncState;
  onRefresh: () => void;
  onShowLeads: (label: string, ids: string[]) => void;
}

export const PerformanceView: React.FC<PerformanceViewProps> = ({ leads, sync, onRefresh, onShowLeads }) => {
  const today = dateKey(new Date());
  const [rm, setRm] = useState('');
  const [source, setSource] = useState('');
  const all = useMemo(() => toMisLeads(leads, new Map()), [leads]);
  const rmOptions = useMemo(() => (all.some((l) => !l.rm) ? uniq(all.map((l) => l.rm)).concat(UNASSIGNED) : uniq(all.map((l) => l.rm))), [all]);
  const sourceOptions = useMemo(() => (all.some((l) => !l.source) ? uniq(all.map((l) => l.source)).concat(BLANK) : uniq(all.map((l) => l.source))), [all]);
  const list = useMemo(
    () => all.filter((l) => (!rm || (rm === UNASSIGNED ? !l.rm : l.rm === rm)) && (!source || (source === BLANK ? !l.source : l.source === source))),
    [all, rm, source],
  );

  if (leads.length === 0 && (sync.status === 'loading' || (!sync.hasLoadedOnce && sync.status === 'syncing'))) {
    return <PageSkeleton variant="dashboard" label="Loading…" />;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight">YTD / MTD performance</h2>
          <p className="text-xs text-[#5E778C] mt-0.5">For the day, month to date, year to date and the whole pipeline · updates on its own as leads come in</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44"><Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All representatives" aria-label="Sales representative" /></div>
          <div className="w-40"><Select value={source} onChange={(e) => setSource(e.target.value)} options={sourceOptions} placeholder="All sources" aria-label="Lead source" /></div>
          <Button variant="secondary" onClick={onRefresh} icon={<RefreshCw size={13} className={sync.status === 'syncing' ? 'animate-spin' : ''} />}>Refresh</Button>
        </div>
      </div>
      <EnquiryPerformance nonDate={list} today={today} show={(label, ls) => onShowLeads(label, ls.map((l) => l.id))} />
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const PERF_COLOURS = { received: '#1F3A8A', qualified: '#1E7A3C', unqualified: '#B42318', nonResponding: '#C2410C', open: '#3B82C4', visits: '#6B21A8', warm: '#B45309', hot: '#BE123C', planned: '#4338CA' };
const two = (n: number) => String(n).padStart(2, '0');

const PerfBlock: React.FC<{ title: string; sub: string; tiles: Array<[string, string, MisLead[], string?]>; show: (label: string, ls: MisLead[]) => void }> = ({ title, sub, tiles, show }) => (
  <div className="rounded-xl border border-[#0B2A44]/80 overflow-hidden">
    <div className="bg-[#D9CFC1] px-3 py-1.5 text-center">
      <span className="text-[13px] sm:text-sm font-bold tracking-wide text-[#0B2A44] uppercase">{title}</span>
      <span className="block text-[10.5px] font-medium text-[#5B5245]">{sub}</span>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 bg-white">
      {tiles.map(([label, colour, ls, hint]) => (
        <button
          key={label}
          type="button"
          onClick={() => show(`${label} · ${title.toLowerCase()}`, ls)}
          title={hint ? `${hint} — select to see these leads` : 'Select to see these leads'}
          className="flex flex-col border-r border-b border-[#CBD5E1] last:border-r-0 hover:bg-[#F7FAFD] focus-visible:outline-2 focus-visible:outline-[#0B6BB0] text-center"
        >
          <span className="py-3 text-3xl sm:text-4xl font-extrabold tabular-nums" style={{ color: colour }}>{two(ls.length)}</span>
          <span className="py-1.5 bg-[#EEE8E0] text-[11.5px] sm:text-[12.5px] font-semibold text-[#3D3A35] mt-auto">{label}</span>
        </button>
      ))}
    </div>
  </div>
);

/** The management summary: for the day, month to date, year to date and the pipeline overall, on one report date. */
export const EnquiryPerformance: React.FC<{ nonDate: MisLead[]; today: string; show: (label: string, ls: MisLead[]) => void }> = ({ nonDate, today, show }) => {
  const [day, setDay] = useState(today);
  const d = day && day <= today ? day : today;
  const r = useMemo(() => perfRanges(d), [d]);
  const rows = useMemo(() => ({ ftd: perfRow(nonDate, r.ftd), mtd: perfRow(nonDate, r.mtd), ytd: perfRow(nonDate, r.ytd) }), [nonDate, r]);
  const pipe = useMemo(() => pipelineNow(nonDate), [nonDate]);
  const C = PERF_COLOURS;
  const tiles = (p: ReturnType<typeof perfRow>): Array<[string, string, MisLead[], string?]> => [
    ['Leads Received', C.received, p.received, 'Enquiries that came in, by enquiry date'],
    ['Qualified Leads', C.qualified, p.qualified, 'Of those: qualified, site visit, HOT, Warm or booked'],
    ['Unqualified Leads', C.unqualified, p.unqualified, 'Of those: disqualified (budget, location, junk…), not counting non-responding'],
    ['Non-Responding', C.nonResponding, p.nonResponding, 'Of those: stage Not Responding'],
    ['Open Enquiries', C.open, p.open, 'Of those: still new or open'],
    ['Site Visits', C.visits, p.visits, 'Site visits done in this period, by visit date'],
  ];
  const year = d.slice(0, 4);
  return (
    <section aria-label="Enquiry performance" className="bg-white rounded-2xl border border-[#D3E3F0] shadow-xs p-3 sm:p-4 space-y-3">
      <div className="rounded-xl border border-[#0B2A44] overflow-hidden">
        <div className="bg-[#1F3A4F] text-white text-center py-2 text-base sm:text-lg font-bold tracking-wide">Enquiry Performance Dashboard</div>
        <div className="flex items-center justify-center gap-2 py-1.5 text-[13px] font-bold text-[#0B2A44]">
          <label htmlFor="perf-date">Report Date:</label>
          <input id="perf-date" type="date" value={d} max={today} onChange={(e) => setDay(e.target.value || today)} className="text-[13px] font-bold px-1.5 py-0.5 rounded border border-[#A9BDCD] text-[#0B2A44]" />
          {d !== today && <button type="button" onClick={() => setDay(today)} className="text-[11px] font-semibold text-[#0B5E9C] hover:underline">Today</button>}
        </div>
      </div>
      <PerfBlock title="For the day (FTD) overview" sub={fmtKey(d)} tiles={tiles(rows.ftd)} show={show} />
      <PerfBlock title="Month to date (MTD) overview" sub={`${fmtKey(r.mtd[0])} to ${fmtKey(d)}`} tiles={tiles(rows.mtd)} show={show} />
      <PerfBlock title="Year to date (YTD) overview" sub={`${fmtKey(r.ytd[0])} to ${fmtKey(d)} · calendar year ${year}`} tiles={tiles(rows.ytd)} show={show} />
      <PerfBlock
        title="Pipeline stages & conversions (overall)"
        sub="All enquiries, as they stand now"
        tiles={[
          ['Total Enquiries', C.received, pipe.total],
          ['Qualified Leads', C.qualified, pipe.qualified, 'Qualified, site visit, HOT, Warm or booked'],
          ['Warm Leads', C.warm, pipe.warm],
          ['Hot Leads', C.hot, pipe.hot],
          ['Site Visits Planned', C.planned, pipe.svPlanned, 'Prospect for site visit or visit scheduled, still open'],
          ['Site Visits Completed', C.visits, pipe.svDone, 'Site visit done or walk-in'],
        ]}
        show={show}
      />
      <p className="text-[11px] text-[#7E93A6] px-1">Received leads split into qualified, unqualified, non-responding and open, so those four add up to Leads Received. Site visits count visits done on those dates. The representative and source filters apply to every block; select any number to see the leads.</p>
      {pipe.svDoneUndated.length > 0 && (
        <p className="text-[11px] text-[#B54708] px-1">
          {pipe.svDoneUndated.length} completed site visit{pipe.svDoneUndated.length === 1 ? ' has' : 's have'} no visit date, so {pipe.svDoneUndated.length === 1 ? 'it is' : 'they are'} counted in the overall total but not in the day, month or year.{' '}
          <button type="button" onClick={() => show('Site visits done without a visit date', pipe.svDoneUndated)} className="font-semibold underline">Show them</button> to add the dates.
        </p>
      )}
    </section>
  );
};

