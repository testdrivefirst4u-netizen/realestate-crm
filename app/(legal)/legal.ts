/**
 * Details shown on the public legal pages (/privacy, /terms, /data-deletion). They are edited in
 * Super admin › Settings › Branding & legal; until then the bracketed placeholders are shown.
 */
import { BRANDING_DEFAULTS, getBranding } from '@/server/platform/branding';

export interface LegalDetails {
  company: string;
  product: string;
  email: string;
  address: string;
  jurisdiction: string;
  updated: string;
}

const fromBranding = (b: typeof BRANDING_DEFAULTS): LegalDetails => ({
  company: b.legalCompany,
  product: b.platformName,
  email: b.legalEmail,
  address: b.legalAddress,
  jurisdiction: b.legalJurisdiction,
  updated: b.legalUpdated,
});

/** The saved details, or the defaults when the database cannot be reached (the pages must always render). */
export async function legalDetails(): Promise<LegalDetails> {
  try {
    return fromBranding(await getBranding());
  } catch {
    return fromBranding(BRANDING_DEFAULTS);
  }
}
