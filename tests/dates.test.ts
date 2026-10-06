import { describe, it, expect } from 'vitest';
import {
  parseDate,
  formatDateTime,
  formatDate,
  dateKey,
  monthKey,
  getPresetRange,
  inRange,
  toSheetDateTime,
  splitFollowupEntry,
  listMonths,
  monthRange,
  previousMonthKey,
  fromDatetimeLocalInput,
  toDatetimeLocalInput,
  compareDates,
  startOfWeek,
  getParts,
} from '../src/core/dates';

// All expectations are in Asia/Kolkata (UTC+5:30), independent of the machine's zone.

describe('parseDate — every format the sheet has produced', () => {
  const expectIst = (d: Date | null, y: number, m: number, day: number, h: number, mi: number) => {
    expect(d).not.toBeNull();
    const p = getParts(d!);
    expect([p.y, p.m, p.d, p.h, p.mi]).toEqual([y, m, day, h, mi]);
  };

  it('ISO UTC', () => expectIst(parseDate('2026-10-01T12:00:00.000Z'), 2026, 10, 1, 17, 30));
  it('ISO with offset', () => expectIst(parseDate('2026-10-01T17:30:00+05:30'), 2026, 10, 1, 17, 30));
  it('yyyy-MM-dd HH:mm (legacy sheet text) is IST wall clock', () => expectIst(parseDate('2026-10-01 17:30'), 2026, 10, 1, 17, 30));
  it('yyyy-MM-dd only → midnight IST', () => expectIst(parseDate('2026-10-01'), 2026, 10, 1, 0, 0));
  it('dd/MM/yyyy', () => expectIst(parseDate('01/10/2026'), 2026, 10, 1, 0, 0));
  it('dd/MM/yyyy HH:mm', () => expectIst(parseDate('01/10/2026 17:30'), 2026, 10, 1, 17, 30));
  it('dd-MM-yy', () => expectIst(parseDate('01-10-26'), 2026, 10, 1, 0, 0));
  it('dd MMM yyyy, hh:mm a (our display format round-trips)', () => expectIst(parseDate('01 Oct 2026, 05:30 PM'), 2026, 10, 1, 17, 30));
  it('MMM d, yyyy h:mm AM', () => expectIst(parseDate('Oct 1, 2026 9:05 AM'), 2026, 10, 1, 9, 5));
  it('JS Date.toString() with GMT+0530 (India Standard Time)', () =>
    expectIst(parseDate('Thu Oct 01 2026 17:30:00 GMT+0530 (India Standard Time)'), 2026, 10, 1, 17, 30));
  it('follow-up cell text with em dash', () => expectIst(parseDate('2026-09-22 11:30 — Completed site visit of sample flat.'), 2026, 9, 22, 11, 30));
  it('sheet serial number', () => expectIst(parseDate(46296.5), 2026, 10, 1, 12, 0)); // 46296 = 2026-10-01
  it('epoch ms', () => expectIst(parseDate(Date.UTC(2026, 9, 1, 12, 0)), 2026, 10, 1, 17, 30));
  it('Date instance passthrough', () => {
    const d = new Date('2026-10-01T12:00:00Z');
    expect(parseDate(d)).toBe(d);
  });
  it('blank / garbage → null', () => {
    for (const v of ['', null, undefined, '-', '—', 'N/A', 'none', 'hello', 'Invalid Date', '32/13/2026']) {
      expect(parseDate(v as any)).toBeNull();
    }
  });
});

describe('formatting', () => {
  const d = new Date('2026-10-01T12:00:00Z'); // 17:30 IST
  it('formatDateTime → dd MMM yyyy, hh:mm a', () => expect(formatDateTime(d)).toBe('01 Oct 2026, 05:30 PM'));
  it('formatDate', () => expect(formatDate(d)).toBe('01 Oct 2026'));
  it('midnight and noon use 12', () => {
    expect(formatDateTime('2026-10-01 00:05')).toBe('01 Oct 2026, 12:05 AM');
    expect(formatDateTime('2026-10-01 12:05')).toBe('01 Oct 2026, 12:05 PM');
  });
  it('never emits GMT or Date.toString()', () => {
    const out = formatDateTime('Thu Oct 01 2026 17:30:00 GMT+0530 (India Standard Time)');
    expect(out).toBe('01 Oct 2026, 05:30 PM');
    expect(out).not.toMatch(/GMT/);
  });
  it('invalid → fallback', () => expect(formatDateTime('garbage', '—')).toBe('—'));
  it('toSheetDateTime', () => expect(toSheetDateTime(d)).toBe('2026-10-01 17:30'));
  it('dateKey / monthKey are IST-based (UTC bug regression)', () => {
    // 20:00 UTC on 30 Sep = 01:30 IST on 1 Oct
    const late = new Date('2026-09-30T20:00:00Z');
    expect(dateKey(late)).toBe('2026-10-01');
    expect(monthKey(late)).toBe('2026-10');
  });
  it('datetime-local round trip', () => {
    expect(toDatetimeLocalInput(d)).toBe('2026-10-01T17:30');
    expect(fromDatetimeLocalInput('2026-10-01T17:30')).toBe(d.toISOString());
  });
});

describe('ranges', () => {
  const now = new Date('2026-10-01T18:01:00Z'); // 23:31 IST on 1 Oct 2026 (Thursday)
  it('today spans the IST calendar day', () => {
    const r = getPresetRange('today', now)!;
    expect(dateKey(r.start)).toBe('2026-10-01');
    expect(dateKey(r.end)).toBe('2026-10-01');
    expect(inRange('2026-10-01 00:00', r)).toBe(true);
    expect(inRange('2026-10-01 23:59', r)).toBe(true);
    expect(inRange('2026-09-30 23:59', r)).toBe(false);
  });
  it('this month / last month', () => {
    const tm = getPresetRange('this_month', now)!;
    expect(dateKey(tm.start)).toBe('2026-10-01');
    expect(dateKey(tm.end)).toBe('2026-10-31');
    const lm = getPresetRange('last_month', now)!;
    expect(dateKey(lm.start)).toBe('2026-09-01');
    expect(dateKey(lm.end)).toBe('2026-09-30');
  });
  it('this week starts Monday', () => {
    expect(dateKey(startOfWeek(now))).toBe('2026-09-28');
    const r = getPresetRange('this_week', now)!;
    expect(dateKey(r.end)).toBe('2026-10-04');
  });
  it('this quarter', () => {
    const r = getPresetRange('this_quarter', now)!;
    expect(dateKey(r.start)).toBe('2026-10-01');
    expect(dateKey(r.end)).toBe('2026-12-31');
  });
  it('monthRange / listMonths / previousMonthKey', () => {
    const r = monthRange('2026-02');
    expect(dateKey(r.start)).toBe('2026-02-01');
    expect(dateKey(r.end)).toBe('2026-02-28');
    expect(listMonths('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(previousMonthKey('2026-01')).toBe('2025-12');
  });
  it('all → null', () => expect(getPresetRange('all', now)).toBeNull());
});

describe('follow-up entries and sorting', () => {
  it('splitFollowupEntry', () => {
    const r = splitFollowupEntry('2026-09-22 11:30 — Completed site visit');
    expect(r.date && dateKey(r.date)).toBe('2026-09-22');
    expect(r.text).toBe('Completed site visit');
    expect(splitFollowupEntry('just a remark').date).toBeNull();
  });
  it('compareDates puts blanks last', () => {
    const arr = ['2026-10-02', '', '2026-10-01', 'garbage'];
    const asc = [...arr].sort((a, b) => compareDates(a, b, true));
    expect(asc.slice(0, 2)).toEqual(['2026-10-01', '2026-10-02']);
    const desc = [...arr].sort((a, b) => compareDates(a, b, false));
    expect(desc.slice(0, 2)).toEqual(['2026-10-02', '2026-10-01']);
  });
});
