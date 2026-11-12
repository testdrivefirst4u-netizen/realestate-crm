/**
 * Release A, finding 3 — ownership by immutable user id. Renaming an agent used to orphan every lead assigned to
 * them, because leads were matched by display name. Through the real router.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, findUserByEmail, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { migrateOwnerIds } from '../scripts/migrate-owner-ids-lib';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.1.1.3' };
const tokens: Record<string, string> = {};
const emails: Record<string, string> = {};

async function signIn(name: string, role: 'Admin' | 'Manager' | 'RM') {
  const email = name.toLowerCase().replace(/\s+/g, '.') + '@own.test';
  emails[name] = email;
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;
const leadIds = (body: any) => (body.data.leads as any[]).map((l) => l['Enquiry ID']).sort();

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await signIn('Asha', 'RM');
  await signIn('Ravi', 'RM');
  await signIn('Admin One', 'Admin');
});

describe('finding 3: renaming an agent keeps their leads', () => {
  it('leads, tasks and visibility survive a rename; the id is stamped on new leads', async () => {
    const lead = (await as('Admin One', 'addLead', { data: { 'Prospect Name': 'Mrs Kapoor', 'Phone Number': '9833300001', 'Assigned RM': 'Asha' } })).data.lead;
    const asha = (await findUserByEmail(emails.Asha))!;
    expect((await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: lead['Enquiry ID'] })).assignedRmId).toBe(asha._id);
    await as('Admin One', 'addTask', { data: { name: 'Call back', leadId: lead['Enquiry ID'], assignedTo: 'Asha', datetime: new Date(Date.now() + 3600e3).toISOString() } });

    const r = await as('Admin One', 'saveUser', { data: { id: asha._id, name: 'Asha Rao' } });
    expect(r.status).toBe('success');

    // Asha's session now carries the new name and still sees her lead and task
    expect(leadIds(await as('Asha', 'getAllLeads'))).toEqual([lead['Enquiry ID']]);
    const boot = (await as('Asha', 'getBootstrap')).data;
    expect(boot.tasks.map((x: any) => x.name)).toEqual(['Call back']);
    // the label follows the rename; the history keeps the old name
    const stored = await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: lead['Enquiry ID'] });
    expect(stored).toMatchObject({ assignedRm: 'Asha Rao', assignedRmId: asha._id });
    const user = await (await col<any>(CFG.COLL.USERS)).findOne({ _id: asha._id });
    expect(user.previousNames.map((p: any) => p.name)).toEqual(['Asha']);
    const audit = await (await col<any>(CFG.COLL.AUDIT_LOG)).findOne({ action: 'User Renamed' });
    expect(audit.details || audit.detail || JSON.stringify(audit)).toContain('Asha → Asha Rao');
  });

  it('a lead from before ids (name only) is re-labelled and stamped too', async () => {
    const lead = (await as('Admin One', 'addLead', { data: { 'Prospect Name': 'Old Lead', 'Phone Number': '9833300002', 'Assigned RM': 'Asha' } })).data.lead;
    await (await col<any>(CFG.COLL.LEADS)).updateOne({ _id: lead['Enquiry ID'] }, { $unset: { assignedRmId: '' } });
    const asha = (await findUserByEmail(emails.Asha))!;
    await as('Admin One', 'saveUser', { data: { id: asha._id, name: 'Asha R' } });
    expect(leadIds(await as('Asha', 'getAllLeads'))).toEqual([lead['Enquiry ID']]);
    expect((await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: lead['Enquiry ID'] })).assignedRmId).toBe(asha._id);
  });

  it("someone renamed to a former agent's old name does not inherit that agent's leads", async () => {
    const lead = (await as('Admin One', 'addLead', { data: { 'Prospect Name': 'Mr Shah', 'Phone Number': '9833300003', 'Assigned RM': 'Asha' } })).data.lead;
    const asha = (await findUserByEmail(emails.Asha))!;
    const ravi = (await findUserByEmail(emails.Ravi))!;
    await as('Admin One', 'saveUser', { data: { id: asha._id, name: 'Asha Menon' } });
    await as('Admin One', 'saveUser', { data: { id: ravi._id, name: 'Asha' } }); // the old name is free again
    expect(leadIds(await as('Ravi', 'getAllLeads'))).toEqual([]);
    expect(leadIds(await as('Asha', 'getAllLeads'))).toEqual([lead['Enquiry ID']]);
  });

  it('the migration backfills ids from names, reports unmatched owners, and rolls back', async () => {
    const leads = await col<any>(CFG.COLL.LEADS);
    await leads.insertMany([
      { _id: 'ENQ-9001', name: 'A', assignedRm: ' asha ', stage: 'New' },
      { _id: 'ENQ-9002', name: 'B', assignedRm: 'Former Agent', stage: 'New' },
      { _id: 'ENQ-9003', name: 'C', assignedRm: '', stage: 'New' },
    ] as any);
    const dry = await migrateOwnerIds(t.db, { apply: false });
    expect(dry).toMatchObject({ leads: { matched: 1, unmatched: 1 } });
    expect(dry.unmatchedNames).toContain('Former Agent');
    expect((await leads.findOne({ _id: 'ENQ-9001' })).assignedRmId).toBeUndefined(); // dry run writes nothing
    await migrateOwnerIds(t.db, { apply: true });
    const asha = (await findUserByEmail(emails.Asha))!;
    expect((await leads.findOne({ _id: 'ENQ-9001' })).assignedRmId).toBe(asha._id);
    expect((await leads.findOne({ _id: 'ENQ-9002' })).assignedRmId).toBeUndefined();
    await migrateOwnerIds(t.db, { rollback: true });
    expect((await leads.findOne({ _id: 'ENQ-9001' })).assignedRmId).toBeUndefined();
    expect((await leads.findOne({ _id: 'ENQ-9001' })).assignedRm).toBe(' asha '); // names are never touched
  });
});
