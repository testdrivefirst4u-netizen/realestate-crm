/** Channel partners: CRUD + RBAC, first-CP-keeps-it registration window, and commission accrual/void on booking. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { onUnitBookingChanged } from '../server/modules/partners';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';

let t: Awaited<ReturnType<typeof startTestDb>>;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) vitest';
const signIn = async (email: string) => (await login(email, 'long-enough-pw', { userAgent: UA, ip: '10.0.0.1' })).token;
const as = async (token: string, action: string, data: any = {}) => (await dispatch(action, data, { userAgent: 'vitest', ip: '10.0.0.1', token })).body as any;

const addLead = async (id: string, phone: string, name = 'Lead ' + id) =>
  (await col(CFG.COLL.LEADS)).insertOne({ _id: id, name, phone, phoneLast10: phone.replace(/\D/g, '').slice(-10), stage: 'New', source: '', subSource: '', followups: [], extra: {} } as any);

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await createUser({ name: 'Asha Admin', email: 'asha@cp.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null);
  await createUser({ name: 'Ravi RM', email: 'ravi@cp.test', password: 'long-enough-pw', role: 'RM', mustChangePassword: false }, null);
});

describe('CRUD and RBAC', () => {
  it('an admin adds and edits a partner; an Agent cannot', async () => {
    const admin = await signIn('asha@cp.test');
    const rm = await signIn('ravi@cp.test');
    const created = await as(admin, 'savePartner', { name: 'Prime Realty', phone: '98765 43210', defaultRate: 2 });
    expect(created.status).toBe('success');
    const id = created.data.id;
    expect(id).toMatch(/^CP-\d{4}$/);
    // an Agent may see the list but cannot create or edit
    expect((await as(rm, 'listPartners')).status).toBe('success');
    expect(await as(rm, 'savePartner', { name: 'Sneaky' })).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
    const edited = await as(admin, 'savePartner', { id, name: 'Prime Realty LLP', defaultRate: 3 });
    expect(edited.data).toMatchObject({ name: 'Prime Realty LLP', defaultRate: 3 });
  });

  it('a partner with attributed leads cannot be deleted; suspend instead', async () => {
    const admin = await signIn('asha@cp.test');
    const id = (await as(admin, 'savePartner', { name: 'Acme Brokers' })).data.id;
    await addLead('ENQ-1', '9000000001');
    expect((await as(admin, 'attributeLeadToPartner', { leadId: 'ENQ-1', cpId: id })).status).toBe('success');
    expect(await as(admin, 'deletePartner', { id })).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect((await as(admin, 'setPartnerStatus', { id, status: 'Suspended' })).data.status).toBe('Suspended');
  });
});

describe('registration window (first CP keeps it)', () => {
  it('a second partner is blocked within the window, allowed after it', async () => {
    const admin = await signIn('asha@cp.test');
    const cp1 = (await as(admin, 'savePartner', { name: 'First CP' })).data.id;
    const cp2 = (await as(admin, 'savePartner', { name: 'Second CP' })).data.id;
    await addLead('ENQ-A', '9000000002', 'Asha Buyer');
    await addLead('ENQ-B', '9000000002', 'Same Phone Buyer'); // same phone, different enquiry
    expect((await as(admin, 'attributeLeadToPartner', { leadId: 'ENQ-A', cpId: cp1 })).status).toBe('success');
    // within the window, CP2 cannot claim the same phone
    expect(await as(admin, 'attributeLeadToPartner', { leadId: 'ENQ-B', cpId: cp2 })).toMatchObject({ status: 'error', code: 'CONFLICT' });
    // re-attributing to the SAME partner is fine (idempotent)
    expect((await as(admin, 'attributeLeadToPartner', { leadId: 'ENQ-B', cpId: cp1 })).status).toBe('success');
    // age the registration past the window → CP2 may now claim
    const old = new Date(Date.now() - (CFG.CP_REGISTRATION_DAYS + 1) * 86_400_000);
    await (await col(CFG.COLL.LEADS)).updateMany({ phoneLast10: '9000000002' }, { $set: { cpRegisteredAt: old } });
    expect((await as(admin, 'attributeLeadToPartner', { leadId: 'ENQ-B', cpId: cp2 })).status).toBe('success');
  });

  it('checkCpRegistration reports who owns a phone', async () => {
    const admin = await signIn('asha@cp.test');
    const cp1 = (await as(admin, 'savePartner', { name: 'Owner CP' })).data.id;
    await addLead('ENQ-C', '9000000003');
    await as(admin, 'attributeLeadToPartner', { leadId: 'ENQ-C', cpId: cp1 });
    const r = await as(admin, 'checkCpRegistration', { phone: '9000000003' });
    expect(r.data).toMatchObject({ registered: true, partnerId: cp1, partnerName: 'Owner CP' });
    expect((await as(admin, 'checkCpRegistration', { phone: '9999999999' })).data.registered).toBe(false);
  });
});

describe('commission accrual', () => {
  it('accrues deal value × rate on booking and voids it on cancel; slabs win over the default', async () => {
    const admin = await signIn('asha@cp.test');
    const cpId = (await as(admin, 'savePartner', { name: 'Slab CP', defaultRate: 2, slabs: [{ minValue: 10_000_000, rate: 3 }] })).data.id;
    await addLead('ENQ-D', '9000000004');
    await as(admin, 'attributeLeadToPartner', { leadId: 'ENQ-D', cpId });

    // a ₹1.2cr deal → the 3% slab applies → ₹3.6L
    await onUnitBookingChanged({ inventoryId: 'U-1', unitId: 'A-101', quotedAmount: 12_000_000, price: 11_000_000 }, 'ENQ-D', 'book', 'Tester');
    let comm = await as(admin, 'partnerCommissions', { cpId });
    expect(comm.data.commissions).toHaveLength(1);
    expect(comm.data.commissions[0]).toMatchObject({ status: 'accrued', rate: 3, dealValue: 12_000_000, amount: 360_000 });
    expect(comm.data.totalAccrued).toBe(360_000);

    // cancelling the booking voids the accrual (kept, not deleted)
    await onUnitBookingChanged({ inventoryId: 'U-1', unitId: 'A-101', quotedAmount: 12_000_000, price: 11_000_000 }, 'ENQ-D', 'cancel', 'Tester');
    comm = await as(admin, 'partnerCommissions', { cpId });
    expect(comm.data.commissions[0].status).toBe('void');
    expect(comm.data.totalAccrued).toBe(0);
  });

  it('a lead with no partner accrues nothing', async () => {
    const admin = await signIn('asha@cp.test');
    await addLead('ENQ-E', '9000000005');
    await onUnitBookingChanged({ inventoryId: 'U-2', unitId: 'B-202', quotedAmount: 5_000_000, price: 5_000_000 }, 'ENQ-E', 'book', 'Tester');
    expect(await (await col(CFG.COLL.CP_COMMISSIONS)).countDocuments({})).toBe(0);
  });

  it('an Agent cannot see commission figures', async () => {
    const admin = await signIn('asha@cp.test');
    const rm = await signIn('ravi@cp.test');
    const cpId = (await as(admin, 'savePartner', { name: 'Money CP' })).data.id;
    expect(await as(rm, 'partnerCommissions', { cpId })).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
    // the Agent's partner list hides the accrued figure (null)
    const list = await as(rm, 'listPartners');
    expect(list.data.partners.find((p: any) => p.id === cpId).commissionAccrued).toBeNull();
  });
});
