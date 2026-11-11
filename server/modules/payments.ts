/**
 * Post-sales payments (Release D): a schedule of milestones and an append-only receipts ledger per booked unit.
 *
 * The unit's `paidAmount` used to be a number anyone with inventory.edit could type over — a total, not a record of
 * money received. Now:
 *   schedule   milestones (Token, On agreement, Slab 1…, On possession) with amount, due date and the payer
 *              (a person of the lead) — set by someone with inventory.approve, versioned on every change
 *   receipts   one entry per payment received: amount, date, mode, reference, who recorded it. Never edited or
 *              deleted: a mistake is VOIDED with a reason (by someone else, with inventory.approve) and stays visible
 *   paid       = sum of receipts not voided. Written to the unit's paidAmount (and dueDate = the next unpaid
 *              milestone) by the ledger only, so reminders and reports read a derived figure
 * A receipt with the same reference twice is refused (no double counting of one bank transfer).
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import { assertLeadAccess } from '../core/scope';
import { shortId, str, truncate } from '../core/utils';

export interface Milestone { id: string; label: string; amount: number; dueDate: string; payerId: string }
export interface ScheduleDoc { _id: string; leadId: string; version: number; milestones: Milestone[]; total: number; updatedAt: Date; updatedBy: string }
export interface ReceiptDoc {
  _id: string; // RCPT_…
  unitId: string;
  leadId: string;
  amount: number;
  receivedOn: Date;
  mode: 'bank' | 'cheque' | 'upi' | 'card' | 'other';
  reference: string;
  payerId: string;
  recordedBy: string;
  recordedAt: Date;
  voided?: { by: string; at: Date; reason: string };
}
const schedules = () => col<ScheduleDoc>('paymentSchedules'); // _id = unit inventory id
const receipts = () => col<ReceiptDoc>('receipts');
const units = () => col<any>(CFG.COLL.INVENTORY);
const money = (v: unknown) => Math.round(Number(String(v ?? '').replace(/[,₹\s]/g, '')) || 0);
const who = (ctx: Ctx) => ctx?.user?.name || 'System';

async function bookedUnit(unitId: string, ctx: Ctx) {
  const u = await (await units()).findOne({ _id: str(unitId) });
  if (!u) throw fail('NOT_FOUND', 'Unit not found');
  if (!['Booked', 'Sold'].includes(String(u.status))) throw fail('VALIDATION', 'Payments are recorded on booked units');
  await assertLeadAccess(ctx, u.leadId);
  if (ctx?.user && !can(ctx.user, 'inventory.customers')) {
    const { visibleLeadIds } = await import('../core/scope');
    const ids = await visibleLeadIds(ctx.user);
    if (ids && !ids.has(String(u.leadId))) throw fail('NOT_FOUND', 'Unit not found');
  }
  return u;
}

/**
 * A schedule typed by hand. Units normally get theirs from the registered payment plan (server/modules/rera.ts);
 * anything else departs from the standard terms, so it needs a reason (Amaya SOP 14: MD approval) and is marked.
 */
export async function setSchedule(d: { unitId: string; milestones: Array<Partial<Milestone>>; reason?: string }, ctx: Ctx) {
  if (!can(ctx.user, 'inventory.approve')) throw fail('FORBIDDEN', 'A manager sets the payment schedule');
  const reason = truncate(str(d?.reason), 300);
  if (!reason) throw fail('VALIDATION', 'A schedule outside the registered payment plan is a deviation: give the reason and who approved it');
  const u = await bookedUnit(d.unitId, ctx);
  const list = (Array.isArray(d.milestones) ? d.milestones : []).slice(0, 40).map((m) => {
    const label = truncate(str(m.label), 60);
    const amount = money(m.amount);
    const due = m.dueDate ? new Date(m.dueDate) : null;
    if (!label || amount <= 0) throw fail('VALIDATION', 'Each milestone needs a name and an amount');
    if (due && Number.isNaN(due.getTime())) throw fail('VALIDATION', `Invalid date for ${label}`);
    return { id: str(m.id) || shortId('MS'), label, amount, dueDate: due ? due.toISOString() : '', payerId: str(m.payerId) };
  });
  const total = list.reduce((a, m) => a + m.amount, 0);
  const quoted = Number(u.quotedAmount || 0);
  if (quoted && total !== quoted) throw fail('VALIDATION', `The milestones add up to ₹${total.toLocaleString('en-IN')}, the agreed price is ₹${quoted.toLocaleString('en-IN')}`);
  const prev = await (await schedules()).findOne({ _id: u._id });
  const doc: ScheduleDoc & { deviation: true; deviationReason: string } = { _id: u._id, leadId: String(u.leadId), version: (prev?.version || 0) + 1, milestones: list, total, updatedAt: new Date(), updatedBy: who(ctx), deviation: true, deviationReason: reason };
  await (await schedules()).replaceOne({ _id: u._id }, doc, { upsert: true });
  await auditLog(ctx, 'Payment Schedule Set', 'Inventory', u._id, `v${doc.version}: ${list.length} milestones, ₹${total}`, { before: prev || null, after: doc });
  await syncUnit(u._id);
  return doc;
}

export async function recordReceipt(d: { unitId: string; amount: unknown; receivedOn?: string; mode?: string; reference?: string; payerId?: string }, ctx: Ctx) {
  const u = await bookedUnit(d.unitId, ctx);
  const amount = money(d.amount);
  if (amount <= 0) throw fail('VALIDATION', 'Enter the amount received');
  const reference = truncate(str(d.reference), 80);
  if (!reference) throw fail('VALIDATION', 'Enter the bank / UPI / cheque reference');
  const on = d.receivedOn ? new Date(d.receivedOn) : new Date();
  if (Number.isNaN(on.getTime()) || on.getTime() > Date.now() + 86400e3) throw fail('VALIDATION', 'Enter the date the money was received');
  const mode = (['bank', 'cheque', 'upi', 'card', 'other'].includes(str(d.mode)) ? str(d.mode) : 'bank') as ReceiptDoc['mode'];
  const r = await receipts();
  if (await r.findOne({ unitId: u._id, reference, voided: { $exists: false } })) throw fail('CONFLICT', `A receipt with reference ${reference} is already recorded for this unit`);
  // RERA Act s. 13: at most 10 % of the cost before the agreement for sale is registered
  if (!u.agreementRegisteredAt) {
    const cost = Number(u.quotedAmount || u.price || 0);
    const already = (await r.find({ unitId: u._id, voided: { $exists: false } }).toArray()).reduce((a, x) => a + x.amount, 0);
    if (cost > 0 && already + amount > Math.round(cost * 0.1)) {
      throw fail('VALIDATION', `Before the agreement for sale is registered, at most 10 % of the cost (₹${Math.round(cost * 0.1).toLocaleString('en-IN')}) can be received (RERA, Section 13). ₹${already.toLocaleString('en-IN')} is already recorded. Record the registered agreement first.`);
    }
  }
  const doc: ReceiptDoc = { _id: shortId('RCPT'), unitId: u._id, leadId: String(u.leadId), amount, receivedOn: on, mode, reference, payerId: str(d.payerId), recordedBy: who(ctx), recordedAt: new Date() };
  await r.insertOne(doc);
  await addTimeline(String(u.leadId), 'payment', `Payment received: ₹${amount.toLocaleString('en-IN')}`, `${mode.toUpperCase()} · ${reference}`, who(ctx), 'Receipt', doc._id);
  await auditLog(ctx, 'Receipt Recorded', 'Inventory', u._id, `₹${amount} · ${mode} · ${reference}`);
  await syncUnit(u._id);
  return doc;
}

export async function voidReceipt(id: string, reason: string, ctx: Ctx) {
  if (!can(ctx.user, 'inventory.approve')) throw fail('FORBIDDEN', 'A manager voids a receipt');
  if (!str(reason)) throw fail('VALIDATION', 'Say why the receipt is void');
  const r = await receipts();
  const doc = await r.findOne({ _id: str(id) });
  if (!doc) throw fail('NOT_FOUND', 'Receipt not found');
  await bookedUnit(doc.unitId, ctx);
  if (doc.recordedBy === who(ctx)) throw fail('FORBIDDEN', 'Someone other than the person who recorded it must void a receipt');
  const done = await r.findOneAndUpdate({ _id: doc._id, voided: { $exists: false } }, { $set: { voided: { by: who(ctx), at: new Date(), reason: truncate(reason, 300) } } }, { returnDocument: 'after' });
  if (!done) throw fail('CONFLICT', 'This receipt is already void');
  await auditLog(ctx, 'Receipt Voided', 'Inventory', doc.unitId, `₹${doc.amount} · ${doc.reference} · ${reason}`);
  await syncUnit(doc.unitId);
  return done;
}

/** paidAmount and the next due date on the unit come from the ledger (never typed). */
export async function syncUnit(unitId: string) {
  const list = await (await receipts()).find({ unitId, voided: { $exists: false } }).toArray();
  const paid = list.reduce((a, x) => a + x.amount, 0);
  const s = await (await schedules()).findOne({ _id: unitId });
  let running = 0;
  let next: Date | null = null;
  for (const m of s?.milestones || []) {
    running += m.amount;
    if (running > paid && m.dueDate) {
      next = new Date(m.dueDate);
      break;
    }
  }
  await (await units()).updateOne({ _id: unitId }, { $set: { paidAmount: paid, dueDate: next, ledger: true }, $inc: { rev: 1 } });
  return { paid, nextDue: next };
}

export async function getPayments(unitId: string, ctx: Ctx) {
  const u = await bookedUnit(unitId, ctx);
  const [s, list] = await Promise.all([(await schedules()).findOne({ _id: u._id }), (await receipts()).find({ unitId: u._id }).sort({ receivedOn: 1 }).toArray()]);
  const paid = list.filter((x) => !x.voided).reduce((a, x) => a + x.amount, 0);
  return { unitId: u._id, agreed: Number(u.quotedAmount || 0), paid, due: Math.max(0, Number(u.quotedAmount || 0) - paid), schedule: s, receipts: list };
}

export const actions: ActionMap = {
  getPayments: { perm: 'inventory.view', fn: (d, ctx) => getPayments(str(d?.unitId), ctx) },
  setPaymentSchedule: { perm: 'inventory.approve', fn: (d, ctx) => setSchedule(d, ctx) },
  recordReceipt: { perm: 'inventory.edit', fn: (d, ctx) => recordReceipt(d, ctx) },
  voidReceipt: { perm: 'inventory.approve', fn: (d, ctx) => voidReceipt(str(d?.id), str(d?.reason), ctx) },
};
