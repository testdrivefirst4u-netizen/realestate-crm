/**
 * Amaya CRM — shared domain types.
 *
 * The original Google Sheet column names are used verbatim as object keys on Lead so
 * that the frontend, the server and imported data always agree.
 * Date-bearing fields hold ISO-8601 strings (UTC) once they have passed through
 * `normalizeLead()`; legacy strings are tolerated by `parseDate()` in core/dates.
 */

export interface Lead {
  _row?: number;
  'Enquiry ID': string;
  'Enquiry Date': string;
  'Prospect Name': string;
  'Phone Number': string;
  Email: string;
  'Lead Stage': string;
  'Enquiry Source': string;
  'Unit Type Interested In': string;
  'Purchase or Rent': string;
  'Site Visit Status': string;
  'Site Visit Date'?: string;
  'Booking Date'?: string;
  'Next Follow-up Date': string;
  'Enquiry Notes': string;
  'Assigned RM': string;
  'Brochure Shared': string;
  'Relationship to Prospect': string;
  'Enquired For': string;
  'Last Follow-up Date & Time'?: string;
  'Created At'?: string;
  'Updated At'?: string;
  'Updated By'?: string;
  [key: string]: any; // Follow-up 1..50 and any extra sheet columns
}

export interface TaskItem {
  id: string;
  name: string;
  lead: string; // prospect name (legacy, kept for display)
  leadId?: string; // ENQ-xxxx when linked
  datetime: string; // ISO
  status: 'Pending' | 'Completed';
  completed: boolean;
  checklist: Array<{ text: string; checked: boolean }>;
  assignedTo?: string;
  createdAt?: string;
  completedAt?: string;
  snoozedUntil?: string; // ISO — alarm suppressed until this time
  createdBy?: string;
  row?: number;
}

export type InventoryStatus = 'Available' | 'Reserved' | 'Booked' | 'Sold' | 'Owner' | 'Blocked';

export interface InventoryUnit {
  inventoryId: string; // INV-xxxx stable id
  unitId: string; // Unit Number e.g. A101 (kept as unitId for backwards compatibility)
  tower: string;
  floor: string | number;
  unitType: string;
  carpetArea: number;
  totalArea: number; // built-up / super built-up area
  uds: number;
  facing?: string;
  status: InventoryStatus;
  price?: number;
  availability?: string;
  bookingStatus?: string;
  bookedDate?: string;
  customerName?: string;
  contact?: string;
  leadId?: string;
  notes?: string;
  lastModified?: string; // ISO
  modifiedBy?: string; // 'Sheet' | 'CRM:<user>' | 'Import'
  syncStatus?: 'Synced' | 'Pending' | 'Conflict' | 'Error';
  syncError?: string;
  /** From the master inventory: 'Developer' | 'Land Owner' (land-owner share units are not for sale). */
  ownership?: string;
  mortgaged?: boolean;
  row?: number;
}

export interface CrmDocument {
  id: string;
  leadId?: string;
  name: string;
  category: string;
  fileUrl: string;
  driveFileId?: string;
  uploadedDate: string;
  uploadedBy?: string;
  description: string;
  row?: number;
}

export interface MessageTemplate {
  id: string;
  type: string;
  name: string;
  message: string;
  updated?: string;
  row?: number;
}

export interface NoteItem {
  id: string;
  text: string;
  created: string;
  updated: string;
  row?: number;
}

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
  updated: string;
  row?: number;
}

export interface CRMConfig {
  fields: string[];
  options: Record<string, string[]>;
}

export interface CRMSettings {
  dialerTemplate: string;
  waTemplate: string;
  emailSubject: string;
  emailBody: string;
  timeZone: string;
  aiConfigured: boolean;
  geminiModel: string;
  autoSyncIntervalSec?: number; // 0 = manual
  lastSyncTime?: string; // ISO
  lastSyncVersion?: string;
}

/** Server-side settings that are safe to show in the UI. Secrets are never returned. */
export interface ServerSettings {
  appName?: string;
  timeZone?: string;
  aiModel?: string;
  aiFastModel?: string;
  aiTranscribeModel?: string;
  aiConfigured?: boolean;
  geminiKeyMasked?: string;
  chat360Configured?: boolean;
  chat360KeyMasked?: string;
  chat360BaseUrl?: string;
  chat360SendPath?: string;
  chat360TemplatePath?: string;
  chat360AuthHeader?: string;
  chat360AuthPrefix?: string;
  chat360AutoCreateLeads?: boolean;
  chat360DefaultRM?: string;
  chat360DefaultSource?: string;
  chat360WebhookUrl?: string;
  chat360WebhookSecretSet?: boolean;
  telephonyWebhookUrl?: string;
  telephonyWebhookSecretSet?: boolean;
  telephonyFieldMap?: string;
  driveRootFolderId?: string;
  driveRootFolderUrl?: string;
  features?: Record<string, boolean>;
  /** The signed-in user's company (multi-company mode). */
  company?: { id: string; slug: string; name: string; logo: string; tagline: string; plan: string; maxUsers: number } | null;
  /** The platform supplies a Gemini key (the company may still set its own). */
  aiPlatformKey?: boolean;
  maxFollowups?: number;
  /** What RMs see: own | own_unassigned | all (server/core/scope.ts). */
  rmLeadVisibility?: 'own' | 'own_unassigned' | 'all';
  deploymentId?: string;
  devAutoDeploy?: boolean;
  dailyDigestEmail?: string;
  scriptId?: string;
  webAppUrl?: string;
  version?: string;
}

export type NotificationType = 'info' | 'success' | 'warning' | 'alert';

export interface NotificationItem {
  id: string;
  key: string; // unique event key (type:recordId:eventId) — one notification per key
  title: string;
  message: string;
  timestamp: string; // ISO
  type: NotificationType;
  read: boolean;
  recordType?: string;
  recordId?: string;
  link?: string;
}

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  type: NotificationType;
  createdAt: number;
}

/** Server event (record in the events collection). Each has a stable ID so clients notify at most once. */
export interface CrmEvent {
  id: string;
  key: string;
  type: string;
  recordType: string;
  recordId: string;
  title: string;
  message: string;
  createdAt: string; // ISO
  actor?: string;
  payload?: any;
}

export interface TimelineEntry {
  id: string;
  leadId: string;
  timestamp: string; // ISO
  type: string;
  title: string;
  details?: string;
  actor?: string;
  refType?: string;
  refId?: string;
}

export type UserRole = 'Admin' | 'Manager' | 'RM' | 'Developer';

export interface UserAccount {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status?: 'Active' | 'Disabled';
  avatar?: string;
  createdAt: string;
  lastLoginAt?: string;
  mustChangePassword?: boolean;
}

export interface AuthSession {
  token: string;
  user: UserAccount;
  expiresAt: string;
}

export interface UserActionLog {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userRole: string;
  action: string;
  details: string;
  timestamp: string; // ISO
  entityType: 'Lead' | 'Segment' | 'Task' | 'Inventory' | 'Import' | 'Export' | 'Auth' | 'System' | 'Call' | 'Chat' | 'Document' | 'Settings' | 'Developer';
  entityId?: string;
}

export type SegmentOperator = 'equals' | 'not_equals' | 'contains' | 'in' | 'greater_than' | 'less_than';

export interface SegmentRule {
  field: string;
  operator: SegmentOperator;
  value: string;
}

export interface ClientSegment {
  id: string;
  name: string;
  description: string;
  color: string;
  matchType: 'ALL' | 'ANY';
  rules: SegmentRule[];
  createdBy?: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model' | 'system';
  content: string;
  timestamp: string; // ISO
  model?: string;
  mapLinks?: Array<{ title: string; uri: string }>;
  /** A proposed CRM action awaiting confirmation */
  pendingAction?: CopilotAction;
  /** Structured results rendered as a table (lead lists etc.) */
  table?: { columns: string[]; rows: Array<Record<string, string>>; leadIds?: string[] };
  status?: 'pending' | 'done' | 'cancelled' | 'error';
}

export interface CopilotAction {
  id: string;
  type: 'create_task' | 'update_lead_stage' | 'add_remark' | 'schedule_followup' | 'update_lead' | 'assign_rm' | 'generate_report';
  summary: string; // human readable: "Change ENQ-0012 (Rahul) stage to Hot"
  args: Record<string, any>;
  destructive?: boolean;
}

export interface CallRecord {
  id: string;
  leadId: string;
  customerName: string;
  phone: string;
  direction: 'Outbound' | 'Inbound';
  callDate: string; // ISO date
  startTime?: string; // ISO
  endTime?: string; // ISO
  durationSec?: number;
  status: 'Completed' | 'Missed' | 'No Answer' | 'Busy' | 'Voicemail' | 'Failed' | 'In Progress';
  outcome?: string;
  provider?: string;
  providerCallId?: string;
  recordingUrl?: string;
  recordingFileId?: string;
  transcriptFileId?: string;
  transcript?: string;
  aiSummary?: string;
  keyPoints?: string[];
  followupActions?: string[];
  loggedBy?: string;
  createdAt?: string;
  notes?: string;
  /** Server-side suggestion for an unlinked call: the enquiry whose phone number matches (not yet linked). */
  matchedLeadId?: string;
  matchedName?: string;
  matchedStage?: string;
  matchedRM?: string;
}

export interface Chat360Message {
  id: string;
  eventId?: string;
  direction: 'Inbound' | 'Outbound';
  phone: string;
  contactName?: string;
  leadId?: string;
  messageType?: string;
  text: string;
  mediaUrl?: string;
  status?: string;
  timestamp: string; // ISO
  agent?: string;
}

export interface Chat360Contact {
  phone: string;
  contactName: string;
  leadId?: string;
  lastMessageAt?: string;
  lastMessage?: string;
  unreadCount?: number;
  assignedRM?: string;
  status?: string;
}

export interface AppCustomization {
  appName: string;
  appSubtitle: string;
  projectName: string;
  developerName: string;
  reraNumber: string;
  siteAddress: string;
  contactPhone: string;
  contactEmail: string;
  dashboardGreeting: string;
  leadsViewTitle: string;
  zohoVoiceDesktopUri: string;
  defaultDialer: 'zoho' | 'system' | 'whatsapp';
}

export interface DevModule {
  name: string; // retired Developer Mode: backend module name
  type: 'SERVER_JS' | 'HTML' | 'JSON';
  module: string; // logical module e.g. "Leads"
  size: number;
  lastModified?: string;
  source?: string;
  protectedFile?: boolean;
}

export interface CodeVersion {
  versionId: string;
  file: string;
  savedAt: string;
  savedBy: string;
  note?: string;
  backupFileId?: string;
  deployed?: boolean;
  deploymentVersion?: number;
}

export interface SyncState {
  status: 'idle' | 'loading' | 'syncing' | 'error' | 'offline' | 'auth';
  lastSyncAt?: string; // ISO
  lastError?: string;
  version?: string;
  hasLoadedOnce: boolean;
}

export interface CRMData {
  headers: string[];
  leads: Lead[];
  config: CRMConfig;
  tasks: TaskItem[];
  inventory: InventoryUnit[];
  documents: CrmDocument[];
  templates: MessageTemplate[];
  notes: NoteItem[];
  checklist: ChecklistItem[];
  settings: CRMSettings;
  segments?: ClientSegment[];
  users?: UserAccount[];
  customization?: AppCustomization;
  serverSettings?: ServerSettings;
  lastEventId?: string;
}
