/** Organisation levels, team-scoped managers, and scorecards with targets — through the real router, synthetic data. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, findUserByEmail, login } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.7.7.7' };
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
async function person(name: string, role: 'Admin' | 'Manager' | 'RM' | 'Viewer') {
  const email = name.toLowerCase().replace(/\s+/g, '.') + '@org.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  ids[name] = String((await findUserByEmail(email))!._id);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;
const relogin = async (name: string) => { tokens[name] = (await login(name.toLowerCase().replace(/\s+/g, '.') + '@org.test', 'long-enough-pw', base)).token; };
const place = (who: string, level: number | null, reportsTo = '', leadScope = 'all') => as('Partner A', 'placeOrgPerson', { userId: ids[who], level, reportsTo: reportsTo ? ids[reportsTo] : '', leadScope });
const leadIds = async (who: string) => ((await as(who, 'getAllLeads')).data.leads as any[]).map((l) => l['Prospect Name']).sort();

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await person('Partner A', 'Admin');
  await person('Head North', 'Manager');
  await person('Head South', 'Manager');
  await person('Asha', 'RM');
  await person('Ravi', 'RM');
  await person('Founder', 'Viewer');
});

describe('organisation', () => {
  it('levels are renamed by admins; placements cannot loop or report to someone junior', async () => {
    expect((await as('Head North', 'saveOrgLevels', { levels: ['A', 'B'] })).code).toBe('FORBIDDEN');
    const lv = await as('Partner A', 'saveOrgLevels', { levels: ['Partner', 'Sales Head', 'Team Lead', 'Senior Executive', 'Executive'] });
    expect(lv.data.levels).toHaveLength(5);
    expect((await as('Partner A', 'saveOrgLevels', { levels: ['1', '2', '3', '4', '5', '6'] })).code).toBe('VALIDATION');
    expect((await place('Partner A', 1)).status).toBe('success');
    expect((await place('Head North', 2, 'Partner A')).status).toBe('success');
    expect((await place('Asha', 5, 'Head North')).status).toBe('success');
    expect((await place('Head North', 5, 'Asha')).message).toMatch(/already reports/);           // loop
    expect((await place('Ravi', 2, 'Head North')).message).toMatch(/more senior/);                // same level
    expect((await place('Head North', 5, 'Partner A')).message).toMatch(/move them first/);       // would sit below Asha
    expect((await place('Asha', 5, 'Asha')).message).toMatch(/themselves/);
  });
});

describe('team-scoped managers', () => {
  beforeEach(async () => {
    await place('Partner A', 1);
    await place('Head North', 2, 'Partner A', 'team');
    await place('Head South', 2, 'Partner A', 'all');
    await place('Asha', 5, 'Head North');
    await place('Ravi', 5, 'Head South');
    for (const [n, phone, rm] of [['North lead', '9811133001', 'Asha'], ['South lead', '9811133002', 'Ravi'], ['Unassigned lead', '9811133003', ''], ['Head lead', '9811133004', 'Head North']]) {
      expect((await as('Partner A', 'addLead', { data: { 'Prospect Name': n, 'Phone Number': phone, 'Assigned RM': rm } })).status).toBe('success');
    }
    await relogin('Head North');
  });

  it('see their own, their team and unassigned leads; an "all" manager and the founder see everything', async () => {
    expect(await leadIds('Head North')).toEqual(['Head lead', 'North lead', 'Unassigned lead']);
    expect(await leadIds('Head South')).toHaveLength(4);
    expect(await leadIds('Founder')).toHaveLength(4);
    expect(await leadIds('Asha')).toEqual(['North lead']);
  });

  it("the team view, workload and reassignment stay inside the team", async () => {
    const team = (await as('Head North', 'getTeamExceptions')).data;
    expect(team.workload.map((w: any) => w.name).sort()).toEqual(['Asha', 'Head North']);
    expect(team.unassigned.map((r: any) => r.name)).toEqual(['Unassigned lead']);
    const south = (await as('Partner A', 'getAllLeads')).data.leads.find((l: any) => l['Prospect Name'] === 'South lead')['Enquiry ID'];
    expect((await as('Head North', 'reassignLeads', { leadIds: [south], to: ids.Asha, reason: 'x' })).code).toBe('NOT_FOUND');
    const un = (await as('Partner A', 'getAllLeads')).data.leads.find((l: any) => l['Prospect Name'] === 'Unassigned lead')['Enquiry ID'];
    expect((await as('Head North', 'reassignLeads', { leadIds: [un], to: ids.Ravi, reason: 'x' })).code).toBe('FORBIDDEN'); // Ravi is not in the team
    expect((await as('Head North', 'reassignLeads', { leadIds: [un], to: ids.Asha, reason: 'North pincode' })).data.moved).toBe(1);
  });
});

describe('scorecards', () => {
  beforeEach(async () => {
    await place('Partner A', 1);
    await place('Head North', 2, 'Partner A', 'team');
    await place('Asha', 5, 'Head North');
    await place('Ravi', 5, 'Head North');
    await relogin('Head North');
    for (const [n, phone, rm] of [['L1', '9811144001', 'Asha'], ['L2', '9811144002', 'Asha'], ['L3', '9811144003', 'Ravi']]) {
      await as('Partner A', 'addLead', { data: { 'Prospect Name': n, 'Phone Number': phone, 'Assigned RM': rm } });
    }
    const all = (await as('Partner A', 'getAllLeads')).data.leads;
    const l1 = all.find((l: any) => l['Prospect Name'] === 'L1')['Enquiry ID'];
    await as('Asha', 'appendRemark', { id: l1, remark: 'Spoke to the daughter' });
    await as('Asha', 'logEngagement', { leadId: l1, channel: 'email', kind: 'content' });
  });

  it('roll up through the tree; an agent sees only their own card', async () => {
    const sc = (await as('Partner A', 'getScorecard', {})).data;
    expect(sc.rows.map((r: any) => [r.name, r.depth])).toEqual([['Partner A', 0], ['Head North', 1], ['Asha', 2], ['Ravi', 2], ['Head South', 0]]);
    const head = sc.rows.find((r: any) => r.name === 'Head North');
    expect(head.team).toMatchObject({ enquiries: 3, contacted: 1, touches: 1 });
    expect(sc.rows.find((r: any) => r.name === 'Asha').own).toMatchObject({ enquiries: 2, contacted: 1, touches: 1 });
    const asha = (await as('Asha', 'getScorecard', {})).data;
    expect(asha.rows.map((r: any) => r.name)).toEqual(['Asha']);
    const north = (await as('Head North', 'getScorecard', {})).data;
    expect(north.rows.map((r: any) => r.name)).toEqual(['Head North', 'Asha', 'Ravi']);
    expect((await as('Founder', 'getScorecard', {})).data.rows.length).toBe(5);
  });

  it('targets are set by someone above the person (or an admin), never by themselves', async () => {
    const month = (await as('Asha', 'getScorecard', {})).data.month;
    expect((await as('Asha', 'setTargets', { userId: ids.Asha, month, values: { bookings: 99 } })).code).toBe('FORBIDDEN');
    expect((await as('Head North', 'setTargets', { userId: ids.Asha, month, values: { bookings: 2, visits: 8, respondedInTime: 90 } })).status).toBe('success');
    expect((await as('Head North', 'setTargets', { userId: ids['Head South'], month, values: { bookings: 2 } })).code).toBe('FORBIDDEN'); // not in their team
    expect((await as('Partner A', 'setTargets', { userId: ids['Head North'], month, values: { bookings: 4 } })).status).toBe('success');
    const mine = (await as('Asha', 'getScorecard', { month })).data.mine;
    expect(mine.targets).toEqual({ bookings: 2, visits: 8, respondedInTime: 90 });
    expect((await as('Head North', 'setTargets', { userId: ids.Asha, month, values: { respondedInTime: 120 } })).code).toBe('VALIDATION');
  });
});
