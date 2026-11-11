/**
 * Organisation: up to five levels and who reports to whom (admins assign them as people join).
 *
 *   levels        company setting `orgLevels`: 1 (most senior) … 5, names editable
 *                 (default Partner · Sales Head · Team Lead · Senior Sales Executive · Sales Executive)
 *   user.orgLevel 1–5, or unset (not placed yet)
 *   user.reportsTo the user id of their manager — must be at a MORE senior level; no loops; never themselves
 *   user.leadScope for managers: 'all' (default — every lead, as before) or 'team' (their own leads, their team's
 *                 leads, and unassigned ones to hand out). Agents always see their own; Admins and View only, all.
 *
 * teamOf(userId) = the user and everyone below them, at any depth. Record-level access (server/core/scope.ts),
 * the team view and the scorecards use it.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { settingSet, settingsAll } from '../core/settings';
import { safeJsonParse, str, truncate } from '../core/utils';

export const MAX_LEVELS = 5;
export const DEFAULT_LEVELS = ['Partner', 'Sales Head', 'Team Lead', 'Senior Sales Executive', 'Sales Executive'];

export interface OrgPerson { id: string; name: string; role: string; status: string; level: number | null; reportsTo: string; leadScope: 'team' | 'all' }

const users = () => col<any>(CFG.COLL.USERS);

export async function orgLevels(): Promise<string[]> {
  const raw = safeJsonParse<string[]>((await settingsAll()).orgLevels, null);
  const list = Array.isArray(raw) ? raw.map((s) => truncate(str(s), 40)).filter(Boolean).slice(0, MAX_LEVELS) : [];
  return list.length ? list : DEFAULT_LEVELS;
}

export async function orgPeople(): Promise<OrgPerson[]> {
  const docs = await (await users()).find({ support: { $ne: true } } as any, { projection: { name: 1, role: 1, status: 1, orgLevel: 1, reportsTo: 1, leadScope: 1 } }).sort({ createdAt: 1 }).toArray();
  return docs.map((u) => ({ id: String(u._id), name: str(u.name), role: str(u.role), status: u.status === 'Disabled' ? 'Disabled' : 'Active', level: Number(u.orgLevel) || null, reportsTo: str(u.reportsTo), leadScope: u.leadScope === 'team' ? 'team' : 'all' }));
}

/** The user and everyone who reports to them, at any depth (cycle-safe). */
export function subtree(people: Array<Pick<OrgPerson, 'id' | 'reportsTo'>>, rootId: string): string[] {
  const kids = new Map<string, string[]>();
  for (const p of people) if (p.reportsTo) kids.set(p.reportsTo, [...(kids.get(p.reportsTo) || []), p.id]);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(kids.get(id) || []));
  }
  return out;
}

export async function teamOf(userId: string): Promise<OrgPerson[]> {
  const people = await orgPeople();
  const ids = new Set(subtree(people, userId));
  return people.filter((p) => ids.has(p.id));
}

export async function getOrg() {
  return { levels: await orgLevels(), people: await orgPeople() };
}

export async function saveLevels(names: unknown, ctx: Ctx) {
  if (!can(ctx.user, 'users.manage')) throw fail('FORBIDDEN', 'Only an admin changes the levels');
  const list = (Array.isArray(names) ? names : []).map((s) => truncate(str(s).trim(), 40)).filter(Boolean);
  if (!list.length || list.length > MAX_LEVELS) throw fail('VALIDATION', `Give between 1 and ${MAX_LEVELS} levels, most senior first`);
  if (new Set(list.map((s) => s.toLowerCase())).size !== list.length) throw fail('VALIDATION', 'Each level needs a different name');
  const people = await orgPeople();
  const tooDeep = people.find((p) => p.level && p.level > list.length);
  if (tooDeep) throw fail('VALIDATION', `${tooDeep.name} is at level ${tooDeep.level}; move them before removing that level`);
  await settingSet('orgLevels', JSON.stringify(list), ctx.user?.name || 'System');
  await auditLog(ctx, 'Org Levels Saved', 'Settings', '', list.join(' › '));
  return getOrg();
}

/** Place a person: level, who they report to, and (managers) what they see. */
export async function placePerson(d: { userId: string; level?: number | null; reportsTo?: string; leadScope?: string }, ctx: Ctx) {
  if (!can(ctx.user, 'users.manage')) throw fail('FORBIDDEN', 'Only an admin places people in the organisation');
  const people = await orgPeople();
  const me = people.find((p) => p.id === str(d.userId));
  if (!me) throw fail('NOT_FOUND', 'User not found');
  const levels = await orgLevels();
  const level = d.level === null || d.level === undefined || (d.level as unknown) === '' ? null : Math.round(Number(d.level));
  if (level !== null && !(level >= 1 && level <= levels.length)) throw fail('VALIDATION', `Choose a level from 1 to ${levels.length}`);
  const reportsTo = str(d.reportsTo);
  if (reportsTo) {
    if (reportsTo === me.id) throw fail('VALIDATION', 'Someone cannot report to themselves');
    const boss = people.find((p) => p.id === reportsTo);
    if (!boss || boss.status === 'Disabled') throw fail('VALIDATION', 'Choose an active person to report to');
    if (subtree(people, me.id).includes(reportsTo)) throw fail('VALIDATION', `${boss.name} already reports to ${me.name} (directly or through others)`);
    if (level !== null && boss.level !== null && boss.level >= level) throw fail('VALIDATION', `${boss.name} is ${levels[boss.level - 1]}; ${me.name} can only report to someone more senior than ${levels[level - 1]}`);
  }
  // people who report to me must stay junior to my new level
  if (level !== null) {
    const junior = people.find((p) => p.reportsTo === me.id && p.level !== null && p.level <= level);
    if (junior) throw fail('VALIDATION', `${junior.name} reports to ${me.name} at ${levels[junior.level! - 1]}; move them first`);
  }
  const leadScope = d.leadScope === 'team' ? 'team' : 'all';
  const set: Record<string, unknown> = { reportsTo, leadScope };
  const unset: Record<string, ''> = {};
  if (level === null) unset.orgLevel = '';
  else set.orgLevel = level;
  await (await users()).updateOne({ _id: me.id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  const bossName = reportsTo ? people.find((p) => p.id === reportsTo)!.name : 'nobody';
  await auditLog(ctx, 'Org Placement', 'Settings', me.id, `${me.name}: ${level ? levels[level - 1] : 'no level'} · reports to ${bossName} · sees ${leadScope === 'team' ? 'their team' : 'all leads'}`, {
    before: { level: me.level, reportsTo: me.reportsTo, leadScope: me.leadScope }, after: { level, reportsTo, leadScope },
  });
  // sessions pick the new scope up on their next request (validateSession re-reads the user)
  return getOrg();
}

export const actions: ActionMap = {
  getOrg: { perm: 'leads.view', fn: () => getOrg() },
  saveOrgLevels: { perm: 'users.manage', fn: (d, ctx) => saveLevels(d?.levels, ctx) },
  placeOrgPerson: { perm: 'users.manage', fn: (d, ctx) => placePerson(d, ctx) },
};

