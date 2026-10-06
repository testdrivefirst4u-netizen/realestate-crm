/**
 * Minimal Google Sheets v4 REST client on top of server/integrations/google.ts.
 *
 * - Ranges are A1 strings with a quoted tab name: a1('My Tab', 'A1:Z') → 'My Tab'!A1:Z ('' tab = first tab).
 * - Writes always use valueInputOption RAW, so customer text such as "=HYPERLINK(...)" is stored as text and
 *   never executed as a formula (the only exception is the no-op write-back in probeWrite, see there).
 * - Google 403/404 answers become friendly messages naming the Google account used (service-account e-mail, or
 *   the e-mail of the company's "Connect with Google" connection).
 * - Every call takes a SheetAccess (token provider) resolved in the company context from the import/export's
 *   SheetAuth (server/modules/googleConnect.ts → sheetAccessFor); this module never chooses credentials itself.
 */
import { fail } from '../core/errors';
import { truncate } from '../core/utils';
import { googleJson, GoogleApiError, type SheetAccess } from './google';

export type { SheetAccess };

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

/** Spreadsheet id from a full URL (…/spreadsheets/d/<id>/…) or a bare id. Throws VALIDATION. */
export function parseSpreadsheetId(input: unknown): string {
  const s = String(input ?? '').trim();
  if (!s) throw fail('VALIDATION', 'Paste the Google Sheet link');
  const m = s.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/);
  const id = m ? m[1] : /^https?:\/\//i.test(s) ? '' : s;
  if (!ID_RE.test(id)) throw fail('VALIDATION', 'This is not a Google Sheets link (expected https://docs.google.com/spreadsheets/d/…)');
  return id;
}

/** 'My Tab' + 'A1:Z' → "'My Tab'!A1:Z" (quotes doubled). An empty tab means the first tab. */
export function a1(tab: string, range = ''): string {
  if (!tab) return range || 'A:ZZ';
  const q = `'${tab.replace(/'/g, "''")}'`;
  return range ? `${q}!${range}` : q;
}

/** 0 → 'A', 25 → 'Z', 26 → 'AA'. */
export function colLetter(index: number): string {
  let n = index + 1, s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const enc = (range: string) => encodeURIComponent(range);

/** Friendly message for a Google error; `need` says what access the failed operation required. */
async function friendly(access: SheetAccess, e: unknown, need: 'read' | 'write'): Promise<never> {
  if (!(e instanceof GoogleApiError)) throw e;
  const email = await access.email();
  const oauth = access.mode === 'oauth';
  if (e.httpStatus === 403) {
    if (/protected/i.test(e.googleMessage)) {
      throw new GoogleApiError(403, e.googleMessage, `The CRM cannot edit a protected range of this sheet. Remove the protection or give ${oauth ? 'the connected Google account' : 'the service account'} permission to edit it.`);
    }
    if (oauth) {
      throw new GoogleApiError(403, e.googleMessage, `The Google account ${email || 'that was connected'} cannot open this sheet. Share it with that account or connect the account that owns it (Viewer to import, Editor to export)${need === 'write' ? ' — this step needs Editor access' : ''}.`);
    }
    throw new GoogleApiError(403, e.googleMessage, `Share the sheet with ${email || 'the platform service account'} (Viewer to import, Editor to export)${need === 'write' ? ' — this step needs Editor access' : ''}.`);
  }
  if (e.httpStatus === 404) throw new GoogleApiError(404, e.googleMessage, 'Spreadsheet not found. Check the link (and that the sheet was not deleted).');
  if (e.httpStatus === 400 && /unable to parse range/i.test(e.googleMessage)) throw new GoogleApiError(400, e.googleMessage, 'That tab does not exist in the spreadsheet.');
  if (e.httpStatus === 400) throw new GoogleApiError(400, e.googleMessage, `Google Sheets refused the request: ${truncate(e.googleMessage, 200)}`);
  throw e;
}

async function call<T>(access: SheetAccess, need: 'read' | 'write', url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await googleJson<T>(access, url, init);
  } catch (e) {
    return friendly(access, e, need);
  }
}

export interface SpreadsheetInfo {
  title: string;
  tabs: Array<{ title: string; sheetId: number; rowCount: number; columnCount: number }>;
}

export async function getSpreadsheet(access: SheetAccess, id: string): Promise<SpreadsheetInfo> {
  const j: any = await call(access, 'read', `${BASE}/${enc(id)}?fields=${enc('properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))')}`);
  const tabs = (j?.sheets || [])
    .map((s: any) => s?.properties || {})
    .sort((a: any, b: any) => (a.index || 0) - (b.index || 0))
    .map((p: any) => ({ title: String(p.title ?? ''), sheetId: Number(p.sheetId) || 0, rowCount: Number(p.gridProperties?.rowCount) || 0, columnCount: Number(p.gridProperties?.columnCount) || 0 }));
  return { title: String(j?.properties?.title ?? ''), tabs };
}

type Cell = string | number | boolean | null;

/** Values of a range as strings (formatted as shown in the sheet). Rows/cells after the last value are omitted by Google. */
export async function readValues(access: SheetAccess, id: string, range: string, render: 'FORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE'): Promise<string[][]> {
  const j: any = await call(access, 'read', `${BASE}/${enc(id)}/values/${enc(range)}?majorDimension=ROWS&valueRenderOption=${render}`);
  return ((j?.values || []) as Cell[][]).map((row) => (row || []).map((v) => (v === null || v === undefined ? '' : String(v))));
}

/** Raw (typed) values — used by probeWrite to write a cell back unchanged. */
async function readRaw(access: SheetAccess, id: string, range: string): Promise<Cell[][]> {
  const j: any = await call(access, 'read', `${BASE}/${enc(id)}/values/${enc(range)}?majorDimension=ROWS&valueRenderOption=FORMULA`);
  return (j?.values || []) as Cell[][];
}

export async function updateValues(access: SheetAccess, id: string, range: string, values: Cell[][], input: 'RAW' | 'USER_ENTERED' = 'RAW') {
  return call<any>(access, 'write', `${BASE}/${enc(id)}/values/${enc(range)}?valueInputOption=${input}`, { method: 'PUT', body: { range, majorDimension: 'ROWS', values } });
}

/** Several ranges in ONE request (RAW). */
export async function batchUpdateValues(access: SheetAccess, id: string, data: Array<{ range: string; values: Cell[][] }>) {
  return call<any>(access, 'write', `${BASE}/${enc(id)}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'RAW', data: data.map((d) => ({ ...d, majorDimension: 'ROWS' })) } });
}

export async function appendValues(access: SheetAccess, id: string, range: string, values: Cell[][]) {
  return call<any>(access, 'write', `${BASE}/${enc(id)}/values/${enc(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: { majorDimension: 'ROWS', values } });
}

export async function clearValues(access: SheetAccess, id: string, range: string) {
  return call<any>(access, 'write', `${BASE}/${enc(id)}/values/${enc(range)}:clear`, { method: 'POST', body: {} });
}

export async function batchUpdate(access: SheetAccess, id: string, requests: unknown[]) {
  return call<any>(access, 'write', `${BASE}/${enc(id)}:batchUpdate`, { method: 'POST', body: { requests } });
}

/** Create a tab; returns its sheetId. */
export async function addSheet(access: SheetAccess, id: string, title: string): Promise<number> {
  const j = await batchUpdate(access, id, [{ addSheet: { properties: { title } } }]);
  return Number(j?.replies?.[0]?.addSheet?.properties?.sheetId) || 0;
}

/** Bold + frozen header row (cosmetic; failures are ignored by callers). */
export async function formatHeaderRow(access: SheetAccess, id: string, sheetId: number) {
  return batchUpdate(access, id, [
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
  ]);
}

/**
 * Does the account (service account or connected Google account) have edit access? Writes ONE cell back unchanged: the cell is read with
 * valueRenderOption FORMULA (numbers/booleans come back typed, formulas as "=…") and written back with RAW —
 * or USER_ENTERED only when it holds a formula, so the formula stays a formula. Values and formatting are
 * unchanged; the only trace is an entry in the sheet's version history. Returns false on 403 (Viewer,
 * protected cell) and rethrows other errors.
 */
export async function probeWrite(access: SheetAccess, id: string, cellRange: string): Promise<boolean> {
  const cur = await readRaw(access, id, cellRange);
  const v: Cell = cur?.[0]?.[0] ?? '';
  try {
    await updateValues(access, id, cellRange, [[v]], typeof v === 'string' && v.startsWith('=') ? 'USER_ENTERED' : 'RAW');
    return true;
  } catch (e) {
    if (e instanceof GoogleApiError && e.httpStatus === 403) return false;
    throw e;
  }
}
