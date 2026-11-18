/**
 * Ads manager › Meta, in the Meta Ads Manager layout (server: modules/metaAdsTable.ts):
 * a header with the ad-account picker, date range and "Create Ad"; pill tabs (Campaigns / Ad sets / Ads / Lead Forms);
 * a blue column header with Off/On, name, Delivery, Objective, Schedule Start/End, Impressions, Clicks, Spend, Reach and
 * a + to add more columns; the on/off switch and daily budget per row; a drill-down by name; and page navigation.
 * New campaigns and ads are still made in Meta (Create Ad / a name opens Meta).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, ChevronDown, Download, Facebook, Layers, Pencil, Plus, RefreshCw, Search, X } from 'lucide-react';
import { api, type MetaAdsLevel, type MetaAdsResult, type MetaAdsRow } from '../../core/api';
import { formatDate, todayKey } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { downloadXlsx } from '../../core/xlsx';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';
import { DELIVERY, cash, count, dec, pct, words } from './adsCells';
import { AdsSideBySide } from './AdsSideBySide';
import { MAX_SIDE_BY_SIDE } from './adsCompare';
import { CreateAdWizard } from './CreateAdWizard';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
type Tab = MetaAdsLevel | 'leadforms';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'campaign', label: 'Campaigns' }, { id: 'adset', label: 'Ad sets' }, { id: 'ad', label: 'Ads' }, { id: 'leadforms', label: 'Lead Forms' },
];
const NAME_LABEL: Record<MetaAdsLevel, string> = { campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' };
const PRESETS = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'last_7d', label: 'Last 7 days' }, { id: 'last_14d', label: 'Last 14 days' },
  { id: 'last_30d', label: 'Last 30 days' }, { id: 'last_90d', label: 'Last 90 days' }, { id: 'this_month', label: 'This month' }, { id: 'last_month', label: 'Last month' },
  { id: 'maximum', label: 'Maximum' }, { id: 'custom', label: 'Custom…' },
];
const PER_PAGE = [10, 25, 50];
const day = (s: string, none: string) => (s ? formatDate(s) : none);
const budgetText = (r: MetaAdsRow) => {
  if (r.dailyBudget !== null) return `${cash(r.dailyBudget, r.currency)}/day`;
  if (r.lifetimeBudget !== null) return `${cash(r.lifetimeBudget, r.currency)} lifetime`;
  return r.level === 'campaign' ? 'Using ad set budget' : r.level === 'adset' ? 'Using campaign budget' : '—';
};

interface Col { id: string; label: string; right?: boolean; levels?: MetaAdsLevel[]; text: (r: MetaAdsRow) => React.ReactNode }
const COLS: Col[] = [
  { id: 'delivery', label: 'Delivery', text: (r) => { const d = DELIVERY[r.delivery] || { label: words(r.delivery), dot: 'bg-[#A7B4C0]' }; return <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className={cx('h-2 w-2 rounded-full', d.dot)} />{d.label}</span>; } },
  { id: 'objective', label: 'Objective', levels: ['campaign', 'adset'], text: (r) => (r.objective ? words(r.objective) : '—') },
  { id: 'start', label: 'Schedule Start', levels: ['campaign', 'adset'], text: (r) => day(r.start, '—') },
  { id: 'end', label: 'Schedule End', levels: ['campaign', 'adset'], text: (r) => day(r.end, 'Ongoing') },
  { id: 'impressions', label: 'Impressions', right: true, text: (r) => count(r.impressions) },
  { id: 'clicks', label: 'Clicks', right: true, text: (r) => count(r.clicks) },
  { id: 'spend', label: 'Spend', right: true, text: (r) => cash(r.spend, r.currency) },
  { id: 'reach', label: 'Reach', right: true, text: (r) => count(r.reach) },
  // added from the + menu
  { id: 'results', label: 'Results', right: true, text: (r) => <span>{count(r.results)}{r.resultLabel && <span className="block text-[10px] opacity-70">{r.resultLabel}</span>}</span> },
  { id: 'cpr', label: 'Cost / result', right: true, text: (r) => cash(r.costPerResult, r.currency) },
  { id: 'leads', label: 'Leads', right: true, text: (r) => count(r.leads) },
  { id: 'cpm', label: 'CPM', right: true, text: (r) => cash(r.cpm, r.currency) },
  { id: 'ctr', label: 'CTR', right: true, text: (r) => pct(r.ctr) },
  { id: 'cpc', label: 'CPC', right: true, text: (r) => cash(r.cpc, r.currency) },
  { id: 'linkClicks', label: 'Link clicks', right: true, text: (r) => count(r.linkClicks) },
  { id: 'landing', label: 'Landing views', right: true, text: (r) => count(r.landingPageViews) },
  { id: 'frequency', label: 'Frequency', right: true, text: (r) => dec(r.frequency) },
  { id: 'budget', label: 'Budget', right: true, levels: ['campaign', 'adset'], text: budgetText },
];
const DEFAULT_COLS = ['delivery', 'objective', 'start', 'end', 'impressions', 'clicks', 'spend', 'reach'];
const COLS_KEY = 'crm.metaAdsManager.columns';
const savedCols = (): string[] => {
  try { const r = JSON.parse(window.localStorage.getItem(COLS_KEY) || 'null'); return Array.isArray(r) && r.length ? r.filter((x) => typeof x === 'string') : DEFAULT_COLS; } catch { return DEFAULT_COLS; }
};

const hBlue = 'bg-[#3F72C4]';
const thC = 'px-3 py-3 text-left text-[12px] font-semibold text-white whitespace-nowrap';
const tdC = 'px-3 py-2.5 text-[13px] text-[#1C2B33] align-middle';

export const MetaAdsManager: React.FC<{ canChange: boolean; canExport?: boolean }> = ({ canChange, canExport }) => {
  const [tab, setTab] = useState<Tab>('campaign');
  const level: MetaAdsLevel = tab === 'leadforms' ? 'campaign' : tab;
  const [preset, setPreset] = useState('last_7d');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [data, setData] = useState<MetaAdsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLS);
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(10);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [drillCampaign, setDrillCampaign] = useState<string[]>([]);
  const [drillAdset, setDrillAdset] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [pendingId, setPendingId] = useState('');
  const latest = useRef(0);

  // returning from the inline "Continue with Facebook" (OAuth) lands on /ads?metaConnect=<id>: reopen the wizard here
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const mc = q.get('metaConnect'); const me = q.get('metaError');
    if (mc || me) {
      if (mc) setPendingId(mc);
      if (me) toast('Facebook connection', me, 'alert');
      setWizard(true);
      q.delete('metaConnect'); q.delete('metaError');
      window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
    }
  }, []);

  useEffect(() => setColumns(savedCols()), []);
  const custom = preset === 'custom';
  const load = useCallback(async () => {
    if (custom && (!since || !until)) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.ads.meta({ level, ...(custom ? { since, until } : { preset }) });
      if (mine !== latest.current) return;
      setData(r); setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('ads.meta', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [level, preset, since, until, custom]);
  useEffect(() => void load(), [load]);
  useEffect(() => { setPage(0); setPicked([]); }, [tab, account, search, perPage, preset]);

  const toggleCol = (id: string, on: boolean) => {
    const next = on ? COLS.filter((c) => c.id === id || columns.includes(c.id)).map((c) => c.id) : columns.filter((c) => c !== id);
    setColumns(next);
    try { window.localStorage.setItem(COLS_KEY, JSON.stringify(next)); } catch { /* lasts this visit */ }
  };
  const shown = COLS.filter((c) => columns.includes(c.id) && (!c.levels || c.levels.includes(level)));

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows || []).filter((r) => r.level === level
      && (!account || r.accountId === account)
      && (!q || r.name.toLowerCase().includes(q))
      && (level === 'campaign' || !drillCampaign.length || drillCampaign.includes(r.campaignId))
      && (level !== 'ad' || !drillAdset.length || drillAdset.includes(r.adsetId)));
  }, [data, level, account, search, drillCampaign, drillAdset]);

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const curPage = Math.min(page, pages - 1);
  const slice = rows.slice(curPage * perPage, curPage * perPage + perPage);
  const from = total ? curPage * perPage + 1 : 0;
  const to = curPage * perPage + slice.length;
  const togglePick = (id: string, on: boolean) => setPicked((v) => (on ? [...v, id] : v.filter((x) => x !== id)));
  const pickedRows = rows.filter((r) => picked.includes(r.id));
  const allOnPage = slice.length > 0 && slice.every((r) => picked.includes(r.id));
  const periodLabel = custom ? (since && until ? `${formatDate(since)} – ${formatDate(until)}` : 'Custom range') : (PRESETS.find((p) => p.id === preset)?.label || '');

  const levelName = (r: MetaAdsRow) => (r.level === 'campaign' ? 'campaign' : r.level === 'adset' ? 'ad set' : 'ad');
  const switchRow = async (r: MetaAdsRow) => {
    const next = r.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    const warn = next === 'ACTIVE' ? ' It can start spending money straight away.' : '';
    if (!window.confirm(`Turn ${next === 'ACTIVE' ? 'on' : 'off'} the ${levelName(r)} “${r.name}”?${warn}`)) return;
    setBusy(r.id);
    try { await api.ads.setMetaStatus(r.id, `${levelName(r)}: ${r.name}`, next); toast(next === 'ACTIVE' ? 'Turned on' : 'Turned off', r.name, 'success'); await load(); }
    catch (e) { toast('Not changed', errText('ads.metaStatus', e), 'alert'); }
    finally { setBusy(''); }
  };
  const saveBudget = async (r: MetaAdsRow) => {
    const v = Number(editing?.value);
    if (!Number.isFinite(v) || v < 100) return toast('Enter a daily budget of at least ₹100', undefined, 'alert');
    if (r.dailyBudget && (v > r.dailyBudget * 2 || v < r.dailyBudget / 2) && !window.confirm(`Change the daily budget from ${cash(r.dailyBudget, r.currency)} to ${cash(v, r.currency)}?`)) return;
    setBusy(r.id);
    try { await api.ads.setMetaBudget(r.id, `${levelName(r)}: ${r.name}`, v); setEditing(null); toast('Budget changed', `${r.name}: ${cash(v, r.currency)} a day`, 'success'); await load(); }
    catch (e) { toast('Budget not changed', errText('ads.metaBudget', e), 'alert'); }
    finally { setBusy(''); }
  };
  const openInside = (r: MetaAdsRow) => {
    if (r.level === 'campaign') { setDrillCampaign([r.id]); setDrillAdset([]); setTab('adset'); }
    else if (r.level === 'adset') { setDrillAdset([r.id]); setTab('ad'); }
  };


  const exportExcel = () => {
    const headers = ['Off/On', NAME_LABEL[level], ...shown.map((c) => c.label)];
    const body = rows.map((r) => [r.status === 'ACTIVE' ? 'On' : 'Off', r.name, ...shown.map((c) => (typeof c.text(r) === 'object' ? (c.id === 'spend' ? cash(r.spend, r.currency) : '') : String(c.text(r))))]);
    downloadXlsx(`meta-${level}-${todayKey()}.xlsx`, headers, body, NAME_LABEL[level]);
    toast('Excel downloaded', `${rows.length} ${NAME_LABEL[level].toLowerCase()}s`, 'success');
  };

  const notConnected = !!data && !data.connected;
  const colCount = 4 + shown.length; // checkbox, off/on, name, + column
  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">Meta Ads Manager</h2>
        {(data?.accounts.length || 0) > 0 && (
          <div className="relative">
            <select className={cx(inputCls, '!w-[220px] appearance-none pr-8')} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="FB Ad Account">
              <option value="">Select FB Ad Account</option>
              {data!.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <ChevronDown size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7B8C]" />
          </div>
        )}
        <button type="button" onClick={() => setWizard(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-[#2E6AD1] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"><Plus size={15} /> Create Ad</button>
      </div>

      {notConnected ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-[#E2ECF3] bg-white py-16 text-center shadow-[0_1px_3px_rgba(16,40,64,0.06)]">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#EAF2FC] text-[#2E6AD1]"><Layers size={26} /></span>
          <div>
            <p className="text-lg font-bold text-[#0B2A44]">Meta ads are not connected</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-[#5E778C]">Connect your Facebook Business Manager right here — no need to open Settings. You need an admin Facebook login.</p>
          </div>
          <button type="button" onClick={() => setWizard(true)} className="inline-flex items-center gap-2 rounded-lg bg-[#2E6AD1] px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110"><Facebook size={16} /> Connect Facebook</button>
        </div>
      ) : (<>

      {/* tabs + date range */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-[#EEF2F6] p-1" role="tablist" aria-label="Level">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={cx('rounded-full px-4 py-1.5 text-[13px] font-semibold transition', tab === t.id ? 'bg-[#1AA865] text-white shadow-sm' : 'text-[#44505C] hover:bg-white')}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B7B8C]" />
            <input className={cx(inputCls, 'w-[180px] pl-8')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" aria-label="Search by name" />
          </label>
          <div className="relative">
            <CalendarRange size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B7B8C]" />
            <select className={cx(inputCls, '!w-auto appearance-none pl-8 pr-8')} value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <ChevronDown size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7B8C]" />
          </div>
          {custom && (
            <>
              <input type="date" className={cx(inputCls, '!w-auto')} value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} aria-label="From" />
              <input type="date" className={cx(inputCls, '!w-auto')} value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} aria-label="To" />
            </>
          )}
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load()} aria-label="Refresh" />
          {canExport && <Button variant="secondary" size="sm" icon={<Download size={13} />} disabled={!rows.length || loading} onClick={exportExcel}>Export</Button>}
        </div>
      </div>

      {tab !== 'leadforms' && pickedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#CFE0F2] bg-[#EEF4FF] px-3 py-2 text-xs text-[#1C2B33]">
          <b>{pickedRows.length} selected</b>
          <Button variant="primary" size="xs" disabled={pickedRows.length < 2 || pickedRows.length > MAX_SIDE_BY_SIDE} onClick={() => setComparing(true)}>Compare side by side</Button>
          {pickedRows.length < 2 && <span className="text-[11px] text-[#44505C]">Select at least 2 to compare.</span>}
          {pickedRows.length > MAX_SIDE_BY_SIDE && <span className="text-[11px] text-[#44505C]">Select up to {MAX_SIDE_BY_SIDE} to compare.</span>}
          <button type="button" className="ml-auto inline-flex items-center gap-1 font-semibold text-[#2E6AD1] hover:underline" onClick={() => setPicked([])}><X size={11} /> Clear</button>
        </div>
      )}
      {(drillCampaign.length > 0 || drillAdset.length > 0) && (
        <div className="flex items-center gap-2 text-xs text-[#44505C]">Showing only what you opened.
          <button type="button" className="inline-flex items-center gap-1 font-semibold text-[#2E6AD1] hover:underline" onClick={() => { setDrillCampaign([]); setDrillAdset([]); }}><X size={11} /> Clear</button>
        </div>
      )}
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {data?.errors.map((e) => <InlineNotice key={e.account} tone="warning">{e.account}: {e.message}</InlineNotice>)}

      {/* table */}
      <div className="overflow-hidden rounded-xl border border-[#E2ECF3] bg-white shadow-[0_1px_3px_rgba(16,40,64,0.06)]">
        <div className={cx('overflow-x-auto', loading && 'opacity-60')}>
          <table className="w-full border-collapse">
            <thead>
              <tr className={hBlue}>
                <th className="w-9 px-2 text-center">
                  {tab !== 'leadforms' && slice.length > 0 && (
                    <input type="checkbox" className="h-3.5 w-3.5 accent-white" aria-label="Select all on this page" checked={allOnPage}
                      onChange={(e) => setPicked((v) => (e.target.checked ? [...new Set([...v, ...slice.map((r) => r.id)])] : v.filter((id) => !slice.some((r) => r.id === id))))} />
                  )}
                </th>
                <th className={cx(thC, 'w-16')}>Off/On</th>
                <th className={cx(thC, 'min-w-[220px]')}>{NAME_LABEL[level]}</th>
                {shown.map((c) => <th key={c.id} className={cx(thC, c.right && 'text-right')}>{c.label}</th>)}
                <th className="w-12 px-2 text-right">
                  <div className="relative inline-block">
                    <button type="button" aria-label="Add columns" title="Add columns" aria-expanded={picking} onClick={() => setPicking((v) => !v)} className="flex h-7 w-7 items-center justify-center rounded-md bg-white/20 text-white hover:bg-white/30"><Plus size={16} /></button>
                    {picking && (
                      <div className="absolute right-0 z-30 mt-1 max-h-80 w-52 overflow-y-auto rounded-lg border border-[#DADDE1] bg-white p-2 text-left shadow-xl">
                        <button type="button" className="mb-1 w-full px-1 text-left text-[11px] font-semibold text-[#2E6AD1] hover:underline" onClick={() => { setColumns(DEFAULT_COLS); try { window.localStorage.removeItem(COLS_KEY); } catch { /* none */ } }}>Reset to default</button>
                        {COLS.map((c) => (
                          <label key={c.id} className="flex items-center gap-2 px-1 py-1 text-xs text-[#1C2B33]">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-[#2E6AD1]" checked={columns.includes(c.id)} onChange={(e) => toggleCol(c.id, e.target.checked)} /> {c.label}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EEF2F6]">
              {tab === 'leadforms' ? (
                <tr><td colSpan={colCount} className="py-16"><NoData note="Lead forms are created and managed in Meta. Connect Meta Lead Ads in Settings to pull their leads into the CRM." /></td></tr>
              ) : !data ? (
                <tr><td colSpan={colCount} className="py-16 text-center text-sm text-[#6B7B8C]">{failed ? '' : 'Loading…'}</td></tr>
              ) : !total ? (
                <tr><td colSpan={colCount} className="py-16"><NoData /></td></tr>
              ) : slice.map((r) => (
                <tr key={r.id} className={cx('hover:bg-[#F5F9FF]', picked.includes(r.id) && 'bg-[#EEF4FF]')}>
                  <td className="px-2 text-center">
                    <input type="checkbox" className="h-3.5 w-3.5 accent-[#2E6AD1]" aria-label={`Select ${r.name}`} checked={picked.includes(r.id)} onChange={(e) => togglePick(r.id, e.target.checked)} />
                  </td>
                  <td className="px-3 text-center">
                    <button type="button" role="switch" aria-checked={r.status === 'ACTIVE'} aria-label={`${r.name}: ${r.status === 'ACTIVE' ? 'on' : 'off'}`} disabled={!canChange || busy === r.id} title={canChange ? undefined : 'Only Admins and Managers can change this'} onClick={() => void switchRow(r)}
                      className={cx('relative inline-block h-[18px] w-8 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60', r.status === 'ACTIVE' ? 'bg-[#1AA865]' : 'bg-[#BCC0C4]')}>
                      <span className={cx('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all', r.status === 'ACTIVE' ? 'left-4' : 'left-0.5')} />
                    </button>
                  </td>
                  <td className={tdC}>
                    <div className="flex items-center gap-2">
                      {r.thumbnail && <img src={r.thumbnail} alt="" loading="lazy" className="h-9 w-9 flex-none rounded object-cover bg-[#F5F6F7]" />}
                      <span className="min-w-0">
                        {level === 'ad' ? <b className="block max-w-[280px] truncate font-semibold" title={r.name}>{r.name}</b>
                          : <button type="button" className="block max-w-[280px] truncate text-left font-semibold text-[#2E6AD1] hover:underline" title={r.name} onClick={() => openInside(r)}>{r.name}</button>}
                        {level !== 'campaign' && <span className="block max-w-[280px] truncate text-[11px] text-[#6B7B8C]">{r.adsetName && level === 'ad' ? `${r.adsetName} · ` : ''}{r.campaignName}</span>}
                      </span>
                    </div>
                  </td>
                  {shown.map((c) => (
                    <td key={c.id} className={cx(tdC, 'whitespace-nowrap', c.right && 'text-right tabular-nums')}>
                      {c.id === 'budget' && editing?.id === r.id ? (
                        <span className="inline-flex items-center gap-1">
                          <input className={cx(inputCls, 'w-24 text-right')} type="number" min={100} step={100} value={editing.value} onChange={(e) => setEditing({ id: r.id, value: e.target.value })} aria-label="Daily budget" autoFocus />
                          <Button size="xs" loading={busy === r.id} onClick={() => void saveBudget(r)}>Save</Button>
                          <Button variant="secondary" size="xs" onClick={() => setEditing(null)}>Cancel</Button>
                        </span>
                      ) : c.id === 'budget' && canChange && r.dailyBudget !== null ? (
                        <span className="inline-flex items-center gap-1">{budgetText(r)}<button type="button" aria-label={`Change the budget of ${r.name}`} className="text-[#2E6AD1]" onClick={() => setEditing({ id: r.id, value: String(r.dailyBudget) })}><Pencil size={12} /></button></span>
                      ) : c.text(r)}
                    </td>
                  ))}
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#EEF2F6] px-4 py-3 text-[13px] text-[#44505C]">
          <div className="flex flex-wrap items-center gap-4">
            <span>Showing <b className="text-[#0B2A44]">{from}</b>-<b className="text-[#0B2A44]">{to}</b> of <b className="text-[#0B2A44]">{tab === 'leadforms' ? 0 : total}</b></span>
            <label className="flex items-center gap-2">Rows per page
              <div className="relative">
                <select className={cx(inputCls, '!w-auto appearance-none pr-7')} value={perPage} onChange={(e) => setPerPage(Number(e.target.value))} aria-label="Rows per page">
                  {PER_PAGE.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#6B7B8C]" />
              </div>
            </label>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={curPage === 0 || tab === 'leadforms'} onClick={() => setPage(curPage - 1)} className="rounded-lg border border-[#D3E3F0] px-3 py-1.5 font-semibold text-[#2E6AD1] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[#F2F7FB]">Prev</button>
            <span className="rounded-lg bg-[#2E6AD1] px-3 py-1.5 font-semibold text-white">{tab === 'leadforms' ? 1 : curPage + 1}</span>
            <button type="button" disabled={curPage >= pages - 1 || tab === 'leadforms'} onClick={() => setPage(curPage + 1)} className="rounded-lg border border-[#D3E3F0] px-3 py-1.5 font-semibold text-[#2E6AD1] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[#F2F7FB]">Next</button>
          </div>
        </div>
      </div>

      </>)}

      {comparing && pickedRows.length >= 2 && (
        <AdsSideBySide rows={pickedRows.slice(0, MAX_SIDE_BY_SIDE)} before={null} levelLabel={NAME_LABEL[level] + 's'} period={periodLabel} earlier="" onClose={() => setComparing(false)} />
      )}

      {wizard && (
        <CreateAdWizard connected={!!data?.connected} accounts={data?.accounts || []} pendingId={pendingId}
          onConnected={() => void load()} onClose={() => { setWizard(false); setPendingId(''); }} />
      )}
    </div>
  );
};

const NoData: React.FC<{ note?: string }> = ({ note }) => (
  <div className="flex flex-col items-center justify-center gap-3 text-center">
    <span className="flex h-12 w-14 flex-col justify-center gap-1 rounded-lg bg-[#EDE7F6] p-2" aria-hidden="true">
      <span className="h-1.5 rounded bg-[#C4B5E0]" /><span className="h-1.5 w-3/4 rounded bg-[#C4B5E0]" /><span className="h-1.5 rounded bg-[#C4B5E0]" />
    </span>
    <p className="text-[15px] font-semibold text-[#44505C]">No Data Available</p>
    {note && <p className="max-w-sm text-xs text-[#6B7B8C]">{note}</p>}
  </div>
);
