import { describe, it, expect } from 'vitest';
import { sortLeads, defaultSortAsc, leadIdNumber } from '../src/modules/leads/sorting';
import { F } from '../src/core/config';
import type { Lead } from '../src/types/crm';

const lead = (id: string, enquiry: string, created?: string, extra: Record<string, any> = {}): Lead =>
  ({ [F.ID]: id, [F.NAME]: 'Lead ' + id, [F.STAGE]: 'New', [F.ENQUIRY_DATE]: enquiry, [F.CREATED_AT]: created || '', ...extra }) as Lead;

describe('sortLeads', () => {
  it('newest first: same-day enquiries fall back to Created At, then the ID number', () => {
    const list = [
      lead('ENQ-0480', '2026-10-01T00:00:00.000Z', '2026-10-01T04:00:00.000Z'),
      lead('ENQ-0612', '2026-10-01T00:00:00.000Z', '2026-10-01T09:30:00.000Z'),
      lead('ENQ-0003', '2026-09-20T00:00:00.000Z'),
      lead('ENQ-0611', '2026-10-01T00:00:00.000Z'), // no Created At → by ID number after the dated ones
      lead('ENQ-0610', '2026-10-01T00:00:00.000Z'),
    ];
    expect(sortLeads(list, 'enquiryDate', false).map((l) => l[F.ID])).toEqual(['ENQ-0612', 'ENQ-0480', 'ENQ-0611', 'ENQ-0610', 'ENQ-0003']);
    expect(sortLeads(list, 'enquiryDate', true).map((l) => l[F.ID])).toEqual(['ENQ-0003', 'ENQ-0480', 'ENQ-0612', 'ENQ-0610', 'ENQ-0611']);
  });
  it('blank dates always sort last in both directions and the input is not mutated', () => {
    const list = [lead('ENQ-2', ''), lead('ENQ-1', '2026-10-01T00:00:00.000Z'), lead('ENQ-3', 'not a date')];
    const copy = [...list];
    expect(sortLeads(list, 'enquiryDate', false)[0][F.ID]).toBe('ENQ-1');
    expect(sortLeads(list, 'enquiryDate', true)[0][F.ID]).toBe('ENQ-1');
    expect(list).toEqual(copy);
  });
  it('next follow-up: soonest first, undated last', () => {
    const list = [
      lead('ENQ-1', '2026-10-01T00:00:00.000Z', '', { [F.NEXT_FOLLOWUP]: '2026-10-05T05:30:00.000Z' }),
      lead('ENQ-2', '2026-10-01T00:00:00.000Z', '', { [F.NEXT_FOLLOWUP]: '' }),
      lead('ENQ-3', '2026-10-01T00:00:00.000Z', '', { [F.NEXT_FOLLOWUP]: '2026-10-03T05:30:00.000Z' }),
    ];
    expect(sortLeads(list, 'nextDue', true).map((l) => l[F.ID])).toEqual(['ENQ-3', 'ENQ-1', 'ENQ-2']);
  });
  it('text keys are numeric-aware and case-insensitive', () => {
    const list = [lead('ENQ-1', '', '', { [F.NAME]: 'ramesh' }), lead('ENQ-2', '', '', { [F.NAME]: 'Anita' }), lead('ENQ-3', '', '', { [F.NAME]: '' })];
    expect(sortLeads(list, 'name', true).map((l) => l[F.NAME])).toEqual(['Anita', 'ramesh', '']);
  });
  it('defaults: dates newest first, due dates soonest first', () => {
    expect(defaultSortAsc('enquiryDate')).toBe(false);
    expect(defaultSortAsc('nextDue')).toBe(true);
    expect(leadIdNumber(lead('ENQ-0612', ''))).toBe(612);
  });
});
