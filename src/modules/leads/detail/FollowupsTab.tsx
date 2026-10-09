/**
 * Lead detail → Follow-ups tab: history of "Follow-up N" entries, the log form
 * (text + dictation + AI reframe + next follow-up) and an inline task scheduler.
 */
import React, { useMemo, useState } from 'react';
import { CalendarClock, CalendarPlus, CheckCircle2, Clock, ListChecks, MessageSquare } from 'lucide-react';
import { Lead, TaskItem, UserAccount } from '../../../types/crm';
import { F } from '../../../core/config';
import { followupEntries, nextFollowupDate } from '../../../core/analytics';
import { addDays, compareDates, formatDateTime, formatRelative, fromDatetimeLocalInput, startOfToday, toDatetimeLocalInput } from '../../../core/dates';
import { Button, Field, InlineNotice, cx, inputCls } from '../../../components/ui';
import { SmartTextarea } from '../shared';

interface Props {
  lead: Lead;
  canEdit: boolean;
  aiConfigured: boolean;
  currentUser: UserAccount | null;
  tasks: TaskItem[];
  onAppendRemark: (id: string, remark: string, nextFollowup?: string) => Promise<boolean>;
  onAddTask: (task: Omit<TaskItem, 'id'>) => Promise<TaskItem | null>;
}

/** A wall-clock time on a day offset from today, as a datetime-local value. */
function quickDate(daysAhead: number, hour: number): string {
  const day = addDays(startOfToday(), daysAhead);
  return toDatetimeLocalInput(new Date(day.getTime() + hour * 3_600_000));
}

const QUICK_PICKS: Array<{ label: string; value: () => string }> = [
  { label: 'Tomorrow 10 AM', value: () => quickDate(1, 10) },
  { label: 'In 3 days', value: () => quickDate(3, 11) },
  { label: 'Next week', value: () => quickDate(7, 11) },
];

export const FollowupsTab: React.FC<Props> = ({ lead, canEdit, aiConfigured, currentUser, tasks, onAppendRemark, onAddTask }) => {
  const id = String(lead[F.ID]);
  const [remark, setRemark] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskName, setTaskName] = useState('');
  const [taskWhen, setTaskWhen] = useState('');
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  const entries = useMemo(
    () =>
      [...followupEntries(lead)].sort((a, b) => {
        const byDate = compareDates(a.date, b.date, false);
        return byDate !== 0 ? byDate : b.index - a.index;
      }),
    [lead]
  );
  const nextDue = nextFollowupDate(lead);
  const overdue = !!nextDue && nextDue.getTime() < Date.now();

  const leadTasks = useMemo(
    () => tasks.filter((t) => t.leadId === id).sort((a, b) => Number(!!a.completed) - Number(!!b.completed) || compareDates(a.datetime, b.datetime, true)),
    [tasks, id]
  );

  const saveRemark = async () => {
    const text = remark.trim();
    if (!text) return;
    setSaving(true);
    const ok = await onAppendRemark(id, text, next ? fromDatetimeLocalInput(next) || undefined : undefined);
    setSaving(false);
    if (ok) {
      setRemark('');
      setNext('');
    }
  };

  const openTask = () => {
    setTaskName(`Follow up with ${lead[F.NAME] || 'prospect'}`);
    setTaskWhen(next || quickDate(1, 10));
    setTaskError(null);
    setTaskOpen(true);
  };

  const saveTask = async () => {
    const name = taskName.trim();
    const when = fromDatetimeLocalInput(taskWhen);
    if (!name) return setTaskError('Give the task a name.');
    if (!when) return setTaskError('Pick a date and time.');
    setTaskError(null);
    setTaskSaving(true);
    const res = await onAddTask({
      name,
      lead: String(lead[F.NAME] || ''),
      leadId: id,
      datetime: when,
      status: 'Pending',
      completed: false,
      checklist: [],
      assignedTo: currentUser?.name || String(lead[F.RM] || '') || undefined,
    });
    setTaskSaving(false);
    if (res) setTaskOpen(false);
  };

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-[#D3E3F0] p-3">
          <div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">Last follow-up</div>
          <div className="text-xs font-semibold text-[#0B2A44] mt-1">{formatRelative(lead[F.LAST_FOLLOWUP] || entries[0]?.date, 'Not contacted yet')}</div>
        </div>
        <div className={cx('rounded-xl border p-3', overdue ? 'bg-[#FAF0EC] border-[#B06A55]/40' : 'bg-white border-[#D3E3F0]')}>
          <div className={cx('text-[10px] uppercase font-bold tracking-wider', overdue ? 'text-[#8A3E28]' : 'text-[#5E778C]')}>{overdue ? 'Overdue' : 'Next follow-up'}</div>
          <div className={cx('text-xs font-semibold mt-1', overdue ? 'text-[#8A3E28]' : 'text-[#0B2A44]')}>{formatRelative(nextDue, 'Not scheduled')}</div>
        </div>
      </div>

      {/* Log form */}
      {canEdit ? (
        <div className="bg-[#F2F7FB] p-4 rounded-xl border border-[#D3E3F0] space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-[#0B2A44]">
            <MessageSquare size={14} className="text-[#0B6BB0]" />
            Log a follow-up
          </div>
          <SmartTextarea
            value={remark}
            onChange={setRemark}
            placeholder="What was discussed on the call / visit / WhatsApp? Next step agreed with the family?"
            rows={3}
            aiEnabled={aiConfigured}
            scope="leads.reframe"
          />
          <Field label="Next follow-up (optional)" hint="Saved with the remark; drives the Follow-ups board and reminders.">
            <div className="flex items-center gap-2 flex-wrap">
              <input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} className={cx(inputCls, 'sm:!w-auto')} />
              {QUICK_PICKS.map((q) => (
                <button key={q.label} type="button" onClick={() => setNext(q.value())} className="text-[11px] px-2 py-1 rounded-md bg-white border border-[#D3E3F0] text-[#5E778C] hover:text-[#0B2A44] hover:border-[#0B6BB0]">
                  {q.label}
                </button>
              ))}
              {next && (
                <button type="button" onClick={() => setNext('')} className="text-[11px] text-[#7E93A6] hover:text-[#0B2A44]">
                  clear
                </button>
              )}
            </div>
          </Field>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <Button type="button" variant="ghost" size="xs" onClick={openTask} icon={<CalendarPlus size={12} />}>
              Schedule task
            </Button>
            <Button type="button" variant="gold" onClick={() => void saveRemark()} disabled={!remark.trim()} loading={saving} icon={<CheckCircle2 size={13} />}>
              Save follow-up
            </Button>
          </div>

          {taskOpen && (
            <div className="bg-white rounded-lg border border-[#D3E3F0] p-3 space-y-2">
              <div className="text-[11px] uppercase font-bold tracking-wider text-[#5E778C] flex items-center gap-1.5">
                <ListChecks size={12} className="text-[#0B6BB0]" /> New task for {lead[F.NAME] || id}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                <input value={taskName} onChange={(e) => setTaskName(e.target.value)} placeholder="Task name" className={inputCls} />
                <input type="datetime-local" value={taskWhen} onChange={(e) => setTaskWhen(e.target.value)} className={inputCls} />
              </div>
              {taskError && <InlineNotice tone="warning">{taskError}</InlineNotice>}
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="xs" onClick={() => setTaskOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" variant="primary" size="xs" onClick={() => void saveTask()} loading={taskSaving}>
                  Add task
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <InlineNotice>You can view follow-ups but your role cannot log new ones.</InlineNotice>
      )}

      {/* Linked tasks */}
      {leadTasks.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase font-bold tracking-wider text-[#5E778C]">Tasks for this enquiry</div>
          {leadTasks.map((t) => (
            <div key={t.id} className={cx('flex items-center justify-between gap-3 text-xs bg-white border border-[#D3E3F0] rounded-lg px-3 py-2', t.completed && 'opacity-60')}>
              <span className={cx('font-medium text-[#0B2A44] truncate', t.completed && 'line-through')}>{t.name}</span>
              <span className="text-[#5E778C] whitespace-nowrap flex items-center gap-1">
                <Clock size={11} /> {formatRelative(t.datetime, '—')}
                {t.completed && <CheckCircle2 size={11} className="text-[#3C573A]" />}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* History */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase font-bold tracking-wider text-[#5E778C]">History · {entries.length}</div>
          <div className="text-[10px] text-[#7E93A6]">newest first</div>
        </div>
        {entries.length === 0 ? (
          <div className="text-xs text-[#7E93A6] py-5 text-center bg-white rounded-xl border border-[#E6EFF6]">No follow-ups logged yet — the first one goes above.</div>
        ) : (
          entries.map((e) => (
            <div key={e.index} className="bg-white rounded-xl border border-[#D3E3F0] p-3 shadow-2xs">
              <div className="flex items-center justify-between gap-2 text-[10px] uppercase font-bold tracking-wider text-[#0B6BB0]">
                <span>Follow-up #{e.index}</span>
                <span className="flex items-center gap-1 text-[#5E778C] normal-case tracking-normal font-medium">
                  <CalendarClock size={11} /> {e.date ? formatDateTime(e.date) : 'Undated'}
                </span>
              </div>
              <div className="text-xs text-[#0F2233] mt-1.5 leading-relaxed whitespace-pre-wrap break-words">{e.text || e.raw}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
