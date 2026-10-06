/**
 * Record-level guards for things that hang off a lead (see server/core/scope.ts for the rule).
 * Used by the action maps: the services themselves stay unrestricted for the system (webhooks, cron).
 */
import type { Ctx, PublicUser } from './auth';
import { CFG } from './config';
import { col } from './db';
import { fail } from './errors';
import { last10, str } from './utils';
import { restrictionFor, sameName, visibleLeadIds } from './scope';

type UserLike = Pick<PublicUser, 'name' | 'role'> | null | undefined;

/* --------------------------------- tasks --------------------------------- */

/** A restricted user sees tasks assigned to or created by them, and tasks of leads they can see. */
export async function filterTasks<T extends { leadId?: string; assignedTo?: string; createdBy?: string }>(user: UserLike, tasks: T[]): Promise<T[]> {
  const r = await restrictionFor(user);
  if (!r) return tasks;
  const ids = (await visibleLeadIds(user))!;
  return tasks.filter((t) => sameName(t.assignedTo, r.name) || sameName(t.createdBy, r.name) || (!!str(t.leadId) && ids.has(str(t.leadId))));
}

export async function assertTaskAccess(ctx: Ctx, taskId: unknown) {
  const t: any = await (await col(CFG.COLL.TASKS)).findOne({ _id: str(taskId) as any });
  if (!t) return; // the service reports NOT_FOUND
  const ok = (await filterTasks(ctx.user, [{ leadId: t.leadId, assignedTo: t.assignedTo, createdBy: t.createdBy }])).length > 0;
  if (!ok) throw fail('NOT_FOUND', 'Task not found: ' + str(taskId));
}

/* --------------------------------- calls --------------------------------- */

export async function filterCalls<T extends { leadId?: string; loggedBy?: string }>(user: UserLike, calls: T[]): Promise<T[]> {
  const r = await restrictionFor(user);
  if (!r) return calls;
  const ids = (await visibleLeadIds(user))!;
  return calls.filter((c) => !str(c.leadId) || ids.has(str(c.leadId)) || sameName(c.loggedBy, r.name));
}

export async function assertCallAccess(ctx: Ctx, callId: unknown) {
  const c: any = await (await col(CFG.COLL.CALLS)).findOne({ _id: str(callId) as any }, { projection: { leadId: 1, loggedBy: 1 } });
  if (!c) return;
  if (!(await filterCalls(ctx.user, [{ leadId: c.leadId, loggedBy: c.loggedBy }])).length) throw fail('NOT_FOUND', 'Call not found: ' + str(callId));
}

/* -------------------------------- WhatsApp -------------------------------- */

/** WhatsApp threads follow their lead; threads not linked to a lead (new enquiries) stay visible. */
export async function filterContacts<T extends { leadId?: string }>(user: UserLike, contacts: T[]): Promise<T[]> {
  const ids = await visibleLeadIds(user);
  if (!ids) return contacts;
  return contacts.filter((c) => !str(c.leadId) || ids.has(str(c.leadId)));
}

export async function assertPhoneAccess(ctx: Ctx, phone: unknown) {
  const key = last10(phone);
  if (!key) return;
  const c: any = await (await col(CFG.COLL.CHAT_CONTACTS)).findOne({ phoneLast10: key }, { projection: { leadId: 1 } });
  if (c && !(await filterContacts(ctx.user, [{ leadId: c.leadId }])).length) throw fail('NOT_FOUND', 'Conversation not found');
}

/* ------------------------------ notifications ----------------------------- */

/** Drop feed events about leads (and their tasks / chats / calls) the user may not see. */
export async function filterEvents<T extends { recordType?: string; recordId?: string; payload?: any }>(user: UserLike, events: T[]): Promise<T[]> {
  const r = await restrictionFor(user);
  if (!r || !events.length) return events;
  const ids = (await visibleLeadIds(user))!;
  const taskIds = events.filter((e) => e.recordType === 'Task').map((e) => str(e.recordId));
  const tasks = taskIds.length ? await (await col(CFG.COLL.TASKS)).find({ _id: { $in: taskIds as any[] } }, { projection: { leadId: 1, assignedTo: 1, createdBy: 1 } }).toArray() : [];
  const taskOk = new Map(tasks.map((t: any) => [str(t._id), sameName(t.assignedTo, r.name) || sameName(t.createdBy, r.name) || (!!str(t.leadId) && ids.has(str(t.leadId)))]));
  return events.filter((e) => {
    if (e.recordType === 'Task') return taskOk.get(str(e.recordId)) ?? true;
    const leadId = e.recordType === 'Lead' ? str(e.recordId) : str(e.payload?.leadId);
    if (!leadId) return e.recordType !== 'Import'; // bulk-import summaries are for managers
    return ids.has(leadId);
  });
}
