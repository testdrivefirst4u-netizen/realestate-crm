import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXPORT_HEADERS,
  DEFAULT_EXPORT_TAB,
  accessOptions,
  authLabel,
  authValue,
  checkSpreadsheetUrl,
  defaultAuth,
  googleErrorText,
  isConnectionInUse,
  normalizeAuth,
  optionForAuth,
  sameAuth,
  sheetsAccessConfigured,
  columnRows,
  emptyExportForm,
  exportFormFrom,
  exportFormToRequest,
  exportableHeaders,
  intervalLabel,
  moveHeader,
  sheetImportFormFrom,
  sheetImportToRequest,
  spreadsheetHref,
  syncResultText,
  toSyncInterval,
  toggleHeader,
} from '../src/modules/settings/sheets/sheetUtils';
import { emptyFormState, formStateFromSource, formToRequest } from '../src/modules/settings/leadSources/SourceForm';
import { TYPE_LABEL, TYPE_OPTIONS, defaultSourceLabel, usesApiKey } from '../src/modules/settings/leadSources/leadSourceUtils';
import type { LeadSource } from '../server/core/leadSourceTypes';
import type { GoogleConnection, GoogleStatus, SheetExport } from '../server/core/sheetTypes';
import { EMPTY_SETTINGS_LINK, hasSettingsLink, initialSettingsSection, parseSettingsLink, stripSettingsLinkParams } from '../src/modules/settings/meta/metaUtils';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy';
const URL_ = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`;

describe('sheets — spreadsheet URL', () => {
  it('accepts normal links, account links and bare ids', () => {
    expect(checkSpreadsheetUrl(URL_)).toEqual({ ok: true, id: ID, error: '' });
    expect(checkSpreadsheetUrl(`  docs.google.com/spreadsheets/d/${ID}  `).id).toBe(ID);
    expect(checkSpreadsheetUrl(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`).id).toBe(ID);
    expect(checkSpreadsheetUrl(ID).ok).toBe(true);
  });
  it('rejects empty, other hosts, publish-to-web and junk', () => {
    expect(checkSpreadsheetUrl('').ok).toBe(false);
    expect(checkSpreadsheetUrl('https://example.com/spreadsheets/d/' + ID).ok).toBe(false);
    expect(checkSpreadsheetUrl('https://docs.google.com/document/d/' + ID).ok).toBe(false);
    const pub = checkSpreadsheetUrl('https://docs.google.com/spreadsheets/d/e/2PACX-1vabc/pubhtml');
    expect(pub.ok).toBe(false);
    expect(pub.error).toMatch(/Publish to web/);
    expect(checkSpreadsheetUrl('not a link').ok).toBe(false);
    expect(checkSpreadsheetUrl('https://docs.google.com/spreadsheets/d/short/edit').ok).toBe(false);
  });
  it('builds an open link from the id or the url', () => {
    expect(spreadsheetHref('', ID)).toBe(`https://docs.google.com/spreadsheets/d/${ID}/edit`);
    expect(spreadsheetHref(URL_)).toBe(`https://docs.google.com/spreadsheets/d/${ID}/edit`);
    expect(spreadsheetHref('nonsense')).toBe('');
  });
});

describe('sheets — intervals and sync text', () => {
  it('coerces intervals', () => {
    expect(toSyncInterval('5')).toBe(5);
    expect(toSyncInterval(0)).toBe(0);
    expect(toSyncInterval(7)).toBe(15);
    expect(toSyncInterval(undefined, 60)).toBe(60);
    expect(intervalLabel(60)).toBe('Hourly');
    expect(intervalLabel(0)).toBe('Manual only');
  });
  it('summarises a sync', () => {
    expect(syncResultText({ created: 3, duplicates: 1, rejected: 0, failed: 0 })).toBe('3 new, 1 duplicate');
    expect(syncResultText({ created: 0, duplicates: 0, rejected: 2, failed: 1, message: 'Header row is empty' })).toBe('0 new, 2 rejected, 1 failed · Header row is empty');
    expect(syncResultText({ created: 2, duplicates: 0, rejected: 0, failed: 0, message: '2 new' })).toBe('2 new');
  });
});

describe('sheets — import form', () => {
  it('reads and validates the sheet part', () => {
    const f = sheetImportFormFrom({ spreadsheetUrl: URL_, tab: 'Leads', headerRow: 2, statusColumn: 'CRM', intervalMinutes: 60 } as any);
    // a saved import without auth uses the service account
    expect(f).toEqual({ spreadsheetUrl: URL_, tab: 'Leads', headerRow: 2, statusColumn: 'CRM', intervalMinutes: 60, auth: { mode: 'service_account' } });
    const r = sheetImportToRequest(f);
    expect(r.errors).toEqual([]);
    expect(r.sheet).toEqual({ spreadsheetUrl: URL_, tab: 'Leads', headerRow: 2, statusColumn: 'CRM', intervalMinutes: 60, auth: { mode: 'service_account' } });
    // a new form has no auth until the access options are known; nothing is sent then
    expect('auth' in sheetImportToRequest({ ...f, auth: undefined }).sheet).toBe(false);
    expect(sheetImportToRequest({ ...f, auth: { mode: 'oauth', connectionId: 'GCN-0001' } }).sheet.auth).toEqual({ mode: 'oauth', connectionId: 'GCN-0001' });
    expect(sheetImportFormFrom({ spreadsheetUrl: URL_, auth: { mode: 'oauth', connectionId: 'GCN-0002' } } as any).auth).toEqual({ mode: 'oauth', connectionId: 'GCN-0002' });
    expect(sheetImportFormFrom(null).auth).toBeUndefined();
    // server-owned fields are never sent
    expect('lastRow' in r.sheet).toBe(false);
    expect(sheetImportToRequest({ ...f, spreadsheetUrl: '' }).errors.length).toBe(1);
    expect(sheetImportToRequest({ ...f, headerRow: 0 }).errors).toContain('The header row must be a number from 1 to 1000.');
  });

  it('lead-source form → request for a google_sheet source (no origins, sheet config)', () => {
    const f = emptyFormState('google_sheet');
    expect(f.sourceLabel).toBe('Google Sheet');
    const bad = formToRequest({ ...f, name: 'Sheet' });
    expect(bad.errors.some((e) => /Google Sheet/.test(e))).toBe(true);
    const ok = formToRequest({
      ...f,
      name: ' Expo sheet ',
      origins: ['not-a-url'], // ignored for sheets
      mapRows: [{ from: 'Mobile', to: 'Phone Number' }],
      sheet: { spreadsheetUrl: URL_, tab: 'Form responses 1', headerRow: 1, statusColumn: '', intervalMinutes: 5, auth: { mode: 'oauth', connectionId: 'GCN-0001' } },
    });
    expect(ok.errors).toEqual([]);
    expect(ok.type).toBe('google_sheet');
    expect(ok.name).toBe('Expo sheet');
    expect(ok.config.allowedOrigins).toEqual([]);
    expect(ok.config.fieldMap).toEqual({ Mobile: 'Phone Number' });
    expect(ok.config.sheet).toEqual({ spreadsheetUrl: URL_, tab: 'Form responses 1', headerRow: 1, statusColumn: '', intervalMinutes: 5, auth: { mode: 'oauth', connectionId: 'GCN-0001' } });
  });

  it('website sources carry no sheet config', () => {
    const r = formToRequest({ ...emptyFormState('website'), name: 'Site' });
    expect(r.errors).toEqual([]);
    expect(r.config.sheet).toBeUndefined();
  });

  it('round-trips a saved google_sheet source', () => {
    const src = {
      id: 'SRC-0003', type: 'google_sheet', name: 'Expo', status: 'Active', keyPrefix: '',
      config: {
        sourceLabel: 'Expo sheet', defaultStage: 'New', assignment: { mode: 'unassigned', rm: '', rms: [] }, duplicates: 'remark', allowedOrigins: [], fieldMap: {},
        sheet: { spreadsheetUrl: URL_, spreadsheetId: ID, tab: 'Sheet1', headerRow: 3, statusColumn: 'Status', intervalMinutes: 0, lastRow: 12, lastSyncAt: '', lastSyncResult: '' },
      },
      stats: { received: 0, created: 0, duplicates: 0, rejected: 0, failed: 0, lastReceivedAt: '', lastError: '' },
      createdAt: '', createdBy: '',
    } as LeadSource;
    const f = formStateFromSource(src);
    expect(f.sheet).toEqual({ spreadsheetUrl: URL_, tab: 'Sheet1', headerRow: 3, statusColumn: 'Status', intervalMinutes: 0, auth: { mode: 'service_account' } });
    expect(formToRequest(f).config.sheet?.intervalMinutes).toBe(0);
  });

  it('labels the new type and knows it has no API key', () => {
    expect(TYPE_LABEL.google_sheet).toBe('Google Sheet');
    expect(TYPE_OPTIONS.map((t) => t.value)).toContain('google_sheet');
    expect(defaultSourceLabel('google_sheet')).toBe('Google Sheet');
    expect(usesApiKey('google_sheet')).toBe(false);
    expect(usesApiKey('website')).toBe(true);
  });
});

describe('sheets — export columns', () => {
  it('default columns come first in the chooser, without follow-up columns', () => {
    const all = exportableHeaders(['Custom Field', 'Follow-up 3', 'Email']);
    expect(all.slice(0, DEFAULT_EXPORT_HEADERS.length)).toEqual(DEFAULT_EXPORT_HEADERS);
    expect(all).toContain('Booking Date');
    expect(all[all.length - 1]).toBe('Custom Field');
    expect(all).not.toContain('Follow-up 3');
    expect(new Set(all).size).toBe(all.length);
  });
  it('lists chosen columns in order, then the rest', () => {
    const rows = columnRows(['Email', 'Enquiry ID'], ['Enquiry ID', 'Prospect Name', 'Email']);
    expect(rows).toEqual([
      { header: 'Email', checked: true, index: 0 },
      { header: 'Enquiry ID', checked: true, index: 1 },
      { header: 'Prospect Name', checked: false, index: -1 },
    ]);
  });
  it('toggles and moves columns', () => {
    expect(toggleHeader(['A', 'B'], 'C')).toEqual(['A', 'B', 'C']);
    expect(toggleHeader(['A', 'B'], 'A')).toEqual(['B']);
    expect(moveHeader(['A', 'B', 'C'], 2, -1)).toEqual(['A', 'C', 'B']);
    expect(moveHeader(['A', 'B', 'C'], 0, -1)).toEqual(['A', 'B', 'C']);
    expect(moveHeader(['A', 'B', 'C'], 2, 1)).toEqual(['A', 'B', 'C']);
  });
});

describe('sheets — export form', () => {
  it('has sensible defaults', () => {
    const f = emptyExportForm();
    expect(f.tab).toBe(DEFAULT_EXPORT_TAB);
    expect(f.headers).toEqual(DEFAULT_EXPORT_HEADERS);
    expect(f.headers[0]).toBe('Enquiry ID');
    expect(f.headers).toContain('Last Follow-up Date & Time');
    expect(f.intervalMinutes).toBe(15);
    expect(f.includeFollowups).toBe(false);
    expect(f.includeTrash).toBe(false);
  });
  it('validates and builds the request', () => {
    const bad = exportFormToRequest({ ...emptyExportForm(), headers: [], tab: 'a/b' });
    expect(bad.errors).toEqual(expect.arrayContaining(['Give the export a name.', 'Choose at least one column.', 'The tab name cannot contain [ ] * ? : \\ or /.']));
    expect(bad.errors.length).toBe(4); // + missing link
    const ok = exportFormToRequest({ ...emptyExportForm(), name: ' Report ', spreadsheetUrl: URL_, tab: '  ', headers: ['Email', 'Email', 'Enquiry ID'], includeFollowups: true, intervalMinutes: 60 });
    expect(ok.errors).toEqual([]);
    expect(ok.req).toEqual({
      name: 'Report',
      spreadsheetUrl: URL_,
      tab: DEFAULT_EXPORT_TAB,
      columns: { headers: ['Email', 'Enquiry ID'], includeFollowups: true, includeTrash: false },
      intervalMinutes: 60,
    });
    const withAuth = exportFormToRequest({ ...emptyExportForm(), name: 'R', spreadsheetUrl: URL_, auth: { mode: 'oauth', connectionId: 'GCN-0001' } });
    expect(withAuth.req.auth).toEqual({ mode: 'oauth', connectionId: 'GCN-0001' });
    expect(emptyExportForm().auth).toBeUndefined();
  });
  it('reads an existing export', () => {
    const x = {
      id: 'SHX-0001', name: 'Mgmt', spreadsheetUrl: URL_, spreadsheetId: ID, tab: 'Leads',
      columns: { headers: ['Prospect Name'], includeFollowups: true, includeTrash: true }, intervalMinutes: 0, status: 'Paused',
      lastSyncAt: '', lastRows: 0, lastError: '', createdAt: '', createdBy: '',
    } as SheetExport;
    expect(exportFormFrom(x)).toEqual({ name: 'Mgmt', spreadsheetUrl: URL_, tab: 'Leads', headers: ['Prospect Name'], includeFollowups: true, includeTrash: true, intervalMinutes: 0, auth: { mode: 'service_account' } });
    expect(exportFormFrom({ ...x, auth: { mode: 'oauth', connectionId: 'GCN-0003' } }).auth).toEqual({ mode: 'oauth', connectionId: 'GCN-0003' });
    expect(exportFormFrom({ ...x, columns: { headers: [], includeFollowups: false, includeTrash: false } }).headers).toEqual(DEFAULT_EXPORT_HEADERS);
  });
});

/* ------------------------- Connect with Google ---------------------------- */

const conn = (id: string, email: string, status: 'Active' | 'Error' = 'Active', usedBy = 0): GoogleConnection => ({
  id, email, status, lastError: status === 'Error' ? 'Google access was revoked — reconnect' : '', connectedBy: 'Asha', connectedAt: '2026-10-01T10:00:00Z', usedBy,
});
const status = (p: Partial<GoogleStatus> = {}): GoogleStatus => ({
  configured: true, serviceAccountEmail: 'crm@platform.iam.gserviceaccount.com', source: 'platform', oauthConfigured: true, connectUrl: '/api/integrations/google/connect', ...p,
});

describe('sheets — access options', () => {
  it('knows whether any access is set up', () => {
    expect(sheetsAccessConfigured(null)).toBe(false);
    expect(sheetsAccessConfigured(status({ configured: false, oauthConfigured: false }))).toBe(false);
    expect(sheetsAccessConfigured(status({ configured: false }))).toBe(true);
    expect(sheetsAccessConfigured(status({ oauthConfigured: false }))).toBe(true);
  });

  it('lists Active connections, then the service account', () => {
    const opts = accessOptions(status(), [conn('GCN-0001', 'a@x.com'), conn('GCN-0002', 'b@x.com', 'Error'), conn('GCN-0003', 'c@x.com')]);
    expect(opts.map((o) => o.label)).toEqual([
      'Google account: a@x.com',
      'Google account: c@x.com',
      'Platform service account (share with crm@platform.iam.gserviceaccount.com)',
    ]);
    expect(opts.map((o) => o.value)).toEqual(['oauth:GCN-0001', 'oauth:GCN-0003', 'service_account']);
    expect(opts[0].auth).toEqual({ mode: 'oauth', connectionId: 'GCN-0001' });
    expect(opts[0].email).toBe('a@x.com');
    expect(opts[2].email).toBe('crm@platform.iam.gserviceaccount.com');
  });

  it('omits the service account when it is not configured, and connections when there are none', () => {
    expect(accessOptions(status({ configured: false, serviceAccountEmail: '' }), [conn('GCN-0001', 'a@x.com')]).map((o) => o.value)).toEqual(['oauth:GCN-0001']);
    expect(accessOptions(status(), null).map((o) => o.value)).toEqual(['service_account']);
    expect(accessOptions(status({ configured: false, oauthConfigured: false }), [])).toEqual([]);
  });

  it('keeps the current access of an existing link, even when it is no longer usable', () => {
    const broken = accessOptions(status(), [conn('GCN-0002', 'b@x.com', 'Error')], { mode: 'oauth', connectionId: 'GCN-0002' });
    expect(broken[0]).toMatchObject({ value: 'oauth:GCN-0002', unavailable: true });
    expect(broken[0].label).toMatch(/needs reconnecting/);
    const gone = accessOptions(status(), [], { mode: 'oauth', connectionId: 'GCN-0009' });
    expect(gone[0]).toMatchObject({ value: 'oauth:GCN-0009', unavailable: true });
    const saGone = accessOptions(status({ configured: false, serviceAccountEmail: '' }), [conn('GCN-0001', 'a@x.com')], { mode: 'service_account' });
    expect(saGone.find((o) => o.value === 'service_account')).toMatchObject({ unavailable: true });
  });

  it('defaults to the first Active connection, else the service account', () => {
    expect(defaultAuth(accessOptions(status(), [conn('GCN-0002', 'b@x.com', 'Error'), conn('GCN-0001', 'a@x.com'), conn('GCN-0003', 'c@x.com')]))).toEqual({ mode: 'oauth', connectionId: 'GCN-0001' });
    expect(defaultAuth(accessOptions(status(), [conn('GCN-0002', 'b@x.com', 'Error')]))).toEqual({ mode: 'service_account' });
    expect(defaultAuth(accessOptions(status(), []))).toEqual({ mode: 'service_account' });
    expect(defaultAuth(accessOptions(status({ configured: false }), [conn('GCN-0002', 'b@x.com', 'Error')]))).toBeNull();
    expect(defaultAuth([])).toBeNull();
  });

  it('normalises, compares and labels auth', () => {
    expect(normalizeAuth(undefined)).toEqual({ mode: 'service_account' });
    expect(normalizeAuth({ mode: 'oauth', connectionId: '' })).toEqual({ mode: 'service_account' });
    expect(authValue({ mode: 'oauth', connectionId: 'GCN-0001' })).toBe('oauth:GCN-0001');
    expect(authValue(null)).toBe('service_account');
    expect(sameAuth(undefined, { mode: 'service_account' })).toBe(true);
    expect(sameAuth({ mode: 'oauth', connectionId: 'GCN-0001' }, { mode: 'oauth', connectionId: 'GCN-0002' })).toBe(false);
    const conns = [conn('GCN-0001', 'a@x.com')];
    expect(authLabel(undefined, conns)).toBe('Service account');
    expect(authLabel({ mode: 'oauth', connectionId: 'GCN-0001' }, conns)).toBe('Google account: a@x.com');
    expect(authLabel({ mode: 'oauth', connectionId: 'GCN-0009' }, conns)).toBe('Google account');
    const opts = accessOptions(status(), conns);
    expect(optionForAuth(opts, { mode: 'service_account' })?.value).toBe('service_account');
    expect(optionForAuth(opts, null)).toBeNull();
  });

  it('recognises a disconnect refused because the account is in use', () => {
    expect(isConnectionInUse({ code: 'CONFLICT' })).toBe(true);
    expect(isConnectionInUse({ code: 'FORBIDDEN' })).toBe(false);
    expect(isConnectionInUse(null)).toBe(false);
  });
});

describe('sheets — return from Connect with Google (URL parameters)', () => {
  it('reads googleConnected and googleError', () => {
    expect(parseSettingsLink('?section=googleSheets&googleConnected=GCN-0001')).toEqual({ ...EMPTY_SETTINGS_LINK, section: 'googleSheets', googleConnected: 'GCN-0001' });
    expect(parseSettingsLink('section=googleSheets&googleError=Google%20sign-in%20was%20cancelled')).toEqual({
      ...EMPTY_SETTINGS_LINK, section: 'googleSheets', googleError: 'Google sign-in was cancelled',
    });
  });
  it('drops values that cannot be a connection id and caps the error', () => {
    expect(parseSettingsLink('?googleConnected=a/../b').googleConnected).toBeNull();
    expect(parseSettingsLink('?googleConnected=%20').googleConnected).toBeNull();
    expect(parseSettingsLink('?googleError=' + 'x'.repeat(1000)).googleError).toHaveLength(300);
  });
  it('removes the Google parameters from the URL and keeps the others', () => {
    expect(stripSettingsLinkParams('?section=googleSheets&googleConnected=GCN-0001')).toBe('');
    expect(stripSettingsLinkParams('?lead=ENQ-1&googleError=denied&x=1')).toBe('?lead=ENQ-1&x=1');
  });
  it('counts as a link and opens the Google Sheets section', () => {
    const ids = ['sync', 'leadSources', 'googleSheets'] as const;
    expect(hasSettingsLink({ ...EMPTY_SETTINGS_LINK, googleConnected: 'GCN-0001' })).toBe(true);
    expect(hasSettingsLink({ ...EMPTY_SETTINGS_LINK, googleError: 'x' })).toBe(true);
    expect(initialSettingsSection(parseSettingsLink('?section=googleSheets'), ids, 'sync')).toBe('googleSheets');
    expect(initialSettingsSection(parseSettingsLink('?section=googlesheets'), ids, 'sync')).toBe('googleSheets');
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, googleConnected: 'GCN-0001' }, ids, 'sync')).toBe('googleSheets');
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, googleError: 'x' }, ids, 'sync')).toBe('googleSheets');
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, googleError: 'x' }, ['sync'] as const, 'sync')).toBe('sync');
  });
  it('explains Google errors in plain words', () => {
    expect(googleErrorText('access_denied')).toMatch(/cancelled/);
    expect(googleErrorText('Invalid state')).toMatch(/session/);
    expect(googleErrorText('Something else')).toBe('Something else');
    expect(googleErrorText(null)).toBe('');
  });
});
