/** Tasks module (port of 11_Tasks.gs): CRUD, lead linking, toggle, snooze, id policy. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { addLead } from '../server/modules/leads';
import { addTask, getAllTasks, removeTask, toggleTask, updateTask, actions } from '../server/modules/tasks';
import type { Ctx } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
});

describe('tasks', () => {
  it('creates, lists, updates, toggles and deletes', async () => {
    const due = '2026-11-01T05:30:00.000Z';
    const r = await addTask({ name: '  Call back ', datetime: due, checklist: ['Price sheet', { text: 'Brochure', checked: true }] }, admin);
    expect(r.id).toBe('TASK-0001');
    expect(r.task).toMatchObject({
      id: 'TASK-0001', name: 'Call back', datetime: due, status: 'Pending', completed: false, assignedTo: 'Asha Admin', createdBy: 'Asha Admin',
      snoozedUntil: '', completedAt: '', lead: '', leadId: '',
      checklist: [{ text: 'Price sheet', checked: false }, { text: 'Brochure', checked: true }],
    });
    expect(r.version).toBeTruthy();
    const doc = await (await col(CFG.COLL.TASKS)).findOne({ _id: 'TASK-0001' as any });
    expect(doc!.dateTime).toBeInstanceOf(Date);

    expect(await getAllTasks()).toHaveLength(1);

    const u = await updateTask('TASK-0001', { name: 'Call back today', assignedTo: 'Ravi' }, admin);
    expect(u.task).toMatchObject({ name: 'Call back today', assignedTo: 'Ravi' });

    const done = await toggleTask('TASK-0001', true, admin);
    expect(done.task).toMatchObject({ completed: true, status: 'Completed' });
    expect(done.task.completedAt).toBeTruthy();
    expect(await (await col(CFG.COLL.EVENTS)).countDocuments({ type: 'task_completed' })).toBe(1);
    const undone = await toggleTask('TASK-0001', false, admin);
    expect(undone.task).toMatchObject({ completed: false, status: 'Pending', completedAt: '' });

    await removeTask('TASK-0001', admin);
    expect(await getAllTasks()).toHaveLength(0);
    await expect(removeTask('TASK-0001', admin)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateTask('TASK-0001', { name: 'x' }, admin)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // ids are never reused
    expect((await addTask({ name: 'Next' }, admin)).id).toBe('TASK-0002');
  });

  it('requires a name and defaults the due time to an hour from now', async () => {
    await expect(addTask({ name: ' ' }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = await addTask({ name: 'Later' }, admin);
    const ms = Date.parse(r.task.datetime) - Date.now();
    expect(ms).toBeGreaterThan(55 * 60e3);
    expect(ms).toBeLessThan(61 * 60e3);
  });

  it('links to a lead by id or unambiguous name and writes the lead timeline', async () => {
    const { id } = await addLead({ 'Prospect Name': 'Meera Nair', 'Phone Number': '9111111111' }, admin);
    const byId = await addTask({ name: 'Visit', leadId: id }, admin);
    expect(byId.task.lead).toBe('Meera Nair');
    const byName = await addTask({ name: 'Docs', lead: 'meera nair' }, admin);
    expect(byName.task.leadId).toBe(id);
    const tl = await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId: id, type: 'task_created' });
    expect(tl).toBe(2);
  });

  it('snoozes (persisted) through the snoozeTask action', async () => {
    const { id: leadId } = await addLead({ 'Prospect Name': 'Snoozy', 'Phone Number': '9222222222' }, admin);
    const { id } = await addTask({ name: 'Ping', leadId }, admin);
    const until = new Date(Date.now() + 2 * 3600e3).toISOString();
    const r: any = await actions.snoozeTask.fn({ id, until }, admin);
    expect(r.task.snoozedUntil).toBe(until);
    expect(r.task.datetime).toBe(until);
    const [task] = await getAllTasks();
    expect(task.snoozedUntil).toBe(until);
    expect(await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId, type: 'task_snoozed' })).toBe(1);
  });
});
