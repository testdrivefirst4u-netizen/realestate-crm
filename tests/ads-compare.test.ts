/** Ads manager: which dates each choice means, comparing two periods fairly, and the Excel sheet. */
import { describe, expect, it } from 'vitest';
import { adsFileName, buildAdsSheet, changeOf, changePercent, compareNote, compareRange, daysIn, metricOf, rangeOfPreset, totalsOf, validRange } from '../src/modules/ads/adsCompare';

const TODAY = '2026-11-06';
const row = (id: string, p: Record<string, unknown> = {}) => ({ id, name: id, level: 'campaign', accountId: 'act_1', currency: 'INR', campaignName: 'C', adsetName: 'S', results: null, resultLabel: '', costPerResult: null, spend: null, reach: null, impressions: null, frequency: null, clicks: null, ctr: null, cpc: null, cpm: null, linkClicks: null, linkCtr: null, linkCpc: null, leads: null, landingPageViews: null, ...p }) as any;

describe('Excel numbers', () => {
  it('writes numbers as numbers and text as text', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
    const { buildXlsx } = await import('../src/core/xlsx');
    const sheet = strFromU8(unzipSync(buildXlsx(['Name', 'Spend'], [['=SUM(A1)', 1500.5], ['0123', 0]]))['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<v>1500.5</v>');
    expect(sheet).toContain('<v>0</v>');
    expect(sheet).toContain('=SUM(A1)</t>'); // text stays text, never a formula
    expect(sheet).toContain('0123</t>');
  });
});

describe('the dates of a choice', () => {
  it('matches how Meta counts', () => {
    expect(rangeOfPreset('today', TODAY)).toEqual({ since: TODAY, until: TODAY });
    expect(rangeOfPreset('yesterday', TODAY)).toEqual({ since: '2026-11-05', until: '2026-11-05' });
    expect(rangeOfPreset('last_7d', TODAY)).toEqual({ since: '2026-10-30', until: '2026-11-05' });
    expect(rangeOfPreset('this_month', TODAY)).toEqual({ since: '2026-11-01', until: TODAY });
    expect(rangeOfPreset('last_month', TODAY)).toEqual({ since: '2026-10-01', until: '2026-10-31' });
    expect(rangeOfPreset('maximum', TODAY)).toBeNull();
  });
  it('crosses a year', () => {
    expect(rangeOfPreset('last_month', '2026-01-15')).toEqual({ since: '2025-12-01', until: '2025-12-31' });
    expect(rangeOfPreset('yesterday', '2026-01-01')).toEqual({ since: '2025-12-31', until: '2025-12-31' });
  });
  it('checks a typed range', () => {
    expect(validRange({ since: '2026-11-01', until: '2026-11-02' })).toBe(true);
    expect(validRange({ since: '2026-11-03', until: '2026-11-02' })).toBe(false);
    expect(validRange({ since: '', until: '2026-11-02' })).toBe(false);
  });
});

describe('what to compare with', () => {
  it('the days just before, the same number of them', () => {
    const r = compareRange('previous', { since: '2026-11-01', until: '2026-11-06' }, TODAY);
    expect(r).toEqual({ since: '2026-10-26', until: '2026-10-31' });
    expect(daysIn(r)).toBe(6);
    expect(compareRange('previous', { since: TODAY, until: TODAY }, TODAY)).toEqual({ since: '2026-11-05', until: '2026-11-05' });
  });
  it('this month so far against the same dates last month', () => {
    expect(compareRange('sameDays', { since: '2026-11-01', until: '2026-11-06' }, TODAY)).toEqual({ since: '2026-10-01', until: '2026-10-06' });
  });
  it('a whole month against the whole month before', () => {
    expect(compareRange('sameDays', { since: '2026-10-01', until: '2026-10-31' }, TODAY)).toEqual({ since: '2026-09-01', until: '2026-09-30' });
    expect(compareRange('sameDays', { since: '2026-03-01', until: '2026-03-31' }, TODAY)).toEqual({ since: '2026-02-01', until: '2026-02-28' });
  });
  it('keeps the number of days when a month is shorter', () => {
    const r = compareRange('sameDays', { since: '2026-10-30', until: '2026-11-05' }, TODAY);
    expect(r).toEqual({ since: '2026-09-30', until: '2026-10-06' });
    expect(daysIn(r)).toBe(7);
    expect(compareRange('sameDays', { since: '2026-03-31', until: '2026-03-31' }, TODAY)).toEqual({ since: '2026-02-28', until: '2026-02-28' });
    expect(compareRange('sameDays', { since: '2026-01-05', until: '2026-01-06' }, TODAY)).toEqual({ since: '2025-12-05', until: '2025-12-06' });
  });
  it('whole of last month, whatever is chosen', () => {
    expect(compareRange('lastMonth', { since: TODAY, until: TODAY }, TODAY)).toEqual({ since: '2026-10-01', until: '2026-10-31' });
  });
  it('warns when the comparison would mislead, and not otherwise', () => {
    expect(compareNote({ since: '2026-11-01', until: '2026-11-06' }, { since: '2026-10-01', until: '2026-10-31' }, TODAY)).toMatch(/different lengths \(6 and 31 days\)/);
    expect(compareNote({ since: '2026-11-01', until: '2026-11-06' }, { since: '2026-10-01', until: '2026-10-06' }, TODAY)).toMatch(/Today is not finished/);
    expect(compareNote({ since: '2026-10-01', until: '2026-10-10' }, { since: '2026-10-05', until: '2026-10-14' }, TODAY)).toMatch(/overlap/);
    expect(compareNote({ since: '2026-10-11', until: '2026-10-20' }, { since: '2026-10-01', until: '2026-10-10' }, TODAY)).toBe('');
  });
});

describe('what changed', () => {
  it('more leads is good, a higher cost is bad, spend is neither', () => {
    expect(changeOf(120, 100, 'up')).toEqual({ text: '20.0%', tone: 'good', arrow: 'up' });
    expect(changeOf(120, 100, 'down')).toEqual({ text: '20.0%', tone: 'bad', arrow: 'up' });
    expect(changeOf(80, 100, 'down')).toEqual({ text: '20.0%', tone: 'good', arrow: 'down' });
    expect(changeOf(120, 100, 'none')?.tone).toBe('flat');
  });
  it('nothing before is New, not an endless rise; stopping is down all the way', () => {
    expect(changeOf(50, null, 'up')).toMatchObject({ text: 'New', arrow: 'up' });
    expect(changeOf(50, 0, 'up')).toMatchObject({ text: 'New' });
    expect(changeOf(null, 50, 'up')).toEqual({ text: '100%', tone: 'bad', arrow: 'down' });
    expect(changeOf(null, null, 'up')).toBeNull();
    expect(changeOf(7, 7, 'up')).toMatchObject({ text: 'No change', tone: 'flat' });
  });
  it('a cost that appears or vanishes is neither good nor bad', () => {
    expect(changeOf(575, null, 'down')).toMatchObject({ text: 'New', tone: 'flat' });
    expect(changeOf(null, 575, 'down')).toMatchObject({ text: '100%', tone: 'flat' });
  });
  it('a percent for Excel, blank when there is nothing to measure from', () => {
    expect(changePercent(150, 100)).toBe(50);
    expect(changePercent(5, 0)).toBeNull();
    expect(changePercent(5, null)).toBeNull();
  });
});

describe('totals', () => {
  const rows = [row('a', { spend: 1000, impressions: 10000, clicks: 100, linkClicks: 50, leads: 10, results: 10, resultLabel: 'Leads', costPerResult: 100, ctr: 1 }), row('b', { spend: 3000, impressions: 30000, clicks: 900, linkClicks: 150, leads: 30, results: 30, resultLabel: 'Leads', costPerResult: 100, ctr: 3 })];
  it('works costs and rates out from the totals, never adding them up', () => {
    const t = totalsOf(rows);
    expect(t).toMatchObject({ spend: 4000, leads: 40, costPerLead: 100, results: 40, cpr: 100, cpc: 4, cpm: 100, ctr: 2.5 });
  });
  it('does not add up results of different kinds', () => {
    const t = totalsOf([row('a', { results: 5, resultLabel: 'Leads' }), row('b', { results: 9, resultLabel: 'Reach' })]);
    expect(t.results).toBeNull();
    expect(t.cpr).toBeNull();
  });
  it('has nothing to divide when nothing happened', () => {
    expect(totalsOf([])).toMatchObject({ spend: 0, costPerLead: null, ctr: null, cpm: null });
  });
});

describe('the Excel sheet', () => {
  const spend = { label: 'Amount spent', metric: 'spend', value: metricOf('spend')!.get };
  const leads = { label: 'Leads', metric: 'leads', value: metricOf('leads')!.get };
  const delivery = { label: 'Delivery', value: () => 'Active' };
  const base = { nameLabel: 'Campaign', level: 'campaign', accountName: () => 'Amaya' };

  it('has real numbers and a total', () => {
    const s = buildAdsSheet({ ...base, rows: [row('a', { spend: 1000.5, leads: 4 }), row('b', { spend: 500, leads: 6 })], columns: [delivery, spend, leads] });
    expect(s.headers).toEqual(['Campaign', 'Ad account', 'Delivery', 'Amount spent', 'Leads']);
    expect(s.rows[0]).toEqual(['a', 'Amaya', 'Active', 1000.5, 4]);
    expect(s.rows[2]).toEqual(['Total', '', '', 1500.5, 10]);
  });

  it('adds the parents at lower levels', () => {
    expect(buildAdsSheet({ ...base, nameLabel: 'Ad', level: 'ad', rows: [], columns: [] }).headers).toEqual(['Ad', 'Ad set', 'Campaign', 'Ad account']);
  });

  it('comparing, adds the earlier figure and the change, with the dates in the heading', () => {
    const before = new Map([['a', row('a', { spend: 500, leads: 2 })]]);
    const s = buildAdsSheet({ ...base, rows: [row('a', { spend: 1000, leads: 4 }), row('new', { spend: 100, leads: 1 })], before, mainLabel: 'Nov', otherLabel: 'Oct', columns: [delivery, spend] });
    expect(s.headers).toEqual(['Campaign', 'Ad account', 'Delivery', 'Amount spent (Nov)', 'Amount spent (Oct)', 'Amount spent change %']);
    expect(s.rows[0]).toEqual(['a', 'Amaya', 'Active', 1000, 500, 100]);
    expect(s.rows[1]).toEqual(['new', 'Amaya', 'Active', 100, '', '']);
    expect(s.rows[2]).toEqual(['Total', '', '', 1100, 500, 120]);
  });

  it('every row has as many cells as there are headings', () => {
    const before = new Map([['a', row('a')]]);
    const s = buildAdsSheet({ ...base, nameLabel: 'Ad', level: 'ad', rows: [row('a')], before, mainLabel: 'x', otherLabel: 'y', columns: [delivery, spend, leads] });
    for (const r of s.rows) expect(r).toHaveLength(s.headers.length);
  });

  it('names the file by what it holds', () => {
    expect(adsFileName('Ad sets', { since: '2026-11-01', until: '2026-11-06' }, 'this_month')).toBe('Ads_Ad_sets_2026-11-01_to_2026-11-06.xlsx');
    expect(adsFileName('Ads', null, 'maximum')).toBe('Ads_Ads_maximum.xlsx');
    expect(adsFileName('Ads', { since: 'a', until: 'b' }, 'x', { since: 'c', until: 'd' })).toBe('Ads_Ads_a_to_b_vs_c_to_d.xlsx');
  });
});
