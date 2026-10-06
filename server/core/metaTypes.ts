/**
 * Meta (Facebook / Instagram) Lead Ads — shared types for the server, the CRM settings screen and the console.
 * Types only: safe to `import type` from client code.
 *
 * Platform (super admin, Platform settings): ONE Meta app — App ID, App Secret (encrypted), webhook verify
 * token (generated), Graph API version, optional "Facebook Login for Business" configuration id. Env fallback:
 * META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN, META_GRAPH_VERSION, META_LOGIN_CONFIG_ID.
 *
 * Webhook: one URL for the whole platform — `${APP_URL}/api/webhooks/meta`
 *   GET  hub.mode=subscribe & hub.verify_token & hub.challenge → echo the challenge when the token matches.
 *   POST object 'page', entry[].changes[] field 'leadgen' {leadgen_id, page_id, form_id, ad_id, created_time};
 *        X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(appSecret, raw body) — verified before parsing.
 *        Each leadgen is queued (platform `metaLeadQueue`, unique leadgen_id) and the request answers 200 at once;
 *        the lead is fetched from the Graph API with the Page token and passed to the intake pipeline
 *        (idempotency key `meta:<leadgen_id>`). GET /api/cron/meta (every 5 min) retries the queue; once a day it
 *        backfills the last 7 days from each connected form (leads are idempotent, so nothing is duplicated).
 *
 * Company: a lead source of type 'meta' per connected Page (LeadSource.config.meta). The Page id is claimed in the
 * platform (`metaPages` {_id: pageId, companyId, sourceId}) — one company per Page. The Page access token is stored
 * encrypted on the source and never returned.
 *
 * Connect flow (company admin): GET /api/integrations/meta/connect → Facebook OAuth (signed state bound to the
 * user's session) → GET /api/integrations/meta/callback → long-lived user token → /me/accounts (Pages + Page
 * tokens) → a short-lived pending connection (company `metaConnections`, TTL 30 min, tokens encrypted) →
 * redirect to `/settings?section=leadSources&metaConnect=<pendingId>` → the UI lets the admin pick Pages/forms →
 * connectMetaPages.
 */

export interface MetaSourceConfig {
  pageId: string;
  pageName: string;
  /** Only these lead forms (empty = every form of the Page). */
  formIds: string[];
  /** Cached form list for the UI. */
  forms: Array<{ id: string; name: string; status: string }>;
  connectedBy: string;
  connectedAt: string;
  /** Whether the app is subscribed to the Page's `leadgen` field (checked on connect / health check). */
  subscribed: boolean;
  lastLeadAt: string;
  lastBackfillAt: string;
  lastError: string;
}

export interface MetaStatus {
  configured: boolean; // app id + secret + verify token present
  appId: string;
  graphVersion: string;
  /** The callback URL to paste into the Meta app's Webhooks product (object Page, field leadgen). */
  webhookUrl: string;
  /** The OAuth redirect URI to add under Facebook Login › Valid OAuth Redirect URIs. */
  oauthRedirectUri: string;
  source: 'env' | 'platform' | 'none';
}

export interface MetaPendingPage {
  id: string;
  name: string;
  /** False when the Facebook user lacks the tasks needed to read leads (needs MANAGE/ADVERTISE on the Page). */
  canReadLeads: boolean;
  /** Already linked to another workspace (cannot be chosen). */
  claimedElsewhere: boolean;
  /** Already connected in this company. */
  alreadyConnected: boolean;
  forms: Array<{ id: string; name: string; status: string }>;
}

/** Company CRM actions (POST /api/rpc). View: settings.view; manage: settings.edit. Plan feature: metaLeads. */
export interface MetaActions {
  metaStatus: { req: {}; res: MetaStatus & { connectUrl: string } };
  /** Pages from a finished Facebook login (`metaConnect` id from the redirect). */
  getMetaPendingConnection: { req: { pendingId: string }; res: { pages: MetaPendingPage[]; expiresAt: string } };
  /** Create one lead source per chosen Page (subscribes the app to the Page, claims it). */
  connectMetaPages: {
    req: { pendingId: string; pages: Array<{ pageId: string; formIds: string[] }>; defaults?: { sourceLabel?: string; assignment?: { mode: 'unassigned' | 'fixed' | 'round_robin'; rm: string; rms: string[] }; duplicates?: 'remark' | 'skip' | 'create'; defaultStage?: string } };
    res: { created: string[]; skipped: Array<{ pageId: string; reason: string }> };
  };
  /** Re-check the Page token/subscription and refresh the form list. */
  checkMetaSource: { req: { sourceId: string }; res: { ok: boolean; message: string; forms: Array<{ id: string; name: string; status: string }>; subscribed: boolean } };
  /** Pull recent leads (default last 7 days) from the Page's forms; idempotent. */
  backfillMetaSource: { req: { sourceId: string; days?: number }; res: { created: number; duplicates: number; rejected: number; failed: number; message: string } };
  /** Unsubscribe the app from the Page, release the claim, delete the token and the source. */
  disconnectMetaSource: { req: { sourceId: string }; res: { ok: true } };
}

/** Super-admin actions (POST /api/platform/rpc). */
export interface PlatformMetaActions {
  getMetaSettings: { req: {}; res: MetaStatus & { verifyToken: string; loginConfigId: string; updatedAt: string; updatedBy: string; queue: { pending: number; failed: number; done24h: number } } };
  /** appSecret '' keeps the stored one; verifyToken '__generate__' creates a new random token. */
  setMetaSettings: { req: { appId: string; appSecret?: string; verifyToken?: string; graphVersion?: string; loginConfigId?: string }; res: PlatformMetaActions['getMetaSettings']['res'] };
  /** App access token check (GET /oauth/access_token?grant_type=client_credentials). */
  testMetaSettings: { req: {}; res: { ok: boolean; message: string } };
  /** A company's connected Pages for the Integrations tab. */
  companyMeta: { req: { companyId: string }; res: Array<{ sourceId: string; name: string; status: string; meta: MetaSourceConfig; stats: { received: number; created: number; duplicates: number; failed: number; lastReceivedAt: string } }> };
  /** Connect a Page on the company's behalf with a Page access token (e.g. from Graph API Explorer). */
  connectCompanyMetaPage: { req: { companyId: string; pageId: string; pageAccessToken: string; formIds?: string[] }; res: { sourceId: string } };
  /** Retry failed queue items for a company (or all companies when companyId is ''). */
  retryMetaQueue: { req: { companyId: string }; res: { retried: number } };
}
