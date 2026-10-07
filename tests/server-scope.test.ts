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
      { phone: '919000000009', phoneLast10: '9000000009', contactName: 'New enquiry', leadId: '', lastMessageAt: new Date(), unreadCount: 1 },
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
