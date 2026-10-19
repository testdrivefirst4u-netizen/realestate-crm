/**
 * Sales automation: auto-reassign of untouched new leads (working hours, once per RM, managers told), site-visit
 * WhatsApp reminders (day before / 2 hours before, once each), the evening WhatsApp summary, the RM leaderboard,
 * campaign spend and the backup restore test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => ({ after: () => {} }));
const chatSend = vi.fn(async () => ({ message: { id: 'wa1' } }));
vi.mock('../server/modules/chat360', async (orig) => ({ ...(await orig<typeof import('../server/modules/chat360')>()), send: chatSend }));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { setSecret, updateSettings } from '../server/core/settings';
import { updateProfile, type Ctx } from '../server/core/auth';
import { makeZoned } from '../server/core/utils';
import { addLead, appendRemark, getLead, timelineForLead } from '../server/modules/leads';
import * as SO from '../server/modules/salesOps';
import { createLeadBackup, listLeadBackups, verifyLatestBackup } from '../server/modules/backups';

const L = CFG.LEAD;
let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx, priya: Ctx, ravi: Ctx;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
  priya = await t.ctx('RM', 'Priya Sharma');
  ravi = await t.ctx('RM', 'Ravi Kumar');
  chatSend.mockClear();
});

const leads = () => col<any>(CFG.COLL.LEADS);
const noon = makeZoned(2026, 10, 19, 12, 0);
const cfg = (o: Partial<SO.SalesOps> = {}) => ({ ...SO.SALES_OPS_DEFAULTS, reassignAfterMin: 15, ...o });

async function newLead(name: string, phone: string, rm = 'Priya Sharma', assignedAt = new Date(noon.getTime() - 30 * 60000)) {
  const { lead } = await addLead({ [L.NAME]: name, [L.PHONE]: phone, [L.RM]: rm }, admin);
  await (await leads()).updateOne({ _id: lead[L.ID] }, { $set: { assignedAt } });
  return lead[L.ID];
}

describe('auto-reassign', () => {
  it('the clock starts when working hours open', () => {
    const night = makeZoned(2026, 10, 19, 2, 0);
    expect(SO.reassignDue(night, { reassignAfterMin: 15, workStartHour: 9 })).toEqual(makeZoned(2026, 10, 19, 9, 15));
    expect(SO.reassignDue(noon, { reassignAfterMin: 15, workStartHour: 9 })).toEqual(makeZoned(2026, 10, 19, 12, 15));
  });

  it('moves an untouched new lead to the other RM once; a lead with a follow-up stays', async () => {
    const idle = await newLead('Meera', '9876500001');
    const busy = await newLead('Kiran', '9876500002');
    await appendRemark(busy, 'Called, will visit Sunday', priya);
    const r = await SO.reassignStale(cfg(), noon);
    expect(r).toEqual({ moved: 1, stuck: 0 });
    expect((await getLead(idle))![L.RM]).toBe('Ravi Kumar');
    expect((await getLead(busy))![L.RM]).toBe('Priya Sharma');
    const doc = await (await leads()).findOne({ _id: idle });
    expect(doc).toMatchObject({ reassignCount: 1, reassignedFrom: ['Priya Sharma'] });
    expect(JSON.stringify(await timelineForLead(idle))).toContain('Moved from Priya Sharma to Ravi Kumar');

    // reassignMax 1: Ravi's untouched lead is not moved again
    await (await leads()).updateOne({ _id: idle }, { $set: { assignedAt: new Date(noon.getTime() - 60 * 60000) } });
    expect((await SO.reassignStale(cfg(), noon)).moved).toBe(0);
  });

  it('does nothing outside working hours, when off, or before the time is up', async () => {
    await newLead('Meera', '9876500001');
    expect((await SO.reassignStale(cfg(), makeZoned(2026, 10, 19, 22, 0))).moved).toBe(0);
    expect((await SO.reassignStale(cfg({ reassignAfterMin: 0 }), noon)).moved).toBe(0);
    expect((await SO.reassignStale(cfg({ reassignAfterMin: 45 }), noon)).moved).toBe(0);
  });

  it('a lead that came in at night is not moved the moment the office opens', async () => {
    await newLead('Night owl', '9876500003', 'Priya Sharma', makeZoned(2026, 10, 19, 1, 0));
    expect((await SO.reassignStale(cfg(), makeZoned(2026, 10, 19, 9, 5))).moved).toBe(0);
    expect((await SO.reassignStale(cfg(), makeZoned(2026, 10, 19, 9, 20))).moved).toBe(1);
  });

  it('settings: at least 5 minutes, valid hours and templates', async () => {
    await expect(updateSettings({ salesOps: { reassignAfterMin: 2 } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ salesOps: { workStartHour: 18, workEndHour: 9 } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ salesOps: { visitReminders: true, visitTemplate: '' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ salesOps: { summaryWhatsapp: true, summaryTemplate: 'daily_numbers', summaryTo: 'nobody@x.in' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await updateSettings({ salesOps: { reassignAfterMin: 20, summaryWhatsapp: true, summaryTemplate: 'daily_numbers', summaryTo: admin.user!.email } }, admin);
    expect(s.salesOps).toMatchObject({ reassignAfterMin: 20, summaryWhatsapp: true, summaryTo: admin.user!.email });
  });
});

describe('site-visit reminders', () => {
  it('sends the day-before reminder from 10 AM and the 2-hour one, each once', async () => {
    await setSecret('CHAT360_API_KEY', 'test-key', admin);
    const visitAt = makeZoned(2026, 10, 20, 11, 30);
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876500009', [L.SITE_VISIT_STATUS]: CFG.SITE_VISIT.SCHEDULED, [L.SITE_VISIT_DATE]: visitAt.toISOString() }, admin);
    const c = cfg({ reassignAfterMin: 0, visitReminders: true, visitTemplate: 'visit_reminder' });

    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 19, 8, 0))).toEqual({ sent: 0, failed: 0 }); // before 10 AM
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 19, 10, 5))).toEqual({ sent: 1, failed: 0 });
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 19, 15, 0))).toEqual({ sent: 0, failed: 0 });
    expect(chatSend).toHaveBeenLastCalledWith(expect.objectContaining({ phone: '9876500009', leadId: lead[L.ID], templateName: 'visit_reminder', params: ['Meera', '20 Oct 2026', '11:30 AM'] }), expect.anything());
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 20, 9, 45))).toEqual({ sent: 1, failed: 0 });
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 20, 10, 0))).toEqual({ sent: 0, failed: 0 });
    expect(chatSend).toHaveBeenCalledTimes(2);
  });

  it('sends nothing without Chat360 or when off', async () => {
    await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876500009', [L.SITE_VISIT_STATUS]: CFG.SITE_VISIT.SCHEDULED, [L.SITE_VISIT_DATE]: new Date(noon.getTime() + 60 * 60000).toISOString() }, admin);
    expect((await SO.sendVisitReminders(cfg({ visitReminders: true, visitTemplate: 'visit_reminder' }), noon)).sent).toBe(0);
    await setSecret('CHAT360_API_KEY', 'test-key', admin);
    expect((await SO.sendVisitReminders(cfg(), noon)).sent).toBe(0);
  });
});

describe('evening summary', () => {
  it('sends the day numbers once, after the chosen hour, to users with a WhatsApp number', async () => {
    await setSecret('CHAT360_API_KEY', 'test-key', admin);
    await updateProfile(admin, { phone: '9876511111' });
    const today = new Date();
    await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876500009', [L.ENQUIRY_DATE]: today.toISOString() }, admin);
    const c = cfg({ summaryWhatsapp: true, summaryTemplate: 'daily_numbers', summaryParams: '{date}, {new}, {overdue}', summaryHour: 0, summaryTo: admin.user!.email });
    expect(await SO.sendEveningSummary(c, today)).toEqual({ sent: 1 });
    const [arg] = chatSend.mock.calls[0] as unknown as [any];
    expect(arg).toMatchObject({ phone: '919876511111', templateName: 'daily_numbers' });
    expect(arg.params[1]).toBe('1');
    expect(await SO.sendEveningSummary(c, today)).toMatchObject({ sent: 0, skipped: 'already sent' });
  });
});

describe('leaderboard and campaign spend', () => {
  it('counts follow-ups and bookings per RM, best first', async () => {
    const a = await newLead('Meera', '9876500001');
    await appendRemark(a, 'Spoke, keen on 2 BHK', ravi);
    await addLead({ [L.NAME]: 'Booked One', [L.PHONE]: '9876500005', [L.RM]: 'Priya Sharma', [L.STAGE]: 'Booked', [L.BOOKING_DATE]: new Date().toISOString() }, admin);
    const r = await SO.leaderboard({ days: 7 });
    expect(r.rows.map((x) => x.rm)).toEqual(['Priya Sharma', 'Ravi Kumar']);
    expect(r.rows[0]).toMatchObject({ bookings: 1 });
    expect(r.rows[1]).toMatchObject({ followups: 1 });
  });

  it('saves spend per month and campaign', async () => {
    await SO.saveCampaignSpend({ month: '2026-10', rows: [{ campaign: 'Amaya Q4', amount: 50000 }, { campaign: 'Retarget', amount: 0 }] }, admin);
    await SO.saveCampaignSpend({ month: '2026-09', rows: [{ campaign: 'Amaya Q4', amount: 30000 }] }, admin);
    await SO.saveCampaignSpend({ month: '2026-10', rows: [{ campaign: 'Amaya Q4', amount: 55000 }] }, admin);
    expect((await SO.getCampaignSpend()).rows).toEqual([{ campaign: 'Amaya Q4', month: '2026-09', amount: 30000 }, { campaign: 'Amaya Q4', month: '2026-10', amount: 55000 }]);
    await expect(SO.saveCampaignSpend({ month: '2026-13', rows: [] }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('backup restore test', () => {
  it('reads the newest backup back and records the result', async () => {
    expect(await verifyLatestBackup()).toBeNull();
    await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876500009' }, admin);
    await createLeadBackup({ by: 'test' });
    expect(await verifyLatestBackup()).toMatchObject({ ok: true, note: 'All 1 leads read back' });
    expect((await listLeadBackups())[0]).toMatchObject({ verified: 'ok' });

    // a damaged backup fails the test
    await (await col<any>('leadBackups')).updateOne({}, { $set: { count: 5 } });
    expect(await verifyLatestBackup()).toMatchObject({ ok: false });
    expect((await listLeadBackups())[0]).toMatchObject({ verified: 'failed' });
  });
});
