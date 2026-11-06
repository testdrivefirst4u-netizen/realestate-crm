/** The Ad Library screen's rules, and that its cards draw with what a saved ad can really hold. */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdCard } from '../src/modules/competitors/AdCard';
import { NO_FILTERS, filtersOn, libraryItems, runningDays, screenshotProblem, type LibraryItem } from '../src/modules/competitors/adLibrary';

const ad = (id: string, patch: Record<string, unknown> = {}) => ({ id, platform: 'meta', link: '', imageUrl: '', offer: '', project: '', price: '', format: 'image', note: '', seenOn: '2026-11-01', active: true, startedOn: '', libraryId: '', placements: [], createdBy: 'Asha', ...patch }) as any;
const item = (a: any, name = 'Rival', competitorId = 'C1'): LibraryItem => ({ ad: a, name, competitorId });
const TODAY = '2026-11-06';
const ids = (list: LibraryItem[]) => list.map((x) => x.ad.id);

describe('how long an ad has run', () => {
  it('counts from the saved start date', () => {
    expect(runningDays(ad('a', { startedOn: '2026-11-01' }), TODAY)).toBe(5);
    expect(runningDays(ad('a', { startedOn: TODAY }), TODAY)).toBe(0);
  });
  it('says nothing it cannot know', () => {
    expect(runningDays(ad('a'), TODAY)).toBeNull();
    expect(runningDays(ad('a', { startedOn: '2026-11-01', active: false }), TODAY)).toBeNull();
    expect(runningDays(ad('a', { startedOn: '2026-12-01' }), TODAY)).toBeNull();
  });
  it('crosses a change of clocks and months exactly', () => {
    expect(runningDays(ad('a', { startedOn: '2026-02-28' }), '2026-03-01')).toBe(1);
  });
});

describe('finding ads', () => {
  const list = [
    item(ad('old', { seenOn: '2026-10-01', offer: 'No pre-EMI', startedOn: '2026-01-01' })),
    item(ad('new', { seenOn: '2026-11-05', project: 'Skyline', platform: 'google', format: 'video' }), 'Other', 'C2'),
    item(ad('off', { seenOn: '2026-11-06', active: false, price: '₹1.2 Cr' })),
  ];
  it('shows active first, then newest', () => {
    expect(ids(libraryItems(list, NO_FILTERS, TODAY))).toEqual(['new', 'old', 'off']);
  });
  it('can show the longest running first, ads with no start date after', () => {
    expect(ids(libraryItems(list, { ...NO_FILTERS, sort: 'longest' }, TODAY))[0]).toBe('old');
  });
  it('filters and searches together', () => {
    expect(ids(libraryItems(list, { ...NO_FILTERS, competitorId: 'C2' }, TODAY))).toEqual(['new']);
    expect(ids(libraryItems(list, { ...NO_FILTERS, status: 'inactive' }, TODAY))).toEqual(['off']);
    expect(ids(libraryItems(list, { ...NO_FILTERS, platform: 'google', format: 'video' }, TODAY))).toEqual(['new']);
    expect(ids(libraryItems(list, { ...NO_FILTERS, q: ' pre-emi ' }, TODAY))).toEqual(['old']);
    expect(ids(libraryItems(list, { ...NO_FILTERS, q: 'other' }, TODAY))).toEqual(['new']);
    expect(libraryItems(list, { ...NO_FILTERS, q: 'nothing like this' }, TODAY)).toEqual([]);
  });
  it('sorting does not disturb the list it was given', () => {
    const before = ids(list);
    libraryItems(list, NO_FILTERS, TODAY);
    expect(ids(list)).toEqual(before);
  });
  it('knows when filters are on, sorting aside', () => {
    expect(filtersOn({ ...NO_FILTERS, sort: 'longest' })).toBe(false);
    expect(filtersOn({ ...NO_FILTERS, status: 'active' })).toBe(true);
    expect(filtersOn({ ...NO_FILTERS, q: '   ' })).toBe(false);
  });
});

describe('screenshots', () => {
  it('takes what the server takes', () => {
    expect(screenshotProblem({ type: 'image/png', size: 1000 })).toBe('');
    expect(screenshotProblem({ type: 'image/webp', size: 1000 })).toMatch(/JPG or PNG/);
    expect(screenshotProblem({ type: 'image/jpeg', size: 3 * 1024 * 1024 + 1 })).toMatch(/3 MB/);
  });
});

describe('the card', () => {
  const draw = (a: any) => renderToStaticMarkup(React.createElement(AdCard, { ad: a, name: 'Rival', today: TODAY, onOpen: vi.fn() }));
  it('shows the screenshot, status, and how long it has run', () => {
    const html = draw(ad('a', { imageUrl: '/api/files/1', offer: 'No pre-EMI', startedOn: '2026-11-01' }));
    expect(html).toContain('/api/files/1');
    expect(html).toContain('Active');
    expect(html).toContain('Running 5 days');
  });
  it('still draws with nothing but a note, an unknown format and no start date', () => {
    const html = draw(ad('a', { note: 'Seen on a hoarding', format: 'mystery', active: false }));
    expect(html).toContain('Seen on a hoarding');
    expect(html).toContain('Inactive');
    expect(html).toContain('Other');
  });
});
