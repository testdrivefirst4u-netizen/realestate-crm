/**
 * Monthly follower snapshots: there is no follower history in Meta's API, so we record each connected Facebook Page /
 * Instagram account's follower count once per calendar month (best-effort, from the daily cron). The Client Report reads
 * this to show month-on-month audience growth. Snapshotting is gated per month, so it makes at most one light Graph call
 * (followers_count only) per account per month, and never throws.
 */
import type { ActionMap } from '../core/actions';
import { col } from '../core/db';
import { graph } from '../integrations/meta';
import { socialPages } from './socialAccounts';

interface SnapDoc { _id: string; key: string; kind: 'facebook' | 'instagram'; name: string; month: string; followers: number; at: Date }
const snaps = () => col<SnapDoc>('followerSnapshots');
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Record each connected account's follower count for the current month (best-effort; never throws). Returns how many
 * were written. By default it skips an account already recorded this month (so the daily cron costs one Graph call per
 * account per month); `force` re-fetches and overwrites, for the manual "snapshot now" button.
 */
export async function snapshotFollowers(now = new Date(), force = false): Promise<number> {
  try {
    const month = monthKey(now);
    const c = await snaps();
    const pages = await socialPages();
    let n = 0;
    for (const p of pages) {
      const targets: Array<{ key: string; kind: 'facebook' | 'instagram'; name: string; id: string }> = [{ key: `facebook:${p.id}`, kind: 'facebook', name: p.name, id: p.id }];
      if (p.igId) targets.push({ key: `instagram:${p.igId}`, kind: 'instagram', name: `@${p.igUsername || p.igId}`, id: p.igId });
      for (const t of targets) {
        if (!force && (await c.findOne({ key: t.key, month }, { projection: { _id: 1 } }))) continue; // already recorded this month
        const followers = await graph<{ followers_count?: number }>(t.id, { token: p.token, params: { fields: 'followers_count' } }).then((j) => num(j.followers_count)).catch(() => null);
        if (followers == null) continue;
        await c.updateOne({ _id: `${t.key}:${month}` }, { $set: { key: t.key, kind: t.kind, name: t.name, month, followers, at: now } }, { upsert: true });
        n++;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export interface FollowerPoint { month: string; followers: number }
export interface FollowerAccount { key: string; kind: 'facebook' | 'instagram'; name: string; points: FollowerPoint[] }

/** Follower history per account (up to the last 13 months, oldest → newest). */
export async function followerHistory(): Promise<{ accounts: FollowerAccount[] }> {
  const rows = await (await snaps()).find({}).sort({ month: 1 }).toArray();
  const by = new Map<string, FollowerAccount>();
  for (const r of rows) {
    let a = by.get(r.key);
    if (!a) { a = { key: r.key, kind: r.kind, name: r.name, points: [] }; by.set(r.key, a); }
    a.name = r.name;
    a.points.push({ month: r.month, followers: r.followers });
  }
  return { accounts: [...by.values()].map((a) => ({ ...a, points: a.points.slice(-13) })) };
}

export const actions: ActionMap = {
  followerHistory: { fn: async () => followerHistory(), perm: 'reports.view' },
  snapshotFollowersNow: { fn: async () => ({ written: await snapshotFollowers(new Date(), true), ...(await followerHistory()) }), perm: 'marketing.posts' },
};
