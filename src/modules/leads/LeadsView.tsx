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
import { ArrowDown, ArrowUp, ArrowUpDown, Download, GitMerge, MessageCircle, Phone, Plus, RotateCcw, Search, SlidersHorizontal, Upload, Users } from 'lucide-react';
import { CRMConfig, Lead, SyncState } from '../../types/crm';
import { DEFAULT_CUSTOMIZATION, F } from '../../core/config';
import { countedLeads, enquiryDate, followupCount, followupEntries, isActive, nextFollowupDate, searchLeads } from '../../core/analytics';
import { formatDateTime, formatRelative, inRange } from '../../core/dates';
import { formatPhone, telLink, whatsappLink } from '../../core/phone';
import { CallButton } from '../calls/CallButton';
import { exportLeadsToXlsx } from '../../services/csvService';
import {
  Button,
  DataTable,
  DateFilterValue,
  DateRangeFilter,
  EmptyState,
  ErrorState,
  Select,
  StageBadge,
  cx,
  resolveDateFilter,
} from '../../components/ui';
import { LeadStars } from './shared';
import { SourceLogo } from './SourceLogo';
import { LeadSortKey, sortLeads } from './sorting';
import { PageSkeleton } from '../../components/Skeletons';
import { DuplicatesModal, findDuplicateGroups } from './DuplicatesModal';

export interface LeadsViewProps {
  leads: Lead[];
  config: CRMConfig;
  onOpenLead: (id: string) => void;
  activeFilterLabel?: string | null;
  onClearActiveFilter?: () => void;
  canExport: boolean;
  /** New enquiry; undefined hides the button (role cannot create leads, e.g. View only). */
  onOpenAddLead?: () => void;
  /** Opens the bulk upload (Excel / CSV import); undefined when the role cannot import. */
  onOpenImport?: () => void;
  /** Merges duplicate leads; undefined when the role cannot delete leads. */
  onMergeLeads?: (keepId: string, mergeIds: string[]) => Promise<boolean>;
  sync: SyncState;
}

/** Keys the table headers sort by (text keys → numeric-aware A→Z; 'id' → by the number in the Enquiry ID). */
type SortKey = Extract<LeadSortKey, 'id' | 'name' | 'enquiryDate' | 'stage' | 'unit' | 'nextDue' | 'rm'>;
const DATE_SORT_KEYS: SortKey[] = ['enquiryDate', 'nextDue'];
const PAGE_SIZE = 50;

export const LeadsView: React.FC<LeadsViewProps> = ({ leads, config, onOpenLead, activeFilterLabel, onClearActiveFilter, canExport, onOpenAddLead, onOpenImport, onMergeLeads, sync }) => {
  const [dupOpen, setDupOpen] = useState(false);
  const dupCount = useMemo(() => (onMergeLeads ? findDuplicateGroups(leads).length : 0), [leads, onMergeLeads]);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [unit, setUnit] = useState('');
  const [rm, setRm] = useState('');
  const [campaign, setCampaign] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ preset: 'all' });
  const [sortKey, setSortKey] = useState<SortKey>('enquiryDate');
  const [sortAsc, setSortAsc] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [filtersOpen, setFiltersOpen] = useState(false);

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

  const campaignOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of base) {
      const v = String(l[F.CAMPAIGN] || '').trim();
      if (v) set.add(v);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [base]);

  const filtered = useMemo(() => {
    const q = query.trim();
    let list = q ? searchLeads(base, q, base.length) : base;
    if (stage) list = list.filter((l) => String(l[F.STAGE] || '').trim() === stage);
    if (source) list = list.filter((l) => String(l[F.SOURCE] || '').trim() === source);
    if (unit) list = list.filter((l) => String(l[F.UNIT_TYPE] || '').trim() === unit);
    if (rm) list = list.filter((l) => String(l[F.RM] || '').trim() === rm);
    if (campaign) list = list.filter((l) => String(l[F.CAMPAIGN] || '').trim() === campaign);
    if (range) list = list.filter((l) => inRange(enquiryDate(l), range));
    return list;
  }, [base, query, stage, source, unit, rm, campaign, range]);

  const sorted = useMemo(() => sortLeads(filtered, sortKey, sortAsc), [filtered, sortKey, sortAsc]);

  // Reset pagination whenever the result set changes shape.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query, stage, source, unit, rm, campaign, range, sortKey, sortAsc]);

  const visible = useMemo(() => sorted.slice(0, limit), [sorted, limit]);
  const hasFilters = !!(query.trim() || stage || source || unit || rm || campaign || dateFilter.preset !== 'all');
  const moreFilters = [source, unit, rm, campaign].filter(Boolean).length + (dateFilter.preset !== 'all' ? 1 : 0);
  // quick stage chips on phones (the stages this company actually uses)
  const quickStages = useMemo(() => ['New', 'Hot', 'Warm', 'Qualified', 'Booked'].filter((x) => (config.options[F.STAGE] || []).includes(x)), [config.options]);

  const clearFilters = () => {
    setQuery('');
    setStage('');
    setSource('');
    setUnit('');
    setRm('');
    setCampaign('');
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

  // every column of the filtered list (CRM + extra columns + each remark with its date), as a real Excel file
  const exportExcel = () => {
    exportLeadsToXlsx(sorted);
  };

  /* ------------------------------- states -------------------------------- */

  if (leads.length === 0 && (sync.status === 'loading' || (!sync.hasLoadedOnce && sync.status === 'syncing'))) {
    return <PageSkeleton variant="table" label="Loading enquiries…" />;
  }

  const filterBanner = activeFilterLabel ? (
    <div className="p-3 bg-[#0B6BB0]/15 border border-[#0B6BB0]/40 rounded-xl flex items-center justify-between gap-3 text-xs text-[#0B2A44]">
      <span className="font-semibold truncate">
        Filtered view: <span className="font-bold">{activeFilterLabel}</span>
        <span className="text-[#5E778C] font-normal"> · {base.length} {base.length === 1 ? 'enquiry' : 'enquiries'}</span>
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
        <div className="bg-white rounded-2xl border border-[#D3E3F0] shadow-xs">
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
                <div className="flex flex-wrap justify-center gap-2">
                  {onOpenImport && (
                    <Button variant="secondary" onClick={onOpenImport} icon={<Upload size={14} />}>
                      Bulk upload
                    </Button>
                  )}
                  {onOpenAddLead && (
                    <Button variant="primary" onClick={onOpenAddLead} icon={<Plus size={14} />}>
                      New Enquiry
                    </Button>
                  )}
                </div>
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
      render: (l: Lead) => <span className="font-semibold text-[#0B6BB0] whitespace-nowrap">{l[F.ID]}</span>,
    },
    {
      key: 'name',
      label: 'Prospect',
      onSort: () => toggleSort('name'),
      sortIndicator: indicator('name'),
      className: 'min-w-[180px]',
      render: (l: Lead) => (
        <div className="min-w-0">
          <div className="font-semibold text-[#0B2A44]">{l[F.NAME] || <span className="text-[#7E93A6] font-normal">Unnamed</span>}</div>
          <div className="text-[10px] text-[#7E93A6] mt-0.5 truncate max-w-[220px]">
            {l[F.EMAIL] || '—'}
          </div>
        </div>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      render: (l: Lead) => <SourceLogo source={l[F.SOURCE]} />,
    },
    {
      key: 'campaign',
      label: 'Campaign',
      className: 'min-w-[160px]',
      render: (l: Lead) =>
        l[F.CAMPAIGN] || l[F.AD_NAME] ? (
          <div className="min-w-0 max-w-[220px]">
            <div className="font-medium text-[#0B2A44] truncate" title={String(l[F.CAMPAIGN] || '')}>{l[F.CAMPAIGN] || '—'}</div>
            <div className="text-[10px] text-[#7E93A6] mt-0.5 truncate" title={[l[F.AD_SET], l[F.AD_NAME], l[F.LEAD_FORM]].filter(Boolean).join(' · ')}>
              {[l[F.AD_SET], l[F.AD_NAME]].filter(Boolean).join(' · ') || l[F.LEAD_FORM] || ''}
            </div>
          </div>
        ) : (
          <span className="text-[#7E93A6]">—</span>
        ),
    },
    {
      key: 'enquiryDate',
      label: 'Enquiry Date',
      onSort: () => toggleSort('enquiryDate'),
      sortIndicator: indicator('enquiryDate'),
      render: (l: Lead) => <span className="whitespace-nowrap text-[#0F2233]">{formatDateTime(enquiryDate(l), '—')}</span>,
    },
    {
      key: 'contact',
      label: 'Contact',
      render: (l: Lead) => <span className="whitespace-nowrap">{formatPhone(l[F.PHONE]) || <span className="text-[#7E93A6]">No phone</span>}</span>,
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
      render: (l: Lead) => <span className="font-medium text-[#0B2A44] whitespace-nowrap">{l[F.UNIT_TYPE] || '—'}</span>,
    },
    {
      key: 'siteVisit',
      label: 'Site Visit',
      render: (l: Lead) => (
        <div className="text-[11px] text-[#5E778C]">
          <div>{l[F.SITE_VISIT_STATUS] || '—'}</div>
          {l[F.SITE_VISIT_DATE] && <div className="text-[10px] text-[#7E93A6]">{formatDateTime(l[F.SITE_VISIT_DATE])}</div>}
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
        if (!d) return <span className="text-[#7E93A6]">Unscheduled</span>;
        const overdue = d.getTime() < now && isActive(l);
        return <span className={cx('whitespace-nowrap font-medium', overdue ? 'text-[#B06A55] font-bold' : 'text-[#0B6BB0]')}>{formatRelative(d)}</span>;
      },
    },
    {
      key: 'rm',
      label: 'RM',
      onSort: () => toggleSort('rm'),
      sortIndicator: indicator('rm'),
      render: (l: Lead) => <span className="text-[#5E778C] whitespace-nowrap">{l[F.RM] || '—'}</span>,
    },
    {
      key: 'score',
      label: 'Score',
      align: 'center' as const,
      render: (l: Lead) => <LeadStars lead={l} />,
    },
    {
      key: 'lastRemark',
      label: 'Last Remark',
      className: 'min-w-[200px]',
      render: (l: Lead) => {
        const list = followupEntries(l);
        const last = list[list.length - 1];
        if (!last) return <span className="text-[#7E93A6]">—</span>;
        const all = list.map((e, i) => `Remark ${i + 1}${e.date ? ` (${formatDateTime(e.date)})` : ''}: ${e.text}`).join('\n');
        return (
          <div className="min-w-0 max-w-[260px]" title={all}>
            <div className="text-[10px] text-[#7E93A6] whitespace-nowrap">
              Remark {list.length}
              {last.date ? ` · ${formatDateTime(last.date)}` : ''}
            </div>
            <div className="text-[11px] text-[#0B2A44] truncate">{last.text || '—'}</div>
          </div>
        );
      },
    },
    {
      key: 'followups',
      label: 'Follow-ups',
      align: 'center' as const,
      render: (l: Lead) => {
        const n = followupCount(l);
        return <span className={cx('font-mono text-xs', n ? 'text-[#0B2A44] font-semibold' : 'text-[#7E93A6]')}>{n}</span>;
      },
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight">{DEFAULT_CUSTOMIZATION.leadsViewTitle}</h2>
          <p className="text-xs text-[#5E778C] mt-0.5">
            {base.length} {base.length === 1 ? 'enquiry' : 'enquiries'} · click a row to open the full record
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onMergeLeads && dupCount > 0 && (
            <Button variant="secondary" onClick={() => setDupOpen(true)} icon={<GitMerge size={13} />} title="People who appear more than once (same phone number) — review and merge">
              Duplicates ({dupCount})
            </Button>
          )}
          {onOpenImport && (
            <Button variant="secondary" onClick={onOpenImport} icon={<Upload size={13} />} title="Upload many leads at once from an Excel or CSV file">
              Bulk upload
            </Button>
          )}
          {canExport && (
            <Button variant="gold" onClick={exportExcel} disabled={!sorted.length} icon={<Download size={13} />} title="Download the filtered list as an Excel file with every column">
              Export Excel
            </Button>
          )}
          {onOpenAddLead && (
            <Button variant="primary" onClick={onOpenAddLead} icon={<Plus size={14} />}>
              New Enquiry
            </Button>
          )}
        </div>
      </div>

      {filterBanner}

      {onMergeLeads && dupOpen && (
        <DuplicatesModal open={dupOpen} onClose={() => setDupOpen(false)} leads={leads} onMerge={onMergeLeads} onOpenLead={(id) => { setDupOpen(false); onOpenLead(id); }} />
      )}

      {/* Toolbar */}
      <div className="bg-[#E6EFF6] p-3 rounded-xl border border-[#D3E3F0] shadow-2xs flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 md:max-w-sm">
          <Search size={14} className="absolute left-3 top-2.5 text-[#7E93A6]" />
          <input
            type="search"
            placeholder="Search name, phone, email, ID, notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full text-xs pl-8 pr-3 py-2 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44] focus:outline-none focus:border-[#0B6BB0]"
            aria-label="Search leads"
          />
        </div>
        <button type="button" onClick={() => setFiltersOpen((v) => !v)} aria-expanded={filtersOpen} className={cx('md:hidden inline-flex items-center gap-1.5 h-[34px] px-3 rounded-lg border text-xs font-semibold', filtersOpen || moreFilters ? 'bg-[#0A1F33] border-[#0A1F33] text-white' : 'bg-white border-[#A9BDCD] text-[#0B2A44]')}>
          <SlidersHorizontal size={13} />Filters{moreFilters ? ` (${moreFilters})` : ''}
        </button>
        <div className={cx(filtersOpen ? 'flex flex-wrap gap-2 w-full' : 'hidden', 'md:contents')}>
        <Select value={stage} onChange={(e) => setStage(e.target.value)} options={config.options[F.STAGE] || []} placeholder="All Stages" className="!w-auto" aria-label="Stage" />
        <Select value={source} onChange={(e) => setSource(e.target.value)} options={config.options[F.SOURCE] || []} placeholder="All Sources" className="!w-auto" aria-label="Source" />
        <Select value={unit} onChange={(e) => setUnit(e.target.value)} options={config.options[F.UNIT_TYPE] || []} placeholder="All Units" className="!w-auto" aria-label="Unit type" />
        <Select value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" aria-label="Relationship manager" />
        {campaignOptions.length > 0 && (
          <Select value={campaign} onChange={(e) => setCampaign(e.target.value)} options={campaignOptions} placeholder="All Campaigns" className="!w-auto" aria-label="Campaign" />
        )}
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
        </div>
        {hasFilters && (
          <Button variant="ghost" onClick={clearFilters} icon={<RotateCcw size={12} />} title="Clear all filters">
            Clear
          </Button>
        )}
        <span className="hidden md:inline ml-auto text-xs text-[#5E778C] font-medium whitespace-nowrap">
          {sorted.length === base.length ? (
            <>
              <strong className="text-[#0B2A44]">{sorted.length}</strong> {sorted.length === 1 ? 'lead' : 'leads'}
            </>
          ) : (
            <>
              <strong className="text-[#0B2A44]">{sorted.length}</strong> of {base.length} leads
            </>
          )}
          {range && <span className="text-[#7E93A6]"> · enquired {range.label.toLowerCase()}</span>}
        </span>
      </div>

      {/* Phones: quick stage chips and lead cards */}
      <div className="md:hidden -mx-4 px-4 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Stage">
        {['', ...quickStages].map((st) => {
          const on = stage === st;
          const n = st ? base.filter((l) => String(l[F.STAGE] || '').trim() === st).length : base.length;
          return (
            <button key={st || 'all'} type="button" onClick={() => setStage(st)} aria-pressed={on}
              className={cx('flex-none h-10 px-4 rounded-full inline-flex items-center gap-1.5 text-[13px] font-semibold border', on ? 'bg-[#0A1F33] border-[#0A1F33] text-white' : 'bg-white border-[#D3E3F0] text-[#0B2A44]')}>
              {st || 'All'}<span className={on ? 'text-[#9CC9EE]' : 'text-[#7E93A6]'}>{n}</span>
            </button>
          );
        })}
      </div>
      <div className="md:hidden space-y-2.5">
        <p className="text-xs text-[#5E778C]"><strong className="text-[#0B2A44]">{sorted.length}</strong> {sorted.length === 1 ? 'lead' : 'leads'}{sorted.length !== base.length ? ` of ${base.length}` : ''}</p>
        {visible.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[#D3E3F0] p-6 text-center text-sm text-[#5E778C] space-y-2">
            <div>No leads match the current filters.</div>
            {hasFilters && <Button variant="secondary" size="xs" onClick={clearFilters} icon={<RotateCcw size={11} />}>Clear filters</Button>}
          </div>
        ) : visible.map((l) => <LeadCard key={String(l[F.ID])} lead={l} onOpen={() => onOpenLead(String(l[F.ID]))} />)}
        {sorted.length > visible.length && (
          <Button variant="secondary" className="w-full" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, sorted.length - visible.length)} more
          </Button>
        )}
      </div>

      {/* Table (tablets and up) */}
      <div className="hidden md:block bg-white rounded-2xl border border-[#D3E3F0] shadow-xs overflow-hidden">
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
          <div className="p-3 border-t border-[#E6EFF6] bg-[#FFFFFF] flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-[#5E778C]">
              Showing <strong className="text-[#0B2A44]">{visible.length}</strong> of {sorted.length}
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

/* ------------------------------ phone card ------------------------------ */

const AVATAR = [['#DCEBFA', '#0B4F86'], ['#DDF1EE', '#0E5E55'], ['#E9E4F7', '#47308A'], ['#FCE9DC', '#8A3E14'], ['#E4EDF4', '#29465E']];

/** One lead on a phone: initials, name and stage, what it is, what's next, and Call / WhatsApp. */
const LeadCard: React.FC<{ lead: Lead; onOpen: () => void }> = ({ lead, onOpen }) => {
  const name = String(lead[F.NAME] || 'Unnamed');
  const phone = String(lead[F.PHONE] || '');
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
  const [bg, ink] = AVATAR[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR.length];
  const next = nextFollowupDate(lead);
  const overdue = !!next && next.getTime() < Date.now();
  const remarks = followupEntries(lead);
  const last = remarks[remarks.length - 1];
  const meta = [lead[F.UNIT_TYPE], lead[F.SOURCE], lead[F.RM]].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
  return (
    <div className="bg-white rounded-[20px] border border-[#E6EFF6] shadow-[0_1px_3px_rgba(10,31,51,0.06)] p-3.5 flex items-center gap-3">
      <button type="button" onClick={onOpen} className="flex-1 min-w-0 flex items-center gap-3 text-left">
        <span className="w-11 h-11 flex-none rounded-full flex items-center justify-center text-sm font-extrabold" style={{ background: bg, color: ink }}>{initials}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-[15px] font-bold text-[#0A1F33] truncate">{name}</span>
            <span className="flex-none"><StageBadge stage={String(lead[F.STAGE] || '')} /></span>
          </span>
          {meta && <span className="block text-[12.5px] text-[#5E778C] truncate mt-0.5">{meta}</span>}
          <span className={cx('block text-[12px] mt-0.5 truncate font-medium', overdue ? 'text-[#B42318]' : next ? 'text-[#0B6BB0]' : 'text-[#7E93A6]')}>
            {next ? `Follow-up ${overdue ? 'overdue · ' : ''}${formatRelative(next.toISOString())}` : last?.text ? `Remark ${remarks.length}: ${last.text}` : `Enquired ${formatRelative(String(lead[F.ENQUIRY_DATE] || ''))}`}
          </span>
        </span>
      </button>
      {phone && (
        <div className="flex gap-1.5 flex-none">
          <CallButton phone={phone} leadId={String(lead[F.ID])} name={name} aria-label={`Call ${name}`} title={formatPhone(phone)} className="w-11 h-11 rounded-full bg-[#F2F7FB] text-[#0A1F33] flex items-center justify-center active:scale-95"><Phone size={17} /></CallButton>
          <a href={whatsappLink(phone)} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${name}`} className="w-11 h-11 rounded-full bg-[#0A1F33] text-white flex items-center justify-center active:scale-95"><MessageCircle size={17} /></a>
        </div>
      )}
    </div>
  );
};
