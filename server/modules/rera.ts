/**
 * RERA payment schedules for Telangana projects (Amaya Phase 1, Medchal). Builds on server/modules/payments.ts
 * (receipts ledger) and writes the same `paymentSchedules` documents with richer milestones.
 *
 * What the law fixes, and how this follows it (confirm the specifics with Amaya's counsel):
 *   - Section 13, RERA Act 2016: no more than 10 % of the cost as advance / application fee before a written
 *     agreement for sale is REGISTERED. Enforced: demands and receipts before registration are capped at 10 %.
 *   - Agreement for sale in the TG-RERA format (Telangana Rules 2017, Rule 38 / Annexure A), verbatim as filed at
 *     registration, with its payment plan. So a PLAN here is entered by an admin from Amaya's registered agreement
 *     (with its reference), never invented by the CRM; a unit's schedule is generated from that plan. A unit-specific
 *     change is a deviation: it needs inventory.approve and a reason (Amaya SOP 14: MD approval).
 *   - Interest for delay: the same rate either way (Act s. 2(za)) — SBI rate + 2 % under the Telangana Rules (rule
 *     number and MCLR vs PLR to be confirmed from the gazette). The rate is a SETTING with its source
 *     (`reraInterestRatePct`, `reraInterestRateSource`); interest is only shown as accrued, never charged
 *     automatically.
 *   - GST and registration are statutory and separate from the instalment (price list: GST 5 %, registration 7.5 %).
 *
 * Triggers: 'booking' (due on booking), 'agreement' (on registration of the agreement), 'stage' (when a construction
 * stage is certified, e.g. by the architect / engineer certificate), 'possession' (raised by a manager).
 * Certifying a stage raises a demand on every booked unit whose schedule waits on it; demand letters are generated
 * for review and printing — the CRM never sends them by itself.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import { assertLeadAccess } from '../core/scope';
import { settingsAll } from '../core/settings';
import { shortId, str, truncate } from '../core/utils';

export const ADVANCE_CAP_PCT = 10;
const DAY = 86_400_000;

export type Trigger = 'booking' | 'agreement' | 'stage' | 'possession';
export interface PlanStage { key: string; label: string; percent: number; trigger: Trigger; stageKey?: string }
export interface PlanDoc {
  _id: string; // PLAN_…
  name: string;
  /** Which registered agreement this plan comes from (TG-RERA project / agreement version). */
  agreementRef: string;
  stages: PlanStage[];
  gstPct: number;
  /** Days the allottee has to pay after a demand. */
  noticeDays: number;
  active: boolean;
  createdBy: string;
  createdAt: Date;
}
export interface ConstructionStageDoc { _id: string; label: string; order: number; certifiedOn: Date | null; certificateRef: string; certifiedBy: string }
export interface ReraMilestone {
  id: string;
  label: string;
  amount: number; // instalment, excluding GST
  gst: number;
  dueDate: string; // set when demanded
  payerId: string;
  percent?: number;
  trigger?: Trigger;
  stageKey?: string;
  demandedAt?: string;
  demandNo?: string;
}

const plans = () => col<PlanDoc>('paymentPlans');
const cstages = () => col<ConstructionStageDoc>('constructionStages');
const schedules = () => col<any>('paymentSchedules');
const units = () => col<any>(CFG.COLL.INVENTORY);
const receipts = () => col<any>('receipts');
const who = (ctx: Ctx) => ctx?.user?.name || 'System';
const pct = (v: unknown) => Math.round(Number(v) * 100) / 100;
const requireApprover = (ctx: Ctx, what: string) => {
  if (ctx?.user && !can(ctx.user, 'inventory.approve')) throw fail('FORBIDDEN', `Only a manager can ${what}`);
};

/* ------------------------------ construction ------------------------------ */

export async function saveConstructionStages(list: Array<{ key: string; label: string }>, ctx: Ctx) {
  requireApprover(ctx, 'change construction stages');
  const c = await cstages();
  let order = 0;
  for (const s of Array.isArray(list) ? list.slice(0, 40) : []) {
    const key = str(s.key).replace(/[^\w-]/g, '').slice(0, 40);
    const label = truncate(str(s.label), 80);
    if (!key || !label) throw fail('VALIDATION', 'Each construction stage needs a key and a name');
    await c.updateOne({ _id: key }, { $set: { label, order: order++ }, $setOnInsert: { certifiedOn: null, certificateRef: '', certifiedBy: '' } }, { upsert: true });
  }
  await auditLog(ctx, 'Construction Stages Saved', 'Inventory', '', `${order} stages`);
  return c.find({}).sort({ order: 1 }).toArray();
}

/** A stage is certified complete: every booked unit waiting on it gets its demand. Idempotent. */
export async function certifyStage(key: string, d: { certifiedOn?: string; certificateRef?: string }, ctx: Ctx) {
  requireApprover(ctx, 'certify construction progress');
  const ref = truncate(str(d?.certificateRef), 120);
  if (!ref) throw fail('VALIDATION', "Enter the certificate reference (architect / engineer's certificate)");
  const on = d?.certifiedOn ? new Date(d.certifiedOn) : new Date();
  if (Number.isNaN(on.getTime()) || on.getTime() > Date.now() + DAY) throw fail('VALIDATION', 'Enter the date the stage was certified');
  const c = await cstages();
  const r = await c.findOneAndUpdate({ _id: str(key), certifiedOn: null }, { $set: { certifiedOn: on, certificateRef: ref, certifiedBy: who(ctx) } }, { returnDocument: 'after' });
  if (!r) {
    const existing = await c.findOne({ _id: str(key) });
    if (!existing) throw fail('NOT_FOUND', 'Construction stage not found');
    return { stage: existing, demands: 0, alreadyCertified: true };
  }
  await auditLog(ctx, 'Construction Stage Certified', 'Inventory', r._id, `${r.label} · ${ref}`);
  let demands = 0;
  for (const s of await (await schedules()).find({ 'milestones.stageKey': r._id }).toArray()) {
    for (const m of s.milestones as ReraMilestone[]) if (m.trigger === 'stage' && m.stageKey === r._id && !m.demandedAt) if (await raise(s._id, m.id, ctx, on)) demands++;
  }
  return { stage: r, demands, alreadyCertified: false };
}

/* ---------------------------------- plans ---------------------------------- */

export async function savePlan(d: any, ctx: Ctx): Promise<PlanDoc> {
  requireApprover(ctx, 'set payment plans');
  const name = truncate(str(d?.name), 80);
  const agreementRef = truncate(str(d?.agreementRef), 120);
  if (!name) throw fail('VALIDATION', 'Name the plan (e.g. "Construction-linked plan, Phase 1")');
  if (!agreementRef) throw fail('VALIDATION', 'Say which registered agreement for sale this plan is from (TG-RERA registration / agreement version)');
  const known = new Set((await (await cstages()).find({}, { projection: { _id: 1 } }).toArray()).map((s) => s._id));
  const stages: PlanStage[] = (Array.isArray(d?.stages) ? d.stages : []).slice(0, 30).map((s: any, i: number) => {
    const trigger = (['booking', 'agreement', 'stage', 'possession'].includes(str(s?.trigger)) ? str(s.trigger) : '') as Trigger;
    if (!trigger) throw fail('VALIDATION', `Instalment ${i + 1}: choose when it is due (booking, agreement, construction stage or possession)`);
    const stageKey = trigger === 'stage' ? str(s?.stageKey) : '';
    if (trigger === 'stage' && !known.has(stageKey)) throw fail('VALIDATION', `Instalment ${i + 1}: unknown construction stage "${stageKey}"`);
    const p = pct(s?.percent);
    if (!(p > 0)) throw fail('VALIDATION', `Instalment ${i + 1}: enter its percentage`);
    return { key: `I${i + 1}`, label: truncate(str(s?.label) || `Instalment ${i + 1}`, 80), percent: p, trigger, ...(stageKey ? { stageKey } : {}) };
  });
  if (!stages.length) throw fail('VALIDATION', 'Add the instalments of the plan');
  const total = pct(stages.reduce((a, s) => a + s.percent, 0));
  if (total !== 100) throw fail('VALIDATION', `The instalments add up to ${total} %; they must add up to 100 %`);
  const beforeAgreement = pct(stages.filter((s) => s.trigger === 'booking').reduce((a, s) => a + s.percent, 0));
  if (beforeAgreement > ADVANCE_CAP_PCT) throw fail('VALIDATION', `${beforeAgreement} % is due before the agreement for sale is registered; RERA (Section 13) allows at most ${ADVANCE_CAP_PCT} %`);
  const gstPct = d?.gstPct === undefined || d?.gstPct === '' ? 5 : pct(d.gstPct);
  if (!(gstPct >= 0 && gstPct <= 28)) throw fail('VALIDATION', 'GST must be between 0 and 28 %');
  const noticeDays = Math.max(1, Math.min(90, Math.round(Number(d?.noticeDays) || 15)));
  const doc: PlanDoc = { _id: shortId('PLAN'), name, agreementRef, stages, gstPct, noticeDays, active: true, createdBy: who(ctx), createdAt: new Date() };
  await (await plans()).insertOne(doc);
  await auditLog(ctx, 'Payment Plan Saved', 'Inventory', doc._id, `${name} · ${stages.length} instalments · ${agreementRef}`);
  return doc;
}

/** Generate a unit's schedule from a plan. Booking instalments are demanded at once (within the 10 % cap). */
export async function applyPlan(unitId: string, planId: string, ctx: Ctx) {
  requireApprover(ctx, 'apply a payment plan');
  const u = await bookedUnit(unitId, ctx);
  const plan = await (await plans()).findOne({ _id: str(planId), active: true });
  if (!plan) throw fail('NOT_FOUND', 'Payment plan not found');
  const basic = Number(u.quotedAmount || u.price || 0);
  if (!(basic > 0)) throw fail('VALIDATION', 'The unit has no agreed price yet');
  if ((await (await receipts()).countDocuments({ unitId: u._id, voided: { $exists: false } })) > 0 && (await (await schedules()).findOne({ _id: u._id }))?.planId) {
    throw fail('CONFLICT', 'This unit already has a plan with payments against it. Change it as a deviation (with a reason) instead.');
  }
  let allocated = 0;
  const milestones: ReraMilestone[] = plan.stages.map((s, i) => {
    const amount = i === plan.stages.length - 1 ? basic - allocated : Math.round((basic * s.percent) / 100);
    allocated += amount;
    return { id: shortId('MS'), label: s.label, amount, gst: Math.round((amount * plan.gstPct) / 100), dueDate: '', payerId: '', percent: s.percent, trigger: s.trigger, ...(s.stageKey ? { stageKey: s.stageKey } : {}) };
  });
  const prev = await (await schedules()).findOne({ _id: u._id });
  const doc = { _id: u._id, leadId: String(u.leadId), version: (prev?.version || 0) + 1, planId: plan._id, planName: plan.name, agreementRef: plan.agreementRef, gstPct: plan.gstPct, noticeDays: plan.noticeDays, deviation: false, milestones, total: basic, updatedAt: new Date(), updatedBy: who(ctx) };
  await (await schedules()).replaceOne({ _id: u._id }, doc, { upsert: true });
  await auditLog(ctx, 'Payment Plan Applied', 'Inventory', u._id, `${plan.name} v${doc.version} · ₹${basic}`);
  // what is already due: booking now; agreement / stages that already happened
  for (const m of milestones) {
    if (m.trigger === 'booking') await raise(u._id, m.id, ctx);
    if (m.trigger === 'agreement' && u.agreementRegisteredAt) await raise(u._id, m.id, ctx);
    if (m.trigger === 'stage') {
      const st = await (await cstages()).findOne({ _id: m.stageKey! });
      if (st?.certifiedOn) await raise(u._id, m.id, ctx);
    }
  }
  await (await import('./payments')).syncUnit(u._id);
  return (await schedules()).findOne({ _id: u._id });
}

/** Record the registered agreement for sale: lifts the 10 % cap and raises the 'on agreement' demand. */
export async function recordAgreement(unitId: string, d: { registeredOn?: string; documentNo?: string }, ctx: Ctx) {
  requireApprover(ctx, 'record the registered agreement');
  const u = await bookedUnit(unitId, ctx);
  const docNo = truncate(str(d?.documentNo), 80);
  if (!docNo) throw fail('VALIDATION', 'Enter the registration document number of the agreement for sale');
  const on = d?.registeredOn ? new Date(d.registeredOn) : new Date();
  if (Number.isNaN(on.getTime()) || on.getTime() > Date.now() + DAY) throw fail('VALIDATION', 'Enter the registration date');
  await (await units()).updateOne({ _id: u._id }, { $set: { agreementRegisteredAt: on, agreementDocumentNo: docNo }, $inc: { rev: 1 } });
  await addTimeline(String(u.leadId), 'agreement', 'Agreement for sale registered', `Document ${docNo}`, who(ctx), 'Inventory', u._id);
  await auditLog(ctx, 'Agreement Registered', 'Inventory', u._id, docNo);
  const { markCustomerStep } = await import('./engagement');
  await markCustomerStep(String(u.leadId), 'agreementRegistered', ctx, on).catch(() => undefined);
  const s = await (await schedules()).findOne({ _id: u._id });
  for (const m of (s?.milestones || []) as ReraMilestone[]) if (m.trigger === 'agreement' && !m.demandedAt) await raise(u._id, m.id, ctx);
  await (await import('./payments')).syncUnit(u._id);
  return { ok: true };
}

/** A manager raises a demand by hand (possession, or a stage the system did not trigger). */
export async function raiseDemand(unitId: string, milestoneId: string, ctx: Ctx) {
  requireApprover(ctx, 'raise a payment demand');
  await bookedUnit(unitId, ctx);
  const ok = await raise(str(unitId), str(milestoneId), ctx);
  if (!ok) throw fail('CONFLICT', 'This instalment was already demanded, or the 10 % limit before the registered agreement would be exceeded');
  await (await import('./payments')).syncUnit(str(unitId));
  return { ok };
}

/** Raise one demand (idempotent). Refuses anything that would take demands past 10 % before registration. */
async function raise(unitId: string, milestoneId: string, ctx: Ctx, at = new Date()): Promise<boolean> {
  const s = await (await schedules()).findOne({ _id: unitId });
  const m: ReraMilestone | undefined = s?.milestones?.find((x: ReraMilestone) => x.id === milestoneId);
  if (!s || !m || m.demandedAt) return false;
  const u = await (await units()).findOne({ _id: unitId });
  if (!u?.agreementRegisteredAt) {
    const demanded = (s.milestones as ReraMilestone[]).filter((x) => x.demandedAt).reduce((a, x) => a + x.amount, 0);
    if (demanded + m.amount > (Number(s.total) * ADVANCE_CAP_PCT) / 100 + 1) return false;
  }
  const noticeDays = Number(s.noticeDays || 15);
  const demandNo = `DEM-${String(unitId).replace(/\W/g, '')}-${(s.milestones as ReraMilestone[]).findIndex((x) => x.id === m.id) + 1}`;
  const due = new Date(at.getTime() + noticeDays * DAY).toISOString();
  const r = await (await schedules()).updateOne({ _id: unitId, milestones: { $elemMatch: { id: milestoneId, demandedAt: { $exists: false } } } }, { $set: { 'milestones.$.demandedAt': at.toISOString(), 'milestones.$.dueDate': due, 'milestones.$.demandNo': demandNo } });
  if (!r.modifiedCount) return false;
  await addTimeline(String(s.leadId), 'payment_demand', `Payment demand ${demandNo}: ${m.label}`, `₹${m.amount.toLocaleString('en-IN')} + GST ₹${m.gst.toLocaleString('en-IN')} · due ${due.slice(0, 10)}`, who(ctx), 'Inventory', unitId);
  await auditLog(ctx, 'Payment Demand Raised', 'Inventory', unitId, `${demandNo} · ${m.label} · ₹${m.amount}`);
  return true;
}

/* -------------------------------- statement -------------------------------- */

export interface StatementLine { id: string; label: string; amount: number; gst: number; status: 'not due' | 'demanded' | 'part paid' | 'paid' | 'overdue'; paid: number; outstanding: number; dueDate: string; demandNo: string; daysLate: number; interestAccrued: number; trigger: string }

/** Receipts are applied to demanded instalments in order (oldest first); interest is shown, never charged. */
export function buildStatement(schedule: any, paidTotal: number, opts: { ratePct: number | null; now?: Date; agreementRegistered: boolean }) {
  const now = opts.now || new Date();
  let left = paidTotal;
  const lines: StatementLine[] = (schedule?.milestones || []).map((m: ReraMilestone) => {
    const demanded = !!m.demandedAt;
    const paid = Math.max(0, Math.min(m.amount, left));
    left -= paid;
    const outstanding = m.amount - paid;
    const late = demanded && outstanding > 0 && m.dueDate && new Date(m.dueDate).getTime() < now.getTime() ? Math.floor((now.getTime() - new Date(m.dueDate).getTime()) / DAY) : 0;
    const interest = late && opts.ratePct ? Math.round((outstanding * opts.ratePct * late) / 36500) : 0;
    const status: StatementLine['status'] = outstanding <= 0 ? 'paid' : late ? 'overdue' : paid > 0 ? 'part paid' : demanded ? 'demanded' : 'not due';
    return { id: m.id, label: m.label, amount: m.amount, gst: m.gst, status, paid, outstanding, dueDate: m.dueDate || '', demandNo: m.demandNo || '', daysLate: late, interestAccrued: interest, trigger: m.trigger === 'stage' ? `Stage: ${m.stageKey}` : m.trigger || 'date' };
  });
  const total = Number(schedule?.total || 0);
  const demanded = lines.filter((l) => l.status !== 'not due').reduce((a, l) => a + l.amount, 0);
  return {
    lines,
    totals: {
      agreed: total, gst: lines.reduce((a, l) => a + l.gst, 0), paid: paidTotal, demanded, outstandingDemanded: Math.max(0, demanded - paidTotal),
      overdue: lines.filter((l) => l.status === 'overdue').reduce((a, l) => a + l.outstanding, 0), interestAccrued: lines.reduce((a, l) => a + l.interestAccrued, 0),
      advanceCap: opts.agreementRegistered ? null : Math.round((total * ADVANCE_CAP_PCT) / 100),
    },
    interestRatePct: opts.ratePct,
    unallocated: Math.max(0, left),
  };
}

export async function getStatement(unitId: string, ctx: Ctx) {
  const u = await bookedUnit(unitId, ctx);
  const s = await (await schedules()).findOne({ _id: u._id });
  const paid = (await (await receipts()).find({ unitId: u._id, voided: { $exists: false } }).toArray()).reduce((a: number, r: any) => a + r.amount, 0);
  const cfg = await settingsAll();
  const rate = Number(cfg.reraInterestRatePct);
  const statement = buildStatement(s, paid, { ratePct: Number.isFinite(rate) && rate > 0 ? rate : null, agreementRegistered: !!u.agreementRegisteredAt });
  return {
    unitId: u._id, unitNumber: u.unitNumber, planName: s?.planName || '', agreementRef: s?.agreementRef || '', deviation: !!s?.deviation,
    agreementRegisteredAt: u.agreementRegisteredAt ? new Date(u.agreementRegisteredAt).toISOString() : '', agreementDocumentNo: u.agreementDocumentNo || '',
    interestRateSource: str(cfg.reraInterestRateSource), projectRegistration: str(cfg.reraProjectNumber), ...statement,
  };
}

/** The text of a demand letter for review / printing (never sent by the CRM). */
export async function demandLetter(unitId: string, milestoneId: string, ctx: Ctx) {
  const st = await getStatement(unitId, ctx);
  const line = st.lines.find((l) => l.id === milestoneId);
  if (!line || !line.demandNo) throw fail('NOT_FOUND', 'No demand raised for this instalment');
  const u = await (await units()).findOne({ _id: str(unitId) });
  const lead = await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: String(u.leadId) }, { projection: { name: 1, people: 1 } });
  const payer = (lead?.people || []).find((p: any) => (p.roles || []).includes('payer'));
  return {
    demandNo: line.demandNo, date: new Date().toISOString().slice(0, 10), to: payer?.name || lead?.name || '', unit: st.unitNumber,
    project: st.projectRegistration, agreementRef: st.agreementRef, instalment: line.label, amount: line.amount, gst: line.gst, total: line.amount + line.gst, dueDate: line.dueDate.slice(0, 10),
    note: 'Payable as per the registered agreement for sale. Interest for delay, if any, at the rate prescribed under the Telangana Real Estate (Regulation and Development) Rules, 2017.',
  };
}

async function bookedUnit(unitId: string, ctx: Ctx) {
  const u = await (await units()).findOne({ _id: str(unitId) });
  if (!u) throw fail('NOT_FOUND', 'Unit not found');
  if (!['Booked', 'Sold'].includes(String(u.status))) throw fail('VALIDATION', 'Payment schedules are for booked units');
  await assertLeadAccess(ctx, u.leadId);
  // payments are buyer detail: an agent sees them only for their own customer
  if (ctx?.user && !can(ctx.user, 'inventory.customers')) {
    const { visibleLeadIds } = await import('../core/scope');
    const ids = await visibleLeadIds(ctx.user);
    if (!ids || !ids.has(String(u.leadId))) throw fail('NOT_FOUND', 'Unit not found');
  }
  return u;
}

/** Project-level RERA facts a manager keeps current: TG-RERA registration and the interest rate with its source. */
export async function saveReraSettings(d: any, ctx: Ctx) {
  requireApprover(ctx, 'change RERA settings');
  const { settingSet } = await import('../core/settings');
  const rate = d?.interestRatePct === '' || d?.interestRatePct === undefined ? '' : String(pct(d.interestRatePct));
  if (rate && !(Number(rate) > 0 && Number(rate) < 30)) throw fail('VALIDATION', 'Enter the yearly interest rate in %, e.g. 10.7');
  if (rate && !str(d?.interestRateSource)) throw fail('VALIDATION', 'Say where the rate comes from (e.g. "SBI MCLR 8.70 % on 1 Nov 2026 + 2 %, TS RERA Rules")');
  await settingSet('reraInterestRatePct', rate, who(ctx));
  await settingSet('reraInterestRateSource', truncate(str(d?.interestRateSource), 200), who(ctx));
  await settingSet('reraProjectNumber', truncate(str(d?.projectNumber), 60), who(ctx));
  await auditLog(ctx, 'RERA Settings Saved', 'Settings', '', `rate ${rate || 'none'} · ${str(d?.projectNumber)}`);
  return getReraSettings();
}
export async function getReraSettings() {
  const c = await settingsAll();
  return { interestRatePct: str(c.reraInterestRatePct), interestRateSource: str(c.reraInterestRateSource), projectNumber: str(c.reraProjectNumber) };
}

export const actions: ActionMap = {
  getReraSettings: { perm: 'inventory.view', fn: () => getReraSettings() },
  saveReraSettings: { perm: 'inventory.approve', fn: (d, ctx) => saveReraSettings(d, ctx) },
  listPaymentPlans: { perm: 'inventory.view', fn: async () => ({ plans: await (await plans()).find({ active: true }).sort({ createdAt: -1 }).toArray(), stages: await (await cstages()).find({}).sort({ order: 1 }).toArray() }) },
  savePaymentPlan: { perm: 'inventory.approve', fn: (d, ctx) => savePlan(d, ctx) },
  saveConstructionStages: { perm: 'inventory.approve', fn: (d, ctx) => saveConstructionStages(d?.stages, ctx) },
  certifyConstructionStage: { perm: 'inventory.approve', fn: (d, ctx) => certifyStage(str(d?.key), d, ctx) },
  applyPaymentPlan: { perm: 'inventory.approve', fn: (d, ctx) => applyPlan(str(d?.unitId), str(d?.planId), ctx) },
  recordAgreementRegistration: { perm: 'inventory.approve', fn: (d, ctx) => recordAgreement(str(d?.unitId), d, ctx) },
  raisePaymentDemand: { perm: 'inventory.approve', fn: (d, ctx) => raiseDemand(str(d?.unitId), str(d?.milestoneId), ctx) },
  getPaymentStatement: { perm: 'inventory.view', fn: (d, ctx) => getStatement(str(d?.unitId), ctx) },
  getDemandLetter: { perm: 'inventory.view', fn: (d, ctx) => demandLetter(str(d?.unitId), str(d?.milestoneId), ctx) },
};
