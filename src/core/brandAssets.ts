/**
 * Logos shipped with the app (files in /public) for specific companies.
 *
 * Used only when the company has no logo uploaded by the platform admin, and matched by the
 * company's slug or name, so every other company keeps its own logo or initials.
 * `logo` is the full logo (wide); `mark` is a square emblem for small spots — the sidebar rail,
 * the top bar, the sign-in card. Both are dark artwork, so they are shown on a white tile.
 */
import type { CompanyInfo } from './features';

export interface BrandAssets {
  logo: string;
  mark: string;
}

const BRANDS: Array<{ match: RegExp; assets: BrandAssets }> = [
  { match: /amaya/i, assets: { logo: '/Amaya_black_Logo.webp', mark: '/Amaya_mark.png' } },
];

export function brandAssets(company: Pick<CompanyInfo, 'slug' | 'name'> | null | undefined): BrandAssets | null {
  if (!company) return null;
  const key = `${company.slug || ''} ${company.name || ''}`;
  return BRANDS.find((b) => b.match.test(key))?.assets || null;
}
