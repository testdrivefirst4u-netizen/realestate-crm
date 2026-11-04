/** Competitor ads: the list, links to the ad libraries, recorded checks and when one is due, saved ads, who may do what. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { googleAdsUrl, listCompetitors, metaAdLibraryUrl, normalizeWebsite, recordCompetitorCheck } from '../server/modules/competitors';
import { statFile } from '../server/modules/storage';

let t: Awaited<ReturnType<typeof startTestDb>>;
const tokens: Record<string, string> = {};
const base = { ip: '1.1.1.1', userAgent: 'vitest' };
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');

const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const as = async (who: string, action: string, data: any = {}) => (await inCo(() => dispatch(action, data, { ...base, token: tokens[who] }))).body as any;
async function signIn(name: string, role: 'Admin' | 'Manager' | 'RM' | 'Viewer') {
  const email = name.toLowerCase() + '@competitors.test';
  await inCo(() => createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null));
  tokens[name] = (await inCo(() => login(email, 'long-enough-pw', base))).token;
}
const add = async (name = 'Rival Homes', extra: any = {}) => (await as('Asha', 'saveCompetitor', { name, ...extra })).data.id as string;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { competitorAds: true });
  await signIn('Asha', 'Admin');
  await signIn('Meera', 'Manager');
  await signIn('Ravi', 'RM');
  await signIn('Fiona', 'Viewer');
});

describe('links', () => {
  it('opens active India ads, by Page name or by website', () => {
    const meta = new URL(metaAdLibraryUrl({ name: 'Rival Homes', pageName: 'Rival Homes Hyderabad' }));
    expect(meta.host).toBe('www.facebook.com');
    expect(meta.searchParams.get('country')).toBe('IN');
    expect(meta.searchParams.get('active_status')).toBe('active');
    expect(meta.searchParams.get('q')).toBe('Rival Homes Hyderabad');
    expect(new URL(metaAdLibraryUrl({ name: 'Rival Homes' })).searchParams.get('q')).toBe('Rival Homes');
    expect(googleAdsUrl({ website: 'rival.example' })).toBe('https://adstransparency.google.com/?region=IN&domain=rival.example');
    expect(googleAdsUrl({})).toBe('https://adstransparency.google.com/?region=IN');
  });

  it('keeps only the domain of a website and refuses what is not one', () => {
    expect(normalizeWebsite('https://www.Rival.example/plots?x=1')).toBe('rival.example');
    expect(normalizeWebsite('rival.example')).toBe('rival.example');
    expect(normalizeWebsite('')).toBe('');
    expect(() => normalizeWebsite('not a website')).toThrow(/example\.com/);
    expect(() => normalizeWebsite('localhost')).toThrow(/example\.com/);
  });
});

describe('competitors', () => {
  it('adds, edits and refuses the same name twice', async () => {
    const id = await add('Rival Homes', { website: 'https://www.rival.example/', area: 'Gachibowli' });
    const dup = await as('Meera', 'saveCompetitor', { name: '  rival   homes ' });
    expect(dup.code).toBe('VALIDATION');
    expect((await as('Asha', 'saveCompetitor', { id, name: 'Rival Homes', pageName: 'Rival Page', website: 'rival.example' })).status).toBe('success');
    const c = (await as('Fiona', 'listCompetitors')).data.competitors[0];
    expect(c).toMatchObject({ id, name: 'Rival Homes', pageName: 'Rival Page', website: 'rival.example', meta: null, google: null, due: true });
    expect(c.metaUrl).toContain('q=Rival+Page');
    expect(c.googleUrl).toContain('domain=rival.example');
  });

  it('is due until both platforms were checked in the last 7 days, and due ones come first', async () => {
    const a = await add('Alpha');
    const z = await add('Zeta');
    const now = Date.now();
    await inCo(async () => {
      const ctx = { user: { name: 'Asha' } } as any;
      await recordCompetitorCheck({ id: z, platform: 'meta', status: 'running' }, ctx, { now: new Date(now - DAY) });
      await recordCompetitorCheck({ id: z, platform: 'google', status: 'not_running' }, ctx, { now: new Date(now - 6 * DAY) });
      await recordCompetitorCheck({ id: a, platform: 'meta', status: 'running' }, ctx, { now: new Date(now - DAY) });
      await recordCompetitorCheck({ id: a, platform: 'google', status: 'running' }, ctx, { now: new Date(now - DAY) });
      const fresh = await listCompetitors({ now });
      expect(fresh.competitors.map((c) => [c.name, c.due])).toEqual([['Alpha', false], ['Zeta', false]]);
      const later = await listCompetitors({ now: now + 2 * DAY });
      expect(later.competitors.map((c) => [c.name, c.due])).toEqual([['Zeta', true], ['Alpha', false]]);
    });
  });

  it('keeps the latest check of each platform, who did it, and the history', async () => {
    const id = await add();
    await as('Meera', 'recordCompetitorCheck', { id, platform: 'meta', status: 'running' });
    await as('Asha', 'recordCompetitorCheck', { id, platform: 'meta', status: 'not_running' });
    const c = (await as('Asha', 'listCompetitors')).data.competitors[0];
    expect(c.meta).toMatchObject({ status: 'not_running', by: 'Asha' });
    expect(c.google).toBeNull();
    const doc: any = await inCo(async () => (await col(CFG.COLL.COMPETITORS)).findOne({ _id: id } as any));
    expect(doc.checks.map((x: any) => x.status)).toEqual(['running', 'not_running']);
    expect((await as('Asha', 'recordCompetitorCheck', { id, platform: 'tiktok', status: 'running' })).status).toBe('error');
  });

  it('only offers Admins and Managers as the person who checks', async () => {
    const list = (await as('Asha', 'listCompetitors')).data.checkers.map((p: any) => p.name).sort();
    expect(list).toEqual(['Asha', 'Meera']);
    const rm = (await as('Asha', 'listCompetitors')).data.checkers.find((p: any) => p.name === 'Meera');
    const id = await add('Rival', { assignedToId: rm.id });
    expect((await as('Fiona', 'listCompetitors')).data.competitors[0]).toMatchObject({ id, assignedToName: 'Meera' });
    expect((await as('Asha', 'saveCompetitor', { name: 'Other', assignedToId: 'USR-nobody' })).status).toBe('error');
  });
});

describe('saved ads', () => {
  const ad = (competitorId: string, extra: any = {}) => ({ competitorId, platform: 'meta', seenOn: '2026-11-04', format: 'image', offer: 'No pre-EMI', ...extra });

  it('saves an ad with a screenshot, and removes the file with it', async () => {
    const id = await add();
    const r = await as('Meera', 'saveCompetitorAd', ad(id, { link: 'https://www.facebook.com/ads/library/?id=1', project: 'Tower A', price: '₹90 L', image: { name: 'ad.png', mime: 'image/png', base64: PNG } }));
    expect(r.status).toBe('success');
    const saved = (await as('Fiona', 'listCompetitors')).data.competitors[0].ads[0];
    expect(saved).toMatchObject({ offer: 'No pre-EMI', project: 'Tower A', price: '₹90 L', createdBy: 'Meera' });
    const fileId = saved.imageUrl.split('/').pop();
    expect(await inCo(() => statFile(fileId))).not.toBeNull();
    expect((await as('Asha', 'deleteCompetitorAd', { id: saved.id })).status).toBe('success');
    expect((await as('Asha', 'listCompetitors')).data.competitors[0].ads).toEqual([]);
    expect(await inCo(() => statFile(fileId))).toBeNull();
  });

  it('refuses unsafe links, other file types, and an empty ad', async () => {
    const id = await add();
    expect((await as('Asha', 'saveCompetitorAd', ad(id, { link: 'javascript:alert(1)' }))).status).toBe('error');
    expect((await as('Asha', 'saveCompetitorAd', ad(id, { image: { name: 'x.svg', mime: 'image/svg+xml', base64: PNG } }))).status).toBe('error');
    expect((await as('Asha', 'saveCompetitorAd', ad(id, { offer: '' }))).status).toBe('error');
    expect((await as('Asha', 'saveCompetitorAd', ad(id, { seenOn: 'yesterday' }))).status).toBe('error');
    expect((await as('Asha', 'saveCompetitorAd', ad('missing'))).status).toBe('error');
    expect((await as('Asha', 'listCompetitors')).data.competitors[0].ads).toEqual([]);
  });

  it('removing a competitor removes its ads and screenshots', async () => {
    const id = await add();
    await as('Asha', 'saveCompetitorAd', ad(id, { image: { name: 'ad.png', mime: 'image/png', base64: PNG } }));
    const fileId = (await as('Asha', 'listCompetitors')).data.competitors[0].ads[0].imageUrl.split('/').pop();
    expect((await as('Asha', 'deleteCompetitor', { id })).status).toBe('success');
    expect((await as('Asha', 'listCompetitors')).data.competitors).toEqual([]);
    expect(await inCo(() => statFile(fileId))).toBeNull();
    expect(await inCo(async () => (await col(CFG.COLL.COMPETITOR_ADS)).countDocuments({}))).toBe(0);
  });
});

describe('who may do what', () => {
  it('Viewers read only; RMs see nothing; Admins and Managers change', async () => {
    const id = await add();
    expect((await inCo(() => dispatch('listCompetitors', {}, { ...base, token: tokens.Ravi }))).status).toBe(403);
    expect((await as('Fiona', 'listCompetitors')).status).toBe('success');
    for (const who of ['Ravi', 'Fiona']) {
      for (const [action, data] of [
        ['saveCompetitor', { name: 'X' }],
        ['deleteCompetitor', { id }],
        ['recordCompetitorCheck', { id, platform: 'meta', status: 'running' }],
        ['saveCompetitorAd', { competitorId: id, platform: 'meta', seenOn: '2026-11-04', offer: 'x' }],
        ['deleteCompetitorAd', { id: 'x' }],
      ] as Array<[string, any]>) {
        const r = await inCo(() => dispatch(action, data, { ...base, token: tokens[who] }));
        expect(r.status, `${who} ${action}`).toBe(403);
      }
    }
    expect((await as('Meera', 'recordCompetitorCheck', { id, platform: 'meta', status: 'running' })).status).toBe('success');
  });

  it('a company without the feature gets nothing', async () => {
    await t.company('test', { competitorAds: false });
    const r = await inCo(() => dispatch('listCompetitors', {}, { ...base, token: tokens.Asha }));
    expect(r.status).toBe(403);
  });
});
