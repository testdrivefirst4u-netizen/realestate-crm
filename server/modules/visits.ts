/**
 * Online site-visit booking (company setting `visitBooking`, Settings › Visit booking; public page /book/<slug>).
 *
 * Slots: every enabled weekday from `start` to `end` in `slotMinutes` steps, `minNoticeHours` from now up to
 * `horizonDays` ahead; each slot takes `capacity` visits (counted from leads whose Site Visit is Scheduled at
 * that time). Booking creates a lead (source "Visit booking") with the visit scheduled — or, for a phone number
 * already in the CRM, schedules the visit on that lead and logs a follow-up — so lead alerts and the follow-up
 * sequence apply as usual.
 *
 * Capacity is reserved atomically (finding 5): each slot has a counter document in `visitSlots`; a booking takes a
 * place with one conditional increment (`booked < capacity`), so simultaneous bookings can never exceed the
 * capacity. Each booking is a `visitBookings` record (booked / cancelled / rescheduled) and a repeated submission
 * with the same request id returns the first booking. Cancelling or rescheduling gives the place back.
 */
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import type { LeadDoc } from '../core/leadShape';
import { settingsAll } from '../core/settings';
import { dateKey, digits, makeZoned, safeJsonParse, truncate } from '../core/utils';
import { SYSTEM_CTX } from '../core/auth';
import { addLead, appendRemark, findLeadByPhone } from './leads';
import { addTask } from './tasks';
import { shortId } from '../core/utils';
import { tenantKey } from '../core/tenant';
import { auditLog, type Ctx } from '../core/auth';

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
  // reserved places (the authoritative count once a slot has been booked online)
  for (const sd of await (await slotsCol()).find({ _id: { $in: all.map((d) => d.toISOString()) } }).toArray()) {
    used.set(sd._id, Math.max(used.get(sd._id) || 0, sd.booked));
  }
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
  /** Idempotency: the same request id again returns the first booking. */
  requestId?: unknown;
}

/* ------------------------------ slot capacity ------------------------------ */

interface SlotDoc { _id: string; at: Date; booked: number; updatedAt: Date }
export interface VisitBookingDoc {
  _id: string; // VB_…
  requestId: string;
  at: Date;
  status: 'booked' | 'cancelled' | 'rescheduled';
  leadId: string;
  name: string;
  phoneLast10: string;
  mode: 'onsite' | 'virtual';
  createdAt: Date;
  updatedAt: Date;
  rescheduledTo?: string;
  cancelReason?: string;
}
const slotsCol = () => col<SlotDoc>('visitSlots');
export const bookingsCol = () => col<VisitBookingDoc>('visitBookings');
const bookingIndex = new Map<string, Promise<unknown>>();
async function ensureBookingIndex() {
  const k = tenantKey();
  if (!bookingIndex.has(k)) bookingIndex.set(k, bookingsCol().then((c) => c.createIndex({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string', $gt: '' } } })).catch((e) => { bookingIndex.delete(k); console.error('[visits] index', e?.message); }));
  await bookingIndex.get(k);
}

/** Take one place in the slot, or false when it is full. Atomic across server instances. */
export async function reserveSlot(at: Date, capacity: number): Promise<boolean> {
  const id = at.toISOString();
  const c = await slotsCol();
  // the first reservation of a slot counts visits already scheduled there by other means (older data)
  const existingCount = await (await col<LeadDoc>(CFG.COLL.LEADS)).countDocuments({ siteVisitStatus: SCHEDULED, siteVisitDate: at });
  try {
    await c.updateOne({ _id: id }, { $setOnInsert: { at, booked: existingCount, updatedAt: new Date() } }, { upsert: true });
  } catch (e: any) {
    if (e?.code !== 11000) throw e; // two first bookings at once: the other one created it
  }
  const r = await c.updateOne({ _id: id, booked: { $lt: capacity } }, { $inc: { booked: 1 }, $set: { updatedAt: new Date() } });
  return r.modifiedCount === 1;
}

/** Give a place back (never below zero). */
export async function releaseSlot(at: Date): Promise<void> {
  await (await slotsCol()).updateOne({ _id: at.toISOString(), booked: { $gt: 0 } }, { $inc: { booked: -1 }, $set: { updatedAt: new Date() } });
}

/** Cancel a booking (staff). Gives the place back once; a second cancel changes nothing. */
export async function cancelVisitBooking(id: string, reason: string, ctx: Ctx | null): Promise<VisitBookingDoc | null> {
  const c = await bookingsCol();
  const b = await c.findOneAndUpdate({ _id: id, status: 'booked' }, { $set: { status: 'cancelled', cancelReason: truncate(reason, 300), updatedAt: new Date() } }, { returnDocument: 'after' });
  if (!b) return c.findOne({ _id: id });
  await releaseSlot(b.at);
  if (b.leadId) {
    await (await col<LeadDoc>(CFG.COLL.LEADS)).updateOne({ _id: b.leadId, siteVisitStatus: SCHEDULED, siteVisitDate: b.at } as any, { $set: { siteVisitStatus: CFG.SITE_VISIT.PROSPECT, updatedAt: new Date() } });
    await appendRemark(b.leadId, `Site visit on ${fmtWhen(b.at)} cancelled${reason ? `: ${reason}` : ''}.`, ctx, undefined, ctx?.user?.name || 'Visit booking');
  }
  await auditLog(ctx, 'Visit Cancelled', 'Lead', b.leadId || b._id, `${fmtWhen(b.at)}${reason ? ' · ' + reason : ''}`);
  return b;
}

/** Move a booking to another slot: the new place is taken first, then the old one is given back. */
export async function rescheduleVisitBooking(id: string, toAt: string, ctx: Ctx | null, now = new Date()): Promise<VisitBookingDoc> {
  const cfg = await visitConfig();
  const at = new Date(toAt);
  if (Number.isNaN(at.getTime())) throw fail('VALIDATION', 'Please choose a time');
  const slot = (await listSlots(cfg, now)).flatMap((d) => d.slots).find((x) => x.at === at.toISOString());
  if (!slot) throw fail('VALIDATION', 'That time is not available — please choose another');
  const c = await bookingsCol();
  const b = await c.findOne({ _id: id, status: 'booked' });
  if (!b) throw fail('NOT_FOUND', 'Booking not found or no longer active');
  if (b.at.getTime() === at.getTime()) return b;
  if (!(await reserveSlot(at, cfg.capacity))) throw fail('CONFLICT', 'That time has just been booked — please choose another');
  const moved = await c.findOneAndUpdate({ _id: id, status: 'booked' }, { $set: { status: 'rescheduled', rescheduledTo: '', updatedAt: new Date() } }, { returnDocument: 'after' });
  if (!moved) {
    await releaseSlot(at); // someone cancelled it meanwhile
    throw fail('CONFLICT', 'This booking changed meanwhile. Reload and try again.');
  }
  await releaseSlot(b.at);
  const next: VisitBookingDoc = { ...b, _id: shortId('VB'), requestId: '', at, status: 'booked', createdAt: new Date(), updatedAt: new Date() };
  await c.insertOne(next);
  await c.updateOne({ _id: id }, { $set: { rescheduledTo: next._id } });
  if (b.leadId) {
    await (await col<LeadDoc>(CFG.COLL.LEADS)).updateOne({ _id: b.leadId } as any, { $set: { siteVisitStatus: SCHEDULED, siteVisitDate: at, updatedAt: new Date() } });
    await appendRemark(b.leadId, `Site visit moved from ${fmtWhen(b.at)} to ${fmtWhen(at)}.`, ctx, undefined, ctx?.user?.name || 'Visit booking');
  }
  await auditLog(ctx, 'Visit Rescheduled', 'Lead', b.leadId || b._id, `${fmtWhen(b.at)} → ${fmtWhen(at)}`);
  return next;
}

const fmtWhen = (at: Date) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CFG.TIME_ZONE }).format(at);

/** Book a visit (public). Returns the slot booked; never reveals lead data. */
export async function bookVisit(input: BookingInput, now = new Date()): Promise<{ at: string; existing: boolean; bookingId?: string; replay?: boolean }> {
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
  // the same submission again (double tap, retried request): the first booking, nothing new
  const requestId = truncate(String(input.requestId ?? '').trim(), 80);
  if (requestId) {
    await ensureBookingIndex();
    const seen = await (await bookingsCol()).findOne({ requestId });
    if (seen) return { at: seen.at.toISOString(), existing: false, bookingId: seen._id, replay: true };
  }

  const slot = (await listSlots(cfg, now)).flatMap((d) => d.slots).find((s) => s.at === at.toISOString());
  if (!slot) throw fail('VALIDATION', 'That time is not available — please choose another');
  if (slot.left <= 0) throw fail('CONFLICT', 'That time has just been booked — please choose another');

  const unit = truncate(String(input.unit ?? '').trim(), 80);
  const notes = truncate(String(input.notes ?? '').trim(), 500);
  const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CFG.TIME_ZONE }).format(at);

  const existing = await findLeadByPhone(phone);
  if (existing && existing[L.STAGE] !== CFG.STAGES.TRASH) {
    // anyone can type a customer's number on this public page: an existing lead is never changed from here.
    // The request goes to its RM to confirm with the customer (who then schedules the visit in the CRM).
    const id = existing[L.ID];
    const recent = await (await col(CFG.COLL.TASKS)).countDocuments({ leadId: id, createdBy: 'Visit booking', createdAt: { $gte: new Date(now.getTime() - 86_400_000) } }, { limit: 3 });
    if (recent >= 3) throw fail('RATE_LIMIT', 'This number has already asked for a visit today. We will call you to confirm.');
    await appendRemark(id, `Online visit request for ${when} (from the booking page, as “${name}”)${notes ? ` — ${notes}` : ''}. Not scheduled yet: call the customer to confirm.`, null, at.toISOString(), 'Visit booking');
    await addTask({ name: `Confirm online visit request: ${when}`, leadId: id, datetime: new Date(Math.min(at.getTime(), now.getTime() + 3_600_000)).toISOString(), assignedTo: String(existing[L.RM] || '') || 'Visit booking' }, { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: 'Visit booking' } });
    return { at: at.toISOString(), existing: true };
  }
  // take the place first (atomic): only then is the lead written
  if (!(await reserveSlot(at, cfg.capacity))) throw fail('CONFLICT', 'That time has just been booked — please choose another');
  const bookingId = shortId('VB');
  if (requestId) {
    try {
      await (await bookingsCol()).insertOne({ _id: bookingId, requestId, at, status: 'booked', leadId: '', name, phoneLast10: digits(phone).slice(-10), mode: 'onsite', createdAt: new Date(), updatedAt: new Date() });
    } catch (e: any) {
      await releaseSlot(at);
      if (e?.code === 11000) {
        const seen = await (await bookingsCol()).findOne({ requestId });
        if (seen) return { at: seen.at.toISOString(), existing: false, bookingId: seen._id, replay: true };
      }
      throw e;
    }
  }
  let created: Awaited<ReturnType<typeof addLead>>;
  try {
  created = await addLead(
    {
      [L.NAME]: name, [L.PHONE]: phone, ...(email ? { [L.EMAIL]: email } : {}), ...(unit ? { [L.UNIT_TYPE]: unit } : {}),
      [L.SOURCE]: 'Visit booking', [L.SITE_VISIT_STATUS]: SCHEDULED, [L.SITE_VISIT_DATE]: at.toISOString(),
      [L.NEXT_FOLLOWUP]: at.toISOString(),
      [L.NOTES]: `Booked a site visit online for ${when}.${notes ? ` ${notes}` : ''}`,
    } as any,
    null,
    { actor: 'Visit booking', allowDuplicate: true, eventSource: 'visit_booking' }
  );
  } catch (e) {
    // no lead, no visit: the place goes back
    await releaseSlot(at);
    if (requestId) await (await bookingsCol()).deleteOne({ _id: bookingId });
    throw e;
  }
  const leadId = String((created as any)?.lead?.[L.ID] || (created as any)?.id || '');
  if (requestId) await (await bookingsCol()).updateOne({ _id: bookingId }, { $set: { leadId } });
  else await (await bookingsCol()).insertOne({ _id: bookingId, requestId: '', at, status: 'booked', leadId, name, phoneLast10: digits(phone).slice(-10), mode: 'onsite', createdAt: new Date(), updatedAt: new Date() });
  return { at: at.toISOString(), existing: false, bookingId };
}

/* --------------------------------- actions -------------------------------- */
import type { ActionMap } from '../core/actions';
import { assertLeadAccess } from '../core/scope';

async function bookingFor(ctx: Ctx, id: unknown) {
  const b = await (await bookingsCol()).findOne({ _id: String(id || '') });
  if (!b) throw fail('NOT_FOUND', 'Booking not found');
  await assertLeadAccess(ctx, b.leadId);
  return b;
}

export const actions: ActionMap = {
  listVisitBookings: {
    perm: 'leads.view',
    fn: async (d, ctx) => {
      await assertLeadAccess(ctx, d?.leadId);
      const rows = await (await bookingsCol()).find({ leadId: String(d?.leadId || '') }).sort({ at: -1 }).limit(50).toArray();
      return rows.map((b) => ({ id: b._id, at: b.at.toISOString(), status: b.status, mode: b.mode, rescheduledTo: b.rescheduledTo || '', cancelReason: b.cancelReason || '' }));
    },
  },
  cancelVisitBooking: { perm: 'leads.edit', fn: async (d, ctx) => { await bookingFor(ctx, d?.id); return cancelVisitBooking(String(d.id), String(d?.reason || ''), ctx); } },
  rescheduleVisitBooking: { perm: 'leads.edit', fn: async (d, ctx) => { await bookingFor(ctx, d?.id); return rescheduleVisitBooking(String(d.id), String(d?.at || ''), ctx); } },
};
