/** Search Console › Performance, laid out as in Google's: filter chips, metric cards, the chart and the tables. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Filter, Plus, RefreshCw, X } from 'lucide-react';
import { api, type SearchFilter, type SearchPerformance, type SearchQuery, type SearchRow } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { downloadText, toCsv } from '../../core/format';
import { Button, InlineNotice, Modal, cx, inputCls } from '../../components/ui';
import { appearanceName, countryName, dayLabel, deviceName, fmt, fmtCard, full, GscChart, METRICS, metricOf, type MetricId } from './gscShared';

export const PRESETS = [{ id: 'last7', label: 'Last 7 days' }, { id: 'last28', label: 'Last 28 days' }, { id: 'last90', label: 'Last 3 months' }, { id: 'last180', label: 'Last 6 months' }, { id: 'last365', label: 'Last 12 months' }, { id: 'last480', label: 'Last 16 months' }];
const TYPES = [{ id: 'web', label: 'Web' }, { id: 'image', label: 'Image' }, { id: 'video', label: 'Video' }, { id: 'news', label: 'News' }];
const TABS = [{ id: 'queries', label: 'Queries', dim: 'query', head: 'Top queries' }, { id: 'pages', label: 'Pages', dim: 'page', head: 'Top pages' }, { id: 'countries', label: 'Countries', dim: 'country', head: 'Country' }, { id: 'devices', label: 'Devices', dim: 'device', head: 'Device' }, { id: 'appearance', label: 'Search appearance', dim: 'searchAppearance', head: 'Search appearance' }, { id: 'dates', label: 'Dates', dim: '', head: 'Date' }] as const;
type TabId = (typeof TABS)[number]['id'];
const DIMENSIONS = [{ id: 'query', label: 'Query' }, { id: 'page', label: 'Page' }, { id: 'country', label: 'Country' }, { id: 'device', label: 'Device' }, { id: 'searchAppearance', label: 'Search appearance' }];
const OPERATORS = [{ id: 'contains', label: 'Containing' }, { id: 'notContains', label: 'Not containing' }, { id: 'equals', label: 'Exact' }, { id: 'notEquals', label: 'Not exact' }, { id: 'includingRegex', label: 'Custom (regex)' }, { id: 'excludingRegex', label: "Doesn't match regex" }];
const nameFor = (dim: string, v: string) => (dim === 'country' ? countryName(v) : dim === 'device' ? deviceName(v) : dim === 'searchAppearance' ? appearanceName(v) : v);
const filterText = (f: SearchFilter) => `${DIMENSIONS.find((d) => d.id === f.dimension)?.label}: ${(OPERATORS.find((o) => o.id === f.operator)?.label || '').toLowerCase()} ${nameFor(f.dimension, f.expression)}`;
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const dateText = (q: SearchQuery) => (q.preset === 'custom' ? `${dayLabel(q.from || '', true)} to ${dayLabel(q.to || '', true)}` : PRESETS.find((p) => p.id === q.preset)?.label || 'Last 28 days');

const Chip: React.FC<{ children: React.ReactNode; onClick?: () => void; onRemove?: () => void; title?: string }> = ({ children, onClick, onRemove, title }) => (
  <span className="inline-flex max-w-full items-center rounded-full border border-[#DADCE0] bg-white text-xs text-[#3C4043]">
    <button type="button" title={title} onClick={onClick} className={cx('inline-flex min-h-8 min-w-0 items-center gap-1 rounded-full py-1 pl-3 hover:bg-[#F1F3F4]', onRemove ? 'pr-1' : 'pr-2')}><span className="truncate">{children}</span>{!onRemove && <ChevronDown size={14} className="flex-none" />}</button>
    {onRemove && <button type="button" aria-label="Remove filter" onClick={onRemove} className="mr-1 flex-none rounded-full p-1 hover:bg-[#F1F3F4]"><X size={13} /></button>}
  </span>
);

const DateDialog: React.FC<{ q: SearchQuery; onClose: () => void; onApply: (patch: SearchQuery) => void }> = ({ q, onClose, onApply }) => {
  const [mode, setMode] = useState<'filter' | 'compare'>('filter');
  const [preset, setPreset] = useState(q.preset || 'last28');
  const [from, setFrom] = useState(q.from || '');
  const [to, setTo] = useState(q.to || '');
  const [compare, setCompare] = useState<SearchQuery['compare']>(q.compare || '');
  const bad = preset === 'custom' && (!from || !to || from > to);
  const radio = (checked: boolean, label: string, onChange: () => void, key: string) => <label key={key} className="flex cursor-pointer items-center gap-2.5 py-1.5 text-[13px] text-[#202124]"><input type="radio" name={`gsc-${mode}`} className="h-4 w-4 accent-[#1A73E8]" checked={checked} onChange={onChange} />{label}</label>;
  return (
    <Modal open onClose={onClose} title="Date range" width="sm" footer={<div className="flex justify-end gap-2"><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" disabled={bad} onClick={() => onApply({ preset, compare, ...(preset === 'custom' ? { from, to } : { from: undefined, to: undefined }) })}>Apply</Button></div>}>
      <div role="tablist" className="mb-3 flex border-b border-[#E8EAED]">
        {(['filter', 'compare'] as const).map((m) => <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cx('-mb-px flex-1 border-b-2 py-2 text-[13px] font-medium capitalize', mode === m ? 'border-[#1A73E8] text-[#1967D2]' : 'border-transparent text-[#5F6368]')}>{m}</button>)}
      </div>
      {mode === 'filter' ? (
        <div>
          {PRESETS.map((p) => radio(preset === p.id, p.label, () => setPreset(p.id), p.id))}
          {radio(preset === 'custom', 'Custom', () => setPreset('custom'), 'custom')}
          {preset === 'custom' && <div className="mt-1 grid grid-cols-2 gap-2"><input type="date" className={inputCls} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Start date" /><input type="date" className={inputCls} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="End date" /></div>}
          <p className="mt-2 text-[11px] text-[#5F6368]">Dates end 2 days ago, because recent days are not final. Google keeps 16 months.</p>
        </div>
      ) : (
        <div>
          {radio(!compare, 'No comparison', () => setCompare(''), 'none')}
          {radio(compare === 'previous', 'Compare to the previous period', () => setCompare('previous'), 'previous')}
          {radio(compare === 'year', 'Compare year over year', () => setCompare('year'), 'year')}
        </div>
      )}
    </Modal>
  );
};

const TypeDialog: React.FC<{ type: string; onClose: () => void; onApply: (type: string) => void }> = ({ type, onClose, onApply }) => {
  const [v, setV] = useState(type);
  return (
    <Modal open onClose={onClose} title="Search type" width="sm" footer={<div className="flex justify-end gap-2"><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={() => onApply(v)}>Apply</Button></div>}>
      {TYPES.map((t) => <label key={t.id} className="flex cursor-pointer items-center gap-2.5 py-1.5 text-[13px] text-[#202124]"><input type="radio" name="gsc-type" className="h-4 w-4 accent-[#1A73E8]" checked={v === t.id} onChange={() => setV(t.id)} />{t.label}</label>)}
    </Modal>
  );
};

const FilterDialog: React.FC<{ data: SearchPerformance | null; onClose: () => void; onApply: (f: SearchFilter) => void }> = ({ data, onClose, onApply }) => {
  const [dimension, setDimension] = useState('query');
  const [operator, setOperator] = useState('contains');
  const [expression, setExpression] = useState('');
  const choices = dimension === 'device' ? ['DESKTOP', 'MOBILE', 'TABLET'] : dimension === 'country' ? (data?.countries || []).map((r) => r.name) : dimension === 'searchAppearance' ? (data?.appearance || []).map((r) => r.name) : null;
  const fixed = choices !== null;
  const ops = fixed ? OPERATORS.filter((o) => o.id === 'equals' || o.id === 'notEquals') : OPERATORS;
  const pickDimension = (d: string) => {
    setDimension(d);
    setExpression('');
    if (d !== 'query' && d !== 'page') setOperator('equals');
  };
  return (
    <Modal open onClose={onClose} title="Add filter" width="sm" footer={<div className="flex justify-end gap-2"><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" disabled={!expression.trim()} onClick={() => onApply({ dimension, operator, expression: expression.trim() })}>Apply</Button></div>}>
      <div className="space-y-3">
        <label className="block text-xs text-[#5F6368]">Filter by<select className={cx(inputCls, 'mt-1')} value={dimension} onChange={(e) => pickDimension(e.target.value)}>{DIMENSIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
        <label className="block text-xs text-[#5F6368]">Match<select className={cx(inputCls, 'mt-1')} value={operator} onChange={(e) => setOperator(e.target.value)}>{ops.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
        {fixed ? (
          <label className="block text-xs text-[#5F6368]">Value<select className={cx(inputCls, 'mt-1')} value={expression} onChange={(e) => setExpression(e.target.value)}><option value="">{choices!.length ? 'Choose…' : 'Nothing in these dates'}</option>{choices!.map((c) => <option key={c} value={c}>{nameFor(dimension, c)}</option>)}</select></label>
        ) : (
          <label className="block text-xs text-[#5F6368]">{dimension === 'page' ? 'Address' : 'Search words'}<input className={cx(inputCls, 'mt-1')} value={expression} maxLength={1000} onChange={(e) => setExpression(e.target.value)} /></label>
        )}
      </div>
    </Modal>
  );
};

interface TableRow { key: string; label: string; values: Record<string, number>; prev?: Record<string, number>; onClick: () => void }

const DataTable: React.FC<{ rows: TableRow[]; head: string; selected: MetricId[]; compare: boolean; nameDesc?: boolean; onExport: (rows: TableRow[]) => void }> = ({ rows, head, selected, compare, nameDesc, onExport }) => {
  const [sort, setSort] = useState<{ id: string; desc: boolean }>(nameDesc ? { id: 'name', desc: true } : { id: selected[0], desc: selected[0] !== 'position' });
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows, search, sort, perPage]);
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = rows.filter((r) => !term || r.label.toLowerCase().includes(term));
    return list.sort((a, b) => (sort.id === 'name' ? a.key.localeCompare(b.key) : (a.values[sort.id] || 0) - (b.values[sort.id] || 0)) * (sort.desc ? -1 : 1));
  }, [rows, search, sort]);
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const at = Math.min(page, pages - 1);
  const visible = shown.slice(at * perPage, (at + 1) * perPage);
  const sortable = (id: string, text: string, alignLeft = false) => (
    <button type="button" className={cx('inline-flex items-center gap-1 hover:text-[#1A73E8]', alignLeft ? '' : 'flex-row-reverse')} onClick={() => setSort((s) => (s.id === id ? { id, desc: !s.desc } : { id, desc: id !== 'name' }))}>{sort.id === id && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}{text}</button>
  );
  const ariaSort = (id: string) => (sort.id === id ? (sort.desc ? 'descending' as const : 'ascending' as const) : undefined);
  const difference = (id: string, r: TableRow) => {
    if (!r.prev) return '—';
    const d = (r.values[id] || 0) - (r.prev[id] || 0);
    return `${d > 0 ? '+' : ''}${fmt(id, d)}`;
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-1 border-b border-[#E8EAED] px-2 py-1.5">
        {searching && <input autoFocus className={cx(inputCls, 'mr-auto max-w-xs py-1.5')} placeholder={`Filter ${head.toLowerCase()}`} aria-label={`Filter ${head}`} value={search} onChange={(e) => setSearch(e.target.value)} />}
        <button type="button" aria-label="Filter rows" aria-pressed={searching} onClick={() => { setSearching((v) => !v); setSearch(''); }} className={cx('rounded-full p-2 hover:bg-[#F1F3F4]', searching ? 'text-[#1A73E8]' : 'text-[#5F6368]')}><Filter size={16} /></button>
        <button type="button" aria-label="Download this table" title="Download this table" onClick={() => onExport(shown)} className="rounded-full p-2 text-[#5F6368] hover:bg-[#F1F3F4]"><Download size={16} /></button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[#E8EAED] text-[11.5px] text-[#5F6368]">
              <th scope="col" className="px-4 py-2.5 text-left font-medium" aria-sort={ariaSort('name')}>{sortable('name', head, true)}</th>
              {selected.map((id) => (
                <React.Fragment key={id}>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right font-medium" aria-sort={ariaSort(id)}>{sortable(id, metricOf(id).short)}</th>
                  {compare && <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Earlier</th>}
                  {compare && <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Difference</th>}
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1F3F4]">
            {!visible.length ? <tr><td colSpan={1 + selected.length * (compare ? 3 : 1)} className="p-8 text-center text-[13px] text-[#5F6368]">No data</td></tr> : visible.map((r) => (
              <tr key={r.key} className="text-[13px] text-[#202124] hover:bg-[#F8F9FA]">
                <td className="max-w-[260px] px-4 py-2.5 sm:max-w-[480px]"><button type="button" title={`Filter by ${r.label}`} onClick={r.onClick} className="block max-w-full truncate text-left hover:text-[#1967D2] hover:underline">{r.label || '(not set)'}</button></td>
                {selected.map((id) => (
                  <React.Fragment key={id}>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{fmt(id, r.values[id] || 0)}</td>
                    {compare && <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-[#5F6368]">{r.prev ? fmt(id, r.prev[id] || 0) : '—'}</td>}
                    {compare && <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-[#5F6368]">{difference(id, r)}</td>}
                  </React.Fragment>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 px-3 py-2 text-xs text-[#5F6368]">
        <label className="inline-flex items-center gap-2">Rows per page<select className="rounded border border-[#DADCE0] bg-white px-1.5 py-1 text-[#202124]" value={perPage} onChange={(e) => setPerPage(Number(e.target.value))}>{[10, 25, 50, 100, 250, 500].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <span className="tabular-nums">{shown.length ? `${at * perPage + 1}-${Math.min(shown.length, (at + 1) * perPage)} of ${full(shown.length)}` : '0 of 0'}</span>
        <span className="inline-flex">
          <button type="button" aria-label="Previous page" disabled={at === 0} onClick={() => setPage(at - 1)} className="rounded-full p-2 hover:bg-[#F1F3F4] disabled:opacity-30"><ChevronLeft size={16} /></button>
          <button type="button" aria-label="Next page" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} className="rounded-full p-2 hover:bg-[#F1F3F4] disabled:opacity-30"><ChevronRight size={16} /></button>
        </span>
      </div>
    </>
  );
};

/** Cells are search words typed by strangers: a spreadsheet must not read them as formulas. */
const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export const PerformancePage: React.FC<{ query: SearchQuery; onQuery: (q: SearchQuery) => void; settingsLink: React.ReactNode }> = ({ query, onQuery, settingsLink }) => {
  const [data, setData] = useState<SearchPerformance | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const [selected, setSelected] = useState<MetricId[]>(['clicks', 'impressions']);
  const [tab, setTab] = useState<TabId>('queries');
  const [dialog, setDialog] = useState<'' | 'date' | 'type' | 'filter'>('');
  const latest = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.searchConsole.performance({ ...query, refresh });
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('gsc.performance', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => void load(), [load]);

  const filters = query.filters || [];
  const comparing = !!query.compare && !!data?.prevTables;
  const addFilter = (f: SearchFilter) => onQuery({ ...query, filters: [...filters.filter((x) => x.dimension !== f.dimension), f] });
  const toggle = (id: MetricId) => setSelected((s) => (s.includes(id) ? (s.length > 1 ? s.filter((x) => x !== id) : s) : METRICS.map((m) => m.id).filter((m) => s.includes(m) || m === id)));

  const rows = useMemo<TableRow[]>(() => {
    if (!data) return [];
    if (tab === 'dates') {
      return data.daily.map((d) => ({ key: d.day, label: dayLabel(d.day, true), values: d.values, prev: comparing && d.prev ? d.prev : undefined, onClick: () => onQuery({ ...query, preset: 'custom', from: d.day, to: d.day }) }));
    }
    const def = TABS.find((t) => t.id === tab)!;
    const before = new Map((comparing ? data.prevTables![tab] : []).map((r: SearchRow) => [r.name, r]));
    return data[tab].map((r) => {
      const p = before.get(r.name);
      return { key: r.name, label: nameFor(def.dim, r.name), values: r as unknown as Record<string, number>, prev: p ? p as unknown as Record<string, number> : undefined, onClick: () => addFilter({ dimension: def.dim, operator: 'equals', expression: r.name }) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tab, comparing, query]);

  const exportRows = (list: TableRow[]) => {
    if (!data) return;
    const def = TABS.find((t) => t.id === tab)!;
    const headers = [def.head, ...selected.flatMap((id) => (comparing ? [metricOf(id).short, `${metricOf(id).short} (earlier)`] : [metricOf(id).short]))];
    const csv = toCsv(headers, list.map((r) => {
      const out: Record<string, unknown> = { [def.head]: safeCell(r.label) };
      for (const id of selected) {
        out[metricOf(id).short] = fmt(id, r.values[id] || 0);
        if (comparing) out[`${metricOf(id).short} (earlier)`] = r.prev ? fmt(id, r.prev[id] || 0) : '';
      }
      return out;
    }));
    downloadText(`search-console-${def.id}-${data.from}-to-${data.to}.csv`, csv);
  };

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-normal text-[#202124]">Performance on Search results</h1>
        {data?.fetchedAt && <span className="text-[11px] text-[#5F6368]">Fetched {new Date(data.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load(true)}>Refresh</Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Chip onClick={() => setDialog('type')}>Search type: {TYPES.find((t) => t.id === (query.type || 'web'))?.label}</Chip>
        <Chip onClick={() => setDialog('date')}>Date: {dateText(query)}{query.compare ? (query.compare === 'year' ? ', year over year' : ', vs previous') : ''}</Chip>
        {filters.map((f) => <Chip key={f.dimension} title={filterText(f)} onClick={() => setDialog('filter')} onRemove={() => onQuery({ ...query, filters: filters.filter((x) => x !== f) })}>{filterText(f)}</Chip>)}
        <button type="button" onClick={() => setDialog('filter')} className="inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-[#1967D2] hover:bg-[#E8F0FE]"><Plus size={14} /> Add filter</button>
      </div>

      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {data?.error && <InlineNotice tone="warning">{data.error} {settingsLink}</InlineNotice>}
      {!data && !failed && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}

      {data && !data.error && data.totals && (
        <>
          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-t-lg lg:grid-cols-4">
              {METRICS.map((m) => {
                const on = selected.includes(m.id);
                const v = data.totals![m.id];
                return (
                  <button key={m.id} type="button" aria-pressed={on} onClick={() => toggle(m.id)} className={cx('min-h-[88px] p-3 text-left transition-colors', on ? 'text-white' : 'bg-white text-[#5F6368] hover:bg-[#F8F9FA]')} style={on ? { background: m.color } : undefined}>
                    <span className="flex items-center gap-1.5 text-xs"><span className={cx('flex h-3.5 w-3.5 flex-none items-center justify-center rounded-sm border', on ? 'border-white bg-white' : 'border-[#9AA0A6]')}>{on && <Check size={11} strokeWidth={3} style={{ color: m.color }} />}</span><span className="truncate">{m.label}</span></span>
                    <span className="mt-1.5 block text-[26px] font-normal leading-tight">{fmtCard(m.id, v)}</span>
                    {comparing && data.prevTotals && <span className={cx('block text-[11px]', on ? 'text-white/90' : 'text-[#5F6368]')}>Earlier: {fmtCard(m.id, data.prevTotals[m.id])}</span>}
                  </button>
                );
              })}
            </div>
            <div className="p-3">
              <GscChart days={data.daily} selected={selected} compare={comparing} />
              {comparing && <p className="px-1 text-[11px] text-[#5F6368]">Solid line: {dayLabel(data.from)} to {dayLabel(data.to)}. Dashed line: {dayLabel(data.prevFrom)} to {dayLabel(data.prevTo)}.</p>}
            </div>
          </section>

          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <div role="tablist" aria-label="Table" className="flex overflow-x-auto border-b border-[#E8EAED]">
              {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx('-mb-px flex-none border-b-2 px-4 py-3 text-[13px] font-medium', tab === t.id ? 'border-[#1A73E8] text-[#1967D2]' : 'border-transparent text-[#5F6368] hover:bg-[#F8F9FA]')}>{t.label}</button>)}
            </div>
            <DataTable key={tab} rows={rows} head={TABS.find((t) => t.id === tab)!.head} selected={selected} compare={comparing} nameDesc={tab === 'dates'} onExport={exportRows} />
          </section>
          <p className="text-[10.5px] text-[#80868B]">From Google Search Console, up to {dayLabel(data.to, true)}. Recent days are not final, and Google hides some rare searches for privacy, so rows can add up to less than the total.</p>
        </>
      )}

      {dialog === 'date' && <DateDialog q={query} onClose={() => setDialog('')} onApply={(p) => { onQuery({ ...query, ...p }); setDialog(''); }} />}
      {dialog === 'type' && <TypeDialog type={query.type || 'web'} onClose={() => setDialog('')} onApply={(type) => { onQuery({ ...query, type }); setDialog(''); }} />}
      {dialog === 'filter' && <FilterDialog data={data} onClose={() => setDialog('')} onApply={(f) => { addFilter(f); setDialog(''); }} />}
    </div>
  );
};
