import { describe, it, expect } from 'vitest';
import {
  buildActionProposal,
  executeReadTool,
  isProposalError,
  parseDueDate,
  quickIntent,
  resolveLead,
  resultTable,
  TOOL_DECLARATIONS,
  SYSTEM_PROMPT,
  type ToolContext,
} from '../src/modules/ai/copilotTools';
import { AMAYA_KNOWLEDGE } from '../src/modules/ai/amayaKnowledge';
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
  mk({ [F.ID]: 'ENQ-0003', [F.NAME]: 'Rahul Verma', [F.PHONE]: '+91 90000 11111', [F.STAGE]: STAGES.WARM, [F.ENQUIRY_DATE]: '2026-10-01 09:00', [F.SITE_VISIT_STATUS]: SITE_VISIT.SCHEDULED, [F.SITE_VISIT_DATE]: '2026-10-03 11:00', [F.SOURCE]: 'Instagram' }),
  mk({ [F.ID]: 'ENQ-0004', [F.STAGE]: STAGES.TRASH, [F.ENQUIRY_DATE]: '2026-10-01 09:00' }),
  mk({ [F.ID]: 'ENQ-0005', [F.STAGE]: STAGES.QUALIFIED, [F.ENQUIRY_DATE]: '2026-09-28', [F.NEXT_FOLLOWUP]: '2026-09-29 10:00', [F.SOURCE]: 'Instagram', 'Follow-up 1': '2026-09-28 18:00 — intro', 'Follow-up 2': '2026-09-30 18:00 — brochure sent' }),
  mk({ [F.ID]: 'ENQ-0006', [F.STAGE]: STAGES.DQ_BUDGET, [F.ENQUIRY_DATE]: '2026-08-15' }),
  mk({ [F.ID]: 'ENQ-0007', [F.STAGE]: STAGES.NEW, [F.ENQUIRY_DATE]: '' }),
];

const tasks: TaskItem[] = [
  { id: 'TASK-0001', name: 'Call', lead: 'Rahul Verma', leadId: 'ENQ-0003', datetime: '2026-10-01T10:00:00.000Z', status: 'Pending', completed: false, checklist: [] },
  { id: 'TASK-0002', name: 'Send', lead: 'Test', datetime: '2026-09-15T10:00:00.000Z', status: 'Completed', completed: true, checklist: [] },
];

const now = new Date('2026-10-01T18:00:00Z'); // 23:30 IST, 1 Oct 2026
const ctx: ToolContext = { leads, tasks, inventory: [], now, currentUser: 'Rahul' };

describe('executeReadTool', () => {
  it('list_leads filters by stage and returns compact rows', () => {
    const r = executeReadTool('list_leads', { stage: 'Hot' }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(1);
    expect(r.leads).toHaveLength(1);
    expect(r.leads![0]).toMatchObject({ id: 'ENQ-0001', stage: 'Hot', rm: 'Rahul', followups: 1 });
    expect(r.leads![0].nextFollowup).toBe('01 Oct 2026, 04:00 PM');
    expect(r.leads![0].enquiryDate).toBe('05 Sep 2026, 10:00 AM');
  });

  it('list_leads understands pseudo-stages, sources, RMs and not_contacted_days', () => {
    expect(executeReadTool('list_leads', { stage: 'active' }, ctx).total).toBe(4); // hot, warm, qualified, new(blank date)
    expect(executeReadTool('list_leads', { stage: 'lost' }, ctx).total).toBe(1);
    expect(executeReadTool('list_leads', { source: 'instagram' }, ctx).total).toBe(2);
    expect(executeReadTool('list_leads', { rm: 'priya' }, ctx).total).toBe(1);
    expect(executeReadTool('list_leads', { rm: 'me' }, ctx).total).toBe(5);
    const quiet = executeReadTool('list_leads', { not_contacted_days: 7 }, ctx);
    expect(quiet.total).toBe(1);
    expect(quiet.leads![0].id).toBe('ENQ-0001');
    expect(executeReadTool('list_leads', { followup: 'today' }, ctx).leads!.map((l) => l.id)).toEqual(['ENQ-0001']);
    expect(executeReadTool('list_leads', { followup: 'overdue' }, ctx).leads!.map((l) => l.id)).toEqual(['ENQ-0005']);
    expect(executeReadTool('list_leads', { stage: 'Nonsense' }, ctx).error).toMatch(/Unknown stage/);
  });

  it('get_kpis this_month uses core/analytics numbers', () => {
    const r = executeReadTool('get_kpis', { range: 'this_month' }, ctx);
    expect(r.range).toBe('This Month');
    expect(r.enquiries).toBe(1); // ENQ-0003 only (ENQ-0004 is trash)
    expect(r.bookings).toBe(1); // booked on 1 Oct though enquired in Sep
    expect(r.warm).toBe(1);
    expect(r.conversionRate).toBe('0.0%'); // cohort-based: the only Oct enquiry (Warm) has not booked yet
    expect(r.followups).toMatchObject({ due: 1 });
    expect(r.taskCounts).toMatchObject({ pending: 1, completed: 0 });
  });

  it('get_kpis accepts month keys, "all", natural month names and RM filters', () => {
    expect(executeReadTool('get_kpis', { range: '2026-09' }, ctx).enquiries).toBe(3);
    expect(executeReadTool('get_kpis', { range: 'September' }, ctx).enquiries).toBe(3);
    expect(executeReadTool('get_kpis', { range: 'all' }, ctx).enquiries).toBe(6);
    expect(executeReadTool('get_kpis', { range: 'all', rm: 'Priya' }, ctx).enquiries).toBe(1);
    expect(executeReadTool('get_kpis', { rm: 'Nobody' }, ctx).error).toMatch(/Unknown RM/);
    const odd = executeReadTool('get_kpis', { range: 'fortnight' }, ctx);
    expect(odd.warning).toMatch(/Unrecognised range/);
    expect(odd.enquiries).toBe(6);
  });

  it('compare_months defaults to current vs previous month', () => {
    const r = executeReadTool('compare_months', {}, ctx) as any;
    expect(r.previous.key).toBe('2026-09');
    expect(r.current.key).toBe('2026-10');
    const enq = r.rows.find((x: any) => x.metric === 'Enquiries');
    expect(enq).toMatchObject({ previous: 3, current: 1, direction: 'down' });
  });

  it('find_lead, get_lead_details, list_tasks and rm_leaderboard', () => {
    expect(executeReadTool('find_lead', { query: 'verma' }, ctx).leads![0].id).toBe('ENQ-0003');
    expect(executeReadTool('find_lead', { query: '90000 11111' }, ctx).leads![0].id).toBe('ENQ-0003');
    const details = executeReadTool('get_lead_details', { lead_id: 'ENQ-0005' }, ctx) as any;
    expect(details.lead.stage).toBe('Qualified');
    expect(details.followups.total).toBe(2);
    expect(details.followups.recent[1].remark).toBe('brochure sent');
    const byName = executeReadTool('get_lead_details', { lead_id: 'Rahul Verma' }, ctx) as any;
    expect(byName.lead.id).toBe('ENQ-0003');
    expect(byName.tasks).toHaveLength(1);
    const pending = executeReadTool('list_tasks', { status: 'pending' }, ctx);
    expect(pending.total).toBe(1);
    expect(pending.tasks![0]).toMatchObject({ id: 'TASK-0001', status: 'Overdue', leadId: 'ENQ-0003' });
    const board = executeReadTool('rm_leaderboard', { range: 'all' }, ctx) as any;
    expect(board.top).toBe('Rahul');
    expect(board.rows[0].enquiries).toBe(5);
  });

  it('unknown tools return an error instead of throwing', () => {
    expect(executeReadTool('explode', {}, ctx).error).toMatch(/Unknown tool/);
  });

  it('resultTable builds a drawer table with hidden lead ids', () => {
    const t = resultTable(executeReadTool('list_leads', { stage: 'Hot' }, ctx));
    expect(t?.leadIds).toEqual(['ENQ-0001']);
    expect(t?.table.columns).toEqual(['ID', 'Name', 'Stage', 'Unit', 'RM', 'Next follow-up']);
    expect(t?.table.rows[0]._leadId).toBe('ENQ-0001');
  });
});

describe('quickIntent (no-AI fallback)', () => {
  it('show me all hot leads', () => {
    const r = quickIntent('show me all hot leads', ctx);
    expect(r).not.toBeNull();
    expect(r!.text).toContain('**1 Hot lead**');
    expect(r!.leadIds).toEqual(['ENQ-0001']);
    expect(r!.table?.rows[0].ID).toBe('ENQ-0001');
  });
  it('covers the example chips', () => {
    expect(quickIntent('How many enquiries came this month?', ctx)!.text).toContain('**1 enquiry** this month');
    expect(quickIntent('Which RM has the highest number of enquiries?', ctx)!.text).toContain('**Rahul** has the most enquiries (5)');
    const quiet = quickIntent('Show leads not contacted for 7 days', ctx)!;
    expect(quiet.text).toContain('1 active lead not contacted for 7 days');
    expect(quiet.leadIds).toEqual(['ENQ-0001']);
    expect(quickIntent('Compare this month with last month', ctx)!.text).toContain('**Sep 2026 vs Oct 2026**');
    expect(quickIntent("Show today's follow-ups", ctx)!.leadIds).toEqual(['ENQ-0001']);
    expect(quickIntent('overdue follow ups', ctx)!.leadIds).toEqual(['ENQ-0005']);
    expect(quickIntent('instagram leads', ctx)!.leadIds).toEqual(['ENQ-0003', 'ENQ-0005']);
    expect(quickIntent('pending tasks', ctx)!.table?.rows[0].Task).toBe('Call');
    expect(quickIntent('find Rahul Verma', ctx)!.leadIds).toEqual(['ENQ-0003']);
    expect(quickIntent('performance last month', ctx)!.text).toContain('**3 enquiries** (Last Month)');
    expect(quickIntent('booked this month', ctx)!.leadIds).toEqual(['ENQ-0002']);
  });
  it('returns null for things it does not understand', () => {
    expect(quickIntent('write a poem about Medchal', ctx)).toBeNull();
  });
});

describe('buildActionProposal', () => {
  it('update_lead_stage resolves a name to the lead id', () => {
    const p = buildActionProposal('update_lead_stage', { lead_id: 'Rahul Verma', stage: 'hot' }, ctx);
    expect(isProposalError(p)).toBe(false);
    if (isProposalError(p)) return;
    expect(p.type).toBe('update_lead_stage');
    expect(p.summary).toBe('Change ENQ-0003 (Rahul Verma) stage Warm → Hot');
    expect(p.args).toMatchObject({ leadId: 'ENQ-0003', stage: 'Hot', previousStage: 'Warm' });
    expect(p.destructive).toBe(false);
  });
  it('flags lost stages as destructive and refuses unknown stages', () => {
    const p = buildActionProposal('update_lead_stage', { lead_id: 'ENQ-0003', stage: 'junk' }, ctx);
    expect(!isProposalError(p) && p.destructive).toBe(true);
    const bad = buildActionProposal('update_lead_stage', { lead_id: 'ENQ-0003', stage: 'lukewarm' }, ctx);
    expect(isProposalError(bad) && bad.error).toMatch(/Unknown stage/);
  });
  it('ambiguous names return candidates instead of a proposal', () => {
    const p = buildActionProposal('update_lead_stage', { lead_id: 'Test', stage: 'Hot' }, ctx);
    expect(isProposalError(p)).toBe(true);
    if (!isProposalError(p)) return;
    expect(p.candidates!.length).toBeGreaterThan(1);
    expect(resolveLead(ctx, { lead_id: '3' })).toMatchObject({ lead: { [F.ID]: 'ENQ-0003' } });
  });
  it('create_task parses natural due dates into ISO', () => {
    const p = buildActionProposal('create_task', { lead_name: 'Rahul Verma', name: 'Call back', due: 'tomorrow 11am' }, ctx);
    if (isProposalError(p)) throw new Error(p.error);
    expect(p.args.datetime).toBe('2026-10-02T05:30:00.000Z'); // 11:00 IST on 2 Oct
    expect(p.summary).toBe('Create task "Call back" for ENQ-0003 (Rahul Verma) due 02 Oct 2026, 11:00 AM');
  });
  it('add_remark / schedule_followup / assign_rm / update_lead normalise their args', () => {
    const remark = buildActionProposal('add_remark', { lead_id: 'ENQ-0003', remark: 'Spoke to son', next_followup: 'next monday 4pm' }, ctx);
    if (isProposalError(remark)) throw new Error(remark.error);
    expect(remark.args.nextFollowup).toBe('2026-10-05T10:30:00.000Z'); // Mon 5 Oct 16:00 IST
    const fu = buildActionProposal('schedule_followup', { lead_id: 'ENQ-0001', due: '2026-10-03 11:00' }, ctx);
    if (isProposalError(fu)) throw new Error(fu.error);
    expect(fu.summary).toContain('to 03 Oct 2026, 11:00 AM (currently 01 Oct 2026, 04:00 PM)');
    const rm = buildActionProposal('assign_rm', { lead_id: 'ENQ-0003', rm: 'priya' }, ctx);
    if (isProposalError(rm)) throw new Error(rm.error);
    expect(rm.args).toMatchObject({ leadId: 'ENQ-0003', rm: 'Priya', previousRm: 'Rahul' });
    const upd = buildActionProposal('update_lead', { lead_id: 'ENQ-0003', fields: [{ field: 'unit_type', value: '3 BHK' }, { field: 'brochure', value: 'yes' }] }, ctx);
    if (isProposalError(upd)) throw new Error(upd.error);
    expect(upd.args.patch).toEqual({ [F.UNIT_TYPE]: '3 BHK', [F.BROCHURE]: 'Yes' });
    const prot = buildActionProposal('update_lead', { lead_id: 'ENQ-0003', fields: [{ field: 'Enquiry ID', value: 'X' }] }, ctx);
    expect(isProposalError(prot)).toBe(true);
  });
});

describe('parseDueDate', () => {
  it('handles explicit and natural inputs in IST', () => {
    expect(parseDueDate('2026-10-05T11:00:00+05:30', now)?.toISOString()).toBe('2026-10-05T05:30:00.000Z');
    expect(parseDueDate('tomorrow', now)?.toISOString()).toBe('2026-10-02T04:30:00.000Z'); // default 10:00
    expect(parseDueDate('in 2 days 3pm', now)?.toISOString()).toBe('2026-10-03T09:30:00.000Z');
    expect(parseDueDate('5 Oct evening', now)?.toISOString()).toBe('2026-10-05T12:30:00.000Z');
    expect(parseDueDate('day after tomorrow at 5', now)?.toISOString()).toBe('2026-10-03T11:30:00.000Z');
    expect(parseDueDate('whenever', now)).toBeNull();
  });
});

describe('declarations & prompt', () => {
  it('declares every tool with an OBJECT schema', () => {
    expect(TOOL_DECLARATIONS.map((d) => d.name)).toEqual([
      'get_kpis', 'compare_months', 'list_leads', 'find_lead', 'get_lead_details', 'list_tasks', 'list_inventory', 'rm_leaderboard', 'source_breakdown',
      'search_project_documents',
      'create_task', 'update_lead_stage', 'add_remark', 'schedule_followup', 'assign_rm', 'update_lead',
    ]);
    for (const d of TOOL_DECLARATIONS) expect(d.parameters?.type).toBe('OBJECT');
  });
  it('system prompt carries the date, RM names and the no-guessing rule', () => {
    const p = SYSTEM_PROMPT(ctx);
    expect(p).toContain('01 Oct 2026, 11:30 PM');
    expect(p).toContain('Priya, Rahul');
    expect(p).toMatch(/Never guess/);
    expect(p).toMatch(/Never claim an action has been done/);
  });
  it('system prompt makes the Copilot a general assistant that is also the Amaya expert', () => {
    const p = SYSTEM_PROMPT(ctx);
    expect(p).toContain(AMAYA_KNOWLEDGE); // embedded verbatim
    expect(p.indexOf(AMAYA_KNOWLEDGE)).toBeGreaterThan(p.indexOf('CRM vocabulary')); // after the CRM tool instructions
    expect(p).toMatch(/Never reply that you can only help with the CRM/);
    expect(p).toMatch(/Answer ONLY from the APPROVED AMAYA KNOWLEDGE below and from the search_project_documents tool/);
    expect(p).toMatch(/approved price sheet or the commercial owner/);
    expect(p).toMatch(/British English/);
    expect(p).toMatch(/FORBIDDEN words/);
    expect(p).not.toContain('Current context'); // only when the drawer passes a context
  });
  it('knowledge carries the floor-plan facts: tower order, numbering rule, facing and the airport time', () => {
    expect(AMAYA_KNOWLEDGE).toMatch(/Tower A \(west, forest side\) · Tower B \(middle\) · Tower C \(east\)/);
    expect(AMAYA_KNOWLEDGE).toMatch(/ODD numbers on the EAST face and EVEN numbers on the WEST face/);
    expect(AMAYA_KNOWLEDGE).toMatch(/A101 3\.5 BHK, A102 3 BHK, A103 3 BHK/);
    expect(AMAYA_KNOWLEDGE).toMatch(/Tower A 80 homes .* Towers B and C 88 each .* = 256/);
    expect(AMAYA_KNOWLEDGE).toMatch(/Shamshabad 70 min/);
    expect(AMAYA_KNOWLEDGE).toMatch(/Never promise a particular view/);
  });
});
