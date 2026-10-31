/**
 * MisView — the Sales MIS dashboard.
 *
 * Built from live CRM data: leads come from the engine (kept current by its polling) and talk time
 * from Call History (reloaded every minute). Every number that stands for leads opens them on the
 * Leads screen through `onShowLeads`. Stage mapping, periods and formatting live in ./misData.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CallRecord, Lead, SyncState } from '../../types/crm';
import { api } from '../../core/api';
import { dateKey } from '../../core/dates';
import { reportError } from '../../core/errors';
import { Button, Select, cx } from '../../components/ui';
import { PageSkeleton } from '../../components/Skeletons';
import { SourceLogo } from '../leads/SourceLogo';
import {
  BLANK, CallDay, FUNNEL_STEPS, MIS_STAGE, MIS_STAGES, MisLead, MisStageId, NO_REASON, PERIOD_NAME, PeriodId, Range, SV_PLANNED_COLOR, UNASSIGNED, misQualified,
  addDaysKey, avgResp, callDays, changePct, funnelCounts, funnelStep, previousRange, dqReasons, firstCallByLead, fmtAvgCall, fmtDur, fmtKey, fmtKeyShort, fmtTalk, inRange, monthNameOf,
  pct, periodRange, rangeLabel, sourceColour, sourceOrder, speedBuckets, speedTone, stageCounts, toMisLeads, uniq, weekStartKey,
} from './misData';
import { REFRESH_EVENT, SITE_VISIT_DONE, STAGES } from '../../core/config';
import { stageOf } from '../../core/analytics';
import { useTenantSettings } from '../../core/tenant';
import { JcCallReport } from './JcCallReport';

export interface MisViewProps {
  leads: Lead[];
  sources: string[];
  sync: SyncState;
  /** Call History feature on and allowed. */
  canSeeCalls: boolean;
  onRefresh: () => void;
  onShowLeads: (label: string, ids: string[]) => void;
  /** May see / enter ad spend per campaign (reports.view / settings.edit). */
  canSeeSpend?: boolean;
  canEditSpend?: boolean;
}

const CALL_POLL_MS = 60_000;

/** This device remembers the MIS filters between visits. */
const FILTERS_KEY = 'crm_mis_filters';
const PERIODS: PeriodId[] = ['today', 'week', 'month', 'all', 'custom'];

interface SavedFilters { period: PeriodId; custom: Range; teamPeriod: PeriodId; rm: string; source: string; country: string; state: string; city: string }

function loadFilters(): SavedFilters {
  const out: SavedFilters = { period: 'month', custom: ['', ''], teamPeriod: 'week', rm: '', source: '', country: '', state: '', city: '' };
  try {
    const v = JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}');
    if (PERIODS.includes(v.period)) out.period = v.period;
    if (PERIODS.includes(v.teamPeriod) && v.teamPeriod !== 'custom') out.teamPeriod = v.teamPeriod;
    if (Array.isArray(v.custom) && v.custom.length === 2) out.custom = [String(v.custom[0] || ''), String(v.custom[1] || '')];
    for (const k of ['rm', 'source', 'country', 'state', 'city'] as const) if (typeof v[k] === 'string') out[k] = v[k];
  } catch {
    /* nothing saved, or storage blocked */
  }
  return out;
}

/* ------------------------------- small UI -------------------------------- */

const Panel: React.FC<{ title: React.ReactNode; hint?: React.ReactNode; actions?: React.ReactNode; className?: string; children: React.ReactNode }> = ({ title, hint, actions, className, children }) => (
  <section className={cx('bg-white rounded-2xl border border-[#D3E3F0] shadow-xs p-4 sm:p-5 min-w-0', className)}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="text-base font-bold text-[#0B2A44] tracking-tight">{title}</h3>
      {actions}
    </div>
    {hint && <p className="text-xs text-[#5E778C] mt-1 mb-3">{hint}</p>}
    {children}
  </section>
);

const PeriodButtons: React.FC<{ value: string; options: PeriodId[]; onChange: (p: PeriodId) => void; label: string }> = ({ value, options, onChange, label }) => (
  <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
    {options.map((p) => (
      <button
        key={p}
        type="button"
        aria-pressed={value === p}
        onClick={() => onChange(p)}
        className={cx(
          'rounded-full px-3.5 py-1.5 text-xs font-semibold border transition',
          value === p ? 'bg-[#0B2A44] border-[#0B2A44] text-white' : 'bg-white border-[#D3E3F0] text-[#0B2A44] hover:bg-[#F2F7FB]',
        )}
      >
        {PERIOD_NAME[p]}
      </button>
    ))}
  </div>
);

const Dot: React.FC<{ color: string; square?: boolean }> = ({ color, square }) => (
  <i className={cx('inline-block w-2 h-2 mr-1.5 align-middle flex-shrink-0', square ? 'rounded-sm' : 'rounded-full')} style={{ background: color }} />
);

const Pc: React.FC<{ n: number; of: number; suffix?: string }> = ({ n, of, suffix }) => (of ? <span className="text-[#7E93A6] text-[10px] font-normal ml-1">{pct(n, of)}{suffix}</span> : null);

/** ▲ / ▼ change against the earlier period; green when it moved the right way. */
const Trend: React.FC<{ now: number; before: number; bad?: boolean; title: string }> = ({ now, before, bad, title }) => {
  if (!now && !before) return null;
  const d = changePct(now, before);
  if (d === null) return <span className="block text-[10px] font-semibold text-[#0E8A7D]" title={`Earlier: ${title}`}>new</span>;
  if (d === 0) return <span className="block text-[10px] text-[#A9BDCD]" title={`Earlier: ${title}`}>= same</span>;
  const good = bad ? d < 0 : d > 0;
  return (
    <span className={cx('block text-[10px] font-semibold', good ? 'text-[#0E8A7D]' : 'text-[#D92D3A]')} title={`Earlier: ${title}`}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d)}%
    </span>
  );
};

const th = 'px-2.5 py-2 text-right font-semibold text-[#5E778C] text-[11px] whitespace-nowrap align-bottom border-b border-[#D3E3F0]';
const td = 'px-2.5 py-2 text-right whitespace-nowrap tabular-nums border-b border-[#EEF4F9]';
const first = '!text-left';
const zero = 'text-[#C5D3DF]';
const foot = 'px-2.5 py-2 text-right whitespace-nowrap tabular-nums font-bold border-t-2 border-[#D3E3F0]';

/* --------------------------------- view ---------------------------------- */

export const MisView: React.FC<MisViewProps> = ({ leads, sources, sync, canSeeCalls, onRefresh, onShowLeads, canSeeSpend, canEditSpend }) => {
  const jcOn = !!(useTenantSettings() as { justconnectConfigured?: boolean } | null)?.justconnectConfigured;
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [callsState, setCallsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [saved] = useState(loadFilters);
  const [period, setPeriod] = useState<PeriodId>(saved.period);
  const [custom, setCustom] = useState<Range>(saved.custom);
  const [teamPeriod, setTeamPeriod] = useState<PeriodId>(saved.teamPeriod);
  const [rm, setRm] = useState(saved.rm);
  const [source, setSource] = useState(saved.source);
  const [country, setCountry] = useState(saved.country);
  const [state, setState] = useState(saved.state);
  const [city, setCity] = useState(saved.city);

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ period, custom, teamPeriod, rm, source, country, state, city }));
    } catch {
      /* storage blocked (private window) — the filters just aren't remembered */
    }
  }, [period, custom, teamPeriod, rm, source, country, state, city]);
  const [geoOpen, setGeoOpen] = useState<Set<string>>(() => new Set(['India']));
  const [weekInfo, setWeekInfo] = useState('');
  // Re-evaluate "today" every minute so periods roll over at midnight without a reload.
  const [today, setToday] = useState(() => dateKey(new Date()));

  useEffect(() => {
    const t = setInterval(() => setToday(dateKey(new Date())), 60_000);
    return () => clearInterval(t);
  }, []);

  const loadCalls = useCallback(async (silent: boolean) => {
    if (!silent) setCallsState('loading');
    try {
      const list = await api.calls.list();
      setCalls(Array.isArray(list) ? list.filter((c) => c && c.id) : []);
      setCallsState('ready');
    } catch (e) {
      reportError('mis.calls', e);
      if (!silent) setCallsState('error');
    }
  }, []);

  useEffect(() => {
    if (!canSeeCalls) return;
    loadCalls(false);
    const t = setInterval(() => loadCalls(true), CALL_POLL_MS);
    return () => clearInterval(t);
  }, [canSeeCalls, loadCalls]);

  /* ------------------------------- data ---------------------------------- */

  const all = useMemo(() => toMisLeads(leads, firstCallByLead(calls)), [leads, calls]);
  const hasGeo = useMemo(() => all.some((l) => l.country || l.state || l.city), [all]);

  const nonDate = useMemo(
    () => all.filter((l) => (!rm || (rm === UNASSIGNED ? !l.rm : l.rm === rm)) && (!source || (source === BLANK ? !l.source : l.source === source)) &&
      (!country || l.country === country) && (!state || l.state === state) && (!city || l.city === city)),
    [all, rm, source, country, state, city],
  );
  const range = useMemo(() => periodRange(period, custom, today), [period, custom, today]);
  const list = useMemo(() => nonDate.filter((l) => inRange(l.day, range)), [nonDate, range]);
  const order = useMemo(() => sourceOrder(sources, all), [sources, all]);

  const rmOptions = useMemo(() => {
    const r = uniq(all.map((l) => l.rm));
    return all.some((l) => !l.rm) ? r.concat(UNASSIGNED) : r;
  }, [all]);
  const sourceOptions = useMemo(() => (all.some((l) => !l.source) ? order.concat(BLANK) : order), [order, all]);
  const countries = useMemo(() => uniq(all.map((l) => l.country)), [all]);
  const states = useMemo(() => uniq(all.filter((l) => !country || l.country === country).map((l) => l.state)), [all, country]);
  const cities = useMemo(() => uniq(all.filter((l) => (!country || l.country === country) && (!state || l.state === state)).map((l) => l.city)), [all, country, state]);

  // A remembered filter whose value no longer exists would hide every lead — drop it once leads are in.
  useEffect(() => {
    if (!all.length) return;
    if (rm && !rmOptions.includes(rm)) setRm('');
    if (source && !sourceOptions.includes(source)) setSource('');
    if (country && !countries.includes(country)) setCountry('');
    if (state && !states.includes(state)) setState('');
    if (city && !cities.includes(city)) setCity('');
  }, [all.length, rm, rmOptions, source, sourceOptions, country, countries, state, states, city, cities]);

  // the top bar's Refresh also reloads the calls shown here
  useEffect(() => {
    if (!canSeeCalls) return;
    const onRefreshAll = () => loadCalls(true);
    window.addEventListener(REFRESH_EVENT, onRefreshAll);
    return () => window.removeEventListener(REFRESH_EVENT, onRefreshAll);
  }, [canSeeCalls, loadCalls]);

  const rangeText = rangeLabel(period, range);
  const show = (label: string, ls: MisLead[]) => onShowLeads(`${label} · ${PERIOD_NAME[period]}`, ls.map((l) => l.id));
  const hasFilters = !!(rm || source || country || state || city || period !== 'month');
  const clearFilters = () => {
    setRm(''); setSource(''); setCountry(''); setState(''); setCity(''); setCustom(['', '']); setPeriod('month');
  };
  const pickPeriod = (p: PeriodId) => {
    if (p === 'custom' && !custom[0] && !custom[1]) setCustom(periodRange(period, custom, today));
    setPeriod(p);
  };

  if (leads.length === 0 && (sync.status === 'loading' || (!sync.hasLoadedOnce && sync.status === 'syncing'))) {
    return <PageSkeleton variant="dashboard" label="Loading the MIS…" />;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight">Sales MIS dashboard</h2>
          <p className="text-xs text-[#5E778C] mt-0.5">
            Live lead pipeline as on {fmtKey(today)} · updates on its own as leads and calls come in
          </p>
        </div>
      </div>

      {/* Filters */}
      <section aria-label="Filters" className="bg-[#E6EFF6] p-3 rounded-xl border border-[#D3E3F0] grid gap-2.5 items-end" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}>
        <label className="text-[11px] text-[#5E778C] font-semibold">
          Date from
          <input type="date" value={custom[0]} max={custom[1] || undefined} onChange={(e) => { setCustom([e.target.value, custom[1]]); setPeriod('custom'); }}
            className="mt-1 w-full text-xs px-2.5 py-2 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44]" />
        </label>
        <label className="text-[11px] text-[#5E778C] font-semibold">
          Date to
          <input type="date" value={custom[1]} min={custom[0] || undefined} onChange={(e) => { setCustom([custom[0], e.target.value]); setPeriod('custom'); }}
            className="mt-1 w-full text-xs px-2.5 py-2 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44]" />
        </label>
        <label className="text-[11px] text-[#5E778C] font-semibold">Sales representative
          <Select className="mt-1" value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All representatives" aria-label="Sales representative" />
        </label>
        <label className="text-[11px] text-[#5E778C] font-semibold">Lead source
          <Select className="mt-1" value={source} onChange={(e) => setSource(e.target.value)} options={sourceOptions} placeholder="All sources" aria-label="Lead source" />
        </label>
        {hasGeo && (
          <>
            <label className="text-[11px] text-[#5E778C] font-semibold">Country
              <Select className="mt-1" value={country} onChange={(e) => { setCountry(e.target.value); setState(''); setCity(''); }} options={countries} placeholder="All countries" aria-label="Country" />
            </label>
            <label className="text-[11px] text-[#5E778C] font-semibold">State
              <Select className="mt-1" value={state} onChange={(e) => { setState(e.target.value); setCity(''); }} options={states} placeholder="All states" aria-label="State" />
            </label>
            <label className="text-[11px] text-[#5E778C] font-semibold">City
              <Select className="mt-1" value={city} onChange={(e) => setCity(e.target.value)} options={cities} placeholder="All cities" aria-label="City" />
            </label>
          </>
        )}
        <Button variant={hasFilters ? 'secondary' : 'ghost'} onClick={clearFilters} disabled={!hasFilters} className="w-full">Clear filters</Button>
      </section>

      <Glance nonDate={nonDate} period={period} today={today} onPick={pickPeriod} reasons={dqReasons(all)} />

      <Details list={list} total={all.length} period={period} rangeText={rangeText} onPick={pickPeriod} show={show} />

      <Funnel list={list} order={order} period={period} rangeText={rangeText} show={show} />

      <Weeks nonDate={nonDate} end={range[1] || today} order={order} info={weekInfo} setInfo={setWeekInfo} />

      <DqBySource list={list} order={order} period={period} rangeText={rangeText} reasons={dqReasons(all)} show={show} />

      {canSeeSpend && all.some((l) => l.campaign) && <CampaignCost all={all} today={today} canEdit={!!canEditSpend} show={show} />}

      <SourceByStage list={list} order={source ? (source === BLANK ? [] : [source]) : order} show={show} />

      <Panel title="Sales team" hint="First response time runs from when the enquiry came in to the representative's first follow-up or call. Leads without either are left out of the average.">
        <h4 className="text-sm font-bold text-[#0B2A44] mt-1 mb-2">Average first response time</h4>
        <ResponseTable nonDate={nonDate} today={today} />

        <div className="flex flex-wrap items-center justify-between gap-2 mt-6 mb-1">
          <h4 className="text-sm font-bold text-[#0B2A44]">Speed to lead</h4>
          <PeriodButtons value={teamPeriod} options={['today', 'week', 'month', 'all']} onChange={setTeamPeriod} label="Period for speed to lead" />
        </div>
        <p className="text-xs text-[#5E778C] mb-2">How quickly each new lead got its first call or follow-up. Leads called within 5 minutes convert far better. "Not contacted" counts open leads with no call or follow-up yet.</p>
        <SpeedTable nonDate={nonDate} range={periodRange(teamPeriod, custom, today)} show={show} />

        <h4 className="text-sm font-bold text-[#0B2A44] mt-6 mb-1">Call duration</h4>
        <p className="text-xs text-[#5E778C] mb-2">
          Talk time per representative from Call History, with calls made and average call length below it. The last column compares the 1st of this month to yesterday with the same dates last month.
        </p>
        <CallTable calls={calls} state={canSeeCalls ? callsState : 'off'} leads={all} rm={rm} today={today} />

        <div className="flex flex-wrap items-center justify-between gap-2 mt-6 mb-2">
          <h4 className="text-sm font-bold text-[#0B2A44]">Performance by representative</h4>
          <PeriodButtons value={teamPeriod} options={['today', 'week', 'month', 'all']} onChange={setTeamPeriod} label="Period for sales team" />
        </div>
        <TeamTable nonDate={nonDate} range={periodRange(teamPeriod, custom, today)} onRep={(r) => setRm(r)} />
      </Panel>

      {jcOn && <JcCallReport today={today} />}

      <Geo list={list} hasGeo={hasGeo} open={geoOpen} setOpen={setGeoOpen} country={country} show={show} />

      <MisNotes />
    </div>
  );
};

/* ------------------------------- Notes ----------------------------------- */

/** Plain-language rules behind every number, written for the sales team (keep in step with misData.ts). */
const NOTES: Array<[string, React.ReactNode[]]> = [
  ['Which leads are counted', [
    <>Leads are counted by the <b>date the enquiry came in</b>, not the date they were last updated.</>,
    <>The filters at the top (representative, source, place) and the period you pick change every section.</>,
    <>Tap any number to see the leads behind it.</>,
  ]],
  ['Stages: every lead is in one stage only', [
    <><b>New</b>: just came in, not worked yet. <b>Open</b>: stage Open or Not Responding.</>,
    <><b>Qualified</b>, <b>HOT</b> (closing within a week), <b>Warm</b> (closing in 15 to 20 days), <b>Booked</b>.</>,
    <><b>Not interested post site visit</b>: lost after the site visit was done. <b>Disqualified</b>: lost or disqualified without a visit; the reason comes from the stage (Budget, Location…).</>,
    <>All the stages added together = <b>New leads</b> for that period.</>,
  ]],
  ['Qualified leads (total)', [
    <>= Qualified + HOT + Warm + Booked + Not interested post site visit + New or Open leads that have a site visit scheduled or done.</>,
    <>That is why this row is bigger than the single "Qualified" row.</>,
  ]],
  ['Site visits planned', [
    <>Leads with site visit status <b>Site Visit - Scheduled</b> that are still open (not booked, not lost).</>,
    <>These leads are already counted in their own stage, so do not add this row to the total.</>,
  ]],
  ['Percentages and arrows', [
    <>A percentage is that number divided by the New leads in the same period. Example: 20 HOT out of 200 new leads = 10%.</>,
    <>Arrows compare with the same stretch of the previous day, week or month. Green is better, red is worse (for Open, Disqualified and Not interested, going up is shown in red).</>,
  ]],
  ['Conversion funnel', [
    <>Steps: Leads → Contacted (has a call or follow-up) → Qualified → Site visit planned → Site visit done → Booked.</>,
    <>A lead counts in every step up to the furthest one it reached, so a booked lead also counts as contacted and qualified.</>,
    <>"% of previous step" = this step ÷ the step above it. The biggest drop is shown in red: that is where leads are being lost.</>,
    <><b>Lost</b> (below the line) is not a step: it counts the leads that dropped out, stage Lost or any Disqualified stage, also after a site visit. Its % is a share of all leads.</>,
  ]],
  ['Reasons for disqualification', [
    <>Counts the Disqualified leads by their reason. Each percentage is a share of that source's (or campaign's) leads.</>,
  ]],
  ['Cost per lead, site visit and booking', [
    <>Cost per lead = ad spend ÷ leads from that campaign in that month.</>,
    <>Cost per site visit = ad spend ÷ site visits done (Completed or Walk-in). Cost per booking = ad spend ÷ bookings.</>,
  ]],
  ['Sales team', [
    <><b>First response time</b> = time from when the enquiry came in to the first call or follow-up. Leads with neither are left out of the average.</>,
    <><b>Speed to lead</b> sorts new leads into: within 5 minutes, 5 to 60 minutes, over 1 hour, and not contacted yet.</>,
    <><b>Awaiting first response</b> = leads that have had no call or follow-up yet; red means someone needs to call them.</>,
    <><b>Call duration</b> = talk time from Call History, with the number of calls and the average call length.</>,
  ]],
];

const MisNotes: React.FC = () => (
  <Panel title="How these numbers are worked out" hint="A short guide for the team. Every section above follows these rules.">
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 mt-2">
      {NOTES.map(([title, items]) => (
        <div key={title} className="min-w-0">
          <h4 className="text-sm font-bold text-[#0B2A44] mb-1">{title}</h4>
          <ul className="list-disc pl-4 space-y-1 text-[12.5px] leading-relaxed text-[#2B4A63]">
            {items.map((it, i) => <li key={i}>{it}</li>)}
          </ul>
        </div>
      ))}
    </div>
  </Panel>
);

/* ------------------------------ At a glance ------------------------------ */

const Glance: React.FC<{ nonDate: MisLead[]; period: PeriodId; today: string; onPick: (p: PeriodId) => void; reasons: string[] }> = ({ nonDate, period, today, onPick, reasons }) => {
  const ps: PeriodId[] = ['today', 'week', 'month', 'all'];
  const summary = (ls: MisLead[]) => ({ total: ls.length, c: stageCounts(ls), sv: ls.filter((l) => l.svPlanned).length, q: ls.filter(misQualified).length });
  const sets = ps.map((p) => {
    const r = periodRange(p, undefined, today);
    const ls = nonDate.filter((l) => inRange(l.day, r));
    const dq = ls.filter((l) => l.stage === 'disqualified');
    const prev = previousRange(p, today);
    return { p, r, ls, dq, now: summary(ls), prev: prev && { label: prev.label, ...summary(nonDate.filter((l) => inRange(l.day, prev.range))) } };
  });
  const sub = (p: PeriodId, [a, b]: Range) => (p === 'all' ? 'All dates' : p === 'today' ? fmtKey(a) : p === 'month' ? monthNameOf(a) : `${fmtKeyShort(a)} to ${fmtKeyShort(b)}`);
  const on = (p: PeriodId) => (p === period ? 'bg-[#F2F7FB]' : '');
  type Sum = ReturnType<typeof summary>;
  // `bad`: a rise is unwelcome, so it is shown in red.
  const rows: Array<[string, string, (s: Sum) => number, boolean?]> = [
    ['Qualified leads (total)', '#0B2A44', (s) => s.q],
    ['Qualified', MIS_STAGE.qualified.color, (s) => s.c.qualified],
    ['Site visits planned', SV_PLANNED_COLOR, (s) => s.sv],
    ['HOT', MIS_STAGE.hot.color, (s) => s.c.hot],
    ['Warm', MIS_STAGE.warm.color, (s) => s.c.warm],
    ['Booked', MIS_STAGE.booked.color, (s) => s.c.booked],
    ['New', MIS_STAGE.new.color, (s) => s.c.new],
    ['Open / not responding', MIS_STAGE.open.color, (s) => s.c.open, true],
    ['Not interested post site visit', MIS_STAGE.ni.color, (s) => s.c.ni, true],
    ['Disqualified', MIS_STAGE.disqualified.color, (s) => s.c.disqualified, true],
  ];
  const trend = (s: (typeof sets)[number], fn: (x: Sum) => number, bad?: boolean) =>
    s.prev ? <Trend now={fn(s.now)} before={fn(s.prev)} bad={bad} title={`${fn(s.prev)} ${s.prev.label.replace(/^vs /, '')}`} /> : null;
  return (
    <Panel title="At a glance" hint="Leads counted by enquiry date. The week runs Monday to today. Percentages are a share of new leads in that period; arrows compare with the same stretch of the previous day, week or month. Select a period heading to see its details below.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className={th} />
              {sets.map((s) => (
                <th key={s.p} className={cx(th, 'min-w-[120px] rounded-t-lg', on(s.p))}>
                  <button type="button" onClick={() => onPick(s.p)} className="text-[#0B2A44] text-sm font-bold hover:underline">{PERIOD_NAME[s.p]}</button>
                  <small className="block text-[10px] font-normal text-[#7E93A6]">{sub(s.p, s.r)}</small>
                  {s.prev && <small className="block text-[10px] font-normal text-[#A9BDCD]">{s.prev.label}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={cx(td, first, 'font-bold text-[#0B2A44]')}>New leads</td>
              {sets.map((s) => <td key={s.p} className={cx(td, on(s.p), 'text-lg font-bold text-[#0B2A44]')}>{s.ls.length}{trend(s, (x) => x.total)}</td>)}
            </tr>
            {rows.map(([label, color, fn, bad]) => (
              <tr key={label} className="hover:bg-[#F7FAFD]">
                <td className={cx(td, first, 'text-[#0F2233]')}><Dot color={color} />{label}</td>
                {sets.map((s) => <td key={s.p} className={cx(td, on(s.p))}>{fn(s.now)}<Pc n={fn(s.now)} of={s.ls.length} />{trend(s, fn, bad)}</td>)}
              </tr>
            ))}
            <tr><td colSpan={5} className="px-2.5 pt-4 pb-1.5 text-[11px] font-semibold text-[#5E778C] border-b border-[#D3E3F0]">Disqualified by reason</td></tr>
            {reasons.map((r) => (
              <tr key={r} className="hover:bg-[#F7FAFD]">
                <td className={cx(td, first, 'pl-7 text-[#5E778C]')}>{r}</td>
                {sets.map((s) => { const n = s.dq.filter((l) => l.reason === r).length; return <td key={s.p} className={cx(td, on(s.p), !n && zero)}>{n}<Pc n={n} of={s.dq.length} /></td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};

/* ------------------------------- Details --------------------------------- */

const Details: React.FC<{ list: MisLead[]; total: number; period: PeriodId; rangeText: string; onPick: (p: PeriodId) => void; show: (label: string, ls: MisLead[]) => void }> = ({ list, total, period, rangeText, onPick, show }) => {
  const c = stageCounts(list);
  const n = list.length;
  const kpis: Array<[string, string, MisLead[], string]> = [
    ['Site visits planned', SV_PLANNED_COLOR, list.filter((l) => l.svPlanned), 'Prospects with a site visit scheduled'],
    ['HOT', MIS_STAGE.hot.color, list.filter((l) => l.stage === 'hot'), 'Expected closure within a week'],
    ['Warm', MIS_STAGE.warm.color, list.filter((l) => l.stage === 'warm'), 'Expected closure in 15 to 20 days'],
    ['Booked', MIS_STAGE.booked.color, list.filter((l) => l.stage === 'booked'), 'Units booked'],
  ];
  return (
    <section className="bg-white rounded-2xl border border-[#D3E3F0] shadow-xs p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h3 className="text-base font-bold text-[#0B2A44] tracking-tight">{PERIOD_NAME[period]} in detail</h3>
          <p className="text-xs text-[#5E778C] mt-0.5">{rangeText}</p>
        </div>
        <div className="text-sm text-[#5E778C]">
          <b className="text-3xl font-bold text-[#0B2A44] tabular-nums mr-1.5">{n}</b>
          {n === 1 ? 'lead' : 'leads'}{n !== total ? ` match the filters, of ${total}` : ' in all'}
        </div>
      </div>
      <PeriodButtons value={period} options={['today', 'week', 'month', 'all', 'custom']} onChange={onPick} label="Period for details" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 my-4">
        {kpis.map(([label, color, ls, desc]) => (
          <button key={label} type="button" onClick={() => show(label, ls)} className="group text-left rounded-xl bg-[#F2F7FB] px-4 py-3 border-l-[6px]" style={{ borderLeftColor: color }}>
            <span className="block text-sm font-semibold text-[#0B2A44] group-hover:underline">{label}</span>
            <span className="block text-3xl font-bold text-[#0B2A44] tabular-nums leading-tight my-0.5">{ls.length}</span>
            <span className="block text-[11px] text-[#5E778C]">{desc}</span>
          </button>
        ))}
      </div>

      <div className="flex h-[18px] rounded-full overflow-hidden bg-[#F2F7FB] gap-0.5 mb-5" role="img" aria-label="Share of leads by stage">
        {n > 0 && MIS_STAGES.filter((s) => c[s.id]).map((s) => (
          <span key={s.id} className="min-w-[3px] transition-[flex-grow] duration-500" style={{ flex: `${c[s.id]} 1 0`, background: s.color }} title={`${s.name}: ${c[s.id]}`} />
        ))}
      </div>

      <div className="grid gap-x-4 gap-y-5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
        {MIS_STAGES.map((s) => {
          const inStage = list.filter((l) => l.stage === s.id);
          let crit: React.ReactNode;
          if (s.id === 'open') {
            crit = <CritRow label="Not Responding" n={inStage.filter((l) => stageOf(l.lead) === STAGES.NOT_RESPONDING).length} />;
          } else if (s.id === 'new') {
            crit = <CritRow label="Not responded yet" n={inStage.filter((l) => !l.responded).length} />;
          } else {
            crit = <li className="italic text-[#7E93A6] py-1 border-t border-dashed border-[#D3E3F0]">{s.note}</li>;
          }
          return (
            <button key={s.id} type="button" onClick={() => show(s.name, inStage)} title="Open these leads" className="group text-left pt-2.5 border-t-4" style={{ borderTopColor: s.color }}>
              <span className="block text-[13px] font-semibold text-[#0B2A44] group-hover:underline">{s.name}</span>
              <span className="block text-3xl font-bold text-[#0B2A44] tabular-nums leading-tight">{c[s.id]}</span>
              <span className="block text-[11px] text-[#5E778C] mb-2">{pct(c[s.id], n)} of leads</span>
              <ul className="text-[11px] text-[#5E778C]">{crit}</ul>
            </button>
          );
        })}
      </div>
    </section>
  );
};

const CritRow: React.FC<{ label: string; n: number }> = ({ label, n }) => (
  <li className="flex justify-between gap-2 py-1 border-t border-dashed border-[#D3E3F0]">
    <span>{label}</span>
    <b className="text-[#0B2A44] tabular-nums font-semibold">{n}</b>
  </li>
);

/* -------------------------------- Funnel --------------------------------- */

const FUNNEL_COLOURS = ['#74889A', '#5B8DB8', '#0E8A7D', '#3B5BDB', '#7B4BC4', '#1F7A4D'];

/** How the funnel table splits leads: by source, or by the Meta campaign / ad set / ad behind them. */
type FunnelBy = 'source' | 'campaign' | 'adSet' | 'ad';
const FUNNEL_BY: Array<{ id: FunnelBy; label: string; column: string }> = [
  { id: 'source', label: 'By lead source', column: 'Lead source' },
  { id: 'campaign', label: 'By campaign', column: 'Campaign' },
  { id: 'adSet', label: 'By ad set', column: 'Ad set' },
  { id: 'ad', label: 'By ad', column: 'Ad' },
];

const Funnel: React.FC<{ list: MisLead[]; order: string[]; period: PeriodId; rangeText: string; show: (label: string, ls: MisLead[]) => void }> = ({ list, order, period, rangeText, show }) => {
  const [by, setBy] = useState<FunnelBy>('source');
  const steps = funnelCounts(list);
  const atStep = (ls: MisLead[], i: number) => ls.filter((l) => funnelStep(l) >= i);
  let rows: Array<[string, MisLead[]]>;
  if (by === 'source') {
    rows = order.map((s) => [s, list.filter((l) => l.source === s)] as [string, MisLead[]]).filter(([, ls]) => ls.length);
  } else {
    // campaigns / ad sets / ads present in the selection, most leads first
    const groups = new Map<string, MisLead[]>();
    for (const l of list) if (l[by]) (groups.get(l[by]) || groups.set(l[by], []).get(l[by])!).push(l);
    rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }
  const blank = list.filter((l) => !l[by]);
  if (blank.length) rows.push([BLANK, blank]);
  const byMeta = FUNNEL_BY.find((x) => x.id === by)!;
  // Weakest step = the biggest drop between two steps, called out so the team knows where to look.
  let weakest = -1, worst = 101;
  for (let i = 1; i < steps.length; i++) {
    if (!steps[i - 1]) break;
    const conv = (steps[i] * 100) / steps[i - 1];
    if (conv < worst) { worst = conv; weakest = i; }
  }
  return (
    <Panel
      title="Conversion funnel"
      hint={`${PERIOD_NAME[period]}, ${rangeText}. Each step counts leads that reached it or went further, so a booked lead also counts as contacted. Select a step or number to open those leads.`}
    >
      {!list.length ? <p className="text-center text-sm text-[#7E93A6] py-6">No leads in this selection.</p> : (
        <>
          <div className="space-y-2 mb-2">
            {FUNNEL_STEPS.map((name, i) => {
              const n = steps[i], prev = i ? steps[i - 1] : n;
              return (
                <button key={name} type="button" onClick={() => show(`Funnel: ${name}`, atStep(list, i))} className="group w-full grid grid-cols-[120px_1fr_auto] sm:grid-cols-[150px_1fr_150px] items-center gap-3 text-left">
                  <span className="text-xs font-semibold text-[#0B2A44] group-hover:underline truncate">{name}</span>
                  <span className="h-7 rounded-lg bg-[#F2F7FB] overflow-hidden">
                    <span className="h-full rounded-lg flex items-center px-2 text-[11px] font-bold text-white transition-[width] duration-500" style={{ width: `${Math.max((n * 100) / steps[0], n ? 4 : 0)}%`, background: FUNNEL_COLOURS[i] }}>
                      {(n * 100) / steps[0] >= 12 ? n : ''}
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-right whitespace-nowrap">
                    <b className="text-[#0B2A44]">{n}</b>
                    <span className="text-[#7E93A6]"> · {pct(n, steps[0])}</span>
                    {i > 0 && <span className={cx('block text-[10px]', i === weakest ? 'text-[#D92D3A] font-bold' : 'text-[#7E93A6]')}>{pct(n, prev)} of previous step</span>}
                  </span>
                </button>
              );
            })}
            {(() => {
              // Not a funnel step: the leads that dropped out (closed without a booking), out of all the leads above.
              const lost = list.filter((l) => l.stage === 'disqualified' || l.stage === 'ni');
              const n = lost.length;
              return (
                <button type="button" onClick={() => show('Funnel: Lost', lost)} title="Closed without a booking: stage Lost or any Disqualified stage, also after a site visit" className="group w-full grid grid-cols-[120px_1fr_auto] sm:grid-cols-[150px_1fr_150px] items-center gap-3 text-left pt-2 border-t border-dashed border-[#D3E3F0]">
                  <span className="text-xs font-semibold text-[#A33A44] group-hover:underline truncate">Lost</span>
                  <span className="h-7 rounded-lg bg-[#F9EEEF] overflow-hidden">
                    <span className="h-full rounded-lg flex items-center px-2 text-[11px] font-bold text-white transition-[width] duration-500" style={{ width: `${Math.max((n * 100) / steps[0], n ? 4 : 0)}%`, background: '#A33A44' }}>
                      {(n * 100) / steps[0] >= 12 ? n : ''}
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-right whitespace-nowrap">
                    <b className="text-[#A33A44]">{n}</b>
                    <span className="text-[#7E93A6]"> · {pct(n, steps[0])}</span>
                    <span className="block text-[10px] text-[#7E93A6]">of all leads, closed without booking</span>
                  </span>
                </button>
              );
            })()}
          </div>
          {weakest > 0 && (
            <p className="text-xs text-[#5E778C] mb-4">
              Biggest drop: <b className="text-[#D92D3A]">{FUNNEL_STEPS[weakest - 1]} → {FUNNEL_STEPS[weakest]}</b>, only {Math.round(worst)}% move on.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 mt-2 mb-2">
            <h4 className="text-sm font-bold text-[#0B2A44]">{byMeta.label}</h4>
            <div role="group" aria-label="Split the funnel" className="inline-flex flex-wrap rounded-lg border border-[#D3E3F0] bg-[#F7FAFD] p-0.5">
              {FUNNEL_BY.map((o) => (
                <button key={o.id} type="button" aria-pressed={by === o.id} onClick={() => setBy(o.id)}
                  className={cx('min-h-[32px] px-3 rounded-md text-xs font-semibold', by === o.id ? 'bg-white text-[#0B6BB0] shadow-xs' : 'text-[#5E778C] hover:text-[#0B2A44]')}>
                  {o.label.replace('By ', '')}
                </button>
              ))}
            </div>
          </div>
          {by !== 'source' && !rows.some(([k]) => k !== BLANK) && (
            <p className="text-xs text-[#7E93A6] mb-2">No {byMeta.column.toLowerCase()} recorded for these leads yet — it is filled in for new Facebook / Instagram leads.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className={cx(th, first)}>{byMeta.column}</th>
                  {FUNNEL_STEPS.map((s, i) => <th key={s} className={th}><Dot color={FUNNEL_COLOURS[i]} square />{s}</th>)}
                  <th className={cx(th, 'border-l-2 border-[#D3E3F0]')}>Lead to booking</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([src, ls]) => {
                  const c = funnelCounts(ls);
                  return (
                    <tr key={src} className="hover:bg-[#F7FAFD]">
                      <td className={cx(td, first)}>{src === BLANK ? <span className="text-[#7E93A6]">{BLANK}</span> : by === 'source' ? <SourceLogo source={src} /> : <span className="font-medium text-[#0B2A44] break-words">{src}</span>}</td>
                      {c.map((n, i) => <td key={i} className={cx(td, i === 0 && 'font-semibold')}><NumBtn n={n} of={i ? c[0] : undefined} onClick={() => show(`${src} · ${FUNNEL_STEPS[i]}`, atStep(ls, i))} /></td>)}
                      <td className={cx(td, 'border-l-2 border-[#D3E3F0] font-bold', c[5] ? 'text-[#1F7A4D]' : zero)}>{pct(c[5], c[0])}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className={cx(foot, first)}>{by === 'source' ? 'All sources' : 'All leads'}</td>
                  {steps.map((n, i) => <td key={i} className={foot}>{n}{i > 0 && <Pc n={n} of={steps[0]} />}</td>)}
                  <td className={cx(foot, 'border-l-2 border-[#D3E3F0] text-[#1F7A4D]')}>{pct(steps[5], steps[0])}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
};

/* --------------------------- Weekly by source ---------------------------- */

const Weeks: React.FC<{ nonDate: MisLead[]; end: string; order: string[]; info: string; setInfo: (s: string) => void }> = ({ nonDate, end, order, info, setInfo }) => {
  const keys: string[] = [];
  for (let k = weekStartKey(end), i = 0; i < 12; i++, k = addDaysKey(k, -7)) keys.unshift(k);
  const all = order.concat(BLANK);
  const wk = Object.fromEntries(keys.map((k) => [k, {} as Record<string, number>]));
  for (const l of nonDate) {
    const w = wk[l.week];
    if (w) { const s = l.source || BLANK; w[s] = (w[s] || 0) + 1; }
  }
  const tot = (k: string) => Object.values(wk[k]).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...keys.map(tot));
  const used = all.filter((s) => keys.some((k) => wk[k][s]));
  const describe = (k: string) => {
    const t = tot(k);
    return `Week of ${fmtKey(k)}: ${t} leads${t ? ` (${all.filter((s) => wk[k][s]).map((s) => `${s} ${wk[k][s]}`).join(', ')})` : ''}`;
  };
  return (
    <Panel title="New leads per week by source" hint="12 weeks up to the end of the selected period, week starting Monday. Hover or tap a bar for the source split.">
      <div className="flex items-end gap-1.5 h-[170px] pt-2">
        {keys.map((k, i) => {
          const t = tot(k);
          return (
            <div key={k} tabIndex={0} title={describe(k)} onMouseEnter={() => setInfo(describe(k))} onFocus={() => setInfo(describe(k))} onClick={() => setInfo(describe(k))}
              className="flex-1 min-w-0 h-full flex flex-col items-center justify-end text-[10px] text-[#7E93A6] cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0B6BB0] rounded">
              <span className="text-[#0B2A44] font-semibold tabular-nums">{t || ''}</span>
              <span className="w-full max-w-[40px] flex flex-col-reverse rounded-t overflow-hidden bg-[#D3E3F0]" style={{ height: `${(t * 78) / max}%`, minHeight: 2 }}>
                {all.filter((s) => wk[k][s]).map((s) => <span key={s} className="block w-full" style={{ height: `${(wk[k][s] * 100) / t}%`, background: sourceColour(s, order) }} />)}
              </span>
              <span className={cx('mt-1 whitespace-nowrap', i % 2 === 1 && 'max-sm:invisible')}>{fmtKeyShort(k)}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3.5 text-xs">
        {used.length ? used.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: sourceColour(s, order) }} />
            {s === BLANK ? <span className="text-[#5E778C]">{BLANK}</span> : <SourceLogo source={s} size={16} />}
            <b className="tabular-nums">{keys.reduce((a, k) => a + (wk[k][s] || 0), 0)}</b>
          </span>
        )) : <span className="text-[#7E93A6]">No leads in these 12 weeks.</span>}
      </div>
      <p className="mt-2 text-xs text-[#5E778C] min-h-[1.3em]">{info}</p>
    </Panel>
  );
};

/* ---------------------- Disqualification by source ----------------------- */

const SourceHead: React.FC<{ s: string; order: string[] }> = ({ s, order }) => (
  <span className="inline-flex items-center justify-end gap-1">
    <i className="w-2 h-2 rounded-sm" style={{ background: sourceColour(s, order) }} />
    {s === BLANK ? BLANK : <SourceLogo source={s} size={16} />}
  </span>
);

const DqBySource: React.FC<{ list: MisLead[]; order: string[]; period: PeriodId; rangeText: string; reasons: string[]; show: (label: string, ls: MisLead[]) => void }> = ({ list, order, period, rangeText, reasons, show }) => {
  const [by, setBy] = useState<'source' | 'campaign'>('source');
  const hasCampaigns = list.some((l) => l.campaign);
  const dim = hasCampaigns ? by : 'source';
  const dq = list.filter((l) => l.stage === 'disqualified');
  const srcOf = (l: MisLead) => (dim === 'campaign' ? l.campaign : l.source) || BLANK;
  let cols: string[];
  if (dim === 'campaign') {
    // campaigns with the most disqualified leads first (at most 8)
    const n = new Map<string, number>();
    for (const l of dq) if (l.campaign) n.set(l.campaign, (n.get(l.campaign) || 0) + 1);
    cols = [...n.keys()].sort((a, b) => (n.get(b) || 0) - (n.get(a) || 0)).slice(0, 8);
  } else {
    cols = order.filter((s, i) => i < 4 || dq.some((l) => l.source === s)).filter((s) => list.some((l) => l.source === s));
  }
  if (dq.some((l) => !(dim === 'campaign' ? l.campaign : l.source))) cols.push(BLANK);
  const rows = reasons.filter((r) => r !== NO_REASON || dq.some((l) => l.reason === r));
  return (
    <Panel
      title={dim === 'campaign' ? 'Why leads are lost, by ad campaign' : 'Reasons for disqualification by source'}
      hint={`${PERIOD_NAME[period]}, ${rangeText}. ${dq.length} of ${list.length} leads disqualified or lost. Each total shows its share of all of them${dim === 'campaign' ? '; the bottom row shows the share of each campaign\'s leads — high numbers point to ads bringing the wrong people' : ''}.`}
      actions={hasCampaigns ? (
        <div className="flex rounded-lg border border-[#D3E3F0] overflow-hidden text-xs font-semibold" role="group" aria-label="Group by">
          {(['source', 'campaign'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setBy(k)} aria-pressed={by === k} className={cx('px-3 py-1.5', by === k ? 'bg-[#0B2A44] text-white' : 'bg-white text-[#3F5A70] hover:bg-[#F2F7FB]')}>{k === 'source' ? 'By source' : 'By campaign'}</button>
          ))}
        </div>
      ) : undefined}
    >
      {!list.length ? <p className="text-center text-sm text-[#7E93A6] py-6">No leads in this selection.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className={cx(th, first)}>Reason</th>
                <th className={th}>Total</th>
                {cols.map((s) => <th key={s} className={th}>{dim === 'campaign' ? <span className="inline-block max-w-[140px] truncate align-bottom" title={s}>{s}</span> : <SourceHead s={s} order={order} />}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rl = dq.filter((l) => l.reason === r);
                return (
                  <tr key={r} className="hover:bg-[#F7FAFD]">
                    <td className={cx(td, first)}>{r}</td>
                    <td className={cx(td, 'font-semibold')}><NumBtn n={rl.length} onClick={() => show(`Disqualified: ${r}`, rl)} /><Pc n={rl.length} of={dq.length} /></td>
                    {cols.map((s) => { const ls = rl.filter((l) => srcOf(l) === s); return <td key={s} className={td}><NumBtn n={ls.length} onClick={() => show(`Disqualified: ${r} · ${s}`, ls)} /></td>; })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className={cx(foot, first)}>Total disqualified</td>
                <td className={foot}>{dq.length}</td>
                {cols.map((s) => {
                  const n = dq.filter((l) => srcOf(l) === s).length, tot = list.filter((l) => srcOf(l) === s).length;
                  return <td key={s} className={foot} title={`${n} of ${tot} leads from this ${dim}`}>{n}<Pc n={n} of={tot} suffix={` of ${dim}`} /></td>;
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
};

const NumBtn: React.FC<{ n: number; onClick: () => void; of?: number }> = ({ n, onClick, of }) =>
  n ? (
    <button type="button" onClick={onClick} className="tabular-nums hover:underline hover:text-[#0B6BB0]">{n}{of ? <Pc n={n} of={of} /> : null}</button>
  ) : <span className={zero}>0</span>;

/* --------------------------- Source by stage ----------------------------- */

const SourceByStage: React.FC<{ list: MisLead[]; order: string[]; show: (label: string, ls: MisLead[]) => void }> = ({ list, order, show }) => {
  const rows: Array<[string, MisLead[]]> = order.map((s) => [s, list.filter((l) => l.source === s)] as [string, MisLead[]]).filter(([, ls]) => ls.length);
  const blank = list.filter((l) => !l.source);
  if (blank.length) rows.push([BLANK, blank]);
  const beyond = (ls: MisLead[]) => ls.filter(misQualified).length;
  const c = stageCounts(list);
  return (
    <Panel title="Lead source by stage" hint="Selected period. Each number shows its share of that source's leads. Select a number to open those leads.">
      {!list.length ? <p className="text-center text-sm text-[#7E93A6] py-6">No leads match these filters.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className={cx(th, first)}>Lead source</th>
                <th className={th}>Total</th>
                {MIS_STAGES.map((s) => <th key={s.id} className={th} title={s.name}><Dot color={s.color} />{s.short}</th>)}
                <th className={th}>Qualified or beyond</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([src, ls]) => {
                const sc = stageCounts(ls);
                return (
                  <tr key={src} className="hover:bg-[#F7FAFD]">
                    <td className={cx(td, first)}>{src === BLANK ? <span className="text-[#7E93A6]">{BLANK}</span> : <SourceLogo source={src} />}</td>
                    <td className={cx(td, 'font-semibold')}><NumBtn n={ls.length} onClick={() => show(src, ls)} /></td>
                    {MIS_STAGES.map((s) => <td key={s.id} className={td}><NumBtn n={sc[s.id]} of={ls.length} onClick={() => show(`${src} · ${s.name}`, ls.filter((l) => l.stage === s.id))} /></td>)}
                    <td className={td}>{pct(beyond(ls), ls.length)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className={cx(foot, first)}>All sources</td>
                <td className={foot}>{list.length}</td>
                {MIS_STAGES.map((s) => <td key={s.id} className={foot}>{c[s.id]}<Pc n={c[s.id]} of={list.length} /></td>)}
                <td className={foot}>{pct(beyond(list), list.length)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
};

/* ------------------------------ Sales team ------------------------------- */

function repsOf(list: MisLead[]): string[] {
  const r = uniq(list.map((l) => l.rm));
  return list.some((l) => !l.rm) ? r.concat(UNASSIGNED) : r;
}
const repLeads = (list: MisLead[], r: string) => list.filter((l) => (r === UNASSIGNED ? !l.rm : l.rm === r));

const SpeedTable: React.FC<{ nonDate: MisLead[]; range: Range; show: (label: string, ls: MisLead[]) => void }> = ({ nonDate, range, show }) => {
  const inP = nonDate.filter((l) => inRange(l.day, range));
  const reps = repsOf(inP);
  if (!reps.length) return <p className="text-center text-sm text-[#7E93A6] py-6">No leads with a sales representative in this period.</p>;
  const row = (label: string, ls: MisLead[], foot2 = false) => {
    const b = speedBuckets(ls);
    const cls = foot2 ? foot : td;
    const notYet = ls.filter((l) => !l.responded && l.stage !== 'disqualified' && l.stage !== 'booked');
    return (
      <tr key={label} className={foot2 ? '' : 'hover:bg-[#F7FAFD]'}>
        <td className={cx(cls, first)}>{label}</td>
        <td className={cls}>{b.total}</td>
        <td className={cx(cls, b.m5 ? 'text-[#0E8A7D] font-bold' : zero)}>{b.m5}<Pc n={b.m5} of={b.total} /></td>
        <td className={cx(cls, !b.h1 && zero)}>{b.h1}<Pc n={b.h1} of={b.total} /></td>
        <td className={cx(cls, !b.later && zero)}>{b.later}<Pc n={b.later} of={b.total} /></td>
        <td className={cx(cls, b.none ? 'text-[#D92D3A] font-bold' : zero)}>{b.none ? <NumBtn n={b.none} onClick={() => show(`Not contacted yet · ${label}`, notYet)} /> : 0}</td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead><tr><th className={cx(th, first)}>Sales representative</th><th className={th}>Leads</th><th className={th}>Within 5 min</th><th className={th}>5–60 min</th><th className={th}>Over 1 hour</th><th className={th}>Not contacted</th></tr></thead>
        <tbody>{reps.map((r) => row(r, repLeads(inP, r)))}</tbody>
        <tfoot>{row('Whole team', inP, true)}</tfoot>
      </table>
    </div>
  );
};

/* ------------------------------ campaign cost ----------------------------- */

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

const CampaignCost: React.FC<{ all: MisLead[]; today: string; canEdit: boolean; show: (label: string, ls: MisLead[]) => void }> = ({ all, today, canEdit, show }) => {
  const months = useMemo(() => uniq(all.filter((l) => l.campaign && l.day).map((l) => l.day.slice(0, 7))).sort().reverse(), [all]);
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [spend, setSpend] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Array<{ campaign: string; month: string; amount: number }>>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'saving'>('loading');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    api.team.spend().then((r) => { if (live) { setSaved(r.rows); setState('ready'); } }, () => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setSpend(Object.fromEntries(saved.filter((r) => r.month === month).map((r) => [r.campaign, String(r.amount)])));
    setMsg('');
  }, [saved, month]);

  const inMonth = all.filter((l) => l.campaign && l.day.startsWith(month));
  const camps = uniq([...inMonth.map((l) => l.campaign), ...Object.keys(spend).filter((c) => Number(spend[c]) > 0)]).sort((a, b) => a.localeCompare(b));
  const visited = (l: MisLead) => SITE_VISIT_DONE.includes(l.sv);
  const cost = (amt: number, n: number) => (amt > 0 && n > 0 ? inr(amt / n) : '—');
  const dirty = camps.some((c) => (Number(spend[c]) || 0) !== (saved.find((r) => r.month === month && r.campaign === c)?.amount || 0));

  const save = async () => {
    setState('saving');
    try {
      const r = await api.team.saveSpend(month, camps.map((c) => ({ campaign: c, amount: Number(spend[c]) || 0 })));
      setSaved(r.rows);
      setMsg('Spend saved.');
    } catch (e) {
      setMsg(reportError('mis.saveSpend', e).userMessage);
    }
    setState('ready');
  };

  let tSpend = 0, tLeads = 0, tVisits = 0, tBooked = 0;
  const monthOpts = uniq([today.slice(0, 7), ...months]).sort().reverse();
  return (
    <Panel
      title="Cost per lead, site visit and booking"
      hint={`Leads by enquiry month and ad campaign (Facebook / Instagram). Enter what each campaign cost that month — from Meta Ads Manager — to see what a lead, a site visit and a booking really cost.${canEdit ? '' : ' Only administrators can enter spend.'}`}
      actions={
        <select className="text-xs px-2.5 py-1.5 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44]" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {monthOpts.map((m) => <option key={m} value={m}>{monthNameOf(m + '-01')} {m.slice(0, 4)}</option>)}
        </select>
      }
    >
      {state === 'loading' ? <p className="text-center text-sm text-[#7E93A6] py-6">Loading…</p> : !camps.length ? (
        <p className="text-center text-sm text-[#7E93A6] py-6">No leads from ad campaigns in this month.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead><tr><th className={cx(th, first)}>Campaign</th><th className={th}>Ad spend</th><th className={th}>Leads</th><th className={th}>Cost per lead</th><th className={th}>Site visits</th><th className={th}>Cost per visit</th><th className={th}>Bookings</th><th className={th}>Cost per booking</th></tr></thead>
            <tbody>
              {camps.map((c) => {
                const ls = inMonth.filter((l) => l.campaign === c);
                const vs = ls.filter(visited), bs = ls.filter((l) => l.stage === 'booked');
                const amt = Number(spend[c]) || 0;
                tSpend += amt; tLeads += ls.length; tVisits += vs.length; tBooked += bs.length;
                return (
                  <tr key={c} className="hover:bg-[#F7FAFD]">
                    <td className={cx(td, first, 'max-w-[260px] truncate')} title={c}>{c}</td>
                    <td className={td}>
                      {canEdit ? (
                        <input type="number" min={0} step={100} inputMode="decimal" value={spend[c] ?? ''} placeholder="0" onChange={(e) => setSpend((x) => ({ ...x, [c]: e.target.value }))}
                          className="w-28 text-right text-xs px-2 py-1.5 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44]" aria-label={`Ad spend for ${c}`} />
                      ) : amt ? inr(amt) : '—'}
                    </td>
                    <td className={td}><NumBtn n={ls.length} onClick={() => show(`Campaign: ${c}`, ls)} /></td>
                    <td className={cx(td, 'font-semibold')}>{cost(amt, ls.length)}</td>
                    <td className={td}><NumBtn n={vs.length} onClick={() => show(`Site visits · ${c}`, vs)} /></td>
                    <td className={td}>{cost(amt, vs.length)}</td>
                    <td className={td}><NumBtn n={bs.length} onClick={() => show(`Bookings · ${c}`, bs)} /></td>
                    <td className={cx(td, 'font-semibold')}>{cost(amt, bs.length)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className={cx(foot, first)}>All campaigns</td>
                <td className={foot}>{tSpend ? inr(tSpend) : '—'}</td>
                <td className={foot}>{tLeads}</td>
                <td className={foot}>{cost(tSpend, tLeads)}</td>
                <td className={foot}>{tVisits}</td>
                <td className={foot}>{cost(tSpend, tVisits)}</td>
                <td className={foot}>{tBooked}</td>
                <td className={foot}>{cost(tSpend, tBooked)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {canEdit && camps.length > 0 && (
        <div className="flex items-center justify-end gap-3 mt-3">
          {msg && <span className="text-xs text-[#5E778C]">{msg}</span>}
          {state === 'error' && <span className="text-xs text-[#B54708]">Saved spend could not be loaded.</span>}
          <Button variant="primary" onClick={() => void save()} loading={state === 'saving'} disabled={!dirty || state === 'saving'}>Save spend</Button>
        </div>
      )}
    </Panel>
  );
};

const ResponseTable: React.FC<{ nonDate: MisLead[]; today: string }> = ({ nonDate, today }) => {
  const ps: PeriodId[] = ['yesterday', 'week', 'month', 'all'];
  const reps = repsOf(nonDate);
  if (!reps.length) return <p className="text-center text-sm text-[#7E93A6] py-6">No leads with a sales representative yet.</p>;
  const sets = Object.fromEntries(ps.map((p) => { const r = periodRange(p, undefined, today); return [p, nonDate.filter((l) => inRange(l.day, r))]; })) as Record<string, MisLead[]>;
  const cell = (ls: MisLead[], p: string) => {
    const a = avgResp(ls);
    return a
      ? <td key={p} className={cx(td, speedTone(a.avg))}>{fmtDur(a.avg)}<small className="block text-[10px] font-normal text-[#7E93A6]">{a.n} responded</small></td>
      : <td key={p} className={cx(td, zero)}>{ls.length ? 'No times' : 'No leads'}</td>;
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead><tr><th className={cx(th, first)}>Sales representative</th>{ps.map((p) => <th key={p} className={th}>{PERIOD_NAME[p]}</th>)}</tr></thead>
        <tbody>{reps.map((r) => <tr key={r} className="hover:bg-[#F7FAFD]"><td className={cx(td, first)}>{r}</td>{ps.map((p) => cell(repLeads(sets[p], r), p))}</tr>)}</tbody>
        <tfoot><tr><td className={cx(foot, first)}>Whole team</td>{ps.map((p) => cell(sets[p], p))}</tr></tfoot>
      </table>
    </div>
  );
};

const CallTable: React.FC<{ calls: CallRecord[]; state: 'idle' | 'loading' | 'ready' | 'error' | 'off'; leads: MisLead[]; rm: string; today: string }> = ({ calls, state, leads, rm, today }) => {
  const rows = useMemo(() => {
    const leadRm = new Map(leads.map((l) => [l.id, l.rm]));
    return callDays(calls, leadRm).filter((c) => !rm || c.rep === rm);
  }, [calls, leads, rm]);
  if (state === 'off') return <p className="text-center text-sm text-[#7E93A6] py-6">Call History isn't part of your plan or role, so talk time can't be shown.</p>;
  if (state === 'loading' || state === 'idle') return <p className="text-center text-sm text-[#7E93A6] py-6">Loading calls…</p>;
  if (state === 'error') return <p className="text-center text-sm text-[#B06A55] py-6">Calls could not be loaded. Press Refresh to try again.</p>;
  if (!rows.length) return <p className="text-center text-sm text-[#7E93A6] py-6">No calls logged yet. Calls from Call History appear here automatically.</p>;
  const ps: PeriodId[] = ['yesterday', 'lastweek', 'month', 'lastmonth'];
  const reps = uniq(rows.map((c) => c.rep));
  const stats = (rs: CallDay[]) => ({ calls: rs.reduce((a, r) => a + r.calls, 0), secs: rs.reduce((a, r) => a + r.secs, 0) });
  const inR = (rs: CallDay[], p: PeriodId) => { const r = periodRange(p, undefined, today); return rs.filter((c) => inRange(c.day, r)); };
  const sub = (p: PeriodId) => {
    const [a, b] = periodRange(p, undefined, today);
    if (p === 'yesterday') return fmtKey(a);
    if (p === 'month') return `${monthNameOf(a)} so far`;
    if (p === 'lastmonth') return monthNameOf(a);
    return `${fmtKeyShort(a)} to ${fmtKeyShort(b)}`;
  };
  const cell = (rs: CallDay[], p: string) => {
    const s = stats(rs);
    return s.calls
      ? <td key={p} className={td}>{fmtTalk(s.secs)}<small className="block text-[10px] text-[#7E93A6]">{s.calls} calls, avg {fmtAvgCall(s.secs / s.calls)}</small></td>
      : <td key={p} className={cx(td, zero)}>None</td>;
  };
  const change = (rs: CallDay[]) => {
    const now = stats(inR(rs, 'monthtoyesterday')).secs, before = stats(inR(rs, 'lastmonthsame')).secs;
    if (!before) return <td className={cx(td, 'border-l-2 border-[#D3E3F0]', zero)}>{now ? 'New' : 'None'}</td>;
    const d = Math.round(((now - before) * 100) / before);
    return (
      <td className={cx(td, 'border-l-2 border-[#D3E3F0] font-bold', d > 0 ? 'text-[#0E8A7D]' : d < 0 ? 'text-[#D92D3A]' : '')}>
        {d > 0 ? '+' : ''}{d}%<small className="block text-[10px] font-normal text-[#7E93A6]">{fmtTalk(before)} same days last month</small>
      </td>
    );
  };
  const line = (label: string, rs: CallDay[], isFoot?: boolean) => (
    <tr key={label} className={isFoot ? 'font-bold' : 'hover:bg-[#F7FAFD]'}>
      <td className={cx(td, first, isFoot && 'border-t-2 border-[#D3E3F0]')}>{label}</td>
      {ps.map((p) => cell(inR(rs, p), p))}
      {change(rs)}
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr>
            <th className={cx(th, first)}>Sales representative</th>
            {ps.map((p) => <th key={p} className={th}>{p === 'month' ? 'Current month' : PERIOD_NAME[p]}<small className="block font-normal text-[10px]">{sub(p)}</small></th>)}
            <th className={cx(th, 'border-l-2 border-[#D3E3F0]')}>Current vs last month<small className="block font-normal text-[10px]">Talk time, 1st to yesterday</small></th>
          </tr>
        </thead>
        <tbody>{reps.map((r) => line(r, rows.filter((c) => c.rep === r)))}</tbody>
        <tfoot>{line('Whole team', rows, true)}</tfoot>
      </table>
    </div>
  );
};

const TeamTable: React.FC<{ nonDate: MisLead[]; range: Range; onRep: (r: string) => void }> = ({ nonDate, range, onRep }) => {
  const list = nonDate.filter((l) => inRange(l.day, range));
  const reps = repsOf(nonDate);
  if (!reps.length) return <p className="text-center text-sm text-[#7E93A6] py-6">No leads with a sales representative yet.</p>;
  const n = (x: number, of: number) => (x ? <>{x}<Pc n={x} of={of} /></> : <span className={zero}>0</span>);
  const row = (label: string, ls: MisLead[], isRep: boolean) => {
    const c = stageCounts(ls), a = avgResp(ls), wait = ls.filter((l) => !l.responded).length;
    const cls = isRep ? td : foot;
    return (
      <tr key={label} className={isRep ? 'hover:bg-[#F7FAFD]' : ''}>
        <td className={cx(cls, first)}>
          {isRep ? <button type="button" onClick={() => onRep(label)} className="font-semibold hover:underline hover:text-[#0B6BB0]" title="Filter the MIS to this representative">{label}</button> : label}
        </td>
        <td className={cls}>{ls.length}</td>
        <td className={cls}>{n(c.qualified, ls.length)}</td>
        <td className={cls}>{n(ls.filter((l) => l.svPlanned).length, ls.length)}</td>
        <td className={cls}>{n(c.hot, ls.length)}</td>
        <td className={cls}>{n(c.warm, ls.length)}</td>
        <td className={cls}>{n(c.booked, ls.length)}</td>
        <td className={cls}>{n(c.disqualified, ls.length)}</td>
        <td className={cls}>{n(c.ni, ls.length)}</td>
        <td className={cx(cls, a && speedTone(a.avg))}>{a ? fmtDur(a.avg) : <span className={zero}>None</span>}</td>
        <td className={cls}>{a ? pct(a.fast, a.n) : <span className={zero}>0%</span>}</td>
        <td className={cx(cls, wait > 0 && 'text-[#D92D3A] font-semibold')}>{wait}</td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr>
            {['Sales representative', 'Leads', 'Qualified, no visit', 'Site visits planned', 'HOT', 'Warm', 'Booked', 'Disqualified', 'Not int. post SV', 'Avg first response', 'Responded within 1 hour', 'Awaiting first response'].map((h, i) => (
              <th key={h} className={cx(th, i === 0 && first)}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{reps.map((r) => row(r, repLeads(list, r), true))}</tbody>
        <tfoot>{row('Whole team', list, false)}</tfoot>
      </table>
    </div>
  );
};

/* --------------------------------- Geo ----------------------------------- */

interface GeoNode { ls: MisLead[]; kids: Map<string, GeoNode> }
const GEO_COLS: MisStageId[] = ['new', 'open', 'qualified', 'warm', 'hot', 'booked', 'disqualified'];
const COUNTRY_ORDER = ['India', 'USA', 'UK', 'UAE'];

const Geo: React.FC<{ list: MisLead[]; hasGeo: boolean; open: Set<string>; setOpen: (s: Set<string>) => void; country: string; show: (label: string, ls: MisLead[]) => void }> = ({ list, hasGeo, open, setOpen, show }) => {
  const tree = useMemo(() => {
    const t = new Map<string, GeoNode>();
    const node = (m: Map<string, GeoNode>, k: string) => { let n = m.get(k); if (!n) { n = { ls: [], kids: new Map() }; m.set(k, n); } return n; };
    for (const l of list) {
      const A = node(t, l.country || BLANK), B = node(A.kids, l.state || BLANK), C = node(B.kids, l.city || BLANK);
      A.ls.push(l); B.ls.push(l); C.ls.push(l);
    }
    return t;
  }, [list]);
  if (!hasGeo) {
    return (
      <Panel title="Country, state and city" hint="Breakdown by where the prospect lives.">
        <p className="text-center text-sm text-[#7E93A6] py-6">No city, state or country is recorded on your leads yet. Fill them in on New Enquiry or a lead's Details tab — website forms, sheets and Meta lead forms that ask for them fill them in automatically — and this table builds itself.</p>
      </Panel>
    );
  }
  const allKeys: string[] = [];
  tree.forEach((A, a) => { allKeys.push(a); A.kids.forEach((_, b) => allKeys.push(`${a}|${b}`)); });
  const allOpen = allKeys.length > 0 && allKeys.every((k) => open.has(k));
  const toggle = (k: string) => { const s = new Set(open); if (s.has(k)) s.delete(k); else s.add(k); setOpen(s); };
  const bySize = (m: Map<string, GeoNode>) => [...m.entries()].sort((a, b) => b[1].ls.length - a[1].ls.length);
  const countries = [...tree.entries()].sort((a, b) => {
    const ia = COUNTRY_ORDER.indexOf(a[0]), ib = COUNTRY_ORDER.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b[1].ls.length - a[1].ls.length;
  });
  const row = (lvl: number, label: string, nd: GeoNode, key?: string) => {
    const c = stageCounts(nd.ls);
    const pad = ['', 'pl-6', 'pl-11'][lvl];
    return (
      <tr key={key || label + lvl} className="hover:bg-[#F7FAFD]">
        <td className={cx(td, first, pad, lvl === 0 && 'font-bold', lvl === 1 && 'font-semibold', lvl === 2 && 'text-[#5E778C]')}>
          {key && nd.kids.size ? (
            <button type="button" aria-expanded={open.has(key)} onClick={() => toggle(key)} className="inline-flex items-center gap-1.5">
              <span className="inline-flex w-4 h-4 items-center justify-center border border-[#D3E3F0] rounded text-[10px] text-[#5E778C]">{open.has(key) ? '−' : '+'}</span>
              {label}
            </button>
          ) : label}
        </td>
        <td className={td}><NumBtn n={nd.ls.length} onClick={() => show(label, nd.ls)} /></td>
        {GEO_COLS.map((s) => <td key={s} className={td}><NumBtn n={c[s]} of={nd.ls.length} onClick={() => show(`${label} · ${MIS_STAGE[s].name}`, nd.ls.filter((l) => l.stage === s))} /></td>)}
      </tr>
    );
  };
  const body: React.ReactNode[] = [];
  countries.forEach(([a, A]) => {
    body.push(row(0, a, A, a));
    if (!open.has(a)) return;
    bySize(A.kids).forEach(([b, B]) => {
      const kb = `${a}|${b}`;
      body.push(row(1, b, B, kb));
      if (open.has(kb)) bySize(B.kids).forEach(([c, C]) => body.push(row(2, c, C)));
    });
  });
  return (
    <Panel
      title="Country, state and city"
      hint="Selected period. Select a country or state to open or close it."
      actions={<Button size="xs" onClick={() => setOpen(allOpen ? new Set() : new Set(allKeys))}>{allOpen ? 'Close all' : 'Open all'}</Button>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className={cx(th, first)}>Country, state, city</th>
              <th className={th}>Leads</th>
              {GEO_COLS.map((s) => <th key={s} className={th}><Dot color={MIS_STAGE[s].color} />{MIS_STAGE[s].short}</th>)}
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </Panel>
  );
};
