/**
 * Lead sources — pure helpers for the settings screen (no React, unit-tested in tests/lead-sources-ui.test.ts).
 * Contract: server/core/leadSourceTypes.ts.
 */
import type { AssignmentMode, DuplicateMode, InboundStatus, LeadSourceConfig, LeadSourceType } from '../../../../server/core/leadSourceTypes';

export const INBOUND_PATH = '/api/inbound/leads';
/** Placeholder used in the guide when the real key is not available (it is only shown once). */
export const KEY_PLACEHOLDER = 'YOUR_KEY';

export const TYPE_OPTIONS: Array<{ value: LeadSourceType; label: string; hint: string }> = [
  { value: 'website', label: 'Website form', hint: 'Your own website’s enquiry form posts straight to the CRM.' },
  { value: 'webhook', label: 'Webhook', hint: 'Zapier, Make, IndiaMART, landing-page tools and other services that can send a webhook.' },
  { value: 'google_sheet', label: 'Google Sheet (import)', hint: 'New rows in a Google Sheet you share with the CRM become leads (no API key needed).' },
];

export const TYPE_LABEL: Record<LeadSourceType, string> = { website: 'Website', webhook: 'Webhook', google_sheet: 'Google Sheet', meta: 'Facebook / Instagram' };

/** Sources that receive pushed submissions with an API key (a Google Sheet import pulls rows; a Meta Page is connected through Facebook). */
export const usesApiKey = (type: LeadSourceType | string) => type !== 'google_sheet' && type !== 'meta';

/** Only key-based sources receive browser submissions, so only they have "allowed websites". */
export const usesOrigins = (type: LeadSourceType | string) => usesApiKey(type);

/** Type choices of the "Add source" form for the plan: website/webhook need `websiteApi`, the sheet import `googleSheets`.
 *  Meta Pages are added with "Connect Facebook / Instagram", never through this form. */
export function allowedTypeOptions(opts: { apiEnabled: boolean; sheetsEnabled: boolean }) {
  return TYPE_OPTIONS.filter((t) => (t.value === 'google_sheet' ? opts.sheetsEnabled : opts.apiEnabled));
}

export const ASSIGNMENT_OPTIONS: Array<{ value: AssignmentMode; label: string }> = [
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'fixed', label: 'Fixed RM' },
  { value: 'round_robin', label: 'Round-robin' },
];

export const DUPLICATE_OPTIONS: Array<{ value: DuplicateMode; label: string }> = [
  { value: 'remark', label: 'Add a follow-up to the existing lead (recommended)' },
  { value: 'skip', label: 'Ignore' },
  { value: 'create', label: 'Create a new lead anyway' },
];

/** CRM fields an incoming field can be mapped to. */
export const MAPPABLE_FIELDS = [
  'Prospect Name',
  'Phone Number',
  'Email',
  'Enquiry Notes',
  'Unit Type Interested In',
  'Purchase or Rent',
  'Enquired For',
  'Relationship to Prospect',
  'Assigned RM',
  'Enquiry Source',
] as const;

export const STATUS_OPTIONS: Array<{ value: InboundStatus; label: string }> = [
  { value: 'created', label: 'Created' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
];

export function statusTone(status: InboundStatus | string): 'sage' | 'gold' | 'amber' | 'rust' | 'muted' {
  switch (status) {
    case 'created': return 'sage';
    case 'duplicate': return 'gold';
    case 'rejected': return 'amber';
    case 'failed': return 'rust';
    default: return 'muted';
  }
}

export const canRetry = (status: InboundStatus | string) => status === 'failed' || status === 'rejected';

export function defaultSourceLabel(type: LeadSourceType): string {
  return type === 'website' ? 'Website' : type === 'google_sheet' ? 'Google Sheet' : type === 'meta' ? 'Facebook' : 'Webhook';
}

export function defaultConfig(type: LeadSourceType): LeadSourceConfig {
  return {
    sourceLabel: defaultSourceLabel(type),
    defaultStage: 'New',
    assignment: { mode: 'unassigned', rm: '', rms: [] },
    duplicates: 'remark',
    allowedOrigins: [],
    fieldMap: {},
  };
}

/* ------------------------------ Origins ---------------------------------- */

/**
 * Validate one allowed website and return its canonical origin (`https://www.example.com`), or an error.
 * Accepts a full URL (path/query are dropped) — but needs the scheme so http and https are never confused.
 */
export interface OriginCheck {
  ok: boolean;
  origin: string;
  error: string;
}

export function normalizeOrigin(input: string): OriginCheck {
  const fail = (error: string): OriginCheck => ({ ok: false, origin: '', error });
  const raw = String(input || '').trim();
  if (!raw) return fail('Enter a website address.');
  if (!/^https?:\/\//i.test(raw)) return fail('Start with https:// (or http:// for local testing).');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return fail('Not a valid web address.');
  }
  if (!u.hostname || /\s/.test(raw)) return fail('Not a valid web address.');
  if (u.username || u.password) return fail('Remove the user name / password from the address.');
  const host = u.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
  if (!local && !host.includes('.')) return fail('Use the full domain, e.g. https://www.example.com');
  if (u.protocol === 'http:' && !local) return fail('Use https:// — plain http is only allowed for localhost.');
  return { ok: true, origin: u.origin.toLowerCase(), error: '' };
}

/** Validate a list of origins; returns the de-duplicated canonical list plus per-line errors. */
export function normalizeOrigins(list: string[]): { origins: string[]; errors: Array<{ index: number; value: string; error: string }> } {
  const origins: string[] = [];
  const errors: Array<{ index: number; value: string; error: string }> = [];
  list.forEach((value, index) => {
    if (!String(value || '').trim()) return;
    const r = normalizeOrigin(value);
    if (r.ok) {
      if (!origins.includes(r.origin)) origins.push(r.origin);
    } else errors.push({ index, value, error: r.error });
  });
  return { origins, errors };
}

/* ----------------------------- Field map --------------------------------- */

export interface FieldMapRow {
  from: string;
  to: string;
}

export const fieldMapToRows = (map: Record<string, string> | null | undefined): FieldMapRow[] =>
  Object.entries(map || {}).map(([from, to]) => ({ from, to }));

/** Rows → map; blank rows are skipped, the last row for a repeated incoming name wins. */
export function rowsToFieldMap(rows: FieldMapRow[]): { map: Record<string, string>; errors: string[] } {
  const map: Record<string, string> = {};
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const from = String(r.from || '').trim();
    const to = String(r.to || '').trim();
    if (!from && !to) return;
    if (!from) errors.push(`Row ${i + 1}: enter the incoming field name.`);
    else if (!to) errors.push(`Row ${i + 1}: choose the CRM field for “${from}”.`);
    else {
      if (seen.has(from)) errors.push(`“${from}” is mapped more than once.`);
      seen.add(from);
      map[from] = to;
    }
  });
  return { map, errors };
}

/* ------------------------------ Test JSON -------------------------------- */

export interface SampleParse {
  ok: boolean;
  payload: Record<string, unknown> | null;
  error: string;
}

export function parseSamplePayload(text: string): SampleParse {
  const fail = (error: string): SampleParse => ({ ok: false, payload: null, error });
  const t = String(text || '').trim();
  if (!t) return fail('Paste a JSON object, e.g. {"name":"Asha","phone":"9876543210"}.');
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('The sample must be a JSON object ({ … }).');
    return { ok: true, payload: v as Record<string, unknown>, error: '' };
  } catch (e) {
    return fail(`Not valid JSON: ${(e as Error).message}`);
  }
}

export const SAMPLE_PAYLOAD = JSON.stringify(
  { name: 'Asha Mehta', phone: '+91 98765 43210', email: 'asha@example.com', message: 'Interested in a 2 BHK, please call after 6 pm.', utm_source: 'google' },
  null,
  2
);

/* ------------------------------- Snippets -------------------------------- */

export type GuideTab = 'html' | 'js' | 'curl' | 'wordpress' | 'zapier';

export const GUIDE_TABS: Array<{ id: GuideTab; label: string }> = [
  { id: 'html', label: 'HTML form' },
  { id: 'js', label: 'JavaScript' },
  { id: 'curl', label: 'cURL' },
  { id: 'wordpress', label: 'WordPress' },
  { id: 'zapier', label: 'Zapier / Make' },
];

export const endpointFor = (origin: string) => `${String(origin || '').replace(/\/+$/, '')}${INBOUND_PATH}`;

const escAttr = (s: string) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escJs = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const escSh = (s: string) => String(s).replace(/'/g, `'\\''`);

export interface SnippetBlock {
  title: string;
  /** Short explanation shown above the code. */
  note?: string;
  code: string;
}

/**
 * Integration guide content for one tab, filled with the real endpoint and key
 * (or `YOUR_KEY` when the key is not available any more).
 */
export function buildSnippets(tab: GuideTab, opts: { endpoint: string; apiKey?: string; redirectUrl?: string }): SnippetBlock[] {
  const endpoint = opts.endpoint;
  const key = (opts.apiKey || '').trim() || KEY_PLACEHOLDER;
  const redirect = (opts.redirectUrl || '').trim() || 'https://www.example.com/thank-you';
  switch (tab) {
    case 'html':
      return [
        {
          title: 'Paste into your page',
          note: 'The form posts straight to the CRM. After saving the lead the visitor is sent to your thank-you page (_redirect must be on one of the allowed websites). Keep the _gotcha field empty and hidden — it traps spam bots.',
          code: [
            `<form action="${escAttr(endpoint)}" method="POST">`,
            `  <input type="hidden" name="_key" value="${escAttr(key)}">`,
            `  <input type="hidden" name="_redirect" value="${escAttr(redirect)}">`,
            `  <!-- Honeypot: must stay empty. Hidden with CSS, not type="hidden", so bots fill it in. -->`,
            `  <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">`,
            ``,
            `  <label>Name <input type="text" name="name" required></label>`,
            `  <label>Phone <input type="tel" name="phone" required></label>`,
            `  <label>Email <input type="email" name="email"></label>`,
            `  <label>Message <textarea name="message"></textarea></label>`,
            `  <button type="submit">Send enquiry</button>`,
            `</form>`,
          ].join('\n'),
        },
      ];
    case 'js':
      return [
        {
          title: 'fetch() with JSON',
          note: 'The key is visible to anyone who views your page source. That is acceptable: it can only create leads, and the allowed websites list stops other sites from using it in a browser. Rotate the key if it is misused.',
          code: [
            `async function sendEnquiry(form) {`,
            `  const res = await fetch('${escJs(endpoint)}', {`,
            `    method: 'POST',`,
            `    headers: {`,
            `      'Content-Type': 'application/json',`,
            `      'Authorization': 'Bearer ${escJs(key)}',`,
            `    },`,
            `    body: JSON.stringify({`,
            `      name: form.name.value,`,
            `      phone: form.phone.value,`,
            `      email: form.email.value,`,
            `      message: form.message.value,`,
            `      _gotcha: '', // honeypot — leave empty`,
            `    }),`,
            `  });`,
            `  const json = await res.json();`,
            `  if (json.status !== 'success') throw new Error(json.message || 'Could not send the enquiry');`,
            `  return json.data; // { leadId, duplicate }`,
            `}`,
          ].join('\n'),
        },
      ];
    case 'curl':
      return [
        {
          title: 'Send a test lead',
          note: 'Run this from a terminal to check the source works; the lead appears in the CRM and in this source’s intake log.',
          code: [
            `curl -X POST '${escSh(endpoint)}' \\`,
            `  -H 'Authorization: Bearer ${escSh(key)}' \\`,
            `  -H 'Content-Type: application/json' \\`,
            `  -d '{"name":"Test Lead","phone":"+91 98765 43210","email":"test@example.com","message":"Test from cURL"}'`,
          ].join('\n'),
        },
      ];
    case 'wordpress':
      return [
        {
          title: 'Webhook URL',
          note: 'Contact Form 7: install “CF7 to Webhook”, open your form → Webhook tab, tick “Send to webhook” and paste this URL. Elementor Forms: Actions After Submit → add “Webhook” and paste this URL. Name your form fields name, phone, email and message (or map other names in this source’s field mapping).',
          code: `${endpoint}?_key=${encodeURIComponent(key)}`,
        },
      ];
    case 'zapier':
      return [
        {
          title: 'URL',
          note: 'Zapier: add the action “Webhooks by Zapier” → POST, Payload type JSON. Make: add the “HTTP → Make a request” module, method POST, body type JSON. Map the lead’s fields into Data as name, phone, email, message.',
          code: endpoint,
        },
        { title: 'Header', note: 'Add one header (Zapier: Headers; Make: Headers → Add item).', code: `Authorization: Bearer ${key}` },
        { title: 'Example data (JSON)', code: JSON.stringify({ name: '{{name}}', phone: '{{phone}}', email: '{{email}}', message: '{{message}}' }, null, 2) },
      ];
  }
}

/** Stages a new lead may start in (the recycle-bin stages are not offered). */
export const usableStages = (options: string[] | null | undefined): string[] =>
  (options || []).filter((s) => s && s !== 'Trash' && s !== 'Permanently Deleted');
