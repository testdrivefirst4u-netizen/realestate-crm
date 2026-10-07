/**
 * Online site-visit booking (company setting `visitBooking`, Settings › Visit booking; public page /book/<slug>).
 *
 * Slots: every enabled weekday from `start` to `end` in `slotMinutes` steps, `minNoticeHours` from now up to
 * `horizonDays` ahead; each slot takes `capacity` visits (counted from leads whose Site Visit is Scheduled at
 * that time). Booking creates a lead (source "Visit booking") with the visit scheduled — or, for a phone number
 * already in the CRM, schedules the visit on that lead and logs a follow-up — so lead alerts and the follow-up
 * sequence apply as usual.
 */
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import type { LeadDoc } from '../core/leadShape';
import { settingsAll } from '../core/settings';
import { dateKey, digits, makeZoned, safeJsonParse, truncate } from '../core/utils';
import { addLead, appendRemark, findLeadByPhone, updateLead } from './leads';

const L = CFG.LEAD;
const SCHEDULED = CFG.SITE_VISIT.SCHEDULED;

export interface VisitBooking {
  enabled: boolean;
  /** Weekdays open for visits, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Opening and closing time, "HH:MM" local. The last slot starts `slotMinutes` before `end`. */
  start: string;
  end: string;
  slotMinutes: number;
  /** Visits that can be hosted in the same slot. */
  capacity: number;
  /** How far ahead visitors can book. */
  horizonDays: number;
  /** Earliest booking from now. */
  minNoticeHours: number;
  /** Shown on the booking page: where to come and anything to bring. */
  location: string;
  instructions: string;
}

export const VISIT_DEFAULTS: VisitBooking = {
  enabled: false, days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '18:00', slotMinutes: 60, capacity: 2,
  horizonDays: 14, minNoticeHours: 2, location: '', instructions: '',
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};

export function parseVisitBooking(raw: unknown): VisitBooking {
  const o = (typeof raw === 'string' ? safeJsonParse<Record<string, unknown>>(raw, {}) : raw) as Record<string, any> | null;
  if (!o || typeof o !== 'object') return { ...VISIT_DEFAULTS, days: [...VISIT_DEFAULTS.days] };
  const days = (Array.isArray(o.days) ? o.days : VISIT_DEFAULTS.days).map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
  const start = HHMM.test(String(o.start)) ? String(o.start) : VISIT_DEFAULTS.start;
  const end = HHMM.test(String(o.end)) ? String(o.end) : VISIT_DEFAULTS.end;
  return {
    enabled: o.enabled === true || o.enabled === 'true',
    days: [...new Set<number>(days)].sort(),
    start,
    end: toMin(end) > toMin(start) ? end : VISIT_DEFAULTS.end,
    slotMinutes: clampInt(o.slotMinutes, 15, 240, VISIT_DEFAULTS.slotMinutes),
    capacity: clampInt(o.capacity, 1, 50, VISIT_DEFAULTS.capacity),
    horizonDays: clampInt(o.horizonDays, 1, 60, VISIT_DEFAULTS.horizonDays),
    minNoticeHours: clampInt(o.minNoticeHours, 0, 72, VISIT_DEFAULTS.minNoticeHours),
    location: truncate(String(o.location ?? '').trim(), 300),
    instructions: truncate(String(o.instructions ?? '').trim(), 600),
  };
}

export function validateVisitBooking(raw: unknown): string {
  const o = (typeof raw === 'string' ? safeJsonParse<Record<string, unknown>>(raw, {}) : raw) as Record<string, any> | null;
  if (!o || typeof o !== 'object') throw fail('VALIDATION', 'Invalid visit booking settings');
  if (o.start !== undefined && !HHMM.test(String(o.start))) throw fail('VALIDATION', 'Opening time must be HH:MM, e.g. 10:00');
  if (o.end !== undefined && !HHMM.test(String(o.end))) throw fail('VALIDATION', 'Closing time must be HH:MM, e.g. 18:00');
  const v = parseVisitBooking(o);
  if (toMin(v.end) - toMin(v.start) < v.slotMinutes) throw fail('VALIDATION', 'Opening hours must fit at least one visit slot');
  if (v.enabled && !v.days.length) throw fail('VALIDATION', 'Choose at least one day for visits');
  if (/[<>]/.test(v.location + v.instructions)) throw fail('VALIDATION', 'Text cannot contain < or >');
  return JSON.stringify(v);
}

export interface SlotDay {
  date: string; // yyyy-mm-dd (local)
  slots: Array<{ at: string; label: string; left: number }>;
}

/** Bookable slots (with places left), grouped by day. */
export async function listSlots(cfg: VisitBooking, now = new Date()): Promise<SlotDay[]> {
  const earliest = now.getTime() + cfg.minNoticeHours * 3_600_000;
  const out: SlotDay[] = [];
  const all: Date[] = [];
  const [y, m, d] = dateKey(now).split('-').map(Number);
  for (let i = 0; i <= cfg.horizonDays; i++) {
    const dayStart = makeZoned(y, m, d + i); // makeZoned normalises day overflow through Date.UTC
    const key = dateKey(new Date(dayStart.getTime() + 12 * 3_600_000));
    const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (!cfg.days.includes(weekday)) continue;
    const [ky, km, kd] = key.split('-').map(Number);
    const slots: Date[] = [];
    for (let t = toMin(cfg.start); t + cfg.slotMinutes <= toMin(cfg.end); t += cfg.slotMinutes) {
      const at = makeZoned(ky, km, kd, Math.floor(t / 60), t % 60);
      if (at.getTime() >= earliest) slots.push(at);
    }
    if (slots.length) {
      out.push({ date: key, slots: slots.map((at) => ({ at: at.toISOString(), label: '', left: cfg.capacity })) });
      all.push(...slots);
    }
  }
  if (!all.length) return out;
  const booked = await (await col<LeadDoc>(CFG.COLL.LEADS))
    .aggregate<{ _id: Date; n: number }>([
      { $match: { siteVisitStatus: SCHEDULED, siteVisitDate: { $gte: all[0], $lte: all[all.length - 1] } } },
      { $group: { _id: '$siteVisitDate', n: { $sum: 1 } } },
    ])
    .toArray();
  const used = new Map(booked.map((b) => [new Date(b._id).toISOString(), b.n]));
  for (const day of out) {
    for (const s of day.slots) {
      s.left = Math.max(0, cfg.capacity - (used.get(s.at) || 0));
      const local = new Date(s.at);
      s.label = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CFG.TIME_ZONE }).format(local);
    }
  }
  return out;
}

export async function visitConfig(): Promise<VisitBooking> {
  return parseVisitBooking((await settingsAll()).visitBooking);
}

export interface BookingInput {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  at?: unknown;
  unit?: unknown;
  notes?: unknown;
}

/** Book a visit (public). Returns the slot booked; never reveals lead data. */
export async function bookVisit(input: BookingInput, now = new Date()): Promise<{ at: string; existing: boolean }> {
  const cfg = await visitConfig();
  if (!cfg.enabled) throw fail('NOT_FOUND', 'Online visit booking is not available');
  const name = truncate(String(input.name ?? '').trim(), 120);
  const phone = truncate(String(input.phone ?? '').trim(), 40);
  const email = truncate(String(input.email ?? '').trim().toLowerCase(), 200);
  if (!name) throw fail('VALIDATION', 'Please enter your name');
  const dc = digits(phone).length;
  if (dc < 7 || dc > 15) throw fail('VALIDATION', 'Please enter a valid phone number');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail('VALIDATION', 'Please enter a valid e-mail address');
  const at = new Date(String(input.at ?? ''));
  if (Number.isNaN(at.getTime())) throw fail('VALIDATION', 'Please choose a time');

  const slot = (await listSlots(cfg, now)).flatMap((d) => d.slots).find((s) => s.at === at.toISOString());
  if (!slot) throw fail('VALIDATION', 'That time is not available — please choose another');
  if (slot.left <= 0) throw fail('CONFLICT', 'That time has just been booked — please choose another');

  const unit = truncate(String(input.unit ?? '').trim(), 80);
  const notes = truncate(String(input.notes ?? '').trim(), 500);
  const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CFG.TIME_ZONE }).format(at);

  const existing = await findLeadByPhone(phone);
  if (existing && existing[L.STAGE] !== CFG.STAGES.TRASH) {
    await updateLead(existing[L.ID], { [L.SITE_VISIT_STATUS]: SCHEDULED, [L.SITE_VISIT_DATE]: at.toISOString() }, null);
    await appendRemark(existing[L.ID], `Site visit booked online for ${when}${notes ? ` — ${notes}` : ''}`, null, at.toISOString(), 'Visit booking');
    return { at: at.toISOString(), existing: true };
  }
  await addLead(
    {
      [L.NAME]: name, [L.PHONE]: phone, ...(email ? { [L.EMAIL]: email } : {}), ...(unit ? { [L.UNIT_TYPE]: unit } : {}),
      [L.SOURCE]: 'Visit booking', [L.SITE_VISIT_STATUS]: SCHEDULED, [L.SITE_VISIT_DATE]: at.toISOString(),
      [L.NEXT_FOLLOWUP]: at.toISOString(),
      [L.NOTES]: `Booked a site visit online for ${when}.${notes ? ` ${notes}` : ''}`,
    } as any,
    null,
    { actor: 'Visit booking', allowDuplicate: true, eventSource: 'visit_booking' }
  );
  return { at: at.toISOString(), existing: false };
}
