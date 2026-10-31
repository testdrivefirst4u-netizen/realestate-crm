import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { blankLeadDoc, type LeadDoc } from '../server/core/leadShape';
import { mergeDocs, mergeLeads } from '../server/modules/leadMerge';
import { findDuplicateGroups } from '../src/modules/leads/DuplicatesModal';

const d = (s: string) => new Date(s);
function doc(id: string, patch: Partial<LeadDoc>): LeadDoc {
  return { ...blankLeadDoc(id), createdAt: d('2026-10-01T10:00:00Z'), updatedAt: d('2026-10-01T10:00:00Z'), ...patch } as LeadDoc;
}

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

describe('merging duplicate leads', () => {
  it('keeps the kept values, fills gaps, combines remarks in date order and takes the earliest enquiry', () => {
    const keep = doc('ENQ-0007', { name: 'Sharath', phone: '9676847969', phoneLast10: '9676847969', stage: 'Warm', source: 'Website/Whatsapp', notes: 'Wants 2BHK',
      enquiryDate: d('2026-08-08T00:00:00Z'), followups: [{ n: 1, at: d('2026-10-03T10:00:00Z'), text: 'Site visit Sunday', by: 'A' }] });
    const other = doc('ENQ-0006', { name: 'Unknown', phone: '919676847969', phoneLast10: '9676847969', stage: 'Open', email: 'sharath@example.com', assignedRm: 'Rahul Macharla',
      notes: 'Wants 2BHK\nLives in LB Nagar', enquiryDate: d('2026-08-07T00:00:00Z'), extra: { City: 'Hyderabad' },
      followups: [{ n: 1, at: d('2026-10-01T09:00:00Z'), text: 'Called, busy', by: 'B' }, { n: 2, at: d('2026-10-03T10:00:00Z'), text: 'Site visit Sunday', by: 'A' }] });
    const m = mergeDocs(keep, [other], 'Tester', d('2026-10-17T00:00:00Z'));
    expect(m).toMatchObject({ _id: 'ENQ-0007', name: 'Sharath', stage: 'Warm', source: 'Website/Whatsapp', email: 'sharath@example.com', assignedRm: 'Rahul Macharla', updatedBy: 'Tester' });
    expect(m.enquiryDate).toEqual(d('2026-08-07T00:00:00Z'));
    expect(m.extra.City).toBe('Hyderabad');
    expect(m.notes).toBe('Wants 2BHK\nLives in LB Nagar');
    expect(m.followups.map((f) => [f.n, f.text])).toEqual([[1, 'Called, busy'], [2, 'Site visit Sunday']]); // same remark once
  });

  it('merges on the server: archives the others and moves their calls and chats', async () => {
    const leads = t.db.collection('leads');
    await leads.insertMany([
      doc('ENQ-0001', { name: 'Asha', phone: '9876501234', phoneLast10: '9876501234', stage: 'Qualified' }),
      doc('ENQ-0002', { name: 'Asha R', phone: '+91 98765 01234', phoneLast10: '9876501234', email: 'asha@example.com' }),
      doc('ENQ-0003', { name: 'Ravi', phone: '9000012345', phoneLast10: '9000012345' }),
    ] as any[]);
    await t.db.collection('calls').insertOne({ _id: 'CALL-1' as any, leadId: 'ENQ-0002' });
    await t.db.collection('waMessages').insertOne({ _id: 'WA-1' as any, leadId: 'ENQ-0002' });

    const r = await mergeLeads('ENQ-0001', ['ENQ-0002'], null);
    expect(r).toMatchObject({ id: 'ENQ-0001', merged: ['ENQ-0002'] });
    expect(await leads.countDocuments()).toBe(2);
    expect(await leads.findOne({ _id: 'ENQ-0001' as any })).toMatchObject({ email: 'asha@example.com', stage: 'Qualified' });
    expect(await t.db.collection('archivedLeads').findOne({ _id: 'ENQ-0002' as any })).toMatchObject({ mergedInto: 'ENQ-0001' });
    expect(await t.db.collection('calls').findOne({ _id: 'CALL-1' as any })).toMatchObject({ leadId: 'ENQ-0001' });
    expect(await t.db.collection('waMessages').findOne({ _id: 'WA-1' as any })).toMatchObject({ leadId: 'ENQ-0001' });

    // different people are refused
    await expect(mergeLeads('ENQ-0001', ['ENQ-0003'], null)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await leads.countDocuments()).toBe(2);
  });

  it('finds groups by phone (last 10 digits), or by e-mail when there is no phone, ignoring trashed leads', () => {
    const L = (id: string, phone: string, extra: Record<string, string> = {}) => ({ 'Enquiry ID': id, 'Prospect Name': id, 'Phone Number': phone, 'Lead Stage': 'New', ...extra }) as any;
    const groups = findDuplicateGroups([
      L('A', '9876501234'), L('B', '+91 98765-01234', { 'Lead Stage': 'Qualified' }), L('C', '9000012345'),
      L('D', '', { Email: 'x@y.com' }), L('E', 'N/A', { Email: 'X@y.com' }), L('F', '9000012345', { 'Lead Stage': 'Trash' }),
    ]);
    expect(groups.map((g) => [g.by, g.leads.map((l) => l['Enquiry ID'])])).toEqual([['phone', ['B', 'A']], ['email', ['D', 'E']]]);
  });
});
