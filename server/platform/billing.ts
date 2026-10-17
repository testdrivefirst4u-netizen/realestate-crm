/**
 * Billing (super admin) — subscriptions and invoices kept by hand until a payment gateway is connected.
 *
 * Subscription per company (platform `subscriptions`, _id = companyId): amount, currency, cycle (monthly | yearly),
 * status (trial | active | overdue | complimentary | cancelled), start, renewal / trial-end date, notes.
 * A company without one shows its plan's monthly price as a suggestion.
 * Invoices (platform `invoices`, INV-0001…): amount, period, issue / due date, status (due | paid | void), payment
 * method and reference once paid. Overdue = due and past its due date.
 * MRR = active subscriptions, yearly amounts divided by 12.
 */
import { fail } from '../core/errors';
import { str, truncate } from '../core/utils';
import { nextPlatformId, pc, platformAudit, type SaCtx } from './base';
import type { BillingInvoice, BillingOverview, BillingSubscription, PlatformActions } from './contract';
import { listPlans } from './plans';
import { PCOLL } from './registry';

type Req<K extends keyof PlatformActions> = PlatformActions[K]['req'];

const SUBS = 'subscriptions';
const INVOICES = 'invoices';
const DAY = 86400000;

const CYCLES = ['monthly', 'yearly'] as const;
const SUB_STATUS = ['trial', 'active', 'overdue', 'complimentary', 'cancelled'] as const;
const PAY_METHODS = ['Bank transfer', 'UPI', 'Card', 'Cheque', 'Cash', 'Payment gateway', 'Other'];

interface SubDoc {
  _id: string; // companyId
  amount: number;
  currency: string;
  cycle: (typeof CYCLES)[number];
  status: (typeof SUB_STATUS)[number];
  startedOn: Date | null;
  renewsOn: Date | null;
  notes: string;
  updatedAt: Date;
  updatedBy: string;
}

interface InvoiceDoc {
  _id: string; // INV-0001
  companyId: string;
  amount: number;
  currency: string;
  description: string;
  periodFrom: Date | null;
  periodTo: Date | null;
  issuedOn: Date;
  dueOn: Date;
  status: 'due' | 'paid' | 'void';
  paidOn: Date | null;
  method: string;
  reference: string;
  createdAt: Date;
  createdBy: string;
}

const subs = () => pc<SubDoc>(SUBS);
const invoices = () => pc<InvoiceDoc>(INVOICES);
const companies = () => pc<{ _id: string; name: string; slug: string; plan: string; status: string; createdAt?: Date }>(PCOLL.COMPANIES);

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : '');
const dayOf = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function parseDay(v: unknown, field: string, required = false): Date | null {
  const s = str(v);
  if (!s) {
    if (required) throw fail('VALIDATION', `${field} is required`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail('VALIDATION', `${field} must be a date (yyyy-mm-dd)`);
  const d = new Date(s + 'T00:00:00.000Z');
  if (Number.isNaN(d.getTime())) throw fail('VALIDATION', `${field} is not a valid date`);
  return d;
}

function parseAmount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw fail('VALIDATION', 'Amount must be a number of 0 or more');
  return Math.round(n * 100) / 100;
}

const monthly = (s: Pick<SubDoc, 'amount' | 'cycle'>) => (s.cycle === 'yearly' ? s.amount / 12 : s.amount);

function invoiceOut(i: InvoiceDoc, name: string, now: number): BillingInvoice {
  return {
    id: i._id, companyId: i.companyId, companyName: name, amount: i.amount, currency: i.currency, description: i.description,
    periodFrom: dayOf(i.periodFrom), periodTo: dayOf(i.periodTo), issuedOn: dayOf(i.issuedOn), dueOn: dayOf(i.dueOn),
    status: i.status, overdue: i.status === 'due' && new Date(i.dueOn).getTime() + DAY <= now,
    paidOn: dayOf(i.paidOn), method: i.method, reference: i.reference,
  };
}

export async function billingOverview(nowMs = Date.now()): Promise<BillingOverview> {
  const [cos, subDocs, invDocs, plans] = await Promise.all([
    (await companies()).find({}).sort({ name: 1 }).toArray(),
    (await subs()).find({}).toArray(),
    (await invoices()).find({}).sort({ issuedOn: -1, _id: -1 }).limit(200).toArray(),
    listPlans(),
  ]);
  const subBy = new Map(subDocs.map((s) => [s._id, s]));
  const nameOf = new Map(cos.map((c) => [c._id, c.name]));
  const subscriptions: BillingSubscription[] = cos.map((c) => {
    const s = subBy.get(c._id);
    const plan = plans.find((p) => p.id === c.plan);
    return {
      companyId: c._id, companyName: c.name, companyStatus: c.status, plan: c.plan, planName: plan?.name || c.plan,
      configured: !!s,
      amount: s ? s.amount : plan?.priceMonthly || 0,
      currency: s?.currency || plan?.currency || 'INR',
      cycle: s?.cycle || 'monthly',
      status: s?.status || 'active',
      startedOn: dayOf(s?.startedOn), renewsOn: dayOf(s?.renewsOn), notes: s?.notes || '',
    };
  });
  const live = subscriptions.filter((s) => s.configured && s.status === 'active' && s.companyStatus === 'Active');
  const mrr = Math.round(live.reduce((n, s) => n + monthly(s), 0) * 100) / 100;
  const inv = invDocs.map((i) => invoiceOut(i, nameOf.get(i.companyId) || i.companyId, nowMs));
  const in30 = nowMs + 30 * DAY;
  const dueSoon = inv.filter((i) => i.status === 'due' && !i.overdue && new Date(i.dueOn).getTime() <= in30);
  const renewals = subscriptions.filter((s) => s.configured && s.status === 'active' && s.renewsOn && new Date(s.renewsOn).getTime() <= in30);
  return {
    currency: subscriptions[0]?.currency || 'INR',
    mrr,
    payingCompanies: live.length,
    dueNext30: Math.round(dueSoon.reduce((n, i) => n + i.amount, 0) * 100) / 100,
    renewalsNext30: renewals.length,
    overdue: Math.round(inv.filter((i) => i.overdue).reduce((n, i) => n + i.amount, 0) * 100) / 100,
    overdueCount: inv.filter((i) => i.overdue).length,
    trialsEnding: subscriptions.filter((s) => s.configured && s.status === 'trial' && s.renewsOn && new Date(s.renewsOn).getTime() <= nowMs + 14 * DAY).length,
    subscriptions,
    invoices: inv,
    paymentMethods: PAY_METHODS,
  };
}

export async function saveSubscription(d: Req<'saveSubscription'>, ctx: SaCtx): Promise<BillingSubscription> {
  const companyId = str(d?.companyId);
  const co = await (await companies()).findOne({ _id: companyId });
  if (!co) throw fail('NOT_FOUND', 'Company not found');
  const cycle = str(d?.cycle) as SubDoc['cycle'];
  const status = str(d?.status) as SubDoc['status'];
  if (!CYCLES.includes(cycle)) throw fail('VALIDATION', 'Billing cycle must be monthly or yearly');
  if (!SUB_STATUS.includes(status)) throw fail('VALIDATION', 'Choose a subscription status');
  const currency = (str(d?.currency) || 'INR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw fail('VALIDATION', 'Currency is a 3-letter code such as INR');
  const doc: SubDoc = {
    _id: companyId, amount: parseAmount(d?.amount), currency, cycle, status,
    startedOn: parseDay(d?.startedOn, 'Start date'), renewsOn: parseDay(d?.renewsOn, status === 'trial' ? 'Trial end date' : 'Renewal date'),
    notes: truncate(str(d?.notes), 500), updatedAt: new Date(), updatedBy: ctx.sa?.name || 'Super admin',
  };
  await (await subs()).replaceOne({ _id: companyId }, doc, { upsert: true });
  await platformAudit(ctx, 'Subscription Saved', companyId, `${status} · ${currency} ${doc.amount} ${cycle}`);
  return (await billingOverview()).subscriptions.find((s) => s.companyId === companyId)!;
}

export async function createInvoice(d: Req<'createInvoice'>, ctx: SaCtx): Promise<BillingInvoice> {
  const companyId = str(d?.companyId);
  const co = await (await companies()).findOne({ _id: companyId });
  if (!co) throw fail('NOT_FOUND', 'Company not found');
  const issuedOn = parseDay(d?.issuedOn, 'Issue date') || new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const dueOn = parseDay(d?.dueOn, 'Due date') || new Date(issuedOn.getTime() + 15 * DAY);
  if (dueOn < issuedOn) throw fail('VALIDATION', 'The due date is before the issue date');
  const currency = (str(d?.currency) || 'INR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw fail('VALIDATION', 'Currency is a 3-letter code such as INR');
  const doc: InvoiceDoc = {
    _id: await nextPlatformId('INV'), companyId, amount: parseAmount(d?.amount), currency,
    description: truncate(str(d?.description) || 'Subscription', 200),
    periodFrom: parseDay(d?.periodFrom, 'Period start'), periodTo: parseDay(d?.periodTo, 'Period end'),
    issuedOn, dueOn, status: 'due', paidOn: null, method: '', reference: '', createdAt: new Date(), createdBy: ctx.sa?.name || 'Super admin',
  };
  await (await invoices()).insertOne(doc);
  await platformAudit(ctx, 'Invoice Created', companyId, `${doc._id} · ${currency} ${doc.amount}`);
  return invoiceOut(doc, co.name, Date.now());
}

export async function setInvoiceStatus(d: Req<'setInvoiceStatus'>, ctx: SaCtx): Promise<BillingInvoice> {
  const id = str(d?.id);
  const status = str(d?.status) as InvoiceDoc['status'];
  if (!['due', 'paid', 'void'].includes(status)) throw fail('VALIDATION', 'Status must be due, paid or void');
  const c = await invoices();
  const cur = await c.findOne({ _id: id });
  if (!cur) throw fail('NOT_FOUND', 'Invoice not found');
  const set: Partial<InvoiceDoc> = { status };
  if (status === 'paid') {
    const method = str(d?.method);
    if (!PAY_METHODS.includes(method)) throw fail('VALIDATION', 'Choose how it was paid');
    Object.assign(set, { paidOn: parseDay(d?.paidOn, 'Payment date') || new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'), method, reference: truncate(str(d?.reference), 120) });
  } else {
    Object.assign(set, { paidOn: null, method: '', reference: '' });
  }
  await c.updateOne({ _id: id }, { $set: set });
  await platformAudit(ctx, status === 'paid' ? 'Invoice Paid' : status === 'void' ? 'Invoice Voided' : 'Invoice Reopened', cur.companyId, `${id}${status === 'paid' ? ` · ${set.method}${set.reference ? ' ' + set.reference : ''}` : ''}`);
  const co = await (await companies()).findOne({ _id: cur.companyId });
  return invoiceOut({ ...cur, ...set } as InvoiceDoc, co?.name || cur.companyId, Date.now());
}
