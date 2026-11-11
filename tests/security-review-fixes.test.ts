/**
 * Fixes from the security review of this branch:
 * 1. payments follow "See buyers and payments": someone who sees every lead but was not given it sees none;
 * 2. an agent cannot quote below the list price without approval (the discount maker-checker held only on the ratio);
 * 3. the manager approving a booking sees the price it will be booked at.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { settingSet } from '../server/core/settings';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.9.9.9' };
const tokens: Record<string, string> = {};
async function signIn(name: string, role: 'Manager' | 'RM' | 'Admin' | 'Viewer') {
  const email = name.toLowerCase() + '@sec.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;
async function roleAccess(config: Record<string, Record<string, boolean>>) {
  await (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'roleAccess' as any }, { $set: { config } }, { upsert: true });
  (await import('../server/core/roleAccess')).clearRoleAccessCache();
}

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  (await import('../server/core/roleAccess')).clearRoleAccessCache();
  await signIn('Meera', 'Manager');
  await signIn('Admin', 'Admin');
  await signIn('Asha', 'RM');
  await signIn('Ravi', 'RM');
  await signIn('Founder', 'Viewer');
});

async function bookedUnitFor(agent: string) {
  const lead = (await as('Admin', 'addLead', { data: { 'Prospect Name': 'Buyer of ' + agent, 'Phone Number': agent === 'Asha' ? '9845011223' : '9845011224', 'Assigned RM': agent } })).data.lead['Enquiry ID'];
  const unit = (await as('Admin', 'addInventoryUnit', { data: { unitId: 'U-' + agent, price: 8_000_000 } })).data.unit;
  await as('Admin', 'updateInventoryUnit', { id: unit.inventoryId, expectedRev: 0, data: { status: 'Booked', leadId: lead, quotedAmount: 8_000_000 } });
  await as('Admin', 'recordReceipt', { unitId: unit.inventoryId, amount: 800_000, mode: 'bank', reference: 'NEFT-' + agent });
  return { lead, unitId: unit.inventoryId as string };
}

describe('payments follow "See buyers and payments"', () => {
  it('View only and a Manager who see every lead get no payments once the setting is off', async () => {
    const { unitId } = await bookedUnitFor('Asha');
    expect((await as('Founder', 'getPayments', { unitId })).data.paid).toBe(800_000); // on by default
    await roleAccess({ Viewer: { 'inventory.customers': false }, Manager: { 'inventory.customers': false } });
    expect((await as('Founder', 'getPayments', { unitId })).code).toBe('NOT_FOUND');
    expect((await as('Meera', 'getPayments', { unitId })).code).toBe('NOT_FOUND');
    expect((await as('Meera', 'recordReceipt', { unitId, amount: 1, reference: 'X-1' })).code).toBe('NOT_FOUND');
    expect((await as('Admin', 'getPayments', { unitId })).data.paid).toBe(800_000);
  });

  it("an agent allowed to see every lead still cannot read or write another agent's customer's payments", async () => {
    const mine = await bookedUnitFor('Asha');
    const theirs = await bookedUnitFor('Ravi');
    await settingSet('rmLeadVisibility', 'all', 'test');
    await roleAccess({ RM: { 'inventory.edit': true } });
    expect((await as('Asha', 'getPayments', { unitId: theirs.unitId })).code).toBe('NOT_FOUND');
    expect((await as('Asha', 'recordReceipt', { unitId: theirs.unitId, amount: 1, reference: 'X-2' })).code).toBe('NOT_FOUND');
    // under 'all' even her own customer is not buyer detail she was given; Managers / Admins hold the ledger
    expect((await as('Asha', 'getPayments', { unitId: mine.unitId })).code).toBe('NOT_FOUND');
    await settingSet('rmLeadVisibility', 'own_unassigned', 'test');
    expect((await as('Asha', 'getPayments', { unitId: mine.unitId })).data.paid).toBe(800_000);
  });
});

describe('quotations are priced from the unit', () => {
  let n = 0;
  async function leadAndUnit(price: number) {
    const lead = (await as('Admin', 'addLead', { data: { 'Prospect Name': 'Kiran R', 'Phone Number': '984501123' + n++, 'Assigned RM': 'Asha' } })).data.lead['Enquiry ID'];
    const unit = (await as('Admin', 'addInventoryUnit', { data: { unitId: 'Q-' + price, price } })).data.unit;
    return { lead, unitId: unit.inventoryId as string };
  }

  it('an agent who sends a lower base price gets the list price, not an approved cheap quote', async () => {
    const { lead, unitId } = await leadAndUnit(8_000_000);
    const q = (await as('Asha', 'saveQuote', { leadId: lead, unitId, basePrice: 1_000_000, discount: 0 })).data;
    expect(q).toMatchObject({ basePrice: 8_000_000, total: 8_000_000, status: 'approved' });
    // a discount over the limit still needs another person
    const d = (await as('Asha', 'saveQuote', { leadId: lead, unitId, discount: 1_000_000 })).data;
    expect(d.status).toBe('pendingApproval');
  });

  it('a manager may quote another base; a unit with no price needs the typed base approved', async () => {
    const { lead, unitId } = await leadAndUnit(8_000_000);
    expect((await as('Meera', 'saveQuote', { leadId: lead, unitId, basePrice: 7_500_000 })).data).toMatchObject({ basePrice: 7_500_000, status: 'approved' });
    const unpriced = await leadAndUnit(0);
    expect((await as('Asha', 'saveQuote', { leadId: unpriced.lead, unitId: unpriced.unitId, basePrice: 1_000_000 })).data.status).toBe('pendingApproval');
  });

  it('the booking approval shows the price it will book at, the discount and the list price', async () => {
    const { lead, unitId } = await leadAndUnit(8_000_000);
    await as('Asha', 'saveQuote', { leadId: lead, unitId, discount: 100_000 });
    await as('Asha', 'saveLeadPerson', { leadId: lead, person: { name: 'Kiran R', roles: ['payer'] } });
    expect((await as('Asha', 'requestBooking', { leadId: lead, unitId })).status).toBe('success');
    const [a] = (await as('Meera', 'getTeamExceptions')).data.approvals;
    expect(a).toMatchObject({ quoteTotal: 7_900_000, quoteDiscount: 100_000, quoteBase: 8_000_000, listPrice: 8_000_000 });
  });
});
