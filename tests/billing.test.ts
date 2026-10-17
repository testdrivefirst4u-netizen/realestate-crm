import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { billingOverview, createInvoice, saveSubscription, setInvoiceStatus } from '../server/platform/billing';

const ctx = { sa: { id: 'SA-1', name: 'Root', email: 'root@x.io' }, ip: '' } as any;
const DAY = 86400000;

let t: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test');
});

describe('billing', () => {
  it('a company without a subscription shows the plan price as "not set up"; MRR counts active ones (yearly ÷ 12)', async () => {
    let o = await billingOverview();
    expect(o.subscriptions).toHaveLength(1);
    expect(o.subscriptions[0]).toMatchObject({ companyId: 'CMP-test', configured: false });
    expect(o.mrr).toBe(0);

    await saveSubscription({ companyId: 'CMP-test', amount: 120000, currency: 'inr', cycle: 'yearly', status: 'active', startedOn: '2026-10-01', renewsOn: '2027-10-01' }, ctx);
    o = await billingOverview();
    expect(o.subscriptions[0]).toMatchObject({ configured: true, amount: 120000, currency: 'INR', cycle: 'yearly', status: 'active', renewsOn: '2027-10-01' });
    expect(o.mrr).toBe(10000);
    expect(o.payingCompanies).toBe(1);

    await saveSubscription({ companyId: 'CMP-test', amount: 0, currency: 'INR', cycle: 'monthly', status: 'complimentary' }, ctx);
    expect((await billingOverview()).mrr).toBe(0);
  });

  it('invoices: created due, overdue after the due date, paid with method and reference, void', async () => {
    const now = Date.now();
    const old = new Date(now - 40 * DAY).toISOString().slice(0, 10);
    const late = await createInvoice({ companyId: 'CMP-test', amount: 5000, currency: 'INR', issuedOn: old, dueOn: new Date(now - 10 * DAY).toISOString().slice(0, 10) }, ctx);
    expect(late).toMatchObject({ id: 'INV-0001', status: 'due', overdue: true });
    const soon = await createInvoice({ companyId: 'CMP-test', amount: 7000, currency: 'INR' }, ctx);
    expect(soon).toMatchObject({ id: 'INV-0002', status: 'due', overdue: false });

    let o = await billingOverview();
    expect(o).toMatchObject({ overdue: 5000, overdueCount: 1, dueNext30: 7000 });

    await expect(setInvoiceStatus({ id: 'INV-0001', status: 'paid', method: 'Bitcoin' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await setInvoiceStatus({ id: 'INV-0001', status: 'paid', method: 'UPI', reference: 'UTR123', paidOn: '2026-10-17' }, ctx)).toMatchObject({ status: 'paid', overdue: false, method: 'UPI', reference: 'UTR123', paidOn: '2026-10-17' });
    expect(await setInvoiceStatus({ id: 'INV-0002', status: 'void' }, ctx)).toMatchObject({ status: 'void' });
    o = await billingOverview();
    expect(o).toMatchObject({ overdue: 0, overdueCount: 0, dueNext30: 0 });
  });

  it('refuses bad input', async () => {
    await expect(saveSubscription({ companyId: 'CMP-nope', amount: 1, currency: 'INR', cycle: 'monthly', status: 'active' }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(saveSubscription({ companyId: 'CMP-test', amount: -5, currency: 'INR', cycle: 'monthly', status: 'active' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveSubscription({ companyId: 'CMP-test', amount: 5, currency: 'INR', cycle: 'weekly' as any, status: 'active' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createInvoice({ companyId: 'CMP-test', amount: 5, currency: 'INR', issuedOn: '2026-10-10', dueOn: '2026-10-01' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
