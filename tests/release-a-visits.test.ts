/** Release A, finding 5 — visit capacity is reserved atomically; bookings are idempotent; cancel / reschedule give places back. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { updateSettings } from '../server/core/settings';
import { bookingsCol, bookVisit, cancelVisitBooking, listSlots, rescheduleVisitBooking, visitConfig } from '../server/modules/visits';
import type { Ctx } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;
const NOW = new Date('2026-10-05T03:30:00.000Z'); // Monday 09:00 IST

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
  await updateSettings({ visitBooking: { enabled: true, days: [1, 2, 3, 4, 5], start: '10:00', end: '13:00', slotMinutes: 60, capacity: 3, horizonDays: 3, minNoticeHours: 2 } }, admin);
});

const firstSlot = async () => (await listSlots(await visitConfig(), NOW))[0].slots[0];
const person = (i: number) => ({ name: `Family ${i}`, phone: `98444${String(10000 + i)}` });

describe('finding 5: visit capacity', () => {
  it('fifteen simultaneous bookings of a 3-place slot: exactly 3 succeed, the rest are told it is full', async () => {
    const slot = await firstSlot();
    const results = await Promise.allSettled(Array.from({ length: 15 }, (_, i) => bookVisit({ ...person(i), at: slot.at }, NOW)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const full = results.filter((r) => r.status === 'rejected' && (r.reason as any)?.code === 'CONFLICT');
    expect(ok).toHaveLength(3);
    expect(full).toHaveLength(12);
    const scheduled = await (await col<any>(CFG.COLL.LEADS)).countDocuments({ siteVisitStatus: CFG.SITE_VISIT.SCHEDULED, siteVisitDate: new Date(slot.at) });
    expect(scheduled).toBe(3);
    expect((await firstSlot()).left).toBe(0); // shown as full (the booking page hides it)
  });

  it('the same submission twice (request id) books once', async () => {
    const slot = await firstSlot();
    const [a, b] = await Promise.all([bookVisit({ ...person(1), at: slot.at, requestId: 'r-1' }, NOW), bookVisit({ ...person(1), at: slot.at, requestId: 'r-1' }, NOW)]);
    expect(a.bookingId).toBe(b.bookingId);
    expect(await (await col<any>(CFG.COLL.LEADS)).countDocuments({})).toBe(1);
    const all = await listSlots(await visitConfig(), NOW);
    expect(all[0].slots.find((s) => s.at === slot.at)?.left).toBe(2);
  });

  it('cancelling gives the place back once; rescheduling takes the new place before releasing the old', async () => {
    const slot = await firstSlot();
    const r = await bookVisit({ ...person(2), at: slot.at }, NOW);
    const leftAfter = async (at: string) => (await listSlots(await visitConfig(), NOW)).flatMap((d) => d.slots).find((s) => s.at === at)?.left;
    expect(await leftAfter(slot.at)).toBe(2);

    const later = (await listSlots(await visitConfig(), NOW))[0].slots[1];
    const moved = await rescheduleVisitBooking(r.bookingId!, later.at, admin, NOW);
    expect(await leftAfter(slot.at)).toBe(3);
    expect(await leftAfter(later.at)).toBe(2);
    const lead = await (await col<any>(CFG.COLL.LEADS)).findOne({});
    expect(lead.siteVisitDate.toISOString()).toBe(later.at);
    expect((await (await bookingsCol()).findOne({ _id: r.bookingId! }))?.status).toBe('rescheduled');

    await cancelVisitBooking(moved._id, 'Family travelling', admin);
    await cancelVisitBooking(moved._id, 'again', admin); // no double release
    expect(await leftAfter(later.at)).toBe(3);
    expect((await (await col<any>(CFG.COLL.LEADS)).findOne({})).siteVisitStatus).toBe(CFG.SITE_VISIT.PROSPECT);
  });

  it('visits scheduled before slot counters existed still count against capacity', async () => {
    const slot = await firstSlot();
    await (await col<any>(CFG.COLL.LEADS)).insertMany([0, 1, 2].map((i) => ({ _id: `ENQ-80${i}`, name: 'Old', siteVisitStatus: CFG.SITE_VISIT.SCHEDULED, siteVisitDate: new Date(slot.at) })) as any);
    await expect(bookVisit({ ...person(9), at: slot.at }, NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
