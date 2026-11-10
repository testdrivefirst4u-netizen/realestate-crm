/**
 * Booking rules for inventory units — one table, applied to every write (the drawer's generic save, the AI assistant,
 * transitions). Pure functions: no database access, so they are tested directly.
 *
 *   Available ─reserve─▶ Reserved ─book─▶ Booked ─sell─▶ Sold
 *       ▲  ▲                │ release        │ cancel*      │ cancel*
 *       │  └────────────────┘                └──────────────┘
 *       └─ Blocked / Owner (no customer)                     * needs inventory.approve
 *
 * - Reserved, Booked and Sold always belong to one customer lead (by its Enquiry ID).
 * - A held unit cannot be given to another lead: release it first. That is what makes two agents reserving the
 *   same unit a conflict rather than a silent overwrite.
 * - A reservation is time-limited (`holdUntil`); once it lapses the unit counts as Available again.
 * - Statuses the company added itself (anything not listed here) are treated like Blocked: no customer.
 */
export const HOLD_STATES = ['Reserved', 'Booked', 'Sold'];
const FREE_STATES = ['Available', 'Blocked', 'Owner'];

export const DEFAULT_HOLD_HOURS = 48;
export const MAX_HOLD_HOURS = 24 * 14;

export interface UnitState {
  status: string;
  leadId?: string;
  holdUntil?: Date | string | null;
}

export type TransitionCheck =
  | { ok: true; kind: 'none' | 'reserve' | 'extend' | 'book' | 'sell' | 'release' | 'cancel' | 'block' | 'edit' }
  | { ok: false; code: 'CONFLICT' | 'VALIDATION' | 'FORBIDDEN'; message: string };

/** A reservation whose time is up. */
export function holdExpired(u: UnitState, now = new Date()): boolean {
  if (u.status !== 'Reserved' || !u.holdUntil) return false;
  const t = new Date(u.holdUntil).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

/** The state a write starts from: a lapsed reservation is free again. */
export function effectiveState(u: UnitState, now = new Date()): UnitState {
  return holdExpired(u, now) ? { status: 'Available', leadId: '', holdUntil: null } : { status: u.status || 'Available', leadId: u.leadId || '', holdUntil: u.holdUntil ?? null };
}

const isHold = (s: string) => HOLD_STATES.includes(s);

/**
 * May the unit go from `before` to `after`? `canApprove` is inventory.approve (cancelling a booking or a sale).
 * `after.leadId` is the lead it will belong to once written (unchanged when the patch does not set it).
 */
export function checkTransition(before0: UnitState, after: { status: string; leadId: string }, opts: { canApprove: boolean; now?: Date }): TransitionCheck {
  const before = effectiveState(before0, opts.now);
  const from = before.status;
  const to = after.status || 'Available';
  const fromLead = before.leadId || '';
  const toLead = after.leadId || '';

  if (isHold(to) && !toLead) return { ok: false, code: 'VALIDATION', message: `Link the customer's lead to mark the unit ${to}.` };
  if (!isHold(to) && toLead && to !== 'Available') return { ok: false, code: 'VALIDATION', message: `A ${to} unit has no customer. Remove the lead, or reserve the unit instead.` };
  if (to === 'Available' && toLead && !isHold(from)) return { ok: false, code: 'VALIDATION', message: 'To give this unit to a customer, reserve or book it.' };

  // a held unit belongs to its lead: another lead must wait until it is released
  if (isHold(from) && isHold(to) && fromLead && toLead !== fromLead) {
    return { ok: false, code: 'CONFLICT', message: `This unit is already ${from.toLowerCase()} for ${fromLead}. Release it before giving it to another customer.` };
  }

  if (from === to) return { ok: true, kind: from === 'Reserved' ? 'extend' : 'edit' };

  switch (from) {
    case 'Reserved':
      if (to === 'Booked') return { ok: true, kind: 'book' };
      if (to === 'Available') return { ok: true, kind: 'release' };
      if (to === 'Sold') return { ok: false, code: 'VALIDATION', message: 'Book the unit before marking it sold.' };
      return { ok: false, code: 'VALIDATION', message: `Release the reservation before marking the unit ${to}.` };
    case 'Booked':
      if (to === 'Sold') return { ok: true, kind: 'sell' };
      if (to === 'Available') return opts.canApprove ? { ok: true, kind: 'cancel' } : { ok: false, code: 'FORBIDDEN', message: 'Cancelling a booking needs a manager. Ask an Admin or Manager to release this unit.' };
      return { ok: false, code: 'VALIDATION', message: `A booked unit can be marked Sold, or the booking cancelled. It cannot become ${to}.` };
    case 'Sold':
      if (to === 'Available') return opts.canApprove ? { ok: true, kind: 'cancel' } : { ok: false, code: 'FORBIDDEN', message: 'Cancelling a sale needs a manager.' };
      return { ok: false, code: 'VALIDATION', message: `A sold unit cannot become ${to}.` };
    default:
      // Available, Blocked, Owner and company-defined statuses
      if (to === 'Reserved') return from === 'Available' ? { ok: true, kind: 'reserve' } : { ok: false, code: 'VALIDATION', message: `Make the unit Available before reserving it (it is ${from}).` };
      if (to === 'Booked') return from === 'Available' ? { ok: true, kind: 'book' } : { ok: false, code: 'VALIDATION', message: `Make the unit Available before booking it (it is ${from}).` };
      if (to === 'Sold') return { ok: false, code: 'VALIDATION', message: 'Book the unit before marking it sold.' };
      return { ok: true, kind: to === 'Available' ? 'release' : 'block' };
  }
}

/** Hours a reservation lasts: the company setting, kept to a sensible range. */
export function holdHours(raw: unknown): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= MAX_HOLD_HOURS ? n : DEFAULT_HOLD_HOURS;
}

export { FREE_STATES };
