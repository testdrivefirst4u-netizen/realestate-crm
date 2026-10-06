/**
 * Lead sources (company-level inbound lead capture) — shared types for the server, the CRM settings
 * screen and the super-admin console. Types only: safe to `import type` from client code.
 *
 * Intake endpoint (public, per-source API key):
 *   POST /api/inbound/leads
 *     key:   header `Authorization: Bearer <key>` | header `X-Api-Key: <key>` | field/query `_key`
 *     body:  JSON, application/x-www-form-urlencoded or multipart/form-data
 *     extras: `_gotcha` honeypot (must stay empty), `_redirect` (https URL on an allowed origin → 303),
 *             `Idempotency-Key` header or `_submission_id` field (same value = same submission)
 *   → 201 { status:'success', data:{ leadId, duplicate } } | 4xx { status:'error', code, message }
 *   OPTIONS answered for CORS (allowed origins only).
 */

import type { SheetImportConfig } from './sheetTypes';
import type { MetaSourceConfig } from './metaTypes';

/** website/webhook: pushed to /api/inbound/leads with an API key. google_sheet: rows pulled from a shared Google Sheet (no key). meta: a connected Facebook Page (no key). */
export type LeadSourceType = 'website' | 'webhook' | 'google_sheet' | 'meta';
export type AssignmentMode = 'unassigned' | 'fixed' | 'round_robin';
export type DuplicateMode = 'remark' | 'skip' | 'create';
export type InboundStatus = 'created' | 'duplicate' | 'rejected' | 'failed';

export interface LeadSourceConfig {
  /** Value written to "Enquiry Source" (default: 'Website' / 'Webhook'). */
  sourceLabel: string;
  /** Lead Stage for new leads (default 'New'). */
  defaultStage: string;
  assignment: { mode: AssignmentMode; rm: string; rms: string[] };
  /** What to do when the phone (or e-mail) already belongs to a lead. 'remark' = log a follow-up on it and notify. */
  duplicates: DuplicateMode;
  /** Browser origins allowed to post directly (e.g. 'https://www.example.com'). Empty = any origin. */
  allowedOrigins: string[];
  /** Extra mappings: incoming field name → CRM field header ('Prospect Name', 'Phone Number', 'Email',
   *  'Enquiry Notes', 'Unit Type Interested In', 'Purchase or Rent', 'Enquired For', 'Relationship to Prospect', …).
   *  Common names (name, phone, email, message, utm_* …) are recognised without mapping. */
  fieldMap: Record<string, string>;
  /** Only for type 'google_sheet' (see server/core/sheetTypes.ts). */
  sheet?: SheetImportConfig;
  /** Only for type 'meta' (see server/core/metaTypes.ts). */
  meta?: MetaSourceConfig;
}

export interface LeadSourceStats {
  received: number;
  created: number;
  duplicates: number;
  rejected: number;
  failed: number;
  lastReceivedAt: string;
  lastError: string;
}

export interface LeadSource {
  id: string; // SRC-0001
  type: LeadSourceType;
  name: string;
  status: 'Active' | 'Paused';
  /** First characters of the key, for recognising it (the full key is shown only once). */
  keyPrefix: string;
  config: LeadSourceConfig;
  stats: LeadSourceStats;
  createdAt: string;
  createdBy: string;
}

export interface InboundLogEntry {
  id: string;
  sourceId: string;
  sourceName: string;
  receivedAt: string;
  status: InboundStatus;
  leadId: string;
  /** Short reason for rejected/failed/duplicate. */
  message: string;
  /** Received fields (values truncated; the key and honeypot are never stored). */
  payload: Record<string, string>;
  ip: string;
  origin: string;
}

/** Company CRM actions (POST /api/rpc). Managing needs `settings.edit`; viewing `settings.view`. Plan feature: websiteApi. */
export interface LeadSourceActions {
  listLeadSources: { req: {}; res: LeadSource[] };
  createLeadSource: { req: { name: string; type: LeadSourceType; config?: Partial<LeadSourceConfig> }; res: { source: LeadSource; apiKey: string } };
  updateLeadSource: { req: { id: string; patch: Partial<Pick<LeadSource, 'name' | 'status'>> & { config?: Partial<LeadSourceConfig> } }; res: LeadSource };
  rotateLeadSourceKey: { req: { id: string }; res: { source: LeadSource; apiKey: string } };
  deleteLeadSource: { req: { id: string }; res: { ok: true } };
  listInboundLog: { req: { sourceId?: string; status?: InboundStatus | ''; limit?: number }; res: InboundLogEntry[] };
  retryInbound: { req: { id: string }; res: InboundLogEntry };
  /** Map a sample payload without saving anything. */
  previewLeadSource: { req: { id: string; payload: Record<string, unknown> }; res: { lead: Record<string, string>; warnings: string[] } };
}

/** Super-admin actions (POST /api/platform/rpc), each scoped to one company. */
export interface PlatformLeadSourceActions {
  listCompanyLeadSources: { req: { companyId: string }; res: LeadSource[] };
  createCompanyLeadSource: { req: { companyId: string; name: string; type: LeadSourceType; config?: Partial<LeadSourceConfig> }; res: { source: LeadSource; apiKey: string } };
  updateCompanyLeadSource: { req: { companyId: string; id: string; patch: Partial<Pick<LeadSource, 'name' | 'status'>> & { config?: Partial<LeadSourceConfig> } }; res: LeadSource };
  rotateCompanyLeadSourceKey: { req: { companyId: string; id: string }; res: { source: LeadSource; apiKey: string } };
  deleteCompanyLeadSource: { req: { companyId: string; id: string }; res: { ok: true } };
  companyInboundLog: { req: { companyId: string; sourceId?: string; status?: InboundStatus | ''; limit?: number }; res: InboundLogEntry[] };
}
