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

/**
 * Calls an RM may see: their own calls, and calls of leads they may see. A call not linked to a lead (a webhook /
 * JustConnect call from a number) follows the lead its number belongs to; one from a number that is no lead yet is
 * shown only when RMs also see unassigned leads ('own_unassigned') — managers handle the rest.
 */
export async function filterCalls<T extends { leadId?: string; loggedBy?: string; phone?: string }>(user: UserLike, calls: T[]): Promise<T[]> {
  const r = await restrictionFor(user);
  if (!r) return calls;
  const ids = (await visibleLeadIds(user))!;
  // the lead each unlinked call's number belongs to (its latest enquiry; one query for all of them)
  const keys = [...new Set(calls.filter((c) => !str(c.leadId) && !sameName(c.loggedBy, r.name)).map((c) => last10(c.phone)).filter((k) => k.length === 10))];
  const owner = new Map<string, string>();
  if (keys.length) {
    for (const l of await (await col(CFG.COLL.LEADS)).find({ phoneLast10: { $in: keys }, stage: { $ne: CFG.STAGES.DELETED } } as any, { projection: { _id: 1, phoneLast10: 1 } }).sort({ createdAt: -1 }).toArray()) {
      if (!owner.has(l.phoneLast10)) owner.set(l.phoneLast10, String(l._id));
    }
  }
  return calls
    .filter((c) => {
      if (sameName(c.loggedBy, r.name)) return true;
      if (str(c.leadId)) return ids.has(str(c.leadId));
      const lead = owner.get(last10(c.phone));
      return lead ? ids.has(lead) : r.mode === 'own_unassigned';
    })
    .map((c: any) => {
      // the suggested lead for an unlinked call is shown only when the user may see that lead
      if (!c.matchedLeadId || ids.has(str(c.matchedLeadId))) return c;
      const { matchedLeadId: _a, matchedName: _b, matchedStage: _c, matchedRM: _d, ...rest } = c;
      return rest;
    });
}

export async function assertCallAccess(ctx: Ctx, callId: unknown) {
  const c: any = await (await col(CFG.COLL.CALLS)).findOne({ _id: str(callId) as any }, { projection: { leadId: 1, loggedBy: 1, phone: 1 } });
  if (!c) return;
  if (!(await filterCalls(ctx.user, [{ leadId: c.leadId, loggedBy: c.loggedBy, phone: c.phone }])).length) throw fail('NOT_FOUND', 'Call not found: ' + str(callId));
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
  // a number typed in directly: if it belongs to another RM's lead, the same answer as for that lead
  if (!c || !str(c.leadId)) {
    const ids = await visibleLeadIds(ctx.user);
    if (!ids) return;
    const lead: any = await (await col(CFG.COLL.LEADS)).find({ phoneLast10: key, stage: { $ne: CFG.STAGES.DELETED } } as any, { projection: { _id: 1 } }).sort({ createdAt: -1 }).limit(1).next();
    if (lead && !ids.has(String(lead._id))) throw fail('NOT_FOUND', 'Conversation not found');
  }
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
