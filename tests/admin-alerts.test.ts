import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { notifyAdmins, THROTTLE_MS } from '../server/modules/adminAlerts';

let t: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('admin alerts', () => {
  it('posts an integration_alert to the notification feed, at most once per window per problem', async () => {
    const now = Date.UTC(2026, 9, 17, 10, 0, 0);
    expect(await notifyAdmins('meta-sync-failed:SRC-1', 'Facebook lead sync is failing', 'Token expired', now)).toBe(true);
    expect(await notifyAdmins('meta-sync-failed:SRC-1', 'Facebook lead sync is failing', 'Token expired', now + 10 * 60e3)).toBe(false);
    // a different problem is not held back
    expect(await notifyAdmins('meta-missed:SRC-1', 'Facebook leads were delayed (2)', '2 leads recovered', now + 10 * 60e3)).toBe(true);
    // after the window the same problem alerts again
    expect(await notifyAdmins('meta-sync-failed:SRC-1', 'Facebook lead sync is failing', 'Still expired', now + THROTTLE_MS + 1000)).toBe(true);

    const events = await t.db.collection('events').find({ type: 'integration_alert' }).sort({ seq: 1 }).toArray();
    expect(events.map((e) => e.title)).toEqual(['Facebook lead sync is failing', 'Facebook leads were delayed (2)', 'Facebook lead sync is failing']);
    expect(events[0]).toMatchObject({ recordType: 'integration', recordId: 'meta-sync-failed:SRC-1', message: 'Token expired' });
  });

  it('two alerts at the same moment send only one', async () => {
    const now = Date.UTC(2026, 9, 17, 11, 0, 0);
    const results = await Promise.all([1, 2, 3].map(() => notifyAdmins('meta-dead:SRC-2', 'A Facebook lead could not be imported', 'x', now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await t.db.collection('events').countDocuments({ type: 'integration_alert' })).toBe(1);
  });
});
