import { describe, it, expect } from 'vitest';
import {
  BACKFILL_DAYS,
  EMPTY_SETTINGS_LINK,
  backfillResultText,
  buildConnectRequest,
  connectResultText,
  facebookPageUrl,
  formFilterFrom,
  formFilterToIds,
  formNames,
  formsSummary,
  hasSettingsLink,
  initialChoices,
  initialSettingsSection,
  isPendingGone,
  metaErrorText,
  needsReconnect,
  pageSelectability,
  parseSettingsLink,
  stripSettingsLinkParams,
  type ConnectDefaults,
} from '../src/modules/settings/meta/metaUtils';
import { TYPE_LABEL, TYPE_OPTIONS, allowedTypeOptions, defaultSourceLabel, usesApiKey, usesOrigins } from '../src/modules/settings/leadSources/leadSourceUtils';
import { emptyFormState, formStateFromSource, formToRequest } from '../src/modules/settings/leadSources/SourceForm';
import type { MetaPendingPage } from '../server/core/metaTypes';
import type { LeadSource } from '../server/core/leadSourceTypes';

const page = (over: Partial<MetaPendingPage> = {}): MetaPendingPage => ({
  id: '111',
  name: 'Amaya Living',
  canReadLeads: true,
  claimedElsewhere: false,
  alreadyConnected: false,
  forms: [
    { id: 'f1', name: 'Brochure request', status: 'ACTIVE' },
    { id: 'f2', name: 'Site visit', status: 'ACTIVE' },
  ],
  ...over,
});

const DEFAULTS: ConnectDefaults = { sourceLabel: 'Facebook', defaultStage: 'New', assignmentMode: 'unassigned', rm: '', rms: [], duplicates: 'remark' };

describe('meta — settings URL parameters', () => {
  it('reads section, metaConnect and metaError', () => {
    expect(parseSettingsLink('?section=leadSources&metaConnect=abc_123-X')).toEqual({ ...EMPTY_SETTINGS_LINK, section: 'leadSources', metaConnect: 'abc_123-X' });
    expect(parseSettingsLink('section=leadSources&metaError=Facebook%20login%20was%20cancelled')).toEqual({ ...EMPTY_SETTINGS_LINK, section: 'leadSources', metaError: 'Facebook login was cancelled' });
    expect(parseSettingsLink('')).toEqual(EMPTY_SETTINGS_LINK);
    expect(parseSettingsLink('?lead=ENQ-0001')).toEqual(EMPTY_SETTINGS_LINK);
  });
  it('drops values that cannot be a section or a pending id', () => {
    expect(parseSettingsLink('?section=<script>&metaConnect=a/b').section).toBeNull();
    expect(parseSettingsLink('?metaConnect=a/../b').metaConnect).toBeNull();
    expect(parseSettingsLink('?metaConnect=%20%20').metaConnect).toBeNull();
    expect(parseSettingsLink(`?metaError=${'x'.repeat(1000)}`).metaError).toHaveLength(300);
  });
  it('removes only the settings parameters and keeps the others in order', () => {
    expect(stripSettingsLinkParams('?section=leadSources&metaConnect=abc')).toBe('');
    expect(stripSettingsLinkParams('?lead=ENQ-1&section=leadSources&metaError=x&tab=2')).toBe('?lead=ENQ-1&tab=2');
    expect(stripSettingsLinkParams('')).toBe('');
    expect(stripSettingsLinkParams('?lead=ENQ-1')).toBe('?lead=ENQ-1');
  });
  it('knows whether a link carries anything', () => {
    expect(hasSettingsLink(EMPTY_SETTINGS_LINK)).toBe(false);
    expect(hasSettingsLink(null)).toBe(false);
    expect(hasSettingsLink({ ...EMPTY_SETTINGS_LINK, metaError: 'x' })).toBe(true);
  });
  it('picks the section to open', () => {
    const ids = ['sync', 'integrations', 'leadSources'] as const;
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, section: 'leadSources' }, ids, 'sync')).toBe('leadSources');
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, section: 'leadsources' }, ids, 'sync')).toBe('leadSources');
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, section: 'nope' }, ids, 'sync')).toBe('sync');
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, metaConnect: 'p1' }, ids, 'sync')).toBe('leadSources');
    expect(initialSettingsSection({ ...EMPTY_SETTINGS_LINK, metaError: 'x' }, ids, 'sync')).toBe('leadSources');
    expect(initialSettingsSection(null, ids, 'sync')).toBe('sync');
  });
  it('explains Facebook errors in plain words', () => {
    expect(metaErrorText('access_denied')).toMatch(/Facebook login was cancelled/);
    expect(metaErrorText('User cancelled the login')).toMatch(/cancelled/);
    expect(metaErrorText('Invalid state')).toMatch(/session/);
    expect(metaErrorText('Something else broke')).toBe('Something else broke');
    expect(metaErrorText('')).toBe('');
    expect(metaErrorText(null)).toBe('');
  });
});

describe('meta — page selection', () => {
  it('allows a readable, unclaimed, unconnected Page', () => {
    expect(pageSelectability(page())).toEqual({ selectable: true, reason: '' });
  });
  it('blocks claimed, connected and unreadable Pages with a reason', () => {
    expect(pageSelectability(page({ claimedElsewhere: true }))).toEqual({ selectable: false, reason: expect.stringMatching(/another workspace/) });
    expect(pageSelectability(page({ alreadyConnected: true }))).toEqual({ selectable: false, reason: expect.stringMatching(/Already connected/) });
    expect(pageSelectability(page({ canReadLeads: false })).reason).toMatch(/full control or advertiser access/);
    // Already connected wins over the other reasons (it is the most useful to know).
    expect(pageSelectability(page({ alreadyConnected: true, claimedElsewhere: true })).reason).toMatch(/Already connected/);
  });
  it('pre-ticks the only selectable Page', () => {
    const pages = [page(), page({ id: '222', claimedElsewhere: true })];
    expect(initialChoices(pages)).toEqual({ '111': { checked: true, allForms: true, formIds: [] }, '222': { checked: false, allForms: true, formIds: [] } });
    const two = [page(), page({ id: '333' })];
    expect(Object.values(initialChoices(two)).every((c) => !c.checked)).toBe(true);
  });
});

describe('meta — connect request', () => {
  it('builds pages with form filters and the shared defaults', () => {
    const pages = [page(), page({ id: '222', name: 'Second' })];
    const r = buildConnectRequest('pend1', pages, {
      '111': { checked: true, allForms: true, formIds: ['f1'] },
      '222': { checked: true, allForms: false, formIds: ['f2', 'f2', 'gone'] },
    }, { ...DEFAULTS, sourceLabel: '  Meta Ads ', assignmentMode: 'round_robin', rms: ['Asha'], rm: 'ignored' });
    expect(r.errors).toEqual([]);
    expect(r.req).toEqual({
      pendingId: 'pend1',
      pages: [{ pageId: '111', formIds: [] }, { pageId: '222', formIds: ['f2'] }],
      defaults: { sourceLabel: 'Meta Ads', assignment: { mode: 'round_robin', rm: '', rms: ['Asha'] }, duplicates: 'remark', defaultStage: 'New' },
    });
  });
  it('skips unticked and unselectable Pages', () => {
    const pages = [page(), page({ id: '222', claimedElsewhere: true })];
    const r = buildConnectRequest('p', pages, { '111': { checked: true, allForms: true, formIds: [] }, '222': { checked: true, allForms: true, formIds: [] } }, DEFAULTS);
    expect(r.req.pages.map((p) => p.pageId)).toEqual(['111']);
  });
  it('reports missing choices', () => {
    expect(buildConnectRequest('p', [page()], {}, DEFAULTS).errors).toContain('Choose at least one Page to connect.');
    expect(buildConnectRequest('p', [page()], { '111': { checked: true, allForms: false, formIds: [] } }, DEFAULTS).errors[0]).toMatch(/choose at least one form/);
    expect(buildConnectRequest('p', [page()], { '111': { checked: true, allForms: true, formIds: [] } }, { ...DEFAULTS, assignmentMode: 'fixed' }).errors).toContain('Choose the RM who receives the leads.');
    expect(buildConnectRequest('', [page()], { '111': { checked: true, allForms: true, formIds: [] } }, DEFAULTS).errors[0]).toMatch(/missing/);
  });
  it('falls back to the Facebook label', () => {
    expect(buildConnectRequest('p', [page()], { '111': { checked: true, allForms: true, formIds: [] } }, { ...DEFAULTS, sourceLabel: ' ' }).req.defaults?.sourceLabel).toBe('Facebook');
  });
  it('summarises the result', () => {
    expect(connectResultText({ created: ['SRC-1'], skipped: [] }).tone).toBe('success');
    const mixed = connectResultText({ created: ['SRC-1'], skipped: [{ pageId: '222', reason: 'claimed' }] }, [page({ id: '222', name: 'Second' })]);
    expect(mixed.tone).toBe('warning');
    expect(mixed.message).toBe('Second: claimed');
    expect(connectResultText({ created: [], skipped: [{ pageId: '9', reason: 'no access' }] }).tone).toBe('alert');
  });
  it('recognises an expired pending connection', () => {
    expect(isPendingGone({ code: 'NOT_FOUND' })).toBe(true);
    expect(isPendingGone({ code: 'VALIDATION', userMessage: 'This Facebook connection has expired' })).toBe(true);
    expect(isPendingGone({ code: 'SERVER', message: 'boom' })).toBe(false);
    expect(isPendingGone(null)).toBe(false);
  });
});

describe('meta — source helpers', () => {
  it('summarises the form filter', () => {
    expect(formsSummary({ formIds: [] })).toBe('All forms');
    expect(formsSummary(undefined)).toBe('All forms');
    expect(formsSummary({ formIds: ['a'] })).toBe('1 form');
    expect(formsSummary({ formIds: ['a', 'b'] })).toBe('2 forms');
    expect(formNames({ formIds: ['f1', 'x'], forms: page().forms })).toEqual(['Brochure request', 'x']);
  });
  it('converts the form filter both ways', () => {
    expect(formFilterFrom({ formIds: [] })).toEqual({ allForms: true, formIds: [] });
    expect(formFilterFrom({ formIds: ['f1'] })).toEqual({ allForms: false, formIds: ['f1'] });
    expect(formFilterToIds({ allForms: true, formIds: ['f1'] })).toEqual({ formIds: [], error: '' });
    expect(formFilterToIds({ allForms: false, formIds: ['f1', 'f1'] })).toEqual({ formIds: ['f1'], error: '' });
    expect(formFilterToIds({ allForms: false, formIds: [] }).error).toMatch(/at least one/);
  });
  it('links the Page and spots expired connections', () => {
    expect(facebookPageUrl('12345')).toBe('https://facebook.com/12345');
    expect(needsReconnect('Error validating access token: Session has expired on Friday')).toBe(true);
    expect(needsReconnect('The Facebook connection expired — reconnect the Page')).toBe(true);
    expect(needsReconnect('Lead form not found')).toBe(false);
    expect(needsReconnect('')).toBe(false);
  });
  it('describes a backfill', () => {
    expect(BACKFILL_DAYS).toEqual([1, 3, 7, 14, 30]);
    expect(backfillResultText({ created: 2, duplicates: 5, rejected: 0, failed: 0, message: '' })).toEqual({ message: '2 new, 5 already in the CRM', tone: 'success' });
    expect(backfillResultText({ created: 0, duplicates: 0, rejected: 1, failed: 1, message: '' }).tone).toBe('warning');
    expect(backfillResultText({ created: 0, duplicates: 3, rejected: 0, failed: 0, message: 'Done' })).toEqual({ message: '0 new, 3 already in the CRM — Done', tone: 'info' });
  });
});

describe('meta — lead source type', () => {
  it('is keyless, has no origins and is not offered in the add form', () => {
    expect(TYPE_LABEL.meta).toBe('Facebook / Instagram');
    expect(defaultSourceLabel('meta')).toBe('Facebook');
    expect(usesApiKey('meta')).toBe(false);
    expect(usesOrigins('meta')).toBe(false);
    expect(usesOrigins('website')).toBe(true);
    expect(TYPE_OPTIONS.map((t) => t.value)).not.toContain('meta');
  });
  it('offers only the types the plan allows', () => {
    expect(allowedTypeOptions({ apiEnabled: true, sheetsEnabled: false }).map((t) => t.value)).toEqual(['website', 'webhook']);
    expect(allowedTypeOptions({ apiEnabled: false, sheetsEnabled: true }).map((t) => t.value)).toEqual(['google_sheet']);
    expect(allowedTypeOptions({ apiEnabled: false, sheetsEnabled: false })).toEqual([]);
  });
  it('saves a Meta source without allowed websites', () => {
    const src: LeadSource = {
      id: 'SRC-0009', type: 'meta', name: 'Facebook – Amaya', status: 'Active', keyPrefix: '',
      config: {
        sourceLabel: 'Facebook', defaultStage: 'New', assignment: { mode: 'unassigned', rm: '', rms: [] }, duplicates: 'remark', allowedOrigins: ['https://x.com'], fieldMap: {},
        meta: { pageId: '111', pageName: 'Amaya', formIds: [], forms: [], connectedBy: 'a', connectedAt: '', subscribed: true, lastLeadAt: '', lastBackfillAt: '', lastError: '' },
      },
      stats: { received: 0, created: 0, duplicates: 0, rejected: 0, failed: 0, lastReceivedAt: '', lastError: '' },
      createdAt: '', createdBy: '',
    };
    const f = formStateFromSource(src);
    f.origins = ['not a url'];
    const r = formToRequest(f);
    expect(r.errors).toEqual([]);
    expect(r.config.allowedOrigins).toEqual([]);
    expect(formToRequest({ ...emptyFormState('meta'), name: 'X' }).config.sourceLabel).toBe('Facebook');
  });
});
