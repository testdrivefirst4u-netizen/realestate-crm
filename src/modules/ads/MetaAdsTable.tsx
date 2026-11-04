/**
 * Ads manager › Meta (server: modules/metaAdsTable.ts): campaigns, ad sets and ads with the columns of Meta Ads Manager,
 * a date range, a column chooser, and the on/off switch and daily budget of each row. A click on a name, or ticking
 * rows, shows what is inside them on the next tab. New campaigns and ads are made in Meta (Open in Meta).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Columns3, ExternalLink, Pencil, RefreshCw, Search, X } from 'lucide-react';
import { api, type MetaAdsLevel, type MetaAdsResult, type MetaAdsRow } from '../../core/api';
import { formatDate } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, EmptyState, InlineNotice, cx, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const LEVELS: Array<{ id: MetaAdsLevel; label: string }> = [{ id: 'campaign', label: 'Campaigns' }, { id: 'adset', label: 'Ad sets' }, { id: 'ad', label: 'Ads' }];
const PRESETS = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'last_7d', label: 'Last 7 days' }, { id: 'last_14d', label: 'Last 14 days' }, { id: 'last_30d', label: 'Last 30 days' },
  { id: 'this_month', label: 'This month' }, { id: 'last_month', label: 'Last month' }, { id: 'maximum', label: 'Maximum' }, { id: 'custom', label: 'Custom' },
];
const DELIVERY: Record<string, { label: string; dot: string }> = {
  ACTIVE: { label: 'Active', dot: 'bg-[#31A24C]' }, PAUSED: { label: 'Off', dot: 'bg-[#A7B4C0]' }, CAMPAIGN_PAUSED: { label: 'Campaign off', dot: 'bg-[#A7B4C0]' }, ADSET_PAUSED: { label: 'Ad set off', dot: 'bg-[#A7B4C0]' },
  PENDING_REVIEW: { label: 'In review', dot: 'bg-[#F0A92E]' }, PREAPPROVED: { label: 'Pre-approved', dot: 'bg-[#F0A92E]' }, IN_PROCESS: { label: 'Processing', dot: 'bg-[#F0A92E]' },
  DISAPPROVED: { label: 'Rejected', dot: 'bg-[#E0483E]' }, WITH_ISSUES: { label: 'Has issues', dot: 'bg-[#E0483E]' }, PENDING_BILLING_INFO: { label: 'Billing needed', dot: 'bg-[#E0483E]' },
};
const BID: Record<string, string> = { LOWEST_COST_WITHOUT_CAP: 'Highest volume', LOWEST_COST_WITH_BID_CAP: 'Bid cap', COST_CAP: 'Cost per result goal', LOWEST_COST_WITH_MIN_ROAS: 'ROAS goal' };
const words = (s: string) => s.replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const count = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-IN'));
const dec = (n: number | null, digits = 2) => (n === null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const pct = (n: number | null) => (n === null ? '—' : `${dec(n)}%`);
function cash(n: number | null, currency: string) {
  if (n === null) return '—';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return dec(n);
  }
}
const day = (s: string, none: string) => (s ? formatDate(s) : none);
const budgetText = (r: MetaAdsRow) => {
  if (r.dailyBudget !== null) return `${cash(r.dailyBudget, r.currency)}/day`;
  if (r.lifetimeBudget !== null) return `${cash(r.lifetimeBudget, r.currency)} lifetime`;
  return r.level === 'campaign' ? 'Using ad set budget' : r.level === 'adset' ? 'Using campaign budget' : '—';
};

interface Column {
  id: string; label: string; right?: boolean; levels?: MetaAdsLevel[];
  /** The figure sorted by (and, with `text`, what is shown). */
  sort: (r: MetaAdsRow) => number | string;
  text: (r: MetaAdsRow) => React.ReactNode;
}
const COLUMNS: Column[] = [
  { id: 'delivery', label: 'Delivery', sort: (r) => r.delivery, text: (r) => { const d = DELIVERY[r.delivery] || { label: words(r.delivery), dot: 'bg-[#A7B4C0]' }; return <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className={cx('h-2 w-2 rounded-full', d.dot)} />{d.label}</span>; } },
  { id: 'objective', label: 'Objective', levels: ['campaign', 'adset'], sort: (r) => r.objective, text: (r) => (r.objective ? words(r.objective) : '—') },
  { id: 'goal', label: 'Optimisation goal', levels: ['adset', 'ad'], sort: (r) => r.optimizationGoal, text: (r) => (r.optimizationGoal ? words(r.optimizationGoal) : '—') },
  { id: 'bid', label: 'Bid strategy', levels: ['campaign', 'adset'], sort: (r) => r.bidStrategy, text: (r) => BID[r.bidStrategy] || (r.bidStrategy ? words(r.bidStrategy) : r.level === 'campaign' ? 'Using ad set bid strategy' : '—') },
  { id: 'budget', label: 'Budget', right: true, levels: ['campaign', 'adset'], sort: (r) => r.dailyBudget ?? r.lifetimeBudget ?? -1, text: budgetText },
  { id: 'results', label: 'Results', right: true, sort: (r) => r.results ?? -1, text: (r) => <span>{count(r.results)}{r.resultLabel && <span className="block text-[10px] text-[#6B7B8C]">{r.resultLabel}</span>}</span> },
  { id: 'reach', label: 'Reach', right: true, sort: (r) => r.reach ?? -1, text: (r) => count(r.reach) },
  { id: 'impressions', label: 'Impressions', right: true, sort: (r) => r.impressions ?? -1, text: (r) => count(r.impressions) },
  { id: 'frequency', label: 'Frequency', right: true, sort: (r) => r.frequency ?? -1, text: (r) => dec(r.frequency) },
  { id: 'cpr', label: 'Cost per result', right: true, sort: (r) => r.costPerResult ?? -1, text: (r) => cash(r.costPerResult, r.currency) },
  { id: 'spend', label: 'Amount spent', right: true, sort: (r) => r.spend ?? -1, text: (r) => cash(r.spend, r.currency) },
  { id: 'start', label: 'Starts', levels: ['campaign', 'adset'], sort: (r) => r.start, text: (r) => day(r.start, '—') },
  { id: 'end', label: 'Ends', levels: ['campaign', 'adset'], sort: (r) => r.end, text: (r) => day(r.end, 'Ongoing') },
  { id: 'linkClicks', label: 'Link clicks', right: true, sort: (r) => r.linkClicks ?? -1, text: (r) => count(r.linkClicks) },
  { id: 'linkCtr', label: 'CTR (link)', right: true, sort: (r) => r.linkCtr ?? -1, text: (r) => pct(r.linkCtr) },
  { id: 'linkCpc', label: 'CPC (link)', right: true, sort: (r) => r.linkCpc ?? -1, text: (r) => cash(r.linkCpc, r.currency) },
  { id: 'cpm', label: 'CPM', right: true, sort: (r) => r.cpm ?? -1, text: (r) => cash(r.cpm, r.currency) },
  { id: 'clicks', label: 'Clicks (all)', right: true, sort: (r) => r.clicks ?? -1, text: (r) => count(r.clicks) },
  { id: 'ctr', label: 'CTR (all)', right: true, sort: (r) => r.ctr ?? -1, text: (r) => pct(r.ctr) },
  { id: 'cpc', label: 'CPC (all)', right: true, sort: (r) => r.cpc ?? -1, text: (r) => cash(r.cpc, r.currency) },
  { id: 'leads', label: 'Leads', right: true, sort: (r) => r.leads ?? -1, text: (r) => count(r.leads) },
  { id: 'landing', label: 'Landing page views', right: true, sort: (r) => r.landingPageViews ?? -1, text: (r) => count(r.landingPageViews) },
  { id: 'quality', label: 'Quality ranking', levels: ['ad'], sort: (r) => r.qualityRanking, text: (r) => (r.qualityRanking ? words(r.qualityRanking) : '—') },
  { id: 'engagement', label: 'Engagement ranking', levels: ['ad'], sort: (r) => r.engagementRanking, text: (r) => (r.engagementRanking ? words(r.engagementRanking) : '—') },
  { id: 'conversion', label: 'Conversion ranking', levels: ['ad'], sort: (r) => r.conversionRanking, text: (r) => (r.conversionRanking ? words(r.conversionRanking) : '—') },
];
const DEFAULT_COLUMNS = ['delivery', 'bid', 'budget', 'results', 'reach', 'impressions', 'cpr', 'spend', 'end'];
const COLUMNS_KEY = 'crm.metaAds.columns';

function savedColumns(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(COLUMNS_KEY) || 'null');
    return Array.isArray(raw) && raw.length ? raw.filter((x) => typeof x === 'string') : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

const th = 'px-3 py-2 text-[11px] font-semibold text-[#44505C] whitespace-nowrap select-none';
const td = 'px-3 py-2 text-xs text-[#1C2B33] align-middle';

export const MetaAdsTable: React.FC<{ canChange: boolean }> = ({ canChange }) => {
  const [level, setLevel] = useState<MetaAdsLevel>('campaign');
  const [preset, setPreset] = useState('last_7d');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [data, setData] = useState<MetaAdsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [picking, setPicking] = useState(false);
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [pickedCampaigns, setPickedCampaigns] = useState<string[]>([]);
  const [pickedAdsets, setPickedAdsets] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const latest = useRef(0);

  useEffect(() => setColumns(savedColumns()), []);
  const custom = preset === 'custom';
  const load = useCallback(async () => {
    if (custom && (!since || !until)) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.ads.meta({ level, ...(custom ? { since, until } : { preset }) });
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('ads.meta', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [level, preset, since, until, custom]);
  useEffect(() => void load(), [load]);

  const chooseColumns = (id: string, on: boolean) => {
    const next = on ? COLUMNS.filter((c) => c.id === id || columns.includes(c.id)).map((c) => c.id) : columns.filter((c) => c !== id);
    setColumns(next);
    try { window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(next)); } catch { /* the choice lasts this visit */ }
  };
  const shown = COLUMNS.filter((c) => columns.includes(c.id) && (!c.levels || c.levels.includes(level)));

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (data?.rows || []).filter((r) => r.level === level
      && (!account || r.accountId === account)
      && (!activeOnly || r.delivery === 'ACTIVE')
      && (!q || r.name.toLowerCase().includes(q))
      && (level === 'campaign' || !pickedCampaigns.length || pickedCampaigns.includes(r.campaignId))
      && (level !== 'ad' || !pickedAdsets.length || pickedAdsets.includes(r.adsetId)));
    const col = sort && COLUMNS.find((c) => c.id === sort.id);
    if (!col) return out;
    return [...out].sort((a, b) => {
      const x = col.sort(a), y = col.sort(b);
      const n = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort!.desc ? -n : n;
    });
  }, [data, level, account, activeOnly, search, pickedCampaigns, pickedAdsets, sort]);

  const currencies = new Set(rows.map((r) => r.currency));
  const currency = currencies.size === 1 ? [...currencies][0] : '';
  const sum = (f: (r: MetaAdsRow) => number | null) => rows.reduce((t, r) => t + (f(r) || 0), 0);
  const totals: Record<string, string> = {};
  if (rows.length) {
    const spend = sum((r) => r.spend), impressions = sum((r) => r.impressions), linkClicks = sum((r) => r.linkClicks), clicks = sum((r) => r.clicks);
    const labels = new Set(rows.filter((r) => r.results !== null).map((r) => r.resultLabel));
    if (labels.size === 1) {
      const results = sum((r) => r.results);
      totals.results = count(results);
      if (currency && results) totals.cpr = cash(spend / results, currency);
    }
    totals.impressions = count(impressions);
    totals.linkClicks = count(linkClicks);
    totals.clicks = count(clicks);
    totals.leads = count(sum((r) => r.leads));
    totals.landing = count(sum((r) => r.landingPageViews));
    if (impressions) { totals.linkCtr = pct(linkClicks / impressions * 100); totals.ctr = pct(clicks / impressions * 100); }
    if (currency) {
      totals.spend = cash(spend, currency);
      if (linkClicks) totals.linkCpc = cash(spend / linkClicks, currency);
      if (clicks) totals.cpc = cash(spend / clicks, currency);
      if (impressions) totals.cpm = cash(spend / impressions * 1000, currency);
    }
  }

  const levelName = (r: MetaAdsRow) => (r.level === 'campaign' ? 'campaign' : r.level === 'adset' ? 'ad set' : 'ad');
  const switchRow = async (r: MetaAdsRow) => {
    const next = r.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    const warn = next === 'ACTIVE' ? ' It can start spending money straight away.' : '';
    if (!window.confirm(`Turn ${next === 'ACTIVE' ? 'on' : 'off'} the ${levelName(r)} “${r.name}”?${warn}`)) return;
    setBusy(r.id);
    try {
      await api.ads.setMetaStatus(r.id, `${levelName(r)}: ${r.name}`, next);
      toast(next === 'ACTIVE' ? 'Turned on' : 'Turned off', r.name, 'success');
      await load();
    } catch (e) {
      toast('Not changed', errText('ads.metaStatus', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const saveBudget = async (r: MetaAdsRow) => {
    const v = Number(editing?.value);
    if (!Number.isFinite(v) || v < 100) return toast('Enter a daily budget of at least ₹100', undefined, 'alert');
    if (r.dailyBudget && (v > r.dailyBudget * 2 || v < r.dailyBudget / 2) && !window.confirm(`Change the daily budget from ${cash(r.dailyBudget, r.currency)} to ${cash(v, r.currency)}?`)) return;
    setBusy(r.id);
    try {
      await api.ads.setMetaBudget(r.id, `${levelName(r)}: ${r.name}`, v);
      setEditing(null);
      toast('Budget changed', `${r.name}: ${cash(v, r.currency)} a day`, 'success');
      await load();
    } catch (e) {
      toast('Budget not changed', errText('ads.metaBudget', e), 'alert');
    } finally {
      setBusy('');
    }
  };

  const open = (r: MetaAdsRow) => {
    if (r.level === 'campaign') { setPickedCampaigns([r.id]); setPickedAdsets([]); setLevel('adset'); }
    else if (r.level === 'adset') { setPickedAdsets([r.id]); setLevel('ad'); }
  };
  const picked = level === 'campaign' ? pickedCampaigns : level === 'adset' ? pickedAdsets : [];
  const togglePick = (id: string, on: boolean) => {
    const set = level === 'campaign' ? setPickedCampaigns : setPickedAdsets;
    set((v) => (on ? [...v, id] : v.filter((x) => x !== id)));
  };
  const clearFilter = () => { setPickedCampaigns([]); setPickedAdsets([]); };
  const clickSort = (id: string) => setSort((s) => (s?.id === id ? { id, desc: !s.desc } : { id, desc: true }));
  const metaAccount = account || data?.accounts[0]?.id || '';
  const metaLink = `https://adsmanager.facebook.com/adsmanager/manage/campaigns${metaAccount ? `?act=${metaAccount.replace(/^act_/, '')}` : ''}`;

  if (data && !data.connected) return <EmptyState title="Meta ads are not connected" description="An Admin can connect them in Settings › Meta ads. Google Ads campaigns are on the Overview tab." />;

  return (
    <div className="rounded-xl border border-[#DADDE1] bg-white">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-[#DADDE1]">
        <label className="relative min-w-[180px] flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B7B8C]" />
          <input className={cx(inputCls, 'pl-8')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" aria-label="Search by name" />
        </label>
        {(data?.accounts.length || 0) > 1 && (
          <select className={cx(inputCls, 'w-auto')} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Ad account">
            <option value="">All ad accounts</option>
            {data!.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <select className={cx(inputCls, 'w-auto')} value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {custom && (
          <>
            <input type="date" className={cx(inputCls, 'w-auto')} value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} aria-label="From" />
            <input type="date" className={cx(inputCls, 'w-auto')} value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} aria-label="To" />
          </>
        )}
        <label className="inline-flex items-center gap-1.5 text-xs text-[#1C2B33]"><input type="checkbox" className="h-4 w-4 accent-[#0866FF]" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only</label>
        <div className="relative">
          <Button variant="secondary" size="sm" icon={<Columns3 size={13} />} aria-expanded={picking} onClick={() => setPicking((v) => !v)}>Columns</Button>
          {picking && (
            <div className="absolute right-0 z-30 mt-1 w-56 max-h-80 overflow-y-auto rounded-lg border border-[#DADDE1] bg-white p-2 shadow-xl">
              <button type="button" className="mb-1 w-full px-1 text-left text-[11px] font-semibold text-[#0866FF] hover:underline" onClick={() => { setColumns(DEFAULT_COLUMNS); try { window.localStorage.removeItem(COLUMNS_KEY); } catch { /* nothing saved */ } }}>Reset to default</button>
              {COLUMNS.map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-1 py-1 text-xs text-[#1C2B33]">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-[#0866FF]" checked={columns.includes(c.id)} onChange={(e) => chooseColumns(c.id, e.target.checked)} /> {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load()}>Refresh</Button>
        <a href={metaLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[#0866FF] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110">Create in Meta <ExternalLink size={12} /></a>
      </div>

      <div className="flex items-stretch border-b border-[#DADDE1]" role="tablist" aria-label="Level">
        {LEVELS.map((l) => {
          const n = l.id === 'campaign' ? pickedCampaigns.length : l.id === 'adset' ? pickedAdsets.length : 0;
          return (
            <button key={l.id} type="button" role="tab" aria-selected={level === l.id} onClick={() => setLevel(l.id)}
              className={cx('flex-1 px-3 py-2.5 text-[13px] font-semibold border-b-2 -mb-px', level === l.id ? 'border-[#0866FF] text-[#0866FF]' : 'border-transparent text-[#44505C] hover:bg-[#F5F6F7]')}>
              {l.label}{n > 0 && <span className="ml-1.5 rounded bg-[#E7F0FF] px-1.5 py-0.5 text-[10px] text-[#0866FF]">{n} selected</span>}
            </button>
          );
        })}
      </div>

      {(pickedCampaigns.length > 0 || pickedAdsets.length > 0) && (
        <div className="flex items-center gap-2 border-b border-[#DADDE1] px-3 py-1.5 text-[11px] text-[#44505C]">
          Showing only what you selected.
          <button type="button" className="inline-flex items-center gap-1 font-semibold text-[#0866FF] hover:underline" onClick={clearFilter}><X size={11} /> Clear</button>
        </div>
      )}
      {failed && <InlineNotice tone="warning" className="m-3">{failed}</InlineNotice>}
      {data?.errors.map((e) => <InlineNotice key={e.account} tone="warning" className="m-3">{e.account}: {e.message}</InlineNotice>)}

      {!data ? <p className="p-4 text-xs text-[#6B7B8C]">{failed ? '' : 'Loading…'}</p> : !rows.length ? (
        <EmptyState className="py-10" title={`No ${LEVELS.find((l) => l.id === level)!.label.toLowerCase()} to show`} description="Try another date range, clear the search, or untick Active only." />
      ) : (
        <div className={cx('overflow-x-auto', loading && 'opacity-60')}>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[#DADDE1] bg-[#F5F6F7]">
                <th className="w-8 px-2" aria-label="Select" />
                <th className="w-10 px-1 text-[11px] font-semibold text-[#44505C]">{level === 'ad' ? '' : 'Off/On'}</th>
                <th className={cx(th, 'min-w-[240px] text-left')}>{LEVELS.find((l) => l.id === level)!.label}</th>
                {shown.map((c) => (
                  <th key={c.id} className={cx(th, c.right ? 'text-right' : 'text-left')} aria-sort={sort?.id === c.id ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                    <button type="button" className="inline-flex items-center gap-1 hover:text-[#0866FF]" onClick={() => clickSort(c.id)}>
                      {c.label}{sort?.id === c.id && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EBEDF0]">
              {rows.map((r) => (
                <tr key={r.id} className={cx('hover:bg-[#F5F9FF]', picked.includes(r.id) && 'bg-[#EEF4FF]')}>
                  <td className="px-2 text-center">
                    {level !== 'ad' && <input type="checkbox" className="h-3.5 w-3.5 accent-[#0866FF]" aria-label={`Select ${r.name}`} checked={picked.includes(r.id)} onChange={(e) => togglePick(r.id, e.target.checked)} />}
                  </td>
                  <td className="px-1 text-center">
                    <button type="button" role="switch" aria-checked={r.status === 'ACTIVE'} aria-label={`${r.name}: ${r.status === 'ACTIVE' ? 'on' : 'off'}`} disabled={!canChange || busy === r.id} title={canChange ? undefined : 'Only Admins and Managers can change this'} onClick={() => void switchRow(r)}
                      className={cx('relative inline-block h-[18px] w-8 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60', r.status === 'ACTIVE' ? 'bg-[#0866FF]' : 'bg-[#BCC0C4]')}>
                      <span className={cx('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all', r.status === 'ACTIVE' ? 'left-4' : 'left-0.5')} />
                    </button>
                  </td>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      {r.thumbnail && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumbnail} alt="" loading="lazy" className="h-9 w-9 flex-none rounded object-cover bg-[#F5F6F7]" />
                      )}
                      <span className="min-w-0">
                        {level === 'ad' ? <b className="block max-w-[300px] truncate font-semibold" title={r.name}>{r.name}</b> : (
                          <button type="button" className="block max-w-[300px] truncate text-left font-semibold text-[#0866FF] hover:underline" title={r.name} onClick={() => open(r)}>{r.name}</button>
                        )}
                        {level !== 'campaign' && <span className="block max-w-[300px] truncate text-[10.5px] text-[#6B7B8C]">{r.adsetName && level === 'ad' ? `${r.adsetName} · ` : ''}{r.campaignName}</span>}
                      </span>
                    </div>
                  </td>
                  {shown.map((c) => (
                    <td key={c.id} className={cx(td, 'whitespace-nowrap', c.right && 'text-right tabular-nums')}>
                      {c.id === 'budget' && editing?.id === r.id ? (
                        <span className="inline-flex items-center gap-1">
                          <input className={cx(inputCls, 'w-24 text-right')} type="number" min={100} step={100} value={editing.value} onChange={(e) => setEditing({ id: r.id, value: e.target.value })} aria-label="Daily budget" autoFocus />
                          <Button size="xs" loading={busy === r.id} onClick={() => void saveBudget(r)}>Save</Button>
                          <Button variant="secondary" size="xs" onClick={() => setEditing(null)}>Cancel</Button>
                        </span>
                      ) : c.id === 'budget' && canChange && r.dailyBudget !== null ? (
                        <span className="inline-flex items-center gap-1">{budgetText(r)}<button type="button" aria-label={`Change the budget of ${r.name}`} className="text-[#0866FF]" onClick={() => setEditing({ id: r.id, value: String(r.dailyBudget) })}><Pencil size={12} /></button></span>
                      ) : c.text(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[#DADDE1] bg-[#F5F6F7]">
                <td /><td />
                <td className={cx(td, 'font-semibold')}>{rows.length} {rows.length === 1 ? LEVELS.find((l) => l.id === level)!.label.replace(/s$/, '').toLowerCase() : LEVELS.find((l) => l.id === level)!.label.toLowerCase()}</td>
                {shown.map((c) => <td key={c.id} className={cx(td, 'font-semibold whitespace-nowrap', c.right && 'text-right tabular-nums')} title={c.id === 'reach' || c.id === 'frequency' ? 'One person can be in several rows, so these do not add up.' : undefined}>{totals[c.id] || ''}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
};
