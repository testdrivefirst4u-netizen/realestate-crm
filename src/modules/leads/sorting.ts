/**
 * Lead sorting — one implementation for All Leads, Enquiry Status and Follow-ups.
 *
 * Why the tie-breaks matter: most Enquiry Dates in the sheet are date-only
 * (00:00 IST), so a plain date sort leaves every same-day enquiry in whatever
 * order the sheet returned them and a fresh ENQ-0612 can sit under ENQ-0480.
 * Every key therefore ends in a deterministic chain:
 *
 *   enquiryDate   Enquiry Date → Created At → Enquiry ID number → name (all but name follow the direction)
 *   nextDue       Next Follow-up Date → enquiry recency, newest first (whatever the direction)
 *   lastActivity  last contact (or Enquiry Date) → enquiry recency in the same direction
 *   text keys     value (numeric-aware, case-insensitive) → enquiry recency, newest first
 *   id            Enquiry ID number → full ID text
 *
 * Blank / unparseable values always sort last, in both directions. The sort is
 * stable (original position is the final tie-break) and never mutates its input.
 * Keys are computed once per lead (decorate–sort–undecorate), so date parsing
 * does not run inside the comparator.
 */
import { Lead } from '../../types/crm';
import { F } from '../../core/config';
import { enquiryDate, lastActivityDate, nextFollowupDate } from '../../core/analytics';
import { parseDate } from '../../core/dates';

export type LeadSortKey = 'enquiryDate' | 'nextDue' | 'lastActivity' | 'name' | 'stage' | 'unit' | 'rm' | 'id';

export interface SortOption {
  key: LeadSortKey;
  label: string;
}

export const SORT_OPTIONS: SortOption[] = [
  { key: 'enquiryDate', label: 'Enquiry date' },
  { key: 'nextDue', label: 'Next follow-up' },
  { key: 'lastActivity', label: 'Last contact' },
  { key: 'name', label: 'Prospect name' },
  { key: 'stage', label: 'Stage' },
  { key: 'unit', label: 'Unit type' },
  { key: 'rm', label: 'Assigned RM' },
  { key: 'id', label: 'Enquiry ID' },
];

/** Lead field behind each plain-text key (the All Leads SORT_FIELDS behaviour). */
const TEXT_FIELDS: Record<'name' | 'stage' | 'unit' | 'rm', string> = {
  name: F.NAME,
  stage: F.STAGE,
  unit: F.UNIT_TYPE,
  rm: F.RM,
};

export function isLeadSortKey(value: unknown): value is LeadSortKey {
  return SORT_OPTIONS.some((o) => o.key === value);
}

/** Direction a key starts in when it is picked: dates newest first, due dates soonest first, text A → Z. */
export function defaultSortAsc(key: LeadSortKey): boolean {
  switch (key) {
    case 'enquiryDate':
    case 'id':
      return false; // newest first
    case 'lastActivity':
      return true; // longest without contact first — the actionable end for follow-ups
    default:
      return true; // nextDue soonest first, text A → Z
  }
}

/** Human wording of a direction, e.g. for the sort button's tooltip. */
export function sortDirectionLabel(key: LeadSortKey, asc: boolean): string {
  switch (key) {
    case 'enquiryDate':
      return asc ? 'Oldest first' : 'Newest first';
    case 'nextDue':
      return asc ? 'Soonest first' : 'Latest first';
    case 'lastActivity':
      return asc ? 'Longest ago first' : 'Most recent first';
    case 'id':
      return asc ? 'Lowest ID first' : 'Highest ID first';
    default:
      return asc ? 'A → Z' : 'Z → A';
  }
}

/** Number at the end of an Enquiry ID ("ENQ-0612" → 612), the same rule the ID generators use. */
export function leadIdNumber(lead: Lead): number | null {
  const m = String(lead[F.ID] ?? '').match(/(\d+)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------------ */
/* Comparators                                                               */
/* ------------------------------------------------------------------------ */

type Dir = 1 | -1;
const NEWEST_FIRST: Dir = -1;

/** Equivalent to `a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })`, built once. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

interface Row {
  lead: Lead;
  index: number;
  /** Value of the chosen key: a timestamp for date keys, trimmed text for text keys (unused for 'enquiryDate' / 'id'). */
  value: number | string | null;
  enquiry: number | null;
  created: number | null;
  idNum: number | null;
  idText: string;
  name: string;
}

const time = (d: Date | null): number | null => (d ? d.getTime() : null);
const text = (v: unknown): string => String(v ?? '').trim();

/** Nullable numbers; null always last. */
function byNumber(a: number | null, b: number | null, dir: Dir): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  if (a === b) return 0;
  return a < b ? -dir : dir;
}

/** Text with numeric-aware, case-insensitive collation; empty always last. */
function byText(a: string, b: string, dir: Dir): number {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return dir * COLLATOR.compare(a, b);
}

/** Enquiry recency: Enquiry Date → Created At → Enquiry ID number. */
function byRecency(a: Row, b: Row, dir: Dir): number {
  return byNumber(a.enquiry, b.enquiry, dir) || byNumber(a.created, b.created, dir) || byNumber(a.idNum, b.idNum, dir);
}

/** Last resort: name A → Z, then original position (stability). */
function byNameThenPosition(a: Row, b: Row): number {
  return byText(a.name, b.name, 1) || a.index - b.index;
}

function toRow(lead: Lead, index: number, key: LeadSortKey): Row {
  let value: number | string | null = null;
  if (key === 'nextDue') value = time(nextFollowupDate(lead));
  else if (key === 'lastActivity') value = time(lastActivityDate(lead) || enquiryDate(lead));
  else if (key === 'name' || key === 'stage' || key === 'unit' || key === 'rm') value = text(lead[TEXT_FIELDS[key]]);
  return {
    lead,
    index,
    value,
    enquiry: time(enquiryDate(lead)),
    created: time(parseDate(lead[F.CREATED_AT])),
    idNum: leadIdNumber(lead),
    idText: text(lead[F.ID]),
    name: text(lead[F.NAME]),
  };
}

function comparator(key: LeadSortKey, asc: boolean): (a: Row, b: Row) => number {
  const dir: Dir = asc ? 1 : -1;
  switch (key) {
    case 'enquiryDate':
      return (a, b) => byRecency(a, b, dir) || byNameThenPosition(a, b);
    case 'nextDue':
      return (a, b) => byNumber(a.value as number | null, b.value as number | null, dir) || byRecency(a, b, NEWEST_FIRST) || byNameThenPosition(a, b);
    case 'lastActivity':
      return (a, b) => byNumber(a.value as number | null, b.value as number | null, dir) || byRecency(a, b, dir) || byNameThenPosition(a, b);
    case 'id':
      return (a, b) => byNumber(a.idNum, b.idNum, dir) || byText(a.idText, b.idText, dir) || a.index - b.index;
    default:
      return (a, b) => byText(a.value as string, b.value as string, dir) || byRecency(a, b, NEWEST_FIRST) || byNameThenPosition(a, b);
  }
}

/**
 * Sorted copy of `list` (stable; the input array is not touched).
 * An unknown key falls back to Enquiry date so a stale stored preference cannot break a view.
 */
export function sortLeads(list: readonly Lead[], key: LeadSortKey, asc: boolean): Lead[] {
  const k: LeadSortKey = isLeadSortKey(key) ? key : 'enquiryDate';
  const rows = list.map((lead, i) => toRow(lead, i, k));
  rows.sort(comparator(k, asc));
  return rows.map((r) => r.lead);
}

/* ------------------------------------------------------------------------ */
/* Remembered choice (per view, this browser only)                           */
/* ------------------------------------------------------------------------ */

export interface SortPref {
  key: LeadSortKey;
  asc: boolean;
}

export const SORT_PREF_KEYS = {
  kanban: 'amaya.sort.kanban',
  followups: 'amaya.sort.followups',
} as const;

/** Parse a stored preference; anything missing, corrupt or not offered by the view → `fallback`. */
export function parseSortPref(raw: string | null | undefined, fallback: SortPref, allowed?: readonly LeadSortKey[]): SortPref {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    if (v && isLeadSortKey(v.key) && typeof v.asc === 'boolean' && (!allowed || allowed.includes(v.key))) return { key: v.key, asc: v.asc };
  } catch {
    /* corrupt value — use the default */
  }
  return fallback;
}

export function loadSortPref(storageKey: string, fallback: SortPref, allowed?: readonly LeadSortKey[]): SortPref {
  try {
    return parseSortPref(localStorage.getItem(storageKey), fallback, allowed);
  } catch {
    return fallback; // storage unavailable (private mode, blocked, server render)
  }
}

export function saveSortPref(storageKey: string, pref: SortPref): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ key: pref.key, asc: pref.asc }));
  } catch {
    /* storage unavailable or full — the choice simply is not remembered */
  }
}
