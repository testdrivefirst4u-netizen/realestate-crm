/**
 * Inventory — residence & unit stock, live from the CRM server.
 *
 * Data and mutations come from the engine through props; this view only filters,
 * renders and shapes patches. A conflict (unit edited elsewhere after we loaded
 * it) is surfaced inline so the user can re-apply the change on the latest copy.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Building2, ChevronDown, ChevronUp, Download, ExternalLink, FileSpreadsheet, Link2, MapPin, Pencil, Plus, RefreshCw, Search, Unlink, Upload, X,
} from 'lucide-react';
import { InventoryStatus, InventoryUnit, Lead, SyncState } from '../../types/crm';
import { F } from '../../core/config';
import { searchLeads } from '../../core/analytics';
import { compareDates, formatDate, formatDateTime, formatRelative, fromDateInput, toDateInput, todayKey } from '../../core/dates';
import { formatINR, formatNumber, toCsv, downloadText, pluralize } from '../../core/format';
import { formatPhone } from '../../core/phone';
import { reportError, toAppError } from '../../core/errors';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, InlineNotice, KpiTile, LoadingState, Modal, Select, StageBadge, cx, inputCls } from '../../components/ui';
import {
  EXPORT_HEADERS, IMPORT_HEADERS, INVENTORY_STATUSES, CsvImportAnalysis, analyzeInventoryCsv, distinctValues, isKnownStatus, naturalCompare, statusTone, summarizeInventory, syncTone, unitKey, unitToExportRow,
} from './inventoryUtils';
import { useFeature } from '../../core/tenant';
import { UnitLocator } from './UnitLocator'; // explicit extension: unitLocator.ts sits next to it (case-only difference)
import { PageSkeleton } from '../../components/Skeletons';

export interface InventoryViewProps {
  inventory: InventoryUnit[];
  leads: Lead[];
  sync: SyncState;
  canEdit: boolean;
  onUpdateUnit: (inventoryId: string, patch: Partial<InventoryUnit>) => Promise<{ ok: boolean; conflict?: InventoryUnit }>;
  onAddUnit: (unit: Partial<InventoryUnit>) => Promise<boolean>;
  onImportInventory: (units: Partial<InventoryUnit>[]) => Promise<{ created: number; skipped: number } | null>;
  onRefresh: () => void;
  onOpenLead: (id: string) => void;
  /** Text search to start with (from the top-bar search, via `?q=`). */
  initialQuery?: string;
}

type SortKey = 'unit' | 'tower' | 'floor' | 'type' | 'carpet' | 'price' | 'status' | 'customer' | 'booked' | 'modified';
const PAGE_SIZE = 100;

const modifiedByLabel = (v?: string) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s === 'Sheet') return 'Spreadsheet import';
  if (s.startsWith('CRM:')) return s.slice(4);
  if (s.startsWith('Import:')) return `Import · ${s.slice(7)}`;
  return s;
};

const LeadChip: React.FC<{ id: string; name?: string; onOpen: (id: string) => void; className?: string }> = ({ id, name, onOpen, className }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onOpen(id);
    }}
    title={`Open ${id}`}
    className={cx('inline-flex items-center gap-1 max-w-full text-[10px] font-semibold text-[#A9825A] hover:text-[#1D2F3F] hover:underline', className)}
  >
    <ExternalLink size={10} className="flex-shrink-0" />
    <span className="font-mono">{id}</span>
    {name && <span className="truncate text-[#6B5F57] font-normal">· {name}</span>}
  </button>
);

export const InventoryView: React.FC<InventoryViewProps> = ({ inventory, leads, sync, canEdit, onUpdateUnit, onAddUnit, onImportInventory, onRefresh, onOpenLead, initialQuery = '' }) => {
  /** The Unit Locator (3D tower view) is a plan feature. */
  const locatorEnabled = useFeature('unitLocator');
  const [search, setSearch] = useState(initialQuery);
  useEffect(() => setSearch(initialQuery), [initialQuery]);
  const [tower, setTower] = useState('');
  const [unitType, setUnitType] = useState('');
  const [floor, setFloor] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'unit', dir: 'asc' });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const leadById = useMemo(() => {
    const m = new Map<string, Lead>();
    for (const l of leads) m.set(String(l[F.ID] || ''), l);
    return m;
  }, [leads]);

  const summary = useMemo(() => summarizeInventory(inventory), [inventory]);
  const towers = useMemo(() => distinctValues(inventory, (u) => u.tower), [inventory]);
  const types = useMemo(() => distinctValues(inventory, (u) => u.unitType), [inventory]);
  const floors = useMemo(() => distinctValues(inventory, (u) => u.floor), [inventory]);
  const statuses = useMemo(() => {
    const present = distinctValues(inventory, (u) => u.status);
    const known = INVENTORY_STATUSES.filter((s) => present.includes(s));
    return [...known, ...present.filter((s) => !isKnownStatus(s))];
  }, [inventory]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    let rows = inventory.filter((u) => {
      if (tower && String(u.tower || '').trim() !== tower) return false;
      if (unitType && String(u.unitType || '').trim() !== unitType) return false;
      if (floor && String(u.floor ?? '').trim() !== floor) return false;
      if (status && String(u.status || '').trim() !== status) return false;
      if (!q) return true;
      const lead = u.leadId ? leadById.get(u.leadId) : undefined;
      const hay = [u.unitId, u.inventoryId, u.customerName, u.leadId, u.tower, u.notes, lead ? lead[F.NAME] : ''].map((v) => String(v || '').toLowerCase());
      if (hay.some((h) => h.includes(q))) return true;
      return digits.length >= 4 && String(u.contact || '').replace(/\D/g, '').includes(digits);
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    const byUnit = (a: InventoryUnit, b: InventoryUnit) =>
      naturalCompare(String(a.tower || ''), String(b.tower || '')) || naturalCompare(String(a.floor ?? ''), String(b.floor ?? '')) || naturalCompare(a.unitId, b.unitId);
    const cmp: Record<SortKey, (a: InventoryUnit, b: InventoryUnit) => number> = {
      unit: byUnit,
      tower: (a, b) => naturalCompare(String(a.tower || ''), String(b.tower || '')) || byUnit(a, b),
      floor: (a, b) => naturalCompare(String(a.floor ?? ''), String(b.floor ?? '')) || byUnit(a, b),
      type: (a, b) => naturalCompare(String(a.unitType || ''), String(b.unitType || '')) || byUnit(a, b),
      carpet: (a, b) => Number(a.carpetArea || 0) - Number(b.carpetArea || 0) || byUnit(a, b),
      price: (a, b) => Number(a.price || 0) - Number(b.price || 0) || byUnit(a, b),
      status: (a, b) => naturalCompare(String(a.status || ''), String(b.status || '')) || byUnit(a, b),
      customer: (a, b) => naturalCompare(String(a.customerName || ''), String(b.customerName || '')) || byUnit(a, b),
      booked: (a, b) => compareDates(a.bookedDate, b.bookedDate) || byUnit(a, b),
      modified: (a, b) => compareDates(a.lastModified, b.lastModified) || byUnit(a, b),
    };
    rows = [...rows].sort((a, b) => cmp[sort.key](a, b) * dir);
    return rows;
  }, [inventory, search, tower, unitType, floor, status, sort, leadById]);

  useEffect(() => setVisible(PAGE_SIZE), [search, tower, unitType, floor, status, sort]);

  const anyFilter = !!(search || tower || unitType || floor || status);
  const clearFilters = () => {
    setSearch('');
    setTower('');
    setUnitType('');
    setFloor('');
    setStatus('');
  };

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const indicator = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : undefined);

  const exportCsv = () => {
    const rows = filtered.map(unitToExportRow);
    downloadText(`Inventory_${todayKey()}.csv`, toCsv([...EXPORT_HEADERS], rows));
  };
  const downloadTemplate = () => downloadText('Inventory_Template.csv', toCsv([...IMPORT_HEADERS], []));

  const editingUnit = useMemo(() => (editingKey ? inventory.find((u) => unitKey(u) === editingKey) || null : null), [inventory, editingKey]);
  // Schematic 3D locator (tower / floor / facing) — opened from a row or from the unit drawer.
  const [locateKey, setLocateKey] = useState<string | null>(null);
  const locatingUnit = useMemo(() => (locateKey ? inventory.find((u) => unitKey(u) === locateKey) || null : null), [inventory, locateKey]);

  /* ------------------------------ states -------------------------------- */
  const empty = inventory.length === 0;
  if (empty && (sync.status === 'loading' || (!sync.hasLoadedOnce && sync.status === 'syncing'))) return <PageSkeleton variant="table" label="Loading inventory…" />;
  if (empty && !sync.hasLoadedOnce && (sync.status === 'error' || sync.status === 'offline' || sync.status === 'auth')) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <ErrorState title={sync.status === 'offline' ? 'You are offline' : 'Inventory could not load'} message={sync.lastError || 'The backend did not respond. Check your connection and try again.'} onRetry={onRefresh} />
      </div>
    );
  }

  const stale = sync.status === 'error' || sync.status === 'offline';

  const columns = [
    {
      key: 'unit', label: 'Unit', onSort: () => toggleSort('unit'), sortIndicator: indicator('unit'),
      render: (u: InventoryUnit) => (
        <div>
          <div className="font-bold text-[#1D2F3F] text-sm">{u.unitId || '—'}</div>
          {u.inventoryId && <div className="text-[10px] font-mono text-[#9E948D]">{u.inventoryId}</div>}
        </div>
      ),
    },
    { key: 'tower', label: 'Tower', onSort: () => toggleSort('tower'), sortIndicator: indicator('tower'), render: (u: InventoryUnit) => u.tower || '—' },
    { key: 'floor', label: 'Floor', onSort: () => toggleSort('floor'), sortIndicator: indicator('floor'), render: (u: InventoryUnit) => (u.floor === '' || u.floor === undefined || u.floor === null ? '—' : String(u.floor)) },
    { key: 'type', label: 'Type', onSort: () => toggleSort('type'), sortIndicator: indicator('type'), render: (u: InventoryUnit) => <span className="font-semibold text-[#A9825A]">{u.unitType || '—'}</span> },
    {
      key: 'area', label: <span>Carpet / Built-up <span className="normal-case font-medium">(sq.ft)</span></span>, onSort: () => toggleSort('carpet'), sortIndicator: indicator('carpet'), align: 'right' as const,
      render: (u: InventoryUnit) => (
        <span className="tabular-nums">{u.carpetArea ? formatNumber(u.carpetArea) : '—'} <span className="text-[#9E948D]">/</span> {u.totalArea ? formatNumber(u.totalArea) : '—'}</span>
      ),
    },
    { key: 'uds', label: 'UDS', align: 'right' as const, render: (u: InventoryUnit) => <span className="tabular-nums">{u.uds ? formatNumber(u.uds) : '—'}</span> },
    { key: 'facing', label: 'Facing', render: (u: InventoryUnit) => u.facing || '—' },
    { key: 'price', label: 'Price', onSort: () => toggleSort('price'), sortIndicator: indicator('price'), align: 'right' as const, render: (u: InventoryUnit) => <span className="font-semibold tabular-nums">{Number(u.price) > 0 ? formatINR(u.price) : '—'}</span> },
    { key: 'status', label: 'Status', onSort: () => toggleSort('status'), sortIndicator: indicator('status'), render: (u: InventoryUnit) => <Badge tone={statusTone(u.status)}>{u.status || 'Unknown'}</Badge> },
    {
      key: 'customer', label: 'Customer', onSort: () => toggleSort('customer'), sortIndicator: indicator('customer'), className: 'min-w-[160px]',
      render: (u: InventoryUnit) => {
        const lead = u.leadId ? leadById.get(u.leadId) : undefined;
        if (!u.customerName && !u.contact && !u.leadId) return <span className="text-[#9E948D]">—</span>;
        return (
          <div className="min-w-0">
            {u.customerName && <div className="font-semibold text-[#1D2F3F] truncate">{u.customerName}</div>}
            {u.contact && <div className="text-[10px] text-[#6B5F57]">{formatPhone(u.contact)}</div>}
            {u.leadId && <LeadChip id={u.leadId} name={lead ? lead[F.NAME] : undefined} onOpen={onOpenLead} />}
          </div>
        );
      },
    },
    { key: 'booked', label: 'Booked', onSort: () => toggleSort('booked'), sortIndicator: indicator('booked'), render: (u: InventoryUnit) => formatDate(u.bookedDate, '—') },
    {
      key: 'modified', label: 'Last modified', onSort: () => toggleSort('modified'), sortIndicator: indicator('modified'),
      render: (u: InventoryUnit) => (
        <div className="min-w-0">
          <div className="whitespace-nowrap">{formatRelative(u.lastModified, '—')}</div>
          {u.modifiedBy && <div className="text-[10px] text-[#9E948D] truncate">{modifiedByLabel(u.modifiedBy)}</div>}
        </div>
      ),
    },
    {
      key: 'sync', label: 'Sync', align: 'center' as const,
      render: (u: InventoryUnit) => (
        <Badge tone={syncTone(u.syncStatus)} title={u.syncError || (u.syncStatus === 'Conflict' ? 'Edited elsewhere — latest copy shown' : undefined)}>
          {u.syncStatus || 'Synced'}
        </Badge>
      ),
    },
    {
      key: 'actions', label: '', align: 'right' as const,
      render: (u: InventoryUnit) => (
        <div className="flex items-center justify-end gap-1">
          {locatorEnabled && <Button
            size="xs"
            variant="ghost"
            icon={<MapPin size={12} />}
            title="Locate / 3D view — tower, floor and facing, shareable on WhatsApp"
            aria-label={`Locate ${u.unitId || 'unit'} in the 3D view`}
            onClick={(e) => {
              e.stopPropagation();
              setLocateKey(unitKey(u));
            }}
          >
            Locate
          </Button>}
          <Button
            size="xs"
            variant="ghost"
            icon={canEdit ? <Pencil size={12} /> : <ExternalLink size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              setEditingKey(unitKey(u));
            }}
          >
            {canEdit ? 'Edit' : 'View'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Residence & Unit Inventory</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5 flex items-center gap-2 flex-wrap">
            <span>Live inventory — edits here are saved to the CRM server at once; colleagues’ edits appear after the next sync.</span>
            <span className="text-[#9E948D]">·</span>
            <span className={stale ? 'text-[#B06A55] font-semibold' : ''}>
              {sync.status === 'syncing' ? 'Syncing…' : sync.lastSyncAt ? `Synced ${formatRelative(sync.lastSyncAt)}` : 'Not synced yet'}
              {stale && ' (showing last known data)'}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" onClick={onRefresh} loading={sync.status === 'syncing'} icon={<RefreshCw size={13} />}>Refresh</Button>
          <Button variant="secondary" onClick={exportCsv} disabled={!filtered.length} icon={<Download size={13} />}>Export CSV</Button>
          {canEdit && <Button variant="secondary" onClick={() => setImportOpen(true)} icon={<Upload size={13} />}>Import CSV</Button>}
          {canEdit && <Button variant="primary" onClick={() => setAddOpen(true)} icon={<Plus size={13} />}>Add unit</Button>}
        </div>
      </div>

      {stale && sync.lastError && <ErrorState compact title={sync.status === 'offline' ? 'Offline — live updates paused' : 'Last sync failed'} message={sync.lastError} onRetry={onRefresh} />}

      {empty ? (
        <Card>
          <EmptyState
            icon={<Building2 size={22} />}
            title="No units in the inventory yet"
            description={
              <>
                The inventory holds one record per residence (Unit Number, Tower, Floor, Unit Type, areas, Facing, Status, Price). Import them from a CSV
                {canEdit ? ' or add units here — they are saved immediately.' : ' (ask a manager to add them).'}
              </>
            }
            action={
              <div className="flex items-center gap-2 flex-wrap justify-center">
                <Button variant="secondary" onClick={onRefresh} icon={<RefreshCw size={13} />}>Refresh</Button>
                {canEdit && <Button variant="secondary" onClick={() => setImportOpen(true)} icon={<Upload size={13} />}>Import CSV</Button>}
                {canEdit && <Button variant="primary" onClick={() => setAddOpen(true)} icon={<Plus size={13} />}>Add unit</Button>}
              </div>
            }
          />
        </Card>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <KpiTile label="Total units" value={summary.total} tone="navy" icon={<Building2 size={12} />} onClick={() => setStatus('')} />
            <KpiTile label="Available" value={summary.byStatus.Available} tone="sage" onClick={() => setStatus('Available')} />
            <KpiTile label="Reserved" value={summary.byStatus.Reserved} tone="gold" onClick={() => setStatus('Reserved')} />
            <KpiTile label="Booked" value={summary.byStatus.Booked} tone="white" onClick={() => setStatus('Booked')} />
            <KpiTile label="Sold" value={summary.byStatus.Sold} tone="light" onClick={() => setStatus('Sold')} />
            <KpiTile label="Owner" value={summary.byStatus.Owner} tone="light" onClick={() => setStatus('Owner')} hint="owner share" />
            <KpiTile label="Blocked" value={summary.byStatus.Blocked} tone="rust" onClick={() => setStatus('Blocked')} hint={summary.other ? `${summary.other} other` : undefined} />
          </div>

          {/* Filters */}
          <div className="bg-[#EDE8E0] p-3 rounded-xl border border-[#D2C9BF] flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9E948D]" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search unit, customer, lead ID, phone…" className={cx(inputCls, 'pl-8')} />
            </div>
            <Select value={tower} onChange={(e) => setTower(e.target.value)} options={towers} placeholder="All towers" className="!w-auto" />
            <Select value={floor} onChange={(e) => setFloor(e.target.value)} options={floors} placeholder="All floors" className="!w-auto" />
            <Select value={unitType} onChange={(e) => setUnitType(e.target.value)} options={types} placeholder="All types" className="!w-auto" />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} options={statuses} placeholder="All statuses" className="!w-auto" />
            <span className="text-xs text-[#6B5F57] font-medium ml-auto">
              {filtered.length === inventory.length ? pluralize(inventory.length, 'unit') : `${filtered.length} of ${inventory.length} units`}
            </span>
            {anyFilter && <Button size="xs" variant="ghost" onClick={clearFilters} icon={<X size={12} />}>Clear</Button>}
          </div>

          {/* Table */}
          <Card padded={false} className="overflow-hidden">
            <DataTable<InventoryUnit>
              columns={columns}
              rows={filtered.slice(0, visible)}
              keyFn={(u, i) => unitKey(u) || String(i)}
              onRowClick={(u) => setEditingKey(unitKey(u))}
              dense
              empty={
                <div className="flex flex-col items-center gap-2">
                  <span>No units match these filters.</span>
                  {anyFilter && <Button size="xs" variant="secondary" onClick={clearFilters}>Clear filters</Button>}
                </div>
              }
            />
            {filtered.length > visible && (
              <div className="p-3 border-t border-[#ECE8E1] flex items-center justify-center gap-3 text-xs text-[#6B5F57]">
                <span>Showing {visible} of {filtered.length}</span>
                <Button size="xs" variant="secondary" onClick={() => setVisible((v) => v + PAGE_SIZE)}>Show more</Button>
              </div>
            )}
          </Card>
        </>
      )}

      {editingUnit && (
        <UnitDrawer
          unit={editingUnit}
          leads={leads}
          leadById={leadById}
          canEdit={canEdit}
          onClose={() => setEditingKey(null)}
          onSave={(patch) => onUpdateUnit(editingUnit.inventoryId || editingUnit.unitId, patch)}
          onOpenLead={onOpenLead}
          onLocate={locatorEnabled ? () => setLocateKey(unitKey(editingUnit)) : undefined}
        />
      )}

      {/* Rendered after the drawer so it stacks on top of it; Escape closes only the locator. */}
      {locatorEnabled && locatingUnit && <UnitLocator unit={locatingUnit} inventory={inventory} leads={leads} onClose={() => setLocateKey(null)} />}

      {canEdit && addOpen && <AddUnitModal open={addOpen} inventory={inventory} towers={towers} types={types} onClose={() => setAddOpen(false)} onAdd={onAddUnit} />}
      {canEdit && importOpen && <ImportModal open={importOpen} inventory={inventory} onClose={() => setImportOpen(false)} onImport={onImportInventory} onDownloadTemplate={downloadTemplate} />}
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Edit / view drawer                                                        */
/* ------------------------------------------------------------------------ */

interface UnitForm {
  status: string;
  availability: string;
  bookingStatus: string;
  price: string;
  facing: string;
  notes: string;
  customerName: string;
  contact: string;
  leadId: string;
  bookedDate: string; // yyyy-MM-dd (input value)
}

const formFromUnit = (u: InventoryUnit): UnitForm => ({
  status: u.status || 'Available',
  availability: u.availability || '',
  bookingStatus: u.bookingStatus || '',
  price: Number(u.price) > 0 ? String(u.price) : '',
  facing: u.facing || '',
  notes: u.notes || '',
  customerName: u.customerName || '',
  contact: u.contact || '',
  leadId: u.leadId || '',
  bookedDate: toDateInput(u.bookedDate),
});

/** Only fields that actually changed — so a save never clobbers other people's edits to other fields. */
function buildPatch(u: InventoryUnit, f: UnitForm): Partial<InventoryUnit> {
  const p: Partial<InventoryUnit> = {};
  const str = (v: unknown) => String(v ?? '').trim();
  if (f.status !== (u.status || 'Available')) p.status = f.status as InventoryStatus;
  if (str(f.availability) !== str(u.availability)) p.availability = str(f.availability);
  if (str(f.bookingStatus) !== str(u.bookingStatus)) p.bookingStatus = str(f.bookingStatus);
  if (str(f.facing) !== str(u.facing)) p.facing = str(f.facing);
  if (str(f.notes) !== str(u.notes)) p.notes = f.notes.trim();
  if (str(f.customerName) !== str(u.customerName)) p.customerName = str(f.customerName);
  if (str(f.contact) !== str(u.contact)) p.contact = str(f.contact);
  if (str(f.leadId) !== str(u.leadId)) p.leadId = str(f.leadId);
  const price = f.price.trim() === '' ? 0 : Number(f.price);
  if (isFinite(price) && price !== Number(u.price || 0)) p.price = price;
  if (f.bookedDate !== toDateInput(u.bookedDate)) p.bookedDate = fromDateInput(f.bookedDate);
  return p;
}

const UnitDrawer: React.FC<{
  unit: InventoryUnit;
  leads: Lead[];
  leadById: Map<string, Lead>;
  canEdit: boolean;
  onClose: () => void;
  onSave: (patch: Partial<InventoryUnit>) => Promise<{ ok: boolean; conflict?: InventoryUnit }>;
  onOpenLead: (id: string) => void;
  /** Open the schematic 3D locator for this unit (stacks on top of the drawer). */
  onLocate?: () => void;
}> = ({ unit, leads, leadById, canEdit, onClose, onSave, onOpenLead, onLocate }) => {
  const [form, setForm] = useState<UnitForm>(() => formFromUnit(unit));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<InventoryUnit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leadQuery, setLeadQuery] = useState('');

  // Switching to another unit while the drawer is open → reload the form.
  const key = unitKey(unit);
  useEffect(() => {
    setForm(formFromUnit(unit));
    setConflict(null);
    setError(null);
    setLeadQuery('');
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof UnitForm>(k: K, v: UnitForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const onStatusChange = (s: string) => {
    setForm((f) => {
      const next = { ...f, status: s };
      if (s === 'Booked' && !f.bookedDate) next.bookedDate = toDateInput(new Date());
      if (s === 'Available') {
        next.customerName = '';
        next.contact = '';
        next.leadId = '';
        next.bookedDate = '';
      }
      return next;
    });
  };

  const leadResults = useMemo(() => (leadQuery.trim().length >= 2 ? searchLeads(leads, leadQuery, 8) : []), [leads, leadQuery]);
  const linkedLead = form.leadId ? leadById.get(form.leadId) : undefined;
  const linkLead = (l: Lead) => {
    setForm((f) => ({ ...f, leadId: String(l[F.ID] || ''), customerName: String(l[F.NAME] || f.customerName), contact: String(l[F.PHONE] || f.contact) }));
    setLeadQuery('');
  };

  const statusOptions = useMemo(() => {
    const opts: string[] = [...INVENTORY_STATUSES];
    if (form.status && !opts.includes(form.status)) opts.push(form.status);
    return opts;
  }, [form.status]);

  const patch = useMemo(() => buildPatch(conflict || unit, form), [conflict, unit, form]);
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    if (!canEdit || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await onSave(patch);
      if (res.conflict) {
        setConflict(res.conflict);
        setForm(formFromUnit(res.conflict));
        return;
      }
      if (res.ok) {
        onClose();
        return;
      }
      setError('The unit could not be saved. See the notification for details and try again.');
    } catch (e) {
      setError(reportError('inventory.save', e).userMessage);
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canEdit || saving;
  const current = conflict || unit;

  return (
    <Modal
      open
      side
      onClose={onClose}
      title={`${canEdit ? 'Edit' : 'Unit'} ${unit.unitId}`}
      subtitle={
        <span className="flex items-center gap-2 flex-wrap">
          {unit.unitType && <span className="font-semibold text-[#A9825A]">{unit.unitType}</span>}
          {unit.tower && <span>· {unit.tower}</span>}
          {unit.floor !== '' && unit.floor !== undefined && <span>· Floor {String(unit.floor)}</span>}
          {unit.inventoryId && <span className="font-mono text-[#9E948D]">· {unit.inventoryId}</span>}
        </span>
      }
      footer={
        <>
          {onLocate && (
            <Button variant="secondary" className="mr-auto" onClick={onLocate} icon={<MapPin size={13} />} aria-label={`Locate ${unit.unitId || 'this unit'} in the 3D view`}>
              <span className="hidden sm:inline">Locate / 3D view</span>
              <span className="sm:hidden">Locate</span>
            </Button>
          )}
          {canEdit ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>{conflict ? 'Re-apply & save' : 'Save unit'}</Button>
            </>
          ) : (
            <Button variant="secondary" onClick={onClose}>Close</Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {conflict && (
          <InlineNotice tone="warning">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <div>
                <strong>Changed elsewhere</strong> by {modifiedByLabel(conflict.modifiedBy) || 'someone'} at {formatDateTime(conflict.lastModified, 'an unknown time')} — showing the latest version. Re-apply your change and save again.
              </div>
            </div>
          </InlineNotice>
        )}
        {error && <InlineNotice tone="warning">{error}</InlineNotice>}
        {current.syncStatus === 'Error' && current.syncError && !error && <InlineNotice tone="warning">Last save failed: {current.syncError}</InlineNotice>}

        {/* Read-only facts */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Fact label="Carpet area" value={current.carpetArea ? `${formatNumber(current.carpetArea)} sq.ft` : '—'} />
          <Fact label="Built-up area" value={current.totalArea ? `${formatNumber(current.totalArea)} sq.ft` : '—'} />
          <Fact label="UDS" value={current.uds ? formatNumber(current.uds) : '—'} />
          <Fact label="Last modified" value={current.lastModified ? `${formatRelative(current.lastModified)}${current.modifiedBy ? ` · ${modifiedByLabel(current.modifiedBy)}` : ''}` : '—'} />
          {(current.ownership || current.mortgaged !== undefined) && (
            <>
              <Fact label="Ownership" value={current.ownership || '—'} />
              <Fact label="Mortgaged" value={current.mortgaged === undefined ? '—' : current.mortgaged ? 'Yes' : 'No'} />
            </>
          )}
        </div>

        <section className="space-y-3">
          <h4 className="text-xs font-bold text-[#1D2F3F] uppercase tracking-wider">Status & pricing</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Status" hint={form.status === 'Available' && (unit.customerName || unit.leadId) ? 'Releasing a unit clears the customer link.' : undefined}>
              <Select value={form.status} onChange={(e) => onStatusChange(e.target.value)} options={statusOptions} disabled={disabled} />
            </Field>
            <Field label="Availability" hint="Free text, e.g. “Launch phase”, “Hold for owner”">
              <input value={form.availability} onChange={(e) => set('availability', e.target.value)} className={inputCls} disabled={disabled} placeholder="—" />
            </Field>
            <Field label="Booking status" hint="e.g. Token received, Agreement signed, Registered">
              <input value={form.bookingStatus} onChange={(e) => set('bookingStatus', e.target.value)} className={inputCls} disabled={disabled} placeholder="—" />
            </Field>
            <Field label="Price (₹)" hint={form.price && Number(form.price) > 0 ? formatINR(Number(form.price)) : 'Leave blank if not finalised'}>
              <input type="number" min={0} step={1000} value={form.price} onChange={(e) => set('price', e.target.value)} className={inputCls} disabled={disabled} placeholder="0" />
            </Field>
            <Field label="Facing">
              <input value={form.facing} onChange={(e) => set('facing', e.target.value)} className={inputCls} disabled={disabled} placeholder="e.g. East" />
            </Field>
            <Field label="Booked date">
              <input type="date" value={form.bookedDate} onChange={(e) => set('bookedDate', e.target.value)} className={inputCls} disabled={disabled} />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-xs font-bold text-[#1D2F3F] uppercase tracking-wider">Customer</h4>
          <div className="rounded-xl border border-[#D2C9BF] bg-white p-3 space-y-2">
            {form.leadId ? (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Linked enquiry</div>
                  <div className="text-sm font-semibold text-[#1D2F3F] truncate">
                    {linkedLead ? linkedLead[F.NAME] : form.customerName || 'Lead'} <span className="font-mono text-[10px] text-[#A9825A] ml-1">{form.leadId}</span>
                  </div>
                  {linkedLead && (
                    <div className="text-[11px] text-[#6B5F57] mt-0.5 flex items-center gap-2 flex-wrap">
                      <StageBadge stage={linkedLead[F.STAGE]} />
                      <span>{linkedLead[F.UNIT_TYPE] || '—'}</span>
                      <span>· RM {linkedLead[F.RM] || '—'}</span>
                    </div>
                  )}
                  {!linkedLead && <div className="text-[10px] text-[#B06A55] mt-0.5">This enquiry is not in the current lead list (it may be trashed or the ID may be wrong).</div>}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="xs" variant="secondary" icon={<ExternalLink size={11} />} onClick={() => onOpenLead(form.leadId)}>Open</Button>
                  {canEdit && <Button size="xs" variant="ghost" icon={<Unlink size={11} />} onClick={() => set('leadId', '')} disabled={disabled}>Unlink</Button>}
                </div>
              </div>
            ) : canEdit ? (
              <div>
                <label className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57] flex items-center gap-1 mb-1"><Link2 size={11} /> Link to an enquiry</label>
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9E948D]" />
                  <input value={leadQuery} onChange={(e) => setLeadQuery(e.target.value)} placeholder="Search by name, phone or enquiry ID…" className={cx(inputCls, 'pl-8')} disabled={disabled} />
                </div>
                {leadQuery.trim().length >= 2 && (
                  <div className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-[#ECE8E1] divide-y divide-[#ECE8E1]">
                    {leadResults.length === 0 && <div className="p-2.5 text-xs text-[#9E948D]">No matching enquiries</div>}
                    {leadResults.map((l) => (
                      <button key={l[F.ID]} type="button" onClick={() => linkLead(l)} className="w-full text-left p-2.5 hover:bg-[#F4F0EB] flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#1D2F3F] truncate">{l[F.NAME]} <span className="font-mono text-[10px] text-[#A9825A] ml-1">{l[F.ID]}</span></div>
                          <div className="text-[10px] text-[#6B5F57]">{formatPhone(l[F.PHONE]) || '—'} · {l[F.UNIT_TYPE] || '—'}</div>
                        </div>
                        <StageBadge stage={l[F.STAGE]} />
                      </button>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-[#9E948D] mt-1">Linking fills the customer name and contact from the enquiry and records the booking on the lead's timeline.</div>
              </div>
            ) : (
              <div className="text-xs text-[#9E948D]">No enquiry linked.</div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Customer name">
              <input value={form.customerName} onChange={(e) => set('customerName', e.target.value)} className={inputCls} disabled={disabled} placeholder="—" />
            </Field>
            <Field label="Contact" hint={form.contact ? formatPhone(form.contact) : undefined}>
              <input value={form.contact} onChange={(e) => set('contact', e.target.value)} className={inputCls} disabled={disabled} placeholder="+91 …" inputMode="tel" />
            </Field>
          </div>
          <Field label="Notes">
            <textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} className={inputCls} disabled={disabled} placeholder="Token receipt, loan status, parking slot…" />
          </Field>
        </section>
      </div>
    </Modal>
  );
};

const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-lg bg-[#F4F0EB] border border-[#ECE8E1] p-2.5 min-w-0">
    <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">{label}</div>
    <div className="text-xs font-semibold text-[#1D2F3F] mt-0.5 truncate">{value}</div>
  </div>
);

/* ------------------------------------------------------------------------ */
/* Add unit                                                                  */
/* ------------------------------------------------------------------------ */

const AddUnitModal: React.FC<{
  open: boolean;
  inventory: InventoryUnit[];
  towers: string[];
  types: string[];
  onClose: () => void;
  onAdd: (unit: Partial<InventoryUnit>) => Promise<boolean>;
}> = ({ open, inventory, towers, types, onClose, onAdd }) => {
  const [f, setF] = useState({ unitId: '', tower: '', floor: '', unitType: '', carpetArea: '', totalArea: '', uds: '', facing: '', price: '', status: 'Available' as string });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const duplicate = useMemo(() => {
    const key = f.unitId.trim().toUpperCase();
    return !!key && inventory.some((u) => String(u.unitId || '').trim().toUpperCase() === key);
  }, [f.unitId, inventory]);

  const submit = async () => {
    const unitId = f.unitId.trim();
    if (!unitId) {
      setError('Unit number is required.');
      return;
    }
    if (duplicate) {
      setError(`Unit ${unitId} already exists.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const ok = await onAdd({
        unitId,
        tower: f.tower.trim(),
        floor: f.floor.trim(),
        unitType: f.unitType.trim(),
        carpetArea: Number(f.carpetArea) || 0,
        totalArea: Number(f.totalArea) || 0,
        uds: Number(f.uds) || 0,
        facing: f.facing.trim(),
        price: Number(f.price) || 0,
        status: (f.status || 'Available') as InventoryStatus,
      });
      if (ok) onClose();
      else setError('The unit could not be added. See the notification for details.');
    } catch (e) {
      setError(reportError('inventory.add', e).userMessage);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add unit"
      subtitle="Saved to the inventory immediately"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={saving} icon={<Plus size={13} />}>Add unit</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <InlineNotice tone="warning">{error}</InlineNotice>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Unit number *" hint={duplicate ? <span className="text-[#B06A55]">This unit number already exists.</span> : 'e.g. A-101'}>
            <input value={f.unitId} onChange={(e) => set('unitId', e.target.value)} className={inputCls} autoFocus placeholder="A-101" />
          </Field>
          <Field label="Tower">
            <input list="inv-towers" value={f.tower} onChange={(e) => set('tower', e.target.value)} className={inputCls} placeholder={towers[0] || 'Tower A'} />
            <datalist id="inv-towers">{towers.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="Floor">
            <input value={f.floor} onChange={(e) => set('floor', e.target.value)} className={inputCls} placeholder="1" />
          </Field>
          <Field label="Unit type">
            <input list="inv-types" value={f.unitType} onChange={(e) => set('unitType', e.target.value)} className={inputCls} placeholder={types[0] || '2 BHK'} />
            <datalist id="inv-types">{types.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="Carpet area (sq.ft)">
            <input type="number" min={0} value={f.carpetArea} onChange={(e) => set('carpetArea', e.target.value)} className={inputCls} placeholder="0" />
          </Field>
          <Field label="Built-up area (sq.ft)">
            <input type="number" min={0} value={f.totalArea} onChange={(e) => set('totalArea', e.target.value)} className={inputCls} placeholder="0" />
          </Field>
          <Field label="UDS">
            <input type="number" min={0} value={f.uds} onChange={(e) => set('uds', e.target.value)} className={inputCls} placeholder="0" />
          </Field>
          <Field label="Facing">
            <input value={f.facing} onChange={(e) => set('facing', e.target.value)} className={inputCls} placeholder="East" />
          </Field>
          <Field label="Price (₹)" hint={Number(f.price) > 0 ? formatINR(Number(f.price)) : undefined}>
            <input type="number" min={0} step={1000} value={f.price} onChange={(e) => set('price', e.target.value)} className={inputCls} placeholder="0" />
          </Field>
          <Field label="Status">
            <Select value={f.status} onChange={(e) => set('status', e.target.value)} options={[...INVENTORY_STATUSES]} />
          </Field>
        </div>
      </div>
    </Modal>
  );
};

/* ------------------------------------------------------------------------ */
/* CSV import                                                                */
/* ------------------------------------------------------------------------ */

const ImportModal: React.FC<{
  open: boolean;
  inventory: InventoryUnit[];
  onClose: () => void;
  onImport: (units: Partial<InventoryUnit>[]) => Promise<{ created: number; skipped: number } | null>;
  onDownloadTemplate: () => void;
}> = ({ open, inventory, onClose, onImport, onDownloadTemplate }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState<CsvImportAnalysis | null>(null);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  const onFile = (file: File | undefined) => {
    setResult(null);
    setError(null);
    setAnalysis(null);
    if (!file) return;
    setFileName(file.name);
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setAnalysis(analyzeInventoryCsv(String(reader.result || ''), inventory));
      } catch (e) {
        setError(toAppError(e).userMessage);
      } finally {
        setReading(false);
      }
    };
    reader.onerror = () => {
      setReading(false);
      setError('Could not read the file. Please try again.');
    };
    reader.readAsText(file);
  };

  const importable = analysis ? analysis.units.filter((u) => !analysis.duplicates.some((d) => d.toUpperCase() === String(u.unitId).toUpperCase())) : [];

  const run = async () => {
    if (!analysis || !analysis.units.length) return;
    setImporting(true);
    setError(null);
    try {
      const res = await onImport(analysis.units);
      if (res) setResult(res);
      else setError('The import did not complete. See the notification for details.');
    } catch (e) {
      setError(reportError('inventory.import', e).userMessage);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import inventory from CSV"
      subtitle="Existing unit numbers are never overwritten — they are skipped."
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={importing}>Cancel</Button>
            <Button variant="primary" onClick={run} loading={importing} disabled={!analysis || analysis.errors.length > 0 || importable.length === 0} icon={<Upload size={13} />}>
              Import {importable.length ? pluralize(importable.length, 'unit') : ''}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <InlineNotice>
          Columns: <span className="font-mono">{IMPORT_HEADERS.join(', ')}</span>. Only <strong>Unit Number</strong> is required; Status defaults to Available. Header names are matched loosely (e.g. “Built up Area”, “Type”).
          <div className="mt-2">
            <Button size="xs" variant="secondary" onClick={onDownloadTemplate} icon={<FileSpreadsheet size={12} />}>Download CSV template</Button>
          </div>
        </InlineNotice>

        <div
          className="rounded-xl border-2 border-dashed border-[#D2C9BF] bg-white p-5 text-center hover:border-[#A9825A] transition cursor-pointer"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFile(e.dataTransfer.files?.[0]);
          }}
        >
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <Upload size={20} className="mx-auto text-[#A9825A]" />
          <div className="text-xs font-semibold text-[#1D2F3F] mt-2">{fileName || 'Choose a CSV file or drop it here'}</div>
          <div className="text-[10px] text-[#9E948D] mt-0.5">Exported from Excel / Google Sheets as CSV (UTF-8)</div>
        </div>

        {reading && <LoadingState label="Reading file…" className="py-6" />}
        {error && <InlineNotice tone="warning">{error}</InlineNotice>}

        {analysis && !result && (
          <div className="space-y-3">
            {analysis.errors.map((e) => <InlineNotice key={e} tone="warning">{e}</InlineNotice>)}
            {analysis.errors.length === 0 && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <Fact label="Rows with unit" value={analysis.units.length} />
                  <Fact label="Will be created" value={<span className="text-[#2E7D32]">{importable.length}</span>} />
                  <Fact label="Already exist" value={analysis.duplicates.length} />
                  <Fact label="Blank / repeated" value={analysis.skippedRows.length + analysis.repeatedInFile.length} />
                </div>
                <div className="text-[11px] text-[#6B5F57]">
                  Mapped columns:{' '}
                  {Object.entries(analysis.mapped).map(([field, header]) => (
                    <span key={field} className="inline-block mr-1.5 mb-1 px-1.5 py-0.5 rounded bg-[#F4F0EB] border border-[#ECE8E1]"><span className="font-mono">{header}</span> → {field}</span>
                  ))}
                  {analysis.unmappedHeaders.length > 0 && <span className="block mt-1 text-[#9E948D]">Ignored: {analysis.unmappedHeaders.join(', ')}</span>}
                </div>
                {analysis.duplicates.length > 0 && (
                  <InlineNotice tone="warning">Skipped as they already exist: {analysis.duplicates.slice(0, 12).join(', ')}{analysis.duplicates.length > 12 ? ` and ${analysis.duplicates.length - 12} more` : ''}</InlineNotice>
                )}
                <div className="rounded-lg border border-[#ECE8E1] overflow-hidden">
                  <DataTable<Partial<InventoryUnit>>
                    dense
                    rows={analysis.units.slice(0, 8)}
                    keyFn={(u, i) => `${u.unitId}-${i}`}
                    columns={[
                      { key: 'unitId', label: 'Unit', render: (u) => <strong>{u.unitId}</strong> },
                      { key: 'tower', label: 'Tower', render: (u) => u.tower || '—' },
                      { key: 'floor', label: 'Floor', render: (u) => (u.floor === undefined ? '—' : String(u.floor)) },
                      { key: 'unitType', label: 'Type', render: (u) => u.unitType || '—' },
                      { key: 'carpetArea', label: 'Carpet', align: 'right', render: (u) => (u.carpetArea ? formatNumber(u.carpetArea) : '—') },
                      { key: 'totalArea', label: 'Built-up', align: 'right', render: (u) => (u.totalArea ? formatNumber(u.totalArea) : '—') },
                      { key: 'price', label: 'Price', align: 'right', render: (u) => (Number(u.price) > 0 ? formatINR(u.price) : '—') },
                      { key: 'status', label: 'Status', render: (u) => <Badge tone={statusTone(u.status)}>{u.status}</Badge> },
                    ]}
                  />
                  {analysis.units.length > 8 && <div className="p-2 text-center text-[10px] text-[#9E948D] border-t border-[#ECE8E1]">…and {analysis.units.length - 8} more rows</div>}
                </div>
              </>
            )}
          </div>
        )}

        {result && (
          <InlineNotice tone="success">
            Import complete: <strong>{result.created}</strong> created, <strong>{result.skipped}</strong> skipped (already existed or had no unit number). The inventory has been refreshed.
          </InlineNotice>
        )}
      </div>
    </Modal>
  );
};

export default InventoryView;
