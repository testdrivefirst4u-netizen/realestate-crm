/**
 * Google Sheets integration — company side (contract and design: server/core/sheetTypes.ts).
 *
 * Import  = lead source of type 'google_sheet' (collection leadSources, config.sheet). Rows go through the
 *           regular intake pipeline (ingestLead: mapping, duplicates, assignment, intake log, stats). Rows are
 *           chosen by the status column (empty status = not imported yet) or, without one, by config.sheet.lastRow.
 *           Every row has an idempotency key (row number + hash of its values), so a re-run never creates a
 *           lead twice even if writing the status back failed.
 * Export  = collection sheetExports (SHX-0001): the tab is cleared and rewritten (RAW values) with one row per
 *           lead; the data version exported is stored so the cron skips unchanged data.
 * Claims  = platform collection sheetClaims { _id: spreadsheetId, companyId }: linking a sheet claims it; a
 *           sheet claimed by another company is refused (CONFLICT); the claim is released when the company no
 *           longer uses the sheet (and when the company is deleted).
 * Cron    = runDueSheetJobs() (GET /api/cron/sheets, inside each company).
 *
 * canWrite (checkSheet): determined by writing the header row's first cell back unchanged (see
 * server/integrations/sheets.ts → probeWrite). Viewer access (or a protected cell) → false.
 *
 * Auth    = each import (config.sheet.auth) and export (auth) says how it reaches Google: the platform service
 *           account (default; also when auth is missing) or one of the company's "Connect with Google"
 *           connections (server/modules/googleConnect.ts). Every Google call of a link goes through
 *           sheetAccessFor(auth) resolved in the company context. Claims are the same in both modes.
 *           A revoked connection fails only the links that use it (lastSyncResult / lastError = RECONNECT_MSG).
 */
import type { Collection } from 'mongodb';
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col, getVersion, nextSeq } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { logError } from '../core/events';
import { requireTenant } from '../core/tenant';
import { fmtHuman, sha256Hex, truncate } from '../core/utils';
import type { GoogleConnection, SheetActions, SheetAuth, SheetCheckResult, SheetExport, SheetExportColumns, SheetImportConfig, SyncInterval } from '../core/sheetTypes';
import { decryptSecret } from '../core/settings';
import { googleStatus } from '../integrations/google';
import {
  a1, addSheet, batchUpdateValues, clearValues, colLetter, formatHeaderRow, getSpreadsheet, parseSpreadsheetId, probeWrite, readValues, updateValues,
  type SheetAccess,
} from '../integrations/sheets';
import { googleConnectionsCol, resetGoogleOAuthTokenCache, revokeGoogleToken, sheetAccessFor, toConnection, validateSheetAuth } from './googleConnect';
import { pc } from '../platform/base';
import { PCOLL } from '../platform/registry';
import { ingestLead, sourcesCol, type IngestResult, type SourceDoc } from './intake';
import { getAllLeads } from './leads';

type Req<K extends keyof SheetActions> = SheetActions[K]['req'];
type Res<K extends keyof SheetActions> = SheetActions[K]['res'];

const L = CFG.LEAD;
export const COLL_EXPORTS = 'sheetExports';
export const INTERVALS: SyncInterval[] = [0, 5, 15, 60];
export const MAX_ROWS_PER_RUN = 2000;
/**
 * Time one manual "Sync now" may spend on rows: it must answer before the browser gives up (120 s) and well
 * inside the function's maxDuration. Rows not reached are left for the next sync, which continues from there.
 */
export const MANUAL_SYNC_BUDGET_MS = 90_000;
export const DEFAULT_EXPORT_TAB = 'CRM Leads';
export const FOLLOWUPS_HEADER = 'Follow-ups';
export const DEFAULT_EXPORT_HEADERS = [
  L.ID, L.ENQUIRY_DATE, L.NAME, L.PHONE, L.EMAIL, L.STAGE, L.SOURCE, L.UNIT_TYPE, L.SITE_VISIT_STATUS, L.NEXT_FOLLOWUP, L.RM, L.NOTES, L.LAST_FOLLOWUP,
];
const MAX_CELL = 49000; // Google's limit is 50,000 characters per cell
const WRITE_CHUNK = 5000; // rows per values.update request
const LOCK_MS = 10 * 60 * 1000;

const actorName = (ctx: Ctx | null) => (ctx?.user ? ctx.user.name + (ctx.user.email ? ` <${ctx.user.email}>` : '') : 'System');
const errMsg = (e: any) => (e instanceof ApiError ? e.message : 'Internal error: ' + truncate(e?.message || String(e), 200));

/* --------------------------------- shapes -------------------------------- */

export interface SheetExportDoc {
  _id: string; // SHX-0001
  /** Missing = service account. */
  auth?: SheetAuth;
  name: string;
  spreadsheetUrl: string;
  spreadsheetId: string;
  tab: string;
  columns: SheetExportColumns;
  intervalMinutes: SyncInterval;
  status: 'Active' | 'Paused';
  lastSyncAt: Date | null;
  lastRows: number;
  lastError: string;
  /** Data version (server/core/db.ts getVersion) of the last successful export. */
  lastVersion: string;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  syncLockUntil?: Date | null;
}

export const exportsCol = () => col<SheetExportDoc>(COLL_EXPORTS);
const claimsCol = () => pc<{ _id: string; companyId: string; claimedAt: Date }>(PCOLL.SHEET_CLAIMS);

export function defaultSheetImportConfig(): SheetImportConfig {
  return { spreadsheetUrl: '', spreadsheetId: '', tab: '', headerRow: 1, statusColumn: '', intervalMinutes: 15, lastRow: 0, lastSyncAt: '', lastSyncResult: '' };
}

/** Stored auth → API shape (missing/unknown = service account). */
export function normAuth(a: SheetAuth | undefined | null): SheetAuth {
  return a?.mode === 'oauth' && a.connectionId ? { mode: 'oauth', connectionId: a.connectionId } : { mode: 'service_account' };
}

export function toExport(d: SheetExportDoc): SheetExport {
  return {
    id: d._id,
    auth: normAuth(d.auth),
    name: d.name,
    spreadsheetUrl: d.spreadsheetUrl,
    spreadsheetId: d.spreadsheetId,
    tab: d.tab,
    columns: { headers: [...(d.columns?.headers || DEFAULT_EXPORT_HEADERS)], includeFollowups: !!d.columns?.includeFollowups, includeTrash: !!d.columns?.includeTrash },
    intervalMinutes: INTERVALS.includes(d.intervalMinutes) ? d.intervalMinutes : 0,
    status: d.status === 'Paused' ? 'Paused' : 'Active',
    lastSyncAt: d.lastSyncAt ? new Date(d.lastSyncAt).toISOString() : '',
    lastRows: Number(d.lastRows) || 0,
    lastError: d.lastError || '',
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
    createdBy: d.createdBy || '',
  };
}

/* --------------------------------- claims -------------------------------- */

/** Fail with CONFLICT when another company has linked this spreadsheet. */
export async function assertNotClaimedByOther(spreadsheetId: string) {
  const d = await (await claimsCol()).findOne({ _id: spreadsheetId });
  if (d && d.companyId !== requireTenant().id) throw fail('CONFLICT', 'This spreadsheet is already linked to another workspace');
}

/** Claim a spreadsheet for the current company (idempotent). CONFLICT when another company holds it. */
export async function claimSheet(spreadsheetId: string) {
  const t = requireTenant();
  const c = await claimsCol();
  try {
    await c.updateOne({ _id: spreadsheetId }, { $setOnInsert: { companyId: t.id, claimedAt: new Date() } }, { upsert: true });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
  }
  const d = await c.findOne({ _id: spreadsheetId });
  if (d && d.companyId !== t.id) throw fail('CONFLICT', 'This spreadsheet is already linked to another workspace');
}

/** Release the claim when no import source and no export of this company references the sheet any more. */
export async function releaseSheetIfUnused(spreadsheetId: string) {
  if (!spreadsheetId) return;
  const [imports, exports] = await Promise.all([
    (await sourcesCol()).countDocuments({ type: 'google_sheet', 'config.sheet.spreadsheetId': spreadsheetId }),
    (await exportsCol()).countDocuments({ spreadsheetId }),
  ]);
  if (!imports && !exports) await (await claimsCol()).deleteOne({ _id: spreadsheetId, companyId: requireTenant().id });
}

/* ---------------------------------- check -------------------------------- */

function validHeaderRow(v: unknown): number {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw fail('VALIDATION', 'The header row must be a row number from 1 to 20');
  return n;
}

function validTabName(v: unknown, label = 'Tab name'): string {
  const s = String(v ?? '').trim();
  if (s.length > 100) throw fail('VALIDATION', `${label} is too long (max 100 characters)`);
  if (/[\u0000-\u001f]/.test(s)) throw fail('VALIDATION', `${label} contains invalid characters`);
  return s;
}

/**
 * Title, tabs and header row of a sheet, plus whether the CRM can write to it. Never claims the sheet.
 * Access problems come back as { ok:false, message }; malformed input throws VALIDATION; a sheet linked by
 * another company throws CONFLICT (its contents are never shown).
 */
export async function checkSheet(d: Req<'checkSheet'>, opts: { probe?: boolean } = {}): Promise<SheetCheckResult> {
  const id = parseSpreadsheetId(d?.spreadsheetUrl);
  const headerRow = validHeaderRow(d?.headerRow);
  const wanted = validTabName(d?.tab);
  const auth = await validateSheetAuth(d?.auth);
  await assertNotClaimedByOther(id);
  return checkWith(sheetAccessFor(auth), id, wanted, headerRow, opts);
}

/** checkSheet with an already validated link and access. */
async function checkWith(access: SheetAccess, id: string, wanted: string, headerRow: number, opts: { probe?: boolean } = {}): Promise<SheetCheckResult> {
  const out: SheetCheckResult = { ok: false, title: '', tabs: [], headers: [], canWrite: false, message: '' };
  try {
    const info = await getSpreadsheet(access, id);
    out.title = info.title;
    out.tabs = info.tabs.map((t) => t.title);
    const tab = wanted || out.tabs[0] || '';
    if (!out.tabs.includes(tab)) {
      out.message = `Tab "${tab}" was not found in "${info.title}". Tabs: ${truncate(out.tabs.join(', '), 200)}`;
      return out;
    }
    const rows = await readValues(access, id, a1(tab, `A${headerRow}:ZZ${headerRow}`));
    out.headers = (rows[0] || []).map((h) => String(h ?? '').trim());
    out.ok = true;
    if (opts.probe !== false) {
      try {
        out.canWrite = await probeWrite(access, id, a1(tab, `A${headerRow}`));
      } catch {
        out.canWrite = false;
      }
    }
    return out;
  } catch (e: any) {
    if (e instanceof ApiError && e.code !== 'INTERNAL') {
      out.message = e.message;
      return out;
    }
    throw e;
  }
}

/* --------------------------- import configuration ------------------------ */

const findStatusIndex = (headers: string[], name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());

/**
 * Validate config.sheet of a google_sheet lead source (create: prev undefined; update: the stored config).
 * Checks the sheet (must be readable, header row present, status column present) when the link changes and
 * refuses a tab an export of this company writes to. Server-managed fields (lastRow, lastSync*) are kept,
 * or reset when the spreadsheet/tab/header row change. Does not claim (the caller does, before saving).
 */
export async function prepareSheetImportConfig(prev: SheetImportConfig | undefined, patch: unknown): Promise<SheetImportConfig> {
  if (patch === undefined || patch === null) {
    if (!prev) throw fail('VALIDATION', 'config.sheet is required for a Google Sheet source (spreadsheetUrl, tab, headerRow …)');
    return prev;
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) throw fail('VALIDATION', 'config.sheet must be an object');
  const p = patch as Partial<SheetImportConfig>;
  const out: SheetImportConfig = { ...defaultSheetImportConfig(), ...(prev || {}) };
  if (p.spreadsheetUrl !== undefined) {
    const url = String(p.spreadsheetUrl ?? '').trim();
    if (url.length > 500) throw fail('VALIDATION', 'The sheet link is too long');
    out.spreadsheetId = parseSpreadsheetId(url);
    out.spreadsheetUrl = url;
  }
  if (!out.spreadsheetUrl || !out.spreadsheetId) throw fail('VALIDATION', 'Paste the Google Sheet link');
  if (p.tab !== undefined) out.tab = validTabName(p.tab);
  if (p.headerRow !== undefined) out.headerRow = validHeaderRow(p.headerRow);
  if (p.statusColumn !== undefined) out.statusColumn = validTabName(p.statusColumn, 'Status column');
  if (p.intervalMinutes !== undefined) {
    const n = Number(p.intervalMinutes);
    if (!INTERVALS.includes(n as SyncInterval)) throw fail('VALIDATION', 'intervalMinutes must be 0 (manual), 5, 15 or 60');
    out.intervalMinutes = n as SyncInterval;
  }
  // auth: validated when given (oauth = an Active connection of this company); the default on create; kept on update
  if (!prev || p.auth !== undefined) out.auth = await validateSheetAuth(p.auth);
  const authChanged = !!prev && JSON.stringify(normAuth(prev.auth)) !== JSON.stringify(normAuth(out.auth));
  const linkChanged = !prev || prev.spreadsheetId !== out.spreadsheetId || prev.tab !== out.tab || prev.headerRow !== out.headerRow;
  if (linkChanged) Object.assign(out, { lastRow: 0, lastSyncAt: '', lastSyncResult: '' });
  if (linkChanged || authChanged || prev?.statusColumn !== out.statusColumn) {
    await assertNotClaimedByOther(out.spreadsheetId);
    const chk = await checkWith(sheetAccessFor(out.auth), out.spreadsheetId, out.tab, out.headerRow, { probe: false });
    if (!chk.ok) throw fail('VALIDATION', chk.message || 'The sheet cannot be read');
    if (!chk.headers.some(Boolean)) throw fail('VALIDATION', `Row ${out.headerRow} of the tab is empty — it must hold the column headers (Name, Phone, Email, …)`);
    if (out.statusColumn) {
      const i = findStatusIndex(chk.headers, out.statusColumn);
      if (i < 0) throw fail('VALIDATION', `Column "${out.statusColumn}" was not found in header row ${out.headerRow}. Add it to the sheet first (it can be empty).`);
      out.statusColumn = chk.headers[i];
    }
    const tab = out.tab || chk.tabs[0] || '';
    const clash = await (await exportsCol()).findOne({ spreadsheetId: out.spreadsheetId, tab });
    if (clash) throw fail('VALIDATION', `Tab "${tab}" is written by the export "${clash.name}" — import from another tab`);
  }
  return out;
}

/* --------------------------------- locking ------------------------------- */

async function withLock<T>(c: Collection<any>, id: string, fn: () => Promise<T>): Promise<T> {
  const now = new Date();
  const got = await c.findOneAndUpdate(
    { _id: id, $or: [{ syncLockUntil: { $exists: false } }, { syncLockUntil: null }, { syncLockUntil: { $lt: now } }] },
    { $set: { syncLockUntil: new Date(now.getTime() + LOCK_MS) } }
  );
  if (!got) throw fail('CONFLICT', 'A sync of this sheet is already running. Try again in a minute.');
  try {
    return await fn();
  } finally {
    await c.updateOne({ _id: id }, { $unset: { syncLockUntil: '' } });
  }
}

/* ---------------------------------- import ------------------------------- */

/** Unique, non-empty column names ('' → 'Column C', repeated 'Phone' → 'Phone (2)'). */
function columnNames(raw: string[], width: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    let n = String(raw[i] ?? '').trim() || `Column ${colLetter(i)}`;
    const k = n.toLowerCase();
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    if (c > 1) n = `${n} (${c})`;
    out.push(n);
  }
  return out;
}

export interface SyncResult {
  created: number;
  duplicates: number;
  rejected: number;
  failed: number;
  message: string;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function statusText(r: IngestResult, when: string): string {
  if (r.status === 'created') return `Imported ${r.leadId} · ${when}`;
  if (r.status === 'duplicate') return r.leadId ? `Duplicate of ${r.leadId}` : 'Duplicate';
  if (r.status === 'rejected') return truncate(`Rejected: ${r.message || 'invalid row'}`, 300);
  return truncate(`Failed: ${r.message || 'error'} (retry from the intake log)`, 300);
}

async function findSheetSource(id: unknown): Promise<SourceDoc> {
  const s = await (await sourcesCol()).findOne({ _id: String(id || '') });
  if (!s) throw fail('NOT_FOUND', 'Lead source not found');
  if (s.type !== 'google_sheet' || !s.config?.sheet?.spreadsheetId) throw fail('VALIDATION', 'This lead source is not a Google Sheet import');
  return s;
}

/**
 * Import new rows of a google_sheet source (manual: ctx = the user; cron: null). Stops starting new rows at
 * `deadline` (default: MANUAL_SYNC_BUDGET_MS from now) and saves its progress, so a large sheet is imported
 * over several syncs instead of being cut off by the platform's time limit with nothing recorded.
 */
export async function syncSheetImport(sourceId: unknown, ctx: Ctx | null, opts: { deadline?: number } = {}): Promise<SyncResult> {
  const src = await findSheetSource(sourceId);
  const deadline = opts.deadline ?? Date.now() + MANUAL_SYNC_BUDGET_MS;
  const res = await withLock(await sourcesCol(), src._id, () => syncLocked(src, deadline));
  if (ctx) await auditLog(ctx, 'Google Sheet Synced', 'Settings', src._id, `${src.name}: ${res.message}`);
  return res;
}

async function syncLocked(src: SourceDoc, deadline: number): Promise<SyncResult> {
  const cfg: SheetImportConfig = { ...defaultSheetImportConfig(), ...src.config.sheet! };
  const id = cfg.spreadsheetId;
  const access = sheetAccessFor(cfg.auth);
  const col_ = await sourcesCol();
  const save = async (set: Partial<SheetImportConfig>, extra: Record<string, unknown> = {}) => {
    const $set: Record<string, unknown> = { ...extra };
    for (const [k, v] of Object.entries(set)) $set['config.sheet.' + k] = v;
    // only if the source still points at the same sheet (it may have been re-linked meanwhile)
    await col_.updateOne({ _id: src._id, 'config.sheet.spreadsheetId': id }, { $set });
  };

  try {
    const info = await getSpreadsheet(access, id);
    const tab = cfg.tab || info.tabs[0]?.title || '';
    if (!info.tabs.some((t) => t.title === tab)) throw fail('VALIDATION', `Tab "${tab}" was not found in "${info.title}"`);
    const hr = cfg.headerRow || 1;
    const headerCells = (await readValues(access, id, a1(tab, `A${hr}:ZZ${hr}`)))[0] || [];
    if (!headerCells.some((h) => String(h).trim())) throw fail('VALIDATION', `Row ${hr} of "${tab}" is empty — it must hold the column headers`);
    const statusIdx = cfg.statusColumn ? findStatusIndex(headerCells, cfg.statusColumn) : -1;
    if (cfg.statusColumn && statusIdx < 0) throw fail('VALIDATION', `Status column "${cfg.statusColumn}" was not found in header row ${hr}`);

    // data rows: with a status column the whole tab below the header; without, the rows after lastRow
    const start = statusIdx >= 0 ? hr + 1 : Math.max(cfg.lastRow || 0, hr) + 1;
    const end = statusIdx >= 0 ? '' : String(start + MAX_ROWS_PER_RUN - 1);
    const data = await readValues(access, id, a1(tab, `A${start}:ZZ${end}`));
    const width = Math.max(headerCells.length, ...data.map((r) => r.length), 0);
    const names = columnNames(headerCells, width);

    const candidates: Array<{ rowNumber: number; fields: Record<string, string>; values: string[] }> = [];
    let more = false;
    for (let i = 0; i < data.length; i++) {
      const row = data[i] || [];
      const values = names.map((_, c) => (c === statusIdx ? '' : String(row[c] ?? '').trim()));
      if (!values.some(Boolean)) continue; // fully empty row
      if (statusIdx >= 0 && String(row[statusIdx] ?? '').trim()) continue; // already handled
      if (candidates.length >= MAX_ROWS_PER_RUN) {
        more = true;
        break;
      }
      const fields: Record<string, string> = {};
      names.forEach((n, c) => {
        if (c !== statusIdx && values[c]) fields[n] = values[c];
      });
      candidates.push({ rowNumber: start + i, fields, values });
    }
    if (statusIdx < 0 && data.length >= MAX_ROWS_PER_RUN) more = true;

    const source: SourceDoc = { ...src, config: { ...src.config, sheet: cfg } };
    const tally = { created: 0, duplicates: 0, rejected: 0, failed: 0, replayed: 0 };
    const statuses: Array<{ range: string; values: string[][] }> = [];
    const when = fmtHuman(new Date());
    /** Rows actually handled this run (the rest wait for the next sync). */
    let processed = 0;
    for (const c of candidates) {
      if (Date.now() > deadline) break;
      processed++;
      const key = `row:${id}:${tab}:${c.rowNumber}:${sha256Hex(JSON.stringify(c.values)).slice(0, 16)}`;
      const r = await ingestLead(source, c.fields, { ip: '', origin: 'google-sheets', idempotencyKey: key });
      if (r.replay) tally.replayed++;
      else if (r.status === 'created') tally.created++;
      else if (r.status === 'duplicate') tally.duplicates++;
      else if (r.status === 'rejected') tally.rejected++;
      else tally.failed++;
      if (statusIdx >= 0) statuses.push({ range: a1(tab, `${colLetter(statusIdx)}${c.rowNumber}`), values: [[statusText(r, when)]] });
    }

    let note = '';
    if (statuses.length) {
      try {
        await batchUpdateValues(access, id, statuses);
      } catch (e: any) {
        const status = (e as any)?.httpStatus;
        note = status === 403
          ? `Statuses were not written to the sheet — give ${access.mode === 'oauth' ? 'the connected Google account' : 'the service account'} Editor access`
          : `Statuses were not written to the sheet: ${errMsg(e)}`;
      }
    }

    const parts = [
      tally.created ? `${tally.created} new` : '',
      tally.duplicates ? plural(tally.duplicates, 'duplicate') : '',
      tally.rejected ? `${tally.rejected} rejected` : '',
      tally.failed ? `${tally.failed} failed` : '',
      tally.replayed ? `${tally.replayed} already imported` : '',
    ].filter(Boolean);
    const waiting = candidates.length - processed;
    let message = parts.length ? parts.join(', ') : 'No new rows';
    if (waiting > 0) message += ` — ${plural(waiting, 'row')}${more ? ' or more' : ''} still waiting, the next sync continues`;
    else if (more) message += ` (more than ${MAX_ROWS_PER_RUN} rows waiting — the next sync continues)`;
    if (note) message += `. ${note}`;

    // Without a status column progress is the last row handled (never one the deadline skipped).
    const lastRow = statusIdx < 0 && processed ? candidates[processed - 1].rowNumber : cfg.lastRow;
    await save({ lastRow, lastSyncAt: new Date().toISOString(), lastSyncResult: truncate(message, 500) });
    return { created: tally.created, duplicates: tally.duplicates, rejected: tally.rejected, failed: tally.failed, message };
  } catch (e: any) {
    const msg = errMsg(e);
    if (!(e instanceof ApiError)) await logError('sheets:import:' + src._id, 'INTERNAL', e?.message, e?.stack, src.name);
    await save({ lastSyncAt: new Date().toISOString(), lastSyncResult: truncate('Error: ' + msg, 500) }, { 'stats.lastError': truncate('sync: ' + msg, 300) });
    throw e;
  }
}

/* ---------------------------------- export ------------------------------- */

function mergeColumns(base: SheetExportColumns, patch: unknown): SheetExportColumns {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) throw fail('VALIDATION', 'columns must be an object');
  const p = patch as Partial<SheetExportColumns>;
  const out: SheetExportColumns = { ...base, headers: [...base.headers] };
  if (p.headers !== undefined) {
    if (!Array.isArray(p.headers)) throw fail('VALIDATION', 'columns.headers must be a list of lead fields');
    const list = [...new Set(p.headers.map((h) => String(h ?? '').trim()).filter(Boolean))];
    if (!list.length) throw fail('VALIDATION', 'Choose at least one column to export');
    const unknown = list.filter((h) => !CFG.LEAD_BASE_HEADERS.includes(h));
    if (unknown.length) throw fail('VALIDATION', `Not lead fields: ${truncate(unknown.join(', '), 120)}`);
    out.headers = list;
  }
  if (p.includeFollowups !== undefined) out.includeFollowups = !!p.includeFollowups;
  if (p.includeTrash !== undefined) out.includeTrash = !!p.includeTrash;
  return out;
}

function validExportName(v: unknown): string {
  const n = String(v ?? '').trim();
  if (!n || n.length > 80) throw fail('VALIDATION', 'Export name must be 1–80 characters');
  return n;
}

function validInterval(v: unknown, fallback: SyncInterval): SyncInterval {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!INTERVALS.includes(n as SyncInterval)) throw fail('VALIDATION', 'intervalMinutes must be 0 (manual), 5, 15 or 60');
  return n as SyncInterval;
}

async function findExport(id: unknown): Promise<SheetExportDoc> {
  const d = await (await exportsCol()).findOne({ _id: String(id || '') });
  if (!d) throw fail('NOT_FOUND', 'Sheet export not found');
  return d;
}

/** The tab an import source of this spreadsheet reads ('' = first tab). */
async function importTabs(spreadsheetId: string, firstTab: string): Promise<string[]> {
  const rows = await (await sourcesCol()).find({ type: 'google_sheet', 'config.sheet.spreadsheetId': spreadsheetId }, { projection: { 'config.sheet.tab': 1 } }).toArray();
  return rows.map((r) => r.config?.sheet?.tab || firstTab);
}

/** Make sure the export tab exists (creates it with a bold, frozen header row). Needs Editor access. */
async function ensureExportTab(access: SheetAccess, spreadsheetId: string, tab: string, excludeExportId = '') {
  const info = await getSpreadsheet(access, spreadsheetId);
  if ((await importTabs(spreadsheetId, info.tabs[0]?.title || '')).includes(tab)) throw fail('VALIDATION', `Tab "${tab}" is imported by a Google Sheet lead source — export to another tab`);
  const other = await (await exportsCol()).findOne({ spreadsheetId, tab, _id: { $ne: excludeExportId } });
  if (other) throw fail('VALIDATION', `The export "${other.name}" already writes to tab "${tab}"`);
  if (info.tabs.some((t) => t.title === tab)) return;
  const sheetId = await addSheet(access, spreadsheetId, tab);
  try {
    await formatHeaderRow(access, spreadsheetId, sheetId);
  } catch {
    /* cosmetic */
  }
}

export async function listSheetExports(): Promise<Res<'listSheetExports'>> {
  return (await (await exportsCol()).find({}).sort({ _id: 1 }).toArray()).map(toExport);
}

export async function createSheetExport(d: Req<'createSheetExport'>, ctx: Ctx | null): Promise<Res<'createSheetExport'>> {
  requireTenant();
  const name = validExportName(d?.name);
  const url = String(d?.spreadsheetUrl ?? '').trim();
  if (url.length > 500) throw fail('VALIDATION', 'The sheet link is too long');
  const spreadsheetId = parseSpreadsheetId(url);
  const tab = validTabName(d?.tab) || DEFAULT_EXPORT_TAB;
  const columns = mergeColumns({ headers: [...DEFAULT_EXPORT_HEADERS], includeFollowups: false, includeTrash: false }, d?.columns);
  const intervalMinutes = validInterval(d?.intervalMinutes, 15);
  const auth = await validateSheetAuth(d?.auth);
  await assertNotClaimedByOther(spreadsheetId);
  await ensureExportTab(sheetAccessFor(auth), spreadsheetId, tab);
  await claimSheet(spreadsheetId);
  const now = new Date();
  const doc: SheetExportDoc = {
    _id: await nextSeq('SHX', 4), auth, name, spreadsheetUrl: url, spreadsheetId, tab, columns, intervalMinutes, status: 'Active',
    lastSyncAt: null, lastRows: 0, lastError: '', lastVersion: '', createdAt: now, createdBy: actorName(ctx), updatedAt: now,
  };
  try {
    await (await exportsCol()).insertOne(doc);
  } catch (e) {
    await releaseSheetIfUnused(spreadsheetId);
    throw e;
  }
  await auditLog(ctx, 'Sheet Export Created', 'Settings', doc._id, `${name} → ${spreadsheetId} / ${tab}`);
  return toExport(doc);
}

export async function updateSheetExport(d: Req<'updateSheetExport'>, ctx: Ctx | null): Promise<Res<'updateSheetExport'>> {
  const cur = await findExport(d?.id);
  const p = d?.patch && typeof d.patch === 'object' ? d.patch : {};
  const set: Partial<SheetExportDoc> = {};
  if (p.name !== undefined) set.name = validExportName(p.name);
  if (p.status !== undefined) {
    if (p.status !== 'Active' && p.status !== 'Paused') throw fail('VALIDATION', 'status must be Active or Paused');
    set.status = p.status;
  }
  if (p.intervalMinutes !== undefined) set.intervalMinutes = validInterval(p.intervalMinutes, cur.intervalMinutes);
  if (p.columns !== undefined) set.columns = mergeColumns(toExport(cur).columns, p.columns);
  // "Access via": same validation as create; the sheet must be reachable (and the tab writable) with the new access
  let access = sheetAccessFor(cur.auth);
  let authChanged = false;
  if (p.auth !== undefined) {
    const auth = await validateSheetAuth(p.auth);
    if (JSON.stringify(auth) !== JSON.stringify(normAuth(cur.auth))) {
      access = sheetAccessFor(auth);
      set.auth = auth;
      authChanged = true;
    }
  }
  let tabChecked = false;
  if (p.tab !== undefined) {
    const tab = validTabName(p.tab) || DEFAULT_EXPORT_TAB;
    if (tab !== cur.tab) {
      await ensureExportTab(access, cur.spreadsheetId, tab, cur._id);
      set.tab = tab;
      tabChecked = true;
    }
  }
  if (authChanged && !tabChecked) await ensureExportTab(access, cur.spreadsheetId, cur.tab, cur._id);
  const changed = Object.keys(set).filter((k) => k === 'auth' || JSON.stringify((set as any)[k]) !== JSON.stringify((cur as any)[k]));
  if (!changed.length) return toExport(cur);
  // a different tab, column set or account must be written even if the leads did not change
  if (changed.includes('tab') || changed.includes('columns') || changed.includes('auth')) set.lastVersion = '';
  set.updatedAt = new Date();
  await (await exportsCol()).updateOne({ _id: cur._id }, { $set: set });
  await auditLog(ctx, 'Sheet Export Updated', 'Settings', cur._id, `${cur.name}: ${changed.join(', ')}`);
  return toExport(await findExport(cur._id));
}

export async function deleteSheetExport(d: Req<'deleteSheetExport'>, ctx: Ctx | null): Promise<Res<'deleteSheetExport'>> {
  const cur = await findExport(d?.id);
  await (await exportsCol()).deleteOne({ _id: cur._id });
  await releaseSheetIfUnused(cur.spreadsheetId);
  await auditLog(ctx, 'Sheet Export Deleted', 'Settings', cur._id, `${cur.name} (${cur.spreadsheetId} / ${cur.tab})`);
  return { ok: true };
}

/** One sheet cell for a lead header (dates 'dd MMM yyyy, hh:mm AM' in the CRM zone). */
function cellFor(lead: Record<string, string>, header: string): string {
  let v: string;
  if (header === FOLLOWUPS_HEADER) {
    v = Object.keys(lead)
      .map((k) => [k, Number(k.match(/^Follow-up (\d+)$/)?.[1] || 0)] as const)
      .filter(([k, n]) => n > 0 && String(lead[k] || '').trim())
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => String(lead[k]).trim())
      .join('\n');
  } else if (CFG.LEAD_DATE_FIELDS.includes(header)) v = fmtHuman(lead[header]) || String(lead[header] || '');
  else v = String(lead[header] ?? '');
  return truncate(v, MAX_CELL);
}

/** Rewrite the export tab with the current leads (manual: ctx = the user; cron: null). */
export async function runSheetExport(d: Req<'runSheetExport'>, ctx: Ctx | null): Promise<Res<'runSheetExport'>> {
  const cur = await findExport(d?.id);
  const c = await exportsCol();
  const access = sheetAccessFor(cur.auth);
  await withLock(c, cur._id, async () => {
    try {
      const version = await getVersion(); // read first: a write during the export triggers the next one
      const cols = toExport(cur).columns;
      const headers = [...cols.headers, ...(cols.includeFollowups ? [FOLLOWUPS_HEADER] : [])];
      const { leads } = await getAllLeads(null); // export is an admin feature: every lead
      const rows = leads
        .filter((l) => l[L.STAGE] !== CFG.STAGES.DELETED && (cols.includeTrash || l[L.STAGE] !== CFG.STAGES.TRASH))
        .map((l) => headers.map((h) => cellFor(l, h)));
      await ensureExportTab(access, cur.spreadsheetId, cur.tab, cur._id);
      await clearValues(access, cur.spreadsheetId, a1(cur.tab));
      const values = [headers, ...rows];
      for (let i = 0; i < values.length; i += WRITE_CHUNK) {
        await updateValues(access, cur.spreadsheetId, a1(cur.tab, `A${i + 1}`), values.slice(i, i + WRITE_CHUNK), 'RAW');
      }
      await c.updateOne({ _id: cur._id }, { $set: { lastSyncAt: new Date(), lastRows: rows.length, lastError: '', lastVersion: version } });
    } catch (e: any) {
      if (!(e instanceof ApiError)) await logError('sheets:export:' + cur._id, 'INTERNAL', e?.message, e?.stack, cur.name);
      await c.updateOne({ _id: cur._id }, { $set: { lastSyncAt: new Date(), lastError: truncate(errMsg(e), 500) } });
      throw e;
    }
  });
  const after = await findExport(cur._id);
  if (ctx) await auditLog(ctx, 'Sheet Export Run', 'Settings', cur._id, `${cur.name}: ${after.lastRows} rows`);
  return toExport(after);
}

/* ----------------------------------- cron -------------------------------- */

export interface DueJobsResult {
  imports: Array<{ id: string; result?: string; error?: string; skipped?: string }>;
  exports: Array<{ id: string; rows?: number; error?: string; skipped?: string }>;
}

/** Interval elapsed (1 minute of slack so a 5-minute cron does not drift past a 5-minute interval). */
const due = (last: string | Date | null | undefined, minutes: number, now: number) => {
  const t = last ? new Date(last).getTime() : 0;
  return !t || now - t >= minutes * 60000 - 60000;
};

/** Run the current company's due imports and exports; errors are isolated per link. */
export async function runDueSheetJobs(opts: { deadline?: number } = {}): Promise<DueJobsResult> {
  const now = Date.now();
  const out: DueJobsResult = { imports: [], exports: [] };
  const late = () => !!opts.deadline && Date.now() > opts.deadline;

  const sources = await (await sourcesCol()).find({ type: 'google_sheet', status: 'Active', 'config.sheet.intervalMinutes': { $gt: 0 } }).sort({ _id: 1 }).toArray();
  for (const s of sources) {
    const sh = s.config.sheet!;
    if (!due(sh.lastSyncAt, sh.intervalMinutes, now)) continue;
    if (late()) {
      out.imports.push({ id: s._id, skipped: 'time budget exhausted' });
      continue;
    }
    try {
      out.imports.push({ id: s._id, result: (await syncSheetImport(s._id, null, { deadline: opts.deadline })).message });
    } catch (e: any) {
      out.imports.push({ id: s._id, error: errMsg(e) });
    }
  }

  const version = await getVersion();
  const exports = await (await exportsCol()).find({ status: 'Active', intervalMinutes: { $gt: 0 } }).sort({ _id: 1 }).toArray();
  for (const x of exports) {
    if (!due(x.lastSyncAt, x.intervalMinutes, now)) continue;
    if (x.lastVersion && x.lastVersion === version) {
      out.exports.push({ id: x._id, skipped: 'unchanged' });
      continue;
    }
    if (late()) {
      out.exports.push({ id: x._id, skipped: 'time budget exhausted' });
      continue;
    }
    try {
      out.exports.push({ id: x._id, rows: (await runSheetExport({ id: x._id }, null)).lastRows });
    } catch (e: any) {
      out.exports.push({ id: x._id, error: errMsg(e) });
    }
  }
  return out;
}

/* --------------------------- Google connections -------------------------- */

/** Imports and exports of the current company that use a connection. */
async function connectionUsage(connectionId: string) {
  const [imports, exports] = await Promise.all([
    (await sourcesCol()).find({ type: 'google_sheet', 'config.sheet.auth.mode': 'oauth', 'config.sheet.auth.connectionId': connectionId }, { projection: { name: 1, status: 1 } }).toArray(),
    (await exportsCol()).find({ 'auth.mode': 'oauth', 'auth.connectionId': connectionId }, { projection: { name: 1, status: 1 } }).toArray(),
  ]);
  return { imports, exports };
}

export async function listGoogleConnections(): Promise<GoogleConnection[]> {
  const docs = await (await googleConnectionsCol()).find({}).sort({ _id: 1 }).toArray();
  return Promise.all(docs.map(async (d) => {
    const u = await connectionUsage(d._id);
    return toConnection(d, u.imports.length + u.exports.length);
  }));
}

/**
 * Remove a Google connection. While imports/exports use it: CONFLICT (details list them) unless force, which pauses
 * them first. The refresh token is revoked at Google (best effort) and the connection deleted.
 */
export async function disconnectGoogleConnection(d: Req<'disconnectGoogleConnection'>, ctx: Ctx | null): Promise<Res<'disconnectGoogleConnection'>> {
  const c = await googleConnectionsCol();
  const cur = await c.findOne({ _id: String(d?.id || '') });
  if (!cur) throw fail('NOT_FOUND', 'Google connection not found');
  const u = await connectionUsage(cur._id);
  const names = [...u.imports.map((s) => `import "${s.name}"`), ...u.exports.map((x) => `export "${x.name}"`)];
  if (names.length && !d?.force) {
    throw new ApiError('CONFLICT', truncate(`The Google account ${cur.email} is used by ${plural(names.length, 'sheet link')} (${names.join(', ')}). Switch them to another account, or disconnect anyway to pause them.`, 500), {
      imports: u.imports.map((s) => ({ id: s._id, name: s.name })),
      exports: u.exports.map((x) => ({ id: x._id, name: x.name })),
    });
  }
  const pausedNote = 'Paused: the Google account was disconnected — choose another account and resume';
  if (u.imports.length) {
    await (await sourcesCol()).updateMany({ _id: { $in: u.imports.map((s) => s._id) } }, { $set: { status: 'Paused', 'config.sheet.lastSyncResult': pausedNote } });
  }
  if (u.exports.length) {
    await (await exportsCol()).updateMany({ _id: { $in: u.exports.map((x) => x._id) } }, { $set: { status: 'Paused', lastError: pausedNote, updatedAt: new Date() } });
  }
  const revoked = await revokeGoogleToken(decryptSecret(cur.refreshToken || ''));
  await c.deleteOne({ _id: cur._id });
  resetGoogleOAuthTokenCache();
  await auditLog(ctx, 'Google Account Disconnected', 'Settings', cur._id, `${cur.email}${names.length ? `; paused ${names.join(', ')}` : ''}${revoked ? '' : ' (token not revoked at Google)'}`);
  return { ok: true };
}

/* --------------------------------- actions ------------------------------- */

export const actions: ActionMap = {
  googleStatus: { fn: () => googleStatus(), perm: 'settings.view' },
  checkSheet: { fn: (d) => checkSheet(d), perm: 'settings.edit' },
  listGoogleConnections: { fn: () => listGoogleConnections(), perm: 'settings.view' },
  disconnectGoogleConnection: { fn: (d, ctx) => disconnectGoogleConnection(d, ctx), perm: 'settings.edit' },
  syncSheetImport: { fn: (d, ctx) => syncSheetImport(d?.sourceId, ctx), perm: 'settings.edit' },
  listSheetExports: { fn: () => listSheetExports(), perm: 'settings.view' },
  createSheetExport: { fn: (d, ctx) => createSheetExport(d, ctx), perm: 'settings.edit' },
  updateSheetExport: { fn: (d, ctx) => updateSheetExport(d, ctx), perm: 'settings.edit' },
  deleteSheetExport: { fn: (d, ctx) => deleteSheetExport(d, ctx), perm: 'settings.edit' },
  runSheetExport: { fn: (d, ctx) => runSheetExport(d, ctx), perm: 'settings.edit' },
};
