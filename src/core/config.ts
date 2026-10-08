/**
 * CRM — central frontend configuration (shared by every company; branding comes from the company).
 *
 * Every module imports constants from here. Nothing else in `src/` may declare
 * its own copy of a stage list, storage key or feature flag.
 * The server keeps its own mirror of the shared constants in `server/`.
 */

export const APP = {
  name: 'CRM',
  shortName: 'CRM',
  subtitle: 'Sales CRM for real-estate teams',
  version: '3.0.0',
  timeZone: 'Asia/Kolkata',
  locale: 'en-IN',
  /** Display format used everywhere in the UI */
  dateTimeFormat: 'dd MMM yyyy, hh:mm a',
  dateFormat: 'dd MMM yyyy',
} as const;

/** Canonical lead field names — use these instead of string literals. */
export const F = {
  ID: 'Enquiry ID',
  ENQUIRY_DATE: 'Enquiry Date',
  NAME: 'Prospect Name',
  PHONE: 'Phone Number',
  EMAIL: 'Email',
  STAGE: 'Lead Stage',
  SOURCE: 'Enquiry Source',
  UNIT_TYPE: 'Unit Type Interested In',
  PURCHASE_OR_RENT: 'Purchase or Rent',
  SITE_VISIT_STATUS: 'Site Visit Status',
  SITE_VISIT_DATE: 'Site Visit Date',
  BOOKING_DATE: 'Booking Date',
  NEXT_FOLLOWUP: 'Next Follow-up Date',
  NOTES: 'Enquiry Notes',
  RM: 'Assigned RM',
  BROCHURE: 'Brochure Shared',
  RELATIONSHIP: 'Relationship to Prospect',
  ENQUIRED_FOR: 'Enquired For',
  LAST_FOLLOWUP: 'Last Follow-up Date & Time',
  CREATED_AT: 'Created At',
  UPDATED_AT: 'Updated At',
  UPDATED_BY: 'Updated By',
} as const;

export const MAX_FOLLOWUPS = 50;
export const followupField = (i: number) => `Follow-up ${i}`;

/** Lead-field names that hold a date/time value (used for normalisation & formatting). */
export const LEAD_DATE_FIELDS: string[] = [
  F.ENQUIRY_DATE,
  F.SITE_VISIT_DATE,
  F.BOOKING_DATE,
  F.NEXT_FOLLOWUP,
  F.LAST_FOLLOWUP,
  F.CREATED_AT,
  F.UPDATED_AT,
];

/** Base field order of a lead record. Follow-up 1..N are appended by the backend. */
export const LEAD_BASE_HEADERS: string[] = [
  F.ID,
  F.ENQUIRY_DATE,
  F.NAME,
  F.PHONE,
  F.EMAIL,
  F.STAGE,
  F.SOURCE,
  F.UNIT_TYPE,
  F.PURCHASE_OR_RENT,
  F.SITE_VISIT_STATUS,
  F.SITE_VISIT_DATE,
  F.BOOKING_DATE,
  F.NEXT_FOLLOWUP,
  F.NOTES,
  F.RM,
  F.BROCHURE,
  F.RELATIONSHIP,
  F.ENQUIRED_FOR,
  F.LAST_FOLLOWUP,
  F.CREATED_AT,
  F.UPDATED_AT,
  F.UPDATED_BY,
];

/* ----------------------------- Stages ----------------------------------- */

export const STAGES = {
  NEW: 'New',
  OPEN: 'Open',
  WARM: 'Warm',
  HOT: 'Hot',
  QUALIFIED: 'Qualified',
  BOOKED: 'Booked',
  NOT_RESPONDING: 'Not Responding',
  DND: 'DND',
  JUNK: 'Junk',
  DQ_BUDGET: 'Disqualified - Budget',
  DQ_LOCATION: 'Disqualified - Location',
  DQ_RENTAL: 'Disqualified - Rental',
  TRASH: 'Trash',
  DELETED: 'Permanently Deleted',
} as const;

/** Pipeline order used by funnels and the Kanban board. */
export const FUNNEL_STAGES: string[] = [
  STAGES.NEW,
  STAGES.OPEN,
  STAGES.WARM,
  STAGES.HOT,
  STAGES.QUALIFIED,
  STAGES.BOOKED,
];

/** Stage classification — the single source of truth for every KPI. */
export const STAGE_CLASS = {
  /** Open pipeline: still being worked. */
  active: [STAGES.NEW, STAGES.OPEN, STAGES.WARM, STAGES.HOT, STAGES.QUALIFIED] as string[],
  /** Won. */
  won: [STAGES.BOOKED] as string[],
  /** Lost / closed without booking. */
  lost: [
    STAGES.NOT_RESPONDING,
    STAGES.DND,
    STAGES.JUNK,
    STAGES.DQ_BUDGET,
    STAGES.DQ_LOCATION,
    STAGES.DQ_RENTAL,
  ] as string[],
  /** Never counted anywhere. */
  excluded: [STAGES.TRASH, STAGES.DELETED] as string[],
};

/** "Qualified Leads" KPI = these stages (a booked lead was qualified first). */
export const QUALIFIED_STAGES: string[] = [STAGES.QUALIFIED, STAGES.BOOKED];

export const SITE_VISIT = {
  PROSPECT: 'Prospect for Site Visit',
  SCHEDULED: 'Site Visit - Scheduled',
  WALK_IN: 'Site Visit - Walk-In',
  COMPLETED: 'Site Visit - Completed',
} as const;

/** Statuses that count as a completed visit. */
export const SITE_VISIT_DONE: string[] = [SITE_VISIT.COMPLETED, SITE_VISIT.WALK_IN];

/* --------------------------- Default dropdowns --------------------------- */

export const DEFAULT_CONFIG = {
  fields: [
    F.STAGE,
    F.SOURCE,
    F.UNIT_TYPE,
    F.PURCHASE_OR_RENT,
    F.SITE_VISIT_STATUS,
    F.RELATIONSHIP,
    F.ENQUIRED_FOR,
    F.RM,
    F.BROCHURE,
  ] as string[],
  options: {
    [F.STAGE]: [
      STAGES.NEW,
      STAGES.OPEN,
      STAGES.WARM,
      STAGES.HOT,
      STAGES.BOOKED,
      STAGES.QUALIFIED,
      STAGES.NOT_RESPONDING,
      STAGES.DND,
      STAGES.JUNK,
      STAGES.DQ_BUDGET,
      STAGES.DQ_LOCATION,
      STAGES.DQ_RENTAL,
      STAGES.TRASH,
    ],
    [F.SOURCE]: [
      'Website',
      'Website/Whatsapp',
      'WhatsApp',
      'Chat360',
      'Facebook',
      'Instagram',
      'Meta Ads',
      'Google Ads',
      'Reference',
      'Walk-In',
      'Inbound Call',
    ],
    [F.UNIT_TYPE]: ['1 BHK', '2 BHK', '2.5 BHK', '3 BHK', '3.5 BHK'],
    [F.PURCHASE_OR_RENT]: ['Purchase', 'Rent'],
    [F.SITE_VISIT_STATUS]: [SITE_VISIT.PROSPECT, SITE_VISIT.SCHEDULED, SITE_VISIT.WALK_IN, SITE_VISIT.COMPLETED],
    [F.RELATIONSHIP]: ['Self', 'Son', 'Daughter', 'Granddaughter', 'Grandson', 'Sister', 'Brother', 'Friend', 'Colleague'],
    [F.ENQUIRED_FOR]: ['Self', 'Parents', 'Grandparents', 'Father', 'Mother', 'Relative', 'Relatives', 'Family'],
    [F.RM]: [] as string[], // filled from the users / config collections at runtime
    [F.BROCHURE]: ['Yes', 'No'],
  } as Record<string, string[]>,
};

/* ------------------------------- Roles ----------------------------------- */

export const ROLES: Record<string, string> = {
  Admin: 'Admin',
  Manager: 'Manager',
  RM: 'RM',
  Developer: 'Developer',
};

/* ------------------------------ Sync ------------------------------------- */

export const SYNC = {
  defaultIntervalSec: 30,
  minIntervalSec: 10,
  /** Minimum gap between two syncs triggered by focus/visibility events. */
  focusDebounceMs: 15_000,
  requestTimeoutMs: 30_000,
  /** Ignore remote echoes of our own writes for this long. */
  localMutationTtlMs: 45_000,
  maxEventsPerPoll: 100,
} as const;

/* ----------------------------- Features ---------------------------------- */

/**
 * Built-in defaults only. The company's plan (settings.features from the server) overrides these —
 * read features through `hasFeature()` / `useFeature()` in core/tenant.tsx, never directly.
 */
export const FEATURES = {
  aiCopilot: true,
  chat360: true,
  calls: true,
  inventory: true,
  inventorySync: true,
  unitLocator: true,
  projectLibrary: true,
  reports: true,
  /** In-app backend code editing (Developer Mode) is retired. */
  developerMode: false,
  segments: true,
  websiteApi: true,
  metaLeads: false,
  googleSheets: false,
  csvImport: true,
  documents: true,
  templates: true,
  library: true,
} as const;

export type FeatureKey = keyof typeof FEATURES;

/* ---------------------------- Storage keys ------------------------------- */

export const STORAGE_KEYS = {
  /** Device preferences only (local settings, customisation, segments) — never CRM records. */
  PREFS: 'amaya_crm_prefs_v3',
  SESSION: 'amaya_crm_session_v2',
  NOTIFICATIONS: 'amaya_crm_notifications_v2',
  NOTIFICATION_SEEN: 'amaya_crm_notification_seen_v2',
  ALARM_HANDLED: 'amaya_crm_alarms_handled_v2',
  CUSTOM_LOGO: 'crm_custom_logo',
  DISPLAY_SCALE: 'crm_display_scale_mode',
  UI_PREFS: 'amaya_crm_ui_prefs_v2',
  /** Caches of earlier builds that held CRM records: purged on load, never written. */
  CRM_STATE: 'amaya_crm_state_v2',
  LAST_EVENT_ID: 'amaya_crm_last_event_v2',
  LEGACY_STATE: 'amaya_crm_full_state_v1',
} as const;

/* ------------------------------- API ------------------------------------- */

export const API = {
  /** Same-origin RPC endpoint (Next.js route handler). The backend URL is not configurable. */
  rpcPath: '/api/rpc',
} as const;

/* ------------------------- Pipeline value defaults ----------------------- */

/** Indicative unit values used only for pipeline-value estimates in Reports. */
export const UNIT_TYPE_PRICES: Record<string, number> = {
  '1 BHK': 10_090_821,
  '2 BHK': 16_079_391,
  '2.5 BHK': 17_753_600,
  '3 BHK': 22_277_536,
  '3.5 BHK': 25_604_301,
};
export const DEFAULT_UNIT_PRICE = 16_079_391;

export const STAGE_WEIGHTS: Record<string, number> = {
  [STAGES.NEW]: 0.1,
  [STAGES.OPEN]: 0.2,
  [STAGES.WARM]: 0.45,
  [STAGES.HOT]: 0.7,
  [STAGES.QUALIFIED]: 0.85,
  [STAGES.BOOKED]: 1.0,
};

/* ------------------------------ Branding --------------------------------- */

export const DEFAULT_CUSTOMIZATION = {
  appName: APP.name,
  appSubtitle: APP.subtitle,
  projectName: '',
  developerName: '',
  reraNumber: '',
  siteAddress: '',
  contactPhone: '',
  contactEmail: '',
  dashboardGreeting: 'Sales Dashboard',
  leadsViewTitle: 'All Customer Enquiries & Pipeline',
  zohoVoiceDesktopUri: 'zohovoice://call?phone=',
  defaultDialer: 'system' as const,
};

export const DEFAULT_SETTINGS = {
  dialerTemplate: 'tel:{phone}',
  waTemplate: 'Hello {name}, this is {rm}.',
  emailSubject: 'Thank you for your enquiry',
  emailBody: 'Dear {name},\n\nThank you for reaching out to us.',
  timeZone: APP.timeZone,
  aiConfigured: false,
  geminiModel: 'gemini-3.8-flash',
  autoSyncIntervalSec: SYNC.defaultIntervalSec,
};

export const AI_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (recommended)' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (fastest)' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview, most capable)' },
] as const;

export const AI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
