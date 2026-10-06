/**
 * Inbound lead intake — the pipeline behind POST /api/inbound/leads (website forms, generic webhooks).
 * Runs inside the company context of the lead source (server/core/tenant.ts).
 *
 *   ingestLead(source, rawFields, meta)
 *     1. idempotency: a repeated (sourceId, idempotencyKey) returns the first result, nothing is created
 *     2. honeypot (`_gotcha` filled) → logged as rejected, no lead
 *     3. field recognition (+ the source's fieldMap) → a UI-shaped lead
 *     4. validation (a phone with ≥ 7 digits or a valid e-mail)
 *     5. duplicates by phone (last 10 digits), else by e-mail: remark | skip | create
 *     6. assignment: unassigned | fixed | round_robin (active users only, atomic counter per source)
 *     7. addLead (actor = source name, eventSource 'website')
 *   Every submission is logged in `inboundLeads` (TTL 180 days) and counted in the source's stats.
 */
import { CFG } from '../core/config';
import { listUsers } from '../core/auth';
import { col, nextCounter } from '../core/db';
import { ApiError } from '../core/errors';
import { addEvent, logError } from '../core/events';
import { escapeRegex, last10, shortId, truncate } from '../core/utils';
import type { InboundLogEntry, InboundStatus, LeadSource, LeadSourceConfig, LeadSourceStats } from '../core/leadSourceTypes';
import { addLead, appendRemark, findLeadByPhone, type UiLead } from './leads';

const L = CFG.LEAD;

export const COLL_SOURCES = 'leadSources';
export const COLL_INBOUND = 'inboundLeads';
export const COLL_RATE = 'rateLimits';

/* --------------------------------- shapes -------------------------------- */

export interface SourceDoc {
  _id: string; // SRC-0001
  type: LeadSource['type'];
  name: string;
  status: LeadSource['status'];
  keyPrefix: string;
  config: LeadSourceConfig;
  stats: Partial<Omit<LeadSourceStats, 'lastReceivedAt'>> & { lastReceivedAt?: Date | null };
  createdAt: Date;
  createdBy: string;
  updatedAt?: Date;
}

export interface InboundDoc {
  _id: string; // INB_…
  sourceId: string;
  receivedAt: Date;
  status: InboundStatus;
  leadId: string;
  message: string;
  payload: Record<string, string>;
  ip: string;
  origin: string;
  idempotencyKey?: string;
  duplicate?: boolean;
  retriedAt?: Date;
}

export interface IngestMeta {
  ip?: string;
  origin?: string;
  idempotencyKey?: string;
}

export interface IngestResult {
  logId: string;
  status: InboundStatus;
  leadId: string;
  duplicate: boolean;
  message: string;
  /** True when this answer is the stored result of an earlier submission with the same idempotency key. */
  replay?: boolean;
}

export const sourcesCol = () => col<SourceDoc>(COLL_SOURCES);
export const inboundCol = () => col<InboundDoc>(COLL_INBOUND);

/* ---------------------------- field recognition -------------------------- */

/** 'Your-Name', 'your name', 'YOUR_NAME' → 'your_name'. */
export const normKey = (k: string) => String(k || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const ALIASES: Record<string, string> = {};
const alias = (header: string, keys: string[]) => keys.forEach((k) => (ALIASES[k] = header));
alias(L.NAME, ['name', 'full_name', 'fullname', 'your_name', 'prospect_name', 'contact_name', 'customer_name']);
alias(L.PHONE, ['phone', 'mobile', 'phone_number', 'phonenumber', 'mobile_number', 'mobile_no', 'phone_no', 'tel', 'telephone', 'contact', 'contact_number', 'whatsapp', 'whatsapp_number', 'your_phone', 'your_mobile']);
alias(L.EMAIL, ['email', 'e_mail', 'email_address', 'your_email', 'mail']);
alias(L.NOTES, ['message', 'notes', 'note', 'comments', 'comment', 'enquiry', 'inquiry', 'your_message', 'remarks', 'requirement']);
alias(L.UNIT_TYPE, ['unit', 'unit_type', 'bhk', 'configuration', 'unit_type_interested_in']);
// CRM headers themselves ('Phone Number', 'Purchase or Rent', …) are recognised too.
for (const h of CFG.LEAD_BASE_HEADERS) ALIASES[normKey(h)] ||= h;
const FIRST = new Set(['first_name', 'firstname', 'fname', 'given_name']);
const LAST = new Set(['last_name', 'lastname', 'lname', 'surname', 'family_name']);
const TRACKING = /^(utm_[a-z0-9_]+|gclid|fbclid|msclkid|page_url|page|referrer|referer|landing_page|form_name|form_id)$/;

/** Headers a fieldMap may target ('_ignore' drops the field). System-managed headers are excluded. */
export const MAPPABLE_HEADERS: string[] = CFG.LEAD_BASE_HEADERS.filter(
  (h) => ![L.ID, L.CREATED_AT, L.UPDATED_AT, L.UPDATED_BY, L.LAST_FOLLOWUP, L.RM].includes(h)
);
export const IGNORE_TARGET = '_ignore';
/** Headers the pipeline never takes from a payload unless the fieldMap targets them explicitly. */
const AUTO_BLOCKED = new Set<string>([L.ID, L.CREATED_AT, L.UPDATED_AT, L.UPDATED_BY, L.LAST_FOLLOWUP, L.RM, L.STAGE, L.SOURCE, L.SITE_VISIT_STATUS, L.SITE_VISIT_DATE, L.BOOKING_DATE, L.NEXT_FOLLOWUP]);

const MAX_NOTES = 2000;
const MAX_NOTE_VALUE = 300;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const digitCount = (s: string) => s.replace(/\D/g, '').length;

/** Flatten any value of a JSON/form payload to a string. */
export function flatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)) ? v.map((x) => flatValue(x)).join(', ') : JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export interface MappedLead {
  lead: Record<string, string>;
  warnings: string[];
  /** Why the submission cannot become a lead ('' = valid). */
  reject: string;
  /** The visitor's message (for the duplicate remark). */
  message: string;
}

/** Fields → UI lead (no database access except none; pure). */
export function mapFields(source: Pick<SourceDoc, 'type' | 'config'>, raw: Record<string, unknown>): MappedLead {
  const cfg = source.config;
  const warnings: string[] = [];
  const lead: Record<string, string> = {};
  const messages: string[] = [];
  const extras: string[] = [];
  const tracking: string[] = [];
  let first = '', last = '';

  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(cfg.fieldMap || {})) {
    map.set(k, v);
    map.set(normKey(k), v);
  }

  for (const [key, rawVal] of Object.entries(raw || {})) {
    if (!key || key.startsWith('_')) continue;
    const value = flatValue(rawVal).trim();
    if (!value) continue;
    const nk = normKey(key);
    const mapped = map.get(key) ?? map.get(nk);
    if (mapped === IGNORE_TARGET) continue;
    let target = mapped || ALIASES[nk] || '';
    if (!mapped && target && AUTO_BLOCKED.has(target)) target = '';
    if (!target) {
      if (!mapped && FIRST.has(nk)) { first = value; continue; }
      if (!mapped && LAST.has(nk)) { last = value; continue; }
      (TRACKING.test(nk) ? tracking : extras).push(`${truncate(key, 60)}: ${truncate(value, MAX_NOTE_VALUE)}`);
      continue;
    }
    if (target === L.NOTES) {
      messages.push(value);
      continue;
    }
    if (!lead[target]) lead[target] = truncate(value, target === L.NAME ? 120 : 500);
  }
  if (!lead[L.NAME] && (first || last)) lead[L.NAME] = truncate(`${first} ${last}`.trim(), 120);

  // contact validation
  const phone = (lead[L.PHONE] || '').trim();
  const email = (lead[L.EMAIL] || '').trim().toLowerCase();
  let phoneOk = false, emailOk = false;
  if (phone) {
    if (digitCount(phone) >= 7 && digitCount(phone) <= 15) {
      phoneOk = true;
      lead[L.PHONE] = truncate(phone, 40);
    } else {
      delete lead[L.PHONE];
      warnings.push(`Phone number "${truncate(phone, 40)}" is not valid (needs 7–15 digits)`);
      extras.unshift(`Phone (invalid): ${truncate(phone, 60)}`);
    }
  }
  if (email) {
    if (EMAIL_RE.test(email) && email.length <= 200) {
      emailOk = true;
      lead[L.EMAIL] = email;
    } else {
      delete lead[L.EMAIL];
      warnings.push(`E-mail address "${truncate(email, 60)}" is not valid`);
      extras.unshift(`Email (invalid): ${truncate(email, 100)}`);
    }
  }
  let reject = '';
  if (!phoneOk && !emailOk) reject = phone || email ? 'No valid phone number or e-mail address' : 'A phone number or e-mail address is required';

  const typeLabel = source.type === 'webhook' ? 'Webhook' : source.type === 'google_sheet' ? 'Google Sheet' : source.type === 'meta' ? 'Meta Lead Ads' : 'Website';
  if (!lead[L.NAME]) lead[L.NAME] = `${typeLabel} enquiry ${phoneOk ? lead[L.PHONE] : emailOk ? lead[L.EMAIL] : ''}`.trim();

  const message = messages.join('\n');
  const notes = [message, ...extras, ...tracking].filter(Boolean).join('\n');
  if (notes) lead[L.NOTES] = truncate(notes, MAX_NOTES);
  if (notes.length > MAX_NOTES) warnings.push('Enquiry notes were shortened to 2 KB');

  if (!lead[L.STAGE]) lead[L.STAGE] = cfg.defaultStage || CFG.STAGES.NEW;
  if (!lead[L.SOURCE]) lead[L.SOURCE] = cfg.sourceLabel || typeLabel;
  return { lead, warnings, reject, message };
}

/* --------------------------------- payload ------------------------------- */

const NEVER_STORED = new Set(['_key', '_gotcha']);

/** What is kept of a submission in the log: ≤ 60 keys, string values ≤ 500 chars, never the key/honeypot. */
export function storedPayload(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw || {})) {
    if (NEVER_STORED.has(k) || /^(authorization|x-api-key)$/i.test(k)) continue;
    if (n >= 60) break;
    // keys become document field names: keep them storable
    const key = truncate(k, 100).replace(/^\$/, '＄').replace(/\./g, '．');
    out[key] = truncate(flatValue(v), 500);
    n++;
  }
  return out;
}

/** The stored payload back as fields (reverses the key escaping). */
function payloadFields(p: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p || {})) out[k.replace(/^＄/, '$').replace(/．/g, '.')] = v;
  return out;
}

/* ------------------------------- duplicates ------------------------------ */

async function findDuplicate(lead: Record<string, string>): Promise<UiLead | null> {
  const ignore = (l: UiLead | null) => (l && l[L.STAGE] !== CFG.STAGES.TRASH && l[L.STAGE] !== CFG.STAGES.DELETED ? l : null);
  if (lead[L.PHONE] && last10(lead[L.PHONE]).length >= 10) {
    const byPhone = ignore(await findLeadByPhone(lead[L.PHONE]));
    if (byPhone) return byPhone;
  }
  const email = (lead[L.EMAIL] || '').trim();
  if (email) {
    const doc = await (await col(CFG.COLL.LEADS))
      .find({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' }, stage: { $nin: [CFG.STAGES.TRASH, CFG.STAGES.DELETED] } })
      .sort({ createdAt: 1, _id: 1 })
      .limit(1)
      .next();
    if (doc) return { [L.ID]: String(doc._id), [L.NAME]: String(doc.name || ''), [L.STAGE]: String(doc.stage || '') };
  }
  return null;
}

/* ------------------------------- assignment ------------------------------ */

/** RM for a new lead. `advance` false = preview (does not move the round-robin counter). */
export async function pickAssignee(source: Pick<SourceDoc, '_id' | 'config'>, advance = true): Promise<{ rm: string; warning: string }> {
  const a = source.config.assignment || { mode: 'unassigned', rm: '', rms: [] };
  if (a.mode === 'unassigned') return { rm: '', warning: '' };
  const active = new Set((await listUsers()).filter((u) => u.status === 'Active').map((u) => u.name));
  if (a.mode === 'fixed') {
    if (a.rm && active.has(a.rm)) return { rm: a.rm, warning: '' };
    return { rm: '', warning: `Assigned RM "${a.rm}" is not an active user — left unassigned` };
  }
  const pool = (a.rms || []).filter((n) => active.has(n));
  if (!pool.length) return { rm: '', warning: 'No active user in the round-robin list — left unassigned' };
  if (!advance) {
    const c = await (await col<{ _id: string; seq: number }>(CFG.COLL.COUNTERS)).findOne({ _id: 'rr:' + source._id });
    return { rm: pool[(c?.seq || 0) % pool.length], warning: '' };
  }
  const n = await nextCounter('rr:' + source._id);
  return { rm: pool[(n - 1) % pool.length], warning: '' };
}

/* ------------------------------- processing ------------------------------ */

interface Outcome { status: InboundStatus; leadId: string; duplicate: boolean; message: string }

/** Turn fields into a lead (or a duplicate remark). Never throws: failures come back as status 'failed'. */
async function processFields(source: SourceDoc, raw: Record<string, unknown>): Promise<Outcome> {
  try {
    const m = mapFields(source, raw);
    if (m.reject) return { status: 'rejected', leadId: '', duplicate: false, message: m.reject };
    const mode = source.config.duplicates || 'remark';
    if (mode !== 'create') {
      const dup = await findDuplicate(m.lead);
      if (dup) {
        const id = dup[L.ID];
        if (mode === 'skip') return { status: 'duplicate', leadId: id, duplicate: true, message: `Already exists as ${id} (skipped)` };
        const note = truncate(`New enquiry via ${source.name}: ${m.message || 'form submitted'}`, 1000);
        let message = `Follow-up added to ${id}`;
        try {
          await appendRemark(id, note, null, undefined, source.name);
        } catch (e: any) {
          message = `Already exists as ${id}; follow-up not added: ${e instanceof ApiError ? e.message : 'internal error'}`;
        }
        await addEvent('lead_reenquiry', 'Lead', id, `Re-enquiry: ${dup[L.NAME] || id}`, truncate(`via ${source.name}${m.message ? ' — ' + m.message : ''}`, 300), source.name, { source: 'website', sourceId: source._id });
        return { status: 'duplicate', leadId: id, duplicate: true, message };
      }
    }
    const { rm, warning } = await pickAssignee(source, true);
    const lead: UiLead = { ...m.lead };
    if (rm) lead[L.RM] = rm;
    const res = await addLead(lead, null, { actor: source.name, eventSource: 'website', allowDuplicate: true });
    const notes = [...m.warnings, warning].filter(Boolean).join('; ');
    return { status: 'created', leadId: res.id, duplicate: false, message: truncate(notes, 500) };
  } catch (e: any) {
    if (e instanceof ApiError && e.code === 'VALIDATION') return { status: 'rejected', leadId: '', duplicate: false, message: truncate(e.message, 300) };
    await logError('intake:' + source._id, e instanceof ApiError ? e.code : 'INTERNAL', e?.message, e?.stack, source.name);
    return { status: 'failed', leadId: '', duplicate: false, message: truncate(e instanceof ApiError ? e.message : 'Internal error: ' + (e?.message || e), 300) };
  }
}

const STAT_OF: Record<InboundStatus, keyof LeadSourceStats> = { created: 'created', duplicate: 'duplicates', rejected: 'rejected', failed: 'failed' };

async function bumpStats(sourceId: string, inc: Record<string, number>, status: InboundStatus, message: string) {
  const set: Record<string, unknown> = { 'stats.lastReceivedAt': new Date() };
  // bot traffic caught by the honeypot is counted as rejected but is not an error worth flagging
  if (status === 'failed' || (status === 'rejected' && !/^spam/.test(message))) set['stats.lastError'] = truncate(`${status}: ${message}`, 300);
  await (await sourcesCol()).updateOne({ _id: sourceId }, { $inc: inc, $set: set });
}

/** Ingest one submission (inside the source's company context). */
export async function ingestLead(source: SourceDoc, rawFields: Record<string, unknown>, meta: IngestMeta = {}): Promise<IngestResult> {
  const log = await inboundCol();
  const idem = truncate(String(meta.idempotencyKey || '').trim(), 200);
  const entry: InboundDoc = {
    _id: shortId('INB'),
    sourceId: source._id,
    receivedAt: new Date(),
    status: 'failed',
    leadId: '',
    message: 'processing',
    payload: storedPayload(rawFields),
    ip: truncate(meta.ip || '', 100),
    origin: truncate(meta.origin || '', 200),
    ...(idem ? { idempotencyKey: idem } : {}),
  };
  // Claim the submission first: a concurrent or repeated idempotency key hits the unique index.
  try {
    await log.insertOne(entry);
  } catch (e: any) {
    if (e?.code !== 11000 || !idem) throw e;
    const first = await log.findOne({ sourceId: source._id, idempotencyKey: idem });
    return { logId: first?._id || '', status: first?.status || 'duplicate', leadId: first?.leadId || '', duplicate: !!first?.duplicate, message: first?.message || '', replay: true };
  }

  const gotcha = flatValue(rawFields?._gotcha).trim();
  const out: Outcome = gotcha ? { status: 'rejected', leadId: '', duplicate: false, message: 'spam (honeypot)' } : await processFields(source, rawFields);
  await log.updateOne({ _id: entry._id }, { $set: { status: out.status, leadId: out.leadId, message: out.message, duplicate: out.duplicate } });
  await bumpStats(source._id, { 'stats.received': 1, ['stats.' + STAT_OF[out.status]]: 1 }, out.status, out.message);
  return { logId: entry._id, ...out };
}

/** Re-run a failed (or rejected) log entry from its stored payload; updates the entry in place. */
export async function retryInboundEntry(id: string): Promise<InboundDoc> {
  const log = await inboundCol();
  const entry = await log.findOne({ _id: String(id || '') });
  if (!entry) throw new ApiError('NOT_FOUND', 'Log entry not found');
  if (entry.status !== 'failed' && entry.status !== 'rejected') throw new ApiError('VALIDATION', 'Only failed or rejected submissions can be retried');
  if (entry.message === 'spam (honeypot)') throw new ApiError('VALIDATION', 'Spam submissions cannot be retried');
  const source = await (await sourcesCol()).findOne({ _id: entry.sourceId });
  if (!source) throw new ApiError('NOT_FOUND', 'The lead source of this submission no longer exists');
  const out = await processFields(source, payloadFields(entry.payload));
  // Only the entry that is still failed/rejected is updated (two retries at once cannot both create a lead).
  const upd = await log.findOneAndUpdate(
    { _id: entry._id, status: entry.status },
    { $set: { status: out.status, leadId: out.leadId, message: out.message, duplicate: out.duplicate, retriedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (upd) await bumpStats(source._id, { ['stats.' + STAT_OF[entry.status]]: -1, ['stats.' + STAT_OF[out.status]]: 1 }, out.status, out.message);
  return upd || (await log.findOne({ _id: entry._id }))!;
}

/** Preview: how a payload would be mapped (nothing saved, round-robin not advanced). */
export async function previewMapping(source: SourceDoc, payload: Record<string, unknown>): Promise<{ lead: Record<string, string>; warnings: string[] }> {
  const m = mapFields(source, payload || {});
  const warnings = [...m.warnings];
  if (m.reject) warnings.unshift(`Would be rejected: ${m.reject}`);
  else {
    const mode = source.config.duplicates || 'remark';
    const dup = mode !== 'create' ? await findDuplicate(m.lead) : null;
    if (dup) warnings.push(`Matches existing lead ${dup[L.ID]} — ${mode === 'skip' ? 'would be skipped' : 'a follow-up would be added to it'}`);
    const { rm, warning } = await pickAssignee(source, false);
    if (rm && !dup) m.lead[L.RM] = rm;
    if (warning) warnings.push(warning);
  }
  if (flatValue(payload?._gotcha).trim()) warnings.unshift('Honeypot field _gotcha is filled — would be treated as spam');
  return { lead: m.lead, warnings };
}

/* ------------------------------ serialisation ---------------------------- */

export function toLogEntry(d: InboundDoc, sourceName = ''): InboundLogEntry {
  return {
    id: d._id,
    sourceId: d.sourceId,
    sourceName,
    receivedAt: d.receivedAt ? new Date(d.receivedAt).toISOString() : '',
    status: d.status,
    leadId: d.leadId || '',
    message: d.message || '',
    payload: d.payload || {},
    ip: d.ip || '',
    origin: d.origin || '',
  };
}

/* ------------------------------- rate limits ----------------------------- */

/** Fixed-window counter in the company DB: true when this hit is within `limit` per minute. */
export async function rateHit(kind: string, id: string, limit: number): Promise<boolean> {
  if (!id) return true;
  const minute = Math.floor(Date.now() / 60000);
  const c = await col<{ _id: string; n: number; expiresAt: Date }>(COLL_RATE);
  const _id = `${kind}:${truncate(id, 100)}:${minute}`;
  const upd = () => c.findOneAndUpdate({ _id }, { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60000) } }, { upsert: true, returnDocument: 'after' });
  let doc;
  try {
    doc = await upd();
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    doc = await upd(); // concurrent upsert of the same window
  }
  return (doc?.n || 0) <= limit;
}
