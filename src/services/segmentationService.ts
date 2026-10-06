/**
 * Client segmentation — rule evaluation for saved audiences.
 *
 * Rules are evaluated generically (no segment is special-cased by id):
 *  - text fields: equals / not_equals / contains / in (comma list), case-insensitive
 *  - date fields (`F.ENQUIRY_DATE`, `F.NEXT_FOLLOWUP`, `F.LAST_FOLLOWUP`, …):
 *      greater_than / less_than compare real dates via `parseDate`; the target
 *      value may be a date ("2026-10-01") or a relative token:
 *      "now", "today", "yesterday", "tomorrow", "+7d", "-30d", "+2w", "-12h"
 *      equals / not_equals on a date field compare calendar days (CRM time zone)
 *  - numeric strings compare numerically for greater_than / less_than
 *
 * The engagement score comes from `leadScore` in core/analytics (single implementation).
 */
import { ClientSegment, Lead, SegmentOperator, SegmentRule } from '../types/crm';
import { F, LEAD_DATE_FIELDS, STAGES } from '../core/config';
import { addDays, dateKey, endOfDay, parseDate, startOfDay, todayKey } from '../core/dates';
import { isCounted, leadScore } from '../core/analytics';

/* ------------------------------------------------------------------------ */
/* Field / operator catalogue (used by the Segments UI)                      */
/* ------------------------------------------------------------------------ */

/** Lead fields a rule may target, in display order. */
export const SEGMENT_FIELDS: string[] = [
  F.STAGE,
  F.UNIT_TYPE,
  F.SOURCE,
  F.SITE_VISIT_STATUS,
  F.RM,
  F.PURCHASE_OR_RENT,
  F.RELATIONSHIP,
  F.ENQUIRED_FOR,
  F.BROCHURE,
  F.NAME,
  F.PHONE,
  F.EMAIL,
  F.NOTES,
  F.ENQUIRY_DATE,
  F.NEXT_FOLLOWUP,
  F.LAST_FOLLOWUP,
  F.SITE_VISIT_DATE,
  F.BOOKING_DATE,
];

export const SEGMENT_OPERATORS: Array<{ value: SegmentOperator; label: string }> = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'contains', label: 'Contains text' },
  { value: 'in', label: 'Is one of (comma separated)' },
  { value: 'greater_than', label: 'Is after / greater than' },
  { value: 'less_than', label: 'Is before / less than' },
];

/** Hint shown next to the value input of a date rule. */
export const RELATIVE_DATE_HINT = 'Dates accept "now", "today", "yesterday", "tomorrow", "+7d", "-30d", "+2w" or a date such as 2026-10-01.';

export function isDateField(field: string): boolean {
  return LEAD_DATE_FIELDS.includes(field);
}

export function operatorLabel(op: SegmentOperator): string {
  return SEGMENT_OPERATORS.find((o) => o.value === op)?.label || op;
}

export function describeRule(rule: SegmentRule): string {
  return `${rule.field} ${operatorLabel(rule.operator).toLowerCase()} "${rule.value}"`;
}

/* ------------------------------------------------------------------------ */
/* Date resolution                                                           */
/* ------------------------------------------------------------------------ */

const REL_RE = /^([+-])\s*(\d+)\s*([dwh])$/i;

/**
 * Resolve a rule value to a Date. Relative tokens are evaluated against `now`
 * in the CRM time zone. "today" means the start of today for less_than /
 * equals and the end of today for greater_than, so "less than today" reads as
 * "before today" and "greater than today" as "after today".
 */
export function resolveRuleDate(value: string, operator: SegmentOperator, now: Date = new Date()): Date | null {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  const dayFor = (d: Date) => (operator === 'greater_than' ? endOfDay(d) : startOfDay(d));
  if (v === 'now') return now;
  if (v === 'today') return dayFor(now);
  if (v === 'yesterday') return dayFor(addDays(startOfDay(now), -1));
  if (v === 'tomorrow') return dayFor(addDays(startOfDay(now), 1));
  const m = v.match(REL_RE);
  if (m) {
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    switch (m[3].toLowerCase()) {
      case 'd':
        return addDays(now, n);
      case 'w':
        return addDays(now, n * 7);
      case 'h':
        return new Date(now.getTime() + n * 3_600_000);
    }
  }
  return parseDate(value);
}

/* ------------------------------------------------------------------------ */
/* Defaults                                                                  */
/* ------------------------------------------------------------------------ */

export const DEFAULT_SEGMENTS: ClientSegment[] = [
  {
    id: 'SEG-0001',
    name: '🔥 Hot & Warm Pipeline',
    description: 'High-intent prospects in active evaluation or negotiating offers',
    color: '#A9825A',
    matchType: 'ANY',
    rules: [
      { field: F.STAGE, operator: 'equals', value: STAGES.HOT },
      { field: F.STAGE, operator: 'equals', value: STAGES.WARM },
    ],
    createdBy: 'System',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'SEG-0002',
    name: '🏢 Luxury 3 BHK & 3.5 BHK Seekers',
    description: 'Clients interested in the larger residences',
    color: '#1D2F3F',
    matchType: 'ANY',
    rules: [
      { field: F.UNIT_TYPE, operator: 'equals', value: '3 BHK' },
      { field: F.UNIT_TYPE, operator: 'equals', value: '3.5 BHK' },
    ],
    createdBy: 'System',
    createdAt: '2026-08-05T00:00:00.000Z',
  },
  {
    id: 'SEG-0003',
    name: '🚶 Site Visit Prospects & Walk-ins',
    description: 'Prospects scheduled for a site tour or who have already visited',
    color: '#7C8B78',
    matchType: 'ANY',
    rules: [
      { field: F.SITE_VISIT_STATUS, operator: 'contains', value: 'Scheduled' },
      { field: F.SITE_VISIT_STATUS, operator: 'contains', value: 'Walk-In' },
      { field: F.SITE_VISIT_STATUS, operator: 'contains', value: 'Completed' },
    ],
    createdBy: 'System',
    createdAt: '2026-08-10T00:00:00.000Z',
  },
  {
    id: 'SEG-0004',
    name: '👨‍👩‍👦 Enquiries for Elderly Parents',
    description: 'Sons and daughters looking for a residence for their parents',
    color: '#6B5F57',
    matchType: 'ANY',
    rules: [
      { field: F.ENQUIRED_FOR, operator: 'contains', value: 'Parents' },
      { field: F.RELATIONSHIP, operator: 'in', value: 'Son,Daughter' },
    ],
    createdBy: 'System',
    createdAt: '2026-08-15T00:00:00.000Z',
  },
  {
    id: 'SEG-0005',
    name: '⚠️ Overdue Client Follow-ups',
    description: 'Clients whose next follow-up time has already passed and who are not booked',
    color: '#8A3E28',
    matchType: 'ALL',
    rules: [
      { field: F.NEXT_FOLLOWUP, operator: 'less_than', value: 'now' },
      { field: F.STAGE, operator: 'not_equals', value: STAGES.BOOKED },
    ],
    createdBy: 'System',
    createdAt: '2026-08-20T00:00:00.000Z',
  },
];

/* ------------------------------------------------------------------------ */
/* Evaluation                                                                */
/* ------------------------------------------------------------------------ */

function testDateRule(leadVal: string, rule: SegmentRule, now: Date): boolean {
  const leadDate = parseDate(leadVal);
  const target = resolveRuleDate(rule.value, rule.operator, now);
  switch (rule.operator) {
    case 'greater_than':
      return !!leadDate && !!target && leadDate.getTime() > target.getTime();
    case 'less_than':
      return !!leadDate && !!target && leadDate.getTime() < target.getTime();
    case 'equals': {
      if (!target) return leadVal.trim() === String(rule.value || '').trim(); // '' → "has no date"
      return !!leadDate && dateKey(leadDate) === dateKey(target);
    }
    case 'not_equals': {
      if (!target) return leadVal.trim() !== String(rule.value || '').trim();
      return !leadDate || dateKey(leadDate) !== dateKey(target);
    }
    default:
      return false;
  }
}

export class SegmentationService {
  /** Does a lead satisfy a single rule? */
  public static testRule(lead: Lead, rule: SegmentRule, now: Date = new Date()): boolean {
    const rawVal = lead[rule.field];
    const leadVal = rawVal !== undefined && rawVal !== null ? String(rawVal).trim() : '';
    const targetVal = String(rule.value ?? '').trim();

    if (isDateField(rule.field) && rule.operator !== 'contains' && rule.operator !== 'in') {
      return testDateRule(leadVal, rule, now);
    }

    const lv = leadVal.toLowerCase();
    const tv = targetVal.toLowerCase();

    switch (rule.operator) {
      case 'equals':
        return lv === tv;
      case 'not_equals':
        return lv !== tv;
      case 'contains':
        return !!tv && lv.includes(tv);
      case 'in': {
        const items = tv.split(',').map((s) => s.trim()).filter(Boolean);
        return items.includes(lv);
      }
      case 'greater_than':
      case 'less_than': {
        const numLead = parseFloat(leadVal);
        const numTarget = parseFloat(targetVal);
        if (!isNaN(numLead) && !isNaN(numTarget)) return rule.operator === 'greater_than' ? numLead > numTarget : numLead < numTarget;
        const dl = parseDate(leadVal);
        const dt = resolveRuleDate(targetVal, rule.operator, now);
        if (dl && dt) return rule.operator === 'greater_than' ? dl.getTime() > dt.getTime() : dl.getTime() < dt.getTime();
        if (!leadVal) return false;
        const cmp = lv.localeCompare(tv);
        return rule.operator === 'greater_than' ? cmp > 0 : cmp < 0;
      }
      default:
        return false;
    }
  }

  /** Does a lead belong to the segment (all / any rules)? */
  public static matches(lead: Lead, segment: ClientSegment, now: Date = new Date()): boolean {
    const rules = segment.rules || [];
    if (rules.length === 0) return true;
    return segment.matchType === 'ALL' ? rules.every((r) => this.testRule(lead, r, now)) : rules.some((r) => this.testRule(lead, r, now));
  }

  /** Leads in the segment. Trashed / permanently deleted leads are never included. */
  public static getSegmentLeads(segment: ClientSegment, leads: Lead[], now: Date = new Date()): Lead[] {
    return leads.filter((l) => isCounted(l) && this.matches(l, segment, now));
  }

  /** Summary metrics for a set of segment leads. */
  public static statsFor(matching: Lead[]) {
    const total = matching.length;
    const unitsCount: Record<string, number> = {};
    let totalScore = 0;
    for (const l of matching) {
      const u = String(l[F.UNIT_TYPE] || '').trim() || 'Unspecified';
      unitsCount[u] = (unitsCount[u] || 0) + 1;
      totalScore += leadScore(l);
    }
    const avgScore = total > 0 ? (totalScore / total).toFixed(1) : '0';
    return { total, avgScore, unitsCount };
  }

  /** Summary metrics for a segment. */
  public static getSegmentStats(segment: ClientSegment, leads: Lead[], now: Date = new Date()) {
    return this.statsFor(this.getSegmentLeads(segment, leads, now));
  }

  /** 'yyyy-MM-dd' for today in the CRM time zone (kept for callers that need a day key). */
  public static todayStr(): string {
    return todayKey();
  }
}
