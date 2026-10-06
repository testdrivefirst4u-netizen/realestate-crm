/**
 * Google Sheets integration — shared types for the server, the CRM settings screen and the console.
 * Types only: safe to `import type` from client code.
 *
 * Access model — two ways to reach a sheet (chosen per import/export via `auth`):
 *  1. "Connect with Google" (OAuth, no key file): a company admin signs in with their own Google account
 *     (scope spreadsheets + openid email, offline access). The refresh token is stored encrypted per company
 *     (`googleConnections`); access tokens are refreshed on demand. Platform: one Google OAuth client
 *     (Client ID + Secret) set by the super admin in Platform settings (env fallback GOOGLE_OAUTH_CLIENT_ID /
 *     GOOGLE_OAUTH_CLIENT_SECRET). Redirect URI `${APP_URL}/api/integrations/google/callback`.
 *     Flow: GET /api/integrations/google/connect (CRM session, settings.edit, plan googleSheets) → Google consent
 *     (signed state bound to the user) → GET /api/integrations/google/callback → redirect to
 *     `/settings?section=googleSheets&googleConnected=<connectionId>` or `…&googleError=<message>`.
 *     Disconnect revokes the token at Google.
 *  2. Platform service account: ONE platform Google service account (set by the super admin in Platform settings, or
 * the GOOGLE_SERVICE_ACCOUNT_JSON env). A company shares its sheet with that account's e-mail
 * (Viewer is enough for import; Editor for export and for writing the import status column).
 * A spreadsheet can be linked to only one company (platform claim), so a company cannot read another
 * company's sheet through the shared account.
 *
 * Import  = a lead source of type 'google_sheet' (LeadSource.config.sheet), processed by the same intake
 *           pipeline as website forms (mapping, duplicates, assignment, intake log, stats).
 * Export  = a one-way copy of the company's leads into a tab, rewritten when data changed.
 * Cron    = GET /api/cron/sheets (every 5 min) runs due imports and exports for every active company with
 *           the plan feature `googleSheets`.
 */

export type SyncInterval = 5 | 15 | 60 | 0; // minutes; 0 = manual only

/** How a sheet is reached. Missing = service account (backward compatible). */
export type SheetAuth = { mode: 'service_account' } | { mode: 'oauth'; connectionId: string };

export interface GoogleConnection {
  id: string; // GCN-0001
  email: string; // the Google account that granted access
  status: 'Active' | 'Error';
  lastError: string; // e.g. "Google access was revoked — reconnect"
  connectedBy: string;
  connectedAt: string;
  /** Imports/exports that use this connection. */
  usedBy: number;
}

export interface SheetImportConfig {
  auth?: SheetAuth;
  spreadsheetUrl: string; // as pasted; the id is parsed from it
  spreadsheetId: string; // filled by the server
  tab: string; // sheet/tab name; '' = first tab
  headerRow: number; // 1-based row holding the column headers (default 1)
  /** Optional header of a column the CRM writes back to ("Imported ENQ-0042 · 05 Oct 2026, 15:30" / error).
   *  When present, rows with a value in it are skipped — robust to inserted/sorted rows. Needs Editor access. */
  statusColumn: string;
  intervalMinutes: SyncInterval;
  /** Last data row (1-based sheet row) imported when no status column is used. */
  lastRow: number;
  lastSyncAt: string;
  lastSyncResult: string; // e.g. "3 new, 1 duplicate" or the error
}

export interface SheetExportColumns {
  /** Lead headers to export, in order (default: the common ones). */
  headers: string[];
  includeFollowups: boolean; // adds "Follow-ups" (all remarks joined)
  includeTrash: boolean;
}

export interface SheetExport {
  id: string; // SHX-0001
  auth?: SheetAuth;
  name: string;
  spreadsheetUrl: string;
  spreadsheetId: string;
  tab: string; // created if missing (default "CRM Leads")
  columns: SheetExportColumns;
  intervalMinutes: SyncInterval;
  status: 'Active' | 'Paused';
  lastSyncAt: string;
  lastRows: number;
  lastError: string;
  createdAt: string;
  createdBy: string;
}

export interface SheetCheckResult {
  ok: boolean;
  title: string; // spreadsheet title
  tabs: string[];
  headers: string[]; // header row of the chosen tab
  canWrite: boolean;
  message: string; // human explanation when !ok ("Share the sheet with …")
}

export interface GoogleStatus {
  /** Service account configured. */
  configured: boolean;
  serviceAccountEmail: string; // '' when not configured
  source: 'env' | 'platform' | 'none';
  /** "Connect with Google" (OAuth client) configured. */
  oauthConfigured: boolean;
  /** Where the browser goes to connect a Google account ('/api/integrations/google/connect'). */
  connectUrl: string;
}

/** Company CRM actions (POST /api/rpc). View: settings.view; manage: settings.edit. Plan feature: googleSheets. */
export interface SheetActions {
  googleStatus: { req: {}; res: GoogleStatus };
  /** Read title/tabs/headers of a sheet the company wants to link (claims nothing). */
  checkSheet: { req: { spreadsheetUrl: string; tab?: string; headerRow?: number; auth?: SheetAuth }; res: SheetCheckResult };
  listGoogleConnections: { req: {}; res: GoogleConnection[] };
  /** Revokes the token at Google; refuses (CONFLICT) while imports/exports still use it unless force. */
  disconnectGoogleConnection: { req: { id: string; force?: boolean }; res: { ok: true } };
  /** Import sources are created/updated via createLeadSource/updateLeadSource with type 'google_sheet' and config.sheet. */
  syncSheetImport: { req: { sourceId: string }; res: { created: number; duplicates: number; rejected: number; failed: number; message: string } };
  listSheetExports: { req: {}; res: SheetExport[] };
  createSheetExport: { req: { name: string; spreadsheetUrl: string; tab?: string; columns?: Partial<SheetExportColumns>; intervalMinutes?: SyncInterval; auth?: SheetAuth }; res: SheetExport };
  updateSheetExport: { req: { id: string; patch: Partial<Pick<SheetExport, 'name' | 'tab' | 'intervalMinutes' | 'status'>> & { columns?: Partial<SheetExportColumns>; auth?: SheetAuth } }; res: SheetExport };
  deleteSheetExport: { req: { id: string }; res: { ok: true } };
  runSheetExport: { req: { id: string }; res: SheetExport };
}

export type GoogleSettingsView = GoogleStatus & {
  projectId: string;
  updatedAt: string;
  updatedBy: string;
  oauthClientId: string;
  oauthSecretSet: boolean;
  oauthSource: 'env' | 'platform' | 'none';
  /** Add this under the OAuth client's "Authorised redirect URIs". */
  oauthRedirectUri: string;
};

/** Super-admin actions (POST /api/platform/rpc). */
export interface PlatformSheetActions {
  getGoogleSettings: { req: {}; res: GoogleSettingsView };
  /** "Connect with Google" OAuth client. clientSecret '' keeps the stored one; clientId '' removes the client. */
  setGoogleOAuthClient: { req: { clientId: string; clientSecret?: string }; res: GoogleSettingsView };
  /** Paste the service-account JSON key (stored encrypted). Empty string removes it. */
  setGoogleServiceAccount: { req: { json: string }; res: GoogleSettingsView };
  /** Obtain an access token to prove the key works. */
  testGoogleServiceAccount: { req: {}; res: { ok: boolean; message: string } };
  /** A company's sheet links (imports + exports) for the Integrations tab. */
  companySheets: { req: { companyId: string }; res: { connections: GoogleConnection[]; imports: Array<{ sourceId: string; name: string; spreadsheetUrl: string; tab: string; status: string; lastSyncAt: string; lastSyncResult: string; auth?: SheetAuth }>; exports: SheetExport[] } };
}
