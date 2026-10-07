/** Follow-up sequences: scheduling rules, new leads, logged follow-ups, settings and the "no activity" sweep. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} })); // no lead alerts here

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { getSettings, updateSettings } from '../server/core/settings';
import { addLead, appendRemark, getLeadDoc } from '../server/modules/leads';
import { markStaleLeads } from '../server/modules/jobs';
import { firstFollowup, nextFollowup, parseSequence, SEQUENCE_DEFAULTS } from '../server/modules/sequences';
import type { Ctx } from '../server/core/auth';

const L = CFG.LEAD;
const S = CFG.STAGES;
const DAY = 86_400_000;
let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;

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

describe('sequence rules', () => {
  const seq = parseSequence(undefined);
  const enquiry = new Date('2026-10-05T06:00:00.000Z');
  const now = new Date('2026-10-05T07:00:00.000Z');

  it('defaults to day 1, 3 and 7 and cleans input', () => {
    expect(seq).toEqual(SEQUENCE_DEFAULTS);
    expect(parseSequence({ days: '7, 1, x, 3, 3', hour: 30 })).toMatchObject({ days: [1, 3, 7], hour: SEQUENCE_DEFAULTS.hour });
  });

  it('schedules day 1 for a new open lead, nothing for closed stages or a lead with a date', () => {
    const first = firstFollowup(seq, { stage: S.NEW, enquiryDate: enquiry }, now)!;
    expect(first.getTime() - now.getTime()).toBeGreaterThan(12 * 3_600_000);
    expect(first.getTime() - now.getTime()).toBeLessThan(2 * DAY);
    expect(firstFollowup(seq, { stage: S.BOOKED, enquiryDate: enquiry }, now)).toBeNull();
    expect(firstFollowup(seq, { stage: S.NEW, enquiryDate: enquiry, nextFollowupAt: now }, now)).toBeNull();
    expect(firstFollowup({ ...seq, enabled: false }, { stage: S.NEW, enquiryDate: enquiry }, now)).toBeNull();
  });

  it('steps through day 3 and 7, then stops; a passed step moves to the next day', () => {
    const after1 = nextFollowup(seq, { stage: S.OPEN, enquiryDate: enquiry }, 1, now)!;
    const after2 = nextFollowup(seq, { stage: S.OPEN, enquiryDate: enquiry }, 2, now)!;
    expect(Math.round((after2.getTime() - after1.getTime()) / DAY)).toBe(4);
    expect(nextFollowup(seq, { stage: S.OPEN, enquiryDate: enquiry }, 3, now)).toBeNull();
    const late = new Date(enquiry.getTime() + 20 * DAY);
    const catchUp = nextFollowup(seq, { stage: S.OPEN, enquiryDate: enquiry }, 1, late)!;
    expect(catchUp.getTime()).toBeGreaterThan(late.getTime());
    expect(catchUp.getTime() - late.getTime()).toBeLessThan(2 * DAY);
  });
});

describe('sequence in the CRM', () => {
  it('a new lead gets its first follow-up; logging follow-ups schedules the next steps', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera', [L.PHONE]: '9876500001' }, admin);
    const d0 = await getLeadDoc(lead[L.ID]);
    expect(d0!.nextFollowupAt).toBeInstanceOf(Date);
    await appendRemark(lead[L.ID], 'Called, asked for brochure', admin);
    const d1 = await getLeadDoc(lead[L.ID]);
    expect(d1!.nextFollowupAt!.getTime()).toBeGreaterThan(d0!.nextFollowupAt!.getTime());
    // an explicit date always wins
    const mine = new Date(Date.now() + 10 * DAY).toISOString();
    await appendRemark(lead[L.ID], 'Will visit next week', admin, mine);
    expect((await getLeadDoc(lead[L.ID]))!.nextFollowupAt!.toISOString()).toBe(mine);
  });

  it('can be switched off, and validates its settings', async () => {
    await expect(updateSettings({ followupSequence: { days: 'soon' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await updateSettings({ followupSequence: { enabled: false, days: '2, 5', autoNotRespondingDays: 14 } }, admin);
    expect(s.followupSequence).toMatchObject({ enabled: false, days: [2, 5], autoNotRespondingDays: 14 });
    expect((await getSettings(admin)).followupSequence.enabled).toBe(false);
    const { lead } = await addLead({ [L.NAME]: 'Rajiv', [L.PHONE]: '9876500002' }, admin);
    expect((await getLeadDoc(lead[L.ID]))!.nextFollowupAt).toBeNull();
  });

  it('moves New/Open/Warm leads without activity to Not Responding only when enabled', async () => {
    const { lead: idle } = await addLead({ [L.NAME]: 'Idle', [L.PHONE]: '9876500003', [L.STAGE]: S.WARM }, admin);
    const { lead: hot } = await addLead({ [L.NAME]: 'Hot one', [L.PHONE]: '9876500004', [L.STAGE]: S.HOT }, admin);
    const old = new Date(Date.now() - 20 * DAY);
    await (await col(CFG.COLL.LEADS)).updateMany({}, { $set: { updatedAt: old } });
    expect(await markStaleLeads()).toBe(0); // off by default
    await updateSettings({ followupSequence: { days: '1,3,7', autoNotRespondingDays: 14 } }, admin);
    await (await col(CFG.COLL.LEADS)).updateMany({}, { $set: { updatedAt: old } });
    expect(await markStaleLeads()).toBe(1);
    expect((await getLeadDoc(idle[L.ID]))!.stage).toBe(S.NOT_RESPONDING);
    expect((await getLeadDoc(hot[L.ID]))!.stage).toBe(S.HOT);
  });
});
