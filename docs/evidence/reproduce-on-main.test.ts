/** Reproductions of the review findings against the ORIGINAL code (main @ 16b330a). Each test asserts the defect. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, findUserByEmail, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { updateSettings } from '../server/core/settings';
import { bookVisit, listSlots, visitConfig } from '../server/modules/visits';
import { calculatePerformanceMetrics } from '../src/core/pipeline';
import { POST as telephonyPOST } from '../app/api/webhooks/telephony/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.9.9.9' };
const tokens: Record<string, string> = {};
async function signIn(name: string, role: any) {
  const email = name.toLowerCase() + '@repro.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await signIn('Asha', 'RM'); await signIn('Ravi', 'RM'); await signIn('Meera', 'Manager');
});

describe('defects present on main', () => {
  it('1: an agent receives another agent\'s buyer name, phone, lead id and money', async () => {
    const ravi = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Mr Menon', 'Phone Number': '9811100002', 'Assigned RM': 'Ravi' } })).data.lead['Enquiry ID'];
    const u = (await as('Meera', 'addInventoryUnit', { data: { unitId: 'A102' } })).data.unit;
    await as('Meera', 'updateInventoryUnit', { id: u.inventoryId, data: { status: 'Booked', leadId: ravi, customerName: 'Mr Menon', contact: '9811100009', paidAmount: 100000 } });
    const seen = (await as('Asha', 'getBootstrap')).data.inventory.find((x: any) => x.unitId === 'A102');
    expect(seen).toMatchObject({ customerName: 'Mr Menon', leadId: ravi, paidAmount: 100000 });
  });

  it('2: twenty simultaneous reservations of one unit all report success', async () => {
    const u = (await as('Meera', 'addInventoryUnit', { data: { unitId: 'C301' } })).data.unit;
    const leads: string[] = [];
    for (let i = 0; i < 20; i++) leads.push((await as('Meera', 'addLead', { data: { 'Prospect Name': `F${i}`, 'Phone Number': `98222${10000 + i}` } })).data.lead['Enquiry ID']);
    const r = await Promise.all(leads.map((leadId) => as('Meera', 'updateInventoryUnit', { id: u.inventoryId, expectedLastModified: u.lastModified, data: { status: 'Reserved', leadId } })));
    const winners = r.filter((x) => x.status === 'success' && !x.data.conflict).length;
    expect(winners).toBeGreaterThan(1);
  });

  it('3: renaming an agent hides their leads from them', async () => {
    const lead = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Mrs Kapoor', 'Phone Number': '9833300001', 'Assigned RM': 'Asha' } })).data.lead['Enquiry ID'];
    expect((await as('Asha', 'getAllLeads')).data.leads.map((l: any) => l['Enquiry ID'])).toEqual([lead]);
    const asha = (await findUserByEmail('asha@repro.test'))!;
    await as('Meera', 'saveUser', { data: { id: asha._id, name: 'Asha Rao' } });
    expect((await as('Asha', 'getAllLeads')).data.leads).toHaveLength(0);
  });

  it('4: a telephony event the CRM fails to save is acknowledged with HTTP 200', async () => {
    await t.company(); await t.secret('TELEPHONY_WEBHOOK_SECRET', 's');
    await (await col<any>(CFG.COLL.CALLS)).insertOne({ _id: 'warm' } as any);
    await t.db.command({ collMod: CFG.COLL.CALLS, validator: { $jsonSchema: { required: ['__never__'] } } });
    const res = await telephonyPOST(new Request('http://x/api/webhooks/telephony?company=test&provider=p', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 's' }, body: JSON.stringify({ call_id: 'Z1', from: '9876511111', direction: 'inbound' }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('error');
    await t.db.command({ collMod: CFG.COLL.CALLS, validator: {} });
  });

  it('5: simultaneous visit bookings exceed the slot capacity', async () => {
    const admin = await t.ctx('Admin', 'Adm');
    await updateSettings({ visitBooking: { enabled: true, days: [1, 2, 3, 4, 5], start: '10:00', end: '13:00', slotMinutes: 60, capacity: 2, horizonDays: 3, minNoticeHours: 2 } }, admin);
    const NOW = new Date('2026-10-05T03:30:00.000Z');
    const slot = (await listSlots(await visitConfig(), NOW))[0].slots[0];
    const r = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => bookVisit({ name: `V${i}`, phone: `98444${10000 + i}`, at: slot.at }, NOW)));
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeGreaterThan(2);
  });

  it('6: one timely reply + nine ignored enquiries shows 100% SLA', () => {
    const now = new Date('2026-11-10T06:30:00Z');
    const enq = new Date(now.getTime() - 72 * 3600e3);
    const leads: any[] = [{ 'Enquiry ID': 'E1', 'Enquiry Date': enq.toISOString(), 'Lead Stage': 'Open', 'Follow-up 1': '07/11/2026 10:30:00 — called' }];
    for (let i = 2; i <= 10; i++) leads.push({ 'Enquiry ID': 'E' + i, 'Enquiry Date': enq.toISOString(), 'Lead Stage': 'New' });
    const p = calculatePerformanceMetrics(leads, 30, '', now);
    expect(p.totalRespondedCount).toBe(1);
    expect(p.slaCompliancePercent).toBe(100);
  });
});
