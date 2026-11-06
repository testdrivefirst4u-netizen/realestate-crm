/**
 * Business Profile (plan feature businessProfile, off by default; screen /businessprofile): the company's Google Business
 * Profile as its team keeps it and as customers see it, its figures, and editing it. Uses the Google account of
 * Settings › Google ("Connect with Google", permission business.manage).
 *
 * Profile  = Business Information API locations.get, and :getGoogleUpdated for the public version. diffMask = what differs
 *            from the company's own details, pendingMask = its edits Google has not published yet.
 * Figures  = Performance API fetchMultiDailyMetricsTimeSeries; a day without a value is zero. They come a few days late, so
 *            the ranges end 3 days ago. Search terms = searchkeywords monthly; small counts are given only as "below N".
 * Editing = locations.patch with an updateMask of only what really changed, compared with Google's details at that moment.
 *            A version of the details the form opened from refuses an edit over someone else's. validateOnly tests without
 *            changing anything. Service area needs Google's place lists, so it stays in Google for now.
 * Kept 15 minutes.
 */
import { createHash } from 'crypto';
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { BUSINESS_SCOPE, gbpFetch } from './googleMarketing';

const INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const PERF = 'https://businessprofileperformance.googleapis.com/v1';
const READ_MASK = 'name,title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceArea,profile,openInfo,metadata';
const CACHE_MS = 15 * 60000;
const DAY_MS = 86400000;
const LAG_DAYS = 3;
const cache = new Map<string, { at: number; data: unknown }>();
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const VIEWS = { searchMobile: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', searchDesktop: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', mapsMobile: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', mapsDesktop: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS' };
const ACTIONS = { calls: 'CALL_CLICKS', website: 'WEBSITE_CLICKS', directions: 'BUSINESS_DIRECTION_REQUESTS', messages: 'MESSAGING_CLICKS', bookings: 'BUSINESS_BOOKINGS' };
const METRIC_KEY: Record<string, string> = Object.fromEntries(Object.entries({ ...VIEWS, ...ACTIONS }).map(([k, v]) => [v, k]));

export interface ProfileHours { day: string; text: string }
export interface ProfileView {
  name: string; title: string; phone: string; otherPhones: string[]; category: string; otherCategories: string[]; address: string; website: string; description: string; status: string;
  hours: ProfileHours[]; specialHours: ProfileHours[]; serviceAreas: string[];
}
export interface BusinessProfileData {
  error: string; locations: Array<{ name: string; title: string }>; location: string; profile: ProfileView | null; live: ProfileView | null; liveError: string;
  fields: Array<{ id: string; label: string; value: string; live: string; state: 'live' | 'pending' | 'changed' }>;
  mapsUri: string; reviewUri: string; managed: boolean; duplicate: boolean; rating: { average: number; total: number } | null; fetchedAt: string;
  /** The form's values, and the version they were read at. */
  edit: ProfileEdit | null; version: string;
}
export interface ProfileEdit {
  title: string; phone: string; otherPhones: string[]; website: string; description: string; status: string; regionCode: string;
  category: { name: string; displayName: string } | null; otherCategories: Array<{ name: string; displayName: string }>;
  address: { lines: string[]; sublocality: string; locality: string; administrativeArea: string; postalCode: string };
  hours: Array<{ day: string; open: string; close: string }>;
  specialHours: Array<{ date: string; closed: boolean; open: string; close: string }>;
}
export interface BusinessPerformance {
  error: string; location: string; from: string; to: string; prevFrom: string; prevTo: string; totals: Record<string, number>; prevTotals: Record<string, number> | null;
  daily: Array<{ day: string; prevDay: string; values: Record<string, number>; prev: Record<string, number> | null }>;
  keywords: Array<{ keyword: string; value: number; below: boolean }>; keywordsFrom: string; keywordsTo: string; keywordsError: string; fetchedAt: string;
}

const safeLink = (v: unknown, schemes = ['https:', 'http:']): string => {
  try {
    const u = new URL(String(v || ''));
    return schemes.includes(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
};
function clock(t: any): string {
  const h = Number(t?.hours) || 0, m = Number(t?.minutes) || 0;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h % 24 < 12 ? 'am' : 'pm'}`;
}
const dateText = (d: any) => `${d?.year}-${String(d?.month).padStart(2, '0')}-${String(d?.day).padStart(2, '0')}`;

/** Google's location, in the words and order the screen shows. */
export function readProfile(l: any): ProfileView {
  const a = l?.storefrontAddress || {};
  const periods: any[] = Array.isArray(l?.regularHours?.periods) ? l.regularHours.periods : [];
  const hours = periods.length ? DAYS.map((day) => {
    const today = periods.filter((p) => p?.openDay === day);
    const allDay = today.some((p) => !(Number(p?.openTime?.hours) || 0) && !(Number(p?.openTime?.minutes) || 0) && Number(p?.closeTime?.hours) === 24);
    return { day: day[0] + day.slice(1).toLowerCase(), text: !today.length ? 'Closed' : allDay ? 'Open 24 hours' : today.map((p) => `${clock(p.openTime)} to ${clock(p.closeTime)}`).join(', ') };
  }) : [];
  const special: any[] = Array.isArray(l?.specialHours?.specialHourPeriods) ? l.specialHours.specialHourPeriods : [];
  return {
    name: String(l?.name || ''), title: String(l?.title || ''),
    phone: String(l?.phoneNumbers?.primaryPhone || ''), otherPhones: (l?.phoneNumbers?.additionalPhones || []).map(String),
    category: String(l?.categories?.primaryCategory?.displayName || ''), otherCategories: (l?.categories?.additionalCategories || []).map((c: any) => String(c?.displayName || '')).filter(Boolean),
    address: [...(a.addressLines || []), a.sublocality, a.locality, a.administrativeArea, a.postalCode].filter(Boolean).join(', '),
    website: safeLink(l?.websiteUri), description: String(l?.profile?.description || ''), status: String(l?.openInfo?.status || ''),
    hours, specialHours: special.map((p) => ({ day: dateText(p?.startDate), text: p?.closed ? 'Closed' : `${clock(p?.openTime)} to ${clock(p?.closeTime)}` })),
    serviceAreas: (l?.serviceArea?.places?.placeInfos || []).map((p: any) => String(p?.placeName || '')).filter(Boolean),
  };
}

const STATUS: Record<string, string> = { OPEN: 'Open', CLOSED_TEMPORARILY: 'Temporarily closed', CLOSED_PERMANENTLY: 'Permanently closed' };
const hoursText = (h: ProfileHours[]) => h.map((x) => `${x.day}: ${x.text}`).join('\n');
const FIELDS: Array<{ id: string; label: string; show: (p: ProfileView) => string }> = [
  { id: 'title', label: 'Business name', show: (p) => p.title },
  { id: 'categories', label: 'Category', show: (p) => [p.category, ...p.otherCategories].filter(Boolean).join(', ') },
  { id: 'profile', label: 'Description', show: (p) => p.description },
  { id: 'openInfo', label: 'Status', show: (p) => STATUS[p.status] || p.status },
  { id: 'phoneNumbers', label: 'Phone', show: (p) => [p.phone, ...p.otherPhones].filter(Boolean).join(', ') },
  { id: 'websiteUri', label: 'Website', show: (p) => p.website },
  { id: 'storefrontAddress', label: 'Address', show: (p) => p.address },
  { id: 'serviceArea', label: 'Service area', show: (p) => p.serviceAreas.join(', ') },
  { id: 'regularHours', label: 'Hours', show: (p) => hoursText(p.hours) },
  { id: 'specialHours', label: 'Special hours', show: (p) => hoursText(p.specialHours) },
];
const topFields = (mask: unknown) => new Set(String(mask || '').split(',').map((s) => s.trim().split('.')[0]).filter(Boolean));

async function connection() {
  const d = await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'google' });
  if (!d?.connectionId) return { error: 'Connect your Google account in Settings › Google.', d };
  if (!(d.scopes || []).includes(BUSINESS_SCOPE)) return { error: 'Google access to the Business Profile was not given. Connect again in Settings › Google and tick the permission.', d };
  return { error: '', d };
}
/** The location asked for must be one this connection reaches. */
function pick(d: any, wanted: unknown): { name: string; title: string; account: string } | null {
  const list: any[] = d?.gbpLocations || [];
  if (wanted) {
    const hit = list.find((l) => l.name === String(wanted));
    if (!hit) throw fail('VALIDATION', 'Choose one of your Business Profile locations.');
    return hit;
  }
  return d?.gbpLocation?.name ? d.gbpLocation : list[0] || null;
}
const key = (...parts: unknown[]) => JSON.stringify([currentTenant()?.id || '', ...parts]);
const short = (e: any) => truncate(String(e?.message || e), 300);
function remember<T extends object>(k: string, data: T): T {
  if (cache.size >= 200) cache.clear();
  cache.set(k, { at: Date.now(), data });
  return data;
}

export async function getBusinessProfile(d: any = {}, now = new Date()): Promise<BusinessProfileData> {
  const { error, d: doc } = await connection();
  const locations = (doc?.gbpLocations || []).map((l: any) => ({ name: String(l.name), title: String(l.title) }));
  const empty: BusinessProfileData = { error, locations, location: '', profile: null, live: null, liveError: '', fields: [], mapsUri: '', reviewUri: '', managed: true, duplicate: false, rating: null, fetchedAt: now.toISOString(), edit: null, version: '' };
  if (error) return empty;
  const loc = pick(doc, d?.location);
  if (!loc) return { ...empty, error: doc?.setupError || 'No Business Profile location found. Click Refresh accounts in Settings › Google.' };
  const k = key('profile', loc.name);
  const hit = cache.get(k);
  if (!d?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data as BusinessProfileData;
  try {
    const raw = await gbpFetch<any>(`${INFO}/${loc.name}?readMask=${READ_MASK}`);
    const profile = readProfile(raw);
    let live: ProfileView | null = null;
    let liveError = '';
    let diff = new Set<string>();
    let pending = new Set<string>();
    try {
      const u = await gbpFetch<any>(`${INFO}/${loc.name}:getGoogleUpdated?readMask=${READ_MASK}`);
      live = readProfile(u?.location);
      diff = topFields(u?.diffMask);
      pending = topFields(u?.pendingMask);
    } catch (e) {
      liveError = short(e);
    }
    let rating: BusinessProfileData['rating'] = null;
    if (loc.account) {
      try {
        const r = await gbpFetch<any>(`https://mybusiness.googleapis.com/v4/${loc.account}/${loc.name}/reviews?pageSize=1`);
        if (r?.totalReviewCount !== undefined) rating = { average: Number(r.averageRating) || 0, total: Number(r.totalReviewCount) || 0 };
      } catch {
        /* the rating is an extra: the profile still shows */
      }
    }
    return remember(k, {
      ...empty, location: loc.name, profile, live, liveError, rating,
      // one that is waiting is told first: its difference from the public version is expected
      fields: FIELDS.map((f) => ({ id: f.id, label: f.label, value: f.show(profile), live: live ? f.show(live) : '', state: pending.has(f.id) ? 'pending' as const : diff.has(f.id) ? 'changed' as const : 'live' as const })),
      mapsUri: safeLink(raw?.metadata?.mapsUri, ['https:']), reviewUri: safeLink(raw?.metadata?.newReviewUri, ['https:']),
      managed: raw?.metadata?.hasVoiceOfMerchant !== false, duplicate: !!raw?.metadata?.duplicateLocation,
      edit: readEdit(raw), version: versionOf(raw),
    });
  } catch (e) {
    return { ...empty, location: loc.name, error: short(e) };
  }
}

/* ---------------------------------- editing --------------------------------- */

const hhmm = (t: any) => `${String(Number(t?.hours) || 0).padStart(2, '0')}:${String(Number(t?.minutes) || 0).padStart(2, '0')}`;
const byDay = (a: { day: string; open: string }, b: { day: string; open: string }) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.open.localeCompare(b.open);
const byDate = (a: { date: string; open: string }, b: { date: string; open: string }) => a.date.localeCompare(b.date) || a.open.localeCompare(b.open);

/** Google's location as the form's values. */
export function readEdit(l: any): ProfileEdit {
  const a = l?.storefrontAddress || {};
  const cat = (c: any) => ({ name: String(c?.name || ''), displayName: String(c?.displayName || '') });
  return {
    title: String(l?.title || ''), phone: String(l?.phoneNumbers?.primaryPhone || ''), otherPhones: (l?.phoneNumbers?.additionalPhones || []).map(String), website: String(l?.websiteUri || ''),
    description: String(l?.profile?.description || ''), status: String(l?.openInfo?.status || 'OPEN'), regionCode: String(a.regionCode || l?.serviceArea?.regionCode || 'IN'),
    category: l?.categories?.primaryCategory ? cat(l.categories.primaryCategory) : null, otherCategories: (l?.categories?.additionalCategories || []).map(cat),
    address: { lines: (a.addressLines || []).map(String), sublocality: String(a.sublocality || ''), locality: String(a.locality || ''), administrativeArea: String(a.administrativeArea || ''), postalCode: String(a.postalCode || '') },
    hours: (l?.regularHours?.periods || []).map((p: any) => ({ day: String(p?.openDay), open: hhmm(p?.openTime), close: hhmm(p?.closeTime) })).sort(byDay),
    specialHours: (l?.specialHours?.specialHourPeriods || []).map((p: any) => ({ date: dateText(p?.startDate), closed: !!p?.closed, open: p?.closed ? '' : hhmm(p?.openTime), close: p?.closed ? '' : hhmm(p?.closeTime) })).sort(byDate),
  };
}
const versionOf = (raw: any) => createHash('sha256').update(JSON.stringify(readEdit(raw))).digest('hex').slice(0, 24);

const bad = (m: string) => fail('VALIDATION', m);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeOf = (s: string) => {
  const [hours, minutes] = s.split(':').map(Number);
  return { hours, minutes };
};
const minutesOf = (s: string) => timeOf(s).hours * 60 + timeOf(s).minutes;
const nextDay = (day: string) => DAYS[(DAYS.indexOf(day) + 1) % 7];

function cleanHours(input: unknown): ProfileEdit['hours'] {
  if (!Array.isArray(input) || input.length > 70) throw bad('Those hours are not valid.');
  const out = input.map((h: any) => {
    const day = String(h?.day), open = String(h?.open), close = String(h?.close);
    if (!DAYS.includes(day) || !TIME.test(open) || !(TIME.test(close) || close === '24:00')) throw bad('Enter an opening and closing time for each day.');
    return { day, open, close };
  }).sort(byDay);
  out.forEach((h, i) => {
    const n = out[i + 1];
    if (n && n.day === h.day && minutesOf(n.open) < (h.close === '24:00' ? 1440 : minutesOf(h.close)) && minutesOf(h.close) > minutesOf(h.open)) throw bad(`The hours on ${h.day[0]}${h.day.slice(1).toLowerCase()} overlap.`);
  });
  return out;
}
function cleanSpecial(input: unknown): ProfileEdit['specialHours'] {
  if (!Array.isArray(input) || input.length > 100) throw bad('Those special hours are not valid.');
  return input.map((s: any) => {
    const date = String(s?.date || ''), closed = !!s?.closed, open = closed ? '' : String(s?.open), close = closed ? '' : String(s?.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw bad('Choose a date for each special day.');
    if (!closed && (!TIME.test(open) || !(TIME.test(close) || close === '24:00'))) throw bad(`Enter the opening and closing time for ${date}, or mark it closed.`);
    return { date, closed, open, close };
  }).sort(byDate);
}
const googleDate = (s: string) => {
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
};

/** Only what really differs from Google's details now, as Google wants it. Parts sent whole are those Google updates whole. */
export function buildPatch(raw: any, c: any): { body: any; mask: string[]; changed: string[]; sensitive: string[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const cur = readEdit(raw);
  const body: any = {}, mask: string[] = [], changed: string[] = [], sensitive: string[] = [], before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  const add = (label: string, m: string, was: unknown, now: unknown, apply: () => void, careful = false) => {
    if (JSON.stringify(was) === JSON.stringify(now)) return;
    apply();
    mask.push(m);
    changed.push(label);
    before[label] = was;
    after[label] = now;
    if (careful) sensitive.push(label);
  };
  if (c.title !== undefined) {
    const title = String(c.title).trim();
    if (!title) throw bad('Enter the business name.');
    add('Business name', 'title', cur.title, title, () => { body.title = title; }, true);
  }
  if (c.phone !== undefined || c.otherPhones !== undefined) {
    const phone = String(c.phone ?? cur.phone).trim();
    const others = (Array.isArray(c.otherPhones) ? c.otherPhones : cur.otherPhones).map((p: unknown) => String(p).trim()).filter(Boolean);
    if (!/^\+?[\d\s()-]{6,24}$/.test(phone)) throw bad('Enter the primary phone number, like +91 98765 43210.');
    if (others.length > 2 || others.some((p: string) => !/^\+?[\d\s()-]{6,24}$/.test(p))) throw bad('Enter up to two other phone numbers, like +91 98765 43210.');
    add('Phone', 'phoneNumbers', [cur.phone, ...cur.otherPhones], [phone, ...others], () => { body.phoneNumbers = { primaryPhone: phone, additionalPhones: others }; });
  }
  if (c.website !== undefined) {
    const website = String(c.website).trim();
    if (website && !safeLink(website)) throw bad('Enter the website as a full address, starting with https://');
    add('Website', 'websiteUri', cur.website, website, () => { if (website) body.websiteUri = website; });
  }
  if (c.description !== undefined) {
    const description = String(c.description).trim();
    add('Description', 'profile.description', cur.description, description, () => { body.profile = { description }; });
  }
  if (c.status !== undefined) {
    const status = String(c.status);
    if (!['OPEN', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'].includes(status)) throw bad('Choose a status.');
    add('Status', 'openInfo.status', cur.status, status, () => { body.openInfo = { status }; }, status === 'CLOSED_PERMANENTLY');
  }
  if (c.category !== undefined || c.otherCategories !== undefined) {
    const name = (x: any) => String(x?.name || '');
    const primary = name(c.category ?? cur.category);
    const others = (Array.isArray(c.otherCategories) ? c.otherCategories : cur.otherCategories).map(name).filter(Boolean);
    if (!primary) throw bad('Choose the primary category.');
    add('Category', 'categories', [name(cur.category), ...cur.otherCategories.map(name)], [primary, ...others], () => { body.categories = { primaryCategory: { name: primary }, additionalCategories: others.map((n: string) => ({ name: n })) }; }, true);
  }
  if (c.address !== undefined) {
    const a = c.address || {};
    const lines = (Array.isArray(a.lines) ? a.lines : []).map((l: unknown) => String(l).trim()).filter(Boolean);
    const next = { lines, sublocality: String(a.sublocality || '').trim(), locality: String(a.locality || '').trim(), administrativeArea: String(a.administrativeArea || '').trim(), postalCode: String(a.postalCode || '').trim() };
    if (!lines.length || lines.length > 5 || !next.locality) throw bad('Enter the address line and the city.');
    // what the form does not show, such as the country, stays as Google has it
    add('Address', 'storefrontAddress', cur.address, next, () => { body.storefrontAddress = { regionCode: cur.regionCode, ...(raw?.storefrontAddress || {}), addressLines: lines, sublocality: next.sublocality, locality: next.locality, administrativeArea: next.administrativeArea, postalCode: next.postalCode }; }, true);
  }
  const hours = c.hours !== undefined ? cleanHours(c.hours) : cur.hours;
  const special = c.specialHours !== undefined ? cleanSpecial(c.specialHours) : cur.specialHours;
  if (!hours.length && special.length) throw bad('Google needs regular hours before it can show special hours.');
  if (c.hours !== undefined) {
    add('Hours', 'regularHours', cur.hours, hours, () => {
      if (hours.length) body.regularHours = { periods: hours.map((h) => ({ openDay: h.day, openTime: timeOf(h.open), closeDay: h.close !== '24:00' && minutesOf(h.close) <= minutesOf(h.open) ? nextDay(h.day) : h.day, closeTime: h.close === '24:00' ? { hours: 24, minutes: 0 } : timeOf(h.close) })) };
    });
  }
  if (c.specialHours !== undefined) {
    add('Special hours', 'specialHours', cur.specialHours, special, () => {
      if (special.length) body.specialHours = { specialHourPeriods: special.map((s) => {
        if (s.closed) return { startDate: googleDate(s.date), closed: true };
        const overnight = s.close !== '24:00' && minutesOf(s.close) <= minutesOf(s.open);
        return { startDate: googleDate(s.date), openTime: timeOf(s.open), closeTime: s.close === '24:00' ? { hours: 24, minutes: 0 } : timeOf(s.close), ...(overnight ? { endDate: googleDate(ymd(Date.parse(s.date) + DAY_MS)) } : {}) };
      }) };
    });
  }
  return { body, mask, changed, sensitive, before, after };
}

export async function updateBusinessProfile(d: any, ctx: Ctx): Promise<{ validated: boolean; changed: string[]; profile: BusinessProfileData | null }> {
  const { error, d: doc } = await connection();
  if (error) throw bad(error);
  if (!d?.location) throw bad('Choose a location.');
  const loc = pick(doc, d.location)!;
  const raw = await gbpFetch<any>(`${INFO}/${loc.name}?readMask=${READ_MASK}`);
  if (String(d?.version || '') !== versionOf(raw)) throw fail('CONFLICT', 'This profile has changed since you opened the form. Close it, click Refresh, and try again.');
  const p = buildPatch(raw, d?.changes || {});
  if (!p.mask.length) throw bad('Nothing has changed.');
  const validateOnly = d?.validateOnly === true;
  if (!validateOnly && p.sensitive.length && d?.confirm !== true) throw bad(`Confirm the change to ${p.sensitive.join(', ')} first.`);
  const q = new URLSearchParams({ updateMask: p.mask.join(',') });
  if (validateOnly) q.set('validateOnly', 'true');
  try {
    await gbpFetch(`${INFO}/${loc.name}?${q.toString()}`, { method: 'PATCH', body: p.body });
  } catch (e) {
    throw bad(short(e)); // Google's reason is what the person needs to fix it
  }
  if (validateOnly) return { validated: true, changed: p.changed, profile: null };
  clearBusinessProfileCache();
  await auditLog(ctx, 'Business Profile Edited', 'Settings', loc.name, `${loc.title}: ${p.changed.join(', ')}`, { before: p.before, after: p.after });
  return { validated: false, changed: p.changed, profile: await getBusinessProfile({ location: loc.name, refresh: true }) };
}

export async function searchBusinessCategories(d: any): Promise<Array<{ name: string; displayName: string }>> {
  const { error } = await connection();
  if (error) throw bad(error);
  const term = String(d?.q || '').trim().slice(0, 60);
  if (term.length < 2) return [];
  const regionCode = /^[A-Za-z]{2}$/.test(String(d?.regionCode || '')) ? String(d.regionCode).toUpperCase() : 'IN';
  const q = new URLSearchParams({ regionCode, languageCode: 'en', view: 'BASIC', pageSize: '20', filter: `displayName=${term}` });
  const j = await gbpFetch<any>(`${INFO}/categories?${q.toString()}`);
  return (j?.categories || []).map((c: any) => ({ name: String(c?.name || ''), displayName: String(c?.displayName || '') })).filter((c: any) => c.name);
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const partsOf = (s: string) => s.split('-').map(Number);

/** Whole days with figures, and the same number just before them. */
export function profileRange(d: any, now = new Date()) {
  const days = ({ last7: 7, last28: 28, last90: 90, last180: 180, last365: 365 } as Record<string, number>)[String(d?.preset || 'last28')];
  if (!days) throw fail('VALIDATION', 'Choose a date range.');
  const end = now.getTime() - LAG_DAYS * DAY_MS;
  const to = ymd(end), from = ymd(end - (days - 1) * DAY_MS);
  const prevEnd = end - days * DAY_MS;
  return { days, from, to, prevTo: ymd(prevEnd), prevFrom: ymd(prevEnd - (days - 1) * DAY_MS) };
}

async function dailyFigures(location: string, from: string, to: string): Promise<Map<string, Record<string, number>>> {
  const [fy, fm, fd] = partsOf(from), [ty, tm, td] = partsOf(to);
  const q = new URLSearchParams();
  for (const m of Object.keys(METRIC_KEY)) q.append('dailyMetrics', m);
  Object.entries({ 'dailyRange.start_date.year': fy, 'dailyRange.start_date.month': fm, 'dailyRange.start_date.day': fd, 'dailyRange.end_date.year': ty, 'dailyRange.end_date.month': tm, 'dailyRange.end_date.day': td }).forEach(([a, b]) => q.set(a, String(b)));
  const j = await gbpFetch<any>(`${PERF}/${location}:fetchMultiDailyMetricsTimeSeries?${q.toString()}`);
  const out = new Map<string, Record<string, number>>();
  for (const group of j?.multiDailyMetricTimeSeries || []) {
    for (const series of group?.dailyMetricTimeSeries || []) {
      const id = METRIC_KEY[String(series?.dailyMetric)];
      if (!id) continue;
      for (const point of series?.timeSeries?.datedValues || []) {
        const day = dateText(point?.date);
        const row = out.get(day) || {};
        row[id] = Number(point?.value) || 0; // Google leaves the value out when it is zero
        out.set(day, row);
      }
    }
  }
  return out;
}
const ALL_KEYS = [...Object.keys(VIEWS), ...Object.keys(ACTIONS)];
function dayValues(row: Record<string, number> | undefined): Record<string, number> {
  const v: Record<string, number> = {};
  for (const k of ALL_KEYS) v[k] = row?.[k] || 0;
  v.views = Object.keys(VIEWS).reduce((t, k) => t + v[k], 0);
  return v;
}
const addUp = (rows: Array<Record<string, number>>) => rows.reduce<Record<string, number>>((t, r) => {
  for (const k of Object.keys(r)) t[k] = (t[k] || 0) + r[k];
  return t;
}, {});

export async function getBusinessPerformance(d: any = {}, now = new Date()): Promise<BusinessPerformance> {
  const range = profileRange(d, now);
  const { days, ...dates } = range;
  const { error, d: doc } = await connection();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = (x: Date) => x.toISOString().slice(0, 7);
  const empty: BusinessPerformance = { error, location: '', ...dates, totals: {}, prevTotals: null, daily: [], keywords: [], keywordsFrom: month(first), keywordsTo: month(last), keywordsError: '', fetchedAt: now.toISOString() };
  if (error) return empty;
  const loc = pick(doc, d?.location);
  if (!loc) return { ...empty, error: doc?.setupError || 'No Business Profile location found. Click Refresh accounts in Settings › Google.' };
  const k = key('figures', loc.name, range.from, range.to);
  const hit = cache.get(k);
  if (!d?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data as BusinessPerformance;
  try {
    const [nowFigures, prevFigures] = await Promise.all([dailyFigures(loc.name, range.from, range.to), dailyFigures(loc.name, range.prevFrom, range.prevTo).catch(() => null)]);
    const daily = Array.from({ length: days }, (_, i) => {
      const day = ymd(Date.parse(range.from) + i * DAY_MS), prevDay = ymd(Date.parse(range.prevFrom) + i * DAY_MS);
      return { day, prevDay, values: dayValues(nowFigures.get(day)), prev: prevFigures ? dayValues(prevFigures.get(prevDay)) : null };
    });
    let keywords: BusinessPerformance['keywords'] = [];
    let keywordsError = '';
    try {
      const q = new URLSearchParams({ 'monthlyRange.start_month.year': String(first.getUTCFullYear()), 'monthlyRange.start_month.month': String(first.getUTCMonth() + 1), 'monthlyRange.end_month.year': String(last.getUTCFullYear()), 'monthlyRange.end_month.month': String(last.getUTCMonth() + 1), pageSize: '100' });
      const j = await gbpFetch<any>(`${PERF}/${loc.name}/searchkeywords/impressions/monthly?${q.toString()}`);
      keywords = (j?.searchKeywordsCounts || []).map((x: any) => {
        const below = x?.insightsValue?.value === undefined && x?.insightsValue?.threshold !== undefined;
        return { keyword: String(x?.searchKeyword || ''), value: Number(below ? x.insightsValue.threshold : x?.insightsValue?.value) || 0, below };
      }).sort((a: any, b: any) => b.value - a.value);
    } catch (e) {
      keywordsError = short(e);
    }
    return remember(k, { ...empty, location: loc.name, daily, totals: addUp(daily.map((x) => x.values)), prevTotals: prevFigures ? addUp(daily.map((x) => x.prev!)) : null, keywords, keywordsError });
  } catch (e) {
    return { ...empty, location: loc.name, error: short(e) };
  }
}

export function clearBusinessProfileCache() {
  cache.clear();
}

const feature = () => {
  if (!(currentTenant()?.features as any)?.businessProfile) throw fail('FORBIDDEN', "The Business Profile screen is not included in your company's plan.");
};

export const actions: ActionMap = {
  getBusinessProfile: { fn: (d) => { feature(); return getBusinessProfile(d); }, perm: 'reports.view' },
  getBusinessPerformance: { fn: (d) => { feature(); return getBusinessPerformance(d); }, perm: 'reports.view' },
  updateBusinessProfile: { fn: (d, ctx) => { feature(); return updateBusinessProfile(d, ctx); }, perm: 'integrations.connect' },
  searchBusinessCategories: { fn: (d) => { feature(); return searchBusinessCategories(d); }, perm: 'integrations.connect' },
};
