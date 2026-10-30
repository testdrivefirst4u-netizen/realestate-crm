/**
 * CRM API client — the only place that talks to the backend.
 *
 * Transport: same-origin `POST /api/rpc` with a JSON body `{action, data}`.
 * The session lives in an httpOnly cookie set by the server on login, so the
 * browser never sees (or stores) the real token; the backend enforces roles.
 * Responses use the envelope `{status:'success', data}` | `{status:'error', code, message}`
 * — also on non-2xx HTTP statuses, so the body is always parsed.
 */
import { API, SYNC } from './config';
import { AppError, ErrorCode, toAppError } from './errors';
import type { LibraryContent, LibraryResponse } from '../documents/projectLibrary';
import type {
  AuthSession,
  CallRecord,
  Chat360Contact,
  Chat360Message,
  CodeVersion,
  CrmDocument,
  CrmEvent,
  DevModule,
  InventoryUnit,
  Lead,
  MessageTemplate,
  ServerSettings,
  TaskItem,
  TimelineEntry,
  UserAccount,
  NoteItem,
  ChecklistItem,
} from '../types/crm';
import type { LeadSourceActions } from '../../server/core/leadSourceTypes';
import type { SheetActions, SheetAuth } from '../../server/core/sheetTypes';
import type { MetaActions } from '../../server/core/metaTypes';

/** Request / response types of a lead-source RPC action (contract: server/core/leadSourceTypes.ts). */
type LsReq<K extends keyof LeadSourceActions> = LeadSourceActions[K]['req'];
type LsRes<K extends keyof LeadSourceActions> = LeadSourceActions[K]['res'];
/** Request / response types of a Google Sheets RPC action (contract: server/core/sheetTypes.ts). */
type ShReq<K extends keyof SheetActions> = SheetActions[K]['req'];
type ShRes<K extends keyof SheetActions> = SheetActions[K]['res'];
/** Request / response types of a Meta Lead Ads RPC action (contract: server/core/metaTypes.ts). */
type MtReq<K extends keyof MetaActions> = MetaActions[K]['req'];
type MtRes<K extends keyof MetaActions> = MetaActions[K]['res'];

export interface BootstrapPayload {
  version: string;
  serverTime: string;
  unchanged?: boolean;
  leads?: { headers: string[]; leads: Lead[] };
  config?: { fields: string[]; options: Record<string, string[]> };
  tasks?: TaskItem[];
  inventory?: InventoryUnit[];
  users?: UserAccount[];
  settings?: ServerSettings;
  events?: CrmEvent[];
  documents?: CrmDocument[];
  templates?: MessageTemplate[];
  notes?: NoteItem[];
  checklist?: ChecklistItem[];
  lastEventId?: string;
}

type Envelope<T> = { status: 'success'; data: T } | { status: 'error'; code?: string; message?: string; details?: any; isAuthError?: boolean };

/** Called when the server ends the session; receives the server's explanation (e.g. a suspended company). */
let onAuthExpired: ((message?: string) => void) | null = null;

/**
 * Only `onAuthExpired` is used. `url` / `token` are still accepted for compatibility and ignored:
 * the backend is always same-origin and the session travels in an httpOnly cookie.
 */
/** A daily lead backup kept by the server (Settings › Backups). */
export interface BackupInfo {
  id: string;
  createdAt: string;
  createdBy: string;
  count: number;
  sizeKB: number;
  /** Restore test: 'ok', 'failed' or '' (not tested yet). */
  verified?: '' | 'ok' | 'failed';
  verifyNote?: string;
}

/** A device someone is signed in on (server: auth.listUserSessions). */
export interface DeviceSession { id: string; device: string; ip: string; signedInAt: string; lastActiveAt: string; current: boolean }
export interface JcAgent { id: string; name: string; role: string; extension: string; email: string; loginId: string; status: string; canCallOut: boolean }
export interface JcAgentsRes { agents: JcAgent[]; users: Array<{ id: string; name: string; email: string; role: string; link: string; agent: JcAgent | null; auto: boolean; mobile: string }> }
/** jcMyCall: the call this user's phone is ringing for / on / just finished (server/modules/jcCalls.ts MyCall). */
export interface MyCall {
  id: string;
  phase: 'ringing' | 'live' | 'ended';
  direction: 'Inbound' | 'Outbound';
  status: string;
  phone: string;
  leadId: string;
  customerName: string;
  startTime: string;
  answeredAt: string;
  durationSec: number;
  outcome: string;
  notes: string;
  aiSummary: string;
  aiTemperature: string;
  aiTemperatureReason: string;
  aiPending: boolean;
  muted: boolean;
}
export interface JcPhoneLogin {
  websocketUrl: string;
  uri: string;
  username: string;
  password: string;
  domain: string;
  displayName: string;
  extension: string;
  callerIds: Array<{ number: string; label: string }>;
}
export interface JcReport {
  timezone: string;
  totals: { calls: number; inbound: number; outbound: number; answered: number; missed: number; notAnswered: number; talkSeconds: number; avgTalkSeconds: number | null; avgSpeedOfAnswerSeconds: number | null; answerRate: number | null; inboundAnswerRate: number | null; abandonRate: number | null; serviceLevel: number | null };
  byDay: Array<{ date: string; calls: number; answered: number; missed: number; notAnswered: number; talkSeconds: number }>;
  byAgent: Array<{ name: string; calls: number; answered: number; missed: number; notAnswered: number; talkSeconds: number; avgTalkSeconds: number | null }>;
}
export interface LeaderRow { rm: string; followups: number; calls: number; visits: number; bookings: number }
export interface SpendRow { campaign: string; month: string; amount: number }

/** Where requests go: the CRM's /api/rpc, or the Super Admin console's company proxy (company settings in the console). */
let rpcPath: string = API.rpcPath;

/**
 * `url` / `token` are legacy (Apps Script) and ignored. `rpcPath` switches to another endpoint of THIS site only
 * (a path under /api/, e.g. the console's company proxy); '' goes back to /api/rpc.
 */
export function configureApi(opts: { url?: string; token?: string | null; rpcPath?: string; onAuthExpired?: (message?: string) => void }) {
  if (opts.onAuthExpired) onAuthExpired = opts.onAuthExpired;
  if (opts.rpcPath !== undefined) rpcPath = /^\/api\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9=&%._-]*)?$/.test(opts.rpcPath) ? opts.rpcPath : API.rpcPath;
}

function mapCode(code?: string, isAuth?: boolean): ErrorCode {
  if (isAuth) return 'AUTH_REQUIRED';
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'INVALID_TOKEN':
    case 'SESSION_EXPIRED':
      return 'AUTH_REQUIRED';
    case 'FORBIDDEN':
      return 'FORBIDDEN';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'VALIDATION':
      return 'VALIDATION';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'NOT_CONFIGURED':
      return 'NOT_CONFIGURED';
    case 'RATE_LIMIT':
      return 'RATE_LIMIT';
    default:
      return 'SERVER';
  }
}

/** A response without a JSON envelope (proxy error page, crashed function…): classify it by HTTP status. */
function codeFromStatus(status: number): ErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 400 || status === 413 || status === 422) return 'VALIDATION';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMIT';
  return 'SERVER';
}

async function request<T>(action: string, data: Record<string, any> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || SYNC.requestTimeoutMs);

  try {
    const res = await fetch(rpcPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, data }),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
    });

    // Errors arrive with real HTTP statuses (401/403/…) but still carry the JSON envelope.
    const text = await res.text();
    let json: Envelope<T> | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!json || typeof json !== 'object' || !('status' in json)) {
      const code = res.ok ? 'SERVER' : codeFromStatus(res.status);
      if (code === 'AUTH_REQUIRED' && onAuthExpired) onAuthExpired();
      throw new AppError(code, `Unexpected response from the backend (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (json.status === 'success') return json.data;
    const code = mapCode(json.code, json.isAuthError);
    if (code === 'AUTH_REQUIRED' && onAuthExpired) onAuthExpired(json.message);
    throw new AppError(code, json.message || 'Backend error', json.details, code === 'SERVER' ? json.message : undefined);
  } catch (e) {
    throw toAppError(e);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------ */
/* Typed API surface                                                         */
/* ------------------------------------------------------------------------ */

export const api = {
  raw: request,

  system: {
    ping: () => request<{ message: string; serverTime: string; version: string; setupRequired?: boolean }>('ping', {}, { timeoutMs: 15000 }),
    setupStatus: () => request<{ hasUsers: boolean; version: string; sheetsReady: boolean }>('setupStatus', {}, { timeoutMs: 15000 }),
    createFirstAdmin: (data: { name: string; email: string; password: string }) => request<AuthSession>('createFirstAdmin', data),
    logError: (rec: any) => request<void>('logError', rec, { timeoutMs: 10000 }),
  },

  auth: {
    login: (email: string, password: string) => request<AuthSession>('login', { email, password }),
    me: () => request<{ user: UserAccount; expiresAt: string }>('me'),
    logout: () => request<void>('logout'),
    changePassword: (currentPassword: string, newPassword: string) => request<void>('changePassword', { currentPassword, newPassword }),
    /** Two-step sign-in (authenticator app): start, confirm with a code, turn off with the password. */
    totpSetup: () => request<{ secret: string; uri: string }>('totpSetup', {}),
    totpEnable: (code: string) => request<UserAccount>('totpEnable', { code }),
    totpDisable: (password: string) => request<UserAccount>('totpDisable', { password }),
    /** Own display name / profile photo (photo = data URL ≤ 48 000 chars; null clears it). */
    updateProfile: (data: { name?: string; avatar?: string | null; phone?: string; callVia?: 'justconnect' | 'direct' }) => request<UserAccount>('updateProfile', { data }),
    /** The person is using the CRM here: starts the 1-hour idle clock again. */
    touch: () => request<{ ok: boolean; idleMinutes: number }>('touchSession', {}),
    /** Where I am signed in (at most 2 devices), and signing one or all others out. */
    sessions: () => request<DeviceSession[]>('mySessions', {}),
    endSession: (id: string) => request<DeviceSession[]>('endMySession', { id }),
    endOtherSessions: () => request<DeviceSession[]>('endMyOtherSessions', {}),
  },

  bootstrap: (since?: string, include?: string[]) =>
    request<BootstrapPayload>('getBootstrap', { since: since || '', include: include?.join(',') || '' }),

  events: {
    since: (sinceId: string) => request<{ events: CrmEvent[]; lastEventId: string }>('getEvents', { sinceId }),
  },

  leads: {
    add: (lead: Lead) => request<{ id: string; lead: Lead; version: string }>('addLead', { data: lead }),
    update: (id: string, patch: Partial<Lead>, expectedUpdatedAt?: string) =>
      request<{ lead: Lead; version: string }>('updateLead', { id, data: patch, expectedUpdatedAt }),
    appendRemark: (id: string, remark: string, nextFollowup?: string) =>
      request<{ index: number; timestamp: string; value: string; lead: Lead; version: string }>('appendRemark', { id, remark, nextFollowup }),
    setStage: (id: string, stage: string) => request<{ lead: Lead; version: string }>('setLeadStage', { id, stage }),
    trash: (id: string) => request<{ version: string }>('trashLead', { id }),
    restore: (id: string) => request<{ version: string }>('restoreLead', { id }),
    remove: (id: string) => request<{ version: string }>('deleteLead', { id }),
    timeline: (id: string) => request<TimelineEntry[]>('getLeadTimeline', { id }),
    merge: (keepId: string, mergeIds: string[]) => request<{ id: string; merged: string[]; version: string }>('mergeLeads', { keepId, mergeIds }),
    importBulk: (leads: Lead[], strategy: string) => request<{ created: number; updated: number; skipped?: number; version: string }>('importLeads', { leads, strategy }),
  },

  backups: {
    list: () => request<BackupInfo[]>('listLeadBackups', {}),
    get: (id: string) => request<{ id: string; createdAt: string; leads: Lead[] }>('getLeadBackup', { id }),
    create: () => request<BackupInfo | null>('createLeadBackup', {}),
    verify: () => request<{ id: string; ok: boolean; note: string } | null>('verifyLeadBackup', {}),
  },

  /** JustConnect calling: test, CRM user ↔ agent links (Settings), click-to-call and its progress. */
  justconnect: {
    test: () => request<{ ok: boolean; message: string; business: string; scopes: string[]; missing: string[] }>('jcTest', {}, { timeoutMs: 30000 }),
    agents: () => request<JcAgentsRes>('jcAgents', {}, { timeoutMs: 30000 }),
    setAgent: (userId: string, agent: string) => request<JcAgentsRes>('jcSetAgent', { userId, agent }, { timeoutMs: 30000 }),
    call: (d: { leadId?: string; phone?: string }) => request<{ mode: 'app' | 'mobile'; requestId: string; status: string }>('jcClickToCall', d, { timeoutMs: 30000 }),
    outcomes: () => request<Array<{ code: string; label: string; parent: string | null; positive: boolean; needsNote: boolean }>>('jcOutcomes', {}, { timeoutMs: 30000 }),
    fileOutcome: (callId: string, outcome: string, notes: string) => request<CallRecord>('jcFileOutcome', { callId, outcome, notes }, { timeoutMs: 30000 }),
    report: (since: string, until: string) => request<JcReport>('jcCallReport', { since, until }, { timeoutMs: 45000 }),
    contactStatus: () => request<{ on: boolean; synced: number; waiting: number; failed: number }>('jcContactStatus', {}),
    syncContacts: () => request<{ sent: number; failed: number; left: number; skipped?: string }>('jcSyncContacts', {}, { timeoutMs: 60000 }),
    syncCalls: () => request<{ saved: number; created: number; finished: number; skipped?: string }>('jcSyncCalls', {}, { timeoutMs: 60000 }),
    callStatus: (id: string, mode: 'app' | 'mobile') => request<{ status: string; callStatus: string; talkSeconds: number; connected?: boolean; ended?: boolean }>('jcCallStatus', { id, mode }),
    /** The call window: what this user's phone is doing right now (or one call, to wait for its AI summary). */
    myCall: (id?: string) => request<MyCall | null>('jcMyCall', id ? { id } : {}, { timeoutMs: 10000 }),
    /** Live call buttons (calls:control): end, transfer (colleague or number), mute, unmute — on the CRM call id. */
    control: (callId: string, action: 'end' | 'transfer' | 'mute' | 'unmute', to?: string) => request<{ ok: true; muted?: boolean; to?: string }>('jcCallControl', { callId, action, to }, { timeoutMs: 20000 }),
    transferTargets: () => request<Array<{ id: string; name: string; extension: string; status: string }>>('jcTransferTargets', {}, { timeoutMs: 20000 }),
    myStatus: () => request<{ agent: { name: string; extension: string; status: string; canCallOut: boolean } | null }>('jcMyStatus', {}, { timeoutMs: 20000 }),
    setMyStatus: (status: string) => request<{ status: string }>('jcSetMyStatus', { status }, { timeoutMs: 20000 }),
    /** This user's own phone login, for the phone inside the CRM (phones:connect). Kept in memory only. */
    myPhone: () => request<JcPhoneLogin>('jcMyPhone', {}, { timeoutMs: 20000 }),
  },

  /** Phone notifications (Web Push) for the signed-in user's devices. */
  push: {
    status: () => request<{ configured: boolean; publicKey: string; devices: Array<{ id: string; device: string; createdAt: string }> }>('pushStatus', {}),
    subscribe: (subscription: unknown) => request<{ configured: boolean; publicKey: string; devices: Array<{ id: string; device: string; createdAt: string }> }>('pushSubscribe', { subscription }),
    unsubscribe: (by: { endpoint?: string; id?: string }) => request<{ configured: boolean; publicKey: string; devices: Array<{ id: string; device: string; createdAt: string }> }>('pushUnsubscribe', by),
    test: () => request<{ sent: number }>('pushTest', {}),
  },

  team: {
    leaderboard: (days = 7) => request<{ from: string; to: string; rows: LeaderRow[] }>('leaderboard', { days }),
    spend: () => request<{ rows: SpendRow[] }>('getCampaignSpend', {}),
    saveSpend: (month: string, rows: Array<{ campaign: string; amount: number }>) => request<{ rows: SpendRow[] }>('saveCampaignSpend', { month, rows }),
  },

  tasks: {
    add: (task: Omit<TaskItem, 'id'> & { id?: string }) => request<{ id: string; task: TaskItem; version: string }>('addTask', { data: task }),
    update: (id: string, patch: Partial<TaskItem>) => request<{ task: TaskItem; version: string }>('updateTask', { id, data: patch }),
    toggle: (id: string, completed: boolean) => request<{ task: TaskItem; version: string }>('toggleTask', { id, completed }),
    remove: (id: string) => request<{ version: string }>('deleteTask', { id }),
    snooze: (id: string, untilIso: string) => request<{ task: TaskItem; version: string }>('snoozeTask', { id, until: untilIso }),
  },

  inventory: {
    list: () => request<{ units: InventoryUnit[]; version: string }>('getInventory'),
    update: (inventoryId: string, patch: Partial<InventoryUnit>, expectedLastModified?: string) =>
      request<{ unit: InventoryUnit; version: string; conflict?: InventoryUnit }>('updateInventoryUnit', { id: inventoryId, data: patch, expectedLastModified }),
    add: (unit: Partial<InventoryUnit>) => request<{ unit: InventoryUnit; version: string }>('addInventoryUnit', { data: unit }),
    importUnits: (units: Partial<InventoryUnit>[]) => request<{ created: number; skipped: number; version: string }>('importInventory', { units }),
  },

  records: {
    list: <T>(kind: 'documents' | 'templates' | 'notes' | 'checklist') => request<T[]>('listRecords', { kind }),
    save: <T>(kind: 'documents' | 'templates' | 'notes' | 'checklist', record: T) => request<T>('saveRecord', { kind, data: record }),
    remove: (kind: 'documents' | 'templates' | 'notes' | 'checklist', id: string) => request<void>('deleteRecord', { kind, id }),
  },

  storage: {
    uploadLeadFile: (leadId: string, category: string, name: string, mime: string, base64: string, description?: string) =>
      request<CrmDocument>('uploadLeadFile', { leadId, category, name, mime, base64, description }, { timeoutMs: 120000 }),
    listLeadFiles: (leadId: string) => request<CrmDocument[]>('listLeadFiles', { leadId }),
    structure: () => request<{ rootUrl: string; rootId?: string; folders: Array<{ name: string; url: string }> }>('getDriveStructure'),
  },

  chat360: {
    contacts: () => request<Chat360Contact[]>('chat360GetContacts'),
    messages: (phone: string) => request<Chat360Message[]>('chat360GetMessages', { phone }),
    send: (payload: { leadId?: string; phone: string; text?: string; templateName?: string; params?: string[] }) =>
      request<{ message: Chat360Message }>('chat360Send', payload),
    test: () => request<{ ok: boolean; message: string }>('chat360Test'),
    /** Which webhook events Chat360 has sent (count, first / last time, payload shape). */
    webhookStats: () => request<Array<{ event: string; count: number; firstAt: string; lastAt: string; shape: string }>>('chat360WebhookStats'),
    mapContact: (phone: string, leadId: string) => request<void>('chat360MapContact', { phone, leadId }),
    markRead: (phone: string) => request<void>('chat360MarkRead', { phone }),
  },

  calls: {
    list: (leadId?: string) => request<CallRecord[]>('getCalls', { leadId: leadId || '' }),
    log: (call: Partial<CallRecord>) => request<CallRecord>('logCall', { data: call }),
    update: (id: string, patch: Partial<CallRecord>) => request<CallRecord>('updateCall', { id, data: patch }),
    uploadRecording: (callId: string, name: string, mime: string, base64: string) =>
      request<CallRecord>('uploadCallRecording', { callId, name, mime, base64 }, { timeoutMs: 180000 }),
    transcribe: (callId: string) => request<CallRecord>('transcribeCall', { callId }, { timeoutMs: 180000 }),
    summarize: (callId: string) => request<CallRecord>('summarizeCall', { callId }, { timeoutMs: 120000 }),
    /** An older one-paragraph transcript, split into Sales Executive / Customer turns. */
    splitTranscript: (callId: string) => request<CallRecord>('splitCallTranscript', { callId }, { timeoutMs: 120000 }),
  },

  ai: {
    chat: (payload: { contents: any[]; systemInstruction?: string; tools?: any[]; model?: string; toolConfig?: any }) =>
      request<{ candidates: any[]; model: string }>('aiChat', payload, { timeoutMs: 90000 }),
    reframe: (text: string) => request<{ result: string }>('aiReframe', { text }, { timeoutMs: 45000 }),
    transcribe: (audioBase64: string, mimeType: string) => request<{ transcription: string }>('aiTranscribe', { audioBase64, mimeType }, { timeoutMs: 120000 }),
    summarizeLead: (leadId: string) => request<{ summary: string }>('aiSummarizeLead', { leadId }, { timeoutMs: 60000 }),
    test: () => request<{ ok: boolean; message: string; model: string }>('aiTest', {}, { timeoutMs: 45000 }),
  },

  settings: {
    get: () => request<ServerSettings>('getSettings'),
    update: (patch: Partial<ServerSettings>) => request<ServerSettings>('updateSettings', { data: patch }),
    setSecret: (key: 'GEMINI_API_KEY' | 'CHAT360_API_KEY' | 'CHAT360_LOGIN_PASSWORD' | 'CHAT360_WEBHOOK_SECRET' | 'TELEPHONY_WEBHOOK_SECRET' | 'JUSTCONNECT_API_KEY' | 'JUSTCONNECT_WEBHOOK_SECRET', value: string) =>
      request<ServerSettings>('setSecret', { key, value }),
    users: {
      list: () => request<UserAccount[]>('listUsers'),
      save: (user: Partial<UserAccount> & { password?: string }) => request<UserAccount & { temporaryPassword?: string }>('saveUser', { data: user }),
      remove: (id: string) => request<void>('deleteUser', { id }),
      resetPassword: (id: string, newPassword: string) => request<void>('resetPassword', { id, newPassword }),
      /** Devices each person is signed in on; an admin signs one (or all) out. */
      sessionCounts: () => request<Record<string, number>>('sessionCounts', {}),
      sessions: (userId: string) => request<DeviceSession[]>('userSessions', { userId }),
      endSessions: (userId: string, id?: string) => request<DeviceSession[]>('endUserSessions', { userId, id }),
    },
    saveReportSnapshot: (payload: { title: string; range: string; rows: Array<Record<string, any>> }) =>
      request<{ url: string }>('saveReportSnapshot', payload, { timeoutMs: 60000 }),
    audit: (limit = 200) => request<any[]>('getAuditLog', { limit }),
    errors: (limit = 100) => request<any[]>('getErrorLog', { limit }),
  },

  /** Lead sources (website forms / webhooks → leads). Viewing needs `settings.view`, managing `settings.edit`; plan feature `websiteApi`. */
  leadSources: {
    list: () => request<LsRes<'listLeadSources'>>('listLeadSources', {}),
    create: (data: LsReq<'createLeadSource'>) => request<LsRes<'createLeadSource'>>('createLeadSource', data),
    update: (id: string, patch: LsReq<'updateLeadSource'>['patch']) => request<LsRes<'updateLeadSource'>>('updateLeadSource', { id, patch }),
    rotateKey: (id: string) => request<LsRes<'rotateLeadSourceKey'>>('rotateLeadSourceKey', { id }),
    remove: (id: string) => request<LsRes<'deleteLeadSource'>>('deleteLeadSource', { id }),
    log: (opts: LsReq<'listInboundLog'> = {}) => request<LsRes<'listInboundLog'>>('listInboundLog', opts),
    retry: (id: string) => request<LsRes<'retryInbound'>>('retryInbound', { id }),
    /** Map a sample payload with the source's settings without saving anything. */
    preview: (id: string, payload: Record<string, unknown>) => request<LsRes<'previewLeadSource'>>('previewLeadSource', { id, payload }),
  },

  /** Google Sheets (plan feature `googleSheets`; view settings.view, manage settings.edit). Imports are lead sources of type 'google_sheet'. */
  sheets: {
    googleStatus: () => request<ShRes<'googleStatus'>>('googleStatus', {}),
    /** Title, tabs and header row of a sheet (claims nothing). Google can be slow — generous timeout. */
    checkSheet: (data: ShReq<'checkSheet'>) => request<ShRes<'checkSheet'>>('checkSheet', data, { timeoutMs: 60000 }),
    /** Google accounts connected with "Connect with Google" (OAuth). */
    connections: () => request<ShRes<'listGoogleConnections'>>('listGoogleConnections', {}),
    /** Revokes the token at Google; CONFLICT while imports/exports use it unless `force` (which pauses them). */
    disconnectConnection: (id: string, force?: boolean) => request<ShRes<'disconnectGoogleConnection'>>('disconnectGoogleConnection', { id, ...(force ? { force: true } : {}) }, { timeoutMs: 60000 }),
    syncImport: (sourceId: string) => request<ShRes<'syncSheetImport'>>('syncSheetImport', { sourceId }, { timeoutMs: 120000 }),
    listExports: () => request<ShRes<'listSheetExports'>>('listSheetExports', {}),
    createExport: (data: ShReq<'createSheetExport'>) => request<ShRes<'createSheetExport'>>('createSheetExport', data, { timeoutMs: 60000 }),
    updateExport: (id: string, patch: ShReq<'updateSheetExport'>['patch'] & { auth?: SheetAuth }) => request<ShRes<'updateSheetExport'>>('updateSheetExport', { id, patch }),
    removeExport: (id: string) => request<ShRes<'deleteSheetExport'>>('deleteSheetExport', { id }),
    runExport: (id: string) => request<ShRes<'runSheetExport'>>('runSheetExport', { id }, { timeoutMs: 120000 }),
  },

  /** Meta (Facebook / Instagram) Lead Ads (plan feature `metaLeads`; view settings.view, manage settings.edit). Each Page is a lead source of type 'meta'. */
  meta: {
    status: () => request<MtRes<'metaStatus'>>('metaStatus', {}),
    /** Pages from a finished Facebook login (the `metaConnect` id of the redirect). */
    pending: (pendingId: string) => request<MtRes<'getMetaPendingConnection'>>('getMetaPendingConnection', { pendingId }, { timeoutMs: 60000 }),
    /** One lead source per chosen Page (subscribes the app to each Page — Facebook can be slow). */
    connect: (data: MtReq<'connectMetaPages'>) => request<MtRes<'connectMetaPages'>>('connectMetaPages', data, { timeoutMs: 120000 }),
    check: (sourceId: string) => request<MtRes<'checkMetaSource'>>('checkMetaSource', { sourceId }, { timeoutMs: 60000 }),
    backfill: (sourceId: string, days?: number) => request<MtRes<'backfillMetaSource'>>('backfillMetaSource', { sourceId, ...(days ? { days } : {}) }, { timeoutMs: 180000 }),
    disconnect: (sourceId: string) => request<MtRes<'disconnectMetaSource'>>('disconnectMetaSource', { sourceId }, { timeoutMs: 60000 }),
    /** Facebook sync page; compare = read the forms from Facebook (slower). */
    syncReport: (compare = false) => request<MtRes<'metaSyncReport'>>('metaSyncReport', { compare }, { timeoutMs: compare ? 120000 : 30000 }),
    retryLeads: () => request<MtRes<'retryMetaLeads'>>('retryMetaLeads', {}, { timeoutMs: 90000 }),
  },

  /** Retired Developer Mode actions — kept for API compatibility; the server answers with an explanatory error. */
  /** The company's Project Library (null content = the library built into the app). Saving is for admins and the chosen editors. */
  library: {
    get: () => request<LibraryResponse>('libraryGet'),
    /** `baseUpdatedAt`: when the library being edited was saved; the server refuses if someone saved since. */
    save: (content: LibraryContent | null, baseUpdatedAt?: string) => request<LibraryResponse>('librarySave', { content, baseUpdatedAt }),
    /** Admins: who else may edit the library (e-mails of active users). */
    setEditors: (emails: string[]) => request<LibraryResponse>('librarySetEditors', { emails }),
    /** One ~3 MB piece of a file being added (pieces keep each request under the host's size limit). */
    uploadPart: (uploadId: string, index: number, base64: string) => request<{ ok: boolean }>('libraryUploadPart', { uploadId, index, base64 }, { timeoutMs: 120000 }),
    /** Read the uploaded file into a new library document. */
    importFile: (d: { uploadId: string; parts: number; name: string; mime: string; title?: string; category?: string }) =>
      request<LibraryResponse & { added: { id: string; title: string; chapters: number; passages: number } }>('libraryImport', d, { timeoutMs: 300000 }),
  },

  dev: {
    status: () => request<{ apiEnabled: boolean; scriptId: string; deploymentId?: string; message?: string; canDeploy: boolean; protectedFiles?: string[]; autoDeploy?: boolean }>('devStatus'),
    listModules: () => request<DevModule[]>('devListModules'),
    getModule: (name: string) => request<DevModule>('devGetModule', { name }),
    validate: (name: string, source: string) => request<{ ok: boolean; errors: Array<{ line?: number; message: string }> }>('devValidate', { name, source }),
    save: (name: string, source: string, note?: string) => request<{ version: CodeVersion; deployed?: boolean; message?: string }>('devSaveModule', { name, source, note }, { timeoutMs: 90000 }),
    deploy: (description?: string) => request<{ versionNumber: number; deploymentId: string; message: string }>('devDeploy', { description }, { timeoutMs: 90000 }),
    versions: (file?: string) => request<CodeVersion[]>('devListVersions', { file: file || '' }),
    rollback: (versionId: string) => request<{ message: string; version: CodeVersion }>('devRollback', { versionId }, { timeoutMs: 90000 }),
  },
};

export type Api = typeof api;
