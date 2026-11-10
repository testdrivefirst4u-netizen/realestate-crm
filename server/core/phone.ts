/**
 * Phone identity (Release B/C): the full international number, not the last ten digits.
 *
 * Amaya's families often enquire from abroad for parents in India, so a lead may have a +1 / +44 / +971 number
 * whose last ten digits equal an unrelated Indian number. Matching on the last ten digits alone merged such people.
 *
 *   phoneIdentity('+1 (415) 987-6543') → { e164: '+14159876543', explicitCountry: true }
 *   phoneIdentity('98765 43210')       → { e164: '+919876543210', explicitCountry: false }  (India assumed)
 *
 * sameIdentity(a, b): two numbers are the same person's number when their E.164 forms are equal — except that a
 * bare 10-digit local number (no country given) is compared by its last ten digits with a +91 number, because
 * Indian numbers are routinely stored without the country code. A number with an explicit non-Indian country code
 * never matches a different country's number, whatever its last ten digits.
 */
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');

export const DEFAULT_COUNTRY = '91';

export function phoneIdentity(raw: unknown, defaultCountry = DEFAULT_COUNTRY): { e164: string; explicitCountry: boolean; country: string } | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let d = digits(s);
  let explicit = /^\s*(\+|00)/.test(s);
  if (/^\s*00/.test(s)) d = d.replace(/^00/, '');
  if (!explicit && d.length === 11 && d.startsWith('0')) d = d.slice(1); // trunk prefix 0
  if (!explicit && d.length === 10) d = defaultCountry + d;
  else if (!explicit && d.length > 10) explicit = true; // includes a country code, written without +
  if (d.length < 8 || d.length > 15) return null;
  return { e164: '+' + d, explicitCountry: explicit, country: countryOf(d) };
}

/** The calling code (best effort: 1–3 digits); enough to tell +1, +44, +91, +971 apart. */
function countryOf(d: string): string {
  const three = ['971', '966', '974', '973', '968', '965', '880', '977', '960', '353', '852'];
  const two = ['91', '44', '61', '65', '60', '49', '33', '39', '31', '41', '81', '86', '27', '64', '92', '94', '62', '63', '66', '34', '46', '47', '45', '32'];
  if (three.includes(d.slice(0, 3))) return d.slice(0, 3);
  if (two.includes(d.slice(0, 2))) return d.slice(0, 2);
  if (d.startsWith('1')) return '1';
  if (d.startsWith('7')) return '7';
  return d.slice(0, 2);
}

export function sameIdentity(a: unknown, b: unknown): boolean {
  const x = phoneIdentity(a);
  const y = phoneIdentity(b);
  if (!x || !y) return false;
  if (x.e164 === y.e164) return true;
  // a bare local number has no country; it can only be the Indian number with the same ten digits
  const local = (p: typeof x) => !p.explicitCountry;
  if (local(x) || local(y)) {
    const other = local(x) ? y : x;
    return other.country === DEFAULT_COUNTRY && x.e164.slice(-10) === y.e164.slice(-10);
  }
  return false;
}
