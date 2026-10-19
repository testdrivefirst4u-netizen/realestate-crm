/**
 * Sales automation: auto-reassign of untouched new leads (working hours, once per RM, managers told), site-visit
 * reminders to the RM's phone (day before / 2 hours before, once each), the evening summary notification, the RM
 * leaderboard, campaign spend and the backup restore test. Everything is free — no WhatsApp is sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => ({ after: () => {} }));
const chatSend = vi.fn(async () => ({ message: { id: 'wa1' } }));
vi.mock('../server/modules/chat360', async (orig) => ({ ...(await orig<typeof import('../server/modules/chat360')>()), send: chatSend }));
const pushSent: Array<{ endpoint: string; body: any }> = [];
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, body: string) => { pushSent.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); return { statusCode: 201 }; },
  },
}));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { updateSettings } from '../server/core/settings';
import { pushSubscribe } from '../server/modules/push';
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
  pushSent.length = 0;
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
});
const device = (n: number) => ({ subscription: { endpoint: `https://push.example/dev${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } });

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
    await expect(updateSettings({ salesOps: { summaryPush: true, summaryTo: 'nobody@x.in' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ salesOps: { summaryPush: true, summaryTo: '' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await updateSettings({ salesOps: { reassignAfterMin: 20, summaryPush: true, summaryTo: admin.user!.email } }, admin);
    expect(s.salesOps).toMatchObject({ reassignAfterMin: 20, visitReminders: true, summaryPush: true, summaryTo: admin.user!.email });
  });
});

describe('site-visit reminders (to the RM, free)', () => {
  it('notifies the RM the day before from 10 AM and 2 hours before, each once — the customer gets no WhatsApp', async () => {
    await pushSubscribe(device(1), priya);
    const visitAt = makeZoned(2026, 10, 20, 11, 30);
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876500009', [L.RM]: 'Priya Sharma', [L.SITE_VISIT_STATUS]: CFG.SITE_VISIT.SCHEDULED, [L.SITE_VISIT_DATE]: visitAt.toISOString() }, admin);
    const c = cfg({ reassignAfterMin: 0, visitReminders: true });

    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 19, 8, 0))).toEqual({ sent: 0, failed: 0 }); // before 10 AM
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 19, 10, 5))).toEqual({ sent: 1, failed: 0 });
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 19, 15, 0))).toEqual({ sent: 0, failed: 0 });
    expect(pushSent[0].body).toMatchObject({ title: 'Tomorrow: site visit with Meera Kapoor', url: `/leads?lead=${lead[L.ID]}` });
    expect(pushSent[0].body.body).toContain('20 Oct 2026 at 11:30 AM');
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 20, 9, 45))).toEqual({ sent: 1, failed: 0 });
    expect(pushSent[1].body.title).toBe('Site visit at 11:30 AM: Meera Kapoor');
    expect(await SO.sendVisitReminders(c, makeZoned(2026, 10, 20, 10, 0))).toEqual({ sent: 0, failed: 0 });
    expect(pushSent).toHaveLength(2);
    expect(chatSend).not.toHaveBeenCalled();
  });

  it('sends nothing when off or when the lead has no RM', async () => {
    await pushSubscribe(device(1), priya);
    await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876500009', [L.RM]: 'Priya Sharma', [L.SITE_VISIT_STATUS]: CFG.SITE_VISIT.SCHEDULED, [L.SITE_VISIT_DATE]: new Date(noon.getTime() + 60 * 60000).toISOString() }, admin);
    await addLead({ [L.NAME]: 'Nobody', [L.PHONE]: '9876500008', [L.SITE_VISIT_STATUS]: CFG.SITE_VISIT.SCHEDULED, [L.SITE_VISIT_DATE]: new Date(noon.getTime() + 60 * 60000).toISOString() }, admin);
    expect((await SO.sendVisitReminders(cfg({ visitReminders: false }), noon)).sent).toBe(0);
    expect((await SO.sendVisitReminders(cfg(), noon)).sent).toBe(1);
  });
});

describe('evening summary', () => {
  it('sends the day numbers once, after the chosen hour, as a phone notification', async () => {
    await pushSubscribe(device(9), admin);
    const today = new Date();
    await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876500009', [L.ENQUIRY_DATE]: today.toISOString() }, admin);
    const c = cfg({ summaryPush: true, summaryHour: 0, summaryTo: admin.user!.email });
    expect(await SO.sendEveningSummary(c, today)).toEqual({ sent: 1 });
    expect(pushSent[0].body.title).toMatch(/^Today in the CRM · /);
    expect(pushSent[0].body.body).toMatch(/^1 new leads · /);
    expect(await SO.sendEveningSummary(c, today)).toMatchObject({ sent: 0, skipped: 'already sent' });
    expect(chatSend).not.toHaveBeenCalled();
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
