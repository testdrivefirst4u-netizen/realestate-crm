/**
 * The signed-in user's company (tenant): branding and the plan's feature switches.
 *
 * Every "is this feature on?" decision in the UI goes through `hasFeature()` (pure) or `useFeature()`
 * (React). While the server settings are not loaded yet both fall back to the built-in defaults in
 * `FEATURES` (config.ts), i.e. the behaviour of the app before companies existed.
 */
import React, { createContext, useContext } from 'react';
import type { ServerSettings } from '../types/crm';
import { companyOf, hasFeature, type CompanyInfo, type FeatureName } from './features';

export * from './features';

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
