/**
 * Action router — successor of apps-script/04_Router.gs.
 *
 * The browser keeps calling the same 69 action names with the same `{action, data}` body and
 * receives the same `{status, data}` envelope, so the React screens did not have to change.
 * Differences: the session comes from an httpOnly cookie (never from the body or URL), errors use
 * real HTTP status codes, and the Developer Mode actions are gone.
 */
import { ActionMap } from './core/actions';
import { can, Ctx, normalizeRole, requirePerm, sessionEndReason, validateSession } from './core/auth';
import { ApiError, errEnvelope, fail, ok } from './core/errors';
import { hidePhonesDeep, hidePhonesInText, revealPhonesDeep } from './core/phoneMask';
import { isTestMode } from './core/db';
import { currentTenant, runWithTenant, type TenantFeatures } from './core/tenant';
import { companyIdForEmail, getTenantById } from './platform/registry';
import { logError } from './core/events';

import { actions as systemActions } from './modules/system';
import { actions as leadActions } from './modules/leads';
import { actions as leadExportActions } from './modules/leadExports';
import { actions as leadMergeActions } from './modules/leadMerge';
import { actions as backupActions } from './modules/backups';
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
import { actions as metaSyncActions } from './modules/metaSync';
import { actions as salesOpsActions } from './modules/salesOps';
import { actions as pushActions } from './modules/push';
import { actions as justconnectActions } from './modules/justconnect';
import { actions as jcSyncActions } from './modules/jcSync';
import { actions as libraryActions } from './modules/library';
import { actions as adConversionActions } from './modules/adConversions';
import { actions as googleMarketingActions } from './modules/googleMarketing';
import { actions as socialAccountActions } from './modules/socialAccounts';
import { actions as socialInboxActions } from './modules/socialInbox';
import { actions as linkedinActions } from './modules/linkedin';
import { actions as pinterestActions } from './modules/pinterest';
import { actions as socialPostActions } from './modules/socialPosts';
import { actions as instagramProfileActions } from './modules/instagramProfile';
import { actions as adsControlActions } from './modules/adsControl';
import { actions as websiteAnalyticsActions } from './modules/websiteAnalytics';
import { actions as competitorActions } from './modules/competitors';
import { actions as searchConsoleActions } from './modules/searchConsole';
import { actions as businessProfileActions } from './modules/businessProfile';
import { actions as dripActions } from './modules/dripCampaigns';
import { actions as roleAccessActions } from './modules/roleAccess';
import { actions as businessPhotoActions } from './modules/businessPhotos';
import { actions as businessReviewActions } from './modules/businessReviews';
import { actions as socialInsightsActions } from './modules/socialInsights';
import { actions as socialPostVideoActions } from './modules/socialPostVideo';
import { actions as analyticsReportActions } from './modules/analyticsReports';
import { actions as socialPostsImportActions } from './modules/socialPostsImport';
import { actions as socialInboxImportActions } from './modules/socialInboxImport';
import { actions as metaAdsTableActions } from './modules/metaAdsTable';
import { actions as whatsappDirectActions } from './modules/whatsappDirect';
import { actions as whatsappCreditActions } from './modules/whatsappCredits';
import { actions as whatsappBotActions } from './modules/whatsappBots';
import { actions as whatsappCampaignActions } from './modules/whatsappCampaigns';
import { actions as connectedAccountActions } from './modules/connectedAccounts';

export const registry: ActionMap = {
  ...systemActions,
  ...leadActions,
  ...leadExportActions,
  ...leadMergeActions,
  ...backupActions,
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
  ...metaSyncActions,
  ...salesOpsActions,
  ...pushActions,
  ...justconnectActions,
  ...jcSyncActions,
  ...libraryActions,
  ...adConversionActions,
  ...googleMarketingActions,
  ...socialAccountActions,
  ...socialInboxActions,
  ...linkedinActions,
  ...pinterestActions,
  ...socialPostActions,
  ...instagramProfileActions,
  ...adsControlActions,
  ...websiteAnalyticsActions,
  ...competitorActions,
  ...searchConsoleActions,
  ...businessProfileActions,
  ...dripActions,
  ...roleAccessActions,
  ...businessPhotoActions,
  ...businessReviewActions,
  ...socialInsightsActions,
  ...socialPostVideoActions,
  ...analyticsReportActions,
  ...socialPostsImportActions,
  ...socialInboxImportActions,
  ...metaAdsTableActions,
  ...whatsappDirectActions,
  ...whatsappCreditActions,
  ...whatsappBotActions,
  ...whatsappCampaignActions,
  ...connectedAccountActions,
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
  [/^waDirect/, 'whatsappDirect', 'WhatsApp direct'],
  [/^waCredits/, 'whatsappCredits', 'WhatsApp credits'],
  [/^waBot/, 'whatsappBots', 'WhatsApp chatbots'],
  [/^waCampaign/, 'whatsappCampaigns', 'WhatsApp campaigns'],
  [/^(getCalls|logCall|updateCall|uploadCallRecording|transcribeCall|summarizeCall|splitCallTranscript)$|^jc[A-Z]/, 'calls', 'Calls'],
  [/^(getInventory|updateInventoryUnit|addInventoryUnit|importInventory)$/, 'inventory', 'Inventory'],
  [/^saveReportSnapshot$/, 'reports', 'Reports'],
  [/^library(Get|Save|SetEditors|UploadPart|Import)$/, 'projectLibrary', 'The project library'],
  [/^(save|test)AdConversions?$|^sendRecentAdConversions$/, 'adConversions', 'Ad conversions'],
  [/^(get|disconnect)AdConversions$|^chooseAdConversionDataset$/, ['adConversions', 'adSpend', 'googleConversions'], 'Meta ads features'],
  [/^(get|save)ConversionRules$/, ['adConversions', 'googleConversions'], 'Lead results to ad platforms'],
  [/^(get|save|refresh|disconnect)GoogleMarketing$|^listGoogleConversionActions$|^testGa4$|^syncGoogleSpend$/, ['googleConversions', 'googleAdsSpend', 'socialInbox', 'socialPosts', 'adsControl', 'websiteAnalytics', 'businessProfile'], 'Google marketing features'],
  [/^(syncAdSpend|saveAdSpendAccounts)$/, 'adSpend', 'Ad spend from Meta'],
  [/^(getSocialAccounts|disconnectSocialPage)$/, ['socialInbox', 'socialPosts'], 'The social inbox and post scheduler'],
  [/^(listInbox|getInboxThread|refreshInboxPeople|replyInbox|markInboxRead|inboxCreateLead|refreshInbox|syncOldInbox)$/, 'socialInbox', 'The social inbox'],
  [/^(get|save|disconnect)LinkedIn$|^syncLinkedInLeads$/, 'linkedin', 'LinkedIn'],
  [/^(get|save|disconnect)Pinterest$/, 'pinterest', 'Pinterest'],
  [/^(getInstagramProfile|listPosts|getPost|createPost|updatePost|reschedulePost|editPublishedPost|deletePublishedPost|retryPost|deletePost|uploadPostImage|uploadPostVideoPart|finishPostVideo|discardPostVideo|syncOldPosts|getPostComments|getSocialInsights|getPostInsights)$/, 'socialPosts', 'The post scheduler'],
  [/^(listAdCampaigns|listMetaAds|setCampaignStatus|setCampaignBudget|saveAdAlerts)$/, 'adsControl', 'The ads manager'],
  [/^(listCompetitors|saveCompetitor|deleteCompetitor|recordCompetitorCheck|saveCompetitorAd|deleteCompetitorAd|setCompetitorAdActive)$/, 'competitorAds', 'Competitor ads'],
  // lead sources serve website/webhook (websiteApi) and Google Sheet imports (googleSheets); per-type check in modules/leadSources.ts
  [/LeadSource|^listInboundLog$|^retryInbound$/, ['websiteApi', 'googleSheets', 'metaLeads', 'googleAdsLeads', 'linkedin'], 'Website forms & lead API'],
  // googleStatus is not gated (it only says whether the platform is configured and which e-mail to share with)
  [/^(checkSheet|syncSheetImport|listGoogleConnections|disconnectGoogleConnection)$|SheetExport/, 'googleSheets', 'Google Sheets sync features'],
  // metaStatus is not gated (it only says whether the platform has a Meta app)
  [/^(getMetaPendingConnection|connectMetaPages|checkMetaSource|backfillMetaSource|disconnectMetaSource|metaSyncReport|retryMetaLeads)$/, 'metaLeads', 'Meta (Facebook / Instagram) Lead Ads'],
];

/** Public actions that need no company (answered without touching any company database). */
const NO_COMPANY_ACTIONS = new Set(['ping', 'setupStatus', 'createFirstAdmin', 'logError']);

/**
 * View-only users (role Viewer, e.g. founders) may only read — plus their own account (password, two-step sign-in,
 * profile, phone notifications). Every other action is refused here, whatever its own permission check.
 */
const VIEWER_ACTIONS = new Set([
  'ping', 'setupStatus', 'logError', 'login', 'logout', 'me',
  'getBootstrap', 'getEvents', 'getAllLeads', 'getSlowLeads', 'logLeadExport', 'getLeadTimeline', 'getEnquiryHistory', 'leaderboard', 'getCampaignSpend', 'getAuditLog',
  'getCalls', 'jcCallReport', 'getInventory', 'listLeadFiles', 'listRecords', 'getDriveStructure', 'chat360GetContacts', 'chat360GetMessages', 'libraryGet',
  'listInbox', 'getInboxThread', 'refreshInboxPeople', 'listAdCampaigns', 'getWebsiteAnalytics', 'getAnalyticsReport', 'getSearchPerformance', 'getSearchIndexing', 'getSearchSitemaps', 'getBusinessProfile', 'getBusinessPerformance', 'getBusinessPhotos', 'getBusinessReviews', 'listCompetitors', 'listMetaAds',
  'changePassword', 'updateProfile', 'totpSetup', 'totpEnable', 'totpDisable', 'touchSession', 'mySessions', 'endMySession', 'endMyOtherSessions', 'pushStatus', 'pushSubscribe', 'pushUnsubscribe', 'pushTest',
]);
/** The person's own account: their own number is theirs to see, whatever they may see of customers'. */
const OWN_ACCOUNT_ACTIONS = new Set(['login', 'me', 'updateProfile']);
const phonesHiddenFrom = (ctx: Ctx) => !!ctx.user && !can(ctx.user, 'leads.phones');

export const VIEW_ONLY_MESSAGE = 'You have view-only access. Ask an administrator if something needs to change.';

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
    } else if (ctx.token && !def.public) {
      // a device the CRM signed out (another device signed in, idle for an hour, signed out remotely): say why
      const why = await sessionEndReason(ctx.token);
      if (why) throw fail('AUTH_REQUIRED', why);
    }
    if (ctx.user && normalizeRole(ctx.user.role) === 'Viewer' && !VIEWER_ACTIONS.has(action)) throw fail('FORBIDDEN', VIEW_ONLY_MESSAGE);
    if (!def.public) requirePerm(ctx, def.perm);
    const hidden = phonesHiddenFrom(ctx);
    const input = data && typeof data === 'object' ? (hidden ? revealPhonesDeep(data) : data) : {};
    const result = await def.fn(input, ctx);
    return { status: 200, body: ok(hidden && !OWN_ACCOUNT_ACTIONS.has(action) ? hidePhonesDeep(result) : result), companyId: t?.id };
  } catch (err: any) {
    const code: string = err instanceof ApiError ? err.code : 'INTERNAL';
    if (!['AUTH_REQUIRED', 'AUTH_FAILED', 'FORBIDDEN', 'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMIT'].includes(code)) {
      console.error(`[rpc:${action}]`, err);
      if (currentTenant() || isTestMode()) await logError('router:' + action, code, err?.message, err?.stack, ctx.user?.email || '', { ms: Date.now() - started });
    }
    // Internal errors are logged in full but never echoed to the browser.
    const message = code === 'INTERNAL' ? 'Something went wrong on the server. The error has been logged.' : err?.message || String(err);
    const outCode = code === 'AUTH_FAILED' ? 'VALIDATION' : code;
    const hidden = phonesHiddenFrom(ctx); // "a lead with this number exists" must not hand the number over either
    const details = err instanceof ApiError ? err.details : undefined;
    return { status: code === 'AUTH_FAILED' ? 401 : STATUS[code] || 500, body: errEnvelope(outCode, hidden ? hidePhonesInText(message) : message, hidden ? hidePhonesDeep(details) : details) };
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
