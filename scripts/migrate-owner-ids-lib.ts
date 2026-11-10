/**
 * Backfill immutable owner ids from display names (finding 3). Works on one company database.
 *
 *   dry run (default)  counts what would change and lists owner names that match no user (already-orphaned rows)
 *   apply              stamps assignedRmId / assignedToId / createdById / loggedById / generatedById where missing,
 *                      tagging each row it stamped with `ownerIdsBy: 'migration'`
 *   rollback           removes ONLY the ids this migration stamped (rows tagged above). Names are never changed,
 *                      so the old code keeps working on rolled-back data.
 *
 * Safe to re-run: rows that already carry an id are skipped.
 */
import type { Db } from 'mongodb';

const nameKey = (n: unknown) => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const TARGETS: Array<{ coll: string; name: string; id: string; label: keyof MigrationReport }> = [
  { coll: 'leads', name: 'assignedRm', id: 'assignedRmId', label: 'leads' },
  { coll: 'archivedLeads', name: 'assignedRm', id: 'assignedRmId', label: 'archivedLeads' },
  { coll: 'tasks', name: 'assignedTo', id: 'assignedToId', label: 'tasksAssigned' },
  { coll: 'tasks', name: 'createdBy', id: 'createdById', label: 'tasksCreated' },
  { coll: 'calls', name: 'loggedBy', id: 'loggedById', label: 'calls' },
  { coll: 'reportSnapshots', name: 'generatedBy', id: 'generatedById', label: 'reports' },
];

type Count = { matched: number; unmatched: number };
export interface MigrationReport {
  leads: Count;
  archivedLeads: Count;
  tasksAssigned: Count;
  tasksCreated: Count;
  calls: Count;
  reports: Count;
  unmatchedNames: string[];
  rolledBack?: number;
}

export async function migrateOwnerIds(db: Db, opts: { apply?: boolean; rollback?: boolean } = {}): Promise<MigrationReport> {
  const empty = (): Count => ({ matched: 0, unmatched: 0 });
  const out: MigrationReport = { leads: empty(), archivedLeads: empty(), tasksAssigned: empty(), tasksCreated: empty(), calls: empty(), reports: empty(), unmatchedNames: [] };

  if (opts.rollback) {
    let n = 0;
    for (const t of TARGETS) {
      const r = await db.collection(t.coll).updateMany({ ownerIdsBy: 'migration', [t.id]: { $exists: true } }, { $unset: { [t.id]: '' } });
      n += r.modifiedCount;
    }
    for (const c of new Set(TARGETS.map((t) => t.coll))) await db.collection(c).updateMany({ ownerIdsBy: 'migration' }, { $unset: { ownerIdsBy: '' } });
    out.rolledBack = n;
    return out;
  }

  const users = await db.collection('users').find({}, { projection: { _id: 1, name: 1, previousNames: 1 } }).toArray();
  const byName = new Map<string, string>();
  for (const u of users) byName.set(nameKey(u.name), String(u._id));
  const unmatched = new Set<string>();

  for (const t of TARGETS) {
    const c = db.collection(t.coll);
    const rows = await c.find({ [t.id]: { $in: [null, ''] }, [t.name]: { $nin: ['', null] } } as any, { projection: { _id: 1, [t.name]: 1 } }).toArray();
    const ops: any[] = [];
    for (const r of rows) {
      const id = byName.get(nameKey(r[t.name]));
      if (!id) {
        out[t.label] = { ...(out[t.label] as Count), unmatched: (out[t.label] as Count).unmatched + 1 } as any;
        unmatched.add(String(r[t.name]).trim());
        continue;
      }
      (out[t.label] as Count).matched++;
      ops.push({ updateOne: { filter: { _id: r._id, [t.id]: { $in: [null, ''] } }, update: { $set: { [t.id]: id, ownerIdsBy: 'migration' } } } });
    }
    if (opts.apply && ops.length) for (let i = 0; i < ops.length; i += 1000) await c.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
  // free-text owners the CRM writes itself are not people
  const SYSTEM = new Set(['system', 'visit booking', 'automation', 'auto-reassign', 'payment reminder', 'website', 'import']);
  out.unmatchedNames = [...unmatched].filter((n) => !SYSTEM.has(nameKey(n))).sort();
  return out;
}
