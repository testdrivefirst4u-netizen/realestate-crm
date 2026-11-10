/**
 * Sales report with stated definitions (finding 6). Computed on the server from recorded evidence, scoped to what the
 * user may see. Every figure says what it is based on; nothing is inferred from a lead's current stage or from notes
 * and then called actual.
 *
 * Cohort: enquiries whose Enquiry Date is in the range (Trash / deleted excluded).
 *
 * Funnel ("reached"): a lead counts at a step only when the step's milestone is recorded (server/core/milestones.ts).
 *   `reconstructed` = how many of those were rebuilt from history by the backfill, not recorded live.
 *   `stageOnly`     = leads whose current stage suggests the step but with no recorded evidence: shown, never counted.
 *
 * First-response SLA (default 24 h): the first contact = the `contacted` milestone, else the first follow-up remark.
 *   eligible          = responded, or older than the SLA window (a lead still inside its window is not yet due)
 *   withinSla         = responded within the window
 *   overdueUnanswered = no response and older than the window
 *   overallPercent    = withinSla / eligible  ← the headline. (`ofRespondedPercent` = withinSla / responded is shown
 *                       only as a secondary figure, labelled as such.)
 *
 * Value — four different things, never added together:
 *   estimated  budgets agents typed on open leads ('Deal Value' or a Cr / Lakh amount in Budget / notes). An estimate.
 *   quoted     quoted amounts on units currently Reserved for a lead
 *   booked     quoted amount (else list price) of units Booked or Sold
 *   collected  paid amounts entered on Booked / Sold units — as entered, not a receipts ledger (see post-sales)
 */
import type { ActionMap } from '../core/actions';
import type { Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { leadFilter } from '../core/scope';
import { getUnitsFor } from './inventory';

const S = CFG.STAGES;
const HOUR = 3_600_000;
export const STEPS = ['contacted', 'qualified', 'visitScheduled', 'visitDone', 'reserved', 'booked'] as const;

/** Current stages that would suggest a step was reached (only to show what is NOT evidenced). */
const STAGE_SUGGESTS: Record<string, string[]> = {
  qualified: [S.QUALIFIED, S.WARM, S.HOT, S.BOOKED],
  booked: [S.BOOKED],
};

export interface ReportLead {
  _id: string;
  enquiryDate?: Date | null;
  createdAt?: Date | null;
  stage?: string;
  siteVisitStatus?: string;
  notes?: string;
  extra?: Record<string, unknown>;
  followups?: Array<{ at?: Date | null }>;
  milestones?: Record<string, { at: Date; source?: string }>;
  updatedAt?: Date | null;
  assignedRm?: string;
  source?: string;
}

export interface ReportUnit { status: string; quotedAmount: number; paidAmount: number; price: number; leadId: string; restricted?: boolean }

/** A budget an agent typed (₹). Null when there is none — never a default unit price. */
export function typedBudget(l: ReportLead): number | null {
  const dv = Number(String(l.extra?.['Deal Value'] ?? '').replace(/[,₹\s]/g, ''));
  if (Number.isFinite(dv) && dv > 0) return dv;
  const text = `${l.extra?.['Budget'] ?? ''} ${l.notes ?? ''}`;
  const cr = text.match(/(\d+(?:\.\d+)?)\s*(?:Cr|Crore)s?\b/i);
  if (cr && +cr[1] > 0 && +cr[1] < 100) return +cr[1] * 1e7;
  const lk = text.match(/(\d+(?:\.\d+)?)\s*(?:L|Lakh|Lac)s?\b/i);
  if (lk && +lk[1] > 0 && +lk[1] < 10000) return +lk[1] * 1e5;
  return null;
}

export function firstResponseAt(l: ReportLead): Date | null {
  const m = l.milestones?.contacted?.at;
  if (m) return new Date(m);
  const fu = (l.followups || []).map((f) => (f.at ? new Date(f.at).getTime() : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return fu ? new Date(fu) : null;
}

const CLOSED = new Set<string>([S.LOST, S.JUNK, S.DND, S.DQ_BUDGET, S.DQ_LOCATION, S.DQ_RENTAL, S.DQ_NI, S.DQ_TIMELINE, S.DQ_PROJECT, S.BOOKED]);

export function computeSalesReport(leads: ReportLead[], units: ReportUnit[], opts: { from: Date; to: Date; now?: Date; slaHours?: number }) {
  const now = opts.now || new Date();
  const slaMs = (opts.slaHours ?? 24) * HOUR;
  const cohort = leads.filter((l) => {
    const d = l.enquiryDate || l.createdAt;
    return d && d >= opts.from && d <= opts.to && l.stage !== S.TRASH && l.stage !== S.DELETED;
  });

  const funnel = STEPS.map((step) => {
    let reached = 0;
    let reconstructed = 0;
    let stageOnly = 0;
    for (const l of cohort) {
      const m = l.milestones?.[step];
      if (m) {
        reached++;
        if (m.source === 'backfill') reconstructed++;
      } else if (STAGE_SUGGESTS[step]?.includes(String(l.stage || ''))) stageOnly++;
    }
    return { step, reached, reconstructed, stageOnly, percentOfEnquiries: cohort.length ? Math.round((reached * 1000) / cohort.length) / 10 : 0 };
  });

  let withinSla = 0, respondedLate = 0, overdueUnanswered = 0, notYetDue = 0;
  for (const l of cohort) {
    const start = (l.enquiryDate || l.createdAt)!.getTime();
    const r = firstResponseAt(l);
    if (r) {
      if (r.getTime() - start <= slaMs) withinSla++;
      else respondedLate++;
    } else if (now.getTime() - start > slaMs) overdueUnanswered++;
    else notYetDue++;
  }
  const responded = withinSla + respondedLate;
  const eligible = responded + overdueUnanswered;
  const pct = (n: number, d: number) => (d ? Math.round((n * 1000) / d) / 10 : null);

  const openLeads = cohort.filter((l) => !CLOSED.has(String(l.stage || '')));
  let estimated = 0, withBudget = 0;
  for (const l of openLeads) {
    const b = typedBudget(l);
    if (b !== null) { estimated += b; withBudget++; }
  }
  const visibleUnits = units.filter((u) => !u.restricted);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
  const reservedUnits = visibleUnits.filter((u) => u.status === 'Reserved');
  const bookedUnits = visibleUnits.filter((u) => u.status === 'Booked' || u.status === 'Sold');

  const cancellations = leads.filter((l) => {
    const c = l.milestones?.cancelled?.at;
    return c && new Date(c) >= opts.from && new Date(c) <= opts.to;
  }).length;

  return {
    range: { from: opts.from.toISOString(), to: opts.to.toISOString() },
    enquiries: cohort.length,
    funnel,
    sla: {
      hours: opts.slaHours ?? 24,
      eligible, withinSla, respondedLate, overdueUnanswered, notYetDue, responded,
      overallPercent: pct(withinSla, eligible),
      ofRespondedPercent: pct(withinSla, responded),
    },
    value: {
      estimated: { amount: estimated, leads: withBudget, openLeadsWithoutBudget: openLeads.length - withBudget, basis: 'Budgets typed by agents on open leads (estimate)' },
      quoted: { amount: sum(reservedUnits.map((u) => u.quotedAmount)), units: reservedUnits.length, basis: 'Quoted amount on units reserved now' },
      booked: { amount: sum(bookedUnits.map((u) => u.quotedAmount || u.price)), units: bookedUnits.length, basis: 'Quoted (else list) price of booked and sold units' },
      collected: { amount: sum(bookedUnits.map((u) => u.paidAmount)), units: bookedUnits.length, basis: 'Paid amounts entered on booked and sold units (not a receipts ledger)' },
      hiddenUnits: units.length - visibleUnits.length,
    },
    cancellations,
  };
}

export async function getSalesReport(d: any, ctx: Ctx) {
  const now = new Date();
  const to = d?.to ? new Date(d.to) : now;
  const from = d?.from ? new Date(d.from) : new Date(to.getTime() - 30 * 24 * HOUR);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw (await import('../core/errors')).fail('VALIDATION', 'Choose a valid date range');
  const scope = await leadFilter(ctx);
  const leadsCol = await col<any>(CFG.COLL.LEADS);
  const leads = (await leadsCol
    .find(scope || {}, { projection: { enquiryDate: 1, createdAt: 1, stage: 1, siteVisitStatus: 1, notes: 1, 'extra.Deal Value': 1, 'extra.Budget': 1, 'followups.at': 1, milestones: 1, updatedAt: 1, assignedRm: 1, source: 1 } })
    .toArray()) as ReportLead[];
  const units = (await getUnitsFor(ctx)) as ReportUnit[];
  const report = computeSalesReport(leads, units, { from, to, now, slaHours: d?.slaHours ? Number(d.slaHours) : undefined });

  // how fresh the numbers are
  const newestLead = await leadsCol.find(scope || {}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next();
  const newestEvent = await (await col<any>('webhookInbox')).find({}, { projection: { receivedAt: 1 } }).sort({ receivedAt: -1 }).limit(1).next().catch(() => null);
  const lastBackup = await (await col<any>('leadBackups')).find({}, { projection: { createdAt: 1, verifyOk: 1 } }).sort({ createdAt: -1 }).limit(1).next().catch(() => null);
  return {
    ...report,
    freshness: {
      generatedAt: now.toISOString(),
      newestLeadChange: newestLead?.updatedAt ? new Date(newestLead.updatedAt).toISOString() : '',
      newestProviderEvent: newestEvent?.receivedAt ? new Date(newestEvent.receivedAt).toISOString() : '',
      lastLeadSnapshot: lastBackup?.createdAt ? new Date(lastBackup.createdAt).toISOString() : '',
      lastSnapshotVerified: lastBackup ? lastBackup.verifyOk === true : null,
    },
  };
}

export const actions: ActionMap = {
  getSalesReport: { fn: (d, ctx) => getSalesReport(d, ctx), perm: 'reports.view' },
};
