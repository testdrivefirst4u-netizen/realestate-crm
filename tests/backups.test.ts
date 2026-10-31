import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { blankLeadDoc } from '../server/core/leadShape';
import { createLeadBackup, getLeadBackup, KEEP_DAYS, listLeadBackups } from '../server/modules/backups';

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

describe('daily lead backups', () => {
  it('saves every lead compressed and gives them back exactly (dates, remarks, extra columns)', async () => {
    await t.db.collection('leads').insertMany([
      { ...blankLeadDoc('ENQ-0001'), name: 'Asha', phone: '919676847969', enquiryDate: new Date('2026-08-06T00:00:00Z'), followups: [{ n: 1, at: new Date('2026-10-01T04:30:00Z'), text: 'Called', by: 'R' }], extra: { City: 'Hyderabad' } },
      { ...blankLeadDoc('ENQ-0002'), name: 'Ravi', phone: '9000012345' },
    ] as any[]);
    const b = await createLeadBackup({ by: 'Tester', now: new Date('2026-10-17T10:00:00Z') });
    expect(b).toMatchObject({ id: '2026-10-17', count: 2, createdBy: 'Tester' });
    const r = await getLeadBackup('2026-10-17', null);
    expect(r.leads).toHaveLength(2);
    const asha = r.leads.find((l) => l['Enquiry ID'] === 'ENQ-0001')!;
    expect(asha['Phone Number']).toBe('919676847969');
    expect(asha.City).toBe('Hyderabad');
    expect(String(asha['Follow-up 1'])).toContain('Called');
    expect(String(asha['Enquiry Date'])).toMatch(/2026/);
  });

  it('the daily job skips a day that already has a backup; only the newest 14 days are kept', async () => {
    await t.db.collection('leads').insertOne({ ...blankLeadDoc('ENQ-0001'), name: 'A' } as any);
    expect(await createLeadBackup({ now: new Date('2026-10-01T10:00:00Z') })).not.toBeNull();
    expect(await createLeadBackup({ onlyIfMissing: true, now: new Date('2026-10-01T11:00:00Z') })).toBeNull();
    for (let d = 2; d <= 20; d++) await createLeadBackup({ now: new Date(`2026-10-${String(d).padStart(2, '0')}T10:00:00Z`) });
    const list = await listLeadBackups();
    expect(list).toHaveLength(KEEP_DAYS);
    expect(list[0].id).toBe('2026-10-20');
    expect(list[list.length - 1].id).toBe('2026-10-07');
    await expect(getLeadBackup('2026-10-01', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
