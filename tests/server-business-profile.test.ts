/** Business Profile screen: the profile, the public version and what differs, the figures, and editing. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { encryptSecret } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { resetGoogleOAuthTokenCache } from '../server/modules/googleConnect';
import { BUSINESS_SCOPE, startGoogleMktConnect } from '../server/modules/googleMarketing';
import { buildPatch, clearBusinessProfileCache, getBusinessPerformance, getBusinessProfile, profileRange, readEdit, readProfile, searchBusinessCategories, updateBusinessProfile } from '../server/modules/businessProfile';

let t: Awaited<ReturnType<typeof startTestDb>>;
let asked: Array<{ url: URL; method: string; body?: any }> = [];
let refuse = '';
let patchRefused = false;
const now = new Date('2026-11-10T10:00:00Z');
const LOC = { name: 'locations/1', title: 'Amaya', account: 'accounts/9' };
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const place = {
  name: 'locations/1', title: 'Amaya', websiteUri: 'https://amaya.example/', phoneNumbers: { primaryPhone: '+91 90000 00000' }, categories: { primaryCategory: { displayName: 'Senior living' } },
  storefrontAddress: { addressLines: ['1 Road'], locality: 'Hyderabad', administrativeArea: 'Telangana', postalCode: '500001' }, profile: { description: 'Care' }, openInfo: { status: 'OPEN' },
  regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 9 }, closeDay: 'MONDAY', closeTime: { hours: 18, minutes: 30 } }, { openDay: 'SUNDAY', openTime: {}, closeDay: 'SUNDAY', closeTime: { hours: 24 } }] },
  metadata: { mapsUri: 'https://maps.google.com/?cid=1', newReviewUri: 'https://search.google.com/local/writereview?placeid=1', hasVoiceOfMerchant: true },
};

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'oauth2.googleapis.com') return json(200, { access_token: 'GAT', expires_in: 3600 });
  asked.push({ url, method: String(init.method || 'GET'), body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (refuse) return json(403, { error: { message: refuse } });
  if (init.method === 'PATCH' && patchRefused) return json(400, { error: { message: 'Request contains an invalid argument.', details: [{ fieldViolations: [{ field: 'title', description: 'Do not use special characters' }] }] } });
  if (init.method === 'PATCH') return json(200, place);
  if (url.pathname === '/v1/categories') return json(200, { categories: [{ name: 'categories/gcid:senior', displayName: 'Senior citizen center' }] });
  if (url.pathname.endsWith(':getGoogleUpdated')) return json(200, { location: { ...place, websiteUri: 'https://google-changed.example/', phoneNumbers: { primaryPhone: '+91 11111 11111' } }, diffMask: 'websiteUri,phoneNumbers.primaryPhone', pendingMask: 'phoneNumbers' });
  if (url.host === 'mybusinessbusinessinformation.googleapis.com') return json(200, place);
  if (url.host === 'mybusiness.googleapis.com') return json(200, { averageRating: 4.5, totalReviewCount: 12, reviews: [] });
  if (url.pathname.endsWith(':fetchMultiDailyMetricsTimeSeries')) {
    const y = url.searchParams.get('dailyRange.start_date.year'), m = url.searchParams.get('dailyRange.start_date.month'), d = url.searchParams.get('dailyRange.start_date.day');
    const date = { year: Number(y), month: Number(m), day: Number(d) };
    const series = (dailyMetric: string, value?: string) => ({ dailyMetric, timeSeries: { datedValues: [{ date, ...(value ? { value } : {}) }] } });
    return json(200, { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [series('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', '10'), series('BUSINESS_IMPRESSIONS_DESKTOP_MAPS', '5'), series('CALL_CLICKS', '3'), series('WEBSITE_CLICKS')] }] });
  }
  if (url.pathname.endsWith('/searchkeywords/impressions/monthly')) return json(200, { searchKeywordsCounts: [{ searchKeyword: 'rare', insightsValue: { threshold: '15' } }, { searchKeyword: 'senior living', insightsValue: { value: '200' } }] });
  return json(404, { error: { message: `unexpected ${url}` } });
}

beforeAll(async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret-123';
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'APP_URL']) delete process.env[k];
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { businessProfile: true });
  resetGoogleOAuthTokenCache();
  clearBusinessProfileCache();
  asked = [];
  refuse = '';
  patchRefused = false;
  vi.stubGlobal('fetch', vi.fn(fake));
  await inCo(async () => {
    await (await col<any>('googleConnections')).insertOne({ _id: 'GCN-0001', email: 'a@b.c', refreshToken: encryptSecret('RT'), scopes: [], status: 'Active', lastError: '', connectedBy: 'x', connectedAt: new Date() });
    await (await col<any>(CFG.COLL.INTEGRATIONS)).insertOne({ _id: 'google', connectionId: 'GCN-0001', email: 'a@b.c', scopes: [BUSINESS_SCOPE], gbpLocation: LOC, gbpLocations: [LOC, { name: 'locations/2', title: 'Second', account: 'accounts/9' }] });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function session(role: 'Admin' | 'Viewer' = 'Admin') {
  const email = `${role.toLowerCase()}@gbp.test`;
  return inCo(async () => {
    await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
    return (await login(email, 'long-enough-pw', { userAgent: 'vitest', ip: '10.9.9.9' })).token;
  });
}

describe('profile', () => {
  it('reads Google\'s details in plain words', () => {
    const p = readProfile(place);
    expect(p).toMatchObject({ title: 'Amaya', phone: '+91 90000 00000', category: 'Senior living', address: '1 Road, Hyderabad, Telangana, 500001', website: 'https://amaya.example/', description: 'Care' });
    expect(p.hours[0]).toEqual({ day: 'Monday', text: '9:00 am to 6:30 pm' });
    expect(p.hours[1]).toEqual({ day: 'Tuesday', text: 'Closed' });
    expect(p.hours[6]).toEqual({ day: 'Sunday', text: 'Open 24 hours' });
    expect(readProfile({ ...place, websiteUri: 'javascript:alert(1)' }).website).toBe('');
    expect(readProfile({}).hours).toEqual([]);
  });

  it('shows the public version and the state of each detail, and only reads', async () => {
    const r = await inCo(() => getBusinessProfile({}, now));
    expect(r.error).toBe('');
    expect(r.profile!.website).toBe('https://amaya.example/');
    expect(r.live!.website).toBe('https://google-changed.example/');
    const state = (id: string) => r.fields.find((f) => f.id === id)!;
    expect(state('websiteUri')).toMatchObject({ state: 'changed', value: 'https://amaya.example/', live: 'https://google-changed.example/' });
    expect(state('phoneNumbers').state).toBe('pending'); // both: our own edit is waiting
    expect(state('title').state).toBe('live');
    expect(r.rating).toEqual({ average: 4.5, total: 12 });
    expect(r.mapsUri).toBe('https://maps.google.com/?cid=1');
    expect(asked.every((a) => a.method === 'GET')).toBe(true);
  });

  it('keeps showing the profile when only an extra fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const u = String(input);
      return u.includes(':getGoogleUpdated') || u.includes('/reviews') ? json(403, { error: { message: 'Not allowed' } }) : fake(input, init);
    }));
    const r = await inCo(() => getBusinessProfile({}, now));
    expect(r.error).toBe('');
    expect(r.live).toBeNull();
    expect(r.liveError).toContain('Not allowed');
    expect(r.rating).toBeNull();
  });

  it('says what is missing, and passes on what Google says', async () => {
    refuse = 'Quota is 0';
    expect((await inCo(() => getBusinessProfile({}, now))).error).toContain('Quota is 0');
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'google' }, { $set: { scopes: [] } }));
    expect((await inCo(() => getBusinessProfile({}, now))).error).toMatch(/permission/);
    await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).deleteOne({ _id: 'google' }));
    expect((await inCo(() => getBusinessProfile({}, now))).error).toMatch(/Connect your Google/);
  });

  it('only opens a location this connection reaches, and keeps each one apart', async () => {
    await expect(inCo(() => getBusinessProfile({ location: 'locations/999' }, now))).rejects.toThrow(/Choose one/);
    await inCo(() => getBusinessProfile({ location: 'locations/2' }, now));
    expect(asked[0].url.pathname).toBe('/v1/locations/2');
    const before = asked.length;
    await inCo(() => getBusinessProfile({ location: 'locations/2' }, now));
    expect(asked.length).toBe(before);
  });
});

describe('figures', () => {
  it('ends 3 days ago, with the same number of days before', () => {
    expect(profileRange({ preset: 'last7' }, now)).toMatchObject({ from: '2026-11-01', to: '2026-11-07', prevFrom: '2026-10-25', prevTo: '2026-10-31' });
    expect(() => profileRange({ preset: 'forever' }, now)).toThrow(/date range/);
  });

  it('adds up the views and fills the days, a missing value being zero', async () => {
    const r = await inCo(() => getBusinessPerformance({ preset: 'last7' }, now));
    expect(r.error).toBe('');
    expect(r.daily).toHaveLength(7);
    expect(r.daily[0].values).toMatchObject({ views: 15, searchMobile: 10, mapsDesktop: 5, calls: 3, website: 0 });
    expect(r.daily[1].values.views).toBe(0);
    expect(r.totals).toMatchObject({ views: 15, calls: 3, website: 0 });
    expect(r.prevTotals).toMatchObject({ views: 15 });
    // both ranges are asked at once, so in either order
    const sent = asked.filter((a) => a.url.pathname.endsWith(':fetchMultiDailyMetricsTimeSeries')).map((a) => a.url.searchParams);
    expect(sent[0].getAll('dailyMetrics')).toContain('CALL_CLICKS');
    expect(sent.map((p) => p.get('dailyRange.end_date.month') + '-' + p.get('dailyRange.end_date.day')).sort()).toEqual(['10-31', '11-7']);
  });

  it('gives search terms, saying when Google only gives a limit', async () => {
    const r = await inCo(() => getBusinessPerformance({ preset: 'last7' }, now));
    expect(r.keywords).toEqual([{ keyword: 'senior living', value: 200, below: false }, { keyword: 'rare', value: 15, below: true }]);
    expect(r.keywordsFrom).toBe('2026-08');
    expect(r.keywordsTo).toBe('2026-10');
  });

  it('keeps the figures when search terms fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => (String(input).includes('searchkeywords') ? json(403, { error: { message: 'No terms' } }) : fake(input, init))));
    const r = await inCo(() => getBusinessPerformance({ preset: 'last7' }, now));
    expect(r.totals.views).toBe(15);
    expect(r.keywordsError).toContain('No terms');
  });
});

describe('editing', () => {
  const version = async () => (await inCo(() => getBusinessProfile({ refresh: true }, now))).version;
  const send = (extra: any) => inCo(async () => updateBusinessProfile({ location: 'locations/1', version: await version(), ...extra }, ctx));
  const patches = () => asked.filter((a) => a.method === 'PATCH');

  it('sends only what really changed, and logs it', async () => {
    const r = await send({ changes: { description: 'New words', title: 'Amaya' } });
    expect(r.changed).toEqual(['Description']);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].url.pathname).toBe('/v1/locations/1');
    expect(patches()[0].url.searchParams.get('updateMask')).toBe('profile.description');
    expect(patches()[0].body).toEqual({ profile: { description: 'New words' } });
    const log = await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).findOne({ action: 'Business Profile Edited' }));
    expect(log?.details).toContain('Description');
  });

  it('checking with Google changes nothing and logs nothing', async () => {
    const r = await send({ changes: { description: 'New words' }, validateOnly: true });
    expect(r).toMatchObject({ validated: true, profile: null });
    expect(patches()[0].url.searchParams.get('validateOnly')).toBe('true');
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Business Profile Edited' }))).toBe(0);
  });

  it('refuses when nothing changed, and an edit over someone else\'s', async () => {
    await expect(send({ changes: { title: 'Amaya' } })).rejects.toThrow(/Nothing has changed/);
    await expect(inCo(() => updateBusinessProfile({ location: 'locations/1', version: 'old', changes: { description: 'x' } }, ctx))).rejects.toThrow(/changed since/);
    expect(patches()).toHaveLength(0);
  });

  it('asks for confirmation before a change that can affect verification', async () => {
    await expect(send({ changes: { title: 'New name' } })).rejects.toThrow(/Confirm/);
    await expect(send({ changes: { status: 'CLOSED_PERMANENTLY' } })).rejects.toThrow(/Confirm/);
    expect(patches()).toHaveLength(0);
    expect((await send({ changes: { title: 'New name' }, validateOnly: true })).validated).toBe(true);
    expect((await send({ changes: { title: 'New name' }, confirm: true })).changed).toEqual(['Business name']);
    expect((await send({ changes: { status: 'CLOSED_TEMPORARILY' } })).changed).toEqual(['Status']);
  });

  it('passes on Google\'s reason for refusing', async () => {
    patchRefused = true;
    await expect(send({ changes: { description: 'x' } })).rejects.toThrow(/special characters/);
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Business Profile Edited' }))).toBe(0);
  });

  it('sends phones together, keeping the other numbers', () => {
    const raw = { ...place, phoneNumbers: { primaryPhone: '+91 90000 00000', additionalPhones: ['+91 80000 00000'] } };
    const p = buildPatch(raw, { phone: '+91 70000 00000' });
    expect(p.mask).toEqual(['phoneNumbers']);
    expect(p.body.phoneNumbers).toEqual({ primaryPhone: '+91 70000 00000', additionalPhones: ['+91 80000 00000'] });
    expect(() => buildPatch(raw, { phone: 'call me' })).toThrow(/primary phone/);
    expect(() => buildPatch(raw, { otherPhones: ['+91 1111111', '+91 2222222', '+91 3333333'] })).toThrow(/up to two/);
  });

  it('keeps address details the form does not show', () => {
    const raw = { ...place, storefrontAddress: { ...place.storefrontAddress, regionCode: 'IN', languageCode: 'en' } };
    const cur = readEdit(raw).address;
    const p = buildPatch(raw, { address: { ...cur, lines: ['2 Road'] } });
    expect(p.mask).toEqual(['storefrontAddress']);
    expect(p.body.storefrontAddress).toMatchObject({ regionCode: 'IN', languageCode: 'en', addressLines: ['2 Road'], locality: 'Hyderabad' });
    expect(p.sensitive).toEqual(['Address']);
    expect(() => buildPatch(raw, { address: { ...cur, lines: [] } })).toThrow(/address line/);
  });

  it('turns hours into Google\'s form, including past midnight, and refuses overlaps', () => {
    const p = buildPatch(place, { hours: [{ day: 'FRIDAY', open: '18:00', close: '02:00' }, { day: 'MONDAY', open: '09:00', close: '24:00' }, { day: 'TUESDAY', open: '09:00', close: '13:00' }, { day: 'TUESDAY', open: '14:00', close: '18:00' }] });
    expect(p.body.regularHours.periods).toEqual([
      { openDay: 'MONDAY', openTime: { hours: 9, minutes: 0 }, closeDay: 'MONDAY', closeTime: { hours: 24, minutes: 0 } },
      { openDay: 'TUESDAY', openTime: { hours: 9, minutes: 0 }, closeDay: 'TUESDAY', closeTime: { hours: 13, minutes: 0 } },
      { openDay: 'TUESDAY', openTime: { hours: 14, minutes: 0 }, closeDay: 'TUESDAY', closeTime: { hours: 18, minutes: 0 } },
      { openDay: 'FRIDAY', openTime: { hours: 18, minutes: 0 }, closeDay: 'SATURDAY', closeTime: { hours: 2, minutes: 0 } },
    ]);
    expect(() => buildPatch(place, { hours: [{ day: 'MONDAY', open: '09:00', close: '13:00' }, { day: 'MONDAY', open: '12:00', close: '18:00' }] })).toThrow(/overlap/);
    expect(() => buildPatch(place, { hours: [{ day: 'NEVER', open: '09:00', close: '13:00' }] })).toThrow(/opening and closing/);
    expect(buildPatch(place, { hours: readEdit(place).hours }).mask).toEqual([]);
  });

  it('turns special hours into Google\'s form, and needs regular hours', () => {
    const p = buildPatch(place, { specialHours: [{ date: '2026-12-25', closed: true, open: '', close: '' }, { date: '2026-12-31', closed: false, open: '18:00', close: '01:00' }] });
    expect(p.body.specialHours.specialHourPeriods).toEqual([
      { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
      { startDate: { year: 2026, month: 12, day: 31 }, openTime: { hours: 18, minutes: 0 }, closeTime: { hours: 1, minutes: 0 }, endDate: { year: 2027, month: 1, day: 1 } },
    ]);
    expect(() => buildPatch({ ...place, regularHours: undefined }, { specialHours: [{ date: '2026-12-25', closed: true }] })).toThrow(/regular hours/);
    expect(() => buildPatch(place, { specialHours: [{ date: 'soon', closed: true }] })).toThrow(/date/);
  });

  it('sends categories together, and refuses an unsafe website', () => {
    const raw = { ...place, categories: { primaryCategory: { name: 'categories/gcid:a', displayName: 'A' }, additionalCategories: [{ name: 'categories/gcid:b', displayName: 'B' }] } };
    const p = buildPatch(raw, { category: { name: 'categories/gcid:c', displayName: 'C' } });
    expect(p.mask).toEqual(['categories']);
    expect(p.body.categories).toEqual({ primaryCategory: { name: 'categories/gcid:c' }, additionalCategories: [{ name: 'categories/gcid:b' }] });
    expect(() => buildPatch(place, { website: 'javascript:alert(1)' })).toThrow(/full address/);
    expect(buildPatch(place, { website: '' }).mask).toEqual(['websiteUri']);
  });

  it('finds categories by name', async () => {
    const r = await inCo(() => searchBusinessCategories({ q: 'senior', regionCode: 'IN' }));
    expect(r).toEqual([{ name: 'categories/gcid:senior', displayName: 'Senior citizen center' }]);
    const sent = asked.find((a) => a.url.pathname === '/v1/categories')!.url.searchParams;
    expect(sent.get('filter')).toBe('displayName=senior');
    expect(sent.get('regionCode')).toBe('IN');
  });

  it('only a location this connection reaches', async () => {
    await expect(inCo(() => updateBusinessProfile({ location: 'locations/999', version: 'x', changes: { description: 'x' } }, ctx))).rejects.toThrow(/Choose one/);
  });
});

describe('who', () => {
  it('only those who can connect accounts can edit', async () => {
    await t.company('test', { businessProfile: true });
    const base = { userAgent: 'vitest', ip: '10.9.9.9' };
    const email = 'manager@gbp.test';
    const manager = await inCo(async () => {
      await createUser({ name: 'Manager', email, password: 'long-enough-pw', role: 'Manager', mustChangePassword: false }, null);
      return (await login(email, 'long-enough-pw', base)).token;
    });
    expect((await inCo(() => dispatch('updateBusinessProfile', { location: 'locations/1', version: 'x', changes: {} }, { ...base, token: manager }))).status).toBe(403);
    expect((await inCo(() => dispatch('searchBusinessCategories', { q: 'senior' }, { ...base, token: manager }))).status).toBe(403);
    expect(asked.filter((a) => a.method === 'PATCH')).toHaveLength(0);
  });

  it('needs the feature, which also opens the Google connect', async () => {
    const admin = await session();
    const base = { userAgent: 'vitest', ip: '10.9.9.9', token: admin };
    expect((await inCo(() => dispatch('getBusinessProfile', {}, base))).status).toBe(200);
    expect((await inCo(() => dispatch('getGoogleMarketing', {}, base))).status).toBe(200);
    expect((await startGoogleMktConnect({ sessionCookie: `CMP-test.${admin}` })).redirect).toContain('accounts.google.com');
    await t.company('test', { businessProfile: false });
    expect((await inCo(() => dispatch('getBusinessProfile', {}, base))).status).toBe(403);
    expect((await inCo(() => dispatch('getBusinessPerformance', {}, base))).status).toBe(403);
  });

  it('a Viewer can read', async () => {
    const viewer = await session('Viewer');
    expect((await inCo(() => dispatch('getBusinessProfile', {}, { userAgent: 'vitest', ip: '10.9.9.9', token: viewer }))).status).toBe(200);
  });
});
