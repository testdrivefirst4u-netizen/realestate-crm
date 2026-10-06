/**
 * Tasks — port of apps-script/11_Tasks.gs. Snooze is persisted so a refresh can never revive a
 * dismissed alarm. `_id` = 'TASK-0001' (never reused); dates are Dates in MongoDB, ISO in the API.
 */
import type { ActionMap } from '../core/actions';
import { assertLeadAccess } from '../core/scope';
import { assertTaskAccess } from '../core/scopeGuards';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col } from '../core/db';
import { fail } from '../core/errors';
import { addEvent, addTimeline } from '../core/events';
import { escapeRegex, fmtHuman, parseDate, str, toIso } from '../core/utils';
import { getLead, resolveSuppliedId } from './leads';

export interface ChecklistEntry { text: string; checked: boolean }

export interface TaskDoc {
  _id: string; // TASK-0001
  name: string;
  lead: string; // prospect name (legacy display)
  leadId: string;
  dateTime: Date | null;
  status: 'Pending' | 'Completed';
  completed: boolean;
  checklist: ChecklistEntry[];
  assignedTo: string;
  createdAt: Date | null;
  completedAt: Date | null;
  snoozedUntil: Date | null;
  createdBy: string;
}

/** API shape (src/types/crm.ts → TaskItem). */
export interface TaskItem {
  id: string;
  name: string;
  lead: string;
  leadId: string;
  datetime: string;
  status: 'Pending' | 'Completed';
  completed: boolean;
  checklist: ChecklistEntry[];
  assignedTo: string;
  createdAt: string;
  completedAt: string;
  snoozedUntil: string;
  createdBy: string;
}

const tasksCol = () => col<TaskDoc>(CFG.COLL.TASKS);
const actorOf = (ctx: Ctx | null | undefined) => (ctx && ctx.user ? ctx.user.name : 'System');

function normalizeChecklist(v: unknown): ChecklistEntry[] {
  let list: unknown = v;
  if (typeof v === 'string') {
    try {
      list = JSON.parse(v);
    } catch {
      return v.split(/\n|;/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, checked: false }));
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((c: any) => (typeof c === 'string' ? { text: c, checked: false } : { text: String(c?.text || ''), checked: !!c?.checked }));
}

export function serializeTask(r: TaskDoc): TaskItem {
  const completed = !!r.completed || r.status === 'Completed';
  return {
    id: str(r._id),
    name: str(r.name),
    lead: str(r.lead),
    leadId: str(r.leadId),
    datetime: toIso(r.dateTime),
    status: completed ? 'Completed' : 'Pending',
    completed,
    checklist: normalizeChecklist(r.checklist),
    assignedTo: str(r.assignedTo),
    createdAt: toIso(r.createdAt),
    completedAt: toIso(r.completedAt),
    snoozedUntil: toIso(r.snoozedUntil),
    createdBy: str(r.createdBy),
  };
}

export async function getAllTasks(): Promise<TaskItem[]> {
  const rows = await (await tasksCol()).find({}).sort({ createdAt: 1, _id: 1 }).toArray();
  return rows.map(serializeTask).filter((t) => t.id || t.name);
}

export async function addTask(data: any, ctx: Ctx | null): Promise<{ id: string; task: TaskItem; version: string }> {
  if (!data || !String(data.name || '').trim()) throw fail('VALIDATION', 'Task name is required');
  const actor = actorOf(ctx);
  const tasks = await tasksCol();
  const taken = async (id: string) => !!(await tasks.findOne({ _id: id }, { projection: { _id: 1 } }));
  const id = await resolveSuppliedId('TASK', 4, data.id, taken);
  const when = parseDate(data.datetime) || new Date(Date.now() + 3600000);
  const now = new Date();
  let leadId = String(data.leadId || '').trim();
  let leadName = String(data.lead || '').trim();
  if (!leadId && leadName) {
    // try to resolve the lead by name (only when unambiguous)
    const found = await (await col(CFG.COLL.LEADS))
      .find({ name: { $regex: '^\\s*' + escapeRegex(leadName) + '\\s*$', $options: 'i' } }, { projection: { _id: 1 } })
      .limit(2)
      .toArray();
    if (found.length === 1) leadId = String(found[0]._id);
  } else if (leadId && !leadName) {
    const l = await getLead(leadId);
    if (l) leadName = l[CFG.LEAD.NAME];
  }
  const doc: TaskDoc = {
    _id: id, name: String(data.name).trim(), lead: leadName, leadId, dateTime: when, status: 'Pending', completed: false,
    checklist: normalizeChecklist(Array.isArray(data.checklist) ? data.checklist : []), assignedTo: String(data.assignedTo || actor),
    createdAt: now, completedAt: null, snoozedUntil: null, createdBy: actor,
  };
  await tasks.insertOne(doc);
  const task = serializeTask(doc);
  if (leadId) await addTimeline(leadId, 'task_created', 'Task created: ' + task.name, 'Due ' + fmtHuman(when), actor, 'Task', id);
  await addEvent('task_created', 'Task', id, 'Task scheduled: ' + task.name, (leadName ? leadName + ' · ' : '') + 'Due ' + fmtHuman(when), actor);
  await auditLog(ctx, 'Task Scheduled', 'Task', id, task.name);
  return { id, task, version: await bumpVersion() };
}

export async function updateTask(id: string, patch: any, ctx: Ctx | null): Promise<{ task: TaskItem; version: string }> {
  if (!id) throw fail('VALIDATION', 'Task id is required');
  patch = patch && typeof patch === 'object' ? patch : {};
  const actor = actorOf(ctx);
  const tasks = await tasksCol();
  const beforeDoc = await tasks.findOne({ _id: String(id) });
  if (!beforeDoc) throw fail('NOT_FOUND', 'Task not found: ' + id);
  const before = serializeTask(beforeDoc);
  const set: Partial<TaskDoc> = {};
  const fields: string[] = []; // legacy column names, for the audit entry
  if (patch.name !== undefined) { set.name = String(patch.name).trim(); fields.push('Task Name'); }
  if (patch.lead !== undefined) { set.lead = String(patch.lead); fields.push('Related Lead'); }
  if (patch.leadId !== undefined) { set.leadId = String(patch.leadId); fields.push('Lead ID'); }
  if (patch.datetime !== undefined) { set.dateTime = parseDate(patch.datetime); fields.push('Date Time'); }
  if (patch.checklist !== undefined) { set.checklist = normalizeChecklist(Array.isArray(patch.checklist) ? patch.checklist : []); fields.push('Checklist'); }
  if (patch.assignedTo !== undefined) { set.assignedTo = String(patch.assignedTo); fields.push('Assigned To'); }
  if (patch.snoozedUntil !== undefined) { set.snoozedUntil = parseDate(patch.snoozedUntil); fields.push('Snoozed Until'); }
  if (patch.completed !== undefined) {
    set.completed = !!patch.completed;
    set.status = patch.completed ? 'Completed' : 'Pending';
    set.completedAt = patch.completed ? new Date() : null;
    fields.push('Completed', 'Status', 'Completed At');
  }
  const doc = Object.keys(set).length
    ? await tasks.findOneAndUpdate({ _id: beforeDoc._id }, { $set: set }, { returnDocument: 'after' })
    : beforeDoc;
  if (!doc) throw fail('NOT_FOUND', 'Task not found: ' + id);
  const task = serializeTask(doc);
  if (patch.snoozedUntil && before.leadId) {
    await addTimeline(before.leadId, 'task_snoozed', 'Task snoozed: ' + task.name, 'Until ' + fmtHuman(patch.snoozedUntil), actor, 'Task', task.id);
  }
  await auditLog(ctx, 'Task Updated', 'Task', task.id, fields.join(', '));
  return { task, version: await bumpVersion() };
}

export async function toggleTask(id: string, completed: boolean, ctx: Ctx | null): Promise<{ task: TaskItem; version: string }> {
  const actor = actorOf(ctx);
  const res = await updateTask(id, { completed: !!completed }, ctx);
  if (completed) {
    if (res.task.leadId) await addTimeline(res.task.leadId, 'task_completed', 'Task completed: ' + res.task.name, '', actor, 'Task', res.task.id);
    await addEvent('task_completed', 'Task', res.task.id, 'Task completed: ' + res.task.name, 'by ' + actor, actor);
  }
  return res;
}

export async function removeTask(id: string, ctx: Ctx | null): Promise<{ version: string }> {
  const doc = await (await tasksCol()).findOneAndDelete({ _id: String(id || '') });
  if (!doc) throw fail('NOT_FOUND', 'Task not found: ' + id);
  await auditLog(ctx, 'Task Deleted', 'Task', doc._id, doc.name);
  return { version: await bumpVersion() };
}

export const actions: ActionMap = {
  addTask: { fn: async (d, ctx) => { await assertLeadAccess(ctx, d.data?.leadId); return addTask(d.data, ctx); }, perm: 'tasks.manage' },
  updateTask: { fn: async (d, ctx) => { await assertTaskAccess(ctx, d.id); if (d.data?.leadId) await assertLeadAccess(ctx, d.data.leadId); return updateTask(d.id, d.data, ctx); }, perm: 'tasks.manage' },
  toggleTask: { fn: async (d, ctx) => { await assertTaskAccess(ctx, d.id); return toggleTask(d.id, d.completed, ctx); }, perm: 'tasks.manage' },
  deleteTask: { fn: async (d, ctx) => { await assertTaskAccess(ctx, d.id); return removeTask(d.id, ctx); }, perm: 'tasks.manage' },
  snoozeTask: { fn: async (d, ctx) => { await assertTaskAccess(ctx, d.id); return updateTask(d.id, { snoozedUntil: d.until, datetime: d.until }, ctx); }, perm: 'tasks.manage' },
};
