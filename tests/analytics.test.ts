import { describe, it, expect } from 'vitest';
import { computeKpis, compareMonths, monthlySeries, availableMonths, followupBuckets, leadsNotContactedForDays, searchLeads, tillDateReport } from '../src/core/analytics';
import { monthRange, getPresetRange } from '../src/core/dates';
import { F, STAGES, SITE_VISIT } from '../src/core/config';
import type { Lead, TaskItem } from '../src/types/crm';

const mk = (over: Partial<Lead>): Lead => ({
  [F.ID]: over[F.ID] || 'ENQ-0001',
  [F.ENQUIRY_DATE]: '2026-09-10T05:00:00.000Z',
  [F.NAME]: 'Test',
  [F.PHONE]: '+91 98490 12345',
  Email: '',
  [F.STAGE]: STAGES.NEW,
  [F.SOURCE]: 'Website',
  [F.UNIT_TYPE]: '2 BHK',
  [F.PURCHASE_OR_RENT]: 'Purchase',
  [F.SITE_VISIT_STATUS]: SITE_VISIT.PROSPECT,
  [F.NEXT_FOLLOWUP]: '',
  [F.NOTES]: '',
  [F.RM]: 'Rahul',
  [F.BROCHURE]: 'No',
  [F.RELATIONSHIP]: 'Self',
  [F.ENQUIRED_FOR]: 'Self',
  ...over,
});

const leads: Lead[] = [
  mk({ [F.ID]: 'ENQ-0001', [F.STAGE]: STAGES.HOT, [F.ENQUIRY_DATE]: '2026-09-05 10:00', 'Follow-up 1': '2026-09-05 12:00 — called', [F.NEXT_FOLLOWUP]: '2026-10-01 16:00' }),
  mk({ [F.ID]: 'ENQ-0002', [F.STAGE]: STAGES.BOOKED, [F.ENQUIRY_DATE]: '2026-09-12', [F.BOOKING_DATE]: '2026-10-01 11:00', [F.SITE_VISIT_STATUS]: SITE_VISIT.COMPLETED, [F.SITE_VISIT_DATE]: '2026-09-20 11:00', [F.RM]: 'Priya' }),
  mk({ [F.ID]: 'ENQ-0003', [F.STAGE]: STAGES.WARM, [F.ENQUIRY_DATE]: '2026-10-01 09:00', [F.SITE_VISIT_STATUS]: SITE_VISIT.SCHEDULED, [F.SITE_VISIT_DATE]: '2026-10-03 11:00', [F.SOURCE]: 'Instagram' }),
  mk({ [F.ID]: 'ENQ-0004', [F.STAGE]: STAGES.TRASH, [F.ENQUIRY_DATE]: '2026-10-01 09:00' }),
  mk({ [F.ID]: 'ENQ-0005', [F.STAGE]: STAGES.QUALIFIED, [F.ENQUIRY_DATE]: '2026-09-28', [F.NEXT_FOLLOWUP]: '2026-09-29 10:00', [F.SOURCE]: 'Instagram', 'Follow-up 1': '2026-09-28 18:00 — intro', 'Follow-up 2': '2026-09-30 18:00 — brochure sent' }),
  mk({ [F.ID]: 'ENQ-0006', [F.STAGE]: STAGES.DQ_BUDGET, [F.ENQUIRY_DATE]: '2026-08-15' }),
  mk({ [F.ID]: 'ENQ-0007', [F.STAGE]: STAGES.NEW, [F.ENQUIRY_DATE]: '' }), // blank date → only counted in all-time
];

const tasks: TaskItem[] = [
  { id: 'TASK-0001', name: 'Call', lead: 'Test', datetime: '2026-10-01T10:00:00.000Z', status: 'Pending', completed: false, checklist: [] },
  { id: 'TASK-0002', name: 'Send', lead: 'Test', datetime: '2026-09-15T10:00:00.000Z', status: 'Completed', completed: true, checklist: [] },
];

const now = new Date('2026-10-01T18:00:00Z'); // 23:30 IST 1 Oct

describe('computeKpis', () => {
  it('excludes trash and attributes by the right dates', () => {
    const oct = computeKpis(leads, tasks, monthRange('2026-10'), { now });
    expect(oct.totalEnquiries).toBe(1); // ENQ-0003 only (ENQ-0004 is trash)
    expect(oct.bookings).toBe(1); // ENQ-0002 booked on 1 Oct though enquired in Sep
    expect(oct.siteVisitsScheduled).toBe(1);
    expect(oct.siteVisitsCompleted).toBe(0); // completed visit was 20 Sep
    expect(oct.followupsDue).toBe(1); // ENQ-0001 due 1 Oct
    expect(oct.pendingTasks).toBe(1);
    expect(oct.completedTasks).toBe(0);
    expect(oct.conversionRate).toBe(0); // cohort-based: the one Oct enquiry (ENQ-0003) is Warm, not Booked
    const all = computeKpis(leads, tasks, null, { now });
    expect(Math.round(all.conversionRate)).toBe(17); // 1 of 6 counted enquiries booked
  });
  it('September cohort', () => {
    const sep = computeKpis(leads, tasks, monthRange('2026-09'), { now });
    expect(sep.totalEnquiries).toBe(3); // 0001, 0002, 0005
    expect(sep.hotLeads).toBe(1);
    expect(sep.qualifiedLeads).toBe(2); // Qualified + Booked
    expect(sep.bookings).toBe(0); // booking happened in Oct
    expect(sep.siteVisitsCompleted).toBe(1);
    expect(sep.followupsCompleted).toBe(3); // 1 + 2 entries in Sep
    expect(sep.completedTasks).toBe(1);
    expect(sep.bySource.find((s) => s.key === 'Instagram')?.count).toBe(1);
    expect(sep.byRM.find((r) => r.rm === 'Priya')?.enquiries).toBe(1);
  });
  it('all-time includes blank-date leads and lost leads', () => {
    const all = computeKpis(leads, tasks, null, { now });
    expect(all.totalEnquiries).toBe(6);
    expect(all.lostLeads).toBe(1);
    expect(all.openLeads).toBe(4); // hot, warm, qualified, new(blank)
    expect(all.followupsOverdue).toBe(2); // ENQ-0005 (29 Sep) + ENQ-0001 (16:00 IST today, now is 23:30 IST)
    expect(all.ids.enquiries).not.toContain('ENQ-0004');
  });
  it('overdue uses now', () => {
    const r = computeKpis(leads, tasks, null, { now: new Date('2026-10-01T05:00:00Z') }); // 10:30 IST
    expect(r.followupsOverdue).toBe(1); // only ENQ-0005; ENQ-0001 is later today
  });
  it('rm filter', () => {
    const r = computeKpis(leads, tasks, null, { now, rm: 'Priya' });
    expect(r.totalEnquiries).toBe(1);
    expect(r.bookings).toBe(1);
  });
});

describe('monthly & comparison', () => {
  it('availableMonths spans earliest → current month', () => {
    const months = availableMonths(leads, tasks);
    expect(months[0]).toBe('2026-08');
    expect(months[months.length - 1]).toMatch(/^\d{4}-\d{2}$/);
  });
  it('monthlySeries', () => {
    const s = monthlySeries(leads, tasks, ['2026-08', '2026-09', '2026-10'], { now });
    expect(s.map((p) => p.enquiries)).toEqual([1, 3, 1]);
    expect(s.map((p) => p.bookings)).toEqual([0, 0, 1]);
  });
  it('compareMonths computes difference and % change', () => {
    const c = compareMonths(leads, tasks, '2026-09', '2026-10', { now });
    const enq = c.rows.find((r) => r.metric === 'Enquiries')!;
    expect(enq.previous).toBe(3);
    expect(enq.current).toBe(1);
    expect(enq.difference).toBe(-2);
    expect(Math.round(enq.pctChange!)).toBe(-67);
    expect(enq.direction).toBe('down');
    const bk = c.rows.find((r) => r.metric === 'Bookings')!;
    expect(bk.pctChange).toBeNull(); // 0 → 1 is not a percentage
    expect(bk.direction).toBe('up');
  });
  it('tillDateReport', () => {
    const t = tillDateReport(leads, tasks, { now });
    expect(t.snapshot.totalEnquiries).toBe(6);
    expect(t.totalFollowups).toBe(3);
    expect(t.firstEnquiryDate && t.firstEnquiryDate.toISOString().slice(0, 7)).toBe('2026-08');
  });
});

describe('follow-up buckets and queries', () => {
  it('buckets', () => {
    const b = followupBuckets(leads, now);
    expect(b.today.map((l) => l[F.ID])).toEqual(['ENQ-0001']);
    expect(b.overdue.map((l) => l[F.ID])).toEqual(['ENQ-0005']);
    expect(b.none.length).toBe(2); // ENQ-0003 (warm) + ENQ-0007 (new) — booked/trash/lost excluded
  });
  it('not contacted for 7 days', () => {
    const r = leadsNotContactedForDays(leads, 7, now);
    expect(r.map((l) => l[F.ID])).toContain('ENQ-0001'); // last activity 5 Sep
    expect(r.map((l) => l[F.ID])).not.toContain('ENQ-0005'); // 30 Sep
  });
  it('searchLeads ranks exact id/name first and matches phone digits', () => {
    expect(searchLeads(leads, 'ENQ-0002')[0][F.ID]).toBe('ENQ-0002');
    expect(searchLeads(leads, '98490 12345').length).toBeGreaterThan(0);
    expect(searchLeads(leads, '')).toEqual([]);
  });
});
