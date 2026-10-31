/** Record-level access (RMs see their own leads) and append-only follow-up history, through the real API router. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { settingSet } from '../server/core/settings';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.1.1.1' };
const tokens: Record<string, string> = {};

async function signIn(name: string, role: 'Admin' | 'Manager' | 'RM') {
  const email = name.toLowerCase().replace(/\s+/g, '.') + '@scope.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;
const leadIds = (body: any) => (body.data.leads as any[]).map((l) => l['Enquiry ID']).sort();

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.reset();
  await signIn('Asha', 'RM');
  await signIn('Ravi', 'RM');
  await signIn('Meera', 'Manager');
  // Asha's, Ravi's and an unassigned lead
  for (const [name, phone, rm] of [['Asha Lead', '9000000001', 'Asha'], ['Ravi Lead', '9000000002', 'Ravi'], ['Fresh Lead', '9000000003', '']]) {
    const r = await as('Meera', 'addLead', { data: { 'Prospect Name': name, 'Phone Number': phone, 'Assigned RM': rm } });
    expect(r.status).toBe('success');
  }
});

describe('lead visibility', () => {
  it('Agents see only their own leads by default; managers see everything', async () => {
    expect(leadIds(await as('Asha', 'getAllLeads'))).toEqual(['ENQ-0001']);
    expect(leadIds(await as('Ravi', 'getAllLeads'))).toEqual(['ENQ-0002']);
    expect(leadIds(await as('Meera', 'getAllLeads'))).toEqual(['ENQ-0001', 'ENQ-0002', 'ENQ-0003']);
    const boot = await as('Asha', 'getBootstrap');
    expect(boot.data.leads.leads.map((l: any) => l['Prospect Name']).sort()).toEqual(['Asha Lead']);
  });

  it("'own_unassigned' adds unassigned leads; 'all' restores the old behaviour", async () => {
    await settingSet('rmLeadVisibility', 'own_unassigned', 'test');
    expect(leadIds(await as('Asha', 'getAllLeads'))).toEqual(['ENQ-0001', 'ENQ-0003']);
    await settingSet('rmLeadVisibility', 'all', 'test');
    expect(leadIds(await as('Asha', 'getAllLeads'))).toHaveLength(3);
  });

  it("an RM cannot open, edit, remark, re-stage or read the timeline of another RM's lead", async () => {
    for (const [action, data] of [
      ['getLeadTimeline', { id: 'ENQ-0002' }],
      ['updateLead', { id: 'ENQ-0002', data: { 'Enquiry Notes': 'x' } }],
      ['appendRemark', { id: 'ENQ-0002', remark: 'hello' }],
      ['setLeadStage', { id: 'ENQ-0002', stage: 'Hot' }],
      ['listLeadFiles', { leadId: 'ENQ-0002' }],
      ['getCalls', { leadId: 'ENQ-0002' }],
      ['addTask', { data: { name: 'steal', leadId: 'ENQ-0002' } }],
    ] as const) {
      const r = await as('Asha', action, data);
      expect(r, action).toMatchObject({ status: 'error', code: 'NOT_FOUND' });
    }
    expect((await as('Asha', 'appendRemark', { id: 'ENQ-0001', remark: 'my own lead' })).status).toBe('success');
  });

  it("renaming cannot widen what an RM sees: no 'System', no other RM's name, and RMs cannot rename themselves", async () => {
    expect(await as('Asha', 'updateProfile', { data: { name: 'System' } })).toMatchObject({ status: 'error' });
    expect(await as('Asha', 'updateProfile', { data: { name: 'Ravi' } })).toMatchObject({ status: 'error' });
    expect((await as('Asha', 'updateProfile', { data: { name: 'Asha', phone: '' } })).status).toBe('success'); // unchanged name is fine
    expect(leadIds(await as('Asha', 'getAllLeads'))).toEqual(['ENQ-0001']);
    // managers can rename, but not to a reserved name or another user's name (case and spaces ignored)
    const users = (await as('Meera', 'listUsers')).data;
    const asha = users.find((u: any) => u.name === 'Asha');
    expect(await as('Meera', 'saveUser', { data: { id: asha.id, name: 'system' } })).toMatchObject({ status: 'error' });
    expect(await as('Meera', 'saveUser', { data: { id: asha.id, name: '  ravi ' } })).toMatchObject({ status: 'error', code: 'CONFLICT' });
    expect((await as('Meera', 'saveUser', { data: { id: asha.id, name: 'Asha Rao' } })).status).toBe('success');
  });

  it("calls not linked to a lead follow the lead their number belongs to; unknown numbers only with 'own_unassigned'", async () => {
    const calls = await col(CFG.COLL.CALLS);
    const at = new Date();
    await calls.insertMany([
      { _id: 'CALL-R', leadId: '', phone: '9000000002', loggedBy: 'JustConnect', direction: 'Inbound', status: 'Missed', startTime: at, createdAt: at },
      { _id: 'CALL-A', leadId: '', phone: '9000000001', loggedBy: 'JustConnect', direction: 'Inbound', status: 'Missed', startTime: at, createdAt: at },
      { _id: 'CALL-N', leadId: '', phone: '9111122233', loggedBy: 'JustConnect', direction: 'Inbound', status: 'Missed', startTime: at, createdAt: at },
    ] as any[]);
    const seen = async (who: string) => ((await as(who, 'getCalls')).data as any[]).map((c) => c.id).sort();
    expect(await seen('Asha')).toEqual(['CALL-A']); // not Ravi's caller, not an unknown number
    expect(await seen('Meera')).toEqual(['CALL-A', 'CALL-N', 'CALL-R']);
    expect((await as('Asha', 'transcribeCall', { callId: 'CALL-R' }))).toMatchObject({ code: 'NOT_FOUND' });
    await settingSet('rmLeadVisibility', 'own_unassigned', 'test');
    expect(await seen('Asha')).toEqual(['CALL-A', 'CALL-N']);
  });

  it('nobody can change an enquiry\'s phone number (the same number in another format is fine)', async () => {
    expect(await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Phone Number': '9111122233' } })).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect(await as('Asha', 'updateLead', { id: 'ENQ-0001', data: { 'Phone Number': '9111122233' } })).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect((await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Phone Number': '+91 90000 00001', 'Enquiry Notes': 'ok' } })).status).toBe('success');
  });

  it('made-up phone numbers are refused: repeated digits, 1234567890, an Indian mobile not starting 6-9', async () => {
    for (const phone of ['1111111111', '9999999999', '+91 22222 22222', '1212121212', '1234567890', '9876543210', '5123456789']) {
      expect(await as('Meera', 'addLead', { data: { 'Prospect Name': 'Fake', 'Phone Number': phone } }), phone).toMatchObject({ status: 'error', code: 'VALIDATION' });
    }
    for (const phone of ['9845012345', '+91 70123 45678', '+44 20 7946 0958', '04023456789']) {
      expect((await as('Meera', 'addLead', { data: { 'Prospect Name': 'Real ' + phone, 'Phone Number': phone } })).status, phone).toBe('success');
    }
  });

  it('bulk actions: managers reassign; agents change only their own leads; others are skipped', async () => {
    const ids = ['ENQ-0001', 'ENQ-0002', 'ENQ-0003'];
    expect(await as('Asha', 'bulkLeads', { ids, op: 'assign', value: 'Asha' })).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
    expect(await as('Meera', 'bulkLeads', { ids, op: 'assign', value: 'Nobody Real' })).toMatchObject({ status: 'error', code: 'VALIDATION' });
    const re = (await as('Meera', 'bulkLeads', { ids: ['ENQ-0003'], op: 'assign', value: 'Ravi' })).data;
    expect(re).toMatchObject({ done: 1, skipped: 0 });
    // Asha sees only ENQ-0001: the other two are skipped, not changed
    const st = (await as('Asha', 'bulkLeads', { ids, op: 'stage', value: 'Hot' })).data;
    expect(st).toMatchObject({ done: 1, skipped: 2 });
    const all = (await as('Meera', 'getAllLeads')).data.leads;
    const by = (id: string) => all.find((l: any) => l['Enquiry ID'] === id);
    expect(by('ENQ-0001')['Lead Stage']).toBe('Hot');
    expect(by('ENQ-0002')['Lead Stage']).not.toBe('Hot');
    expect(by('ENQ-0003')['Assigned RM']).toBe('Ravi');
    // a remark on several leads, a follow-up date, and the bin only with leads.trash
    expect((await as('Meera', 'bulkLeads', { ids: ['ENQ-0001', 'ENQ-0002'], op: 'remark', value: 'Sent the new price sheet' })).data.done).toBe(2);
    const at = new Date(Date.now() + 86_400_000).toISOString();
    expect((await as('Meera', 'bulkLeads', { ids: ['ENQ-0002'], op: 'followup', value: at })).data.done).toBe(1);
    const after = (await as('Meera', 'getAllLeads')).data.leads;
    expect(after.find((l: any) => l['Enquiry ID'] === 'ENQ-0002')['Follow-up 1']).toContain('Sent the new price sheet');
    expect(Math.abs(Date.parse(after.find((l: any) => l['Enquiry ID'] === 'ENQ-0002')['Next Follow-up Date']) - Date.parse(at))).toBeLessThan(60_000);
    expect(await as('Asha', 'bulkLeads', { ids: ['ENQ-0001'], op: 'trash' })).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
    expect(await as('Meera', 'bulkLeads', { ids: [], op: 'stage', value: 'Hot' })).toMatchObject({ status: 'error', code: 'VALIDATION' });
  });

  it('enquiry history lists every enquiry from the same number, oldest first', async () => {
    const r = await as('Meera', 'addLead', { data: { 'Prospect Name': 'Asha again', 'Phone Number': '9000000001', _forceCreate: true } });
    expect(r.status).toBe('success');
    const h = (await as('Meera', 'getEnquiryHistory', { id: r.data.id })).data;
    expect(h.map((x: any) => x.id)).toEqual(['ENQ-0001', r.data.id]);
    expect(h[1].current).toBe(true);
    expect((await as('Meera', 'getEnquiryHistory', { id: 'ENQ-0003' })).data).toEqual([]); // only one enquiry
  });

  it('nobody can change the enquiry date (re-sending the same time is fine)', async () => {
    const lead = (await as('Meera', 'getAllLeads')).data.leads.find((l: any) => l['Enquiry ID'] === 'ENQ-0001');
    expect(await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Enquiry Date': '2020-01-01T10:00:00.000Z' } })).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect((await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Enquiry Date': lead['Enquiry Date'], 'Enquiry Notes': 'ok' } })).status).toBe('success');
  });

  it('nobody can change an enquiry source once it is set; an empty one can be filled once', async () => {
    expect((await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Enquiry Source': 'Website' } })).status).toBe('success'); // was empty
    expect(await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Enquiry Source': 'Facebook' } })).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect(await as('Asha', 'updateLead', { id: 'ENQ-0001', data: { 'Enquiry Source': '' } })).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect((await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Enquiry Source': 'Website', 'Enquiry Notes': 'ok' } })).status).toBe('success'); // unchanged is fine
  });

  it("the duplicate-phone message does not reveal another RM's customer", async () => {
    const r = await as('Asha', 'addLead', { data: { 'Prospect Name': 'Dup', 'Phone Number': '9000000002' } });
    expect(r).toMatchObject({ status: 'error', code: 'CONFLICT' });
    expect(r.message).not.toContain('Ravi Lead');
    expect(r.message).not.toContain('ENQ-0002');
    const m = await as('Meera', 'addLead', { data: { 'Prospect Name': 'Dup', 'Phone Number': '9000000002' } });
    expect(m.message).toContain('ENQ-0002');
  });

  it('tasks, notifications, WhatsApp threads and documents follow the lead', async () => {
    await as('Meera', 'addTask', { data: { name: 'Call Ravi lead', leadId: 'ENQ-0002', assignedTo: 'Ravi' } });
    await as('Meera', 'addTask', { data: { name: 'Call Asha lead', leadId: 'ENQ-0001', assignedTo: 'Asha' } });
    const tasks = (await as('Asha', 'getBootstrap')).data.tasks.map((x: any) => x.name);
    expect(tasks).toEqual(['Call Asha lead']);
    const ravisTask = (await as('Meera', 'getBootstrap')).data.tasks.find((x: any) => x.name === 'Call Ravi lead');
    expect(await as('Asha', 'toggleTask', { id: ravisTask.id, completed: true })).toMatchObject({ code: 'NOT_FOUND' });

    const events = (await as('Asha', 'getEvents', { sinceId: 'EVT-000000' })).data.events;
    expect(events.some((e: any) => /Ravi Lead/.test(e.title + e.message))).toBe(false);
    expect(events.some((e: any) => /Asha Lead/.test(e.title + e.message))).toBe(true);

    const contacts = await col(CFG.COLL.CHAT_CONTACTS);
    await contacts.insertMany([
      { phone: '919000000002', phoneLast10: '9000000002', contactName: 'Ravi Lead', leadId: 'ENQ-0002', lastMessageAt: new Date(), unreadCount: 1 },
      { phone: '919000012349', phoneLast10: '9000012349', contactName: 'New enquiry', leadId: '', lastMessageAt: new Date(), unreadCount: 1 },
    ] as any[]);
    const seen = (await as('Asha', 'chat360GetContacts')).data.map((c: any) => c.contactName);
    expect(seen).toEqual(['New enquiry']);
    expect(await as('Asha', 'chat360GetMessages', { phone: '9000000002' })).toMatchObject({ code: 'NOT_FOUND' });

    await as('Meera', 'saveRecord', { kind: 'documents', data: { name: 'Ravi agreement', leadId: 'ENQ-0002', fileUrl: 'https://example.com/a.pdf' } });
    await as('Meera', 'saveRecord', { kind: 'documents', data: { name: 'Brochure', fileUrl: 'https://example.com/b.pdf' } });
    const docs = (await as('Asha', 'listRecords', { kind: 'documents' })).data.map((d: any) => d.name);
    expect(docs).toEqual(['Brochure']);
  });
});

describe('follow-up history', () => {
  it('is append-only for RMs; managers can still correct it', async () => {
    await as('Asha', 'appendRemark', { id: 'ENQ-0001', remark: 'First call' });
    const lead = (await as('Asha', 'getAllLeads')).data.leads.find((l: any) => l['Enquiry ID'] === 'ENQ-0001');
    expect(lead['Follow-up 1']).toContain('First call');

    const edit = await as('Asha', 'updateLead', { id: 'ENQ-0001', data: { 'Follow-up 1': 'rewritten history' } });
    expect(edit).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
    const wipe = await as('Asha', 'updateLead', { id: 'ENQ-0001', data: { 'Follow-up 1': '' } });
    expect(wipe).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
    // other fields and new remarks still work
    expect((await as('Asha', 'updateLead', { id: 'ENQ-0001', data: { 'Enquiry Notes': 'prefers 3 BHK' } })).status).toBe('success');
    expect((await as('Asha', 'appendRemark', { id: 'ENQ-0001', remark: 'Second call' })).data.index).toBe(2);

    const fix = await as('Meera', 'updateLead', { id: 'ENQ-0001', data: { 'Follow-up 1': '2026-10-05 10:00 — First call (corrected)' } });
    expect(fix.status).toBe('success');
    const audit = await (await col(CFG.COLL.AUDIT_LOG)).findOne({ action: 'Lead Updated', entityId: 'ENQ-0001', 'before.Follow-up 1': { $exists: true } } as any);
    expect(String((audit as any).before['Follow-up 1'])).toContain('First call');
  });
});
