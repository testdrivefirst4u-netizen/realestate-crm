/**
 * WhatsApp credits (plan feature whatsappCredits, on top of whatsappDirect): BroaddCast bills its clients, so Super Admin adds
 * credits, 1 credit = ₹1, GST invoiced apart. Companies without the switch are never touched: nothing is held or charged.
 *
 * A paid message: enough credits are held before it goes out (so a bulk send cannot overrun the balance), then the price is
 * charged when Meta says it was delivered, using what Meta says it costs. Not delivered: the hold is released, nothing charged.
 * Meta's free messages (first 1,000 replies a month, the window after a click-to-WhatsApp ad) are free to the client too.
 *
 * Every change is an entry in the ledger, which is never edited; the balance is kept with it, and Super Admin sees if they differ.
 * Amounts are stored in ten-thousandths of a rupee (Meta's rates have four decimals), so there are no rounding errors.
 */
import type { ActionMap } from '../core/actions';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { dateKey } from '../core/utils';
import { pc } from '../platform/base';
import { PCOLL } from '../platform/registry';
import { notifyAdmins } from './adminAlerts';

export const UNITS = 10000;
export const toUnits = (rupees: number) => Math.round(rupees * UNITS);
export const toRupees = (units: number) => Math.round(units) / UNITS;
const money2 = (units: number) => Math.round(units / 100) / 100;

export const CATEGORIES = ['marketing', 'utility', 'authentication', 'service'] as const;
export type Category = (typeof CATEGORIES)[number];
export interface WhatsappPricing { prices: Record<Category, number>; costs: Record<Category, number>; lowBalanceAt: number; replyGrace: number }

/** Meta's rates for India as reported in November 2026; Super Admin can change them when Meta does. */
export const PRICING_DEFAULTS: WhatsappPricing = {
  prices: { marketing: 0.96, utility: 0.15, authentication: 0.15, service: 0.15 },
  costs: { marketing: 0.8631, utility: 0.115, authentication: 0.115, service: 0.115 },
  lowBalanceAt: 500,
  replyGrace: 50,
};
const PRICING_ID = 'whatsappPricing';
const pricingCol = () => pc<any>(PCOLL.PLATFORM_SETTINGS);

export async function getPricing(): Promise<WhatsappPricing> {
  const d = await (await pricingCol()).findOne({ _id: PRICING_ID });
  return { prices: { ...PRICING_DEFAULTS.prices, ...d?.prices }, costs: { ...PRICING_DEFAULTS.costs, ...d?.costs }, lowBalanceAt: d?.lowBalanceAt ?? PRICING_DEFAULTS.lowBalanceAt, replyGrace: d?.replyGrace ?? PRICING_DEFAULTS.replyGrace };
}

export async function setPricing(p: WhatsappPricing, by: string) {
  await (await pricingCol()).updateOne({ _id: PRICING_ID }, { $set: { ...p, updatedAt: new Date(), updatedBy: by } }, { upsert: true });
}

interface Wallet { _id: string; balance: number; held: number; graceMonth?: string; graceUsed?: number; updatedAt?: Date }
export interface LedgerEntry {
  _id: string; companyId: string; type: 'credit' | 'charge' | 'free'; units: number; costUnits: number; category: string; template: string; agent: string;
  day: string; at: Date; reference?: string; note?: string; by?: string; estimated?: boolean; campaignId?: string;
}

const walletCol = () => col<Wallet>('whatsappWallet');
export const ledgerCol = () => col<LedgerEntry>('whatsappLedger');
const lateCol = () => col<{ _id: string; statuses: any[]; at: Date }>('whatsappLateStatus');
const msgs = () => col<any>(CFG.COLL.CHAT_MESSAGES);
const companyId = () => currentTenant()?.id || '';

/** Does this company pay by credits? Both switches, deliberately. */
export const creditsOn = () => {
  const f = currentTenant()?.features as any;
  return !!(f?.whatsappCredits && f?.whatsappDirect);
};

async function wallet(): Promise<Wallet> {
  const c = await walletCol();
  const id = companyId();
  const found = await c.findOne({ _id: id });
  if (found) return found;
  try {
    await c.insertOne({ _id: id, balance: 0, held: 0, updatedAt: new Date() });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
  }
  return (await c.findOne({ _id: id }))!;
}

/** Meta's name for what a message costs, as one of the prices here. */
export function normalizeCategory(raw: unknown, fallback: string = 'service'): Category {
  const s = String(raw || '').toLowerCase();
  if (s.startsWith('marketing')) return 'marketing';
  if (s.startsWith('utility')) return 'utility';
  if (s.startsWith('authentication')) return 'authentication';
  if (s.startsWith('service')) return 'service';
  return CATEGORIES.includes(fallback as Category) ? (fallback as Category) : 'service';
}

/* ------------------------------- before sending ----------------------------- */

export const NO_CREDITS = 'WhatsApp credits are finished, so this was not sent. Tell your Admin.';

/**
 * Hold what this message will cost. When credits run out, a customer who wrote in can still be answered, up to a small limit a
 * month, so nobody is ignored; those go below zero. Anything else is refused here, before it reaches Meta.
 */
export async function holdForSend(category: Category, phone: string, now = new Date()): Promise<{ units: number; grace: boolean }> {
  // prices here are for India; other countries cost differently, and are off until they are priced
  if (!/^91\d{10}$/.test(phone)) throw fail('VALIDATION', 'WhatsApp credits cover Indian numbers only for now, so this was not sent.');
  const pricing = await getPricing();
  await wallet();
  const c = await walletCol();
  const id = companyId();
  const units = toUnits(pricing.prices[category]);
  const held = await c.updateOne({ _id: id, $expr: { $gte: [{ $subtract: ['$balance', '$held'] }, units] } } as any, { $inc: { held: units }, $set: { updatedAt: now } });
  if (held.modifiedCount) return { units, grace: false };
  if (category === 'service' && pricing.replyGrace > 0) {
    const month = dateKey(now).slice(0, 7);
    await c.updateOne({ _id: id, graceMonth: { $ne: month } }, { $set: { graceMonth: month, graceUsed: 0 } });
    const r = await c.updateOne({ _id: id, graceMonth: month, graceUsed: { $lt: pricing.replyGrace } }, { $inc: { graceUsed: 1 } });
    if (r.modifiedCount) return { units: 0, grace: true };
  }
  await warnLow(pricing).catch(() => undefined);
  throw fail('VALIDATION', NO_CREDITS);
}

/** The send did not go out. */
export async function releaseUnits(units: number) {
  if (units > 0) await (await walletCol()).updateOne({ _id: companyId() }, { $inc: { held: -units } });
}

/** Every user's bell can show this, and e-mails go to the alert list: it says nothing about amounts. */
async function warnLow(pricing: WhatsappPricing, nowMs = Date.now()) {
  const w = await wallet();
  const free = w.balance - w.held;
  if (free <= 0) await notifyAdmins('credits-out', 'WhatsApp credits are finished', 'Paid WhatsApp messages have stopped. Ask BroaddCast to add credits.', nowMs);
  else if (free < toUnits(pricing.lowBalanceAt)) await notifyAdmins('credits-low', 'WhatsApp credits are running low', 'Ask BroaddCast to add credits before they run out. Admins can see the balance under WhatsApp Credits.', nowMs);
}

/* -------------------------------- after sending ----------------------------- */

/** Meta says it was delivered: charge once, whatever repeats arrive. */
export async function settleMessage(row: any, pricing: { billable?: boolean; category?: string } | null | undefined, now = new Date()) {
  if (!row?.creditTracked) return;
  const rates = await getPricing();
  const billable = pricing?.billable ?? row.billable;
  const category = normalizeCategory(pricing?.category ?? row.pricingCategory, row.creditCategory);
  const free = billable === false;
  const units = free ? 0 : toUnits(rates.prices[category]);
  const entry: LedgerEntry = {
    _id: `charge:${row._id}`, companyId: companyId(), type: free ? 'free' : 'charge', units: -units, costUnits: free ? 0 : toUnits(rates.costs[category]), category,
    template: String(row.creditTemplate || ''), agent: String(row.agent || ''), day: dateKey(now), at: now, ...(billable === undefined ? { estimated: true } : {}), ...(row.campaignId ? { campaignId: String(row.campaignId) } : {}),
  };
  try {
    await (await ledgerCol()).insertOne(entry);
  } catch (e: any) {
    if (e?.code === 11000) return; // already charged
    throw e;
  }
  const hold = Number(row.creditHold) || 0;
  await (await walletCol()).updateOne({ _id: companyId() }, { $inc: { balance: -units, held: -hold }, $set: { updatedAt: now } });
  if (hold) await (await msgs()).updateOne({ _id: row._id }, { $set: { creditHold: 0 } });
  if (units) await warnLow(rates, now.getTime()).catch(() => undefined);
}

/** Not delivered: nothing to pay. */
export async function releaseMessage(row: any) {
  if (!row?.creditTracked) return;
  const was = await (await msgs()).findOneAndUpdate({ _id: row._id, creditHold: { $gt: 0 } }, { $set: { creditHold: 0 } });
  if (was) await releaseUnits(Number(was.creditHold) || 0);
}

/** A receipt can arrive before the send has finished saving its message: kept for the send to pick up. */
export async function keepLateStatus(id: string, status: any, now = new Date()) {
  await (await lateCol()).updateOne({ _id: id }, { $push: { statuses: status }, $setOnInsert: { at: now } } as any, { upsert: true });
}
export async function takeLateStatuses(id: string): Promise<any[]> {
  return (await (await lateCol()).findOneAndDelete({ _id: id }))?.statuses || [];
}

const HOLD_MAX_MS = 3 * 86400000;
const LATE_MAX_MS = 3600000;

/** From the background job: holds nothing ever came back for stop tying up credits; a delivery with no saved message is still charged, since Meta bills it. */
export async function sweepCredits(now = new Date()): Promise<{ released: number; charged: number }> {
  const out = { released: 0, charged: 0 };
  if (!creditsOn()) return out;
  for (const row of await (await msgs()).find({ creditTracked: true, creditHold: { $gt: 0 }, timestamp: { $lt: new Date(now.getTime() - HOLD_MAX_MS) } }).limit(500).toArray()) {
    await releaseMessage(row);
    out.released++;
  }
  const late = await lateCol();
  for (const doc of await late.find({ at: { $lt: new Date(now.getTime() - LATE_MAX_MS) } }).limit(200).toArray()) {
    // only what Meta itself says it billed: a message with no saved copy may never have been ours to charge
    const done = doc.statuses.find((s: any) => (s?.status === 'delivered' || s?.status === 'read') && s?.pricing?.billable === true);
    if (done) {
      await settleMessage({ _id: doc._id, creditTracked: true, creditHold: 0 }, done.pricing, now);
      out.charged++;
    }
    await late.deleteOne({ _id: doc._id });
  }
  return out;
}

/* ---------------------------------- reports --------------------------------- */

export interface StatementRow { date: string; details: string; credit: number; used: number; balance: number }

/** Credits one by one, usage one line a day, with the balance after each, newest first. Same-day credits come before that day's usage. */
export function buildStatement(entries: Array<Pick<LedgerEntry, 'type' | 'units' | 'day' | 'at' | 'note' | 'reference'>>, openingUnits: number): StatementRow[] {
  const byDay = new Map<string, { units: number; messages: number }>();
  const lines: Array<{ day: string; order: number; details: string; units: number }> = [];
  for (const e of entries) {
    if (e.type === 'credit') {
      const what = e.units >= 0 ? 'Added by BroaddCast' : 'Correction by BroaddCast';
      lines.push({ day: e.day, order: 0, details: [what, e.note].filter(Boolean).join(': '), units: e.units });
    } else {
      const d = byDay.get(e.day) || { units: 0, messages: 0 };
      d.units += e.units;
      d.messages += 1;
      byDay.set(e.day, d);
    }
  }
  for (const [day, d] of byDay) lines.push({ day, order: 1, details: `${d.messages.toLocaleString('en-IN')} WhatsApp message${d.messages === 1 ? '' : 's'}`, units: d.units });
  lines.sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order);
  let running = openingUnits;
  const out = lines.map((l) => {
    running += l.units;
    return { date: l.day, details: l.details, credit: l.units > 0 ? toRupees(l.units) : 0, used: l.units < 0 ? toRupees(-l.units) : 0, balance: toRupees(running) };
  });
  return out.reverse();
}

const monthRe = /^\d{4}-\d{2}$/;
export const monthOf = (raw: unknown, now = new Date()) => (monthRe.test(String(raw || '')) ? String(raw) : dateKey(now).slice(0, 7));

async function monthEntries(month: string) {
  return (await ledgerCol()).find({ companyId: companyId(), day: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray();
}

/** One company's month, for its own screen and for Super Admin. */
export async function monthSummary(month: string) {
  const entries = await monthEntries(month);
  const w = await wallet();
  const used = entries.filter((e) => e.type !== 'credit');
  const sum = (list: LedgerEntry[], f: (e: LedgerEntry) => number) => list.reduce((t, e) => t + f(e), 0);
  const ledgerTotal = (await (await ledgerCol()).aggregate<{ t: number }>([{ $match: { companyId: companyId() } }, { $group: { _id: null, t: { $sum: '$units' } } }]).toArray())[0]?.t || 0;
  return {
    entries, wallet: w, used,
    addedUnits: sum(entries.filter((e) => e.type === 'credit'), (e) => e.units),
    usedUnits: sum(used, (e) => -e.units),
    costUnits: sum(used, (e) => e.costUnits),
    // the balance and the ledger must always agree
    mismatchUnits: w.balance - ledgerTotal,
  };
}

/** What a client sees: never Meta's cost or the margin. */
export async function creditsOverview(d: any, now = new Date()) {
  const month = monthOf(d?.month, now);
  const s = await monthSummary(month);
  const pricing = await getPricing();
  const today = dateKey(now);
  const group = <K extends string>(key: (e: LedgerEntry) => K) => {
    const m = new Map<K, { messages: number; free: number; units: number }>();
    for (const e of s.used) {
      const k = key(e);
      const r = m.get(k) || { messages: 0, free: 0, units: 0 };
      r.messages++;
      if (e.type === 'free') r.free++;
      r.units -= e.units;
      m.set(k, r);
    }
    return [...m.entries()].map(([k, r]) => ({ key: k, messages: r.messages, free: r.free, amount: toRupees(r.units) }));
  };
  const opening = (await (await ledgerCol()).aggregate<{ t: number }>([{ $match: { companyId: companyId(), day: { $lt: `${month}-01` } } }, { $group: { _id: null, t: { $sum: '$units' } } }]).toArray())[0]?.t || 0;
  const available = s.wallet.balance - s.wallet.held;
  const days = await (await ledgerCol()).distinct('day', { companyId: companyId() });
  return {
    month, months: [...new Set([today.slice(0, 7), ...days.map((x) => String(x).slice(0, 7))])].sort().reverse(),
    balance: toRupees(s.wallet.balance), held: toRupees(s.wallet.held), available: toRupees(available),
    low: available < toUnits(pricing.lowBalanceAt), finished: available <= 0,
    usedToday: toRupees(s.used.filter((e) => e.day === today).reduce((t, e) => t - e.units, 0)), usedMonth: toRupees(s.usedUnits), addedMonth: toRupees(s.addedUnits),
    byType: group((e) => e.category as string).sort((a, b) => CATEGORIES.indexOf(a.key as Category) - CATEGORIES.indexOf(b.key as Category)),
    byDay: group((e) => e.day).sort((a, b) => a.key.localeCompare(b.key)),
    byTemplate: group((e) => e.template || 'Typed messages').sort((a, b) => b.amount - a.amount).slice(0, 50),
    prices: pricing.prices,
    statement: buildStatement(s.entries, opening),
  };
}

export async function creditsBalance() {
  const w = await wallet();
  const pricing = await getPricing();
  const available = w.balance - w.held;
  return { available: money2(available), low: available < toUnits(pricing.lowBalanceAt), finished: available <= 0 };
}

/** Super Admin only (server/platform/whatsappCredits.ts). A repeat of the same request does nothing, so a double click cannot add twice. */
export async function addCreditEntry(o: { requestId: string; units: number; reference: string; note: string; by: string }, now = new Date()): Promise<{ applied: boolean }> {
  await wallet();
  try {
    await (await ledgerCol()).insertOne({ _id: `credit:${o.requestId}`, companyId: companyId(), type: 'credit', units: o.units, costUnits: 0, category: '', template: '', agent: '', day: dateKey(now), at: now, reference: o.reference, note: o.note, by: o.by });
  } catch (e: any) {
    if (e?.code === 11000) return { applied: false };
    throw e;
  }
  await (await walletCol()).updateOne({ _id: companyId() }, { $inc: { balance: o.units }, $set: { updatedAt: now } });
  return { applied: true };
}

export const actions: ActionMap = {
  waCreditsOverview: { fn: (d) => creditsOverview(d), perm: 'reports.credits' },
  waCreditsBalance: { fn: () => creditsBalance(), perm: 'reports.credits' },
};
