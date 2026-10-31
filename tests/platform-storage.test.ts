/** Super admin › Database storage: daily snapshots, growth per day, collections by size, the largest records. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { snapshotStorage, storageCompany, storageLargest, storageOverview } from '../server/platform/storage';

let t: Awaited<ReturnType<typeof startTestDb>>;
const platformDb = () => t.db.client.db(process.env.PLATFORM_DB || 'amaya_platform');

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('database storage', () => {
  it('measures collections, shows growth since yesterday and the largest records', async () => {
    const notes = platformDb().collection('bigNotes');
    await notes.insertMany(Array.from({ length: 20 }, (_, i) => ({ name: `note ${i}`, text: 'x'.repeat(200) })));
    await snapshotStorage(new Date(Date.now() - 86_400_000)); // yesterday
    await notes.insertMany(Array.from({ length: 30 }, (_, i) => ({ name: `later ${i}`, text: 'y'.repeat(2000) })));
    await notes.insertOne({ name: 'the huge one', text: 'z'.repeat(50_000) });

    const o = await storageOverview();
    const p = o.companies.find((c) => c.companyId === 'platform')!;
    expect(p.name).toBe('Platform (shared)');
    expect(p.count).toBeGreaterThanOrEqual(51);
    expect(p.growth1d!).toBeGreaterThan(50_000); // 30 × 2 KB + 50 KB were added since yesterday
    expect(p.records1d!).toBeGreaterThanOrEqual(31);
    expect(p.series.length).toBe(2);
    expect(o.total.size).toBeGreaterThan(0);

    const c = await storageCompany({ companyId: 'platform' });
    const big = c.collections.find((x) => x.name === 'bigNotes')!;
    expect(big).toMatchObject({ count: 51, records1d: 31 });
    expect(big.growth1d!).toBeGreaterThan(50_000);
    expect(c.collections[0].size).toBeGreaterThanOrEqual(c.collections[c.collections.length - 1].size); // largest first

    const top = await storageLargest({ companyId: 'platform', collection: 'bigNotes' });
    expect(top).toHaveLength(10);
    expect(top[0]).toMatchObject({ label: 'the huge one' });
    expect(top[0].size).toBeGreaterThan(50_000);
    await expect(storageLargest({ companyId: 'platform', collection: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
