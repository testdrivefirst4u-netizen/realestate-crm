/**
 * LeadsView — the "All Leads" table.
 *
 * Search (core/analytics.searchLeads), config-driven filters, an Enquiry-Date
 * range filter, real-date sorting, pagination and CSV export. Trash /
 * Permanently Deleted rows are excluded through `countedLeads`.
 * Sorting goes through `sortLeads` (./sorting): same-day enquiries are ordered
 * by Created At, then Enquiry ID, so new ENQ rows never sink under older ones.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Plus, RotateCcw, Search, Users } from 'lucide-react';
import { CRMConfig, Lead, SyncState } from '../../types/crm';
import { DEFAULT_CUSTOMIZATION, F } from '../../core/config';
import { countedLeads, enquiryDate, followupCount, isActive, nextFollowupDate, searchLeads } from '../../core/analytics';
import { dateKey, formatDateTime, formatRelative, inRange } from '../../core/dates';
import { formatPhone } from '../../core/phone';
import { downloadText, toCsv } from '../../core/format';
import {
  Button,
  DataTable,
  DateFilterValue,
  DateRangeFilter,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  StageBadge,
  cx,
  resolveDateFilter,
} from '../../components/ui';
import { LeadStars } from './shared';
import { LeadSortKey, sortLeads } from './sorting';

export interface LeadsViewProps {
  leads: Lead[];
  config: CRMConfig;
  onOpenLead: (id: string) => void;
  activeFilterLabel?: string | null;
  onClearActiveFilter?: () => void;
  canExport: boolean;
  onOpenAddLead: () => void;
  sync: SyncState;
}

/** Keys the table headers sort by (text keys → numeric-aware A→Z; 'id' → by the number in the Enquiry ID). */
type SortKey = Extract<LeadSortKey, 'id' | 'name' | 'enquiryDate' | 'stage' | 'unit' | 'nextDue' | 'rm'>;
const DATE_SORT_KEYS: SortKey[] = ['enquiryDate', 'nextDue'];
const PAGE_SIZE = 50;

const EXPORT_HEADERS: string[] = [
  F.ID,
  F.ENQUIRY_DATE,
  F.NAME,
  F.PHONE,
  F.EMAIL,
  F.STAGE,
  F.SOURCE,
  F.UNIT_TYPE,
  F.PURCHASE_OR_RENT,
  F.SITE_VISIT_STATUS,
  F.SITE_VISIT_DATE,
  F.BOOKING_DATE,
  F.NEXT_FOLLOWUP,
  F.LAST_FOLLOWUP,
  F.RM,
  F.BROCHURE,
  F.RELATIONSHIP,
  F.ENQUIRED_FOR,
  F.NOTES,
  'Follow-ups',
];
const EXPORT_DATE_FIELDS: string[] = [F.ENQUIRY_DATE, F.SITE_VISIT_DATE, F.BOOKING_DATE, F.NEXT_FOLLOWUP, F.LAST_FOLLOWUP];

export const LeadsView: React.FC<LeadsViewProps> = ({ leads, config, onOpenLead, activeFilterLabel, onClearActiveFilter, canExport, onOpenAddLead, sync }) => {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [unit, setUnit] = useState('');
  const [rm, setRm] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ preset: 'all' });
  const [sortKey, setSortKey] = useState<SortKey>('enquiryDate');
  const [sortAsc, setSortAsc] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const range = useMemo(() => resolveDateFilter(dateFilter), [dateFilter]);
  const base = useMemo(() => countedLeads(leads), [leads]);

  const rmOptions = useMemo(() => {
    const set = new Set<string>(config.options[F.RM] || []);
    for (const l of base) {
      const v = String(l[F.RM] || '').trim();
      if (v) set.add(v);
    }
    return [...set];
  }, [config.options, base]);

  const filtered = useMemo(() => {
    const q = query.trim();
    let list = q ? searchLeads(base, q, base.length) : base;
    if (stage) list = list.filter((l) => String(l[F.STAGE] || '').trim() === stage);
    if (source) list = list.filter((l) => String(l[F.SOURCE] || '').trim() === source);
    if (unit) list = list.filter((l) => String(l[F.UNIT_TYPE] || '').trim() === unit);
    if (rm) list = list.filter((l) => String(l[F.RM] || '').trim() === rm);
    if (range) list = list.filter((l) => inRange(enquiryDate(l), range));
    return list;
  }, [base, query, stage, source, unit, rm, range]);

  const sorted = useMemo(() => sortLeads(filtered, sortKey, sortAsc), [filtered, sortKey, sortAsc]);

  // Reset pagination whenever the result set changes shape.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query, stage, source, unit, rm, range, sortKey, sortAsc]);

  const visible = useMemo(() => sorted.slice(0, limit), [sorted, limit]);
  const hasFilters = !!(query.trim() || stage || source || unit || rm || dateFilter.preset !== 'all');

  const clearFilters = () => {
    setQuery('');
    setStage('');
    setSource('');
    setUnit('');
    setRm('');
    setDateFilter({ preset: 'all' });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(!DATE_SORT_KEYS.includes(key)); // dates default newest first, text A→Z
    }
  };

  const indicator = (key: SortKey) =>
    sortKey === key ? sortAsc ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : <ArrowUpDown size={11} className="opacity-40" />;

  const exportCsv = () => {
    if (!sorted.length) return;
    const rows = sorted.map((l) => {
      const row: Record<string, unknown> = {};
      for (const h of EXPORT_HEADERS) {
        if (h === 'Follow-ups') row[h] = followupCount(l);
        else if (h === F.ENQUIRY_DATE) row[h] = formatDateTime(enquiryDate(l));
        else if (EXPORT_DATE_FIELDS.includes(h)) row[h] = formatDateTime(l[h]);
        else row[h] = l[h] ?? '';
      }
      return row;
    });
    downloadText(`Leads_${dateKey(new Date())}.csv`, toCsv(EXPORT_HEADERS, rows));
  };

  /* ------------------------------- states -------------------------------- */

  if (leads.length === 0 && (sync.status === 'loading' || (!sync.hasLoadedOnce && sync.status === 'syncing'))) {
    return <LoadingState label="Loading enquiries…" />;
  }

  const filterBanner = activeFilterLabel ? (
    <div className="p-3 bg-[#A9825A]/15 border border-[#A9825A]/40 rounded-xl flex items-center justify-between gap-3 text-xs text-[#1D2F3F]">
      <span className="font-semibold truncate">
        Filtered view: <span className="font-bold">{activeFilterLabel}</span>
        <span className="text-[#6B5F57] font-normal"> · {base.length} {base.length === 1 ? 'enquiry' : 'enquiries'}</span>
      </span>
      {onClearActiveFilter && (
        <Button variant="primary" size="xs" onClick={onClearActiveFilter} icon={<RotateCcw size={11} />}>
          Show all leads
        </Button>
      )}
    </div>
  ) : null;

  if (base.length === 0) {
    const offline = sync.status === 'error' || sync.status === 'offline';
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
        {filterBanner}
        {offline && leads.length === 0 && (
          <ErrorState compact title={sync.status === 'offline' ? 'You are offline' : 'Last sync failed'} message={sync.lastError || 'Showing the last known data.'} />
        )}
        <div className="bg-white rounded-2xl border border-[#D2C9BF] shadow-xs">
          <EmptyState
            icon={<Users size={22} />}
            title={activeFilterLabel ? 'No enquiries match this filter' : 'No enquiries yet'}
            description={
              activeFilterLabel
                ? 'The selected dashboard metric has no leads behind it right now. Clear the filter to see every enquiry.'
                : 'The Enquiry Log is empty. Record the first prospect with “New Enquiry” — it is saved to the CRM instantly.'
            }
            action={
              activeFilterLabel && onClearActiveFilter ? (
                <Button variant="secondary" onClick={onClearActiveFilter} icon={<RotateCcw size={13} />}>
                  Show all leads
                </Button>
              ) : (
                <Button variant="primary" onClick={onOpenAddLead} icon={<Plus size={14} />}>
                  New Enquiry
                </Button>
              )
            }
          />
        </div>
      </div>
    );
  }

  /* -------------------------------- table -------------------------------- */

  const now = Date.now();
  const columns = [
    {
      key: 'id',
      label: 'ID',
      onSort: () => toggleSort('id'),
      sortIndicator: indicator('id'),
      render: (l: Lead) => <span className="font-semibold text-[#A9825A] whitespace-nowrap">{l[F.ID]}</span>,
    },
    {
      key: 'name',
      label: 'Prospect',
      onSort: () => toggleSort('name'),
      sortIndicator: indicator('name'),
      className: 'min-w-[180px]',
      render: (l: Lead) => (
        <div className="min-w-0">
          <div className="font-semibold text-[#1D2F3F]">{l[F.NAME] || <span className="text-[#9E948D] font-normal">Unnamed</span>}</div>
          <div className="text-[10px] text-[#9E948D] mt-0.5 truncate max-w-[220px]">
            {[l[F.SOURCE], l[F.EMAIL]].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      ),
    },
    {
      key: 'enquiryDate',
      label: 'Enquiry Date',
      onSort: () => toggleSort('enquiryDate'),
      sortIndicator: indicator('enquiryDate'),
      render: (l: Lead) => <span className="whitespace-nowrap text-[#3D3530]">{formatDateTime(enquiryDate(l), '—')}</span>,
    },
    {
      key: 'contact',
      label: 'Contact',
      render: (l: Lead) => <span className="whitespace-nowrap">{formatPhone(l[F.PHONE]) || <span className="text-[#9E948D]">No phone</span>}</span>,
    },
    {
      key: 'stage',
      label: 'Stage',
      onSort: () => toggleSort('stage'),
      sortIndicator: indicator('stage'),
      render: (l: Lead) => <StageBadge stage={String(l[F.STAGE] || '')} />,
    },
    {
      key: 'unit',
      label: 'Unit',
      onSort: () => toggleSort('unit'),
      sortIndicator: indicator('unit'),
      render: (l: Lead) => <span className="font-medium text-[#1D2F3F] whitespace-nowrap">{l[F.UNIT_TYPE] || '—'}</span>,
    },
    {
      key: 'siteVisit',
      label: 'Site Visit',
      render: (l: Lead) => (
        <div className="text-[11px] text-[#6B5F57]">
          <div>{l[F.SITE_VISIT_STATUS] || '—'}</div>
          {l[F.SITE_VISIT_DATE] && <div className="text-[10px] text-[#9E948D]">{formatDateTime(l[F.SITE_VISIT_DATE])}</div>}
        </div>
      ),
    },
    {
      key: 'nextDue',
      label: 'Next Due',
      onSort: () => toggleSort('nextDue'),
      sortIndicator: indicator('nextDue'),
      render: (l: Lead) => {
        const d = nextFollowupDate(l);
        if (!d) return <span className="text-[#9E948D]">Unscheduled</span>;
        const overdue = d.getTime() < now && isActive(l);
        return <span className={cx('whitespace-nowrap font-medium', overdue ? 'text-[#B06A55] font-bold' : 'text-[#A9825A]')}>{formatRelative(d)}</span>;
      },
    },
    {
      key: 'rm',
      label: 'RM',
      onSort: () => toggleSort('rm'),
      sortIndicator: indicator('rm'),
      render: (l: Lead) => <span className="text-[#6B5F57] whitespace-nowrap">{l[F.RM] || '—'}</span>,
    },
    {
      key: 'score',
      label: 'Score',
      align: 'center' as const,
      render: (l: Lead) => <LeadStars lead={l} />,
    },
    {
      key: 'followups',
      label: 'Follow-ups',
      align: 'center' as const,
      render: (l: Lead) => {
        const n = followupCount(l);
        return <span className={cx('font-mono text-xs', n ? 'text-[#1D2F3F] font-semibold' : 'text-[#9E948D]')}>{n}</span>;
      },
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">{DEFAULT_CUSTOMIZATION.leadsViewTitle}</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">
            {base.length} {base.length === 1 ? 'enquiry' : 'enquiries'} · click a row to open the full record
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canExport && (
            <Button variant="gold" onClick={exportCsv} disabled={!sorted.length} icon={<Download size={13} />} title="Download the filtered list as CSV">
              Export CSV
            </Button>
          )}
          <Button variant="primary" onClick={onOpenAddLead} icon={<Plus size={14} />}>
            New Enquiry
          </Button>
        </div>
      </div>

      {filterBanner}

      {/* Toolbar */}
      <div className="bg-[#EDE8E0] p-3 rounded-xl border border-[#D2C9BF] shadow-2xs flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-2.5 text-[#9E948D]" />
          <input
            type="search"
            placeholder="Search name, phone, email, ID, notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full text-xs pl-8 pr-3 py-2 rounded-lg border border-[#B8AFA7] bg-white text-[#1D2F3F] focus:outline-none focus:border-[#A9825A]"
            aria-label="Search leads"
          />
        </div>
        <Select value={stage} onChange={(e) => setStage(e.target.value)} options={config.options[F.STAGE] || []} placeholder="All Stages" className="!w-auto" aria-label="Stage" />
        <Select value={source} onChange={(e) => setSource(e.target.value)} options={config.options[F.SOURCE] || []} placeholder="All Sources" className="!w-auto" aria-label="Source" />
        <Select value={unit} onChange={(e) => setUnit(e.target.value)} options={config.options[F.UNIT_TYPE] || []} placeholder="All Units" className="!w-auto" aria-label="Unit type" />
        <Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" aria-label="Relationship manager" />
        <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
        <Button
          variant="secondary"
          onClick={() => toggleSort('enquiryDate')}
          icon={<ArrowUpDown size={12} />}
          title="Sort by enquiry date"
          className={sortKey !== 'enquiryDate' ? 'opacity-70' : ''}
        >
          {sortKey === 'enquiryDate' && sortAsc ? 'Oldest → Newest' : 'Newest → Oldest'}
        </Button>
        {hasFilters && (
          <Button variant="ghost" onClick={clearFilters} icon={<RotateCcw size={12} />} title="Clear all filters">
            Clear
          </Button>
        )}
        <span className="ml-auto text-xs text-[#6B5F57] font-medium whitespace-nowrap">
          {sorted.length === base.length ? (
            <>
              <strong className="text-[#1D2F3F]">{sorted.length}</strong> {sorted.length === 1 ? 'lead' : 'leads'}
            </>
          ) : (
            <>
              <strong className="text-[#1D2F3F]">{sorted.length}</strong> of {base.length} leads
            </>
          )}
          {range && <span className="text-[#9E948D]"> · enquired {range.label.toLowerCase()}</span>}
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-[#D2C9BF] shadow-xs overflow-hidden">
        <DataTable<Lead>
          columns={columns}
          rows={visible}
          keyFn={(l) => String(l[F.ID])}
          onRowClick={(l) => onOpenLead(String(l[F.ID]))}
          empty={
            <div className="space-y-2">
              <div>No leads match the current filters.</div>
              {hasFilters && (
                <Button variant="secondary" size="xs" onClick={clearFilters} icon={<RotateCcw size={11} />}>
                  Clear filters
                </Button>
              )}
            </div>
          }
        />
        {sorted.length > visible.length && (
          <div className="p-3 border-t border-[#ECE8E1] bg-[#FDFCFA] flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-[#6B5F57]">
              Showing <strong className="text-[#1D2F3F]">{visible.length}</strong> of {sorted.length}
            </span>
            <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, sorted.length - visible.length)} more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
