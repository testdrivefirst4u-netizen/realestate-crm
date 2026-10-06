/**
 * Shared server utilities — port of apps-script/01_Utils.gs (U_*).
 * Dates: wall-clock strings without a zone are interpreted in the CRM time zone.
 */
import crypto from 'node:crypto';
import { CFG } from './config';

export const tz = () => CFG.TIME_ZONE;

export function isDate(v: unknown): v is Date {
  return v instanceof Date && !isNaN(v.getTime());
}

/** Wall-clock parts of instant `d` in time zone `zone`. */
function zonedParts(d: Date, zone = tz()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(d)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** Offset of the CRM zone at instant d, in ms. */
export function tzOffsetMs(d: Date) {
  const p = zonedParts(d);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

export function makeZoned(y: number, m: number, d: number, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off = tzOffsetMs(new Date(guess));
  return new Date(guess - off);
}

function monthIndex(name: string) {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(name || '').slice(0, 3).toLowerCase());
}
function to24h(h: number, ampm?: string) {
  if (!ampm) return h;
  const pm = ampm.toLowerCase() === 'pm';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

/**
 * Parse anything into a Date or null: ISO, 'yyyy-MM-dd HH:mm', dd/MM/yyyy, 'dd MMM yyyy, hh:mm a',
 * 'MMM dd, yyyy', JS Date.toString() output, epoch numbers and Sheets serial numbers.
 */
export function parseDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (isDate(v)) return v;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      const ms = Math.round((v - 25569) * 86400000);
      return new Date(ms - tzOffsetMs(new Date(ms)));
    }
    const d = new Date(v < 1e11 ? v * 1000 : v);
    return isNaN(d.getTime()) ? null : d;
  }
  let s = String(v).trim();
  if (!s || /^(n\/?a|none|null|undefined|-|—|invalid date)$/i.test(s)) return null;
  const lead = s.match(/^(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)\s+[—–-]\s/);
  if (lead) s = lead[1];
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/))) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) {
    return makeZoned(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/))) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return makeZoned(y, +m[2], +m[1], m[4] ? to24h(+m[4], m[7]) : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/))) {
    const mo = monthIndex(m[2]);
    if (mo < 0) return null;
    return makeZoned(+m[3], mo + 1, +m[1], m[4] ? to24h(+m[4], m[7]) : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/))) {
    const mo = monthIndex(m[1]);
    if (mo < 0) return null;
    return makeZoned(+m[3], mo + 1, +m[2], m[4] ? to24h(+m[4], m[7]) : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }
  if ((m = s.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT([+-]\d{4})/))) {
    const mo = monthIndex(m[1]);
    if (mo < 0) return null;
    const sign = m[7][0] === '-' ? -1 : 1;
    const offMin = sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10));
    return new Date(Date.UTC(+m[3], mo, +m[2], +m[4], +m[5], +m[6]) - offMin * 60000);
  }
  if (/^\d+$/.test(s)) return parseDate(Number(s));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** ISO 8601 UTC string, or ''. */
export function toIso(v: unknown) {
  const d = parseDate(v);
  return d ? d.toISOString() : '';
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'yyyy-MM-dd HH:mm' wall clock — the legacy text format used inside follow-up entries. */
export function fmtSheet(v: unknown) {
  const d = parseDate(v);
  if (!d) return '';
  const p = zonedParts(d);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

/** 'dd MMM yyyy, hh:mm AM' — human display (emails, digests). */
export function fmtHuman(v: unknown) {
  const d = parseDate(v);
  if (!d) return '';
  const p = zonedParts(d);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${pad(p.d)} ${MONTHS[p.mo - 1]} ${p.y}, ${pad(h12)}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`;
}

export function fmtDate(v: unknown) {
  const d = parseDate(v);
  if (!d) return '';
  const p = zonedParts(d);
  return `${pad(p.d)} ${MONTHS[p.mo - 1]} ${p.y}`;
}

/** 'yyyy-MM-dd' in the CRM zone. */
export function dateKey(v: unknown) {
  const d = parseDate(v);
  if (!d) return '';
  const p = zonedParts(d);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export const nowIso = () => new Date().toISOString();

/** String value (dates → ISO). */
export function str(v: unknown) {
  if (v === null || v === undefined) return '';
  if (isDate(v)) return v.toISOString();
  return String(v).trim();
}

export function bool(v: unknown) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}

export function num(v: unknown, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return isNaN(n) ? fallback : n;
}

export const uuid = () => crypto.randomUUID();

export function shortId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex').slice(0, 5)}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars.charAt(buf[i] % chars.length);
  return out;
}

export function sha256Hex(text: string) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
export function sha256Base64(text: string) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** Canonical unit-type spelling: "1 BHK", "2.5 BHK", "3 BHK-A" … */
export function normalizeUnitType(v: unknown) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  if (/^(unit\s*type(\s*interested\s*in)?|select|choose|none|n\/?a|-+)$/i.test(s)) return '';
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*[-–—_ ]*\s*b\.?\s*h\.?\s*k\.?/i);
  if (!m) return s.replace(/\s+/g, ' ');
  let n = String(m[1]).replace(',', '.');
  if (/^\d+\.0+$/.test(n)) n = n.replace(/\.0+$/, '');
  const rest = s.replace(m[0], ' ');
  const variant = rest.match(/(?:^|[\s\-–—_(/:]|type\s*)([abcd])(?=$|[\s)\]/:.,-])/i);
  return n + ' BHK' + (variant ? '-' + variant[1].toUpperCase() : '');
}

export function dedupeUnitTypes(list: unknown[]) {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  (list || []).forEach((v) => {
    const n = normalizeUnitType(v);
    if (n && !seen[n]) {
      seen[n] = true;
      out.push(n);
    }
  });
  const key = (t: string): [number, number, string] => {
    const m = t.match(/^(\d+(?:\.\d+)?) BHK(?:-([A-D]))?$/);
    return m ? [0, parseFloat(m[1]), m[2] || ''] : [1, 0, t];
  };
  return out.sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
  });
}

export const digits = (phone: unknown) => String(phone ?? '').replace(/\D/g, '');
export function last10(phone: unknown) {
  const d = digits(phone);
  return d.length >= 10 ? d.slice(-10) : d;
}
export function e164(phone: unknown) {
  let d = digits(phone);
  if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  if (d.length === 10) return '91' + d;
  return d;
}
export function samePhone(a: unknown, b: unknown) {
  const x = last10(a), y = last10(b);
  return !!x && x.length === 10 && x === y;
}

export function safeJsonParse<T = any>(s: unknown, fallback: T | null = null): T | null {
  try {
    return JSON.parse(String(s));
  } catch {
    return fallback;
  }
}

export function maskSecret(s: unknown) {
  const v = String(s || '');
  if (!v) return '';
  if (v.length <= 6) return '••••';
  return '••••••••' + v.slice(-4);
}

export function truncate(s: unknown, n: number) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Escape a value for CSV export so spreadsheet apps never treat it as a formula. */
export function csvSafe(v: unknown) {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** Escape a user-supplied string for use inside a RegExp. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
