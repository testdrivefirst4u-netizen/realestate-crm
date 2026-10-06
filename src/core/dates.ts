/**
 * Amaya CRM — the ONE date/time module.
 *
 * Rules:
 *  - Dates are stored as ISO-8601 strings (UTC) in app state and on the wire.
 *  - All "today / this month / wall-clock" logic is evaluated in the CRM time
 *    zone (Asia/Kolkata), never in the browser's zone and never in UTC.
 *  - Display is always `formatDateTime()` → "01 Oct 2026, 05:30 PM".
 *    Raw strings such as "Thu Oct 01 2026 17:30:00 GMT+0530 (India Standard Time)"
 *    must never reach the UI.
 *  - `parseDate()` accepts every format that has ever appeared in the sheet.
 */
import { APP } from './config';

export type DateInput = Date | string | number | null | undefined;

export interface DateRange {
  start: Date; // inclusive
  end: Date; // inclusive
  label: string;
  key?: string;
}

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'all';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_INDEX: Record<string, number> = {};
MONTHS_SHORT.forEach((m, i) => (MONTH_INDEX[m.toLowerCase()] = i));
MONTHS_LONG.forEach((m, i) => (MONTH_INDEX[m.toLowerCase()] = i));
MONTH_INDEX['sept'] = 8;

let CRM_TZ: string = APP.timeZone;

/** Change the CRM time zone at runtime (from Settings). */
export function setTimeZone(tz: string) {
  if (tz && isValidTimeZone(tz)) {
    CRM_TZ = tz;
    partsFormatterCache.clear();
  }
}
export function getTimeZone() {
  return CRM_TZ;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Time-zone aware primitives                                                */
/* ------------------------------------------------------------------------ */

interface Parts {
  y: number;
  m: number; // 1-12
  d: number;
  h: number; // 0-23
  mi: number;
  s: number;
  weekday: number; // 0 = Sunday
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `d` in the CRM time zone. */
export function getParts(d: Date, tz: string = CRM_TZ): Parts {
  const parts = partsFormatter(tz).formatToParts(d);
  const out: any = {};
  for (const p of parts) out[p.type] = p.value;
  return {
    y: Number(out.year),
    m: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour) % 24,
    mi: Number(out.minute),
    s: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `d`, in milliseconds (IST → +19800000). */
export function tzOffsetMs(d: Date, tz: string = CRM_TZ): number {
  const p = getParts(d, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Build a Date from wall-clock values in the CRM time zone. */
export function makeZoned(
  y: number,
  m: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  tz: string = CRM_TZ
): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let offset = tzOffsetMs(new Date(guess), tz);
  let result = guess - offset;
  // second pass handles DST transitions (no-op for IST)
  const offset2 = tzOffsetMs(new Date(result), tz);
  if (offset2 !== offset) result = guess - offset2;
  return new Date(result);
}

/* ------------------------------------------------------------------------ */
/* Parsing                                                                   */
/* ------------------------------------------------------------------------ */

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
// yyyy-MM-dd[ HH:mm[:ss]]  (sheet / legacy app format, wall clock in CRM TZ)
const RE_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
// dd/MM/yyyy or dd-MM-yyyy or dd.MM.yyyy [HH:mm[:ss]] [AM/PM]
const RE_DMY = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
// dd MMM yyyy[, hh:mm[:ss] [AM/PM]]   e.g. "01 Oct 2026, 05:30 PM"
const RE_DMONY = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
// MMM dd, yyyy[ hh:mm AM/PM]  e.g. "Oct 1, 2026 5:30 PM"
const RE_MONDY = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
// JS Date.toString(): "Thu Oct 01 2026 17:30:00 GMT+0530 (India Standard Time)"
const RE_JS_TOSTRING = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT([+-]\d{4})/;
// Leading timestamp inside follow-up text: "2026-10-01 17:30 — remark"
const RE_LEADING_TS = /^(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/;

function to24h(h: number, ampm?: string): number {
  if (!ampm) return h;
  const isPm = ampm.toLowerCase() === 'pm';
  if (h === 12) return isPm ? 12 : 0;
  return isPm ? h + 12 : h;
}

function validYmd(y: number, m: number, d: number) {
  return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/**
 * Parse anything that might be a date. Returns null for blanks / garbage.
 * Wall-clock strings without zone info are interpreted in the CRM time zone.
 */
export function parseDate(input: DateInput): Date | null {
  if (input === null || input === undefined || input === '') return null;

  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;

  if (typeof input === 'number') {
    if (!isFinite(input)) return null;
    // Excel / Sheets serial number (days since 1899-12-30)
    if (input > 20000 && input < 80000) {
      const ms = Math.round((input - 25569) * 86400 * 1000);
      // serial is wall-clock in sheet TZ → shift
      const utcGuess = new Date(ms);
      return new Date(ms - tzOffsetMs(utcGuess));
    }
    // epoch seconds vs milliseconds
    const d = new Date(input < 1e11 ? input * 1000 : input);
    return isNaN(d.getTime()) ? null : d;
  }

  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s === '-' || s === '—' || /^(n\/?a|none|null|undefined|invalid date)$/i.test(s)) return null;

  // Follow-up text: "2026-10-01 17:30 — Spoke to customer"
  if (s.length > 19 && /—|-\s/.test(s)) {
    const lead = s.match(RE_LEADING_TS);
    if (lead) s = lead[1];
  }

  let m: RegExpMatchArray | null;

  if ((m = s.match(RE_ISO))) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  if ((m = s.match(RE_YMD))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!validYmd(y, mo, d)) return null;
    return makeZoned(y, mo, d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }

  if ((m = s.match(RE_DMY))) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const d = +m[1], mo = +m[2];
    if (!validYmd(y, mo, d)) return null;
    return makeZoned(y, mo, d, m[4] ? to24h(+m[4], m[7]) : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }

  if ((m = s.match(RE_DMONY))) {
    const mo = MONTH_INDEX[m[2].toLowerCase()];
    if (mo === undefined) return null;
    const y = +m[3], d = +m[1];
    if (!validYmd(y, mo + 1, d)) return null;
    return makeZoned(y, mo + 1, d, m[4] ? to24h(+m[4], m[7]) : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }

  if ((m = s.match(RE_MONDY))) {
    const mo = MONTH_INDEX[m[1].toLowerCase()];
    if (mo === undefined) return null;
    const y = +m[3], d = +m[2];
    if (!validYmd(y, mo + 1, d)) return null;
    return makeZoned(y, mo + 1, d, m[4] ? to24h(+m[4], m[7]) : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }

  if ((m = s.match(RE_JS_TOSTRING))) {
    const mo = MONTH_INDEX[m[1].toLowerCase()];
    if (mo === undefined) return null;
    const sign = m[7][0] === '-' ? -1 : 1;
    const offMin = sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10));
    const utc = Date.UTC(+m[3], mo, +m[2], +m[4], +m[5], +m[6]) - offMin * 60_000;
    return new Date(utc);
  }

  // Last resort: native parser (handles RFC 2822 etc.). Reject if it only parsed a number.
  if (/^\d+$/.test(s)) return parseDate(Number(s));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function isValidDate(d: any): d is Date {
  return d instanceof Date && !isNaN(d.getTime());
}

/** ISO string or '' */
export function toIso(input: DateInput): string {
  const d = parseDate(input);
  return d ? d.toISOString() : '';
}

/** Normalise any date-ish value to ISO; keep '' for blanks. Garbage returns '' too. */
export function normalizeDateValue(v: any): string {
  if (v === null || v === undefined || v === '') return '';
  const d = parseDate(v);
  return d ? d.toISOString() : '';
}

/* ------------------------------------------------------------------------ */
/* Formatting                                                                */
/* ------------------------------------------------------------------------ */

const pad2 = (n: number) => (n < 10 ? '0' + n : String(n));

/** "01 Oct 2026, 05:30 PM" */
export function formatDateTime(input: DateInput, fallback = ''): string {
  const d = parseDate(input);
  if (!d) return fallback;
  const p = getParts(d);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${pad2(p.d)} ${MONTHS_SHORT[p.m - 1]} ${p.y}, ${pad2(h12)}:${pad2(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`;
}

/** "01 Oct 2026" */
export function formatDate(input: DateInput, fallback = ''): string {
  const d = parseDate(input);
  if (!d) return fallback;
  const p = getParts(d);
  return `${pad2(p.d)} ${MONTHS_SHORT[p.m - 1]} ${p.y}`;
}

/** "05:30 PM" */
export function formatTime(input: DateInput, fallback = ''): string {
  const d = parseDate(input);
  if (!d) return fallback;
  const p = getParts(d);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${pad2(h12)}:${pad2(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`;
}

/** "Today, 05:30 PM" / "Yesterday, 11:00 AM" / "Tomorrow, 09:00 AM" / "01 Oct 2026, 05:30 PM" */
export function formatRelative(input: DateInput, fallback = ''): string {
  const d = parseDate(input);
  if (!d) return fallback;
  const key = dateKey(d);
  const today = todayKey();
  if (key === today) return `Today, ${formatTime(d)}`;
  if (key === dateKey(addDays(startOfToday(), -1))) return `Yesterday, ${formatTime(d)}`;
  if (key === dateKey(addDays(startOfToday(), 1))) return `Tomorrow, ${formatTime(d)}`;
  return formatDateTime(d);
}

/** "3 days ago", "in 2 hrs", "just now" */
export function formatDistance(input: DateInput, now: Date = new Date()): string {
  const d = parseDate(input);
  if (!d) return '';
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  let txt: string;
  if (abs < 60_000) return 'just now';
  else if (abs < 3_600_000) txt = unit(Math.round(abs / 60_000), 'min');
  else if (abs < 86_400_000) txt = unit(Math.round(abs / 3_600_000), 'hr');
  else if (abs < 30 * 86_400_000) txt = unit(Math.round(abs / 86_400_000), 'day');
  else if (abs < 365 * 86_400_000) txt = unit(Math.round(abs / (30 * 86_400_000)), 'month');
  else txt = unit(Math.round(abs / (365 * 86_400_000)), 'year');
  return future ? `in ${txt}` : `${txt} ago`;
}

/** 'yyyy-MM-dd HH:mm' wall clock in CRM TZ — the stored format of follow-up remarks. */
export function toSheetDateTime(input: DateInput): string {
  const d = parseDate(input);
  if (!d) return '';
  const p = getParts(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

/** 'yyyy-MM-dd' wall clock in CRM TZ */
export function dateKey(input: DateInput): string {
  const d = parseDate(input);
  if (!d) return '';
  const p = getParts(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** 'yyyy-MM' wall clock in CRM TZ */
export function monthKey(input: DateInput): string {
  const d = parseDate(input);
  if (!d) return '';
  const p = getParts(d);
  return `${p.y}-${pad2(p.m)}`;
}

/** 'Oct 2026' from '2026-10' */
export function monthLabel(key: string, long = false): string {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return key;
  const idx = +m[2] - 1;
  return `${(long ? MONTHS_LONG : MONTHS_SHORT)[idx]} ${m[1]}`;
}

/** 'October' */
export function monthName(key: string): string {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return key;
  return MONTHS_LONG[+m[2] - 1];
}

/* ------------------------------------------------------------------------ */
/* Calendar arithmetic (CRM time zone)                                       */
/* ------------------------------------------------------------------------ */

export function todayKey(): string {
  return dateKey(new Date());
}

export function currentMonthKey(): string {
  return monthKey(new Date());
}

export function startOfDay(input: DateInput): Date {
  const d = parseDate(input) || new Date();
  const p = getParts(d);
  return makeZoned(p.y, p.m, p.d, 0, 0, 0);
}

export function endOfDay(input: DateInput): Date {
  const d = parseDate(input) || new Date();
  const p = getParts(d);
  return new Date(makeZoned(p.y, p.m, p.d + 1, 0, 0, 0).getTime() - 1);
}

export function startOfToday(): Date {
  return startOfDay(new Date());
}

export function addDays(input: DateInput, days: number): Date {
  const d = parseDate(input) || new Date();
  const p = getParts(d);
  return makeZoned(p.y, p.m, p.d + days, p.h, p.mi, p.s);
}

export function addMonths(input: DateInput, months: number): Date {
  const d = parseDate(input) || new Date();
  const p = getParts(d);
  return makeZoned(p.y, p.m + months, Math.min(p.d, 28), p.h, p.mi, p.s);
}

export function startOfMonth(input: DateInput): Date {
  const d = parseDate(input) || new Date();
  const p = getParts(d);
  return makeZoned(p.y, p.m, 1);
}

export function endOfMonth(input: DateInput): Date {
  const d = parseDate(input) || new Date();
  const p = getParts(d);
  return new Date(makeZoned(p.y, p.m + 1, 1).getTime() - 1);
}

/** Monday-based week */
export function startOfWeek(input: DateInput): Date {
  const d = startOfDay(input);
  const wd = getParts(d).weekday; // 0 Sun..6 Sat
  const back = wd === 0 ? 6 : wd - 1;
  return addDays(d, -back);
}

export function startOfQuarter(input: DateInput): Date {
  const d = parseDate(input) || new Date();
  const p = getParts(d);
  const qm = Math.floor((p.m - 1) / 3) * 3 + 1;
  return makeZoned(p.y, qm, 1);
}

export function startOfYear(input: DateInput): Date {
  const d = parseDate(input) || new Date();
  return makeZoned(getParts(d).y, 1, 1);
}

/** Range for a 'yyyy-MM' key */
export function monthRange(key: string): DateRange {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const y = m ? +m[1] : getParts(now).y;
  const mo = m ? +m[2] : getParts(now).m;
  const start = makeZoned(y, mo, 1);
  const end = new Date(makeZoned(y, mo + 1, 1).getTime() - 1);
  return { start, end, label: monthLabel(key), key };
}

export function previousMonthKey(key: string): string {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return key;
  let y = +m[1], mo = +m[2] - 1;
  if (mo < 1) { mo = 12; y -= 1; }
  return `${y}-${pad2(mo)}`;
}

/** Ascending list of month keys from `fromKey` to `toKey` inclusive. */
export function listMonths(fromKey: string, toKey: string): string[] {
  const a = fromKey.match(/^(\d{4})-(\d{2})$/);
  const b = toKey.match(/^(\d{4})-(\d{2})$/);
  if (!a || !b) return [];
  const out: string[] = [];
  let y = +a[1], mo = +a[2];
  const ey = +b[1], em = +b[2];
  let guard = 0;
  while ((y < ey || (y === ey && mo <= em)) && guard++ < 600) {
    out.push(`${y}-${pad2(mo)}`);
    mo++;
    if (mo > 12) { mo = 1; y++; }
  }
  return out;
}

export function inRange(input: DateInput, range: DateRange | null | undefined): boolean {
  if (!range) return true;
  const d = parseDate(input);
  if (!d) return false;
  const t = d.getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}

export function isSameDay(a: DateInput, b: DateInput): boolean {
  const ka = dateKey(a), kb = dateKey(b);
  return !!ka && ka === kb;
}

export function hoursBetween(a: DateInput, b: DateInput): number | null {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return null;
  return (db.getTime() - da.getTime()) / 3_600_000;
}

export function daysBetween(a: DateInput, b: DateInput): number | null {
  const h = hoursBetween(a, b);
  return h === null ? null : h / 24;
}

/** Whole calendar days since `input` (CRM TZ), 0 for today, negative for future. */
export function daysSince(input: DateInput, now: Date = new Date()): number | null {
  const d = parseDate(input);
  if (!d) return null;
  return Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000);
}

export function getPresetRange(preset: RangePreset, now: Date = new Date()): DateRange | null {
  const today0 = startOfDay(now);
  switch (preset) {
    case 'today':
      return { start: today0, end: endOfDay(now), label: 'Today', key: preset };
    case 'yesterday': {
      const y = addDays(today0, -1);
      return { start: y, end: endOfDay(y), label: 'Yesterday', key: preset };
    }
    case 'this_week': {
      const s = startOfWeek(now);
      return { start: s, end: endOfDay(addDays(s, 6)), label: 'This Week', key: preset };
    }
    case 'last_week': {
      const s = addDays(startOfWeek(now), -7);
      return { start: s, end: endOfDay(addDays(s, 6)), label: 'Last Week', key: preset };
    }
    case 'this_month':
      return { start: startOfMonth(now), end: endOfMonth(now), label: 'This Month', key: preset };
    case 'last_month': {
      const lm = addMonths(startOfMonth(now), -1);
      return { start: lm, end: endOfMonth(lm), label: 'Last Month', key: preset };
    }
    case 'this_quarter': {
      const s = startOfQuarter(now);
      return { start: s, end: new Date(addMonths(s, 3).getTime() - 1), label: 'This Quarter', key: preset };
    }
    case 'last_quarter': {
      const s = addMonths(startOfQuarter(now), -3);
      return { start: s, end: new Date(addMonths(s, 3).getTime() - 1), label: 'Last Quarter', key: preset };
    }
    case 'this_year':
      return { start: startOfYear(now), end: endOfDay(now), label: 'This Year', key: preset };
    case 'last_7_days':
      return { start: addDays(today0, -6), end: endOfDay(now), label: 'Last 7 Days', key: preset };
    case 'last_30_days':
      return { start: addDays(today0, -29), end: endOfDay(now), label: 'Last 30 Days', key: preset };
    case 'last_90_days':
      return { start: addDays(today0, -89), end: endOfDay(now), label: 'Last 90 Days', key: preset };
    case 'all':
    default:
      return null;
  }
}

export const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: 'all', label: 'All Time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'this_week', label: 'This Week' },
  { id: 'last_week', label: 'Last Week' },
  { id: 'this_month', label: 'This Month' },
  { id: 'last_month', label: 'Last Month' },
  { id: 'this_quarter', label: 'This Quarter' },
  { id: 'last_7_days', label: 'Last 7 Days' },
  { id: 'last_30_days', label: 'Last 30 Days' },
];

export function customRange(fromKey: string, toKey: string): DateRange | null {
  const s = fromKey ? parseDate(fromKey) : null;
  const e = toKey ? parseDate(toKey) : null;
  if (!s && !e) return null;
  const start = s ? startOfDay(s) : new Date(0);
  const end = e ? endOfDay(e) : new Date(8.64e15);
  return { start, end, label: `${s ? formatDate(s) : '…'} → ${e ? formatDate(e) : '…'}`, key: 'custom' };
}

/* ------------------------------------------------------------------------ */
/* <input type="datetime-local"> / <input type="date"> helpers              */
/* ------------------------------------------------------------------------ */

/** Value for <input type="datetime-local"> showing CRM wall-clock time. */
export function toDatetimeLocalInput(input: DateInput): string {
  const d = parseDate(input);
  if (!d) return '';
  const p = getParts(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
}

/** Parse <input type="datetime-local"> value (CRM wall clock) → ISO. */
export function fromDatetimeLocalInput(value: string): string {
  if (!value) return '';
  const d = parseDate(value.replace('T', ' '));
  return d ? d.toISOString() : '';
}

/** Value for <input type="date"> */
export function toDateInput(input: DateInput): string {
  return dateKey(input);
}

/** Parse <input type="date"> value → ISO at 00:00 CRM time. */
export function fromDateInput(value: string): string {
  if (!value) return '';
  const d = parseDate(value);
  return d ? d.toISOString() : '';
}

/** Sort comparator on a date field (invalid/blank dates sort last). */
export function compareDates(a: DateInput, b: DateInput, asc = true): number {
  const da = parseDate(a), db = parseDate(b);
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return asc ? da.getTime() - db.getTime() : db.getTime() - da.getTime();
}

/** Extract the timestamp prefix and remark text from a follow-up cell value. */
export function splitFollowupEntry(value: string): { date: Date | null; text: string } {
  const s = String(value || '').trim();
  if (!s) return { date: null, text: '' };
  const m = s.match(/^(.+?)\s+[—–-]\s+([\s\S]*)$/);
  if (m) {
    const d = parseDate(m[1]);
    if (d) return { date: d, text: m[2].trim() };
  }
  const lead = s.match(RE_LEADING_TS);
  if (lead) {
    const d = parseDate(lead[1]);
    return { date: d, text: s.slice(lead[1].length).replace(/^\s*[—–-]\s*/, '').trim() };
  }
  return { date: null, text: s };
}

export function nowIso(): string {
  return new Date().toISOString();
}
