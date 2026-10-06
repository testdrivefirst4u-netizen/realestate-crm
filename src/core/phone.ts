/** Phone-number helpers (India-first). One implementation for the whole app. */

/** Digits only. */
export function digitsOnly(phone: string | undefined | null): string {
  return String(phone || '').replace(/\D/g, '');
}

/** Last 10 digits — the stable key for matching the same customer across systems. */
export function last10(phone: string | undefined | null): string {
  const d = digitsOnly(phone);
  return d.length >= 10 ? d.slice(-10) : d;
}

/** E.164 without '+', e.g. 919849012345. Assumes India when 10 digits. */
export function toE164Digits(phone: string | undefined | null): string {
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
  return phone ? String(phone).trim() : '';
}

export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const la = last10(a), lb = last10(b);
  return !!la && la.length === 10 && la === lb;
}

export function telLink(phone: string | undefined | null): string {
  const e = toE164Digits(phone);
  return e ? `tel:+${e}` : '#';
}

export function fillTemplate(template: string, vars: Record<string, string | undefined>): string {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

export function whatsappLink(phone: string | undefined | null, text?: string): string {
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

export function isLikelyPhone(value: string): boolean {
  const d = digitsOnly(value);
  return d.length >= 10 && d.length <= 13;
}
