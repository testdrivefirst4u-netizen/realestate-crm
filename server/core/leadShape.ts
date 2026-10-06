/**
 * Lead shape conversion: MongoDB lead document (camelCase, real Dates, embedded follow-ups)
 * ⇄ the UI lead the browser has always received from Leads_serialize (header-keyed strings,
 * ISO dates, 'Follow-up N' in the legacy "yyyy-MM-dd HH:mm — remark" text format).
 */
import { CFG } from './config';
import { fmtSheet, isDate, last10, normalizeUnitType, parseDate, toIso } from './utils';

export interface FollowupEntry {
  n: number;
  at: Date | null;
  text: string;
  by: string;
  /** Original cell text when it cannot be rebuilt exactly from at + text (legacy data). */
  raw?: string;
}

export interface LeadDoc {
  _id: string; // ENQ-0001
  enquiryDate: Date | null;
  name: string;
  phone: string;
  phoneLast10: string;
  email: string;
  stage: string;
  source: string;
  unitType: string;
  purchaseOrRent: string;
  siteVisitStatus: string;
  siteVisitDate: Date | null;
  bookingDate: Date | null;
  nextFollowupAt: Date | null;
  notes: string;
  assignedRm: string;
  brochureShared: string;
  relationship: string;
  enquiredFor: string;
  lastFollowupAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  updatedBy: string;
  followups: FollowupEntry[];
  /** Any non-base header (extra sheet columns) so nothing is lost. */
  extra: Record<string, string>;
}

export interface ArchivedLeadDoc extends LeadDoc {
  archivedAt: Date;
  archivedBy: string;
}

export type UiLead = Record<string, string>;

const L = CFG.LEAD;

/** UI header → document field. */
export const HEADER_TO_FIELD: Record<string, keyof LeadDoc> = {
  [L.ID]: '_id',
  [L.ENQUIRY_DATE]: 'enquiryDate',
  [L.NAME]: 'name',
  [L.PHONE]: 'phone',
  [L.EMAIL]: 'email',
  [L.STAGE]: 'stage',
  [L.SOURCE]: 'source',
  [L.UNIT_TYPE]: 'unitType',
  [L.PURCHASE_OR_RENT]: 'purchaseOrRent',
  [L.SITE_VISIT_STATUS]: 'siteVisitStatus',
  [L.SITE_VISIT_DATE]: 'siteVisitDate',
  [L.BOOKING_DATE]: 'bookingDate',
  [L.NEXT_FOLLOWUP]: 'nextFollowupAt',
  [L.NOTES]: 'notes',
  [L.RM]: 'assignedRm',
  [L.BROCHURE]: 'brochureShared',
  [L.RELATIONSHIP]: 'relationship',
  [L.ENQUIRED_FOR]: 'enquiredFor',
  [L.LAST_FOLLOWUP]: 'lastFollowupAt',
  [L.CREATED_AT]: 'createdAt',
  [L.UPDATED_AT]: 'updatedAt',
  [L.UPDATED_BY]: 'updatedBy',
};

export const FOLLOWUP_RE = /^Follow-up (\d+)$/;
export const followupHeader = (n: number) => `Follow-up ${n}`;
/** The legacy sheet always had 50 follow-up columns; the API keeps reporting at least that many. */
export const LEGACY_FOLLOWUP_COLUMNS = 50;

export const isDateHeader = (h: string) => CFG.LEAD_DATE_FIELDS.includes(h);
export const isBaseHeader = (h: string) => Object.prototype.hasOwnProperty.call(HEADER_TO_FIELD, h);

/* ------------------------------ follow-ups ------------------------------ */

export function formatFollowup(f: FollowupEntry): string {
  if (f.raw !== undefined) return f.raw;
  return f.at ? `${fmtSheet(f.at)} — ${f.text}` : f.text;
}

/** Parse a 'Follow-up N' cell value ("yyyy-MM-dd HH:mm — remark", or any legacy text). */
export function parseFollowup(n: number, value: string, by = ''): FollowupEntry {
  const raw = String(value ?? '').trim();
  const m = raw.match(/^(.+?)\s+[—–-]\s+([\s\S]*)$/);
  const at = m ? parseDate(m[1]) : null;
  const entry: FollowupEntry = { n, at, text: m && at ? m[2] : raw, by };
  if (formatFollowup(entry) !== raw) entry.raw = raw;
  return entry;
}

export const maxFollowupN = (doc: Pick<LeadDoc, 'followups'>) =>
  (doc.followups || []).reduce((mx, f) => Math.max(mx, f.n || 0), 0);

/** First free follow-up slot (gaps in legacy data are filled first, like the sheet did). */
export function nextFollowupSlot(doc: Pick<LeadDoc, 'followups'>) {
  const used = new Set((doc.followups || []).map((f) => f.n));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/* ------------------------------ doc → UI -------------------------------- */

function uiString(header: string, v: unknown): string {
  if (isDateHeader(header)) return toIso(v);
  if (v === null || v === undefined) return '';
  if (header === L.UNIT_TYPE) return normalizeUnitType(v);
  if (isDate(v)) return v.toISOString();
  return typeof v === 'string' ? v.trim() : String(v);
}

/** MongoDB document → UI lead (exactly the keys/format Leads_serialize produced). */
export function toUiLead(doc: LeadDoc | null | undefined): UiLead | null {
  if (!doc) return null;
  const out: UiLead = {};
  for (const h of CFG.LEAD_BASE_HEADERS) out[h] = uiString(h, (doc as any)[HEADER_TO_FIELD[h]]);
  const fus = [...(doc.followups || [])].sort((a, b) => a.n - b.n);
  const max = Math.max(maxFollowupN(doc), 0);
  for (let i = 1; i <= max; i++) out[followupHeader(i)] = '';
  for (const f of fus) out[followupHeader(f.n)] = formatFollowup(f).trim();
  for (const [k, v] of Object.entries(doc.extra || {})) {
    if (out[k] === undefined) out[k] = v === null || v === undefined ? '' : String(v).trim();
  }
  return out;
}

/** Headers for getAllLeads: base headers + Follow-up 1..max(50, most used) + extra keys. */
export function headersFor(docs: Array<Pick<LeadDoc, 'followups' | 'extra'>>): string[] {
  let max = LEGACY_FOLLOWUP_COLUMNS;
  const extras: string[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    max = Math.max(max, maxFollowupN(d));
    for (const k of Object.keys(d.extra || {})) {
      if (!seen.has(k) && !isBaseHeader(k) && !FOLLOWUP_RE.test(k)) {
        seen.add(k);
        extras.push(k);
      }
    }
  }
  const out = CFG.LEAD_BASE_HEADERS.slice();
  for (let i = 1; i <= max; i++) out.push(followupHeader(i));
  return out.concat(extras);
}

/* ------------------------------ UI → doc -------------------------------- */

/** Port of Leads_toCell: undefined = skip, Date|null for date headers, string otherwise. */
export function toCellValue(header: string, value: unknown): Date | null | string | undefined {
  if (value === undefined) return undefined;
  if (isDateHeader(header)) {
    if (value === null || value === '') return null;
    return parseDate(value);
  }
  if (value === null) return '';
  if (header === L.UNIT_TYPE) return normalizeUnitType(value);
  if (typeof value === 'object' && !isDate(value)) return JSON.stringify(value);
  if (isDate(value)) return value.toISOString();
  return String(value);
}

/** Serialised form of a cell value (what the UI would read back) — used for change detection. */
export function cellToUi(header: string, cell: Date | null | string): string {
  if (isDateHeader(header)) return toIso(cell);
  if (isDate(cell)) return cell.toISOString();
  return cell === null ? '' : String(cell).trim();
}

export interface DocPatch {
  /** Base fields (camelCase), including phoneLast10 when the phone changes. `_id` only if supplied. */
  set: Partial<LeadDoc>;
  /** Follow-up N → cell text ('' clears that follow-up). */
  followups: Record<number, string>;
  /** Non-base headers. */
  extra: Record<string, string>;
}

/** Map a header-keyed patch (UI shape) to document fields. Unknown keys go to `extra`. */
export function fromUiPatch(patch: Record<string, unknown>): DocPatch {
  const out: DocPatch = { set: {}, followups: {}, extra: {} };
  for (const k of Object.keys(patch || {})) {
    if (k === '_row' || k.startsWith('_')) continue;
    const cell = toCellValue(k, patch[k]);
    if (cell === undefined) continue;
    const fm = k.match(FOLLOWUP_RE);
    if (fm) {
      out.followups[Number(fm[1])] = cellToUi(k, cell);
      continue;
    }
    const field = HEADER_TO_FIELD[k];
    if (!field) {
      out.extra[k] = cellToUi(k, cell);
      continue;
    }
    if (isDateHeader(k)) (out.set as any)[field] = cell instanceof Date ? cell : null;
    else (out.set as any)[field] = String(cell ?? '').trim();
    if (field === 'phone') out.set.phoneLast10 = last10(out.set.phone);
  }
  return out;
}

/** Apply follow-up cell edits to an entry list (returns a new list sorted by n). */
export function applyFollowupEdits(list: FollowupEntry[], edits: Record<number, string>, by: string): FollowupEntry[] {
  const map = new Map<number, FollowupEntry>((list || []).map((f) => [f.n, f]));
  for (const [nStr, value] of Object.entries(edits)) {
    const n = Number(nStr);
    if (!n || n < 1) continue;
    if (!String(value || '').trim()) map.delete(n);
    else map.set(n, parseFollowup(n, value, by));
  }
  return [...map.values()].sort((a, b) => a.n - b.n);
}

/** An empty lead document (all base fields present). */
export function blankLeadDoc(id: string): LeadDoc {
  return {
    _id: id, enquiryDate: null, name: '', phone: '', phoneLast10: '', email: '', stage: CFG.STAGES.NEW, source: '', unitType: '',
    purchaseOrRent: '', siteVisitStatus: '', siteVisitDate: null, bookingDate: null, nextFollowupAt: null, notes: '', assignedRm: '',
    brochureShared: '', relationship: '', enquiredFor: '', lastFollowupAt: null, createdAt: null, updatedAt: null, updatedBy: '',
    followups: [], extra: {},
  };
}
