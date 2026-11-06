/** What the Ad Library screen shows: saved ads searched, filtered and sorted. No screen code, so the rules can be tested. */
import type { CompetitorAd } from '../../core/api';

export interface LibraryItem { ad: CompetitorAd; competitorId: string; name: string }
export type LibrarySort = 'recent' | 'longest';
export interface LibraryFilters { q: string; competitorId: string; platform: string; status: '' | 'active' | 'inactive'; format: string; sort: LibrarySort }
export const NO_FILTERS: LibraryFilters = { q: '', competitorId: '', platform: '', status: '', format: '', sort: 'recent' };

const dayNumber = (key: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : null;
};

/**
 * How long an active ad has been running, from the start date the team saved. Null when that is unknown, or the ad has stopped:
 * the day it stopped is not recorded, only the day someone noticed.
 */
export function runningDays(ad: Pick<CompetitorAd, 'active' | 'startedOn'>, today: string): number | null {
  if (!ad.active || !ad.startedOn) return null;
  const from = dayNumber(ad.startedOn), to = dayNumber(today);
  return from === null || to === null || to < from ? null : to - from;
}

export function libraryItems(items: LibraryItem[], f: LibraryFilters, today: string): LibraryItem[] {
  const term = f.q.trim().toLowerCase();
  const found = items.filter(({ ad, name, competitorId }) =>
    (!f.competitorId || competitorId === f.competitorId)
    && (!f.platform || ad.platform === f.platform)
    && (!f.status || ad.active === (f.status === 'active'))
    && (!f.format || ad.format === f.format)
    && (!term || [name, ad.offer, ad.project, ad.price, ad.note, ad.libraryId].join(' ').toLowerCase().includes(term)));
  const seen = (a: LibraryItem, b: LibraryItem) => b.ad.seenOn.localeCompare(a.ad.seenOn);
  return found.sort(f.sort === 'longest'
    ? (a, b) => (runningDays(b.ad, today) ?? -1) - (runningDays(a.ad, today) ?? -1) || seen(a, b)
    : (a, b) => Number(b.ad.active) - Number(a.ad.active) || seen(a, b));
}

export const filtersOn = (f: LibraryFilters) => !!(f.q.trim() || f.competitorId || f.platform || f.status || f.format);

/** Why a screenshot cannot be used ('' when it can). The server checks the same. */
export function screenshotProblem(file: { type: string; size: number }): string {
  if (!/^image\/(jpeg|png)$/.test(file.type)) return 'Use a JPG or PNG screenshot.';
  if (file.size > 3 * 1024 * 1024) return 'The screenshot is larger than 3 MB. Make it smaller first.';
  return '';
}
