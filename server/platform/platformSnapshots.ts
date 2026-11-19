/**
 * Daily platform-wide snapshots: one row per day in the platform DB capturing totals across every company
 * (companies, users, leads, storage, MRR). There is no history otherwise — the dashboard only knows "now" — so this
 * lets the Super Admin console chart growth over time. Written once a day from the global cron tail; best-effort.
 */
import { pcol } from '../core/db';
import { dateKey } from '../core/utils';
import { dashboard } from './companies';
import { billingOverview } from './billing';

const COLL = 'platformSnapshots';
interface SnapshotDoc { _id: string; date: string; companies: number; activeCompanies: number; users: number; leads: number; storageMB: number; mrr: number; currency: string; at: Date }

/** Record today's platform totals (best-effort; never throws). Idempotent — re-running a day overwrites it. */
export async function snapshotPlatform(now = new Date()): Promise<{ ok: boolean }> {
  try {
    const date = dateKey(now);
    const [d, b] = await Promise.all([dashboard(), billingOverview().catch(() => null)]);
    await (await pcol<SnapshotDoc>(COLL)).updateOne(
      { _id: date },
      { $set: { date, companies: d.companies.total, activeCompanies: d.companies.active, users: d.users, leads: d.leads, storageMB: d.storageMB, mrr: b?.mrr ?? 0, currency: b?.currency ?? 'INR', at: now } },
      { upsert: true },
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export interface PlatformTrendPoint { date: string; companies: number; activeCompanies: number; users: number; leads: number; storageMB: number; mrr: number }
export interface PlatformTrends { currency: string; points: PlatformTrendPoint[] }

/** Daily snapshots over the last `days` (7–400, default 90), oldest → newest. */
export async function platformTrends(d?: { days?: number }): Promise<PlatformTrends> {
  const days = Math.min(400, Math.max(7, Math.floor(Number(d?.days) || 90)));
  const since = dateKey(new Date(Date.now() - days * 86_400_000));
  const rows = await (await pcol<SnapshotDoc>(COLL)).find({ _id: { $gte: since } } as any).sort({ _id: 1 }).toArray();
  return {
    currency: rows.length ? rows[rows.length - 1].currency : 'INR',
    points: rows.map((r) => ({ date: r.date, companies: r.companies, activeCompanies: r.activeCompanies, users: r.users, leads: r.leads, storageMB: r.storageMB, mrr: r.mrr })),
  };
}
