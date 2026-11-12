/** Release D — payment milestones and an append-only receipts ledger; paid is derived, never typed. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.4.4.4' };
const tokens: Record<string, string> = {};
async function signIn(name: string, role: 'Manager' | 'RM' | 'Admin') {
  const email = name.toLowerCase() + '@pay.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await signIn('Meera', 'Manager');
  await signIn('Admin', 'Admin');
  await signIn('Asha', 'RM');
});

describe('payments ledger', () => {
  it('schedule must add up to the agreed price; receipts derive paid and the next due date; a void needs a second person', async () => {
    const lead = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Lata S', 'Phone Number': '9845011223', 'Assigned RM': 'Asha' } })).data.lead['Enquiry ID'];
    const unit = (await as('Meera', 'addInventoryUnit', { data: { unitId: 'T2-305', price: 13_400_000 } })).data.unit;
    await as('Meera', 'updateInventoryUnit', { id: unit.inventoryId, expectedRev: 0, data: { status: 'Booked', leadId: lead, quotedAmount: 10_000_000 } });
    const soon = (d: number) => new Date(Date.now() + d * 86400e3).toISOString();
    expect((await as('Meera', 'setPaymentSchedule', { unitId: unit.inventoryId, reason: 'Custom plan approved by MD (test)', milestones: [{ label: 'Token', amount: 500_000, dueDate: soon(-1) }] })).code).toBe('VALIDATION');
    expect((await as('Asha', 'setPaymentSchedule', { unitId: unit.inventoryId, milestones: [] })).code).toBe('FORBIDDEN');
    const s = await as('Meera', 'setPaymentSchedule', { unitId: unit.inventoryId, reason: 'Custom plan approved by MD (test)', milestones: [
      { label: 'Token', amount: 1_000_000, dueDate: soon(-1) }, { label: 'On agreement', amount: 2_000_000, dueDate: soon(30) }, { label: 'On possession', amount: 7_000_000, dueDate: soon(400) },
    ] });
    expect(s.data).toMatchObject({ version: 1, total: 10_000_000 });

    const r1 = await as('Meera', 'recordReceipt', { unitId: unit.inventoryId, amount: '10,00,000', mode: 'bank', reference: 'NEFT-001' });
    expect(r1.status).toBe('success');
    expect((await as('Meera', 'recordReceipt', { unitId: unit.inventoryId, amount: 1_000_000, reference: 'NEFT-001' })).code).toBe('CONFLICT'); // same transfer twice
    let u = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: unit.inventoryId });
    expect(u.paidAmount).toBe(1_000_000);
    expect(new Date(u.dueDate).toISOString().slice(0, 10)).toBe(soon(30).slice(0, 10)); // next unpaid milestone

    // the paid total cannot be typed any more
    const typed = await as('Meera', 'updateInventoryUnit', { id: unit.inventoryId, expectedRev: u.rev, data: { paidAmount: 9_999_999 } });
    expect(typed.code).toBe('VALIDATION');

    // a mistake is voided (never deleted), by someone else, with a reason
    expect((await as('Meera', 'voidReceipt', { id: r1.data._id, reason: 'Bounced' })).code).toBe('FORBIDDEN');
    expect((await as('Admin', 'voidReceipt', { id: r1.data._id })).code).toBe('VALIDATION');
    expect((await as('Admin', 'voidReceipt', { id: r1.data._id, reason: 'Transfer reversed by bank' })).status).toBe('success');
    const p = (await as('Asha', 'getPayments', { unitId: unit.inventoryId })).data; // the agent sees her own customer's payments
    expect(p).toMatchObject({ agreed: 10_000_000, paid: 0, due: 10_000_000 });
    expect(p.receipts).toHaveLength(1);
    expect(p.receipts[0].voided.reason).toBe('Transfer reversed by bank');
    u = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: unit.inventoryId });
    expect(u.paidAmount).toBe(0);
  });
});
