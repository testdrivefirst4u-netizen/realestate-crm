/**
 * RERA (Telangana) payment schedules and customer engagement, through the real router with synthetic data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { settingSet } from '../server/core/settings';
import { buildStatement } from '../server/modules/rera';
import { healthOf } from '../server/modules/engagement';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.6.6.6' };
const tokens: Record<string, string> = {};
async function signIn(name: string, role: 'Manager' | 'RM' | 'Admin') {
  const email = name.toLowerCase() + '@rera.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;
const STAGES = [{ key: 'plinth', label: 'Plinth' }, { key: 'slab3', label: '3rd slab' }, { key: 'finishing', label: 'Finishing' }];
const PLAN = {
  name: 'Construction-linked plan (example)', agreementRef: 'P02200000000 · Agreement v1 (synthetic)', gstPct: 5, noticeDays: 15,
  stages: [
    { label: 'On booking', percent: 10, trigger: 'booking' },
    { label: 'On agreement', percent: 20, trigger: 'agreement' },
    { label: 'Plinth', percent: 20, trigger: 'stage', stageKey: 'plinth' },
    { label: '3rd slab', percent: 20, trigger: 'stage', stageKey: 'slab3' },
    { label: 'Finishing', percent: 20, trigger: 'stage', stageKey: 'finishing' },
    { label: 'On possession', percent: 10, trigger: 'possession' },
  ],
};
let leadId = '';
let unitId = '';

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await signIn('Meera', 'Manager');
  await signIn('Asha', 'RM');
  await signIn('Ravi', 'RM');
  leadId = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Priya Nair', 'Phone Number': '+971501234567', 'Assigned RM': 'Asha' } })).data.lead['Enquiry ID'];
  const u = (await as('Meera', 'addInventoryUnit', { data: { unitId: 'B-2A-0504', price: 13_032_880 } })).data.unit;
  unitId = u.inventoryId;
  await as('Meera', 'updateInventoryUnit', { id: unitId, expectedRev: 0, data: { status: 'Booked', leadId, quotedAmount: 10_000_000 } });
  await as('Meera', 'saveConstructionStages', { stages: STAGES });
});

describe('RERA payment plans (Telangana)', () => {
  it('a plan must add up to 100 %, name its registered agreement, and keep the pre-agreement part within 10 %', async () => {
    expect((await as('Meera', 'savePaymentPlan', { ...PLAN, agreementRef: '' })).code).toBe('VALIDATION');
    expect((await as('Meera', 'savePaymentPlan', { ...PLAN, stages: PLAN.stages.slice(1) })).message).toMatch(/add up to 90/);
    const tooMuch = { ...PLAN, stages: [{ label: 'Booking', percent: 15, trigger: 'booking' }, { label: 'Rest', percent: 85, trigger: 'agreement' }] };
    expect((await as('Meera', 'savePaymentPlan', tooMuch)).message).toMatch(/Section 13/);
    expect((await as('Asha', 'savePaymentPlan', PLAN)).code).toBe('FORBIDDEN');
    expect((await as('Meera', 'savePaymentPlan', PLAN)).status).toBe('success');
  });

  it('booking → cap → registered agreement → certified stages raise demands once → interest accrues at the entered rate', async () => {
    const plan = (await as('Meera', 'savePaymentPlan', PLAN)).data;
    const s = (await as('Meera', 'applyPaymentPlan', { unitId, planId: plan._id })).data;
    expect(s.milestones.map((m: any) => m.amount)).toEqual([1_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000, 1_000_000]);
    expect(s.milestones[0]).toMatchObject({ gst: 50_000, demandNo: expect.stringMatching(/^DEM-/) });
    expect(s.milestones[1].demandedAt).toBeUndefined(); // agreement not registered yet

    // RERA s.13: only 10 % before the registered agreement
    expect((await as('Meera', 'recordReceipt', { unitId, amount: 1_000_000, reference: 'NEFT-B1' })).status).toBe('success');
    const over = await as('Meera', 'recordReceipt', { unitId, amount: 1, reference: 'NEFT-B2' });
    expect(over.code).toBe('VALIDATION');
    expect(over.message).toMatch(/Section 13/);
    expect((await as('Meera', 'raisePaymentDemand', { unitId, milestoneId: s.milestones[5].id })).code).toBe('CONFLICT');

    // agreement registered: its instalment is demanded
    expect((await as('Meera', 'recordAgreementRegistration', { unitId, documentNo: '' })).code).toBe('VALIDATION');
    await as('Meera', 'recordAgreementRegistration', { unitId, documentNo: 'MDL/1234/2026' });
    let st = (await as('Meera', 'getPaymentStatement', { unitId })).data;
    expect(st.lines.map((l: any) => l.status)).toEqual(['paid', 'demanded', 'not due', 'not due', 'not due', 'not due']);
    expect(st.totals.advanceCap).toBeNull();

    // plinth certified: demand raised on this unit, once
    expect((await as('Meera', 'certifyConstructionStage', { key: 'plinth' })).code).toBe('VALIDATION'); // certificate needed
    expect((await as('Meera', 'certifyConstructionStage', { key: 'plinth', certificateRef: 'ARCH/PL/01' })).data.demands).toBe(1);
    expect((await as('Meera', 'certifyConstructionStage', { key: 'plinth', certificateRef: 'ARCH/PL/01' })).data).toMatchObject({ demands: 0, alreadyCertified: true });

    // a late payment: the agreement instalment 30 days overdue, interest shown at the admin-entered rate, not charged
    await settingSet('reraInterestRatePct', '10.7', 'test');
    await settingSet('reraInterestRateSource', 'SBI MCLR + 2 % (synthetic test value)', 'test');
    const sched = await (await col<any>('paymentSchedules')).findOne({ _id: unitId });
    sched.milestones[1].dueDate = new Date(Date.now() - 30 * 86400e3).toISOString();
    await (await col<any>('paymentSchedules')).replaceOne({ _id: unitId }, sched);
    st = (await as('Meera', 'getPaymentStatement', { unitId })).data;
    expect(st.lines[1]).toMatchObject({ status: 'overdue', daysLate: 30, interestAccrued: Math.round((2_000_000 * 10.7 * 30) / 36500) });
    expect(st.interestRateSource).toMatch(/MCLR/);
    const letter = (await as('Meera', 'getDemandLetter', { unitId, milestoneId: sched.milestones[2].id })).data;
    expect(letter).toMatchObject({ amount: 2_000_000, gst: 100_000, total: 2_100_000 });

    // the paid amount on the unit is still the ledger's
    expect((await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: unitId })).paidAmount).toBe(1_000_000);
  });

  it("another agent cannot read this customer's statement; their own agent can", async () => {
    const plan = (await as('Meera', 'savePaymentPlan', PLAN)).data;
    await as('Meera', 'applyPaymentPlan', { unitId, planId: plan._id });
    expect((await as('Ravi', 'getPaymentStatement', { unitId })).code).toBe('NOT_FOUND');
    expect((await as('Asha', 'getPaymentStatement', { unitId })).status).toBe('success');
  });

  it('a schedule outside the registered plan needs a reason and is marked as a deviation', async () => {
    const r = await as('Meera', 'setPaymentSchedule', { unitId, milestones: [{ label: 'All', amount: 10_000_000 }] });
    expect(r.code).toBe('VALIDATION');
    const ok = await as('Meera', 'setPaymentSchedule', { unitId, reason: 'MD approved 50:50 (synthetic)', milestones: [{ label: 'Half', amount: 5_000_000 }, { label: 'Half', amount: 5_000_000 }] });
    expect(ok.status).toBe('success');
    expect((await (await col<any>('paymentSchedules')).findOne({ _id: unitId })).deviation).toBe(true);
  });

  it('a manager sets the interest rate only with its source; agents cannot', async () => {
    expect((await as('Asha', 'saveReraSettings', { interestRatePct: '10.7', interestRateSource: 'x' })).code).toBe('FORBIDDEN');
    expect((await as('Meera', 'saveReraSettings', { interestRatePct: '10.7', interestRateSource: '' })).code).toBe('VALIDATION');
    const r = await as('Meera', 'saveReraSettings', { interestRatePct: '10.7', interestRateSource: 'SBI MCLR + 2 % (synthetic)', projectNumber: 'P0220000XXXX' });
    expect(r.data).toMatchObject({ interestRatePct: '10.7', projectNumber: 'P0220000XXXX' });
  });

  it('statement allocates receipts oldest-first (pure)', () => {
    const s = { total: 300, milestones: [{ id: 'a', label: 'A', amount: 100, gst: 5, demandedAt: 'x', dueDate: '2026-01-01' }, { id: 'b', label: 'B', amount: 200, gst: 10, demandedAt: 'x', dueDate: '2099-01-01' }] };
    const st = buildStatement(s, 150, { ratePct: null, agreementRegistered: true, now: new Date('2026-02-01') });
    expect(st.lines.map((l) => [l.status, l.paid])).toEqual([['paid', 100], ['part paid', 50]]);
  });
});

describe('engagement', () => {
  it('health: engaged within 14 days of a response, cooling to 30, cold after; new until there is signal', () => {
    const now = new Date('2026-11-11T06:00:00Z');
    const at = (d: number) => new Date(now.getTime() - d * 86400e3).toISOString();
    const t = (d: number, dir: 'in' | 'out') => ({ at: at(d), channel: 'whatsapp', kind: 'message', direction: dir, responded: dir === 'in', source: 'whatsapp' as const, note: '', personId: '' });
    expect(healthOf([t(3, 'in')], now).state).toBe('engaged');
    expect(healthOf([t(20, 'in'), t(2, 'out')], now).state).toBe('cooling');
    expect(healthOf([t(40, 'in')], now).state).toBe('cold');
    expect(healthOf([t(1, 'out'), t(5, 'out'), t(9, 'out')], now).state).toBe('cold'); // three unanswered touches
    expect(healthOf([t(1, 'out')], now).state).toBe('new');
  });

  it('logged touches count; a booked customer gets the SOP steps; assigning an owner and a referral ask close them', async () => {
    expect((await as('Ravi', 'logEngagement', { leadId, channel: 'event', kind: 'eventAttended' })).code).toBe('NOT_FOUND'); // not Ravi's customer
    await as('Asha', 'logEngagement', { leadId, channel: 'event', kind: 'eventAttended', note: 'Parents came to the music evening' });
    const e = (await as('Asha', 'getEngagement', { leadId })).data;
    expect(e.health.state).toBe('engaged');
    expect(e.customer.due.map((d: any) => d.key)).toEqual(expect.arrayContaining(['welcomeCall', 'handedOver']));

    const users = (await as('Meera', 'getBootstrap')).data.users;
    const meera = users.find((u: any) => u.name === 'Meera');
    await as('Meera', 'assignCxOwner', { leadId, userId: meera.id });
    await as('Asha', 'logEngagement', { leadId, channel: 'call', kind: 'welcome', note: 'Welcome call with Priya and her parents' });
    // pretend the booking was 35 days ago: referral ask and progress update fall due
    await (await col<any>(CFG.COLL.LEADS)).updateOne({ _id: leadId }, { $set: { 'milestones.booked.at': new Date(Date.now() - 35 * 86400e3) } });
    let due = (await as('Meera', 'getEngagement', { leadId })).data.customer.due.map((d: any) => d.key);
    expect(due).toEqual(expect.arrayContaining(['referralAsk', 'progressUpdate', 'communityPreview']));
    expect(due).not.toContain('handedOver');
    expect(due).not.toContain('welcomeCall');
    await as('Meera', 'logEngagement', { leadId, channel: 'whatsapp', kind: 'referralAsk' });
    await as('Meera', 'logEngagement', { leadId, channel: 'email', kind: 'progressUpdate', note: 'October site photos' });
    due = (await as('Meera', 'getEngagement', { leadId })).data.customer.due.map((d: any) => d.key);
    expect(due).not.toContain('referralAsk');
    expect(due).not.toContain('progressUpdate');

    // Today shows the customer to the owner
    const today = (await as('Meera', 'getToday')).data;
    expect(today.customers.map((c: any) => c.leadId)).toContain(leadId);
  });
});
