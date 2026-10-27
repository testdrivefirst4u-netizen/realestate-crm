/** JustConnect step 3: leads as contacts (caller names), outcomes both ways, the call report. Fetch is faked. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { setSecret, updateSettings } from '../server/core/settings';
import type { Ctx } from '../server/core/auth';
import { addLead, getLead, updateLead } from '../server/modules/leads';
import { ingestJcCall, type JcCall } from '../server/modules/jcCalls';
import { contactFor, jcCallReport, jcFileOutcome, remarkFromJcOutcome, syncContacts } from '../server/modules/jcSync';

const L = CFG.LEAD;
let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx, priya: Ctx;
let sent: Array<{ method: string; path: string; body: any }> = [];
let refuse = new Set<string>();

const OUTCOMES = [
  { code: 'INTERESTED', label: 'Interested', parent: null, positive: true, needsNote: false },
  { code: 'CALL_BACK', label: 'Call back later', parent: null, positive: false, needsNote: true },
];

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
  priya = await t.ctx('RM', 'Priya Sharma');
  sent = [];
  refuse = new Set();
  await setSecret('JUSTCONNECT_API_KEY', 'jc_key', admin);
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v1', '') + u.search;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/contacts' && method === 'POST') return refuse.has(body.phone) ? json(400, { error: 'Use a 10-digit Indian phone number.' }) : json(201, { contact: { id: 'c1' }, created: true });
    if (path === '/outcomes') return json(200, { items: OUTCOMES });
    if (path === '/agents') return json(200, { items: [{ id: 'ag1', name: 'Priya S', role: 'agent', extension: '1002', email: priya.user!.email, loginId: 'P', status: 'online', canCallOut: true }] });
    if (path.startsWith('/call-logs/') && method === 'PATCH') return json(200, { call: {} });
    if (path.startsWith('/reports/calls')) {
      return json(200, {
        timezone: 'Asia/Kolkata',
        totals: { calls: 40, inbound: 25, outbound: 15, answered: 22, missed: 9, notAnswered: 6, talkSeconds: 5400, avgTalkSeconds: 245, avgSpeedOfAnswerSeconds: 9, answerRate: 55, abandonRate: 12.5, serviceLevel: 80 },
        byDay: [{ date: '2026-10-27', calls: 40, answered: 22, missed: 9, notAnswered: 6, talkSeconds: 5400 }],
        byAgent: [{ agent: { id: 'ag1', name: 'Priya S', extension: '1002' }, calls: 30, answered: 18, missed: 5, notAnswered: 4, talkSeconds: 4300, avgTalkSeconds: 239 }],
      });
    }
    return json(404, { error: 'no' });
  });
});
afterEach(() => vi.unstubAllGlobals());

const contactsSent = () => sent.filter((x) => x.path === '/contacts' && x.method === 'POST');

describe('contacts (caller names)', () => {
  it('sends a lead as name, phone, stage, unit, source and RM', () => {
    expect(contactFor({ _id: 'ENQ-0007', name: 'Meera Kapoor', phone: '9876543210', email: 'm@x.in', stage: 'Hot', source: 'Facebook', unitType: '2.5 BHK', assignedRm: 'Priya Sharma' })).toMatchObject({
      name: 'Meera Kapoor', phone: '9876543210', email: 'm@x.in', company: 'Hot · 2.5 BHK',
      fields: { 'CRM ID': 'ENQ-0007', Stage: 'Hot', 'Interested in': '2.5 BHK', Source: 'Facebook', RM: 'Priya Sharma' },
    });
  });

  it('sends every live lead once, again after a change, never a refused number every run, and nothing when off', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876543210' }, admin);
    await addLead({ [L.NAME]: 'Ravi', [L.PHONE]: '9876500002' }, admin);
    await addLead({ [L.NAME]: 'Bad number', [L.PHONE]: '1234567890' }, admin);
    refuse.add('1234567890');
    let r = await syncContacts({ gapMs: 0 });
    expect(r).toMatchObject({ sent: 2, failed: 1, left: 0 });
    expect(contactsSent().map((x) => x.body.name).sort()).toEqual(['Bad number', 'Meera', 'Ravi']);

    sent = [];
    expect(await syncContacts({ gapMs: 0 })).toMatchObject({ sent: 0, failed: 0 });

    await new Promise((res) => setTimeout(res, 5));
    await updateLead(lead[L.ID], { [L.STAGE]: 'Hot' }, admin);
    r = await syncContacts({ gapMs: 0 });
    expect(r.sent).toBe(1);
    expect(contactsSent()[0].body.fields.Stage).toBe('Hot');

    await updateSettings({ jcContactSync: false } as any, admin);
    expect(await syncContacts({ gapMs: 0 })).toMatchObject({ skipped: 'off' });
  });
});

const jcCall = (o: Partial<JcCall> = {}): JcCall => ({
  id: 'jc1', direction: 'outbound', status: 'answered', customer: '9876543210', agent: { id: 'ag1', name: 'Priya S' }, rang: [],
  startedAt: '2026-10-27T09:00:00.000Z', endedAt: '2026-10-27T09:03:00.000Z', talkSeconds: 180, recording: null, voicemail: null, outcome: null, notes: null, ref: null, updatedAt: '2026-10-27T09:04:00.000Z', ...o,
});

describe('outcomes both ways', () => {
  it('the outcome an agent filed in JustConnect becomes one remark on the lead', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ outcome: 'INTERESTED', notes: 'Visiting Saturday', ref: lead[L.ID] }));
    expect(await remarkFromJcOutcome(callId)).toBe(true);
    expect(await remarkFromJcOutcome(callId)).toBe(false);
    const after = await getLead(lead[L.ID]);
    expect(JSON.stringify(after)).toContain('Call · 3 min · Interested — Visiting Saturday');
  });

  it('an outcome filed in the CRM goes to JustConnect, onto the call and into the remarks; a "note needed" outcome needs one', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Ravi', [L.PHONE]: '9876500002', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ id: 'jc2', customer: '9876500002', ref: lead[L.ID] }));
    await expect(jcFileOutcome({ callId, outcome: 'CALL_BACK' }, priya)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(jcFileOutcome({ callId, outcome: 'NOPE' }, priya)).rejects.toMatchObject({ code: 'VALIDATION' });
    const c = await jcFileOutcome({ callId, outcome: 'CALL_BACK', notes: 'Ring after 6 pm' }, priya);
    expect(c).toMatchObject({ outcome: 'Call back later', notes: 'Ring after 6 pm' });
    expect(sent.find((x) => x.method === 'PATCH')).toMatchObject({ path: '/call-logs/jc2', body: { outcome: 'CALL_BACK', notes: 'Ring after 6 pm' } });
    expect(JSON.stringify(await getLead(lead[L.ID]))).toContain('Call back later — Ring after 6 pm');
    // not remarked twice by the background step
    expect(await remarkFromJcOutcome(callId)).toBe(false);
  });

  it('an RM cannot file on a call of a lead they cannot see', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Other', [L.PHONE]: '9876500003', [L.RM]: 'Asha Admin' }, admin);
    const { callId } = await ingestJcCall(jcCall({ id: 'jc3', customer: '9876500003', ref: lead[L.ID] }));
    await expect(jcFileOutcome({ callId, outcome: 'INTERESTED' }, priya)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
  });
});

describe('call report', () => {
  it('passes JustConnect\'s figures through with agents under their CRM names; at most 92 days', async () => {
    const r = await jcCallReport({ since: '2026-10-26T18:30:00.000Z', until: '2026-10-27T18:30:00.000Z' });
    expect(r.totals).toMatchObject({ calls: 40, answered: 22, missed: 9, answerRate: 55, avgTalkSeconds: 245 });
    expect(r.byAgent[0]).toMatchObject({ name: 'Priya Sharma', calls: 30, talkSeconds: 4300 });
    expect(sent.find((x) => x.path.startsWith('/reports/calls'))!.path).toContain('since=2026-10-26T18%3A30%3A00.000Z');
    await expect(jcCallReport({ since: '2026-01-01T00:00:00Z', until: '2026-10-01T00:00:00Z' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('leads collection stays clean', () => {
  it('marking a lead as sent does not change its "updated" time', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876543210' }, admin);
    const before = (await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: lead[L.ID] })).updatedAt;
    await syncContacts({ gapMs: 0 });
    const doc = await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: lead[L.ID] });
    expect(doc.updatedAt).toEqual(before);
    expect(doc.jcContactAt).toBeTruthy();
  });
});
