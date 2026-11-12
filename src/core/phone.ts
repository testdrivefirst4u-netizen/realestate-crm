/** Phone-number helpers (India-first). One implementation for the whole app. */

/** A number the server hid from this user's role (server/core/phoneMask.ts). It can be shown and sent back, not dialled. */
export function isMaskedPhone(phone: unknown): boolean {
  return String(phone ?? '').includes('•');
}

/** Digits only. */
export function digitsOnly(phone: string | undefined | null): string {
  return String(phone || '').replace(/\D/g, '');
}

/** Last 10 digits — the stable key for matching the same customer across systems. */
export function last10(phone: string | undefined | null): string {
  if (isMaskedPhone(phone)) return String(phone).trim(); // still one person's key: the server gives each person one hidden form
  const d = digitsOnly(phone);
  return d.length >= 10 ? d.slice(-10) : d;
}

/** E.164 without '+', e.g. 919849012345. Assumes India when 10 digits. */
export function toE164Digits(phone: string | undefined | null): string {
  if (isMaskedPhone(phone)) return String(phone).trim();
  let d = digitsOnly(phone);
  if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  if (d.length === 10) return '91' + d;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('91')) return d; // malformed but keep
  return d;
}

/** "+91 98490 12345" */
export function formatPhone(phone: string | undefined | null): string {
  const e = toE164Digits(phone);
  if (e.length === 12 && e.startsWith('91')) {
    return `+91 ${e.slice(2, 7)} ${e.slice(7)}`;
  }
  // an international number written with its country code: "+971 50 123 4567"-style groups
  const raw = String(phone || '').trim();
  if (/^\+/.test(raw) && !isMaskedPhone(raw)) {
    const d = digitsOnly(raw);
    const cc = countryCode(d);
    const rest = d.slice(cc.length);
    const groups = rest.length === 10 ? [3, 3, 4] : rest.length === 9 ? [2, 3, 4] : rest.length === 8 ? [4, 4] : null;
    if (!groups) return `+${cc} ${rest}`;
    let i = 0;
    return `+${cc} ${groups.map((n) => rest.slice(i, (i += n))).join(' ')}`;
  }
  return raw;
}

const CC3 = ['971', '966', '974', '973', '968', '965', '880', '977', '960', '353', '852'];
const CC2 = ['91', '44', '61', '65', '60', '49', '33', '39', '31', '41', '81', '86', '27', '64', '92', '94', '62', '63', '66', '34', '46', '47', '45', '32'];
function countryCode(d: string): string {
  if (CC3.includes(d.slice(0, 3))) return d.slice(0, 3);
  if (CC2.includes(d.slice(0, 2))) return d.slice(0, 2);
  if (d.startsWith('1') || d.startsWith('7')) return d[0];
  return d.slice(0, 2);
}

/** Written with an explicit country code (+…, 00…, or more than 10 digits). */
const explicitCountry = (p: string) => /^\s*(\+|00)/.test(p) || (digitsOnly(p).length > 10 && !(digitsOnly(p).length === 11 && digitsOnly(p).startsWith('0')));

/**
 * Same customer number? The last ten digits narrow it; the country decides — a +1 / +44 / +971 family number is
 * never the Indian number with the same ten digits (mirrors server/core/phone.ts → sameIdentity).
 */
export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const la = last10(a), lb = last10(b);
  if (!(!!la && (la.length === 10 || isMaskedPhone(la)) && la === lb)) return false;
  if (isMaskedPhone(la)) return true;
  const ea = toE164Digits(a), eb = toE164Digits(b);
  if (ea === eb) return true;
  const xa = explicitCountry(String(a)), xb = explicitCountry(String(b));
  if (xa && xb) return false;
  const other = xa ? ea : eb; // the bare local number is Indian
  return countryCode(other) === '91';
}

export function telLink(phone: string | undefined | null): string {
  if (isMaskedPhone(phone)) return '#';
  const e = toE164Digits(phone);
  return e ? `tel:+${e}` : '#';
}

export function fillTemplate(template: string, vars: Record<string, string | undefined>): string {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

export function whatsappLink(phone: string | undefined | null, text?: string): string {
  if (isMaskedPhone(phone)) return '#';
  const e = toE164Digits(phone);
  if (!e) return '#';
  return `https://wa.me/${e}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function mailtoLink(email: string | undefined | null, subject?: string, body?: string): string {
  if (!email) return '#';
  const params: string[] = [];
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${email}${params.length ? '?' + params.join('&') : ''}`;
}

/**
 * Why a phone number cannot be a real customer's ('' when it looks real). Refuses made-up numbers:
 * one digit repeated (1111111111), only two different digits (1212121212), 1234567890 / 9876543210, and an
 * Indian mobile (10 digits, or 91 + 10) that does not start with 6, 7, 8 or 9. A landline with a leading 0 is fine.
 */
export function phoneProblem(value: unknown): string {
  if (isMaskedPhone(value)) return ''; // left as it was: the server has the real one
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length < 10 || d.length > 15) return 'Enter a valid phone number (10 digits, or with the country code).';
  const ten = d.slice(-10);
  if (/^(\d)\1+$/.test(ten) || new Set(ten).size <= 2) return 'This phone number looks made up (the same digits repeated). Enter the customer’s real number.';
  if (['0123456789', '1234567890', '9876543210', '0987654321'].includes(ten)) return 'This phone number looks made up (digits in a row). Enter the customer’s real number.';
  const indianMobile = d.length === 10 || (d.length === 12 && d.startsWith('91'));
  if (indianMobile && !/^[6-9]/.test(ten)) return 'An Indian mobile number starts with 6, 7, 8 or 9.';
  return '';
}

export function isLikelyPhone(value: string): boolean {
  return !phoneProblem(value);
}
