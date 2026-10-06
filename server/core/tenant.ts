/**
 * Multi-tenancy: every request runs inside one company's context.
 *
 * Each company (tenant) has its own MongoDB database; the platform (super admin, company registry,
 * user directory) lives in a separate database. `runWithTenant(company, fn)` sets the company for
 * everything awaited inside `fn` (AsyncLocalStorage), and `col()` in db.ts resolves collections in
 * that company's database. There is deliberately NO default tenant: code that reaches the database
 * without a company context throws instead of reading another company's data.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantFeatures {
  aiCopilot: boolean;
  chat360: boolean;
  calls: boolean;
  inventory: boolean;
  unitLocator: boolean;
  /** Amaya-specific project document library and Copilot knowledge (only for Amaya by Vera Vita). */
  projectLibrary: boolean;
  reports: boolean;
  segments: boolean;
  /** Website forms / generic webhook API (lead sources). */
  websiteApi: boolean;
  /** Meta (Facebook / Instagram) Lead Ads. */
  metaLeads: boolean;
  /** Google Sheets import / export. */
  googleSheets: boolean;
}

export interface Tenant {
  id: string; // CMP-0001
  slug: string; // url-safe, unique
  name: string;
  dbName: string;
  status: 'Active' | 'Suspended';
  plan: string;
  maxUsers: number;
  features: TenantFeatures;
  logo: string; // small data URL or ''
  tagline: string;
}

const storage = new AsyncLocalStorage<Tenant>();

export function runWithTenant<T>(tenant: Tenant, fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(storage.run(tenant, fn));
}

export function currentTenant(): Tenant | null {
  return storage.getStore() || null;
}

/** The current company; throws when code runs outside a company context. */
export function requireTenant(): Tenant {
  const t = storage.getStore();
  if (!t) throw new Error('No company context for this operation (tenant isolation guard).');
  return t;
}

/** Key for per-company in-memory caches/locks. */
export function tenantKey(suffix = '') {
  const t = storage.getStore();
  return (t ? t.dbName : '__none__') + (suffix ? ':' + suffix : '');
}
