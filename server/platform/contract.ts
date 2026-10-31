/**
 * Super Admin (platform) API contract — shared by the backend (server/platform/*) and the console UI
 * (app/superadmin/*). Transport: POST /api/platform/rpc with JSON `{ action, data }`, same-origin,
 * session in the httpOnly cookie `platform_session`. Responses use the CRM envelope:
 *   { status: 'success', data }  |  { status: 'error', code, message, details? }
 * Error codes: AUTH_REQUIRED (401), AUTH_FAILED→VALIDATION, FORBIDDEN, NOT_FOUND, VALIDATION, CONFLICT, RATE_LIMIT, INTERNAL.
 */
import type { TenantFeatures } from '../core/tenant';
import type { PlatformLeadSourceActions } from '../core/leadSourceTypes';
import type { PlatformSheetActions } from '../core/sheetTypes';
import type { PlatformMetaActions } from '../core/metaTypes';
import type { Branding, BrandingInput } from './branding';
export type { Branding, BrandingInput } from './branding';
export type { MetaSourceConfig, MetaStatus } from '../core/metaTypes';
export type { GoogleConnection, GoogleSettingsView, GoogleStatus, SheetAuth, SheetExport, SheetExportColumns, SheetImportConfig, SyncInterval } from '../core/sheetTypes';
export type { LeadSource, LeadSourceConfig, LeadSourceType, InboundLogEntry, InboundStatus, AssignmentMode, DuplicateMode } from '../core/leadSourceTypes';

export type FeatureKey = keyof TenantFeatures;

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  aiCopilot: 'AI Copilot & AI tools',
  chat360: 'WhatsApp (Chat360)',
  calls: 'Calls & recordings',
  inventory: 'Inventory',
  unitLocator: 'Unit locator (floor plans)',
  projectLibrary: 'Amaya project library',
  reports: 'Reports & exports',
  segments: 'Client segments',
  websiteApi: 'Website forms & lead API',
  metaLeads: 'Meta (Facebook/Instagram) Lead Ads',
  googleSheets: 'Google Sheets sync',
};

export interface SuperAdmin {
  id: string; // SA-0001
  name: string;
  email: string;
  status: 'Active' | 'Disabled';
  createdAt: string;
  lastLoginAt: string;
  /** True after the account was created/reset with a temporary password (backend addition). */
  mustChangePassword?: boolean;
  /** Two-step sign-in (authenticator app) is on. */
  twoFactor?: boolean;
}

export interface Plan {
  id: string; // e.g. 'starter'
  name: string;
  description: string;
  maxUsers: number; // 0 = unlimited
  features: TenantFeatures;
  priceMonthly: number; // display only (no billing integration yet)
  currency: string; // 'INR'
}

export interface CompanySummary {
  id: string; // CMP-0001
  slug: string;
  name: string;
  status: 'Active' | 'Suspended';
  plan: string; // plan id
  maxUsers: number;
  activeUsers: number;
  leads: number;
  storageMB: number;
  features: TenantFeatures;
  contactEmail: string;
  createdAt: string;
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
  role: 'Admin' | 'Manager' | 'RM' | 'Viewer' | 'Developer';
  status: 'Active' | 'Disabled';
  lastLoginAt: string;
}

export interface CompanyDetail extends CompanySummary {
  dbName: string;
  logo: string; // data URL ≤ 200 000 characters or ''
  tagline: string;
  contactName: string;
  contactPhone: string;
  notes: string;
  updatedAt: string;
  users: CompanyUser[];
  usage: { leads: number; tasks: number; units: number; calls: number; messages: number; storageMB: number; lastActivityAt: string };
}

export interface PlatformAuditEntry {
  id: string;
  timestamp: string;
  actor: string; // super admin name <email>
  action: string;
  companyId: string;
  details: string;
}

/** Billing (super admin): subscriptions and invoices kept by hand until a payment gateway is connected. */
export interface BillingSubscription {
  companyId: string;
  companyName: string;
  companyStatus: string;
  plan: string;
  planName: string;
  /** false: nothing saved yet — amount/currency are the plan's suggestion. */
  configured: boolean;
  amount: number;
  currency: string;
  cycle: 'monthly' | 'yearly';
  status: 'trial' | 'active' | 'overdue' | 'complimentary' | 'cancelled';
  startedOn: string;
  /** Renewal date (trial end for trials), yyyy-mm-dd. */
  renewsOn: string;
  notes: string;
}
export interface BillingInvoice {
  id: string;
  companyId: string;
  companyName: string;
  amount: number;
  currency: string;
  description: string;
  periodFrom: string;
  periodTo: string;
  issuedOn: string;
  dueOn: string;
  status: 'due' | 'paid' | 'void';
  overdue: boolean;
  paidOn: string;
  method: string;
  reference: string;
}
export interface BillingOverview {
  currency: string;
  mrr: number;
  payingCompanies: number;
  dueNext30: number;
  renewalsNext30: number;
  overdue: number;
  overdueCount: number;
  trialsEnding: number;
  subscriptions: BillingSubscription[];
  invoices: BillingInvoice[];
  paymentMethods: string[];
}

/** Platform health (super admin): scheduled jobs, Meta lead queue, latest errors of every company. */
export interface HealthJob {
  id: string;
  label: string;
  path: string;
  everyMin: number;
  status: 'ok' | 'late' | 'failing' | 'never';
  lastRunAt: string;
  lastOkAt: string;
  /** Last call with a missing or wrong CRON_SECRET. */
  lastRejectedAt: string;
  durationMs: number;
  summary: string;
  lastError: string;
  history: Array<{ at: string; ok: boolean; ms: number; summary: string }>;
}
export interface PlatformHealth {
  checkedAt: string;
  jobs: HealthJob[];
  metaQueue: { pending: number; failed: number; done24h: number };
  errors: Array<{ at: string; company: string; companyId: string; scope: string; code: string; message: string }>;
}

/** Database storage of one company (bytes; growth is null until there is an older snapshot to compare). */
export interface StorageCompany {
  companyId: string;
  name: string;
  dbName: string;
  at: string;
  /** Data + indexes. */
  size: number;
  dataSize: number;
  indexSize: number;
  /** Compressed space MongoDB has allocated on disk. */
  storageSize: number;
  count: number;
  collections: number;
  growth1d: number | null;
  growth7d: number | null;
  records1d: number | null;
  topCollection: { name: string; size: number } | null;
  series: Array<{ day: string; size: number }>;
}
export interface StorageOverview {
  checkedAt: string;
  total: { size: number; storageSize: number; count: number; growth1d: number | null };
  companies: StorageCompany[];
}
export interface StorageCollection {
  name: string;
  count: number;
  size: number;
  dataSize: number;
  indexSize: number;
  storageSize: number;
  avgRecord: number;
  /** Part of the company's database (0–1). */
  share: number;
  growth1d: number | null;
  growth7d: number | null;
  records1d: number | null;
}
export interface StorageLargestItem { id: string; size: number; label: string; at: string }

/** Action → request data → response data. */
/** Action → request data → response data (includes the per-company lead-source actions). */
export interface PlatformActions extends PlatformLeadSourceActions, PlatformSheetActions, PlatformMetaActions {
  /* public */
  saStatus: { req: {}; res: { setupRequired: boolean; setupTokenRequired: boolean; platformName: string } };
  saSetup: { req: { name: string; email: string; password: string; setupToken?: string }; res: { user: SuperAdmin; expiresAt: string } };
  saLogin: { req: { email: string; password: string; code?: string }; res: { user: SuperAdmin; expiresAt: string } };
  /* signed in */
  saLogout: { req: {}; res: null };
  saMe: { req: {}; res: { user: SuperAdmin; expiresAt: string } };
  saChangePassword: { req: { currentPassword: string; newPassword: string }; res: null };
  saTotpSetup: { req: {}; res: { secret: string; uri: string } };
  saTotpEnable: { req: { code: string }; res: SuperAdmin };
  saTotpDisable: { req: { password: string }; res: SuperAdmin };
  dashboard: {
    req: {};
    res: {
      companies: { total: number; active: number; suspended: number };
      users: number;
      leads: number;
      storageMB: number;
      recentCompanies: CompanySummary[];
      recentAudit: PlatformAuditEntry[];
    };
  };
  listCompanies: { req: { q?: string; status?: 'Active' | 'Suspended' | '' }; res: CompanySummary[] };
  getCompany: { req: { id: string }; res: CompanyDetail };
  /** Sets the CRM session cookie (route handler) for a 2-hour Platform support session in that company. */
  openCompanySupport: { req: { companyId: string }; res: { companyId: string; expiresAt: string; redirect: string } };
  createCompany: {
    req: {
      name: string;
      slug: string; // 2–40 chars: a-z 0-9 -
      plan: string;
      maxUsers?: number; // defaults to the plan's
      features?: Partial<TenantFeatures>; // defaults to the plan's
      contactName?: string;
      contactEmail?: string;
      contactPhone?: string;
      notes?: string;
      admin: { name: string; email: string; password?: string }; // password optional → generated
    };
    res: { company: CompanyDetail; adminTemporaryPassword?: string };
  };
  updateCompany: {
    req: { id: string; patch: Partial<Pick<CompanyDetail, 'name' | 'plan' | 'maxUsers' | 'features' | 'logo' | 'tagline' | 'contactName' | 'contactEmail' | 'contactPhone' | 'notes'>> };
    res: CompanyDetail;
  };
  setCompanyStatus: { req: { id: string; status: 'Active' | 'Suspended'; reason?: string }; res: CompanyDetail };
  createCompanyUser: { req: { companyId: string; name: string; email: string; role: CompanyUser['role'] }; res: { user: CompanyUser; temporaryPassword: string } };
  resetCompanyUserPassword: { req: { companyId: string; userId: string }; res: { temporaryPassword: string } };
  setCompanyUserStatus: { req: { companyId: string; userId: string; status: 'Active' | 'Disabled' }; res: CompanyUser };
  deleteCompany: { req: { id: string; confirmSlug: string }; res: { ok: true } };
  listPlans: { req: {}; res: Plan[] };
  savePlan: { req: { plan: Plan }; res: Plan };
  deletePlan: { req: { id: string }; res: { ok: true } };
  listSuperAdmins: { req: {}; res: SuperAdmin[] };
  saveSuperAdmin: { req: { id?: string; name: string; email: string; status?: 'Active' | 'Disabled' }; res: { user: SuperAdmin; temporaryPassword?: string } };
  resetSuperAdminPassword: { req: { id: string }; res: { temporaryPassword: string } };
  deleteSuperAdmin: { req: { id: string }; res: { ok: true } };
  auditLog: { req: { limit?: number; companyId?: string }; res: PlatformAuditEntry[] };
  platformHealth: { req: {}; res: PlatformHealth };
  storageOverview: { req: { refresh?: boolean }; res: StorageOverview };
  storageCompany: { req: { companyId: string }; res: { companyId: string; name: string; at: string; collections: StorageCollection[] } };
  storageLargest: { req: { companyId: string; collection: string }; res: StorageLargestItem[] };
  billingOverview: { req: {}; res: BillingOverview };
  saveSubscription: { req: { companyId: string; amount: number; currency: string; cycle: 'monthly' | 'yearly'; status: BillingSubscription['status']; startedOn?: string; renewsOn?: string; notes?: string }; res: BillingSubscription };
  createInvoice: { req: { companyId: string; amount: number; currency: string; description?: string; periodFrom?: string; periodTo?: string; issuedOn?: string; dueOn?: string }; res: BillingInvoice };
  setInvoiceStatus: { req: { id: string; status: 'due' | 'paid' | 'void'; method?: string; reference?: string; paidOn?: string }; res: BillingInvoice };
  /* branding & legal details (public legal pages) */
  getBranding: { req: {}; res: Branding };
  saveBranding: { req: BrandingInput; res: Branding };
}

export type PlatformActionName = keyof PlatformActions;
