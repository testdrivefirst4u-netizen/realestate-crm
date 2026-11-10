/**
 * Release B — the family-to-booking journey through the real router, with synthetic data:
 * family enquiry → agent → people & consent → disposition with next action → visit → quotation (discount approval)
 * → reservation → booking request → manager approval → booked; plus phone identity and the Today queues.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { phoneIdentity, sameIdentity } from '../server/core/phone';
import { findLeadByPhone } from '../server/modules/leads';
import { canSend, isStopWord } from '../server/modules/consent';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.2.2.2' };
const tokens: Record<string, string> = {};
async function signIn(name: string, role: 'Admin' | 'Manager' | 'RM' | 'Viewer') {
  const email = name.toLowerCase().replace(/\s+/g, '.') + '@journey.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;
const soon = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

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
  await signIn('Meera', 'Manager');
  await signIn('Founder', 'Viewer');
});

describe('phone identity', () => {
  it('international numbers that share the last ten digits stay distinct', async () => {
    expect(phoneIdentity('+1 (415) 987-6543')?.e164).toBe('+14159876543');
    expect(phoneIdentity('098765 43210')?.e164).toBe('+919876543210');
    expect(phoneIdentity('00971 50 123 4567')?.e164).toBe('+971501234567');
    expect(sameIdentity('+14159876543', '+914159876543')).toBe(false);
    expect(sameIdentity('+447415987654', '+917415987654')).toBe(false);
    expect(sameIdentity('9876543210', '+91 98765 43210')).toBe(true); // local Indian vs +91
    expect(sameIdentity('9876543210', '+1 987 654 3210')).toBe(false); // local is India, not the US

    // synthetic: a US-format number and an Indian mobile with the same last ten digits (9811122334)
    const us = await as('Meera', 'addLead', { data: { 'Prospect Name': 'Son in Seattle', 'Phone Number': '+1 981 112 2334' } });
    expect(us.status).toBe('success');
    const inLead = await as('Meera', 'addLead', { data: { 'Prospect Name': 'Different person', 'Phone Number': '+91 98111 22334' } });
    expect(inLead.status).toBe('success'); // not refused as a duplicate of the US number
    expect((await findLeadByPhone('+19811122334'))?.['Enquiry ID']).toBe(us.data.lead['Enquiry ID']);
    expect((await findLeadByPhone('+919811122334'))?.['Enquiry ID']).toBe(inLead.data.lead['Enquiry ID']);
    expect((await findLeadByPhone('98111 22334'))?.['Enquiry ID']).toBe(inLead.data.lead['Enquiry ID']); // local = India
  });
});

describe('family-to-booking journey', () => {
  it('runs end to end with gates, approvals and audit', async () => {
    // 1. a daughter in Dubai enquires for her parents; assigned to Asha
    const lead = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'Priya Nair', 'Phone Number': '+971 50 123 4567', 'Assigned RM': 'Asha', 'Enquired For': 'Parents', 'Enquiry Source': 'Website' } })).data.lead;
    const id = lead['Enquiry ID'];

    // 2. Asha sees it first in Today
    const today = (await as('Asha', 'getToday')).data;
    expect(today.newEnquiries.map((r: any) => r.leadId)).toEqual([id]);
    expect((await as('Ravi', 'getToday')).data.newEnquiries).toHaveLength(0); // not Ravi's

    // 3. people: the enquirer (daughter), residents (parents), payer (son in the US)
    const people0 = (await as('Asha', 'getLeadPeople', { leadId: id })).data;
    expect(people0[0]).toMatchObject({ roles: ['enquirer'], phone: '+971501234567' });
    await as('Asha', 'saveLeadPerson', { leadId: id, person: { ...people0[0], roles: ['enquirer', 'decisionMaker'], relationship: 'Daughter', timeZone: 'Asia/Dubai', preferredChannel: 'whatsapp', consent: { whatsappMarketing: 'granted', source: 'website', evidence: 'Ticked WhatsApp updates on the enquiry form' } } });
    await as('Asha', 'saveLeadPerson', { leadId: id, person: { name: 'Mr & Mrs Nair', roles: ['resident'], relationship: 'Parents', phone: '9876500010', language: 'Malayalam' } });
    const badTz = await as('Asha', 'saveLeadPerson', { leadId: id, person: { name: 'X', roles: ['other'], timeZone: 'Mars/Base' } });
    expect(badTz.code).toBe('VALIDATION');
    const noEvidence = await as('Asha', 'saveLeadPerson', { leadId: id, person: { name: 'Y', roles: ['other'], phone: '+1 206 555 0100', consent: { whatsappMarketing: 'granted' } } });
    expect(noEvidence.code).toBe('VALIDATION'); // consent needs evidence
    expect((await canSend('+971501234567', 'marketing')).ok).toBe(true);
    expect((await canSend('9876500010', 'marketing')).ok).toBe(true); // default policy: not opted out
    const { settingSet } = await import('../server/core/settings');
    await settingSet('whatsappMarketingConsent', 'explicit', 'test');
    expect((await canSend('9876500010', 'marketing')).ok).toBe(false); // explicit policy: no consent recorded for the parents
    expect((await canSend('+971501234567', 'marketing')).ok).toBe(true);
    await settingSet('whatsappMarketingConsent', 'optOut', 'test');

    // Ravi cannot read or change Asha's customer's family
    expect((await as('Ravi', 'getLeadPeople', { leadId: id })).code).toBe('NOT_FOUND');

    // 4. disposition: an open outcome needs a next action
    expect((await as('Asha', 'logDisposition', { leadId: id, outcome: 'familyConsult', note: 'Will discuss with brother' })).code).toBe('VALIDATION');
    const disp = await as('Asha', 'logDisposition', { leadId: id, outcome: 'visitAgreed', note: 'Parents to visit with daughter on video', next: { type: 'visit', at: soon(48), note: 'Virtual tour' } });
    expect(disp.status).toBe('success');
    const doc = await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: id });
    expect(doc.milestones.contacted).toBeTruthy();
    expect(doc.nextAction).toMatchObject({ type: 'visit' });
    expect((await as('Asha', 'getToday')).data.newEnquiries).toHaveLength(0); // contacted: out of the new queue

    // 5. visit scheduled and completed (milestones)
    await as('Asha', 'updateLead', { id, data: { 'Site Visit Status': CFG.SITE_VISIT.SCHEDULED, 'Site Visit Date': soon(48) } });
    await as('Asha', 'updateLead', { id, data: { 'Site Visit Status': CFG.SITE_VISIT.COMPLETED, 'Lead Stage': 'Hot' } });

    // 6. quotation with a discount above the limit → needs a manager; the author cannot approve their own
    const unit = (await as('Meera', 'addInventoryUnit', { data: { unitId: 'T2-504', price: 12_000_000 } })).data.unit;
    const q = (await as('Asha', 'saveQuote', { leadId: id, unitId: unit.inventoryId, charges: [{ label: 'Lifestyle plan (1 yr)', amount: 600_000 }], discount: 500_000 })).data;
    expect(q).toMatchObject({ version: 1, status: 'pendingApproval', total: 12_100_000 });
    expect((await as('Asha', 'decideQuote', { id: q._id, approve: true })).code).toBe('FORBIDDEN');
    // booking cannot be requested yet: quote not approved, no payer
    const early = await as('Asha', 'requestBooking', { leadId: id, unitId: unit.inventoryId });
    expect(early.code).toBe('VALIDATION');
    expect(early.details.missing).toHaveLength(2);
    expect((await as('Meera', 'decideQuote', { id: q._id, approve: true, note: 'Launch offer' })).data.status).toBe('approved');

    // 7. payer: son in the US (overseas number stays distinct)
    await as('Asha', 'saveLeadPerson', { leadId: id, person: { name: 'Arjun Nair', roles: ['payer'], relationship: 'Son', phone: '+1 206 555 0100', timeZone: 'America/Los_Angeles' } });

    // 8. reservation (held, time-limited) then a booking request
    await as('Meera', 'updateInventoryUnit', { id: unit.inventoryId, expectedRev: 0, data: { status: 'Reserved', leadId: id } });
    const req = (await as('Asha', 'requestBooking', { leadId: id, unitId: unit.inventoryId, note: 'Token cheque ready' })).data;
    expect(req.status).toBe('pending');
    expect((await as('Meera', 'getTeamExceptions')).data.approvals.map((a: any) => a.id)).toEqual([req._id]);

    // 9. the manager approves → the unit is booked atomically, the lead is Booked; the founder sees, cannot act
    expect((await as('Founder', 'decideBooking', { id: req._id, approve: true })).code).toBe('FORBIDDEN');
    expect((await as('Meera', 'decideBooking', { id: req._id, approve: true })).data.status).toBe('approved');
    const booked = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: unit.inventoryId });
    expect(booked).toMatchObject({ status: 'Booked', leadId: id, quotedAmount: 12_100_000 });
    const after = await (await col<any>(CFG.COLL.LEADS)).findOne({ _id: id });
    expect(after.stage).toBe('Booked');
    expect(Object.keys(after.milestones).sort()).toEqual(['booked', 'contacted', 'qualified', 'reserved', 'visitDone', 'visitScheduled']);
    const actions = (await (await col<any>(CFG.COLL.AUDIT_LOG)).find({}).toArray()).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['Consent Recorded', 'Quote Saved', 'Quote Approved', 'Booking Requested', 'Booking Approved']));

    // 10. the founder's report shows it, value split by kind
    const rep = (await as('Founder', 'getSalesReport', {})).data;
    expect(rep.funnel.find((f: any) => f.step === 'booked').reached).toBe(1);
    expect(rep.value.booked.amount).toBe(12_100_000);
    expect(rep.value.collected.amount).toBe(0);
  });

  it('two booking requests for one unit: only one can be approved', async () => {
    const mk = async (name: string, phone: string) => (await as('Meera', 'addLead', { data: { 'Prospect Name': name, 'Phone Number': phone, 'Assigned RM': 'Asha' } })).data.lead['Enquiry ID'];
    const a = await mk('Family A', '9876500021');
    const b = await mk('Family B', '9876500022');
    const unit = (await as('Meera', 'addInventoryUnit', { data: { unitId: 'T1-101', price: 9_000_000 } })).data.unit;
    const reqs = [];
    for (const lead of [a, b]) {
      await as('Asha', 'saveQuote', { leadId: lead, unitId: unit.inventoryId });
      await as('Asha', 'saveLeadPerson', { leadId: lead, person: { name: 'Payer ' + lead, roles: ['payer'] } });
      reqs.push((await as('Asha', 'requestBooking', { leadId: lead, unitId: unit.inventoryId })).data);
    }
    const [r1, r2] = await Promise.all(reqs.map((r) => as('Meera', 'decideBooking', { id: r._id, approve: true })));
    const ok = [r1, r2].filter((r) => r.status === 'success');
    expect(ok).toHaveLength(1);
    expect([r1, r2].find((r) => r.status !== 'success')!.code).toBe('CONFLICT');
    const stored = await (await col<any>(CFG.COLL.INVENTORY)).findOne({ _id: unit.inventoryId });
    expect(stored.status).toBe('Booked');
  });

  it('managers get exceptions and can reassign with a reason; agents cannot open the team view', async () => {
    const lead = (await as('Meera', 'addLead', { data: { 'Prospect Name': 'No owner', 'Phone Number': '9876500031' } })).data.lead['Enquiry ID'];
    const ex = (await as('Meera', 'getTeamExceptions')).data;
    expect(ex.unassigned.map((r: any) => r.leadId)).toContain(lead);
    expect(ex.workload.map((w: any) => w.name)).toEqual(expect.arrayContaining(['Asha', 'Ravi']));
    expect((await as('Asha', 'getTeamExceptions')).code).toBe('FORBIDDEN');
    expect((await as('Meera', 'reassignLeads', { leadIds: [lead], to: 'Ravi' })).code).toBe('VALIDATION');
    expect((await as('Meera', 'reassignLeads', { leadIds: [lead], to: 'Ravi', reason: 'Asha on leave' })).data.moved).toBe(1);
    expect((await as('Ravi', 'getAllLeads')).data.leads.map((l: any) => l['Enquiry ID'])).toContain(lead);
  });

  it('STOP words are recognised', () => {
    expect(isStopWord('STOP')).toBe(true);
    expect(isStopWord('Unsubscribe.')).toBe(true);
    expect(isStopWord('stop by on Sunday?')).toBe(false);
  });
});
