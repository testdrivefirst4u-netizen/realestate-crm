/** Customer insights (score, signals, next step) and month-on-month comparisons. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { analyse, contactTime, type InsightInput } from '../server/modules/insights';
import { computeSalesReport } from '../server/modules/salesReport';

const NOW = new Date('2026-11-11T06:30:00Z'); // 12:00 IST
const ago = (h: number) => new Date(NOW.getTime() - h * 3600e3);
const base = (lead: any, more: Partial<InsightInput> = {}): InsightInput => ({ lead: { _id: 'ENQ-1', name: 'Priya Nair', phone: '+971501234567', stage: 'Open', enquiryDate: ago(72), ...lead }, touches: [], quotes: [], units: [], pendingApproval: false, missedCallAt: null, overdueDemand: null, slaHours: 24, ...more });
const touch = (h: number, dir: 'in' | 'out', personId = '') => ({ at: ago(h).toISOString(), channel: 'whatsapp', kind: 'message', direction: dir, responded: dir === 'in', source: 'whatsapp' as const, note: '', personId });

describe('analysis rules', () => {
  it('a missed call comes first, whatever else is going on', () => {
    const i = analyse(base({ milestones: { contacted: { at: ago(48) } } }, { missedCallAt: ago(0.5) }), NOW);
    expect(i.next).toMatchObject({ key: 'missedCall', urgency: 'now', nextType: 'call' });
    expect(i.next!.why).toMatch(/30 minutes ago/);
  });

  it('a new enquiry past the response time: first call now, with the reason', () => {
    const i = analyse(base({ stage: 'New' }), NOW);
    expect(i.next).toMatchObject({ key: 'firstContact', urgency: 'now' });
    expect(i.next!.why).toMatch(/72 hours/);
    expect(i.scoreLabel).toBe('Cold');
  });

  it('visited with no quotation after 3 days → send a quotation; score explains itself', () => {
    const lead = { stage: 'Hot', nextFollowupAt: new Date(NOW.getTime() + 86400e3), milestones: { contacted: { at: ago(200) }, qualified: { at: ago(190) }, visitScheduled: { at: ago(150) }, visitDone: { at: ago(100) } } };
    const i = analyse(base(lead, { touches: [touch(30, 'in')] }), NOW);
    expect(i.next).toMatchObject({ key: 'quote', nextType: 'sendQuote' });
    expect(i.score).toBe(58); // visited 50 + responded 8
    expect(i.signals.map((s) => s.label)).toEqual(['Furthest step: visited', 'Responded 1 days ago']);
    expect(i.scoreLabel).toBe('Progressing');
  });

  it('the decision-maker abroad who never took part → family consultation, timed for their day', () => {
    const people = [{ id: 'P1', name: 'Priya Nair', roles: ['enquirer'] }, { id: 'P2', name: 'Arjun Nair', roles: ['decisionMaker'], phone: '+14155550178', timeZone: 'America/Los_Angeles' }];
    const i = analyse(base({ stage: 'Warm', people, nextFollowupAt: new Date(NOW.getTime() + 86400e3), milestones: { contacted: { at: ago(100) }, qualified: { at: ago(90) }, visitDone: { at: ago(20) } } }, { quotes: [{ status: 'draft', unitId: 'INV-1', total: 1, createdAt: ago(10) }], touches: [touch(5, 'in', 'P1')] }), NOW);
    expect(i.next).toMatchObject({ key: 'family', personName: 'Arjun Nair', nextType: 'familyMeeting' });
    expect(i.next!.timeNote).toMatch(/Los Angeles/);
    expect(i.risks.join(' ')).not.toMatch(/no time zone/);
  });

  it('gone quiet → something of value, not a check-in; WhatsApp without consent is flagged', () => {
    const i = analyse(base({ stage: 'Warm', nextFollowupAt: new Date(NOW.getTime() + 86400e3), milestones: { contacted: { at: ago(900) }, qualified: { at: ago(880) } } }, { touches: [touch(40 * 24, 'in'), touch(10, 'out')] }), NOW);
    const keys = [i.next!.key, ...i.also.map((a) => a.key)];
    expect(keys).toContain('reengage');
    expect(i.signals.find((s) => s.points === -15)).toBeTruthy();
    expect(i.risks.join(' ')).toMatch(/service message/);
  });

  it('a reservation about to lapse and an overdue payment are today’s jobs; budget below price is a risk', () => {
    const lead = { _id: 'ENQ-1', stage: 'Hot', notes: 'Budget about 80 Lakh', nextFollowupAt: new Date(NOW.getTime() + 86400e3), milestones: { contacted: { at: ago(300) }, reserved: { at: ago(30) } } };
    const units = [{ _id: 'INV-1', status: 'Reserved', leadId: 'ENQ-1', holdUntil: new Date(NOW.getTime() + 6 * 3600e3), price: 13_000_000, unitNumber: 'T2-305' }];
    const i = analyse(base(lead, { units, quotes: [{ status: 'approved', unitId: 'INV-1', total: 13_000_000, createdAt: ago(40) }] }), NOW);
    expect(i.next).toMatchObject({ key: 'hold', urgency: 'today' });
    expect(i.next!.title).toMatch(/T2-305/);
    expect(i.risks.join(' ')).toMatch(/budget/i);
    const paid = analyse(base({ ...lead, milestones: { booked: { at: ago(500) } } }, { overdueDemand: { label: 'On agreement', amount: 2_000_000, daysLate: 9 } }), NOW);
    expect(paid.next).toMatchObject({ key: 'payment' });
    expect(paid.scoreLabel).toBe('Customer');
  });

  it('contact time: inside 10:00–19:00 now, else the next local 11:00 (half-hour zones too)', () => {
    expect(contactTime('Asia/Dubai', NOW).at.getTime()).toBe(NOW.getTime()); // 10:30 in Dubai
    const la = contactTime('America/Los_Angeles', NOW); // 22:30 in LA
    expect(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' }).format(la.at)).toBe('11:00');
    const kathmandu = contactTime('Asia/Kathmandu', new Date('2026-11-11T16:00:00Z')); // 21:45 there
    expect(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kathmandu' }).format(kathmandu.at)).toBe('11:00');
  });
});

describe('month on month', () => {
  it('the report compares the same definitions over the previous period', () => {
    const leads: any[] = [
      { _id: 'A', enquiryDate: new Date('2026-10-20'), stage: 'Open', milestones: { contacted: { at: new Date('2026-10-20T02:00:00Z') } } },
      { _id: 'B', enquiryDate: new Date('2026-09-25'), stage: 'New' },
    ];
    const now = new Date('2026-11-01T00:00:00Z');
    const cur = computeSalesReport(leads, [], { from: new Date('2026-10-02'), to: now, now });
    const prev = computeSalesReport(leads, [], { from: new Date('2026-09-02'), to: new Date('2026-10-01'), now });
    expect(cur.enquiries).toBe(1);
    expect(prev.enquiries).toBe(1);
    expect(cur.sla.overallPercent).toBe(100);
    expect(prev.sla.overallPercent).toBe(0);
  });
});

describe('through the router', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  const tokens: Record<string, string> = {};
  const b = { userAgent: 'vitest', ip: '10.8.8.8' };
  const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...b, token: tokens[who] })).body as any;
  beforeAll(async () => { t = await startTestDb(); });
  afterAll(async () => { await t.stop(); });
  beforeEach(async () => {
    await t.reset();
    for (const [n, r] of [['Meera', 'Manager'], ['Asha', 'RM'], ['Ravi', 'RM']] as const) {
      await createUser({ name: n, email: `${n.toLowerCase()}@ins.test`, password: 'long-enough-pw', role: r, mustChangePassword: false }, null);
      tokens[n] = (await login(`${n.toLowerCase()}@ins.test`, 'long-enough-pw', b)).token;
    }
  });

  it("next steps are ranked within the user's own customers; the insight of another agent's lead is hidden", async () => {
    const a = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Asha customer', 'Phone Number': '9811155001', 'Assigned RM': 'Asha' } })).data.lead['Enquiry ID'];
    const r = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Ravi customer', 'Phone Number': '9811155002', 'Assigned RM': 'Ravi' } })).data.lead['Enquiry ID'];
    await (await col<any>(CFG.COLL.LEADS)).updateMany({}, { $set: { enquiryDate: new Date(Date.now() - 50 * 3600e3) } });
    const steps = (await as('Asha', 'getNextSteps')).data;
    expect(steps.map((s: any) => s.leadId)).toEqual([a]);
    expect(steps[0].next.key).toBe('firstContact');
    expect((await as('Asha', 'getLeadInsight', { leadId: r })).code).toBe('NOT_FOUND');
    expect((await as('Meera', 'getNextSteps')).data).toHaveLength(2);
  });

  it('urgency always outranks readiness', async () => {
    const { getNextSteps } = await import('../server/modules/insights');
    const leads = await col<any>(CFG.COLL.LEADS);
    await leads.insertMany([
      { _id: 'ENQ-9001', name: 'Booked, visit tomorrow', phone: '9811166001', stage: 'Booked', assignedRm: 'Meera', milestones: { booked: { at: new Date() } }, siteVisitStatus: CFG.SITE_VISIT.SCHEDULED, siteVisitDate: new Date(Date.now() + 20 * 3600e3), customerJourney: { welcomeCall: { at: new Date() }, handedOver: { at: new Date() } } },
      { _id: 'ENQ-9002', name: 'Missed caller', phone: '9811166002', stage: 'Open', assignedRm: 'Meera', nextFollowupAt: new Date(Date.now() + 86400e3), milestones: { contacted: { at: new Date() } } },
    ] as any);
    await (await col<any>(CFG.COLL.CALLS)).insertOne({ _id: 'CALL-1', phoneLast10: '9811166002', direction: 'Inbound', status: 'Missed', createdAt: new Date(Date.now() - 5 * 60_000) } as any);
    const steps = await getNextSteps({ user: { id: 'SYSTEM', name: 'System', role: 'Developer' } } as any);
    expect(steps[0]).toMatchObject({ leadId: 'ENQ-9002' });
    expect(steps[0].next!.urgency).toBe('now');
  });

  it('the scorecard carries the previous month', async () => {
    const sc = (await as('Meera', 'getScorecard', {})).data;
    expect(sc.prevMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(sc.prevTotal).toBeTruthy();
    expect(sc.rows[0].prevOwn).toBeTruthy();
  });
});
