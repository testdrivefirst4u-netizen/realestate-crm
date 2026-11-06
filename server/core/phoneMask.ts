/**
 * Hiding customers' phone numbers from a role (Settings › Roles & access › See phone numbers).
 *
 * Done once, where every answer leaves the server (server/router.ts), so no screen, report, export or free-text remark can
 * carry a number past it. A hidden number reads 98•••••34, followed by an encrypted reference in invisible characters. The
 * browser never has the number, but can still hand the reference back: the router swaps it for the real number on the way
 * in, so calling through the CRM, WhatsApp and saving a lead keep working, and the same person always has the same reference.
 */
import crypto from 'crypto';
import { fail } from './errors';
import { currentTenant } from './tenant';

const SYMBOLS = ['​', '‌', '‍', '⁠'];
const DOT = '•';
const IV_BYTES = 6;

/** A number in running text: Indian mobiles, written the usual ways. Longer ids and anything inside a word are left alone. */
const NUMBER_IN_TEXT = /(?<![\w•+])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\w)/g;
const WHOLE_NUMBER = /^(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}$/;
const HIDDEN = /\+?\d{0,2}•{3,}\d{0,2}[​‌‍⁠]+/g;
/** Fields that hold a phone number whatever its format, which also catches numbers from other countries. */
const PHONE_FIELD = /phone|mobile/i;
const NOT_A_NUMBER_FIELD = /id$/i;

function key(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY?.trim() || (process.env.NODE_ENV !== 'production' ? 'amaya-dev-only-key' : '');
  if (!raw) throw fail('NOT_CONFIGURED', 'SECRETS_ENCRYPTION_KEY is not set on the server.');
  return crypto.createHash('sha256').update(`phone-mask\n${currentTenant()?.id || ''}\n${raw}`).digest();
}

/** The same person written +91 98765 43210 or 09876543210 must come out the same. */
function canonical(raw: string): string {
  let d = raw.replace(/\D/g, '').replace(/^00/, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return d;
}

const ivFor = (k: Buffer, digits: string) => crypto.createHmac('sha256', k).update(digits).digest().subarray(0, IV_BYTES);
const counter = (iv: Buffer) => Buffer.concat([iv, Buffer.alloc(16 - IV_BYTES)]);

function hideDigits(digits: string): string {
  const k = key();
  const iv = ivFor(k, digits);
  const packed = Buffer.from(digits.length % 2 ? digits + 'f' : digits, 'hex');
  const c = crypto.createCipheriv('aes-256-ctr', k, counter(iv));
  const bytes = Buffer.concat([iv, c.update(packed), c.final()]);
  let tail = '';
  for (const b of bytes) tail += SYMBOLS[b >> 6] + SYMBOLS[(b >> 4) & 3] + SYMBOLS[(b >> 2) & 3] + SYMBOLS[b & 3];
  return `${digits.slice(0, 2)}${DOT.repeat(5)}${digits.slice(-2)}${tail}`;
}

function revealDigits(hidden: string): string | null {
  const symbols = [...hidden].map((ch) => SYMBOLS.indexOf(ch)).filter((i) => i >= 0);
  if (symbols.length % 4 || symbols.length / 4 <= IV_BYTES) return null;
  const bytes = Buffer.alloc(symbols.length / 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (symbols[i * 4] << 6) | (symbols[i * 4 + 1] << 4) | (symbols[i * 4 + 2] << 2) | symbols[i * 4 + 3];
  const k = key();
  const iv = bytes.subarray(0, IV_BYTES);
  const d = crypto.createDecipheriv('aes-256-ctr', k, counter(iv));
  const digits = Buffer.concat([d.update(bytes.subarray(IV_BYTES)), d.final()]).toString('hex').replace(/f$/, '');
  if (!/^\d+$/.test(digits) || !crypto.timingSafeEqual(ivFor(k, digits), iv)) return null; // not ours, or changed on the way
  return digits;
}

export const hidePhone = (raw: string): string => hideDigits(canonical(raw));

/** Every number in a piece of text hidden. */
export function hidePhonesInText(text: string): string {
  return text.replace(NUMBER_IN_TEXT, (m) => hidePhone(m));
}

const isPlain = (v: object) => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

function hideField(value: string): string {
  const inText = hidePhonesInText(value);
  if (inText !== value) return inText;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 && !value.includes(DOT) ? hidePhone(value) : value;
}

/** A copy of an answer with every customer number hidden. Dates, ids and other values pass through untouched. */
export function hidePhonesDeep(value: any, field = ''): any {
  if (typeof value === 'string') return field && PHONE_FIELD.test(field) && !NOT_A_NUMBER_FIELD.test(field) ? hideField(value) : hidePhonesInText(value);
  if (typeof value === 'number') return field && PHONE_FIELD.test(field) && !NOT_A_NUMBER_FIELD.test(field) && value >= 1000000 ? hideField(String(value)) : value;
  if (Array.isArray(value)) return value.map((v) => hidePhonesDeep(v, field));
  if (value && typeof value === 'object' && isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[WHOLE_NUMBER.test(k) ? hidePhone(k) : k] = hidePhonesDeep(v, k);
    return out;
  }
  return value;
}

function revealText(text: string): string {
  return text.replace(HIDDEN, (m) => {
    const digits = revealDigits(m);
    if (!digits) return m;
    return digits.length > 10 ? `+${digits}` : digits;
  });
}

/** What the browser sent, with its hidden numbers back to the real ones. A hidden number that was changed by hand is refused. */
export function revealPhonesDeep(value: any, field = ''): any {
  if (typeof value === 'string') {
    if (!value.includes(DOT)) return value;
    const out = revealText(value);
    if (out.includes(DOT) && PHONE_FIELD.test(field)) throw fail('VALIDATION', 'This phone number is hidden. Leave it as it is, or type the full new number.');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => revealPhonesDeep(v, field));
  if (value && typeof value === 'object' && isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[revealText(k)] = revealPhonesDeep(v, k);
    return out;
  }
  return value;
}
