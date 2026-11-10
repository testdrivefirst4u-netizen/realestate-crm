/**
 * Release A regression tests — inventory disclosure (finding 1) and booking integrity (finding 2), through the real
 * API router so permissions, the Viewer allow-list and phone masking all apply exactly as in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { releaseExpiredHolds } from '../server/modules/inventory';
import { checkTransition } from '../server/modules/unitRules';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.1.1.2' };
const tokens: Record<string, string> = {};

async function signIn(name: string, role: 'Admin' | 'Manager' | 'RM' | 'Viewer') {
  const email = name.toLowerCase().replace(/\s+/g, '.') + '@inv.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;
const unitOf = (body: any, no: string) => (body.data.units || body.data.inventory).find((u: any) => u.unitId === no);

let ashaLead = '';
let raviLead = '';

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
  await signIn('Founder', 'Viewer');
  ashaLead = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Mrs Iyer', 'Phone Number': '9811100001', 'Assigned RM': 'Asha' } })).data.lead['Enquiry ID'];
  raviLead = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Mr Menon', 'Phone Number': '9811100002', 'Assigned RM': 'Ravi' } })).data.lead['Enquiry ID'];
  for (const [no, lead, name, notes] of [['A101', ashaLead, 'Mrs Iyer', 'Daughter decides'], ['A102', raviLead, 'Mr Menon', 'Pays from son in Dubai']]) {
    const add = await as('Meera', 'addInventoryUnit', { data: { unitId: no, price: 9000000 } });
    expect(add.status).toBe('success');
    const res = await as('Meera', 'updateInventoryUnit', { id: add.data.unit.inventoryId, expectedRev: add.data.unit.rev, data: { status: 'Booked', leadId: lead, customerName: name, contact: '9811100009', quotedAmount: 9500000, paidAmount: 1000000, notes } });
    expect(res.status).toBe('success');
    expect(res.data.conflict).toBeUndefined();
  }
});

describe('finding 1: customer fields on units reach only authorised users', () => {
  for (const action of ['getInventory', 'getBootstrap']) {
    it(`${action}: an agent sees their own buyer, not another agent's`, async () => {
      const body = await as('Asha', action);
      const own = unitOf(body, 'A101');
      const other = unitOf(body, 'A102');
      expect(own).toMatchObject({ customerName: 'Mrs Iyer', leadId: ashaLead, quotedAmount: 9500000, paidAmount: 1000000 });
      expect(other).toMatchObject({ status: 'Booked', price: 9000000, customerName: '', contact: '', leadId: '', quotedAmount: 0, paidAmount: 0, notes: '', restricted: true });
      expect(JSON.stringify(body)).not.toContain('Mr Menon');
      expect(JSON.stringify(body)).not.toContain('Dubai'); // notes are buyer detail too
    });
  }

  it('managers and the view-only founder see every buyer; the founder cannot change anything', async () => {
    for (const who of ['Meera', 'Founder']) {
      const other = unitOf(await as(who, 'getInventory'), 'A102');
      expect(other).toMatchObject({ customerName: 'Mr Menon', leadId: raviLead, quotedAmount: 9500000 });
      expect(other.restricted).toBeUndefined();
    }
    const u = unitOf(await as('Founder', 'getInventory'), 'A102');
    const w = await as('Founder', 'updateInventoryUnit', { id: u.inventoryId, expectedRev: u.rev, data: { price: 1 } });
    expect(w.code).toBe('FORBIDDEN');
  });

  it('a company can switch buyer details off for View only users (Roles & access)', async () => {
    const saved = await (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'roleAccess' as any }, { $set: { config: { Viewer: { 'inventory.customers': false } } } }, { upsert: true });
    expect(saved.acknowledged).toBe(true);
    const { clearRoleAccessCache } = await import('../server/core/roleAccess');
    clearRoleAccessCache();
    await signIn('Investor', 'Viewer');
    const other = unitOf(await as('Investor', 'getInventory'), 'A102');
    expect(other).toMatchObject({ customerName: '', restricted: true });
  });

  it('the event feed carries no buyer names and follows the lead', async () => {
    const feed = await as('Asha', 'getEvents', { sinceId: '' });
    const text = JSON.stringify(feed.data.events);
    expect(text).not.toContain('Mr Menon');
    const inv = (feed.data.events as any[]).filter((e) => e.type === 'inventory_status');
    expect(inv).toHaveLength(1); // her own unit only
  });

  it('an agent cannot link a unit to a lead they cannot see', async () => {
    await signIn('Boss', 'Admin');
    // give agents inventory.edit for this test
    await (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'roleAccess' as any }, { $set: { config: { RM: { 'inventory.edit': true } } } }, { upsert: true });
    (await import('../server/core/roleAccess')).clearRoleAccessCache();
    await signIn('Asha2', 'RM');
    const add = await as('Boss', 'addInventoryUnit', { data: { unitId: 'B201' } });
    const r = await as('Asha2', 'updateInventoryUnit', { id: add.data.unit.inventoryId, expectedRev: 0, data: { status: 'Reserved', leadId: raviLead } });
    expect(r.code).toBe('NOT_FOUND');
  });
});

describe('finding 2: reservations and bookings are atomic', () => {
  it('twenty simultaneous attempts to reserve one unit produce exactly one winner', async () => {
    const add = await as('Meera', 'addInventoryUnit', { data: { unitId: 'C301' } });
    const id = add.data.unit.inventoryId;
    const leads: string[] = [];
    for (let i = 0; i < 20; i++) {
      leads.push((await as('Meera', 'addLead', { data: { 'Prospect Name': `Family ${i}`, 'Phone Number': `98222${String(10000 + i)}` } })).data.lead['Enquiry ID']);
    }
    const results = await Promise.all(leads.map((leadId, i) => as('Meera', 'updateInventoryUnit', { id, expectedRev: 0, idempotencyKey: `try-${i}`, data: { status: 'Reserved', leadId } })));
    const winners = results.filter((r) => r.status === 'success' && !r.data.conflict);
    const losers = results.filter((r) => r.status === 'success' && r.data.conflict);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(19);
    expect(losers[0].data.reason).toMatch(/changed|reserved/i);
    const stored = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: id });
    expect(stored.status).toBe('Reserved');
    expect(stored.leadId).toBe(winners[0].data.unit.leadId);
    expect(stored.rev).toBe(1);
    expect(stored.holdUntil.getTime()).toBeGreaterThan(Date.now() + 47 * 3600e3);
    const timeline = await (await col<any>(CFG.COLL.TIMELINE)).countDocuments({ type: 'inventory', refId: id });
    expect(timeline).toBe(1);
  });

  it('a write must name its revision; a stale revision is refused with the current copy', async () => {
    const add = await as('Meera', 'addInventoryUnit', { data: { unitId: 'C302', price: 100 } });
    const id = add.data.unit.inventoryId;
    expect((await as('Meera', 'updateInventoryUnit', { id, data: { price: 200 } })).code).toBe('VALIDATION');
    const first = await as('Meera', 'updateInventoryUnit', { id, expectedRev: 0, data: { price: 200 } });
    expect(first.data.unit).toMatchObject({ price: 200, rev: 1 });
    const stale = await as('Meera', 'updateInventoryUnit', { id, expectedRev: 0, data: { price: 300 } });
    expect(stale.data.conflict).toMatchObject({ price: 200, rev: 1 });
  });

  it('the same submission twice is applied once', async () => {
    const add = await as('Meera', 'addInventoryUnit', { data: { unitId: 'C303' } });
    const id = add.data.unit.inventoryId;
    const a = await as('Meera', 'updateInventoryUnit', { id, expectedRev: 0, idempotencyKey: 'k1', data: { status: 'Reserved', leadId: ashaLead } });
    const b = await as('Meera', 'updateInventoryUnit', { id, expectedRev: 0, idempotencyKey: 'k1', data: { status: 'Reserved', leadId: ashaLead } });
    expect(a.data.conflict).toBeUndefined();
    expect(b.data.conflict).toBeUndefined();
    expect(b.data.replay).toBe(true);
    expect((await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: id })).rev).toBe(1);
  });

  it('a generic field edit cannot bypass booking rules', async () => {
    const a102 = unitOf(await as('Meera', 'getInventory'), 'A102');
    // booked for Ravi's customer: cannot be handed to Asha's customer by editing the lead
    const steal = await as('Meera', 'updateInventoryUnit', { id: a102.inventoryId, expectedRev: a102.rev, data: { leadId: ashaLead, customerName: 'Mrs Iyer' } });
    expect(steal.data.conflict).toBeDefined();
    expect(steal.data.reason).toMatch(/already booked/);
    const add = await as('Meera', 'addInventoryUnit', { data: { unitId: 'C304' } });
    // Booked needs a lead
    expect((await as('Meera', 'updateInventoryUnit', { id: add.data.unit.inventoryId, expectedRev: 0, data: { status: 'Booked' } })).code).toBe('VALIDATION');
    // cannot be created already booked
    expect((await as('Meera', 'addInventoryUnit', { data: { unitId: 'C305', status: 'Booked', leadId: ashaLead } })).code).toBe('VALIDATION');
  });

  it('cancelling a booking needs inventory.approve', () => {
    expect(checkTransition({ status: 'Booked', leadId: 'ENQ-1' }, { status: 'Available', leadId: '' }, { canApprove: false })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(checkTransition({ status: 'Booked', leadId: 'ENQ-1' }, { status: 'Available', leadId: '' }, { canApprove: true })).toMatchObject({ ok: true, kind: 'cancel' });
    expect(checkTransition({ status: 'Reserved', leadId: 'ENQ-1' }, { status: 'Sold', leadId: 'ENQ-1' }, { canApprove: true })).toMatchObject({ ok: false });
  });

  it('a lapsed reservation is free again: another customer can take it, and the job releases it', async () => {
    const add = await as('Meera', 'addInventoryUnit', { data: { unitId: 'C306' } });
    const id = add.data.unit.inventoryId;
    await as('Meera', 'updateInventoryUnit', { id, expectedRev: 0, data: { status: 'Reserved', leadId: ashaLead } });
    await (await col<any>(CFG.COLL.INVENTORY)).updateOne({ _id: id }, { $set: { holdUntil: new Date(Date.now() - 60_000) } });
    const take = await as('Meera', 'updateInventoryUnit', { id, expectedRev: 1, data: { status: 'Reserved', leadId: raviLead } });
    expect(take.data.conflict).toBeUndefined();
    expect(take.data.unit.leadId).toBe(raviLead);

    await (await col<any>(CFG.COLL.INVENTORY)).updateOne({ _id: id }, { $set: { holdUntil: new Date(Date.now() - 60_000) } });
    expect(await releaseExpiredHolds()).toEqual({ released: 1 });
    const stored = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: id });
    expect(stored).toMatchObject({ status: 'Available', leadId: '', customerName: '', rev: 3 });
  });
});
