/**
 * Inventory module helpers — status styling, counts, CSV template / parsing.
 * UI-free so they can be unit-tested; nothing here talks to the backend.
 */
import { normalizeUnitType } from '../../core/units';
import { InventoryStatus, InventoryUnit } from '../../types/crm';
import { parseDate } from '../../core/dates';

export type BadgeTone = 'navy' | 'gold' | 'sage' | 'rust' | 'muted' | 'amber';

/** Statuses the sheet is expected to hold. Unknown values are tolerated and rendered muted. */
export const INVENTORY_STATUSES: InventoryStatus[] = ['Available', 'Reserved', 'Booked', 'Sold', 'Owner', 'Blocked'];

export function isKnownStatus(s: string): s is InventoryStatus {
  return (INVENTORY_STATUSES as string[]).includes(s);
}

export function statusTone(status: string | undefined | null): BadgeTone {
  switch (String(status || '').trim()) {
    case 'Available':
      return 'sage';
    case 'Reserved':
      return 'amber';
    case 'Booked':
      return 'navy';
    case 'Sold':
      return 'gold';
    case 'Owner':
      return 'muted';
    case 'Blocked':
      return 'rust';
    default:
      return 'muted';
  }
}

export function syncTone(status: string | undefined | null): BadgeTone {
  switch (String(status || 'Synced')) {
    case 'Pending':
      return 'amber';
    case 'Conflict':
      return 'rust';
    case 'Error':
      return 'rust';
    default:
      return 'sage';
  }
}

export interface InventorySummary {
  total: number;
  byStatus: Record<InventoryStatus, number>;
  /** Units whose status is not one of INVENTORY_STATUSES (rendered as "Other"). */
  other: number;
  /** Sum of `price` across Booked + Sold units (0 when prices are not maintained). */
  bookedValue: number;
}

export function summarizeInventory(units: InventoryUnit[]): InventorySummary {
  const byStatus = { Available: 0, Reserved: 0, Booked: 0, Sold: 0, Owner: 0, Blocked: 0 } as Record<InventoryStatus, number>;
  let other = 0;
  let bookedValue = 0;
  for (const u of units) {
    const s = String(u.status || '').trim();
    if (isKnownStatus(s)) byStatus[s]++;
    else other++;
    if ((s === 'Booked' || s === 'Sold') && Number(u.price) > 0) bookedValue += Number(u.price);
  }
  return { total: units.length, byStatus, other, bookedValue };
}

/** Distinct non-empty values of a field, sorted naturally (A1 < A2 < A10, numbers numeric). */
export function distinctValues(units: InventoryUnit[], pick: (u: InventoryUnit) => string | number | undefined | null): string[] {
  const set = new Set<string>();
  for (const u of units) {
    const v = pick(u);
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) set.add(s);
  }
  return [...set].sort(naturalCompare);
}

export function naturalCompare(a: string, b: string): number {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function unitKey(u: InventoryUnit): string {
  return u.inventoryId || u.unitId;
}

/* ------------------------------------------------------------------------ */
/* CSV                                                                       */
/* ------------------------------------------------------------------------ */

export const IMPORT_HEADERS = ['Unit Number', 'Tower', 'Floor', 'Unit Type', 'Carpet Area', 'Built-up Area', 'UDS', 'Facing', 'Status', 'Price'] as const;

export const EXPORT_HEADERS = [
  'Inventory ID', 'Unit Number', 'Tower', 'Floor', 'Unit Type', 'Carpet Area', 'Built-up Area', 'UDS', 'Facing', 'Status', 'Price',
  'Availability', 'Booking Status', 'Customer Name', 'Contact', 'Lead ID', 'Booked Date', 'Notes', 'Last Modified', 'Modified By', 'Sync Status',
  'Ownership', 'Mortgaged',
] as const;

/**
 * Minimal RFC-4180 parser: quoted fields, doubled quotes, embedded newlines,
 * CRLF / LF / CR line endings, optional BOM. Returns rows of raw cells.
 */
export function parseCsv(text: string): string[][] {
  const src = String(text || '').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // drop fully blank rows
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

type ImportField = 'unitId' | 'tower' | 'floor' | 'unitType' | 'carpetArea' | 'totalArea' | 'uds' | 'facing' | 'status' | 'price';

const HEADER_ALIASES: Array<{ field: ImportField; match: RegExp }> = [
  { field: 'unitId', match: /^(unit\s*(number|no\.?|num|id)?|flat\s*(no\.?|number)?|unit)$/i },
  { field: 'tower', match: /^(tower|block|wing)$/i },
  { field: 'floor', match: /^(floor|level)$/i },
  { field: 'unitType', match: /^(unit\s*type|type|configuration|config|bhk)$/i },
  { field: 'carpetArea', match: /^(carpet(\s*area)?(\s*\(?sq\.?\s*ft\)?)?)$/i },
  { field: 'totalArea', match: /^((super\s*)?built[-\s]?up(\s*area)?(\s*\(?sq\.?\s*ft\)?)?|total\s*area|sba|saleable\s*area)$/i },
  { field: 'uds', match: /^(uds|undivided\s*share(\s*\(?sq\.?\s*(yd|yard|ft)s?\)?)?)$/i },
  { field: 'facing', match: /^(facing|direction)$/i },
  { field: 'status', match: /^(status|availability\s*status|inventory\s*status)$/i },
  { field: 'price', match: /^(price|total\s*price|cost|amount|price\s*\(?(inr|₹|rs\.?)\)?)$/i },
];

export interface CsvImportAnalysis {
  headers: string[];
  mapped: Partial<Record<ImportField, string>>;
  unmappedHeaders: string[];
  units: Partial<InventoryUnit>[];
  /** Row numbers (1-based, as in the file) skipped because Unit Number was blank. */
  skippedRows: number[];
  /** Unit numbers that already exist in the current inventory (backend will skip them). */
  duplicates: string[];
  /** Unit numbers repeated inside the file (only the first occurrence is kept). */
  repeatedInFile: string[];
  errors: string[];
}

function toNumber(v: string): number {
  const n = Number(String(v || '').replace(/[₹,\s]/g, '').replace(/^rs\.?/i, ''));
  return isFinite(n) ? n : 0;
}

function normalizeStatus(v: string): string {
  const s = String(v || '').trim();
  if (!s) return 'Available';
  const hit = INVENTORY_STATUSES.find((k) => k.toLowerCase() === s.toLowerCase());
  return hit || s; // keep unknown value — rendered muted, never crashes
}

export function analyzeInventoryCsv(text: string, existing: InventoryUnit[]): CsvImportAnalysis {
  const rows = parseCsv(text);
  const out: CsvImportAnalysis = { headers: [], mapped: {}, unmappedHeaders: [], units: [], skippedRows: [], duplicates: [], repeatedInFile: [], errors: [] };
  if (rows.length < 2) {
    out.errors.push('The file needs a header row and at least one data row.');
    return out;
  }
  out.headers = rows[0].map((h) => String(h || '').trim());
  const colIndex: Partial<Record<ImportField, number>> = {};
  out.headers.forEach((h, idx) => {
    if (!h) return;
    const alias = HEADER_ALIASES.find((a) => a.match.test(h));
    if (alias && colIndex[alias.field] === undefined) {
      colIndex[alias.field] = idx;
      out.mapped[alias.field] = h;
    } else {
      out.unmappedHeaders.push(h);
    }
  });
  if (colIndex.unitId === undefined) {
    out.errors.push('Could not find a "Unit Number" column. Download the template to see the expected headers.');
    return out;
  }

  const existingSet = new Set(existing.map((u) => String(u.unitId || '').trim().toUpperCase()).filter(Boolean));
  const seen = new Set<string>();
  const get = (r: string[], f: ImportField) => (colIndex[f] === undefined ? '' : String(r[colIndex[f]!] ?? '').trim());

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const unitNo = get(r, 'unitId');
    if (!unitNo) {
      out.skippedRows.push(i + 1);
      continue;
    }
    const key = unitNo.toUpperCase();
    if (seen.has(key)) {
      out.repeatedInFile.push(unitNo);
      continue;
    }
    seen.add(key);
    if (existingSet.has(key)) out.duplicates.push(unitNo);
    const unit: Partial<InventoryUnit> = { unitId: unitNo };
    const tower = get(r, 'tower');
    const floor = get(r, 'floor');
    const unitType = get(r, 'unitType');
    const facing = get(r, 'facing');
    if (tower) unit.tower = tower;
    if (floor) unit.floor = floor;
    if (unitType) unit.unitType = normalizeUnitType(unitType);
    if (facing) unit.facing = facing;
    if (colIndex.carpetArea !== undefined) unit.carpetArea = toNumber(get(r, 'carpetArea'));
    if (colIndex.totalArea !== undefined) unit.totalArea = toNumber(get(r, 'totalArea'));
    if (colIndex.uds !== undefined) unit.uds = toNumber(get(r, 'uds'));
    if (colIndex.price !== undefined) unit.price = toNumber(get(r, 'price'));
    unit.status = normalizeStatus(get(r, 'status')) as InventoryStatus;
    out.units.push(unit);
  }
  if (!out.units.length) out.errors.push('No rows with a Unit Number were found.');
  return out;
}

/** Row objects for `toCsv(EXPORT_HEADERS, rows)` — dates are exported as ISO so they round-trip. */
export function unitToExportRow(u: InventoryUnit): Record<string, unknown> {
  const iso = (v?: string) => {
    const d = parseDate(v);
    return d ? d.toISOString() : '';
  };
  return {
    'Inventory ID': u.inventoryId,
    'Unit Number': u.unitId,
    Tower: u.tower,
    Floor: u.floor,
    'Unit Type': u.unitType,
    'Carpet Area': u.carpetArea || '',
    'Built-up Area': u.totalArea || '',
    UDS: u.uds || '',
    Facing: u.facing || '',
    Status: u.status,
    Price: u.price || '',
    Availability: u.availability || '',
    'Booking Status': u.bookingStatus || '',
    'Customer Name': u.customerName || '',
    Contact: u.contact || '',
    'Lead ID': u.leadId || '',
    'Booked Date': iso(u.bookedDate),
    Notes: u.notes || '',
    'Last Modified': iso(u.lastModified),
    'Modified By': u.modifiedBy || '',
    'Sync Status': u.syncStatus || 'Synced',
    Ownership: u.ownership || '',
    Mortgaged: u.mortgaged === undefined ? '' : u.mortgaged ? 'Yes' : 'No',
  };
}
