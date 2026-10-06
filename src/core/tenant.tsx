/**
 * The signed-in user's company (tenant): branding and the plan's feature switches.
 *
 * Every "is this feature on?" decision in the UI goes through `hasFeature()` (pure) or `useFeature()`
 * (React). While the server settings are not loaded yet both fall back to the built-in defaults in
 * `FEATURES` (config.ts), i.e. the behaviour of the app before companies existed.
 */
import React, { createContext, useContext } from 'react';
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

/* ------------------------------- React ---------------------------------- */

const TenantContext = createContext<ServerSettings | null>(null);

export const TenantProvider: React.FC<{ settings: ServerSettings | null | undefined; children?: React.ReactNode }> = ({ settings, children }) => (
  <TenantContext.Provider value={settings || null}>{children}</TenantContext.Provider>
);

/** The server settings of the signed-in user's company (null before sign-in / before the first load). */
export function useTenantSettings(): ServerSettings | null {
  return useContext(TenantContext);
}

export function useCompany(): CompanyInfo | null {
  return companyOf(useContext(TenantContext));
}

export function useFeature(name: FeatureName): boolean {
  return hasFeature(useContext(TenantContext), name);
}

/* ------------------------------ Plan usage ------------------------------ */

export interface PlanUsage {
  /** Users that can sign in (status not Disabled). */
  active: number;
  /** Plan limit; 0 = unlimited. */
  max: number;
  atLimit: boolean;
  /** "3 of 5 active users" / "3 active users · unlimited plan". */
  label: string;
}

/** Active users against the company's plan limit (Settings › Users, Company & plan). */
export function planUsage(users: ReadonlyArray<{ status?: string }> | null | undefined, maxUsers: number | null | undefined): PlanUsage {
  const active = (users || []).filter((u) => u && u.status !== 'Disabled').length;
  const max = Math.max(0, Number(maxUsers) || 0);
  const noun = (n: number) => (n === 1 ? 'active user' : 'active users');
  return {
    active,
    max,
    atLimit: max > 0 && active >= max,
    label: max > 0 ? `${active} of ${max} ${noun(max)}` : `${active} ${noun(active)} · no plan limit`,
  };
}

/** Is this the server's "Your plan allows N active users…" refusal? */
export const isPlanLimitMessage = (msg: string | null | undefined) => /plan allows/i.test(String(msg || ''));
