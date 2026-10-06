/**
 * Action router — successor of apps-script/04_Router.gs.
 *
 * The browser keeps calling the same 69 action names with the same `{action, data}` body and
 * receives the same `{status, data}` envelope, so the React screens did not have to change.
 * Differences: the session comes from an httpOnly cookie (never from the body or URL), errors use
 * real HTTP status codes, and the Developer Mode actions are gone.
 */
import { ActionMap } from './core/actions';
import { Ctx, requirePerm, validateSession } from './core/auth';
import { ApiError, errEnvelope, fail, ok } from './core/errors';
import { isTestMode } from './core/db';
import { currentTenant, runWithTenant, type TenantFeatures } from './core/tenant';
import { companyIdForEmail, getTenantById } from './platform/registry';
import { logError } from './core/events';

import { actions as systemActions } from './modules/system';
import { actions as leadActions } from './modules/leads';
import { actions as taskActions } from './modules/tasks';
import { actions as inventoryActions } from './modules/inventory';
import { actions as recordActions } from './modules/records';
import { actions as storageActions } from './modules/storage';
import { actions as chatActions } from './modules/chat360';
import { actions as callActions } from './modules/calls';
import { actions as aiActions } from './modules/ai';
import { actions as reportActions } from './modules/reports';
import { actions as leadSourceActions } from './modules/leadSources';
import { actions as sheetActions } from './modules/sheets';
import { actions as metaActions } from './modules/meta';

export const registry: ActionMap = {
  ...systemActions,
  ...leadActions,
  ...taskActions,
  ...inventoryActions,
  ...recordActions,
  ...storageActions,
  ...chatActions,
  ...callActions,
  ...aiActions,
  ...reportActions,
  ...leadSourceActions,
  ...sheetActions,
  ...metaActions,
};

const STATUS: Record<string, number> = {
  AUTH_REQUIRED: 401, AUTH_FAILED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 400,
  CONFLICT: 409, NOT_CONFIGURED: 503, RATE_LIMIT: 429, SERVER: 502, INTERNAL: 500,
};

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
  /** Company the action ran in (used to scope the session cookie on login). */
  companyId?: string;
}

/** Actions that belong to a plan feature (any of the listed); a company without it gets FORBIDDEN. */
const FEATURE_OF: Array<[RegExp, keyof TenantFeatures | Array<keyof TenantFeatures>, string]> = [
  [/^ai[A-Z]/, 'aiCopilot', 'AI features'],
  [/^chat360/, 'chat360', 'WhatsApp (Chat360)'],
  [/^(getCalls|logCall|updateCall|uploadCallRecording|transcribeCall|summarizeCall)$/, 'calls', 'Calls'],
  [/^(getInventory|updateInventoryUnit|addInventoryUnit|importInventory)$/, 'inventory', 'Inventory'],
  [/^saveReportSnapshot$/, 'reports', 'Reports'],
  // lead sources serve website/webhook (websiteApi) and Google Sheet imports (googleSheets); per-type check in modules/leadSources.ts
  [/LeadSource|^listInboundLog$|^retryInbound$/, ['websiteApi', 'googleSheets', 'metaLeads'], 'Website forms & lead API'],
  // googleStatus is not gated (it only says whether the platform is configured and which e-mail to share with)
  [/^(checkSheet|syncSheetImport|listGoogleConnections|disconnectGoogleConnection)$|SheetExport/, 'googleSheets', 'Google Sheets sync features'],
  // metaStatus is not gated (it only says whether the platform has a Meta app)
  [/^(getMetaPendingConnection|connectMetaPages|checkMetaSource|backfillMetaSource|disconnectMetaSource)$/, 'metaLeads', 'Meta (Facebook / Instagram) Lead Ads'],
];

/** Public actions that need no company (answered without touching any company database). */
const NO_COMPANY_ACTIONS = new Set(['ping', 'setupStatus', 'createFirstAdmin', 'logError']);

async function run(action: string, data: any, ctx: Ctx, started: number): Promise<RouteResult> {
  try {
    const def = registry[action];
    if (!def) return { status: 404, body: errEnvelope('NOT_FOUND', 'Unknown action: ' + action) };
    const t = currentTenant();
    if (t) {
      const gated = FEATURE_OF.find(([re]) => re.test(action));
      if (gated && !(Array.isArray(gated[1]) ? gated[1] : [gated[1]]).some((f) => t.features[f])) throw fail('FORBIDDEN', `${gated[2]} are not included in your company's plan.`);
    }
    const session = ctx.token ? await validateSession(ctx.token) : null;
    if (session) {
      ctx.user = session.user;
      ctx.session = { expiresAt: session.expiresAt };
    }
    if (!def.public) requirePerm(ctx, def.perm);
    const result = await def.fn(data && typeof data === 'object' ? data : {}, ctx);
    return { status: 200, body: ok(result), companyId: t?.id };
  } catch (err: any) {
    const code: string = err instanceof ApiError ? err.code : 'INTERNAL';
    if (!['AUTH_REQUIRED', 'AUTH_FAILED', 'FORBIDDEN', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMIT'].includes(code)) {
      console.error(`[rpc:${action}]`, err);
      if (currentTenant() || isTestMode()) await logError('router:' + action, code, err?.message, err?.stack, ctx.user?.email || '', { ms: Date.now() - started });
    }
    // Internal errors are logged in full but never echoed to the browser.
    const message = code === 'INTERNAL' ? 'Something went wrong on the server. The error has been logged.' : err?.message || String(err);
    const outCode = code === 'AUTH_FAILED' ? 'VALIDATION' : code;
    return { status: code === 'AUTH_FAILED' ? 401 : STATUS[code] || 500, body: errEnvelope(outCode, message, err instanceof ApiError ? err.details : undefined) };
  }
}

/**
 * Resolve the company, then run the action inside it:
 * - login: the company that owns the e-mail (platform directory);
 * - everything else: the company in the session cookie.
 * Suspended or deleted companies cannot sign in or use a session. Without a company only the
 * public system actions answer (unit tests run single-company code without one).
 */
export async function dispatch(action: string, data: any, base: Omit<Ctx, 'user' | 'session' | 'action'> & { companyId?: string }): Promise<RouteResult> {
  const started = Date.now();
  const { companyId: cookieCompany, ...rest } = base;
  const ctx: Ctx = { ...rest, user: null, session: null, action };
  try {
    let companyId = cookieCompany || '';
    if (action === 'login') companyId = (await companyIdForEmail(data?.email)) || '';
    if (!companyId) {
      if (NO_COMPANY_ACTIONS.has(action) || isTestMode()) return run(action, data, ctx, started);
      if (action === 'login') throw fail('AUTH_FAILED', 'Invalid email or password');
      throw fail('AUTH_REQUIRED', 'Please sign in');
    }
    const tenant = await getTenantById(companyId);
    if (!tenant) throw fail(action === 'login' ? 'AUTH_FAILED' : 'AUTH_REQUIRED', action === 'login' ? 'Invalid email or password' : 'Please sign in');
    if (tenant.status !== 'Active') {
      throw fail(action === 'login' ? 'FORBIDDEN' : 'AUTH_REQUIRED', 'This company account is suspended. Please contact your platform administrator.');
    }
    return runWithTenant(tenant, () => run(action, data, ctx, started));
  } catch (err: any) {
    const code: string = err instanceof ApiError ? err.code : 'INTERNAL';
    if (code === 'INTERNAL') console.error(`[rpc:${action}] tenant resolution`, err);
    const message = code === 'INTERNAL' ? 'Something went wrong on the server. The error has been logged.' : err?.message || String(err);
    return { status: code === 'AUTH_FAILED' ? 401 : STATUS[code] || 500, body: errEnvelope(code === 'AUTH_FAILED' ? 'VALIDATION' : code, message) };
  }
}
