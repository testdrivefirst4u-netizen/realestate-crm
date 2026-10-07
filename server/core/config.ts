/**
 * Server configuration — the Next.js/MongoDB successor of apps-script/00_Config.gs.
 *
 * Lead field names deliberately keep the sheet header spelling ('Prospect Name', 'Lead Stage' …):
 * the browser code reads leads by these keys (src/core/config.ts → F) in ~990 places, so the
 * API keeps returning the same shape. In MongoDB the lead document stores camelCase fields;
 * server/core/leadShape.ts converts between the two.
 */
export const CFG = {
  APP_NAME: 'Amaya CRM',
  VERSION: '3.0.0',
  TIME_ZONE: 'Asia/Kolkata',

  SESSION_HOURS: 12,
  SESSION_COOKIE: 'amaya_session',
  EVENTS_KEEP: 3000,
  ERROR_LOG_KEEP: 2000,
  /** Kept for the UI contract; MongoDB has no follow-up column limit, this is only a soft cap. */
  MAX_FOLLOWUPS: 500,

  /** MongoDB collection names (one per former sheet tab, plus new ones). */
  COLL: {
    LEADS: 'leads',
    ARCHIVE: 'archivedLeads',
    CONFIG: 'dropdownOptions',
    TASKS: 'tasks',
    INVENTORY: 'units',
    USERS: 'users',
    SESSIONS: 'sessions',
    EVENTS: 'events',
    TIMELINE: 'activities',
    CHAT_MESSAGES: 'waMessages',
    CHAT_CONTACTS: 'waContacts',
    CALLS: 'calls',
    DOCUMENTS: 'documents',
    TEMPLATES: 'templates',
    NOTES: 'notes',
    CHECKLIST: 'checklistItems',
    SETTINGS: 'settings',
    SECRETS: 'secrets',
    ERROR_LOG: 'errorLogs',
    AUDIT_LOG: 'auditLogs',
    REPORTS: 'reportSnapshots',
    COUNTERS: 'counters',
    META: 'meta',
    LOGIN_ATTEMPTS: 'loginAttempts',
    FILES_BUCKET: 'files', // GridFS bucket (lead documents, call recordings)
  },

  /** Lead field names as the UI sees them (must match src/core/config.ts → F). */
  LEAD: {
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
  },

  LEAD_BASE_HEADERS: [
    'Enquiry ID', 'Enquiry Date', 'Prospect Name', 'Phone Number', 'Email', 'Lead Stage', 'Enquiry Source',
    'Unit Type Interested In', 'Purchase or Rent', 'Site Visit Status', 'Site Visit Date', 'Booking Date',
    'Next Follow-up Date', 'Enquiry Notes', 'Assigned RM', 'Brochure Shared', 'Relationship to Prospect',
    'Enquired For', 'Last Follow-up Date & Time', 'Created At', 'Updated At', 'Updated By',
  ],

  LEAD_DATE_FIELDS: [
    'Enquiry Date', 'Site Visit Date', 'Booking Date', 'Next Follow-up Date',
    'Last Follow-up Date & Time', 'Created At', 'Updated At',
  ],

  STAGES: {
    NEW: 'New', OPEN: 'Open', WARM: 'Warm', HOT: 'Hot', QUALIFIED: 'Qualified', BOOKED: 'Booked',
    NOT_RESPONDING: 'Not Responding', DND: 'DND', JUNK: 'Junk',
    DQ_BUDGET: 'Disqualified - Budget', DQ_LOCATION: 'Disqualified - Location', DQ_RENTAL: 'Disqualified - Rental',
    TRASH: 'Trash', DELETED: 'Permanently Deleted',
  },

  SITE_VISIT: {
    PROSPECT: 'Prospect for Site Visit',
    SCHEDULED: 'Site Visit - Scheduled',
    WALK_IN: 'Site Visit - Walk-In',
    COMPLETED: 'Site Visit - Completed',
  },

  DROPDOWNS: ['Lead Stage', 'Enquiry Source', 'Unit Type Interested In', 'Purchase or Rent', 'Site Visit Status',
    'Relationship to Prospect', 'Enquired For', 'Assigned RM', 'Brochure Shared'],

  DEFAULT_OPTIONS: {
    'Lead Stage': ['New', 'Open', 'Warm', 'Hot', 'Booked', 'Qualified', 'Not Responding', 'DND', 'Junk',
      'Disqualified - Budget', 'Disqualified - Location', 'Disqualified - Rental', 'Trash'],
    'Enquiry Source': ['Website', 'Website/Whatsapp', 'WhatsApp', 'Chat360', 'Facebook', 'Instagram', 'Meta Ads',
      'Google Ads', 'Reference', 'Walk-In', 'Inbound Call'],
    'Unit Type Interested In': ['1 BHK', '2 BHK', '2.5 BHK', '3 BHK', '3.5 BHK'],
    'Purchase or Rent': ['Purchase', 'Rent'],
    'Site Visit Status': ['Prospect for Site Visit', 'Site Visit - Scheduled', 'Site Visit - Walk-In', 'Site Visit - Completed'],
    'Relationship to Prospect': ['Self', 'Son', 'Daughter', 'Granddaughter', 'Grandson', 'Sister', 'Brother', 'Friend', 'Colleague'],
    'Enquired For': ['Self', 'Parents', 'Grandparents', 'Father', 'Mother', 'Relative', 'Relatives', 'Family'],
    'Assigned RM': [] as string[],
    'Brochure Shared': ['Yes', 'No'],
  } as Record<string, string[]>,

  ROLES: ['Admin', 'Manager', 'RM', 'Developer'],

  /**
   * Mirrors src/core/rbac.ts. The server is the enforcer.
   * Company settings, integrations and API keys (settings.*, secrets.*) belong to the platform: only the
   * Developer role has them — the hidden "Platform support" account a super admin opens from the console.
   * Admins run the team (users.*); Managers have full lead access and may manage Agents (users.manageAgents);
   * Agents (role RM) work their own leads.
   */
  PERMISSIONS: {
    Developer: ['*'],
    Admin: ['leads.*', 'tasks.*', 'inventory.*', 'reports.*', 'chat.*', 'calls.*', 'ai.*',
      'users.*', 'audit.*', 'records.*', 'storage.*'],
    Manager: ['leads.*', 'tasks.*', 'inventory.*', 'reports.*', 'chat.*', 'calls.*', 'ai.*', 'audit.view',
      'users.manageAgents', 'records.*', 'storage.*'],
    RM: ['leads.view', 'leads.create', 'leads.edit', 'leads.export', 'tasks.*', 'inventory.view', 'reports.view',
      'chat.*', 'calls.*', 'ai.*', 'records.*', 'storage.*'],
  } as Record<string, string[]>,

  /** Secret keys (stored encrypted in the `secrets` collection; an env var of the same name wins). */
  SECRETS: ['GEMINI_API_KEY', 'CHAT360_API_KEY', 'CHAT360_WEBHOOK_SECRET', 'TELEPHONY_WEBHOOK_SECRET'] as const,

  /** Non-secret settings (key → default), stored in the `settings` collection. */
  SETTING_DEFAULTS: {
    appName: 'Amaya CRM',
    timeZone: 'Asia/Kolkata',
    aiModel: 'gemini-3.8-flash',
    aiFastModel: 'gemini-3.5-flash-lite',
    aiTranscribeModel: 'gemini-3.5-transcribe',
    chat360BaseUrl: 'https://api.chat360.io',
    chat360SendPath: '/api/v1/messages/send',
    chat360TemplatePath: '/api/v1/messages/template',
    chat360AuthHeader: 'Authorization',
    chat360AuthPrefix: 'Bearer ',
    chat360AutoCreateLeads: 'true',
    chat360DefaultRM: '',
    chat360DefaultSource: 'Chat360',
    telephonyFieldMap: '{"callId":"call_id","from":"from","to":"to","direction":"direction","startTime":"start_time","endTime":"end_time","duration":"duration","recordingUrl":"recording_url","status":"status"}',
    features: '{"aiCopilot":true,"chat360":true,"calls":true,"inventorySync":true,"developerMode":false}',
    dailyDigestEmail: '',
    maxFollowups: '500',
    /** What Agents (RMs) see: 'own' | 'own_unassigned' | 'all' (server/core/scope.ts). */
    rmLeadVisibility: 'own',
  } as Record<string, string>,

  /** Hosts the server may fetch call recordings from (SSRF guard). Extend via settings if needed. */
  RECORDING_HOST_ALLOWLIST: [/\.zoho\.(com|in)$/i, /\.exotel\.(com|in)$/i, /\.knowlarity\.com$/i, /\.twilio\.com$/i, /\.chat360\.io$/i, /\.amazonaws\.com$/i, /\.googleapis\.com$/i],

  UPLOAD_MAX_BYTES: 45 * 1024 * 1024,
  UPLOAD_MIME_ALLOW: [/^image\//, /^audio\//, /^video\//, /^application\/pdf$/, /^text\//,
    /^application\/(msword|vnd\.openxmlformats-officedocument\..+|vnd\.ms-excel|vnd\.ms-powerpoint|zip|json|octet-stream)$/],
};

export type Role = 'Admin' | 'Manager' | 'RM' | 'Developer';
