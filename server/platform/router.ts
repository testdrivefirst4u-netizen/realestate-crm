/**
 * Platform (super admin) action router — implements every action of server/platform/contract.ts.
 *
 * Public: saStatus, saSetup, saLogin. Everything else needs a valid super-admin session.
 * Same envelope and HTTP status codes as the company router; internal errors are logged and never echoed.
 * A freshly issued (or slid) session token is returned beside the body in `session`, never inside it —
 * the route handler puts it into the httpOnly `platform_session` cookie.
 */
import { ApiError, errEnvelope, fail, ok } from '../core/errors';
import type { PlatformActionName } from './contract';
import type { SaCtx } from './base';
import { listPlatformAudit } from './base';
import * as SA from './superAdmins';
import * as CO from './companies';
import * as PL from './plans';
import * as LS from './leadSources';
import * as GS from './sheets';
import * as MA from './meta';
import * as BR from './branding';

type Handler = { public?: boolean; fn: (data: any, ctx: SaCtx) => Promise<unknown> | unknown };

export const platformRegistry: Record<PlatformActionName, Handler> = {
  /* public */
  saStatus: { public: true, fn: () => SA.saStatus() },
  saSetup: { public: true, fn: (d, ctx) => SA.saSetup(d, ctx) },
  saLogin: { public: true, fn: (d, ctx) => SA.saLogin(d, ctx) },
  /* session */
  saLogout: { fn: (_d, ctx) => SA.saLogout(ctx) },
  saMe: { fn: (_d, ctx) => ({ user: ctx.sa, expiresAt: ctx.expiresAt }) },
  saChangePassword: { fn: (d, ctx) => SA.saChangePassword(d, ctx) },
  /* companies */
  dashboard: { fn: () => CO.dashboard() },
  listCompanies: { fn: (d) => CO.listCompanies(d) },
  getCompany: { fn: (d) => CO.getCompany(d) },
  createCompany: { fn: (d, ctx) => CO.createCompany(d, ctx) },
  updateCompany: { fn: (d, ctx) => CO.updateCompany(d, ctx) },
  setCompanyStatus: { fn: (d, ctx) => CO.setCompanyStatus(d, ctx) },
  createCompanyUser: { fn: (d, ctx) => CO.createCompanyUser(d, ctx) },
  resetCompanyUserPassword: { fn: (d, ctx) => CO.resetCompanyUserPassword(d, ctx) },
  setCompanyUserStatus: { fn: (d, ctx) => CO.setCompanyUserStatus(d, ctx) },
  deleteCompany: { fn: (d, ctx) => CO.deleteCompany(d, ctx) },
  /* company lead sources */
  listCompanyLeadSources: { fn: (d) => LS.listCompanyLeadSources(d) },
  createCompanyLeadSource: { fn: (d, ctx) => LS.createCompanyLeadSource(d, ctx) },
  updateCompanyLeadSource: { fn: (d, ctx) => LS.updateCompanyLeadSource(d, ctx) },
  rotateCompanyLeadSourceKey: { fn: (d, ctx) => LS.rotateCompanyLeadSourceKey(d, ctx) },
  deleteCompanyLeadSource: { fn: (d, ctx) => LS.deleteCompanyLeadSource(d, ctx) },
  companyInboundLog: { fn: (d) => LS.companyInboundLog(d) },
  /* Google Sheets */
  getGoogleSettings: { fn: () => GS.getGoogleSettings() },
  setGoogleOAuthClient: { fn: (d, ctx) => GS.setGoogleOAuthClient(d, ctx) },
  setGoogleServiceAccount: { fn: (d, ctx) => GS.setGoogleServiceAccount(d, ctx) },
  testGoogleServiceAccount: { fn: () => GS.testGoogleServiceAccount() },
  companySheets: { fn: (d) => GS.companySheets(d) },
  /* Meta Lead Ads */
  getMetaSettings: { fn: () => MA.getMetaSettings() },
  setMetaSettings: { fn: (d, ctx) => MA.setMetaSettings(d, ctx) },
  testMetaSettings: { fn: () => MA.testMetaSettings() },
  companyMeta: { fn: (d) => MA.companyMeta(d) },
  connectCompanyMetaPage: { fn: (d, ctx) => MA.connectCompanyMetaPage(d, ctx) },
  retryMetaQueue: { fn: (d, ctx) => MA.retryMetaQueue(d, ctx) },
  /* plans */
  listPlans: { fn: () => PL.listPlans() },
  savePlan: { fn: (d, ctx) => PL.savePlan(d, ctx) },
  deletePlan: { fn: (d, ctx) => PL.deletePlan(d, ctx) },
  /* super admins */
  listSuperAdmins: { fn: () => SA.listSuperAdmins() },
  saveSuperAdmin: { fn: (d, ctx) => SA.saveSuperAdmin(d, ctx) },
  resetSuperAdminPassword: { fn: (d, ctx) => SA.resetSuperAdminPassword(d, ctx) },
  deleteSuperAdmin: { fn: (d, ctx) => SA.deleteSuperAdmin(d, ctx) },
  /* audit */
  auditLog: { fn: (d) => listPlatformAudit({ limit: d?.limit, companyId: d?.companyId }) },
  /* branding */
  getBranding: { fn: () => BR.getBranding() },
  saveBranding: { fn: (d, ctx) => BR.saveBranding(d, ctx) },
};

const STATUS: Record<string, number> = {
  AUTH_REQUIRED: 401, AUTH_FAILED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 400,
  CONFLICT: 409, NOT_CONFIGURED: 503, RATE_LIMIT: 429, SERVER: 502, INTERNAL: 500,
};
const EXPECTED = new Set(['AUTH_REQUIRED', 'AUTH_FAILED', 'FORBIDDEN', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMIT', 'NOT_CONFIGURED']);

export interface PlatformRouteResult {
  status: number;
  body: Record<string, unknown>;
  /** Session to (re)write into the cookie: set on saLogin/saSetup and when the sliding expiry moved. */
  session?: { token: string; expiresAt: string };
  /** True when the cookie must be cleared (logout, invalid session). */
  clearSession?: boolean;
}

export async function platformDispatch(action: string, data: any, base: { token: string; userAgent: string; ip: string }): Promise<PlatformRouteResult> {
  const ctx: SaCtx = { sa: null, token: String(base.token || ''), expiresAt: '', userAgent: base.userAgent || '', ip: base.ip || '' };
  try {
    const def = Object.prototype.hasOwnProperty.call(platformRegistry, action) ? platformRegistry[action as PlatformActionName] : undefined;
    if (!def) return { status: 404, body: errEnvelope('NOT_FOUND', 'Unknown action: ' + action) };
    let session: PlatformRouteResult['session'];
    if (!def.public) {
      const s = ctx.token ? await SA.validateSaSession(ctx.token) : null;
      if (!s) throw fail('AUTH_REQUIRED', 'Please sign in');
      ctx.sa = s.user;
      ctx.expiresAt = s.expiresAt;
      if (s.refreshed) session = { token: ctx.token, expiresAt: s.expiresAt };
    }
    let result: any = await def.fn(data && typeof data === 'object' && !Array.isArray(data) ? data : {}, ctx);
    if (result && typeof result === 'object' && typeof result.token === 'string' && (action === 'saLogin' || action === 'saSetup')) {
      const { token, ...rest } = result;
      session = { token, expiresAt: rest.expiresAt };
      result = rest;
    }
    return { status: 200, body: ok(result), session, clearSession: action === 'saLogout' };
  } catch (err: any) {
    const code: string = err instanceof ApiError ? err.code : 'INTERNAL';
    if (!EXPECTED.has(code)) console.error(`[platform-rpc:${action}]`, err);
    const message = code === 'INTERNAL' ? 'Something went wrong on the server. The error has been logged.' : err?.message || String(err);
    return {
      status: STATUS[code] || 500,
      body: errEnvelope(code === 'AUTH_FAILED' ? 'VALIDATION' : code, message, err instanceof ApiError ? err.details : undefined),
      clearSession: code === 'AUTH_REQUIRED' || action === 'saLogout',
    };
  }
}
