/** Leads module (port of 10_Leads.gs): create, duplicates, remarks, stage rules, conflicts, archive, import, timeline, jobs. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { fmtSheet } from '../server/core/utils';
import { fromUiPatch, parseFollowup, formatFollowup, toUiLead } from '../server/core/leadShape';
import {
  addLead, appendRemark, archiveLead, findLeadByPhone, getAllLeads, getLead, getLeadsConfig, importLeads, timelineForLead, updateLead,
} from '../server/modules/leads';
import { runHourlyFollowups, runDaily } from '../server/modules/jobs';
import type { Ctx } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;
const L = CFG.LEAD;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
});

const sample = (over: Record<string, string> = {}) => ({
  [L.NAME]: 'Ravi Kumar', [L.PHONE]: '+91 98765 43210', [L.SOURCE]: 'Website', [L.UNIT_TYPE]: '2bhk', ...over,
});

describe('leadShape', () => {
  it('round-trips legacy follow-up text', () => {
    const f = parseFollowup(1, '2026-01-05 10:30 — called, interested');
    expect(f.text).toBe('called, interested');
    expect(f.raw).toBeUndefined();
    expect(formatFollowup(f)).toBe('2026-01-05 10:30 — called, interested');
    const odd = parseFollowup(2, 'just some old note');
    expect(odd.at).toBeNull();
    expect(formatFollowup(odd)).toBe('just some old note');
  });

  it('maps header keys to fields and keeps unknown keys in extra', () => {
    const p = fromUiPatch({ [L.NAME]: ' A ', [L.PHONE]: '098765-43210', [L.NEXT_FOLLOWUP]: '2026-02-01 09:00', 'Budget': '1.2 Cr', 'Follow-up 3': 'x' });
    expect(p.set.name).toBe('A');
    expect(p.set.phoneLast10).toBe('9876543210');
    expect(p.set.nextFollowupAt).toBeInstanceOf(Date);
    expect(p.extra).toEqual({ Budget: '1.2 Cr' });
    expect(p.followups).toEqual({ 3: 'x' });
  });
});

describe('leads', () => {
  it('adds a lead that appears in getAllLeads with header keys', async () => {
    const r = await addLead(sample({ Budget: '1 Cr' }), admin);
    expect(r.id).toBe('ENQ-0001');
    expect(r.lead[L.STAGE]).toBe('New');
    expect(r.lead[L.UNIT_TYPE]).toBe('2 BHK');
    expect(r.lead[L.UPDATED_BY]).toBe('Asha Admin');
    expect(r.lead[L.CREATED_AT]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(r.version).toBeTruthy();

    const all = await getAllLeads();
    expect(all.headers.slice(0, CFG.LEAD_BASE_HEADERS.length)).toEqual(CFG.LEAD_BASE_HEADERS);
    expect(all.headers).toContain('Follow-up 50');
    expect(all.headers).toContain('Budget');
    expect(all.leads).toHaveLength(1);
    const l = all.leads[0];
    for (const h of CFG.LEAD_BASE_HEADERS) expect(typeof l[h]).toBe('string');
    expect(l[L.ID]).toBe('ENQ-0001');
    expect(l.Budget).toBe('1 Cr');

    const doc = await (await col(CFG.COLL.LEADS)).findOne({ _id: 'ENQ-0001' as any });
    expect(doc!.phoneLast10).toBe('9876543210');
    expect(doc!.createdAt).toBeInstanceOf(Date);

    const ev = await (await col(CFG.COLL.EVENTS)).findOne({ type: 'lead_created' });
    expect(ev!.title).toBe('New enquiry: Ravi Kumar');
    const tl = await timelineForLead('ENQ-0001');
    expect(tl[0].type).toBe('lead_created');
    expect(await findLeadByPhone('9876543210')).toMatchObject({ [L.ID]: 'ENQ-0001' });
  });

  it('requires a name and rejects a duplicate phone', async () => {
    await expect(addLead({ [L.PHONE]: '1' }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await addLead(sample(), admin);
    await expect(addLead(sample({ [L.NAME]: 'Other', [L.PHONE]: '9876543210' }), admin)).rejects.toMatchObject({
      code: 'CONFLICT', details: { existingId: 'ENQ-0001' },
    });
    // returnExisting (Chat360 path)
    const r = await addLead(sample({ [L.NAME]: 'Other' }), null, { returnExisting: true, actor: 'Chat360' });
    expect(r.existing).toBe(true);
    expect(r.id).toBe('ENQ-0001');
  });

  it('appends sequential follow-ups in the legacy format and stamps Last Follow-up', async () => {
    const { id } = await addLead(sample(), admin);
    const r1 = await appendRemark(id, 'Called, interested', admin, '2026-12-01 10:00');
    expect(r1.index).toBe(1);
    expect(r1.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — Called, interested$/);
    expect(r1.value.slice(0, 16)).toBe(fmtSheet(r1.timestamp));
    expect(r1.lead['Follow-up 1']).toBe(r1.value);
    expect(r1.lead[L.LAST_FOLLOWUP]).toBe(r1.timestamp);
    expect(r1.lead[L.NEXT_FOLLOWUP]).toBeTruthy();
    const r2 = await appendRemark(id, 'Sent brochure', admin);
    expect(r2.index).toBe(2);
    expect(r2.lead['Follow-up 2']).toMatch(/ — Sent brochure$/);
    expect(r2.lead['Follow-up 1']).toBe(r1.value);
    await expect(appendRemark(id, '  ', admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const tl = await timelineForLead(id);
    expect(tl.filter((e) => e.type === 'remark_added').map((e) => e.title).sort()).toEqual(['Follow-up #1 logged', 'Follow-up #2 logged']);
  });

  it('stamps Booking Date when the stage becomes Booked, and site visit dates', async () => {
    const { id } = await addLead(sample(), admin);
    const r = await updateLead(id, { [L.STAGE]: 'Booked' }, admin);
    expect(r.lead[L.BOOKING_DATE]).toBeTruthy();
    expect(r.changes!.map((c) => c.field)).toEqual([L.STAGE]);
    const ev = await (await col(CFG.COLL.EVENTS)).findOne({ type: 'lead_booked' });
    expect(ev!.title).toBe('Unit booked: Ravi Kumar');

    const r2 = await updateLead(id, { [L.SITE_VISIT_STATUS]: 'Site Visit - Completed' }, admin);
    expect(r2.lead[L.SITE_VISIT_DATE]).toBeTruthy();
    // no-op update
    const r3 = await updateLead(id, { [L.STAGE]: 'Booked' }, admin);
    expect(r3.unchanged).toBe(true);
    // created already booked
    const b = await addLead(sample({ [L.PHONE]: '9000000001', [L.STAGE]: 'Booked' }), admin);
    expect(b.lead[L.BOOKING_DATE]).toBeTruthy();
  });

  it('rejects a stale expectedUpdatedAt with CONFLICT and the latest lead', async () => {
    const { id, lead } = await addLead(sample(), admin);
    const stale = new Date(Date.parse(lead[L.UPDATED_AT]) - 60000).toISOString();
    await updateLead(id, { [L.NOTES]: 'first' }, admin, lead[L.UPDATED_AT]);
    await (await col(CFG.COLL.LEADS)).updateOne({ _id: id as any }, { $set: { updatedAt: new Date(Date.now() + 5000) } });
    await expect(updateLead(id, { [L.NOTES]: 'second' }, admin, stale)).rejects.toMatchObject({ code: 'CONFLICT' });
    try {
      await updateLead(id, { [L.NOTES]: 'second' }, admin, lead[L.UPDATED_AT]);
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('CONFLICT');
      expect(e.details.lead[L.NOTES]).toBe('first');
    }
  });

  it('only leads.trash may move leads to the bin through updateLead', async () => {
    const rm = await t.ctx('RM');
    const { id } = await addLead(sample(), admin);
    await expect(updateLead(id, { [L.STAGE]: 'Trash' }, rm)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await updateLead(id, { [L.STAGE]: 'Trash' }, admin);
    // a trashed lead's phone may be re-used
    const again = await addLead(sample({ [L.NAME]: 'Again' }), admin);
    expect(again.id).toBe('ENQ-0002');
  });

  it('archives a lead (moved, not copied) and never reuses its id', async () => {
    await addLead(sample(), admin);
    const second = await addLead(sample({ [L.PHONE]: '9000000002' }), admin);
    expect(second.id).toBe('ENQ-0002');
    const r = await archiveLead('ENQ-0002', admin);
    expect(r.version).toBeTruthy();
    expect(await getLead('ENQ-0002')).toBeNull();
    const arch = await (await col(CFG.COLL.ARCHIVE)).findOne({ _id: 'ENQ-0002' as any });
    expect(arch!.archivedBy).toBe('Asha Admin');
    expect(arch!.archivedAt).toBeInstanceOf(Date);
    await expect(archiveLead('ENQ-0002', admin)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const next = await addLead(sample({ [L.PHONE]: '9000000003' }), admin);
    expect(next.id).toBe('ENQ-0003');
    // a client-supplied id of an issued (archived) number is not reused
    const sup = await addLead(sample({ [L.PHONE]: '9000000004', [L.ID]: 'ENQ-0002' }), admin);
    expect(sup.id).toBe('ENQ-0004');
    // a client-supplied id above the counter is kept and the counter follows it
    const ahead = await addLead(sample({ [L.PHONE]: '9000000005', [L.ID]: 'ENQ-0010' }), admin);
    expect(ahead.id).toBe('ENQ-0010');
    expect((await addLead(sample({ [L.PHONE]: '9000000006' }), admin)).id).toBe('ENQ-0011');
  });

  it('imports with SKIP / OVERWRITE / CREATE_COPY', async () => {
    await addLead(sample(), admin); // ENQ-0001, phone 9876543210
    const rows = [
      { [L.NAME]: 'Ravi K', [L.PHONE]: '9876543210', [L.NOTES]: 'from csv' },
      { [L.NAME]: 'Meera', [L.PHONE]: '9111111111', [L.STAGE]: 'Hot', 'Follow-up 1': '2025-05-01 09:00 — met at expo' },
      { [L.NAME]: 'Meera dup', [L.PHONE]: '9111111111' },
    ];
    const skip = await importLeads(rows, 'SKIP', admin);
    expect(skip).toMatchObject({ created: 1, updated: 0, skipped: 2 });
    const meera = (await getAllLeads()).leads.find((l) => l[L.NAME] === 'Meera')!;
    expect(meera[L.ID]).toBe('ENQ-0002');
    expect(meera['Follow-up 1']).toBe('2025-05-01 09:00 — met at expo');

    const over = await importLeads([{ [L.ID]: 'ENQ-0001', [L.NAME]: '', [L.NOTES]: 'overwritten', [L.STAGE]: 'Booked' }], 'OVERWRITE', admin);
    expect(over).toMatchObject({ created: 0, updated: 1 });
    const l1 = (await getLead('ENQ-0001'))!;
    expect(l1[L.NOTES]).toBe('overwritten');
    expect(l1[L.NAME]).toBe('Ravi Kumar'); // empty cells never overwrite
    expect(l1[L.BOOKING_DATE]).toBeTruthy();

    const copy = await importLeads([{ [L.ID]: 'ENQ-0001', [L.NAME]: 'Ravi copy', [L.PHONE]: '9876543210' }], 'CREATE_COPY', admin);
    expect(copy).toMatchObject({ created: 1 });
    expect((await getAllLeads()).leads.filter((l) => l[L.PHONE].endsWith('43210'))).toHaveLength(2);
    expect(await getLead('ENQ-0003')).toMatchObject({ [L.NAME]: 'Ravi copy' });

    await expect(importLeads([{ [L.PHONE]: '9222222222' }], 'SKIP', admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(importLeads(new Array(20001).fill({ [L.NAME]: 'x' }), 'SKIP', admin)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('imports thousands of rows in batches', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ [L.NAME]: 'Bulk ' + i, [L.PHONE]: String(9300000000 + i) }));
    const r = await importLeads(rows, 'SKIP', admin);
    expect(r.created).toBe(1500);
    const all = await getAllLeads();
    expect(new Set(all.leads.map((l) => l[L.ID])).size).toBe(1500);
    expect(all.leads.map((l) => l[L.ID])).toContain('ENQ-1500');
    expect(await (await col(CFG.COLL.EVENTS)).countDocuments({ type: 'leads_imported' })).toBe(1);
  });

  it('builds dropdown config with defaults, unit-type dedupe and users as RMs', async () => {
    await (await col(CFG.COLL.CONFIG)).insertMany([{ field: 'Unit Type Interested In', option: '2BHK' }, { field: 'Enquiry Source', option: 'Hoarding' }]);
    const c = await getLeadsConfig();
    expect(c.fields).toEqual(CFG.DROPDOWNS);
    expect(c.options['Enquiry Source'][0]).toBe('Hoarding');
    expect(c.options['Unit Type Interested In'].filter((u) => u === '2 BHK')).toHaveLength(1);
    expect(c.options['Assigned RM']).toContain('Asha Admin');
  });

  it('synthesizes timeline entries for legacy follow-ups', async () => {
    await (await col(CFG.COLL.LEADS)).insertOne({
      _id: 'ENQ-0100', name: 'Legacy', phone: '', phoneLast10: '', stage: 'Open', createdAt: new Date('2024-01-01T00:00:00Z'),
      followups: [parseFollowup(1, '2024-02-01 10:00 — old remark')], extra: {},
    } as any);
    const tl = await timelineForLead('ENQ-0100');
    expect(tl.map((e) => e.id)).toEqual(['legacy_fu_1', 'legacy_created']);
    expect(tl[0].details).toBe('old remark');
    expect(toUiLead((await (await col(CFG.COLL.LEADS)).findOne({ _id: 'ENQ-0100' as any })) as any)!['Follow-up 1']).toBe('2024-02-01 10:00 — old remark');
  });
});

describe('jobs', () => {
  it('creates one overdue event per lead per day', async () => {
    const past = new Date(Date.now() - 3600e3).toISOString();
    const a = await addLead(sample({ [L.NEXT_FOLLOWUP]: past }), admin);
    await addLead(sample({ [L.PHONE]: '9000000010', [L.NEXT_FOLLOWUP]: past, [L.STAGE]: 'Booked' }), admin);
    await addLead(sample({ [L.PHONE]: '9000000011', [L.NEXT_FOLLOWUP]: past, [L.STAGE]: 'Disqualified - Budget' }), admin);
    await addLead(sample({ [L.PHONE]: '9000000012', [L.NEXT_FOLLOWUP]: new Date(Date.now() + 3600e3).toISOString() }), admin);
    expect(await runHourlyFollowups()).toEqual({ notified: 1 });
    expect(await runHourlyFollowups()).toEqual({ notified: 0 });
    const evs = await (await col(CFG.COLL.EVENTS)).find({ type: 'followup_overdue' }).toArray();
    expect(evs).toHaveLength(1);
    expect(evs[0].recordId).toBe(a.id);
    expect(evs[0].title).toBe('Follow-up overdue: Ravi Kumar');
    expect(evs[0].key).toMatch(new RegExp(`^followup_overdue:${a.id}:\\d{4}-\\d{2}-\\d{2}$`));
  });

  it('daily job runs housekeeping and skips the digest without SMTP', async () => {
    expect(await runDaily()).toEqual({ ok: true, digestSent: false });
  });
});
