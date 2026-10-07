/**
 * Google Sheets integration: service-account JWT + token cache, the Sheets client, import (lead source type
 * google_sheet) with and without a status column, export (RAW values), the cron, platform claims, plan
 * gating, the super-admin key storage and the inbound endpoint refusing sheet sources.
 * Google is replaced by an in-memory fake behind a stubbed global fetch.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { getClient, PLATFORM_DB } from '../server/core/db';
import { runWithTenant, type Tenant } from '../server/core/tenant';
import { DEFAULT_FEATURES, getTenantById, invalidateTenant } from '../server/platform/registry';
import { createUser, login } from '../server/core/auth';
import { sha256Hex } from '../server/core/utils';
import * as LS from '../server/modules/leadSources';
import * as SH from '../server/modules/sheets';
import * as leadsModule from '../server/modules/leads';
import { sourcesCol } from '../server/modules/intake';
import { buildJwt, getAccessToken, GOOGLE_TOKEN_URL, resetGoogleTokenCache, SHEETS_SCOPE, __setGoogleRetryDelay } from '../server/integrations/google';
import { parseSpreadsheetId } from '../server/integrations/sheets';
import { dispatch } from '../server/router';
import { platformDispatch } from '../server/platform/router';
import { POST as inboundPOST } from '../app/api/inbound/leads/route';
import { GET as cronGET } from '../app/api/cron/sheets/route';

/* ------------------------------ fake Google ------------------------------ */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SA_EMAIL = 'crm-sync@amaya-test.iam.gserviceaccount.com';
const SA_JSON = JSON.stringify({ type: 'service_account', project_id: 'amaya-test', private_key_id: 'abc', private_key: privateKey, client_email: SA_EMAIL, token_uri: GOOGLE_TOKEN_URL });

type Perm = 'none' | 'reader' | 'writer';
interface FakeTab { title: string; sheetId: number; rows: string[][] }
interface FakeSheet { title: string; perm: Perm; tabs: FakeTab[] }
interface Call { method: string; path: string; query: URLSearchParams; body: any }

let sheets: Record<string, FakeSheet> = {};
let calls: Call[] = [];
let tokenRequests: URLSearchParams[] = [];
let nextSheetId = 100;

const SID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab';
const SID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-zz';
const URL1 = `https://docs.google.com/spreadsheets/d/${SID}/edit#gid=0`;
const URL2 = `https://docs.google.com/spreadsheets/d/${SID2}/edit`;

function addFakeSheet(id: string, perm: Perm, tabs: Array<{ title: string; rows: string[][] }>, title = 'Leads book') {
  sheets[id] = { title, perm, tabs: tabs.map((t) => ({ title: t.title, sheetId: nextSheetId++, rows: t.rows.map((r) => [...r]) })) };
  return sheets[id];
}

const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

function parseRange(sheet: FakeSheet, range: string) {
  const m = range.match(/^'((?:[^']|'')*)'(?:!(.*))?$/);
  if (!m) throw new Error('fake: unquoted range ' + range);
  const tab = sheet.tabs.find((t) => t.title === m[1].replace(/''/g, "'"));
  if (!tab) return null;
  const ref = m[2] || '';
  const r = ref.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  if (ref && !r) throw new Error('fake: bad ref ' + ref);
  return {
    tab,
    c0: r ? colNum(r[1]) : 0,
    r0: r && r[2] ? Number(r[2]) - 1 : 0,
    c1: r && r[3] ? colNum(r[3]) : r && !r[3] && r[2] ? colNum(r[1]) : 10000,
    r1: r && r[4] ? Number(r[4]) - 1 : r && !r[3] && r[2] ? Number(r[2]) - 1 : 1000000,
  };
}

function writeCells(tab: FakeTab, r0: number, c0: number, values: any[][]) {
  values.forEach((row, i) => {
    const rr = (tab.rows[r0 + i] ||= []);
    row.forEach((v, j) => {
      while (rr.length < c0 + j) rr.push('');
      rr[c0 + j] = v === null || v === undefined ? '' : String(v);
    });
  });
  for (let i = 0; i < tab.rows.length; i++) tab.rows[i] ||= [];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gErr = (status: number, message: string) => json(status, { error: { code: status, message, status: 'ERR' } });

async function fakeFetch(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  if (url.toString() === GOOGLE_TOKEN_URL) {
    const form = new URLSearchParams(String(init.body));
    tokenRequests.push(form);
    return json(200, { access_token: `ya29.token-${tokenRequests.length}`, expires_in: 3599, token_type: 'Bearer' });
  }
  if (url.host !== 'sheets.googleapis.com') throw new Error('fake: unexpected host ' + url.host);
  expect(init.headers?.Authorization).toMatch(/^Bearer ya29\.token-\d+$/);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const path = url.pathname.replace(/^\/v4\/spreadsheets\//, '');
  calls.push({ method, path: decodeURIComponent(path), query: url.searchParams, body });

  const [idPart, ...rest] = path.split('/');
  const [rawId, op] = idPart.split(':');
  const sheet = sheets[decodeURIComponent(rawId)];
  if (!sheet) return gErr(404, 'Requested entity was not found.');
  if (sheet.perm === 'none') return gErr(403, 'The caller does not have permission');
  const needWrite = method !== 'GET';
  if (needWrite && sheet.perm !== 'writer') return gErr(403, 'The caller does not have permission');

  if (!rest.length && !op && method === 'GET') {
    return json(200, { properties: { title: sheet.title }, sheets: sheet.tabs.map((t, i) => ({ properties: { sheetId: t.sheetId, title: t.title, index: i, gridProperties: { rowCount: 1000, columnCount: 26 } } })) });
  }
  if (!rest.length && op === 'batchUpdate') {
    const replies: any[] = [];
    for (const r of body.requests) {
      if (r.addSheet) {
        const tab = { title: r.addSheet.properties.title, sheetId: nextSheetId++, rows: [] as string[][] };
        sheet.tabs.push(tab);
        replies.push({ addSheet: { properties: { sheetId: tab.sheetId, title: tab.title } } });
      } else replies.push({});
    }
    return json(200, { replies });
  }
  if (rest[0] === 'values:batchUpdate') {
    expect(body.valueInputOption).toBe('RAW');
    for (const d of body.data) {
      const p = parseRange(sheet, d.range)!;
      writeCells(p.tab, p.r0, p.c0, d.values);
    }
    return json(200, { totalUpdatedCells: body.data.length });
  }
  if (rest[0] === 'values') {
    const [rangeEnc, suffix] = rest.slice(1).join('/').split(':');
    const p = parseRange(sheet, decodeURIComponent(rangeEnc));
    if (!p) return gErr(400, 'Unable to parse range: ' + decodeURIComponent(rangeEnc));
    if (method === 'GET') {
      const out: string[][] = [];
      for (let r = p.r0; r <= Math.min(p.r1, p.tab.rows.length - 1); r++) {
        const row = (p.tab.rows[r] || []).slice(p.c0, p.c1 + 1);
        while (row.length && row[row.length - 1] === '') row.pop();
        out.push(row);
      }
      while (out.length && !out[out.length - 1].length) out.pop();
      return json(200, { range: decodeURIComponent(rangeEnc), majorDimension: 'ROWS', ...(out.length ? { values: out } : {}) });
    }
    if (suffix === 'clear') {
      for (let r = p.r0; r <= Math.min(p.r1, p.tab.rows.length - 1); r++) {
        const row = p.tab.rows[r] || [];
        for (let c = p.c0; c <= Math.min(p.c1, row.length - 1); c++) row[c] = '';
      }
      return json(200, {});
    }
    if (method === 'PUT') {
      writeCells(p.tab, p.r0, p.c0, body.values);
      return json(200, { updatedCells: 1 });
    }
  }
  throw new Error(`fake: unhandled ${method} ${url}`);
}

const sheetCalls = (pred: (c: Call) => boolean) => calls.filter(pred);
const tabRows = (id: string, tab: string) => sheets[id].tabs.find((t) => t.title === tab)!.rows;

/* --------------------------------- setup --------------------------------- */

let t: Awaited<ReturnType<typeof startTestDb>>;
const OTHER_DB = 'amaya_test_sheets_other';

async function tenant(id = 'CMP-test'): Promise<Tenant> {
  invalidateTenant();
  return (await getTenantById(id))!;
}
const inCo = async <T>(fn: () => Promise<T>, id = 'CMP-test') => runWithTenant(await tenant(id), fn);

async function registerOther(features: Partial<typeof DEFAULT_FEATURES> = {}) {
  await (await getClient())!.db(PLATFORM_DB()).collection('companies').updateOne(
    { _id: 'CMP-other' as any },
    { $set: { slug: 'other', name: 'Other Co', dbName: OTHER_DB, status: 'Active', plan: 'Test', maxUsers: 0, features: { ...DEFAULT_FEATURES, googleSheets: true, ...features }, logo: '', tagline: '', createdAt: new Date(), updatedAt: new Date() } },
    { upsert: true }
  );
  invalidateTenant();
}

const sheetSource = (sheet: Record<string, unknown>, extra: Record<string, unknown> = {}, companyId = 'CMP-test') =>
  inCo(() => LS.createLeadSource({ name: 'Sheet leads', type: 'google_sheet', config: { sheet, ...extra } as any }, null), companyId);
const leadsIn = async (id = 'CMP-test') => inCo(async () => (await leadsModule.getAllLeads(null)).leads, id);
const addLead = (data: Record<string, string>) => inCo(() => leadsModule.addLead(data, null, { allowDuplicate: true }));

beforeAll(async () => {
  t = await startTestDb();
  __setGoogleRetryDelay(5);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.CRON_SECRET;
  await (await getClient())!.db(OTHER_DB).dropDatabase();
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  const other = (await getClient())!.db(OTHER_DB);
  await Promise.all((await other.collections()).map((c) => c.deleteMany({})));
  await t.company('test', { googleSheets: true, websiteApi: true });
  sheets = {};
  calls = [];
  tokenRequests = [];
  resetGoogleTokenCache();
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;
  process.env.CRON_SECRET = 'cron-secret-123';
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

/* --------------------------------- tests --------------------------------- */

describe('service-account auth', () => {
  it('signs an RS256 JWT verifiable with the public key, with the right claims', () => {
    const now = 1_800_000_000;
    const jwt = buildJwt({ client_email: SA_EMAIL, private_key: privateKey }, now);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iss: SA_EMAIL, scope: SHEETS_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 });
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('exchanges the JWT at the token endpoint and caches the token', async () => {
    const a = await getAccessToken();
    expect(a).toEqual({ token: 'ya29.token-1', email: SA_EMAIL });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(tokenRequests[0].get('assertion')!.split('.')).toHaveLength(3);
    expect((await getAccessToken()).token).toBe('ya29.token-1');
    expect(tokenRequests).toHaveLength(1);
    resetGoogleTokenCache();
    expect((await getAccessToken()).token).toBe('ya29.token-2');
  });

  it('accepts the env key as base64 and reports NOT_CONFIGURED without one', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = Buffer.from(SA_JSON).toString('base64');
    expect((await getAccessToken()).email).toBe(SA_EMAIL);
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    await expect(getAccessToken()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('retries once on 5xx', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Name']] }]);
    let failures = 1;
    vi.stubGlobal('fetch', vi.fn(async (u: any, i: any) => (String(u).includes('sheets.googleapis.com') && failures-- > 0 ? gErr(503, 'busy') : fakeFetch(u, i))));
    const r = await inCo(() => SH.checkSheet({ spreadsheetUrl: SID }));
    expect(r.ok).toBe(true);
  });
});

describe('parseSpreadsheetId', () => {
  it('accepts URLs and bare ids, rejects the rest', () => {
    expect(parseSpreadsheetId(URL1)).toBe(SID);
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/u/0/d/${SID}/edit?usp=sharing`)).toBe(SID);
    expect(parseSpreadsheetId(`  ${SID}  `)).toBe(SID);
    expect(() => parseSpreadsheetId('')).toThrow(/link/);
    expect(() => parseSpreadsheetId('short-id')).toThrow(/not a Google Sheets link/);
    expect(() => parseSpreadsheetId('https://example.com/whatever/' + SID)).toThrow(/not a Google Sheets link/);
    expect(() => parseSpreadsheetId('https://docs.google.com/spreadsheets/d/abc/edit')).toThrow(/not a Google Sheets link/);
  });
});

describe('checkSheet', () => {
  it('maps 403 to the share message with the service-account e-mail, and 404 to not found', async () => {
    addFakeSheet(SID, 'none', [{ title: 'Sheet1', rows: [] }]);
    const r = await inCo(() => SH.checkSheet({ spreadsheetUrl: URL1 }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`Share the sheet with ${SA_EMAIL} (Viewer to import, Editor to export)`);
    const nf = await inCo(() => SH.checkSheet({ spreadsheetUrl: SID2 }));
    expect(nf).toMatchObject({ ok: false });
    expect(nf.message).toMatch(/Spreadsheet not found/);
  });

  it('returns title, tabs and headers; canWrite via an unchanged write-back of the header cell', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Form responses', rows: [['Name', 'Phone', 'Email']] }, { title: 'Other', rows: [] }], 'Enquiries');
    const r = await inCo(() => SH.checkSheet({ spreadsheetUrl: URL1 }));
    expect(r).toEqual({ ok: true, title: 'Enquiries', tabs: ['Form responses', 'Other'], headers: ['Name', 'Phone', 'Email'], canWrite: false, message: '' });
    sheets[SID].perm = 'writer';
    const w = await inCo(() => SH.checkSheet({ spreadsheetUrl: URL1, tab: 'Form responses' }));
    expect(w.canWrite).toBe(true);
    expect(tabRows(SID, 'Form responses')[0]).toEqual(['Name', 'Phone', 'Email']);
    const missing = await inCo(() => SH.checkSheet({ spreadsheetUrl: URL1, tab: 'Nope' }));
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/Tab "Nope" was not found/);
  });
});

describe('import (lead source type google_sheet)', () => {
  it('creates a source without an API key and validates the sheet', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    await expect(sheetSource({})).rejects.toThrow(/Paste the Google Sheet link/);
    await expect(sheetSource({ spreadsheetUrl: URL1, headerRow: 25 })).rejects.toThrow(/1 to 20/);
    await expect(sheetSource({ spreadsheetUrl: URL1, intervalMinutes: 7 })).rejects.toThrow(/intervalMinutes/);
    await expect(sheetSource({ spreadsheetUrl: URL1, statusColumn: 'Status' })).rejects.toThrow(/Column "Status" was not found/);
    await expect(sheetSource({ spreadsheetUrl: URL2 })).rejects.toThrow(/Spreadsheet not found/);
    const { source, apiKey } = await sheetSource({ spreadsheetUrl: URL1 });
    expect(apiKey).toBe('');
    expect(source).toMatchObject({ type: 'google_sheet', keyPrefix: '' });
    expect(source.config.sheet).toMatchObject({ spreadsheetId: SID, tab: '', headerRow: 1, intervalMinutes: 15, lastRow: 0 });
    expect(source.config.sourceLabel).toBe('Google Sheet');
    const keys = await (await getClient())!.db(PLATFORM_DB()).collection('apiKeys').countDocuments({});
    expect(keys).toBe(0);
    await expect(inCo(() => LS.rotateLeadSourceKey({ id: source.id }, null))).rejects.toThrow(/no API key/);
  });

  it('with a status column: imports only empty-status rows, writes statuses in one batch, re-runs are idempotent', async () => {
    addFakeSheet(SID, 'writer', [{
      title: 'Leads',
      rows: [
        ['Name', 'Phone', 'Email', 'City', 'CRM Status'],
        ['Asha Rao', '+91 98765 43210', 'asha@example.com', 'Pune', ''],
        ['Old Row', '9000000009', '', '', 'Imported ENQ-0999 · earlier'],
        [],
        ['No Contact', '', '', 'Delhi', ''],
        ['Vikram', '9123456780', '', '', ''],
      ],
    }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1, tab: 'Leads', statusColumn: 'crm status' });
    expect(source.config.sheet!.statusColumn).toBe('CRM Status');
    calls = [];
    const r = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(r).toMatchObject({ created: 2, duplicates: 0, rejected: 1, failed: 0 });
    expect(r.message).toBe('2 new, 1 rejected');
    const writes = sheetCalls((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`${SID}/values:batchUpdate`);
    expect(writes[0].body.data.map((d: any) => d.range)).toEqual(["'Leads'!E2", "'Leads'!E5", "'Leads'!E6"]);
    const rows = tabRows(SID, 'Leads');
    expect(rows[1][4]).toMatch(/^Imported ENQ-0001 · \d\d \w{3} \d{4}, \d\d:\d\d (AM|PM)$/);
    expect(rows[4][4]).toBe('Rejected: A phone number or e-mail address is required');
    expect(rows[5][4]).toMatch(/^Imported ENQ-0002/);
    const leads = await leadsIn();
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({ 'Prospect Name': 'Asha Rao', Email: 'asha@example.com', 'Enquiry Source': 'Google Sheet', 'Lead Stage': 'New' });
    expect(leads[0]['Enquiry Notes']).toContain('City: Pune');

    // re-run: nothing new, nothing written
    calls = [];
    const again = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(again).toMatchObject({ created: 0, rejected: 0, message: 'No new rows' });
    expect(sheetCalls((c) => c.method !== 'GET')).toHaveLength(0);

    // a status lost (e.g. the write-back failed): the idempotency key replays, no second lead
    rows[1][4] = '';
    const replay = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(replay).toMatchObject({ created: 0, message: '1 already imported' });
    expect(tabRows(SID, 'Leads')[1][4]).toMatch(/^Imported ENQ-0001/);
    expect(await leadsIn()).toHaveLength(2);

    const src = (await inCo(() => LS.listLeadSources()))[0];
    expect(src.stats).toMatchObject({ received: 3, created: 2, rejected: 1 });
    expect(src.config.sheet!.lastSyncResult).toBe('1 already imported');
    expect(src.config.sheet!.lastSyncAt).not.toBe('');
  });

  it('keeps the import when statuses cannot be written (Viewer access) and says Editor is needed', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Name', 'Phone', 'Status'], ['Asha', '9876543210', '']] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1, statusColumn: 'Status' });
    const r = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(r.created).toBe(1);
    expect(r.message).toMatch(/Editor access/);
    expect(await leadsIn()).toHaveLength(1);
    // still idempotent on the next run
    const r2 = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(r2.created).toBe(0);
    expect(await leadsIn()).toHaveLength(1);
  });

  it('without a status column: imports the rows after lastRow', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Title row'], ['Full Name', 'Mobile'], ['Asha', '9876543210'], ['Ravi', '9876543211']] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1, headerRow: 2, intervalMinutes: 0 });
    calls = [];
    const r = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(r.created).toBe(2);
    let src = (await inCo(() => LS.listLeadSources()))[0];
    expect(src.config.sheet!.lastRow).toBe(4);
    expect((await leadsIn()).map((l) => l['Prospect Name'])).toEqual(['Asha', 'Ravi']);
    expect(sheetCalls((c) => c.method === 'GET' && c.path.includes('/values/')).map((c) => c.path.split('/values/')[1])).toEqual(["'Sheet1'!A2:ZZ2", "'Sheet1'!A3:ZZ2002"]);

    tabRows(SID, 'Sheet1').push(['Meera', '9876543212']);
    calls = [];
    const r2 = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(r2.created).toBe(1);
    expect(sheetCalls((c) => c.path.includes('/values/')).map((c) => c.path.split('/values/')[1])).toContain("'Sheet1'!A5:ZZ2004");
    src = (await inCo(() => LS.listLeadSources()))[0];
    expect(src.config.sheet!.lastRow).toBe(5);
    expect((await inCo(() => SH.syncSheetImport(source.id, null))).message).toBe('No new rows');
  });

  it('duplicates and assignment flow through the intake pipeline; fieldMap overrides headers', async () => {
    const rm = await t.ctx('RM', 'Priya');
    expect(rm.user!.name).toBe('Priya');
    await addLead({ 'Prospect Name': 'Existing', 'Phone Number': '9876543210' });
    addFakeSheet(SID, 'writer', [{ title: 'Sheet1', rows: [['Name', 'Phone', 'BHK wanted', 'Status'], ['Again', '+91 98765 43210', '', ''], ['Newbie', '9123456789', '3 BHK', '']] }]);
    const { source } = await sheetSource(
      { spreadsheetUrl: URL1, statusColumn: 'Status' },
      { assignment: { mode: 'fixed', rm: 'Priya', rms: [] }, fieldMap: { 'BHK wanted': 'Unit Type Interested In' } }
    );
    const r = await inCo(() => SH.syncSheetImport(source.id, null));
    expect(r).toMatchObject({ created: 1, duplicates: 1 });
    const rows = tabRows(SID, 'Sheet1');
    expect(rows[1][3]).toBe('Duplicate of ENQ-0001');
    const fresh = (await leadsIn()).find((l) => l['Prospect Name'] === 'Newbie')!;
    expect(fresh).toMatchObject({ 'Assigned RM': 'Priya', 'Unit Type Interested In': '3 BHK' });
  });

  it('records sync errors on the source', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1 });
    sheets[SID].perm = 'none';
    await expect(inCo(() => SH.syncSheetImport(source.id, null))).rejects.toThrow(/Share the sheet/);
    const src = (await inCo(() => LS.listLeadSources()))[0];
    expect(src.config.sheet!.lastSyncResult).toMatch(/^Error: Share the sheet/);
  });
});

describe('export', () => {
  it('creates the tab, writes RAW values with a header row and skips Trash', async () => {
    addFakeSheet(SID, 'writer', [{ title: 'Sheet1', rows: [] }]);
    await addLead({ 'Prospect Name': 'Asha', 'Phone Number': '9876543210', 'Enquiry Notes': '=HYPERLINK("http://evil","x")', 'Enquiry Date': '2026-10-05T10:00:00.000Z' });
    await addLead({ 'Prospect Name': 'Binned', 'Phone Number': '9876543211', 'Lead Stage': 'Trash' });
    await inCo(() => leadsModule.appendRemark('ENQ-0001', 'Called, interested', null, undefined, 'Tester'));
    const x = await inCo(() => SH.createSheetExport({ name: 'Backup', spreadsheetUrl: URL1, columns: { includeFollowups: true } }, null));
    expect(x).toMatchObject({ id: 'SHX-0001', tab: 'CRM Leads', status: 'Active', intervalMinutes: 15, lastRows: 0 });
    expect(sheets[SID].tabs.map((tb) => tb.title)).toEqual(['Sheet1', 'CRM Leads']);

    calls = [];
    const done = await inCo(() => SH.runSheetExport({ id: x.id }, null));
    expect(done).toMatchObject({ lastRows: 1, lastError: '' });
    const writes = sheetCalls((c) => c.method !== 'GET');
    expect(writes.map((c) => c.method + ' ' + c.path)).toEqual([`POST ${SID}/values/'CRM Leads':clear`, `PUT ${SID}/values/'CRM Leads'!A1`]);
    expect(writes[1].query.get('valueInputOption')).toBe('RAW');
    const rows = tabRows(SID, 'CRM Leads');
    expect(rows[0]).toEqual([...SH.DEFAULT_EXPORT_HEADERS, 'Follow-ups']);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('ENQ-0001');
    expect(rows[1][1]).toBe('05 Oct 2026, 03:30 PM');
    expect(rows[1][SH.DEFAULT_EXPORT_HEADERS.indexOf('Enquiry Notes')]).toBe('=HYPERLINK("http://evil","x")');
    expect(rows[1][rows[0].length - 1]).toContain('Called, interested');

    // the tab is rewritten (old rows cleared) and Trash can be included
    await inCo(() => SH.updateSheetExport({ id: x.id, patch: { columns: { includeTrash: true, includeFollowups: false, headers: ['Enquiry ID', 'Prospect Name'] } } }, null));
    await inCo(() => SH.runSheetExport({ id: x.id }, null));
    const trimmed = tabRows(SID, 'CRM Leads').map((r) => r.slice(0, r.reduce((n, v, i) => (v ? i + 1 : n), 0))).filter((r) => r.length);
    expect(trimmed).toEqual([['Enquiry ID', 'Prospect Name'], ['ENQ-0001', 'Asha'], ['ENQ-0002', 'Binned']]);
  });

  it('needs Editor access to create the tab, and refuses unknown columns', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [] }]);
    await expect(inCo(() => SH.createSheetExport({ name: 'X', spreadsheetUrl: URL1 }, null))).rejects.toThrow(/Editor/);
    sheets[SID].perm = 'writer';
    await expect(inCo(() => SH.createSheetExport({ name: 'X', spreadsheetUrl: URL1, columns: { headers: ['Password'] } }, null))).rejects.toThrow(/Not lead fields/);
    // an export may not overwrite the tab an import reads
    sheets[SID].tabs[0].rows = [['Name', 'Phone']];
    await sheetSource({ spreadsheetUrl: URL1 });
    await expect(inCo(() => SH.createSheetExport({ name: 'X', spreadsheetUrl: URL1, tab: 'Sheet1' }, null))).rejects.toThrow(/imported by a Google Sheet lead source/);
  });
});

describe('cron /api/cron/sheets', () => {
  const cron = () => cronGET(new Request('https://crm.example.com/api/cron/sheets', { headers: { Authorization: 'Bearer cron-secret-123' } }));

  it('needs the cron secret and skips when Google is not configured', async () => {
    expect((await cronGET(new Request('https://crm.example.com/api/cron/sheets'))).status).toBe(401);
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const r = await cron();
    expect(r.status).toBe(200);
    expect((await r.json()).data.skipped).toMatch(/not configured/);
  });

  it('runs due imports and exports, and skips an export when the data version is unchanged', async () => {
    addFakeSheet(SID, 'writer', [{ title: 'Sheet1', rows: [['Name', 'Phone'], ['Asha', '9876543210']] }]);
    addFakeSheet(SID2, 'writer', [{ title: 'Sheet1', rows: [] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1, intervalMinutes: 5 });
    const x = await inCo(() => SH.createSheetExport({ name: 'Backup', spreadsheetUrl: URL2, intervalMinutes: 5 }, null));

    const b1 = await (await cron()).json();
    expect(b1.status).toBe('success');
    expect(b1.data.results.test.imports).toEqual([{ id: source.id, result: '1 new' }]);
    expect(b1.data.results.test.exports).toEqual([{ id: x.id, rows: 1 }]);
    expect(tabRows(SID2, 'CRM Leads')).toHaveLength(2);

    // not due yet → nothing runs
    const b2 = await (await cron()).json();
    expect(b2.data.results.test).toEqual({ imports: [], exports: [] });

    // interval elapsed but no data change → export skipped
    const past = new Date(Date.now() - 10 * 60000);
    await inCo(async () => {
      await (await SH.exportsCol()).updateOne({ _id: x.id }, { $set: { lastSyncAt: past } });
      await (await sourcesCol()).updateOne({ _id: source.id }, { $set: { 'config.sheet.lastSyncAt': past.toISOString() } });
    });
    calls = [];
    const b3 = await (await cron()).json();
    expect(b3.data.results.test.exports).toEqual([{ id: x.id, skipped: 'unchanged' }]);
    expect(b3.data.results.test.imports).toEqual([{ id: source.id, result: 'No new rows' }]);
    expect(sheetCalls((c) => c.path.startsWith(SID2))).toHaveLength(0);

    // a data change → exported again
    await new Promise((r) => setTimeout(r, 5));
    await addLead({ 'Prospect Name': 'Ravi', 'Phone Number': '9876543211' });
    await inCo(async () => (await SH.exportsCol()).updateOne({ _id: x.id }, { $set: { lastSyncAt: past } }));
    const b4 = await (await cron()).json();
    expect(b4.data.results.test.exports).toEqual([{ id: x.id, rows: 2 }]);
  });

  it('isolates errors per link and skips companies without the feature', async () => {
    addFakeSheet(SID, 'writer', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    addFakeSheet(SID2, 'writer', [{ title: 'Sheet1', rows: [] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1, intervalMinutes: 5 });
    const x = await inCo(() => SH.createSheetExport({ name: 'Backup', spreadsheetUrl: URL2, intervalMinutes: 5 }, null));
    sheets[SID].perm = 'none';
    const b = await (await cron()).json();
    expect(b.data.results.test.imports[0]).toMatchObject({ id: source.id, error: expect.stringMatching(/Share the sheet/) });
    expect(b.data.results.test.exports).toEqual([{ id: x.id, rows: 0 }]);

    await t.company('test', { googleSheets: false });
    const b2 = await (await cron()).json();
    expect(b2.data.results).toEqual({});
  });
});

describe('claims', () => {
  it('a spreadsheet can be linked by one company only; released when unused and when the company is deleted', async () => {
    await registerOther();
    addFakeSheet(SID, 'writer', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    const x = await inCo(() => SH.createSheetExport({ name: 'Backup', spreadsheetUrl: URL1 }, null));
    const claims = (await getClient())!.db(PLATFORM_DB()).collection('sheetClaims');
    expect(await claims.findOne({ _id: SID as any })).toMatchObject({ companyId: 'CMP-test' });

    await expect(inCo(() => SH.createSheetExport({ name: 'Mine', spreadsheetUrl: URL1, tab: 'Other' }, null), 'CMP-other')).rejects.toMatchObject({ code: 'CONFLICT', message: 'This spreadsheet is already linked to another workspace' });
    await expect(sheetSource({ spreadsheetUrl: URL1 }, {}, 'CMP-other')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(inCo(() => SH.checkSheet({ spreadsheetUrl: URL1 }), 'CMP-other')).rejects.toMatchObject({ code: 'CONFLICT' });

    // the same company may use it for an import too; deleting one link keeps the claim
    const { source } = await sheetSource({ spreadsheetUrl: URL1 });
    await inCo(() => SH.deleteSheetExport({ id: x.id }, null));
    expect(await claims.countDocuments({ _id: SID as any })).toBe(1);
    await inCo(() => LS.deleteLeadSource({ id: source.id }, null));
    expect(await claims.countDocuments({ _id: SID as any })).toBe(0);

    // now the other company can link it; deleting that company releases it
    await inCo(() => SH.createSheetExport({ name: 'Mine', spreadsheetUrl: URL1, tab: 'Theirs' }, null), 'CMP-other');
    expect(await claims.findOne({ _id: SID as any })).toMatchObject({ companyId: 'CMP-other' });
    const setup = await platformDispatch('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' }, { token: '', userAgent: 'vitest', ip: '10.0.0.1' });
    const del = await platformDispatch('deleteCompany', { id: 'CMP-other', confirmSlug: 'other' }, { token: setup.session!.token, userAgent: 'vitest', ip: '10.0.0.1' });
    expect(del.status).toBe(200);
    expect(await claims.countDocuments({})).toBe(0);
  });

  it('re-linking an import source to another sheet moves the claim', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    addFakeSheet(SID2, 'reader', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1 });
    const upd = await inCo(() => LS.updateLeadSource({ id: source.id, patch: { config: { sheet: { spreadsheetUrl: URL2 } } as any } }, null));
    expect(upd.config.sheet!.spreadsheetId).toBe(SID2);
    const claims = (await getClient())!.db(PLATFORM_DB()).collection('sheetClaims');
    expect((await claims.find({}).toArray()).map((c) => c._id)).toEqual([SID2]);
  });
});

describe('plan gate (company router)', () => {
  async function session(features: Partial<typeof DEFAULT_FEATURES>) {
    await t.company('test', features);
    await createUser({ name: 'Boss', email: 'boss@sheets.test', password: 'long-enough-pw', role: 'Developer', mustChangePassword: false }, null); // platform support
    const token = (await login('boss@sheets.test', 'long-enough-pw', { userAgent: 'vitest', ip: '10.2.2.2' })).token;
    return (action: string, data: any = {}) => dispatch(action, data, { token, userAgent: 'vitest', ip: '10.2.2.2', companyId: 'CMP-test' });
  }

  it('without googleSheets: checkSheet / exports / sheet sources are FORBIDDEN, googleStatus still answers', async () => {
    const call = await session({ googleSheets: false, websiteApi: true });
    const r = await call('checkSheet', { spreadsheetUrl: URL1 });
    expect(r.status).toBe(403);
    expect((r.body as any).code).toBe('FORBIDDEN');
    expect((await call('listSheetExports')).status).toBe(403);
    const g = await call('googleStatus');
    expect(g.status).toBe(200);
    expect((g.body as any).data).toEqual({ configured: true, serviceAccountEmail: SA_EMAIL, source: 'env', oauthConfigured: false, connectUrl: '/api/integrations/google/connect' });
    expect(JSON.stringify(g.body)).not.toContain('PRIVATE KEY');
    const c = await call('createLeadSource', { name: 'S', type: 'google_sheet', config: { sheet: { spreadsheetUrl: URL1 } } });
    expect(c.status).toBe(403);
    expect((c.body as any).message).toMatch(/Google Sheets/);
  });

  it('with only googleSheets: sheet sources work, website sources are refused', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    const call = await session({ googleSheets: true, websiteApi: false });
    expect((await call('checkSheet', { spreadsheetUrl: URL1 })).status).toBe(200);
    const ok = await call('createLeadSource', { name: 'S', type: 'google_sheet', config: { sheet: { spreadsheetUrl: URL1 } } });
    expect(ok.status).toBe(200);
    const no = await call('createLeadSource', { name: 'W', type: 'website' });
    expect(no.status).toBe(403);
    const sync = await call('syncSheetImport', { sourceId: (ok.body as any).data.source.id });
    expect(sync.status).toBe(200);
  });
});

describe('super admin', () => {
  it('stores the service account encrypted and never returns the key', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const setup = await platformDispatch('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' }, { token: '', userAgent: 'vitest', ip: '10.0.0.1' });
    const pd = (action: string, data: any = {}) => platformDispatch(action, data, { token: setup.session!.token, userAgent: 'vitest', ip: '10.0.0.1' });

    expect((await pd('getGoogleSettings')).body).toMatchObject({ data: { configured: false, source: 'none', serviceAccountEmail: '' } });
    expect((await pd('setGoogleServiceAccount', { json: '{"type":"user"}' })).status).toBe(400);
    expect((await pd('testGoogleServiceAccount')).body).toMatchObject({ data: { ok: false } });

    const set = await pd('setGoogleServiceAccount', { json: SA_JSON });
    expect(set.status).toBe(200);
    expect((set.body as any).data).toMatchObject({ configured: true, source: 'platform', serviceAccountEmail: SA_EMAIL, projectId: 'amaya-test', updatedBy: 'Root <root@platform.io>' });
    expect(JSON.stringify(set.body)).not.toContain('PRIVATE KEY');
    const doc = await (await getClient())!.db(PLATFORM_DB()).collection('platformSettings').findOne({ _id: 'google' as any });
    expect(doc).toMatchObject({ clientEmail: SA_EMAIL, projectId: 'amaya-test' });
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain(privateKey.slice(40, 80));
    expect(String(doc!.serviceAccount).split('.')).toHaveLength(3);

    const got = await pd('getGoogleSettings');
    expect(JSON.stringify(got.body)).not.toContain('PRIVATE KEY');
    expect((got.body as any).data).toMatchObject({ configured: true, source: 'platform' });
    expect((await pd('testGoogleServiceAccount')).body).toMatchObject({ data: { ok: true } });
    expect(tokenRequests).toHaveLength(1);

    // company side sees the platform account
    expect(await inCo(() => SH.listSheetExports())).toEqual([]);
    const audit = await pd('auditLog', {});
    expect(JSON.stringify(audit.body)).toContain('Google Service Account Set');
    expect(JSON.stringify(audit.body)).not.toContain('PRIVATE KEY');

    // companySheets lists a company's links
    addFakeSheet(SID, 'writer', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    await sheetSource({ spreadsheetUrl: URL1 });
    const cs = await pd('companySheets', { companyId: 'CMP-test' });
    expect((cs.body as any).data.imports).toEqual([expect.objectContaining({ sourceId: 'SRC-0001', name: 'Sheet leads', spreadsheetUrl: URL1, status: 'Active' })]);

    const removed = await pd('setGoogleServiceAccount', { json: '' });
    expect((removed.body as any).data).toMatchObject({ configured: false, source: 'none' });
  });
});

describe('inbound endpoint', () => {
  it('refuses google_sheet sources even with a key that resolves to one', async () => {
    addFakeSheet(SID, 'reader', [{ title: 'Sheet1', rows: [['Name', 'Phone']] }]);
    const { source } = await sheetSource({ spreadsheetUrl: URL1 });
    const key = 'crm_live_' + 'a'.repeat(48);
    await (await getClient())!.db(PLATFORM_DB()).collection('apiKeys').insertOne({ _id: sha256Hex(key) as any, companyId: 'CMP-test', sourceId: source.id, createdAt: new Date() });
    const r = await inboundPOST(new Request('https://crm.example.com/api/inbound/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key }, body: JSON.stringify({ name: 'X', phone: '9876543210' }) }));
    expect(r.status).toBe(403);
    expect((await r.json()).message).toMatch(/Google Sheets/);
    expect(await leadsIn()).toHaveLength(0);
  });
});
