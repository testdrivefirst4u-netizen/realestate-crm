/**
 * Tasks, Reminders & Scratchpad.
 *
 * Left: scheduled tasks (filterable, sortable by due time) with inline edit,
 * checklist sub-items, lead links and alarm snooze badges.
 * Right: personal notes and a quick checklist.
 *
 * All mutations go through the engine callbacks (optimistic, already toasting);
 * all dates are rendered through core/dates.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock, Calendar, Check, CheckCircle2, Clock, ListChecks, ListTodo, Pencil, Plus, Search, StickyNote, Trash2, User, UserCheck, X, ExternalLink, Moon,
} from 'lucide-react';
import { ChecklistItem, Lead, NoteItem, TaskItem, UserAccount } from '../../types/crm';
import { F } from '../../core/config';
import { searchLeads } from '../../core/analytics';
import { compareDates, dateKey, formatRelative, fromDatetimeLocalInput, parseDate, todayKey, toDatetimeLocalInput, endOfDay } from '../../core/dates';
import { toast } from '../../core/notifications';
import { formatPhone } from '../../core/phone';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Modal, Select, StageBadge, Tabs, cx, inputCls } from '../../components/ui';

/* ------------------------------------------------------------------------ */
/* Props (exactly what App.tsx passes)                                       */
/* ------------------------------------------------------------------------ */

export interface TasksViewProps {
  tasks: TaskItem[];
  notes: NoteItem[];
  checklist: ChecklistItem[];
  leads: Lead[];
  users: UserAccount[];
  onAddTask: (task: Omit<TaskItem, 'id'>) => Promise<TaskItem | null>;
  onUpdateTask: (id: string, patch: Partial<TaskItem>) => Promise<boolean>;
  onToggleTask: (id: string, completed: boolean) => Promise<boolean>;
  onDeleteTask: (id: string) => Promise<boolean>;
  onToggleTaskChecklist: (id: string, index: number, checked: boolean) => void;
  onAddNote: (text: string) => Promise<boolean>;
  onDeleteNote: (id: string) => Promise<boolean>;
  onAddChecklist: (text: string) => Promise<boolean>;
  onToggleChecklist: (id: string, completed: boolean) => Promise<boolean>;
  onDeleteChecklist: (id: string) => Promise<boolean>;
  onOpenLead: (id: string) => void;
}

type TaskFilter = 'all' | 'pending' | 'overdue' | 'today' | 'upcoming' | 'completed';

const PAGE_SIZE = 50;

const isDone = (t: TaskItem) => !!t.completed || t.status === 'Completed';

/** Due-state of a task relative to `now` (ms). */
function dueState(t: TaskItem, now: number): 'done' | 'overdue' | 'today' | 'upcoming' | 'nodate' {
  if (isDone(t)) return 'done';
  const d = parseDate(t.datetime);
  if (!d) return 'nodate';
  if (d.getTime() < now) return 'overdue';
  if (dateKey(d) === todayKey()) return 'today';
  return 'upcoming';
}

const byDueAsc = (a: TaskItem, b: TaskItem) => compareDates(a.datetime, b.datetime, true);
const byDueDesc = (a: TaskItem, b: TaskItem) => compareDates(a.datetime, b.datetime, false);

/* ------------------------------------------------------------------------ */
/* View                                                                      */
/* ------------------------------------------------------------------------ */

export const TasksView: React.FC<TasksViewProps> = ({
  tasks, notes, checklist, leads, users,
  onAddTask, onUpdateTask, onToggleTask, onDeleteTask, onToggleTaskChecklist,
  onAddNote, onDeleteNote, onAddChecklist, onToggleChecklist, onDeleteChecklist, onOpenLead,
}) => {
  const [filter, setFilter] = useState<TaskFilter>('pending');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [confirm, setConfirm] = useState<{ kind: 'task' | 'note'; id: string; label: string } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Re-evaluate overdue / today every minute without any user interaction.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const i = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(i);
  }, []);
  const now = useMemo(() => Date.now(), [tick, tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const buckets = useMemo(() => {
    const pending = tasks.filter((t) => !isDone(t)).sort(byDueAsc);
    const completed = tasks.filter(isDone).sort(byDueDesc);
    const endToday = endOfDay(new Date(now)).getTime();
    return {
      all: [...pending, ...completed],
      pending,
      overdue: pending.filter((t) => dueState(t, now) === 'overdue'),
      today: pending.filter((t) => {
        const d = parseDate(t.datetime);
        return !!d && dateKey(d) === todayKey();
      }),
      upcoming: pending.filter((t) => {
        const d = parseDate(t.datetime);
        return !!d && d.getTime() > endToday;
      }),
      completed,
    };
  }, [tasks, now]);

  const list = buckets[filter];
  const shown = list.slice(0, visible);

  const assignees = useMemo(() => users.filter((u) => u.status !== 'Disabled').map((u) => u.name).filter(Boolean), [users]);

  const handleConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      if (confirm.kind === 'task') await onDeleteTask(confirm.id);
      else await onDeleteNote(confirm.id);
    } finally {
      setConfirmBusy(false);
      setConfirm(null);
    }
  };

  const tabs: Array<{ id: TaskFilter; label: string; badge?: React.ReactNode }> = [
    { id: 'all', label: 'All', badge: buckets.all.length },
    { id: 'pending', label: 'Pending', badge: buckets.pending.length },
    { id: 'overdue', label: 'Overdue', badge: buckets.overdue.length },
    { id: 'today', label: 'Today', badge: buckets.today.length },
    { id: 'upcoming', label: 'Upcoming', badge: buckets.upcoming.length },
    { id: 'completed', label: 'Completed', badge: buckets.completed.length },
  ];

  const emptyCopy: Record<TaskFilter, { title: string; description: string }> = {
    all: { title: 'No tasks yet', description: 'Schedule a reminder for a site visit, a callback or a document hand-over. The alarm rings at the due time.' },
    pending: { title: 'Nothing pending', description: 'Every task is done. Schedule the next one with “New Task”.' },
    overdue: { title: 'Nothing overdue', description: 'All pending tasks are still within their due time.' },
    today: { title: 'Nothing due today', description: 'Tasks due later show under “Upcoming”.' },
    upcoming: { title: 'Nothing scheduled ahead', description: 'Create a task with a future due time and it will appear here.' },
    completed: { title: 'No completed tasks', description: 'Tick a task when it is done and it moves here.' },
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Tasks, Reminders & Scratchpad</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">
            {buckets.pending.length} pending
            {buckets.overdue.length > 0 && <span className="text-[#B06A55] font-semibold"> · {buckets.overdue.length} overdue</span>}
            {buckets.today.length > 0 && <span className="text-[#86633E] font-semibold"> · {buckets.today.length} due today</span>}
          </p>
        </div>
        <Button variant="primary" onClick={() => setIsAddOpen(true)} icon={<Plus size={14} />}>New Task</Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ------------------------------ Tasks ------------------------------ */}
        <div className="lg:col-span-2">
          <Card
            title={<span className="inline-flex items-center gap-2"><AlarmClock size={17} className="text-[#A9825A]" />Scheduled tasks & alarms</span>}
            subtitle="Pending tasks sorted by due time; completed tasks newest first"
          >
            <Tabs
              className="mb-4"
              tabs={tabs}
              value={filter}
              onChange={(v) => {
                setFilter(v);
                setVisible(PAGE_SIZE);
              }}
            />

            {shown.length === 0 ? (
              <EmptyState
                title={emptyCopy[filter].title}
                description={emptyCopy[filter].description}
                icon={<ListChecks size={22} />}
                className="py-8"
                action={filter !== 'completed' ? <Button variant="secondary" onClick={() => setIsAddOpen(true)} icon={<Plus size={13} />}>New Task</Button> : undefined}
              />
            ) : (
              <div className="space-y-3">
                {shown.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    now={now}
                    assignees={assignees}
                    onToggle={(completed) => onToggleTask(t.id, completed)}
                    onToggleChecklist={(i, checked) => onToggleTaskChecklist(t.id, i, checked)}
                    onUpdate={(patch) => onUpdateTask(t.id, patch)}
                    onDelete={() => setConfirm({ kind: 'task', id: t.id, label: t.name })}
                    onOpenLead={onOpenLead}
                  />
                ))}
                {list.length > visible && (
                  <div className="text-center pt-1">
                    <Button variant="ghost" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
                      Show more ({list.length - visible} remaining)
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>

        {/* --------------------------- Notes & checklist -------------------- */}
        <div className="space-y-5">
          <NotesCard notes={notes} onAdd={onAddNote} onDelete={(n) => setConfirm({ kind: 'note', id: n.id, label: n.text })} />
          <ChecklistCard items={checklist} onAdd={onAddChecklist} onToggle={onToggleChecklist} onDelete={onDeleteChecklist} />
        </div>
      </div>

      <NewTaskModal open={isAddOpen} onClose={() => setIsAddOpen(false)} leads={leads} assignees={assignees} onAddTask={onAddTask} />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'note' ? 'Delete this note?' : 'Delete this task?'}
        message={
          confirm ? (
            <>
              <span className="font-semibold text-[#1D2F3F]">“{confirm.label.length > 80 ? confirm.label.slice(0, 79) + '…' : confirm.label}”</span> will be removed permanently
              {confirm.kind === 'task' ? ' and its alarm cancelled.' : '.'}
            </>
          ) : ''
        }
        confirmLabel="Delete"
        danger
        loading={confirmBusy}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Task card                                                                 */
/* ------------------------------------------------------------------------ */

const TaskCard: React.FC<{
  task: TaskItem;
  now: number;
  assignees: string[];
  onToggle: (completed: boolean) => Promise<boolean>;
  onToggleChecklist: (index: number, checked: boolean) => void;
  onUpdate: (patch: Partial<TaskItem>) => Promise<boolean>;
  onDelete: () => void;
  onOpenLead: (id: string) => void;
}> = ({ task, now, assignees, onToggle, onToggleChecklist, onUpdate, onDelete, onOpenLead }) => {
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const done = isDone(task);
  const state = dueState(task, now);

  const dueCls =
    state === 'overdue' ? 'text-[#B06A55] font-bold' : state === 'today' ? 'text-[#86633E] font-bold' : done ? 'text-[#9E948D]' : 'text-[#6B5F57]';

  const snoozed = useMemo(() => {
    if (!task.snoozedUntil || done) return null;
    const d = parseDate(task.snoozedUntil);
    return d && d.getTime() > now ? d : null;
  }, [task.snoozedUntil, done, now]);

  const checks = task.checklist || [];
  const checkedCount = checks.filter((c) => c.checked).length;

  const toggle = async () => {
    setToggling(true);
    try {
      await onToggle(!done);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className={cx('p-4 rounded-xl border transition', done ? 'bg-[#F4F0EB]/60 border-[#D2C9BF] opacity-75' : state === 'overdue' ? 'bg-white border-[#B06A55]/50 shadow-2xs' : 'bg-white border-[#D2C9BF] shadow-2xs hover:border-[#A9825A]')}>
      <div className="flex items-start gap-3">
        <button
          onClick={toggle}
          disabled={toggling}
          aria-label={done ? 'Mark as pending' : 'Mark as completed'}
          className={cx('mt-0.5 w-5 h-5 rounded-md flex items-center justify-center border transition flex-shrink-0', done ? 'bg-[#7C8B78] border-[#7C8B78] text-white' : 'border-[#B8AFA7] hover:border-[#1D2F3F] bg-white', toggling && 'opacity-50')}
        >
          {done && <Check size={13} />}
        </button>

        <div className="flex-1 min-w-0">
          {editing ? (
            <TaskEditForm task={task} assignees={assignees} onCancel={() => setEditing(false)} onSave={async (patch) => { const ok = await onUpdate(patch); if (ok) setEditing(false); return ok; }} />
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <h4 className={cx('text-sm font-bold text-[#1D2F3F] leading-snug break-words', done && 'line-through text-[#6B5F57]')}>{task.name}</h4>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!done && (
                    <button onClick={() => setEditing(true)} className="p-1.5 rounded-md text-[#9E948D] hover:text-[#1D2F3F] hover:bg-[#F4F0EB]" title="Edit task" aria-label="Edit task">
                      <Pencil size={13} />
                    </button>
                  )}
                  <button onClick={onDelete} className="p-1.5 rounded-md text-[#9E948D] hover:text-[#8A3E28] hover:bg-[#FAF0EC]" title="Delete task" aria-label="Delete task">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs mt-1.5">
                <span className={cx('inline-flex items-center gap-1', dueCls)}>
                  <Clock size={12} />
                  {formatRelative(task.datetime, 'No due time')}
                  {state === 'overdue' && <span className="ml-1 text-[10px] uppercase tracking-wider">overdue</span>}
                </span>
                {task.leadId ? (
                  <button onClick={() => onOpenLead(task.leadId!)} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#A9825A]/15 text-[#86633E] font-semibold hover:bg-[#A9825A]/25" title="Open lead">
                    <User size={11} />
                    <span className="truncate max-w-[180px]">{task.lead || task.leadId}</span>
                    <ExternalLink size={10} className="opacity-70" />
                  </button>
                ) : task.lead && task.lead !== 'General' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#ECE8E1] text-[#6B5F57] font-medium">
                    <User size={11} />
                    <span className="truncate max-w-[180px]">{task.lead}</span>
                  </span>
                ) : null}
                {snoozed && (
                  <Badge tone="amber" title={formatRelative(snoozed)}>
                    <Moon size={10} className="mr-1" /> Snoozed · {formatRelative(snoozed)}
                  </Badge>
                )}
                {done && <Badge tone="sage">Completed{task.completedAt ? ` · ${formatRelative(task.completedAt)}` : ''}</Badge>}
              </div>

              {checks.length > 0 && (
                <div className="mt-3 bg-[#F4F0EB] p-3 rounded-lg border border-[#D2C9BF]/60 space-y-1.5">
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57] flex items-center justify-between">
                    <span>Checklist</span>
                    <span>{checkedCount} of {checks.length}</span>
                  </div>
                  {checks.map((item, idx) => (
                    <label key={idx} className="flex items-start gap-2 text-xs text-[#3D3530] cursor-pointer">
                      <input type="checkbox" checked={!!item.checked} onChange={(e) => onToggleChecklist(idx, e.target.checked)} className="mt-0.5 rounded border-[#B8AFA7] accent-[#A9825A]" />
                      <span className={cx('leading-snug', item.checked && 'line-through text-[#9E948D]')}>{item.text}</span>
                    </label>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#9E948D] mt-2.5">
                {task.assignedTo && (
                  <span className="inline-flex items-center gap-1 text-[#3D3530]"><UserCheck size={11} className="text-[#7C8B78]" />Assigned to <strong>{task.assignedTo}</strong></span>
                )}
                {task.createdBy && <span>Created by {task.createdBy}</span>}
                {task.createdAt && <span>{formatRelative(task.createdAt)}</span>}
                <span className="font-mono">{task.id}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Inline edit form                                                          */
/* ------------------------------------------------------------------------ */

const TaskEditForm: React.FC<{ task: TaskItem; assignees: string[]; onSave: (patch: Partial<TaskItem>) => Promise<boolean>; onCancel: () => void }> = ({ task, assignees, onSave, onCancel }) => {
  const [name, setName] = useState(task.name);
  const [due, setDue] = useState(toDatetimeLocalInput(task.datetime));
  const [assignee, setAssignee] = useState(task.assignedTo || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const options = useMemo(() => (assignee && !assignees.includes(assignee) ? [assignee, ...assignees] : assignees), [assignee, assignees]);

  const save = async () => {
    const n = name.trim();
    const iso = fromDatetimeLocalInput(due);
    if (!n) return setError('Task name is required.');
    if (!iso) return setError('Choose a valid due date & time.');
    setError('');
    setSaving(true);
    try {
      const patch: Partial<TaskItem> = { name: n, datetime: iso, assignedTo: assignee || undefined };
      // A re-scheduled task should ring again at the new time.
      if (iso !== task.datetime && task.snoozedUntil) patch.snoozedUntil = '';
      await onSave(patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <Field label="Task name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Due date & time">
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Assigned to">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} options={options} placeholder="Unassigned" />
        </Field>
      </div>
      {error && <div className="text-xs text-[#8A3E28]">{error}</div>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={saving} icon={<Check size={13} />}>Save</Button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* New task modal                                                            */
/* ------------------------------------------------------------------------ */

type LeadPick = { id: string; name: string };

const defaultDue = () => toDatetimeLocalInput(new Date(Date.now() + 60 * 60_000));

const NewTaskModal: React.FC<{
  open: boolean;
  onClose: () => void;
  leads: Lead[];
  assignees: string[];
  onAddTask: (task: Omit<TaskItem, 'id'>) => Promise<TaskItem | null>;
}> = ({ open, onClose, leads, assignees, onAddTask }) => {
  const [name, setName] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [lead, setLead] = useState<LeadPick | null>(null);
  const [assignee, setAssignee] = useState('');
  const [checklistRaw, setChecklistRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Fresh defaults every time the modal opens.
  useEffect(() => {
    if (open) {
      setName('');
      setDue(defaultDue());
      setLead(null);
      setAssignee('');
      setChecklistRaw('');
      setError('');
    }
  }, [open]);

  const submit = async () => {
    const n = name.trim();
    const iso = fromDatetimeLocalInput(due);
    if (!n) return setError('Task name is required.');
    if (!iso) return setError('Choose a valid due date & time.');
    setError('');
    const checklist = checklistRaw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => ({ text, checked: false }));
    setSaving(true);
    try {
      const created = await onAddTask({
        name: n,
        lead: lead?.name || 'General',
        leadId: lead?.id || undefined,
        datetime: iso,
        status: 'Pending',
        completed: false,
        checklist,
        assignedTo: assignee || undefined,
      });
      if (created) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule a task & reminder"
      subtitle="The alarm rings in the CRM at the due time (and on the desktop when alerts are enabled)."
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={saving} icon={<Plus size={13} />}>Save Task</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Task name / objective *">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Site visit walkthrough with Dr. Rao" className={inputCls} autoFocus onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Due date & time *" hint="CRM time (Asia/Kolkata)">
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Assigned to">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} options={assignees} placeholder="Unassigned" />
          </Field>
        </div>
        <Field label="Related lead" hint="Optional — search by name, phone or enquiry ID">
          <LeadPicker leads={leads} value={lead} onChange={setLead} />
        </Field>
        <Field label="Checklist items" hint="One item per line">
          <textarea value={checklistRaw} onChange={(e) => setChecklistRaw(e.target.value)} rows={3} placeholder={'Print floor plan\nBook EV buggy\nPrepare tea'} className={cx(inputCls, 'resize-y')} />
        </Field>
        {error && <div className="text-xs text-[#8A3E28] bg-[#FAF0EC] border border-[#B06A55]/30 rounded-lg p-2.5">{error}</div>}
      </div>
    </Modal>
  );
};

/* ------------------------------------------------------------------------ */
/* Lead picker                                                               */
/* ------------------------------------------------------------------------ */

const LeadPicker: React.FC<{ leads: Lead[]; value: LeadPick | null; onChange: (v: LeadPick | null) => void }> = ({ leads, value, onChange }) => {
  const [q, setQ] = useState('');
  const results = useMemo(() => (q.trim() ? searchLeads(leads, q, 8) : []), [leads, q]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-[#A9825A]/40 bg-[#FAF7F2] text-xs">
        <span className="inline-flex items-center gap-2 min-w-0">
          <User size={13} className="text-[#A9825A] flex-shrink-0" />
          <span className="font-semibold text-[#1D2F3F] truncate">{value.name}</span>
          <span className="font-mono text-[10px] text-[#A9825A]">{value.id}</span>
        </span>
        <button onClick={() => onChange(null)} className="p-1 rounded-md text-[#9E948D] hover:text-[#1D2F3F] hover:bg-[#F4F0EB]" aria-label="Clear lead"><X size={13} /></button>
      </div>
    );
  }

  return (
    <div>
      <div className="relative flex items-center">
        <Search size={13} className="absolute left-3 text-[#9E948D] pointer-events-none" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leads…" className={cx(inputCls, 'pl-8')} />
      </div>
      {q.trim() && (
        <div className="mt-1 bg-white rounded-xl border border-[#D2C9BF] shadow-sm max-h-56 overflow-y-auto">
          {results.length === 0 ? (
            <div className="p-3 text-xs text-[#9E948D]">No matching lead — the task will be saved as “General”.</div>
          ) : (
            results.map((l) => (
              <button
                key={l[F.ID]}
                type="button"
                onClick={() => {
                  onChange({ id: l[F.ID], name: l[F.NAME] || l[F.ID] });
                  setQ('');
                }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-[#F4F0EB] border-b border-[#ECE8E1] last:border-0"
              >
                <span className="min-w-0">
                  <span className="font-semibold text-[#1D2F3F] truncate block">{l[F.NAME] || '—'} <span className="font-mono text-[10px] text-[#A9825A] ml-1">{l[F.ID]}</span></span>
                  <span className="text-[11px] text-[#6B5F57]">{formatPhone(l[F.PHONE]) || 'No phone'}{l[F.RM] ? ` · RM ${l[F.RM]}` : ''}</span>
                </span>
                <StageBadge stage={l[F.STAGE]} />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Notes                                                                     */
/* ------------------------------------------------------------------------ */

const NotesCard: React.FC<{ notes: NoteItem[]; onAdd: (text: string) => Promise<boolean>; onDelete: (note: NoteItem) => void }> = ({ notes, onAdd, onDelete }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const sorted = useMemo(() => [...notes].sort((a, b) => compareDates(a.created, b.created, false)), [notes]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setSaving(true);
    try {
      const ok = await onAdd(t);
      if (ok) {
        setText('');
        toast('Note saved', undefined, 'success');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={<span className="inline-flex items-center gap-2"><StickyNote size={16} className="text-[#A9825A]" />My Notes</span>} subtitle={`${notes.length} saved`}>
      <div className="space-y-2 mb-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="Write a quick note or phone memo… (Ctrl+Enter to save)"
          rows={2}
          className={cx(inputCls, 'resize-y')}
        />
        <Button variant="primary" className="w-full" onClick={submit} loading={saving} disabled={!text.trim()} icon={<Plus size={13} />}>Save Note</Button>
      </div>
      {sorted.length === 0 ? (
        <EmptyState title="No notes yet" description="Jot down call memos, reminders or anything you need later." icon={<StickyNote size={20} />} className="py-6" />
      ) : (
        <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
          {sorted.map((n) => (
            <div key={n.id} className="p-3 rounded-lg bg-[#F4F0EB] border border-[#D2C9BF] text-xs text-[#3D3530]">
              <p className="whitespace-pre-wrap leading-relaxed break-words">{n.text}</p>
              <div className="flex items-center justify-between text-[10px] text-[#9E948D] mt-2 pt-1.5 border-t border-[#D2C9BF]/50">
                <span className="inline-flex items-center gap-1"><Calendar size={10} />{formatRelative(n.created, '—')}</span>
                <button onClick={() => onDelete(n)} className="p-1 rounded text-[#9E948D] hover:text-[#8A3E28] hover:bg-[#FAF0EC]" title="Delete note" aria-label="Delete note"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

/* ------------------------------------------------------------------------ */
/* Checklist                                                                 */
/* ------------------------------------------------------------------------ */

const ChecklistCard: React.FC<{
  items: ChecklistItem[];
  onAdd: (text: string) => Promise<boolean>;
  onToggle: (id: string, completed: boolean) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}> = ({ items, onAdd, onToggle, onDelete }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const sorted = useMemo(
    () => [...items].sort((a, b) => Number(a.completed) - Number(b.completed) || compareDates(a.updated, b.updated, false)),
    [items]
  );
  const doneCount = items.filter((i) => i.completed).length;

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setSaving(true);
    try {
      const ok = await onAdd(t);
      if (ok) setText('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={<span className="inline-flex items-center gap-2"><ListTodo size={16} className="text-[#A9825A]" />My Checklist</span>} subtitle={items.length ? `${doneCount} of ${items.length} done` : 'Quick to-dos for the day'}>
      <div className="flex gap-2 mb-3">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="New quick item…" className={inputCls} />
        <Button variant="gold" onClick={submit} loading={saving} disabled={!text.trim()}>Add</Button>
      </div>
      {sorted.length === 0 ? (
        <EmptyState title="Checklist is empty" description="Add the small things you want to tick off today." icon={<CheckCircle2 size={20} />} className="py-6" />
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
          {sorted.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#F4F0EB] text-xs hover:bg-[#EDE8E0] transition">
              <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                <input type="checkbox" checked={!!item.completed} onChange={(e) => onToggle(item.id, e.target.checked)} className="rounded border-[#B8AFA7] accent-[#A9825A]" />
                <span className={cx('truncate', item.completed ? 'line-through text-[#9E948D]' : 'text-[#1D2F3F]')} title={item.text}>{item.text}</span>
              </label>
              <button onClick={() => onDelete(item.id)} className="p-1 rounded text-[#9E948D] hover:text-[#8A3E28] hover:bg-[#FAF0EC]" title="Remove" aria-label="Remove checklist item"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};
