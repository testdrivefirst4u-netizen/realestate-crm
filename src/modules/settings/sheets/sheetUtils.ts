/**
 * Google Sheets — pure helpers for the settings screens (no React; unit-tested in tests/sheets-ui.test.ts).
 * Contract: server/core/sheetTypes.ts.
 */
import type { GoogleConnection, GoogleStatus, SheetAuth, SheetExport, SheetExportColumns, SheetImportConfig, SyncInterval } from '../../../../server/core/sheetTypes';
import { LEAD_BASE_HEADERS } from '../../../core/config';

/* ------------------------------ Intervals -------------------------------- */

export const INTERVAL_OPTIONS: Array<{ value: SyncInterval; label: string }> = [
  { value: 5, label: 'Every 5 minutes' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Hourly' },
  { value: 0, label: 'Manual only' },
];

/** <Select> options (values are strings). */
export const INTERVAL_SELECT_OPTIONS = INTERVAL_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));

export function toSyncInterval(v: unknown, fallback: SyncInterval = 15): SyncInterval {
  const n = Number(v);
  return n === 5 || n === 15 || n === 60 || n === 0 ? n : fallback;
}

export function intervalLabel(v: number | null | undefined): string {
  return INTERVAL_OPTIONS.find((o) => o.value === v)?.label || 'Manual only';
}

/* --------------------------- Spreadsheet URL ----------------------------- */

export interface SpreadsheetUrlCheck {
  ok: boolean;
  /** Spreadsheet id parsed from the URL ('' when not valid). */
  id: string;
  error: string;
}

const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

/**
 * Client-side check of a pasted Google Sheets link (the server parses it again).
 * Accepts `https://docs.google.com/spreadsheets/d/<id>/edit…` or a bare spreadsheet id.
 */
export function checkSpreadsheetUrl(input: string): SpreadsheetUrlCheck {
  const fail = (error: string): SpreadsheetUrlCheck => ({ ok: false, id: '', error });
  const raw = String(input || '').trim();
  if (!raw) return fail('Paste the link of the Google Sheet.');
  if (ID_RE.test(raw)) return { ok: true, id: raw, error: '' };
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return fail('Not a valid link — copy it from the browser’s address bar while the sheet is open.');
  }
  if (u.hostname.toLowerCase() !== 'docs.google.com') return fail('Use a Google Sheets link (https://docs.google.com/spreadsheets/d/…).');
  if (/\/spreadsheets\/d\/e\//.test(u.pathname)) return fail('This is a “Publish to web” link — use the normal link from the address bar instead.');
  const m = u.pathname.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/);
  if (!m) return fail('This doesn’t look like a Google Sheets link (https://docs.google.com/spreadsheets/d/…).');
  if (!ID_RE.test(m[1])) return fail('The spreadsheet id in this link looks incomplete.');
  return { ok: true, id: m[1], error: '' };
}

/** Link to open a spreadsheet (falls back to the stored URL). */
export function spreadsheetHref(url: string, id?: string): string {
  const sid = id || checkSpreadsheetUrl(url).id;
  return sid ? `https://docs.google.com/spreadsheets/d/${sid}/edit` : '';
}

/* ------------------------------- Access ---------------------------------- */

export const SERVICE_ACCOUNT_AUTH: SheetAuth = { mode: 'service_account' };

/** Can the company reach sheets at all (service account or "Connect with Google")? */
export const sheetsAccessConfigured = (g: Pick<GoogleStatus, 'configured' | 'oauthConfigured'> | null | undefined) => !!(g && (g.configured || g.oauthConfigured));

/** Missing auth = service account (backward compatible). */
export const normalizeAuth = (a: SheetAuth | null | undefined): SheetAuth =>
  a && a.mode === 'oauth' && a.connectionId ? { mode: 'oauth', connectionId: a.connectionId } : { mode: 'service_account' };

/** <select> value of an auth ('service_account' or 'oauth:<connectionId>'). */
export const authValue = (a: SheetAuth | null | undefined): string => {
  const n = normalizeAuth(a);
  return n.mode === 'oauth' ? `oauth:${n.connectionId}` : 'service_account';
};

export const sameAuth = (a: SheetAuth | null | undefined, b: SheetAuth | null | undefined) => authValue(a) === authValue(b);

export interface AccessOption {
  value: string;
  label: string;
  auth: SheetAuth;
  /** The address that must be able to open the sheet. */
  email: string;
  /** Not selectable for new links (a connection in Error, or a service account that is no longer set up). */
  unavailable: boolean;
}

/**
 * "Access via" choices: every Active Google connection, then the platform service account when configured.
 * `current` (an existing import/export's auth) is always listed so editing keeps it, even when it is no longer usable.
 */
export function accessOptions(
  google: Pick<GoogleStatus, 'configured' | 'serviceAccountEmail' | 'oauthConfigured'> | null | undefined,
  connections: GoogleConnection[] | null | undefined,
  current?: SheetAuth | null
): AccessOption[] {
  const out: AccessOption[] = [];
  const cur = current ? normalizeAuth(current) : null;
  (connections || []).forEach((c) => {
    const isCurrent = cur?.mode === 'oauth' && cur.connectionId === c.id;
    if (c.status !== 'Active' && !isCurrent) return;
    out.push({
      value: `oauth:${c.id}`,
      label: `Google account: ${c.email}${c.status !== 'Active' ? ' (needs reconnecting)' : ''}`,
      auth: { mode: 'oauth', connectionId: c.id },
      email: c.email,
      unavailable: c.status !== 'Active',
    });
  });
  if (cur?.mode === 'oauth' && !out.some((o) => o.value === authValue(cur))) {
    out.push({ value: authValue(cur), label: `Google account (disconnected — ${cur.connectionId})`, auth: cur, email: '', unavailable: true });
  }
  const saEmail = google?.configured ? google.serviceAccountEmail || '' : '';
  if (google?.configured || cur?.mode === 'service_account') {
    out.push({
      value: 'service_account',
      label: google?.configured ? `Platform service account (share with ${saEmail})` : 'Platform service account (no longer set up)',
      auth: SERVICE_ACCOUNT_AUTH,
      email: saEmail,
      unavailable: !google?.configured,
    });
  }
  return out;
}

/** Default for a new import/export: the first Active connection, else the service account, else null (nothing set up). */
export function defaultAuth(options: AccessOption[]): SheetAuth | null {
  const usable = options.filter((o) => !o.unavailable);
  return (usable.find((o) => o.auth.mode === 'oauth') || usable.find((o) => o.auth.mode === 'service_account'))?.auth || null;
}

export const optionForAuth = (options: AccessOption[], a: SheetAuth | null | undefined): AccessOption | null =>
  a ? options.find((o) => o.value === authValue(a)) || null : null;

/** Short label of how a sheet is reached (import cards, export rows). */
export function authLabel(a: SheetAuth | null | undefined, connections?: GoogleConnection[] | null): string {
  const n = normalizeAuth(a);
  if (n.mode === 'service_account') return 'Service account';
  const c = (connections || []).find((x) => x.id === n.connectionId);
  return c ? `Google account: ${c.email}` : 'Google account';
}

/** "Disconnect" refused because imports/exports still use the connection. */
export function isConnectionInUse(err: { code?: string } | null | undefined): boolean {
  return err?.code === 'CONFLICT';
}

/** Explain a `googleError` from the Google callback in plain words. */
export function googleErrorText(raw: string | null | undefined): string {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/cancel|access_denied|denied|declined/i.test(t)) return 'Google sign-in was cancelled, so no account was connected.';
  if (/state|session|csrf|expired/i.test(t)) return 'The Google sign-in could not be matched to your CRM session (it may have taken too long). Please try again.';
  return t;
}

/* ------------------------------- Import ---------------------------------- */

/** Editable part of an import's sheet settings (the rest is filled by the server). */
export interface SheetImportFormState {
  spreadsheetUrl: string;
  tab: string;
  headerRow: number;
  statusColumn: string;
  intervalMinutes: SyncInterval;
  /** How the sheet is reached; unset on a new form until the access options are known. */
  auth?: SheetAuth | null;
}

export const emptySheetImportForm = (): SheetImportFormState => ({ spreadsheetUrl: '', tab: '', headerRow: 1, statusColumn: '', intervalMinutes: 15 });

export function sheetImportFormFrom(c: Partial<SheetImportConfig> | null | undefined): SheetImportFormState {
  return {
    spreadsheetUrl: c?.spreadsheetUrl || '',
    tab: c?.tab || '',
    headerRow: Math.max(1, Math.floor(Number(c?.headerRow) || 1)),
    statusColumn: c?.statusColumn || '',
    intervalMinutes: toSyncInterval(c?.intervalMinutes, 15),
    // A saved import without auth uses the service account.
    ...(c?.spreadsheetUrl ? { auth: normalizeAuth(c.auth) } : {}),
  };
}

/**
 * Validate the sheet part of an import source; `sheet` carries only the fields the user edits —
 * the server keeps its own fields (spreadsheetId, lastRow, lastSyncAt, lastSyncResult).
 */
export function sheetImportToRequest(f: SheetImportFormState): { sheet: SheetImportConfig; errors: string[] } {
  const errors: string[] = [];
  const url = checkSpreadsheetUrl(f.spreadsheetUrl);
  if (!url.ok) errors.push(url.error);
  const headerRow = Math.floor(Number(f.headerRow));
  if (!Number.isFinite(headerRow) || headerRow < 1 || headerRow > 1000) errors.push('The header row must be a number from 1 to 1000.');
  const sheet = {
    spreadsheetUrl: String(f.spreadsheetUrl || '').trim(),
    tab: String(f.tab || '').trim(),
    headerRow: Number.isFinite(headerRow) && headerRow >= 1 ? headerRow : 1,
    statusColumn: String(f.statusColumn || '').trim(),
    intervalMinutes: toSyncInterval(f.intervalMinutes, 15),
    ...(f.auth ? { auth: normalizeAuth(f.auth) } : {}),
  } as SheetImportConfig;
  return { sheet, errors };
}

/** Toast text for a "Sync now" result. */
export function syncResultText(r: { created: number; duplicates: number; rejected: number; failed: number; message?: string }): string {
  const parts: string[] = [];
  const n = (v: number) => Number(v || 0);
  parts.push(`${n(r.created)} new`);
  if (n(r.duplicates)) parts.push(`${n(r.duplicates)} duplicate${n(r.duplicates) === 1 ? '' : 's'}`);
  if (n(r.rejected)) parts.push(`${n(r.rejected)} rejected`);
  if (n(r.failed)) parts.push(`${n(r.failed)} failed`);
  const counts = parts.join(', ');
  const msg = String(r.message || '').trim();
  return msg && msg !== counts ? `${counts} · ${msg}` : counts;
}

/* ------------------------------- Export ---------------------------------- */

export const DEFAULT_EXPORT_TAB = 'CRM Leads';

export const DEFAULT_EXPORT_HEADERS: string[] = [
  'Enquiry ID',
  'Enquiry Date',
  'Prospect Name',
  'Phone Number',
  'Email',
  'Lead Stage',
  'Enquiry Source',
  'Unit Type Interested In',
  'Site Visit Status',
  'Next Follow-up Date',
  'Assigned RM',
  'Enquiry Notes',
  'Last Follow-up Date & Time',
];

/** Lead headers that can be exported: the defaults first, then the other base headers, then any extra. */
export function exportableHeaders(extra: string[] = []): string[] {
  const out: string[] = [];
  const add = (h: string) => {
    const v = String(h || '').trim();
    if (v && !out.includes(v) && !/^Follow-up \d+$/.test(v)) out.push(v);
  };
  DEFAULT_EXPORT_HEADERS.forEach(add);
  LEAD_BASE_HEADERS.forEach(add);
  extra.forEach(add);
  return out;
}

/** Rows for the column picker: chosen columns in their order, then the rest in the default order. */
export function columnRows(selected: string[], available: string[]): Array<{ header: string; checked: boolean; index: number }> {
  const chosen = selected.filter((h, i) => h && selected.indexOf(h) === i);
  return [
    ...chosen.map((header, index) => ({ header, checked: true, index })),
    ...available.filter((h) => !chosen.includes(h)).map((header) => ({ header, checked: false, index: -1 })),
  ];
}

export function toggleHeader(selected: string[], header: string): string[] {
  return selected.includes(header) ? selected.filter((h) => h !== header) : [...selected, header];
}

export function moveHeader(selected: string[], index: number, dir: -1 | 1): string[] {
  const j = index + dir;
  if (index < 0 || index >= selected.length || j < 0 || j >= selected.length) return selected;
  const next = [...selected];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

export interface ExportFormState {
  name: string;
  spreadsheetUrl: string;
  tab: string;
  headers: string[];
  includeFollowups: boolean;
  includeTrash: boolean;
  intervalMinutes: SyncInterval;
  /** How the sheet is reached; unset on a new form until the access options are known. */
  auth?: SheetAuth | null;
}

export const emptyExportForm = (): ExportFormState => ({
  name: '',
  spreadsheetUrl: '',
  tab: DEFAULT_EXPORT_TAB,
  headers: [...DEFAULT_EXPORT_HEADERS],
  includeFollowups: false,
  includeTrash: false,
  intervalMinutes: 15,
});

export function exportFormFrom(x: SheetExport): ExportFormState {
  return {
    name: x.name || '',
    spreadsheetUrl: x.spreadsheetUrl || '',
    tab: x.tab || DEFAULT_EXPORT_TAB,
    headers: x.columns?.headers?.length ? [...x.columns.headers] : [...DEFAULT_EXPORT_HEADERS],
    includeFollowups: !!x.columns?.includeFollowups,
    includeTrash: !!x.columns?.includeTrash,
    intervalMinutes: toSyncInterval(x.intervalMinutes, 15),
    auth: normalizeAuth(x.auth),
  };
}

export interface ExportRequest {
  name: string;
  spreadsheetUrl: string;
  tab: string;
  columns: SheetExportColumns;
  intervalMinutes: SyncInterval;
  auth?: SheetAuth;
}

/** Validate the export dialog; `errors` is empty when it can be saved. */
export function exportFormToRequest(f: ExportFormState): { req: ExportRequest; errors: string[] } {
  const errors: string[] = [];
  const name = String(f.name || '').trim();
  if (!name) errors.push('Give the export a name.');
  const url = checkSpreadsheetUrl(f.spreadsheetUrl);
  if (!url.ok) errors.push(url.error);
  const tab = String(f.tab || '').trim() || DEFAULT_EXPORT_TAB;
  if (/[\[\]*?:\\/]/.test(tab)) errors.push('The tab name cannot contain [ ] * ? : \\ or /.');
  if (tab.length > 100) errors.push('The tab name is too long (100 characters at most).');
  const headers = f.headers.map((h) => String(h || '').trim()).filter((h, i, a) => h && a.indexOf(h) === i);
  if (!headers.length) errors.push('Choose at least one column.');
  return {
    req: {
      name,
      spreadsheetUrl: String(f.spreadsheetUrl || '').trim(),
      tab,
      columns: { headers, includeFollowups: !!f.includeFollowups, includeTrash: !!f.includeTrash },
      intervalMinutes: toSyncInterval(f.intervalMinutes, 15),
      ...(f.auth ? { auth: normalizeAuth(f.auth) } : {}),
    },
    errors,
  };
}
