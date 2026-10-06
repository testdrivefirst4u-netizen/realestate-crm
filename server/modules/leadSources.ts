/**
 * Lead sources — company settings for inbound lead capture (website forms, generic webhooks).
 *
 * Sources live in the company collection `leadSources` (SRC-0001 …). Each has one API key
 * `crm_live_<48 hex>`: only its SHA-256 is stored, in the PLATFORM collection `apiKeys`
 * ({ _id: sha256(key), companyId, sourceId, createdAt }) so the public endpoint can route a key to its
 * company without knowing the company first; the source keeps `keyPrefix` (first 12 chars) for display.
 * The full key is returned only by create and rotate.
 *
 * Type 'google_sheet' (server/modules/sheets.ts) has NO key (keyPrefix ''): rows are pulled from a shared
 * Google Sheet; config.sheet is validated (the sheet must be readable) and the spreadsheet is claimed for the
 * company (platform sheetClaims) on create/update and released when no longer used.
 *
 * Type 'meta' (server/modules/meta.ts) has NO key either: created only by connecting a Facebook Page
 * (connectMetaPages / connectCompanyMetaPage); deleting one disconnects the Page.
 *
 * The functions take an explicit Ctx so the super-admin console can reuse them inside runWithTenant().
 */
import type { ActionMap } from '../core/actions';
import { auditLog, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant, requireTenant } from '../core/tenant';
import { randomToken, sha256Hex, truncate } from '../core/utils';
import type {
  InboundLogEntry, InboundStatus, LeadSource, LeadSourceActions, LeadSourceConfig, LeadSourceType,
} from '../core/leadSourceTypes';
import { pc } from '../platform/base';
import { PCOLL } from '../platform/registry';
import {
  IGNORE_TARGET, inboundCol, MAPPABLE_HEADERS, previewMapping, retryInboundEntry, sourcesCol, toLogEntry, type SourceDoc,
} from './intake';
import { claimSheet, defaultSheetImportConfig, prepareSheetImportConfig, releaseSheetIfUnused } from './sheets';
import { defaultMetaSourceConfig, disconnectMetaSourceDoc, validFormIds } from './meta';

type Req<K extends keyof LeadSourceActions> = LeadSourceActions[K]['req'];
type Res<K extends keyof LeadSourceActions> = LeadSourceActions[K]['res'];

const TYPES: LeadSourceType[] = ['website', 'webhook', 'google_sheet'];
const TYPE_LABEL: Record<LeadSourceType, string> = { website: 'Website', webhook: 'Webhook', google_sheet: 'Google Sheet', meta: 'Meta Lead Ads' };
const ASSIGN_MODES = ['unassigned', 'fixed', 'round_robin'] as const;
const DUP_MODES = ['remark', 'skip', 'create'] as const;
const STATUSES: InboundStatus[] = ['created', 'duplicate', 'rejected', 'failed'];

export const KEY_RE = /^crm_live_[0-9a-f]{48}$/;
export const newApiKey = () => `crm_live_${randomToken(24)}`;
const keyPrefix = (key: string) => key.slice(0, 12);

const apiKeys = () => pc<{ _id: string; companyId: string; sourceId: string; createdAt: Date }>(PCOLL.API_KEYS);
const actorName = (ctx: Ctx | null) => (ctx?.user ? ctx.user.name + (ctx.user.email ? ` <${ctx.user.email}>` : '') : 'System');

/* ------------------------------ serialisation ---------------------------- */

export function defaultConfig(type: LeadSourceType): LeadSourceConfig {
  return {
    sourceLabel: TYPE_LABEL[type] || 'Website',
    defaultStage: CFG.STAGES.NEW,
    assignment: { mode: 'unassigned', rm: '', rms: [] },
    duplicates: 'remark',
    allowedOrigins: [],
    fieldMap: {},
    ...(type === 'google_sheet' ? { sheet: defaultSheetImportConfig() } : {}),
    ...(type === 'meta' ? { meta: defaultMetaSourceConfig() } : {}),
  };
}

export function toSource(d: SourceDoc): LeadSource {
  const s = d.stats || {};
  return {
    id: d._id,
    type: d.type,
    name: d.name,
    status: d.status === 'Paused' ? 'Paused' : 'Active',
    keyPrefix: d.keyPrefix || '',
    config: (() => {
      const c: LeadSourceConfig = { ...defaultConfig(d.type), ...(d.config || {}) };
      if (d.type === 'google_sheet') c.sheet = { ...defaultSheetImportConfig(), ...(d.config?.sheet || {}) };
      else delete c.sheet;
      if (d.type === 'meta') c.meta = { ...defaultMetaSourceConfig(), ...(d.config?.meta || {}) };
      else delete c.meta;
      return c;
    })(),
    stats: {
      received: Number(s.received) || 0,
      created: Number(s.created) || 0,
      duplicates: Number(s.duplicates) || 0,
      rejected: Number(s.rejected) || 0,
      failed: Number(s.failed) || 0,
      lastReceivedAt: s.lastReceivedAt ? new Date(s.lastReceivedAt).toISOString() : '',
      lastError: s.lastError || '',
    },
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
    createdBy: d.createdBy || '',
  };
}

/* -------------------------------- validation ----------------------------- */

function validName(v: unknown): string {
  const n = String(v ?? '').trim();
  if (!n || n.length > 80) throw fail('VALIDATION', 'Source name must be 1–80 characters');
  return n;
}

/** 'https://www.example.com' (scheme + host [+ port], no path). */
export function normalizeOrigin(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw fail('VALIDATION', `"${truncate(s, 80)}" is not a valid origin (e.g. https://www.example.com)`);
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin.toLowerCase() !== s.toLowerCase() || u.username || u.password) {
    throw fail('VALIDATION', `"${truncate(s, 80)}" must be an http(s) origin without a path, e.g. https://www.example.com`);
  }
  return u.origin;
}

/** Merge a partial config over `base` and validate the result. */
export async function mergeConfig(base: LeadSourceConfig, patch: unknown): Promise<LeadSourceConfig> {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) throw fail('VALIDATION', 'config must be an object');
  const p = patch as Partial<LeadSourceConfig>;
  const out: LeadSourceConfig = { ...base, assignment: { ...base.assignment }, allowedOrigins: [...base.allowedOrigins], fieldMap: { ...base.fieldMap } };
  // config.sheet is validated separately (prepareSheetImportConfig) because it needs the Google check;
  // config.meta is server-managed (only meta.formIds can be changed, see updateLeadSource)

  if (p.sourceLabel !== undefined) {
    const v = String(p.sourceLabel ?? '').trim();
    if (v.length > 60) throw fail('VALIDATION', 'Enquiry Source label is too long (max 60)');
    out.sourceLabel = v;
  }
  if (p.defaultStage !== undefined) {
    const v = String(p.defaultStage ?? '').trim();
    if (v.length > 60) throw fail('VALIDATION', 'Default stage is too long (max 60)');
    if (v === CFG.STAGES.TRASH || v === CFG.STAGES.DELETED) throw fail('VALIDATION', 'New leads cannot start in the Recycle Bin');
    out.defaultStage = v;
  }
  if (p.duplicates !== undefined) {
    if (!(DUP_MODES as readonly string[]).includes(String(p.duplicates))) throw fail('VALIDATION', 'duplicates must be remark, skip or create');
    out.duplicates = p.duplicates;
  }
  if (p.allowedOrigins !== undefined) {
    if (!Array.isArray(p.allowedOrigins)) throw fail('VALIDATION', 'allowedOrigins must be a list');
    if (p.allowedOrigins.length > 20) throw fail('VALIDATION', 'At most 20 allowed origins');
    out.allowedOrigins = [...new Set(p.allowedOrigins.filter((o) => String(o ?? '').trim()).map(normalizeOrigin))];
  }
  if (p.fieldMap !== undefined) {
    if (!p.fieldMap || typeof p.fieldMap !== 'object' || Array.isArray(p.fieldMap)) throw fail('VALIDATION', 'fieldMap must be an object');
    const entries = Object.entries(p.fieldMap);
    if (entries.length > 50) throw fail('VALIDATION', 'At most 50 field mappings');
    const fm: Record<string, string> = {};
    for (const [k, v] of entries) {
      const key = String(k).trim();
      const target = String(v ?? '').trim();
      if (!key || key.length > 80 || /^\$|\./.test(key)) throw fail('VALIDATION', `Invalid incoming field name "${truncate(key, 80)}" (no dots, not starting with $)`);
      if (target !== IGNORE_TARGET && !MAPPABLE_HEADERS.includes(target)) {
        throw fail('VALIDATION', `"${truncate(target, 60)}" is not a lead field that can be mapped (field "${truncate(key, 40)}")`);
      }
      fm[key] = target;
    }
    out.fieldMap = fm;
  }
  if (p.assignment !== undefined) {
    const a = p.assignment as Partial<LeadSourceConfig['assignment']>;
    if (!a || typeof a !== 'object') throw fail('VALIDATION', 'assignment must be an object');
    const mode = a.mode ?? out.assignment.mode;
    if (!(ASSIGN_MODES as readonly string[]).includes(String(mode))) throw fail('VALIDATION', 'assignment.mode must be unassigned, fixed or round_robin');
    out.assignment = {
      mode,
      rm: a.rm !== undefined ? String(a.rm ?? '').trim() : out.assignment.rm,
      rms: a.rms !== undefined ? (Array.isArray(a.rms) ? [...new Set(a.rms.map((x) => String(x ?? '').trim()).filter(Boolean))] : null as any) : out.assignment.rms,
    };
    if (!Array.isArray(out.assignment.rms)) throw fail('VALIDATION', 'assignment.rms must be a list of user names');
  }
  // assignment must point at existing users
  const a = out.assignment;
  if (a.mode === 'fixed' || a.mode === 'round_robin') {
    const names = new Set((await listUsers()).map((u) => u.name));
    if (a.mode === 'fixed') {
      if (!a.rm) throw fail('VALIDATION', 'Choose the user who receives the leads');
      if (!names.has(a.rm)) throw fail('VALIDATION', `"${truncate(a.rm, 60)}" is not a user of this company`);
    } else {
      if (!a.rms.length) throw fail('VALIDATION', 'Choose at least one user for round robin');
      if (a.rms.length > 50) throw fail('VALIDATION', 'At most 50 users in a round robin');
      const unknown = a.rms.filter((n) => !names.has(n));
      if (unknown.length) throw fail('VALIDATION', `Not users of this company: ${truncate(unknown.join(', '), 120)}`);
    }
  }
  return out;
}

async function findSource(id: unknown): Promise<SourceDoc> {
  const s = await (await sourcesCol()).findOne({ _id: String(id || '') });
  if (!s) throw fail('NOT_FOUND', 'Lead source not found');
  return s;
}

/** Look up a raw API key → { companyId, sourceId } (platform DB). null when unknown or malformed. */
export async function resolveApiKey(key: string): Promise<{ companyId: string; sourceId: string } | null> {
  if (!KEY_RE.test(key)) return null;
  const doc = await (await apiKeys()).findOne({ _id: sha256Hex(key) });
  return doc ? { companyId: doc.companyId, sourceId: doc.sourceId } : null;
}

async function issueKey(sourceId: string): Promise<string> {
  const key = newApiKey();
  await (await apiKeys()).insertOne({ _id: sha256Hex(key), companyId: requireTenant().id, sourceId, createdAt: new Date() });
  return key;
}

/* --------------------------------- actions ------------------------------- */

export async function listLeadSources(): Promise<Res<'listLeadSources'>> {
  const rows = await (await sourcesCol()).find({}).sort({ _id: 1 }).toArray();
  return rows.map(toSource);
}

export async function createLeadSource(d: Req<'createLeadSource'>, ctx: Ctx | null): Promise<Res<'createLeadSource'>> {
  requireTenant();
  const name = validName(d?.name);
  const type = String(d?.type || '') as LeadSourceType;
  if (type === 'meta') throw fail('VALIDATION', 'Meta (Facebook / Instagram) sources are created by connecting a Facebook Page (Connect with Facebook)');
  if (!TYPES.includes(type)) throw fail('VALIDATION', 'type must be website, webhook or google_sheet');
  const config = await mergeConfig(defaultConfig(type), d?.config);
  const isSheet = type === 'google_sheet';
  if (isSheet) {
    config.sheet = await prepareSheetImportConfig(undefined, (d?.config as Partial<LeadSourceConfig> | undefined)?.sheet);
    await claimSheet(config.sheet.spreadsheetId);
  } else delete config.sheet;
  const id = await nextSeq('SRC', 4);
  const key = isSheet ? '' : newApiKey();
  const doc: SourceDoc = {
    _id: id,
    type,
    name,
    status: 'Active',
    keyPrefix: isSheet ? '' : keyPrefix(key),
    config,
    stats: { received: 0, created: 0, duplicates: 0, rejected: 0, failed: 0, lastReceivedAt: null, lastError: '' },
    createdAt: new Date(),
    createdBy: actorName(ctx),
    updatedAt: new Date(),
  };
  try {
    await (await sourcesCol()).insertOne(doc);
  } catch (e) {
    if (isSheet) await releaseSheetIfUnused(config.sheet!.spreadsheetId);
    throw e;
  }
  if (isSheet) {
    await auditLog(ctx, 'Lead Source Created', 'Settings', id, `${name} (google_sheet) ${config.sheet!.spreadsheetId}${config.sheet!.tab ? ' / ' + config.sheet!.tab : ''}`);
    return { source: toSource(doc), apiKey: '' };
  }
  try {
    await (await apiKeys()).insertOne({ _id: sha256Hex(key), companyId: requireTenant().id, sourceId: id, createdAt: new Date() });
  } catch (e) {
    await (await sourcesCol()).deleteOne({ _id: id });
    throw e;
  }
  await auditLog(ctx, 'Lead Source Created', 'Settings', id, `${name} (${type}) key ${doc.keyPrefix}…`);
  return { source: toSource(doc), apiKey: key };
}

export async function updateLeadSource(d: Req<'updateLeadSource'>, ctx: Ctx | null): Promise<Res<'updateLeadSource'>> {
  const cur = await findSource(d?.id);
  const p = d?.patch && typeof d.patch === 'object' ? d.patch : {};
  const set: Partial<SourceDoc> = {};
  if (p.name !== undefined) set.name = validName(p.name);
  if (p.status !== undefined) {
    if (p.status !== 'Active' && p.status !== 'Paused') throw fail('VALIDATION', 'status must be Active or Paused');
    set.status = p.status;
  }
  let claimed = '';
  if (p.config !== undefined) {
    const base = toSource(cur).config;
    set.config = await mergeConfig(base, p.config);
    if (cur.type === 'google_sheet') {
      const sheetPatch = p.config && typeof p.config === 'object' ? (p.config as Partial<LeadSourceConfig>).sheet : undefined;
      set.config.sheet = await prepareSheetImportConfig(base.sheet, sheetPatch);
      if (set.config.sheet.spreadsheetId !== base.sheet?.spreadsheetId) {
        await claimSheet(set.config.sheet.spreadsheetId);
        claimed = set.config.sheet.spreadsheetId;
      }
    } else delete set.config.sheet;
    if (cur.type === 'meta') {
      const metaPatch = p.config && typeof p.config === 'object' ? (p.config as Partial<LeadSourceConfig>).meta : undefined;
      const meta = { ...base.meta! };
      if (metaPatch !== undefined && metaPatch !== null) {
        if (typeof metaPatch !== 'object' || Array.isArray(metaPatch)) throw fail('VALIDATION', 'config.meta must be an object');
        // only the form filter can be changed; everything else is managed by the server
        if ((metaPatch as any).formIds !== undefined) {
          const ids = validFormIds((metaPatch as any).formIds);
          const known = meta.forms || [];
          if (known.length && ids.some((f) => !known.some((x) => x.id === f))) throw fail('VALIDATION', 'A chosen lead form does not belong to this Page (refresh the forms with "Check" first)');
          meta.formIds = ids;
        }
      }
      set.config.meta = meta;
    } else delete set.config.meta;
  }
  const changed = Object.keys(set).filter((k) => JSON.stringify((set as any)[k]) !== JSON.stringify((cur as any)[k]));
  if (!changed.length) return toSource(cur);
  set.updatedAt = new Date();
  try {
    await (await sourcesCol()).updateOne({ _id: cur._id }, { $set: set });
  } catch (e) {
    if (claimed) await releaseSheetIfUnused(claimed);
    throw e;
  }
  if (claimed && cur.config?.sheet?.spreadsheetId) await releaseSheetIfUnused(cur.config.sheet.spreadsheetId);
  const before = Object.fromEntries(changed.map((k) => [k, (cur as any)[k]]));
  const after = Object.fromEntries(changed.map((k) => [k, (set as any)[k]]));
  await auditLog(ctx, 'Lead Source Updated', 'Settings', cur._id, `${cur.name}: ${changed.join(', ')}`, { before, after });
  return toSource((await findSource(cur._id))!);
}

export async function rotateLeadSourceKey(d: Req<'rotateLeadSourceKey'>, ctx: Ctx | null): Promise<Res<'rotateLeadSourceKey'>> {
  const cur = await findSource(d?.id);
  if (cur.type === 'google_sheet' || cur.type === 'meta') throw fail('VALIDATION', cur.type === 'meta' ? 'Meta sources have no API key' : 'Google Sheet sources have no API key');
  const tenant = requireTenant();
  const keys = await apiKeys();
  const key = await issueKey(cur._id);
  await keys.deleteMany({ companyId: tenant.id, sourceId: cur._id, _id: { $ne: sha256Hex(key) } });
  await (await sourcesCol()).updateOne({ _id: cur._id }, { $set: { keyPrefix: keyPrefix(key), updatedAt: new Date() } });
  await auditLog(ctx, 'Lead Source Key Rotated', 'Settings', cur._id, `${cur.name}: new key ${keyPrefix(key)}… (old ${cur.keyPrefix}… revoked)`);
  return { source: toSource((await findSource(cur._id))!), apiKey: key };
}

export async function deleteLeadSource(d: Req<'deleteLeadSource'>, ctx: Ctx | null): Promise<Res<'deleteLeadSource'>> {
  const cur = await findSource(d?.id);
  // a Meta source: unsubscribe the app from the Page (best effort), release the Page claim, delete token + source
  if (cur.type === 'meta') {
    await disconnectMetaSourceDoc(cur, ctx);
    return { ok: true };
  }
  await (await apiKeys()).deleteMany({ companyId: requireTenant().id, sourceId: cur._id });
  await (await sourcesCol()).deleteOne({ _id: cur._id });
  if (cur.type === 'google_sheet') await releaseSheetIfUnused(cur.config?.sheet?.spreadsheetId || '');
  await auditLog(ctx, 'Lead Source Deleted', 'Settings', cur._id, cur.type === 'google_sheet' ? `${cur.name} (google_sheet)` : `${cur.name} (${cur.type}); key ${cur.keyPrefix}… revoked`);
  return { ok: true };
}

export async function listInboundLog(d: Req<'listInboundLog'> = {}): Promise<Res<'listInboundLog'>> {
  const q: Record<string, unknown> = {};
  if (d?.sourceId) q.sourceId = String(d.sourceId);
  if (d?.status) {
    if (!STATUSES.includes(d.status as InboundStatus)) throw fail('VALIDATION', 'Unknown status');
    q.status = d.status;
  }
  const limit = Math.max(1, Math.min(Math.floor(Number(d?.limit) || 100), 500));
  const [rows, sources] = await Promise.all([
    (await inboundCol()).find(q).sort({ receivedAt: -1, _id: -1 }).limit(limit).toArray(),
    (await sourcesCol()).find({}, { projection: { name: 1 } }).toArray(),
  ]);
  const names = new Map(sources.map((s) => [s._id, s.name]));
  return rows.map((r) => toLogEntry(r, names.get(r.sourceId) || '(deleted source)'));
}

export async function retryInbound(d: Req<'retryInbound'>, ctx: Ctx | null): Promise<Res<'retryInbound'>> {
  const entry = await retryInboundEntry(String(d?.id || ''));
  const src = await (await sourcesCol()).findOne({ _id: entry.sourceId }, { projection: { name: 1 } });
  await auditLog(ctx, 'Inbound Lead Retried', 'Settings', entry._id, `${src?.name || entry.sourceId}: ${entry.status}${entry.leadId ? ' ' + entry.leadId : ''}`);
  return toLogEntry(entry, src?.name || '');
}

export async function previewLeadSource(d: Req<'previewLeadSource'>): Promise<Res<'previewLeadSource'>> {
  const src = await findSource(d?.id);
  const payload = d?.payload && typeof d.payload === 'object' && !Array.isArray(d.payload) ? d.payload : null;
  if (!payload) throw fail('VALIDATION', 'payload must be an object of field → value');
  return previewMapping({ ...src, config: toSource(src).config }, payload);
}

/**
 * The company router admits lead-source actions when the plan has websiteApi OR googleSheets; here each
 * source type is held to its own feature (website/webhook → websiteApi, google_sheet → googleSheets).
 * Meta sources need metaLeads. The super-admin console calls the functions directly and is not gated.
 */
function assertTypeFeature(type: string) {
  const t = currentTenant();
  if (!t) return;
  if (type === 'meta') {
    if (!t.features.metaLeads) throw fail('FORBIDDEN', "Meta (Facebook / Instagram) Lead Ads are not included in your company's plan.");
    return;
  }
  if (type === 'google_sheet' ? !t.features.googleSheets : !t.features.websiteApi) {
    throw fail('FORBIDDEN', type === 'google_sheet' ? "Google Sheets sync is not included in your company's plan." : "Website forms & lead API are not included in your company's plan.");
  }
}
async function guardSource(id: unknown) {
  const s = await (await sourcesCol()).findOne({ _id: String(id || '') }, { projection: { type: 1 } });
  if (s) assertTypeFeature(s.type);
}

export const actions: ActionMap = {
  listLeadSources: { fn: () => listLeadSources(), perm: 'settings.view' },
  createLeadSource: { fn: (d, ctx) => (assertTypeFeature(String(d?.type || '')), createLeadSource(d, ctx)), perm: 'settings.edit' },
  updateLeadSource: { fn: async (d, ctx) => (await guardSource(d?.id), updateLeadSource(d, ctx)), perm: 'settings.edit' },
  rotateLeadSourceKey: { fn: async (d, ctx) => (await guardSource(d?.id), rotateLeadSourceKey(d, ctx)), perm: 'settings.edit' },
  deleteLeadSource: { fn: async (d, ctx) => (await guardSource(d?.id), deleteLeadSource(d, ctx)), perm: 'settings.edit' },
  listInboundLog: { fn: (d) => listInboundLog(d), perm: 'settings.view' },
  retryInbound: { fn: (d, ctx) => retryInbound(d, ctx), perm: 'settings.edit' },
  previewLeadSource: { fn: (d) => previewLeadSource(d), perm: 'settings.edit' },
};
