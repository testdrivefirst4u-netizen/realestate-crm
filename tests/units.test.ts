import { describe, it, expect } from 'vitest';
import { dedupeUnitTypes, normalizeUnitType, parseUnitType, unitTypeMatches } from '../src/core/units';

describe('normalizeUnitType', () => {
  it('collapses every historical spelling into one', () => {
    const cases: Record<string, string> = {
      '1 - BHK': '1 BHK', '1BHK': '1 BHK', '1-bhk': '1 BHK', ' 1 Bhk ': '1 BHK', '2 B.H.K': '2 BHK', '3.0 BHK': '3 BHK',
      '2.5 BHK Type A': '2.5 BHK-A', '3 BHK (B)': '3 BHK-B', 'Type B 2 BHK': '2 BHK-B', '1 BHK – A': '1 BHK-A', '3BHK-A': '3 BHK-A',
      '2.5 bhk a': '2.5 BHK-A', '1 BHK Type-B': '1 BHK-B', '2 BHK-A': '2 BHK-A', '3.5 BHK': '3.5 BHK', '1 BHK Senior': '1 BHK', '2 BHK Deluxe': '2 BHK',
      Villa: 'Villa', '': '', 'Studio  Apartment': 'Studio Apartment',
    };
    for (const [input, expected] of Object.entries(cases)) expect(normalizeUnitType(input), input).toBe(expected);
    expect(normalizeUnitType(null)).toBe('');
    expect(normalizeUnitType(undefined)).toBe('');
  });
  it('treats placeholder text as empty (a column header or dropdown prompt saved as a value)', () => {
    for (const v of ['Unit Type', 'unit type', 'Unit Type Interested In', 'Select', 'Choose', 'None', 'N/A', 'NA', '-', '--']) expect(normalizeUnitType(v), v).toBe('');
    expect(normalizeUnitType('Unit 2 BHK')).toBe('2 BHK');
  });
  it('parses size and variant', () => {
    expect(parseUnitType('2.5 BHK Type A')).toEqual({ size: 2.5, variant: 'A', base: '2.5 BHK' });
    expect(parseUnitType('Villa')).toBeNull();
  });
  it('matches a lead interest against inventory variants', () => {
    expect(unitTypeMatches('2 BHK', '2 BHK-B')).toBe(true);
    expect(unitTypeMatches('2 - BHK', '2BHK')).toBe(true);
    expect(unitTypeMatches('2 BHK', '2.5 BHK')).toBe(false);
    expect(unitTypeMatches('', '2 BHK')).toBe(false);
  });
  it('dedupes and sorts option lists', () => {
    expect(dedupeUnitTypes(['3 BHK', '1 - BHK', '1BHK', '2.5 BHK-B', '2.5 BHK-A', 'Villa', '2 BHK', '1 BHK', null, ''])).toEqual(['1 BHK', '2 BHK', '2.5 BHK-A', '2.5 BHK-B', '3 BHK', 'Villa']);
  });
});
