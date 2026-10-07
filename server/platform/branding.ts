/**
 * Platform branding and legal details (super admin › Settings › Branding & legal).
 *
 * One document in PCOLL.PLATFORM_SETTINGS {_id:'branding'}. It is read by the public legal pages (/privacy,
 * /terms, /data-deletion) and the console title, so the operator can fill in real company details without a
 * code change. Empty fields fall back to the defaults below (bracketed placeholders until they are set).
 */
import { fail } from '../core/errors';
import { truncate } from '../core/utils';
import { pc, platformAudit, type SaCtx } from './base';
import { PCOLL } from './registry';

export interface Branding {
  /** Name of the platform/product shown on the legal pages and in the console title. */
  platformName: string;
  /** Registered name of the business that operates the platform. */
  legalCompany: string;
  /** Public inbox for privacy and data-deletion requests. */
  legalEmail: string;
  /** Registered postal address. */
  legalAddress: string;
  /** Courts with jurisdiction (Terms of Service), e.g. "Hyderabad, India". */
  legalJurisdiction: string;
  /** "Last updated" date shown on the legal pages. */
  legalUpdated: string;
  updatedAt: string;
  updatedBy: string;
}

export type BrandingInput = Partial<Omit<Branding, 'updatedAt' | 'updatedBy'>>;

export const BRANDING_DEFAULTS: Omit<Branding, 'updatedAt' | 'updatedBy'> = {
  platformName: 'Amaya CRM',
  legalCompany: '[Your company legal name]',
  legalEmail: '[privacy@yourcompany.com]',
  legalAddress: '[Registered address, City, State, PIN, India]',
  legalJurisdiction: '[City], India',
  legalUpdated: '6 October 2026',
};

const FIELDS = Object.keys(BRANDING_DEFAULTS) as Array<keyof typeof BRANDING_DEFAULTS>;
const LIMITS: Record<keyof typeof BRANDING_DEFAULTS, number> = {
  platformName: 80, legalCompany: 160, legalEmail: 200, legalAddress: 300, legalJurisdiction: 120, legalUpdated: 40,
};
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface BrandingDoc extends BrandingInput {
  _id: 'branding';
  updatedAt?: Date;
  updatedBy?: string;
}

const col = () => pc<BrandingDoc>(PCOLL.PLATFORM_SETTINGS);

/** Current branding with defaults for anything not set. Never throws for a missing document. */
export async function getBranding(): Promise<Branding> {
  const doc = await (await col()).findOne({ _id: 'branding' });
  const out = { ...BRANDING_DEFAULTS } as Branding;
  for (const f of FIELDS) {
    const v = String(doc?.[f] ?? '').trim();
    if (v) out[f] = v;
  }
  out.updatedAt = doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : '';
  out.updatedBy = doc?.updatedBy || '';
  return out;
}

/** Save the fields given (an empty string clears a field back to its default). */
export async function saveBranding(d: BrandingInput, ctx: SaCtx): Promise<Branding> {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};
  for (const f of FIELDS) {
    if (d?.[f] === undefined) continue;
    const v = truncate(String(d[f] ?? '').trim(), LIMITS[f]);
    if (f === 'legalEmail' && v && !EMAIL_RE.test(v)) throw fail('VALIDATION', 'Enter a valid e-mail address for privacy requests');
    if (/[<>]/.test(v)) throw fail('VALIDATION', 'Text cannot contain < or >');
    if (v) $set[f] = v;
    else $unset[f] = '';
  }
  $set.updatedAt = new Date();
  $set.updatedBy = ctx.sa?.email || '';
  await (await col()).updateOne({ _id: 'branding' }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { upsert: true });
  await platformAudit(ctx, 'Branding Updated', '', truncate(Object.keys($set).filter((k) => !k.startsWith('updated')).join(', '), 300));
  return getBranding();
}
