/**
 * Follow-up sequence (company setting `followupSequence`, Settings › Alerts & follow-ups).
 *
 * The CRM already reminds RMs when a lead's "Next follow-up" is due (hourly job). A sequence fills that date in
 * automatically so no lead is forgotten:
 *   - a new lead without a follow-up date gets one on day `days[0]` after it arrived;
 *   - after follow-up #k is logged without a date, the next one is set to day `days[k]` (never in the past:
 *     a step that has already passed is set for the next day); after the last step nothing more is scheduled.
 * Only open stages are scheduled. Optional: the daily job moves New/Open/Warm leads with no activity for
 * `autoNotRespondingDays` days to "Not Responding" (0 = off).
 */
import { CFG } from '../core/config';
import { fail } from '../core/errors';
import { dateKey, makeZoned, safeJsonParse } from '../core/utils';

const S = CFG.STAGES;
/** Stages a sequence keeps following up. */
export const SEQUENCE_STAGES: string[] = [S.NEW, S.OPEN, S.WARM, S.HOT, S.QUALIFIED];
/** Stages the "no activity" rule may move to Not Responding. */
export const STALE_STAGES: string[] = [S.NEW, S.OPEN, S.WARM];

export interface FollowupSequence {
  enabled: boolean;
  /** Days after the enquiry for each follow-up step, ascending (e.g. 1, 3, 7). */
  days: number[];
  /** Local hour the follow-ups are scheduled at. */
  hour: number;
  /** Move New/Open/Warm leads to Not Responding after this many days without activity; 0 = off. */
  autoNotRespondingDays: number;
}

export const SEQUENCE_DEFAULTS: FollowupSequence = { enabled: true, days: [1, 3, 7], hour: 10, autoNotRespondingDays: 0 };

export function parseSequence(raw: unknown): FollowupSequence {
  const o = (typeof raw === 'string' ? safeJsonParse<Record<string, unknown>>(raw, {}) : raw) as Record<string, any> | null;
  if (!o || typeof o !== 'object') return { ...SEQUENCE_DEFAULTS, days: [...SEQUENCE_DEFAULTS.days] };
  const days = Array.isArray(o.days) ? o.days : String(o.days ?? '').split(/[,\s]+/);
  const clean = [...new Set(days.map((d: unknown) => Math.round(Number(d))).filter((d: number) => Number.isFinite(d) && d >= 0 && d <= 365))].sort((a, b) => a - b);
  const hour = Math.round(Number(o.hour));
  const nr = Math.round(Number(o.autoNotRespondingDays));
  return {
    enabled: o.enabled === undefined ? SEQUENCE_DEFAULTS.enabled : o.enabled === true || o.enabled === 'true',
    days: clean.length ? clean.slice(0, 10) : [...SEQUENCE_DEFAULTS.days],
    hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : SEQUENCE_DEFAULTS.hour,
    autoNotRespondingDays: Number.isFinite(nr) && nr > 0 ? Math.min(nr, 365) : 0,
  };
}

/** Validate a settings patch; returns the JSON string to store. */
export function validateSequence(raw: unknown): string {
  const o = (typeof raw === 'string' ? safeJsonParse<Record<string, unknown>>(raw, {}) : raw) as Record<string, any> | null;
  if (!o || typeof o !== 'object') throw fail('VALIDATION', 'Invalid follow-up sequence');
  const days = Array.isArray(o.days) ? o.days : String(o.days ?? '').split(/[,\s]+/).filter(Boolean);
  if (!days.length || days.some((d: unknown) => !Number.isFinite(Number(d)) || Number(d) < 0 || Number(d) > 365)) {
    throw fail('VALIDATION', 'Follow-up days must be numbers between 0 and 365, e.g. 1, 3, 7');
  }
  if (days.length > 10) throw fail('VALIDATION', 'Use at most 10 follow-up steps');
  return JSON.stringify(parseSequence(o));
}

/** `base` + `days` at `hour` local time. */
function dayAt(base: Date, days: number, hour: number): Date {
  const [y, m, d] = dateKey(base).split('-').map(Number);
  const start = makeZoned(y, m, d, hour);
  return new Date(start.getTime() + days * 86_400_000);
}

/** First follow-up for a new lead, or null (sequence off, stage closed, or a date already set). */
export function firstFollowup(seq: FollowupSequence, lead: { stage: string; nextFollowupAt?: Date | null; enquiryDate?: Date | null; createdAt?: Date | null }, now = new Date()): Date | null {
  if (!seq.enabled || lead.nextFollowupAt || !SEQUENCE_STAGES.includes(lead.stage)) return null;
  const base = lead.enquiryDate || lead.createdAt || now;
  const at = dayAt(base, seq.days[0], seq.hour);
  return at.getTime() > now.getTime() ? at : dayAt(now, 1, seq.hour);
}

/** Next follow-up after follow-up number `done` (1-based) was logged without a date, or null when the sequence is over. */
export function nextFollowup(seq: FollowupSequence, lead: { stage: string; enquiryDate?: Date | null; createdAt?: Date | null }, done: number, now = new Date()): Date | null {
  if (!seq.enabled || !SEQUENCE_STAGES.includes(lead.stage) || done < 1 || done >= seq.days.length) return null;
  const base = lead.enquiryDate || lead.createdAt || now;
  const at = dayAt(base, seq.days[done], seq.hour);
  return at.getTime() > now.getTime() ? at : dayAt(now, 1, seq.hour);
}
