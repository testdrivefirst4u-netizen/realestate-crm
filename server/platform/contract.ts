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
  role: 'Admin' | 'Manager' | 'RM' | 'Developer';
  status: 'Active' | 'Disabled';
  lastLoginAt: string;
}

export interface CompanyDetail extends CompanySummary {
  dbName: string;
  logo: string; // data URL ≤ 48 KB or ''
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

/** Action → request data → response data. */
/** Action → request data → response data (includes the per-company lead-source actions). */
export interface PlatformActions extends PlatformLeadSourceActions, PlatformSheetActions, PlatformMetaActions {
  /* public */
  saStatus: { req: {}; res: { setupRequired: boolean; setupTokenRequired: boolean; platformName: string } };
  saSetup: { req: { name: string; email: string; password: string; setupToken?: string }; res: { user: SuperAdmin; expiresAt: string } };
  saLogin: { req: { email: string; password: string }; res: { user: SuperAdmin; expiresAt: string } };
  /* signed in */
  saLogout: { req: {}; res: null };
  saMe: { req: {}; res: { user: SuperAdmin; expiresAt: string } };
  saChangePassword: { req: { currentPassword: string; newPassword: string }; res: null };
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
}

export type PlatformActionName = keyof PlatformActions;
