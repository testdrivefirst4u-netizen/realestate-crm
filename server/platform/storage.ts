/**
 * Database storage monitoring for the super admin console: how big each company's database is, which collections
 * use the space, how much they grew per day, and the largest records in a collection.
 *
 * Sizes come from MongoDB's own statistics ($collStats; collStats as a fallback). Growth needs history, so one
 * snapshot per company per day is kept in the platform collection `storageSnapshots` — taken by the daily cron
 * and, when today's is missing, the first time the page is opened. "Size" = data + indexes (what grows with use);
 * "on disk" is the compressed storage MongoDB has allocated.
 */
import { getClient, PLATFORM_DB } from '../core/db';
import { dateKey, truncate } from '../core/utils';
import { fail } from '../core/errors';
import { pc } from './base';
import { listActiveTenants } from './registry';
import type { StorageCollection, StorageCompany, StorageLargestItem, StorageOverview } from './contract';

const SNAPSHOTS = 'storageSnapshots';
const PLATFORM_ID = 'platform';
const KEEP_DAYS = 120;

interface CollStat { name: string; count: number; dataSize: number; storageSize: number; indexSize: number }
interface SnapshotDoc {
  _id: string; // companyId:yyyy-MM-dd
  companyId: string;
  name: string;
  dbName: string;
  day: string;
  at: Date;
  totals: Omit<CollStat, 'name'>;
  collections: CollStat[];
}

const snaps = () => pc<SnapshotDoc>(SNAPSHOTS);
const num = (v: unknown) => Number(v) || 0;
const sizeOf = (c: { dataSize: number; indexSize: number }) => c.dataSize + c.indexSize;

/** Every collection of one database with its record count and sizes. */
async function statsOf(dbName: string): Promise<CollStat[]> {
  const db = (await getClient())!.db(dbName);
  const names = (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  const out: CollStat[] = [];
  for (const name of names) {
    try {
      const rows = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const s: Omit<CollStat, 'name'> = rows.reduce<Omit<CollStat, 'name'>>((a, r: any) => {
        const t = r.storageStats || {};
        return { count: a.count + num(t.count), dataSize: a.dataSize + num(t.size), storageSize: a.storageSize + num(t.storageSize), indexSize: a.indexSize + num(t.totalIndexSize) };
      }, { count: 0, dataSize: 0, storageSize: 0, indexSize: 0 });
      out.push({ name, ...s });
    } catch {
      try {
        const t: any = await db.command({ collStats: name });
        out.push({ name, count: num(t.count), dataSize: num(t.size), storageSize: num(t.storageSize), indexSize: num(t.totalIndexSize) });
      } catch {
        out.push({ name, count: await db.collection(name).estimatedDocumentCount().catch(() => 0), dataSize: 0, storageSize: 0, indexSize: 0 });
      }
    }
  }
  return out.sort((a, b) => sizeOf(b) - sizeOf(a));
}

const totalsOf = (cols: CollStat[]) =>
  cols.reduce((a, c) => ({ count: a.count + c.count, dataSize: a.dataSize + c.dataSize, storageSize: a.storageSize + c.storageSize, indexSize: a.indexSize + c.indexSize }), { count: 0, dataSize: 0, storageSize: 0, indexSize: 0 });

/** Today's snapshot of every active company (and the shared platform database). Never throws per company. */
export async function snapshotStorage(now = new Date()): Promise<{ companies: number; failed: number }> {
  const day = dateKey(now);
  const targets = [
    { companyId: PLATFORM_ID, name: 'Platform (shared)', dbName: PLATFORM_DB() },
    ...(await listActiveTenants()).map((t) => ({ companyId: t.id, name: t.name, dbName: t.dbName })),
  ];
  const c = await snaps();
  let failed = 0;
  for (const t of targets) {
    try {
      const collections = await statsOf(t.dbName);
      await c.replaceOne({ _id: `${t.companyId}:${day}` }, { ...t, day, at: now, totals: totalsOf(collections), collections }, { upsert: true });
    } catch (e: any) {
      failed++;
      console.error('[storage] snapshot', t.dbName, e?.message);
    }
  }
  await c.deleteMany({ at: { $lt: new Date(now.getTime() - KEEP_DAYS * 86_400_000) } });
  return { companies: targets.length, failed };
}

/** The latest snapshot on or before `day` (null when there is none that old). */
function onOrBefore(list: SnapshotDoc[], day: string): SnapshotDoc | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].day <= day) return list[i];
  return null;
}
const daysBefore = (day: string, n: number) => dateKey(new Date(Date.parse(day + 'T12:00:00Z') - n * 86_400_000));

/** All companies: size now, growth over a day and a week, a 30-day trend, and the collection using the most. */
export async function storageOverview(d: { refresh?: boolean } = {}): Promise<StorageOverview> {
  const today = dateKey(new Date());
  const c = await snaps();
  if (d.refresh || !(await c.findOne({ day: today }, { projection: { _id: 1 } }))) await snapshotStorage();
  const since = daysBefore(today, 31);
  const rows = await c.find({ day: { $gte: since } }).sort({ day: 1 }).toArray();
  const byCompany = new Map<string, SnapshotDoc[]>();
  for (const r of rows) byCompany.set(r.companyId, [...(byCompany.get(r.companyId) || []), r]);
  const companies: StorageCompany[] = [];
  for (const [companyId, list] of byCompany) {
    const now = list[list.length - 1];
    const d1 = onOrBefore(list, daysBefore(now.day, 1));
    const d7 = onOrBefore(list, daysBefore(now.day, 7));
    const top = now.collections[0];
    companies.push({
      companyId, name: now.name, dbName: now.dbName, at: now.at.toISOString(),
      size: sizeOf(now.totals), dataSize: now.totals.dataSize, indexSize: now.totals.indexSize, storageSize: now.totals.storageSize, count: now.totals.count,
      collections: now.collections.length,
      growth1d: d1 ? sizeOf(now.totals) - sizeOf(d1.totals) : null,
      growth7d: d7 ? sizeOf(now.totals) - sizeOf(d7.totals) : null,
      records1d: d1 ? now.totals.count - d1.totals.count : null,
      topCollection: top ? { name: top.name, size: sizeOf(top) } : null,
      series: list.map((s) => ({ day: s.day, size: sizeOf(s.totals) })),
    });
  }
  companies.sort((a, b) => b.size - a.size);
  const sum = (k: 'size' | 'storageSize' | 'count') => companies.reduce((s, x) => s + x[k], 0);
  const grow = companies.filter((x) => x.growth1d !== null);
  return {
    checkedAt: new Date().toISOString(),
    total: { size: sum('size'), storageSize: sum('storageSize'), count: sum('count'), growth1d: grow.length ? grow.reduce((s, x) => s + (x.growth1d || 0), 0) : null },
    companies,
  };
}

/** One company's collections: size, records, growth over a day and a week, share of the database. */
export async function storageCompany(d: { companyId: string }): Promise<{ companyId: string; name: string; at: string; collections: StorageCollection[] }> {
  const id = String(d?.companyId || '');
  const c = await snaps();
  const list = await c.find({ companyId: id }).sort({ day: -1 }).limit(10).toArray();
  if (!list.length) throw fail('NOT_FOUND', 'No storage snapshot for this company yet');
  const [now] = list;
  const prev = (n: number) => list.find((s) => s.day <= daysBefore(now.day, n)) || null;
  const d1 = prev(1), d7 = prev(7);
  const find = (s: SnapshotDoc | null, name: string) => s?.collections.find((x) => x.name === name) || null;
  const total = sizeOf(now.totals) || 1;
  return {
    companyId: id, name: now.name, at: now.at.toISOString(),
    collections: now.collections.map((x) => {
      const a = find(d1, x.name), b = find(d7, x.name);
      return {
        name: x.name, count: x.count, size: sizeOf(x), dataSize: x.dataSize, indexSize: x.indexSize, storageSize: x.storageSize,
        avgRecord: x.count ? Math.round(x.dataSize / x.count) : 0,
        share: sizeOf(x) / total,
        growth1d: d1 ? sizeOf(x) - (a ? sizeOf(a) : 0) : null,
        growth7d: d7 ? sizeOf(x) - (b ? sizeOf(b) : 0) : null,
        records1d: d1 ? x.count - (a?.count || 0) : null,
      };
    }),
  };
}

const LABEL_FIELDS = ['name', 'title', 'filename', 'fileName', 'phone', 'email', 'subject', 'type', 'action', 'unitNumber', 'leadId'];

/** The 10 largest records of a collection (GridFS files by file size), with a readable label. */
export async function storageLargest(d: { companyId: string; collection: string }): Promise<StorageLargestItem[]> {
  const id = String(d?.companyId || '');
  const name = String(d?.collection || '');
  const snap = await (await snaps()).findOne({ companyId: id }, { sort: { day: -1 } });
  if (!snap || !snap.collections.some((x) => x.name === name)) throw fail('NOT_FOUND', 'Unknown collection');
  const db = (await getClient())!.db(snap.dbName);
  const label = (doc: any) => truncate(LABEL_FIELDS.map((f) => doc?.[f]).filter((v) => typeof v === 'string' && v.trim()).slice(0, 2).join(' · ') || '', 120);
  // GridFS: a file is many chunks; the files list says how big each file is
  if (name.endsWith('.chunks') || name.endsWith('.files')) {
    const files = name.replace(/\.chunks$/, '.files');
    const rows = await db.collection(files).find({}, { projection: { filename: 1, length: 1, uploadDate: 1, contentType: 1 } }).sort({ length: -1 }).limit(10).maxTimeMS(15000).toArray();
    return rows.map((r: any) => ({ id: String(r._id), size: num(r.length), label: truncate(`${r.filename || ''}${r.contentType ? ` · ${r.contentType}` : ''}`, 120), at: r.uploadDate ? new Date(r.uploadDate).toISOString() : '' }));
  }
  const rows = await db.collection(name).aggregate([
    { $project: { size: { $bsonSize: '$$ROOT' }, ...Object.fromEntries(LABEL_FIELDS.map((f) => [f, 1])), createdAt: 1, at: 1, timestamp: 1 } },
    { $sort: { size: -1 } },
    { $limit: 10 },
  ], { maxTimeMS: 20000, allowDiskUse: true }).toArray();
  return rows.map((r: any) => {
    const when = r.createdAt || r.at || r.timestamp;
    return { id: String(r._id), size: num(r.size), label: label(r), at: when ? new Date(when).toISOString() : '' };
  });
}
