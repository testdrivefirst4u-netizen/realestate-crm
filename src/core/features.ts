/**
 * Plan features and company branding — pure helpers shared by the browser and the server
 * (server components gate routes with the same rules the sidebar uses). React bindings live in tenant.tsx.
 */
import { FEATURES } from './config';
import type { ServerSettings } from '../types/crm';

/** Plan / settings features the server reports in `settings.features`. */
export type FeatureName =
  | 'aiCopilot'
  | 'chat360'
  | 'calls'
  | 'inventory'
  | 'inventorySync'
  | 'websiteApi'
  | 'metaLeads'
  | 'googleSheets'
  | 'unitLocator'
  | 'projectLibrary'
  | 'reports'
  | 'segments'
  | 'developerMode'
  // UI-only switches that are not part of a plan (always on unless settings turn them off)
  | 'documents'
  | 'templates'
  | 'csvImport';

export interface CompanyInfo {
  id: string;
  slug: string;
  name: string;
  /** Small data URL, or '' when the company has no logo. */
  logo: string;
  tagline: string;
  plan: string;
  /** 0 = unlimited. */
  maxUsers: number;
}

type SettingsLike = { features?: Record<string, boolean> | null } | null | undefined;

/** Is `name` enabled? Uses `settings.features` when it says so, else the built-in default. */
export function hasFeature(settings: SettingsLike, name: FeatureName): boolean {
  const f = settings?.features;
  if (f && typeof f[name] === 'boolean') return f[name];
  return !!(FEATURES as Record<string, boolean>)[name];
}

/** Every feature resolved (defaults overlaid with the server's values). */
export function resolveFeatures(settings: SettingsLike): Record<FeatureName, boolean> & Record<string, boolean> {
  return { ...(FEATURES as Record<string, boolean>), ...(settings?.features || {}) } as Record<FeatureName, boolean> & Record<string, boolean>;
}

/** Human labels for the plan features (Settings › Company & plan). */
export const FEATURE_LABELS: Partial<Record<FeatureName, string>> = {
  aiCopilot: 'AI Copilot',
  chat360: 'WhatsApp (Chat360)',
  calls: 'Call history & logging',
  inventory: 'Inventory',
  inventorySync: 'Inventory sync',
  unitLocator: 'Unit Locator',
  projectLibrary: 'Project library',
  reports: 'Reports',
  segments: 'Client segments',
  websiteApi: 'Website forms & lead API',
  metaLeads: 'Meta Lead Ads',
  googleSheets: 'Google Sheets sync',
};

/** Up to two initials of a company name ("Vera Vita Living" → "VV", "acme" → "A"). */
export function companyInitials(name: string | null | undefined): string {
  const words = String(name || '').trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  if (!words.length) return '';
  const first = (w: string) => (w.match(/[A-Za-z0-9]/) || [''])[0].toUpperCase();
  return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[1]);
}

/** Product name shown before sign-in (no company is known yet). */
export function platformProductName(): string {
  const platform = (process.env.NEXT_PUBLIC_PLATFORM_NAME || '').trim();
  return platform ? `${platform} CRM` : 'CRM';
}

/** Browser tab title: "<Company> · CRM", or just "CRM" without a company. */
export function documentTitleFor(company: Pick<CompanyInfo, 'name'> | null | undefined): string {
  return company?.name ? `${company.name} · CRM` : platformProductName();
}

export function companyOf(settings: ServerSettings | null | undefined): CompanyInfo | null {
  const c = settings?.company;
  return c && typeof c === 'object' && c.name ? c : null;
}
