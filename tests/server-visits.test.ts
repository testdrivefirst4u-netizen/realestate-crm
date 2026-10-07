/** Online site-visit booking: settings, slot generation, capacity, new and existing leads. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} })); // no lead alerts here

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { updateSettings } from '../server/core/settings';
import { addLead, getLeadDoc } from '../server/modules/leads';
import { bookVisit, listSlots, parseVisitBooking, visitConfig } from '../server/modules/visits';
import type { Ctx } from '../server/core/auth';

const L = CFG.LEAD;
let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;
/** Monday 5 Oct 2026, 09:00 in Kolkata. */
const NOW = new Date('2026-10-05T03:30:00.000Z');

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

const enable = (patch: Record<string, unknown> = {}) =>
  updateSettings({ visitBooking: { enabled: true, days: [1, 2, 3, 4, 5], start: '10:00', end: '13:00', slotMinutes: 60, capacity: 1, horizonDays: 3, minNoticeHours: 2, location: 'Experience Centre', ...patch } }, admin);

describe('visit booking settings', () => {
  it('is off by default and validates hours', async () => {
    expect((await visitConfig()).enabled).toBe(false);
    await expect(updateSettings({ visitBooking: { start: '9am' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ visitBooking: { enabled: true, start: '10:00', end: '10:30', slotMinutes: 60 } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ visitBooking: { enabled: true, days: [] } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await enable();
    expect(s.visitBooking).toMatchObject({ enabled: true, start: '10:00', end: '13:00', capacity: 1, location: 'Experience Centre' });
  });
});

describe('slots', () => {
  it('lists open weekdays only, from the opening time, respecting notice', async () => {
    const days = await listSlots(parseVisitBooking({ enabled: true, days: [1, 2, 3, 4, 5], start: '10:00', end: '13:00', slotMinutes: 60, capacity: 2, horizonDays: 6, minNoticeHours: 2 }), NOW);
    // Mon 5 → Sat 10 / Sun 11 excluded; Monday 10:00 is within 2 h notice of 09:00, so Monday starts at 11:00
    expect(days.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(days[0].slots.map((s) => s.label)).toEqual(['11:00', '12:00']);
    expect(days[1].slots.map((s) => s.label)).toEqual(['10:00', '11:00', '12:00']);
    expect(days[1].slots.every((s) => s.left === 2)).toBe(true);
  });
});

describe('booking', () => {
  it('creates a lead with the visit scheduled and fills the slot', async () => {
    await enable();
    const slot = (await listSlots(await visitConfig(), NOW))[1].slots[0];
    const r = await bookVisit({ name: 'Meera Kapoor', phone: '+91 98765 43210', email: 'meera@example.com', at: slot.at, notes: 'Coming with parents' }, NOW);
    expect(r).toEqual({ at: slot.at, existing: false });
    const lead = (await getLeadDoc('ENQ-0001'))!;
    expect(lead).toMatchObject({ name: 'Meera Kapoor', siteVisitStatus: CFG.SITE_VISIT.SCHEDULED, source: 'Visit booking' });
    expect(lead.siteVisitDate!.toISOString()).toBe(slot.at);
    // capacity 1: the slot is now full
    const again = (await listSlots(await visitConfig(), NOW))[1].slots[0];
    expect(again.left).toBe(0);
    await expect(bookVisit({ name: 'Someone', phone: '9876500099', at: slot.at }, NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('schedules the visit on an existing lead with the same phone', async () => {
    await enable({ capacity: 3 });
    await addLead({ [L.NAME]: 'Rajiv Menon', [L.PHONE]: '9876500002' }, admin);
    const slot = (await listSlots(await visitConfig(), NOW))[2].slots[1];
    expect(await bookVisit({ name: 'Rajiv M', phone: '98765 00002', at: slot.at }, NOW)).toEqual({ at: slot.at, existing: true });
    const lead = (await getLeadDoc('ENQ-0001'))!;
    expect(lead.siteVisitStatus).toBe(CFG.SITE_VISIT.SCHEDULED);
    expect(lead.followups.at(-1)!.text).toMatch(/Site visit booked online/);
    expect(await getLeadDoc('ENQ-0002')).toBeNull();
  });

  it('rejects bad input, invented times and bookings when switched off', async () => {
    await expect(bookVisit({ name: 'X', phone: '98765', at: NOW.toISOString() }, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await enable();
    const slot = (await listSlots(await visitConfig(), NOW))[1].slots[0];
    await expect(bookVisit({ name: '', phone: '9876500003', at: slot.at }, NOW)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bookVisit({ name: 'Y', phone: '123', at: slot.at }, NOW)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bookVisit({ name: 'Y', phone: '9876500003', at: '2026-10-06T04:47:00.000Z' }, NOW)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
