/**
 * Platform registry — companies (tenants) and the global user directory.
 *
 * Stored in the platform database (db.ts → platformDb()):
 *   companies  { _id: 'CMP-0001', slug, name, dbName, status, plan, maxUsers, features, logo, tagline,
 *                contactName, contactEmail, contactPhone, notes, createdAt, createdBy, updatedAt, deletedAt? }
 *   directory  { _id: emailLower, companyId }   — which company a CRM user belongs to (emails are unique
 *                                                  across the platform, so the login page needs no company code)
 */
import { pcol } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant, type Tenant, type TenantFeatures } from '../core/tenant';

export const PCOLL = {
  COMPANIES: 'companies',
  DIRECTORY: 'directory',
  SUPER_ADMINS: 'superAdmins',
  SA_SESSIONS: 'superAdminSessions',
  PLANS: 'plans',
  AUDIT: 'platformAudit',
  COUNTERS: 'counters',
  LOGIN_ATTEMPTS: 'loginAttempts',
  /** { _id: sha256(apiKey), companyId, sourceId, createdAt } — routes a lead-source key to its company. */
  API_KEYS: 'apiKeys',
  /** { _id: spreadsheetId, companyId, claimedAt } — a Google spreadsheet can be linked to one company only. */
  SHEET_CLAIMS: 'sheetClaims',
  /** Platform-wide settings documents, e.g. { _id: 'google', serviceAccount: <encrypted JSON>, … }. */
  PLATFORM_SETTINGS: 'platformSettings',
  /** { _id: Facebook pageId, companyId, sourceId, claimedAt } — a Facebook Page can be connected to one company only. */
  META_PAGES: 'metaPages',
  /** Meta leadgen webhook queue { _id: leadgen_id, pageId, formId, adId, createdTime, receivedAt, status, attempts, … }. */
  META_QUEUE: 'metaLeadQueue',
} as const;

export interface CompanyDoc {
  _id: string;
  slug: string;
  name: string;
  dbName: string;
  status: 'Active' | 'Suspended';
  plan: string;
  maxUsers: number;
  features: TenantFeatures;
  logo: string;
  tagline: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export const DEFAULT_FEATURES: TenantFeatures = {
  aiCopilot: true,
  chat360: true,
  calls: true,
  inventory: true,
  unitLocator: false,
  projectLibrary: false,
  reports: true,
  segments: true,
  websiteApi: true,
  metaLeads: false,
  googleSheets: false,
};

export function normalizeFeatures(f: Partial<TenantFeatures> | null | undefined): TenantFeatures {
  const out = { ...DEFAULT_FEATURES };
  for (const k of Object.keys(out) as Array<keyof TenantFeatures>) if (f && typeof f[k] === 'boolean') out[k] = f[k] as boolean;
  return out;
}

export function toTenant(c: CompanyDoc): Tenant {
  return {
    id: c._id,
    slug: c.slug,
    name: c.name,
    dbName: c.dbName,
    status: c.status === 'Suspended' ? 'Suspended' : 'Active',
    plan: c.plan || '',
    maxUsers: Number(c.maxUsers) || 0,
    features: normalizeFeatures(c.features),
    logo: c.logo || '',
    tagline: c.tagline || '',
  };
}

/* ------------------------------- lookups -------------------------------- */

const CACHE_MS = 15000;
const byId = new Map<string, { at: number; tenant: Tenant | null }>();

/** Company by id (cached 15 s). Deleted companies resolve to null. */
export async function getTenantById(id: string): Promise<Tenant | null> {
  if (!id) return null;
  const hit = byId.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.tenant;
  const c = await (await pcol<CompanyDoc>(PCOLL.COMPANIES)).findOne({ _id: id, deletedAt: { $in: [null, undefined] } } as any);
  const tenant = c ? toTenant(c) : null;
  byId.set(id, { at: Date.now(), tenant });
  return tenant;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(s)) return null;
  const c = await (await pcol<CompanyDoc>(PCOLL.COMPANIES)).findOne({ slug: s, deletedAt: { $in: [null, undefined] } } as any);
  return c ? toTenant(c) : null;
}

/** Forget cached company data (call after any company update). */
export function invalidateTenant(id?: string) {
  if (id) byId.delete(id);
  else byId.clear();
}

export async function listActiveTenants(): Promise<Tenant[]> {
  const rows = await (await pcol<CompanyDoc>(PCOLL.COMPANIES)).find({ status: 'Active', deletedAt: { $in: [null, undefined] } } as any).toArray();
  return rows.map(toTenant);
}

/* ------------------------------ directory ------------------------------- */

const dir = () => pcol<{ _id: string; companyId: string }>(PCOLL.DIRECTORY);

export async function companyIdForEmail(email: string): Promise<string | null> {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const d = await (await dir()).findOne({ _id: e });
  return d?.companyId || null;
}

/**
 * Reserve an e-mail for the current company. Throws CONFLICT when another company uses it.
 * Outside a company context (unit tests of single-company code) this is a no-op.
 */
export async function claimEmail(email: string) {
  const t = currentTenant();
  if (!t) return;
  const e = String(email || '').trim().toLowerCase();
  const c = await dir();
  try {
    await c.updateOne({ _id: e }, { $setOnInsert: { companyId: t.id } }, { upsert: true });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }
  const d = await c.findOne({ _id: e });
  if (d && d.companyId !== t.id) throw fail('CONFLICT', 'This e-mail address is already used by another account on the platform');
}

export async function releaseEmail(email: string) {
  const t = currentTenant();
  if (!t) return;
  await (await dir()).deleteOne({ _id: String(email || '').trim().toLowerCase(), companyId: t.id });
}
