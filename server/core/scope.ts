/**
 * Record-level access: which leads (and everything hanging off a lead) a user may see.
 *
 * Roles with `leads.viewAll` (Admin, Manager, Developer) see every lead of their company. Everyone else
 * (RMs) sees only the leads assigned to them — plus unassigned leads unless the company chose the strict
 * mode. The company setting `rmLeadVisibility` is one of:
 *   'own'             — only leads whose Assigned RM is the user
 *   'own_unassigned'  — own leads + leads with no RM yet (default: new web/WhatsApp enquiries can be picked up)
 *   'all'             — no restriction (previous behaviour)
 * Tasks, calls, WhatsApp threads, documents, files, timeline, AI summaries and notifications follow the lead.
 * A lead the user may not see answers NOT_FOUND (its existence is not revealed).
 * A null context (webhooks, cron, scripts) is the system and is never restricted.
 */
import type { Filter } from 'mongodb';
import { can, type Ctx, type PublicUser } from './auth';
import { CFG } from './config';
import { col } from './db';
import { fail } from './errors';
import { settingsAll } from './settings';
import { escapeRegex, str } from './utils';

export type LeadVisibility = 'own' | 'own_unassigned' | 'all';
export const LEAD_VISIBILITY: LeadVisibility[] = ['own', 'own_unassigned', 'all'];

type UserLike = (Pick<PublicUser, 'name' | 'role'> & { id?: string }) | null | undefined;

export async function leadVisibility(): Promise<LeadVisibility> {
  const v = str((await settingsAll()).rmLeadVisibility) as LeadVisibility;
  return LEAD_VISIBILITY.includes(v) ? v : 'own';
}

/**
 * The restriction for this user, or null when the user sees every lead. `ids` / `names` are the people whose leads
 * count as theirs: an Agent is just themselves; a Manager the admin limited to their team (organisation, leadScope
 * 'team') is themselves and everyone below them, plus unassigned leads to hand out (server/modules/org.ts).
 */
export interface Restriction { id: string; name: string; ids: string[]; names: string[]; mode: Exclude<LeadVisibility, 'all'>; team: boolean }
export async function restrictionFor(user: UserLike): Promise<Restriction | null> {
  // the CRM's own jobs run as the SYSTEM account (by id — a person's name can never make them that)
  if (!user || user.id === 'SYSTEM') return null;
  if ((user as any).leadScope === 'team' && String(user.role) === 'Manager' && user.id) {
    const { teamOf } = await import('../modules/org');
    const team = await teamOf(str(user.id));
    return { id: str(user.id), name: str(user.name), ids: team.map((p) => p.id), names: team.map((p) => p.name), mode: 'own_unassigned', team: true };
  }
  if (can(user, 'leads.viewAll')) return null;
  const mode = await leadVisibility();
  if (mode === 'all') return null;
  return { id: str(user.id), name: str(user.name), ids: user.id ? [str(user.id)] : [], names: [str(user.name)], mode, team: false };
}

/** Is this name / id one of the restricted user's people? The id decides when the row has one. */
export function isMember(r: Pick<Restriction, 'ids' | 'names'>, name: unknown, id?: unknown): boolean {
  const i = str(id);
  if (i && r.ids.length) return r.ids.includes(i);
  return r.names.some((n) => sameName(name, n));
}

const nameMatcher = (name: string) => new RegExp('^\\s*' + escapeRegex(name) + '\\s*$', 'i');
const sameName = (a: unknown, b: string) => str(a).toLowerCase() === b.trim().toLowerCase();

/** MongoDB filter on the leads collection (null = no restriction). */
export async function leadFilter(ctx: Ctx | null | undefined): Promise<Filter<any> | null> {
  const r = await restrictionFor(ctx?.user);
  if (!r) return null;
  // by immutable id; by name only on leads not yet stamped with an id (data from before scripts/migrate-owner-ids.ts)
  const byName = { assignedRm: { $in: r.names.filter(Boolean).map(nameMatcher) } };
  const own = r.ids.length
    ? { $or: [{ assignedRmId: { $in: r.ids } }, { $and: [{ assignedRmId: { $in: ['', null] } }, byName] }] }
    : byName;
  if (r.mode === 'own') return own;
  return { $or: [own, { $and: [{ assignedRm: { $in: ['', null] } }, { assignedRmId: { $in: ['', null] } }] }] };
}

/** Pure check on a lead's owner (id first, then the display name on rows without an id). */
export function rmAllows(r: { id?: string; name: string; ids?: string[]; names?: string[]; mode: string } | null, assignedRm: unknown, assignedRmId?: unknown) {
  if (!r) return true;
  const ids = r.ids || (r.id ? [r.id] : []);
  const names = r.names || [r.name];
  const ownerId = str(assignedRmId);
  if (ownerId && ids.length) return ids.includes(ownerId);
  if (names.some((n) => sameName(assignedRm, n))) return true;
  return r.mode === 'own_unassigned' && !str(assignedRm) && !ownerId;
}

/** Ids of the leads this user may see (null = all). */
export async function visibleLeadIds(user: UserLike): Promise<Set<string> | null> {
  const r = await restrictionFor(user);
  if (!r) return null;
  const f = await leadFilter({ user: user as PublicUser } as Ctx);
  const ids = await (await col(CFG.COLL.LEADS)).distinct('_id', f || {});
  return new Set(ids.map(String));
}

/** Can this user see the lead? A lead that does not exist counts as visible (callers report NOT_FOUND themselves). */
export async function canSeeLead(user: UserLike, leadId: unknown): Promise<boolean> {
  const id = str(leadId);
  if (!id) return true;
  const r = await restrictionFor(user);
  if (!r) return true;
  const doc = await (await col(CFG.COLL.LEADS)).findOne({ _id: id as any }, { projection: { assignedRm: 1, assignedRmId: 1 } });
  if (!doc) {
    // archived leads: only users who see everything
    const archived = await (await col(CFG.COLL.ARCHIVE)).findOne({ _id: id as any }, { projection: { _id: 1 } });
    return !archived;
  }
  return rmAllows(r, (doc as any).assignedRm, (doc as any).assignedRmId);
}

/** Throw NOT_FOUND (never FORBIDDEN, so existence is not revealed) when the user may not see the lead. */
export async function assertLeadAccess(ctx: Ctx | null | undefined, leadId: unknown) {
  if (!(await canSeeLead(ctx?.user, leadId))) throw fail('NOT_FOUND', 'Lead not found: ' + str(leadId));
}

/** Keep the items whose lead the user may see (items without a lead are kept). */
export async function filterByLead<T>(user: UserLike, items: T[], leadIdOf: (item: T) => unknown, keepIf?: (item: T) => boolean): Promise<T[]> {
  const ids = await visibleLeadIds(user);
  if (!ids) return items;
  return items.filter((it) => {
    const lid = str(leadIdOf(it));
    return !lid || ids.has(lid) || (keepIf ? keepIf(it) : false);
  });
}

export { sameName };
