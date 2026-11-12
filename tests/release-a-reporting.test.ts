/**
 * Release A, finding 6 — reporting uses explicit evidence and honest denominators.
 *  - one timely response + nine overdue unanswered enquiries is 10 % overall SLA, not 100 %
 *  - a lead counts at a funnel step only when the step was recorded, not because of its current stage
 *  - estimated, quoted, booked and collected value are separate
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));

import { startTestDb } from './helpers/mongo';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { computeSalesReport, getSalesReport, type ReportLead } from '../server/modules/salesReport';
import { calculatePerformanceMetrics } from '../src/core/pipeline';
import { addLead, appendRemark, updateLead } from '../server/modules/leads';
import { backfillMilestones } from '../scripts/backfill-milestones-lib';
import type { Lead } from '../src/types/crm';

const H = 3_600_000;
const NOW = new Date('2026-11-10T06:30:00Z');

function slaCohort(): ReportLead[] {
  const out: ReportLead[] = [];
  const enquired = new Date(NOW.getTime() - 72 * H);
  out.push({ _id: 'ENQ-1', enquiryDate: enquired, stage: 'Open', milestones: { contacted: { at: new Date(enquired.getTime() + 2 * H) } } });
  for (let i = 2; i <= 10; i++) out.push({ _id: `ENQ-${i}`, enquiryDate: enquired, stage: 'New' });
  return out;
}

describe('finding 6: SLA denominators', () => {
  it('server report: 1 timely + 9 overdue unanswered = 10 % overall (100 % only "of responded")', () => {
    const r = computeSalesReport(slaCohort(), [], { from: new Date(NOW.getTime() - 30 * 24 * H), to: NOW, now: NOW });
    expect(r.sla).toMatchObject({ eligible: 10, withinSla: 1, overdueUnanswered: 9, overallPercent: 10, ofRespondedPercent: 100 });
  });

  it('a lead still inside its 24 h window is not yet due (neither for nor against)', () => {
    const fresh: ReportLead = { _id: 'ENQ-11', enquiryDate: new Date(NOW.getTime() - 2 * H), stage: 'New' };
    const r = computeSalesReport([...slaCohort(), fresh], [], { from: new Date(NOW.getTime() - 30 * 24 * H), to: NOW, now: NOW });
    expect(r.sla).toMatchObject({ eligible: 10, notYetDue: 1, overallPercent: 10 });
  });

  it('browser Performance report: the same cohort shows 10 % overall', () => {
    const at = (d: Date) => d.toISOString();
    const enquired = new Date(NOW.getTime() - 72 * H);
    const leads: Lead[] = [];
    leads.push({ 'Enquiry ID': 'ENQ-1', 'Enquiry Date': at(enquired), 'Lead Stage': 'Open', 'Follow-up 1': `${new Date(enquired.getTime() + 2 * H).toLocaleString('en-GB')} — called` } as any);
    for (let i = 2; i <= 10; i++) leads.push({ 'Enquiry ID': `ENQ-${i}`, 'Enquiry Date': at(enquired), 'Lead Stage': 'New' } as any);
    const p = calculatePerformanceMetrics(leads, 30, '', NOW);
    expect(p.overdueUnansweredCount).toBe(9);
    expect(p.slaEligibleCount).toBe(p.totalRespondedCount + 9);
    expect(p.slaCompliancePercent).toBeLessThanOrEqual(10);
    expect(p.slaCompliancePercent).not.toBe(100);
  });
});

describe('finding 6: funnel from recorded steps', () => {
  it('current stage alone is never counted as reaching a step', () => {
    const leads: ReportLead[] = [
      { _id: 'A', enquiryDate: NOW, stage: 'Booked' }, // booked by stage only, nothing recorded
      { _id: 'B', enquiryDate: NOW, stage: 'Lost', milestones: { contacted: { at: NOW }, qualified: { at: NOW } } }, // qualified, later lost
      { _id: 'C', enquiryDate: NOW, stage: 'Booked', milestones: { contacted: { at: NOW }, qualified: { at: NOW, source: 'backfill' }, booked: { at: NOW } } },
    ];
    const r = computeSalesReport(leads, [], { from: new Date(NOW.getTime() - H), to: NOW, now: NOW });
    const step = (s: string) => r.funnel.find((f) => f.step === s)!;
    expect(step('qualified')).toMatchObject({ reached: 2, reconstructed: 1, stageOnly: 1 });
    expect(step('booked')).toMatchObject({ reached: 1, stageOnly: 1 });
  });

  it('value: estimated, quoted, booked and collected are separate; no default price is invented', () => {
    const leads: ReportLead[] = [
      { _id: 'A', enquiryDate: NOW, stage: 'Hot', notes: 'Budget around 1.2 Cr' },
      { _id: 'B', enquiryDate: NOW, stage: 'Open' }, // no budget: not valued at a made-up unit price
    ];
    const units = [
      { status: 'Reserved', quotedAmount: 9_000_000, paidAmount: 0, price: 9_500_000, leadId: 'A' },
      { status: 'Booked', quotedAmount: 11_000_000, paidAmount: 2_000_000, price: 12_000_000, leadId: 'C' },
      { status: 'Booked', quotedAmount: 0, paidAmount: 0, price: 0, leadId: '', restricted: true },
    ];
    const v = computeSalesReport(leads, units, { from: new Date(NOW.getTime() - H), to: NOW, now: NOW }).value;
    expect(v.estimated).toMatchObject({ amount: 12_000_000, leads: 1, openLeadsWithoutBudget: 1 });
    expect(v.quoted.amount).toBe(9_000_000);
    expect(v.booked.amount).toBe(11_000_000);
    expect(v.collected.amount).toBe(2_000_000);
    expect(v.hiddenUnits).toBe(1);
  });
});

describe('milestones are recorded when steps happen', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  beforeAll(async () => {
    t = await startTestDb();
  });
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('a remark records contacted; stage changes record qualified and booked once; the report reads them', async () => {
    const ctx = await t.ctx('Manager', 'Meera');
    const { lead } = await addLead({ 'Prospect Name': 'Mrs Rao', 'Phone Number': '9877700001' } as any, ctx);
    const id = lead['Enquiry ID'];
    await appendRemark(id, 'Spoke to her son in Dubai', ctx);
    await updateLead(id, { 'Lead Stage': 'Hot' }, ctx);
    await updateLead(id, { 'Lead Stage': 'Lost' }, ctx);
    await updateLead(id, { 'Lead Stage': 'Hot' }, ctx); // qualified is kept from the first time
    const doc = await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: id });
    expect(Object.keys(doc.milestones).sort()).toEqual(['contacted', 'qualified']);
    expect(doc.milestones.qualified.source).toBe('event');
    const rep = await getSalesReport({}, ctx);
    expect(rep.funnel.find((f: any) => f.step === 'qualified')?.reached).toBe(1);
    expect(rep.freshness.generatedAt).toBeTruthy();
  });

  it('the backfill reconstructs history from the timeline and never overwrites recorded steps', async () => {
    const leads = await col<any>(CFG.COLL.LEADS);
    await leads.insertOne({ _id: 'ENQ-7001', name: 'Old', stage: 'Booked', followups: [{ n: 1, at: new Date('2026-01-02'), text: 'x' }], bookingDate: new Date('2026-02-01'), milestones: { contacted: { at: new Date('2026-01-01'), by: 'Asha', source: 'event' } } } as any);
    await (await col<any>(CFG.COLL.TIMELINE)).insertOne({ _id: 'TL_x', leadId: 'ENQ-7001', type: 'stage_changed', title: 'Stage changed: Open → Hot', timestamp: new Date('2026-01-10') } as any);
    const dry = await backfillMilestones(t.db);
    expect(dry.wouldMark).toMatchObject({ contacted: 0, qualified: 1, booked: 1 });
    await backfillMilestones(t.db, { apply: true });
    const doc = await leads.findOne({ _id: 'ENQ-7001' });
    expect(doc.milestones.contacted.source).toBe('event');
    expect(doc.milestones.qualified).toMatchObject({ source: 'backfill' });
    expect(new Date(doc.milestones.qualified.at).toISOString()).toBe('2026-01-10T00:00:00.000Z');
    await backfillMilestones(t.db, { rollback: true });
    expect(Object.keys((await leads.findOne({ _id: 'ENQ-7001' })).milestones)).toEqual(['contacted']);
  });
});
