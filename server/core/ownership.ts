/**
 * Ownership by immutable user id.
 *
 * Leads used to belong to an agent by display name only (`assignedRm`), so renaming an agent orphaned their leads:
 * the scope filter matched the new name and found nothing. Now:
 *   - every write that sets `assignedRm` also stamps `assignedRmId` (the user's `_id`, which never changes);
 *     tasks stamp `assignedToId`; report snapshots stamp `generatedById`;
 *   - record-level access matches the id first and the name only on rows that have no id yet (older data until
 *     scripts/migrate-owner-ids.ts has run);
 *   - renaming a user re-labels the display name on everything they own (found by id, or by the old name where no
 *     id was stamped) and stamps the id, BEFORE the user's own name changes. If the cascade stops part-way, every
 *     re-labelled row already carries the id, so nothing is orphaned; running the rename again finishes it.
 *   - historical text (follow-up remarks, timeline entries, audit log) keeps the name used at the time, and the
 *     user keeps a list of previous names.
 */
import { CFG } from './config';
import { col } from './db';
import { escapeRegex, str } from './utils';

export const nameKey = (n: unknown) => str(n).trim().replace(/\s+/g, ' ').toLowerCase();

/** The id of the active or disabled user with this display name ('' when none: e.g. "Visit booking", a free-text name). */
export async function userIdByName(name: unknown): Promise<string> {
  const key = nameKey(name);
  if (!key) return '';
  const users = await (await col<any>(CFG.COLL.USERS)).find({}, { projection: { _id: 1, name: 1 } }).toArray();
  const hit = users.find((u) => nameKey(u.name) === key);
  return hit ? String(hit._id) : '';
}

/** Many names at once (bulk import): name key → id. */
export async function userIdsByName(): Promise<Map<string, string>> {
  const users = await (await col<any>(CFG.COLL.USERS)).find({}, { projection: { _id: 1, name: 1 } }).toArray();
  return new Map(users.map((u) => [nameKey(u.name), String(u._id)]));
}

const exactName = (name: string) => new RegExp('^\\s*' + escapeRegex(name.trim()).replace(/\s+/g, '\\s+') + '\\s*$', 'i');
const noId = (field: string) => ({ [field]: { $in: ['', null] } });

/** Rows owned by this user: by id, or by name where no id was stamped yet. */
export function ownedBy(nameField: string, idField: string, userId: string, name: string) {
  return { $or: [{ [idField]: userId }, { $and: [noId(idField), { [nameField]: exactName(name) }] }] };
}

export interface RenameReport {
  leads: number;
  archivedLeads: number;
  tasksAssigned: number;
  tasksCreated: number;
  calls: number;
  reports: number;
}

/** Re-label everything a user owns from `oldName` to `newName`, stamping their id. Idempotent. */
export async function cascadeRename(userId: string, oldName: string, newName: string): Promise<RenameReport> {
  const out: RenameReport = { leads: 0, archivedLeads: 0, tasksAssigned: 0, tasksCreated: 0, calls: 0, reports: 0 };
  if (!userId || !str(oldName).trim()) return out;
  const leadSet = { $set: { assignedRm: newName, assignedRmId: userId } };
  out.leads = (await (await col(CFG.COLL.LEADS)).updateMany(ownedBy('assignedRm', 'assignedRmId', userId, oldName) as any, leadSet)).modifiedCount;
  out.archivedLeads = (await (await col(CFG.COLL.ARCHIVE)).updateMany(ownedBy('assignedRm', 'assignedRmId', userId, oldName) as any, leadSet)).modifiedCount;
  out.tasksAssigned = (await (await col(CFG.COLL.TASKS)).updateMany(ownedBy('assignedTo', 'assignedToId', userId, oldName) as any, { $set: { assignedTo: newName, assignedToId: userId } })).modifiedCount;
  out.tasksCreated = (await (await col(CFG.COLL.TASKS)).updateMany(ownedBy('createdBy', 'createdById', userId, oldName) as any, { $set: { createdBy: newName, createdById: userId } })).modifiedCount;
  out.calls = (await (await col(CFG.COLL.CALLS)).updateMany(ownedBy('loggedBy', 'loggedById', userId, oldName) as any, { $set: { loggedBy: newName, loggedById: userId } })).modifiedCount;
  out.reports = (await (await col(CFG.COLL.REPORTS)).updateMany(ownedBy('generatedBy', 'generatedById', userId, oldName) as any, { $set: { generatedBy: newName, generatedById: userId } })).modifiedCount;
  return out;
}
