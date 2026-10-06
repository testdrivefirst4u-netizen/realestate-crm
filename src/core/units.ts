/**
 * Unit-type vocabulary — ONE canonical spelling for every BHK value.
 *
 * Over time the sheet collected "1 - BHK", "1BHK", "1 bhk", "2.5 BHK Type A", "3 BHK (B)" … for the same
 * thing. Every place that reads or writes a unit type goes through `normalizeUnitType`, so filters,
 * dropdowns, reports, the Copilot and the inventory all agree. The backend applies the same rule
 * (server-side) on read and write; a one-off maintenance step rewrites
 * the historical cells once.
 *
 *   normalizeUnitType('1 - BHK')         → '1 BHK'
 *   normalizeUnitType('2.5 BHK Type A')  → '2.5 BHK-A'
 *   normalizeUnitType('Villa')           → 'Villa'   (non-BHK values are only trimmed)
 */

const BHK_RE = /(\d+(?:[.,]\d+)?)\s*[-–—_ ]*\s*b\.?\s*h\.?\s*k\.?/i;
const VARIANT_RE = /(?:^|[\s\-–—_(/:]|type\s*)([abcd])(?=$|[\s)\]/:.,-])/i;
const PLACEHOLDER_RE = /^(unit\s*type(\s*interested\s*in)?|select|choose|none|n\/?a|-+)$/i;
const CANON_RE = /^(\d+(?:\.\d+)?) BHK(?:-([A-D]))?$/;

export function normalizeUnitType(value: unknown): string {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return '';
  if (PLACEHOLDER_RE.test(s)) return ''; // "Unit Type", "Select", "N/A", "None", "-" are placeholders, not values
  const m = s.match(BHK_RE);
  if (!m) return s.replace(/\s+/g, ' ');
  let n = String(m[1]).replace(',', '.');
  if (/^\d+\.0+$/.test(n)) n = n.replace(/\.0+$/, '');
  const rest = s.replace(m[0], ' ');
  const variant = rest.match(VARIANT_RE);
  return `${n} BHK${variant ? `-${variant[1].toUpperCase()}` : ''}`;
}

/** The size ("2.5") and variant ("A") of a canonical unit type, or null for non-BHK values. */
export function parseUnitType(value: unknown): { size: number; variant: string; base: string } | null {
  const m = normalizeUnitType(value).match(CANON_RE);
  return m ? { size: parseFloat(m[1]), variant: m[2] || '', base: `${m[1]} BHK` } : null;
}

/** "2.5 BHK-A" and "2.5 BHK" are the same lead interest; inventory keeps the variant. */
export function unitTypeBase(value: unknown): string {
  const p = parseUnitType(value);
  return p ? p.base : normalizeUnitType(value);
}

/** True when a lead's interest matches an inventory unit type (base match: "2 BHK" ↔ "2 BHK-B"). */
export function unitTypeMatches(a: unknown, b: unknown): boolean {
  const na = normalizeUnitType(a), nb = normalizeUnitType(b);
  if (!na || !nb) return false;
  return na === nb || unitTypeBase(na) === unitTypeBase(nb);
}

function sortKey(t: string): [number, number, string] {
  const p = parseUnitType(t);
  return p ? [0, p.size, p.variant] : [1, 0, t.toLowerCase()];
}

/** Normalise, dedupe and sort a list of unit types (by size, then variant); other values keep their order at the end. */
export function dedupeUnitTypes(list: readonly unknown[] | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list || []) {
    const n = normalizeUnitType(v);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  });
}
