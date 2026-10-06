/**
 * Full-screen alarm shown by the engine when a task falls due.
 * Rings (services/sound) while open; every action stops the ring first.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import { BellRing, Check, Clock, ExternalLink, Moon, User, X } from 'lucide-react';
import { TaskItem } from '../../types/crm';
import { addDays, formatDateTime, formatDistance, formatRelative, getParts, makeZoned, startOfToday } from '../../core/dates';
import { sound } from '../../services/sound';
import { Button, cx } from '../../components/ui';

export interface AlarmModalProps {
  task: TaskItem | null;
  onSnooze: (task: TaskItem, minutes: number) => Promise<void>;
  onComplete: (task: TaskItem) => Promise<void>;
  onDismiss: () => void;
  onOpenLead: (id: string) => void;
}

/** Minutes from now until tomorrow 10:00 in the CRM time zone. */
function minutesUntilTomorrowTen(now = new Date()): { minutes: number; at: Date } {
  const tomorrow0 = addDays(startOfToday(), 1);
  const p = getParts(tomorrow0);
  const at = makeZoned(p.y, p.m, p.d, 10, 0, 0);
  return { minutes: Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000)), at };
}

function fireConfetti() {
  try {
    confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 }, colors: ['#1D2F3F', '#A9825A', '#7C8B78', '#E7D8C6'] });
  } catch {
    /* canvas not available (tests / SSR) */
  }
}

export const AlarmModal: React.FC<AlarmModalProps> = ({ task, onSnooze, onComplete, onDismiss, onOpenLead }) => {
  const [busy, setBusy] = useState<'snooze' | 'complete' | null>(null);
  const taskId = task?.id;

  // Ring while a task is showing; stop on unmount / task change.
  useEffect(() => {
    if (!taskId) return;
    sound.startAlarm();
    return () => sound.stopAlarm();
  }, [taskId]);

  const dismiss = useCallback(() => {
    sound.stopAlarm();
    onDismiss();
  }, [onDismiss]);

  // Esc dismisses
  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [taskId, dismiss]);

  const snoozeOptions = useMemo(() => {
    const t10 = minutesUntilTomorrowTen();
    return [
      { label: '15 min', minutes: 15 },
      { label: '1 hour', minutes: 60 },
      { label: formatRelative(t10.at), minutes: t10.minutes, hint: 'Tomorrow 10:00' },
      { label: '1 week', minutes: 7 * 24 * 60 },
    ];
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task) return null;

  const snooze = async (minutes: number) => {
    sound.stopAlarm();
    setBusy('snooze');
    try {
      await onSnooze(task, minutes);
    } finally {
      setBusy(null);
    }
  };

  const complete = async () => {
    sound.stopAlarm();
    fireConfetti();
    setBusy('complete');
    try {
      await onComplete(task);
    } finally {
      setBusy(null);
    }
  };

  const openLead = () => {
    if (!task.leadId) return;
    sound.stopAlarm();
    onDismiss();
    onOpenLead(task.leadId);
  };

  const pendingChecks = (task.checklist || []).filter((c) => !c.checked).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200" role="dialog" aria-modal="true" aria-labelledby="alarm-title">
      <div className="absolute inset-0 bg-[#1D2F3F]/60 backdrop-blur-xs" onClick={dismiss} />
      <div className="relative bg-[#FDFCFA] rounded-2xl shadow-2xl border border-[#D2C9BF] max-w-md w-full overflow-hidden text-center animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="bg-[#F5EDE8] border-b border-[#B06A55]/30 p-5 flex flex-col items-center relative">
          <button onClick={dismiss} className="absolute top-3 right-3 p-1.5 rounded-md text-[#B06A55] hover:text-[#8A3E28] hover:bg-white/60" aria-label="Dismiss alarm"><X size={16} /></button>
          <div className="w-14 h-14 rounded-full bg-[#8A3E28]/15 flex items-center justify-center text-[#8A3E28] mb-2 animate-bounce">
            <BellRing size={26} />
          </div>
          <h2 id="alarm-title" className="text-xl font-bold text-[#8A3E28]">Reminder</h2>
          <span className="text-[10px] uppercase tracking-widest text-[#B06A55] font-semibold mt-1">Task due {formatDistance(task.datetime) || 'now'}</span>
        </div>

        {/* Body */}
        <div className="p-6">
          <h3 className="text-lg font-bold text-[#1D2F3F] leading-snug break-words">{task.name}</h3>

          <div className="mt-2 flex flex-col items-center gap-2">
            {task.leadId ? (
              <button onClick={openLead} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#86633E] hover:text-[#1D2F3F] px-3 py-1 rounded-lg hover:bg-[#F4F0EB]">
                <User size={14} />
                <span>{task.lead || task.leadId}</span>
                <ExternalLink size={12} className="opacity-70" />
              </button>
            ) : task.lead && task.lead !== 'General' ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[#6B5F57]"><User size={14} />{task.lead}</span>
            ) : null}
            <span className="inline-flex items-center gap-1.5 text-xs text-[#6B5F57] bg-[#F4F0EB] px-3 py-1.5 rounded-full border border-[#D2C9BF]">
              <Clock size={13} />
              <span>Scheduled {formatDateTime(task.datetime, '—')}</span>
            </span>
            {task.assignedTo && <span className="text-[11px] text-[#9E948D]">Assigned to {task.assignedTo}</span>}
          </div>

          {task.checklist && task.checklist.length > 0 && (
            <div className="mt-4 text-left bg-[#F4F0EB] p-3 rounded-lg border border-[#D2C9BF] max-h-36 overflow-y-auto">
              <span className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57] block mb-1.5">
                Checklist · {pendingChecks} pending
              </span>
              {task.checklist.map((item, idx) => (
                <div key={idx} className="text-xs text-[#3D3530] flex items-start gap-2 py-0.5">
                  <span className={cx('mt-0.5 w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0', item.checked ? 'bg-[#7C8B78] border-[#7C8B78] text-white' : 'border-[#B8AFA7] bg-white')}>
                    {item.checked && <Check size={10} />}
                  </span>
                  <span className={item.checked ? 'line-through text-[#9E948D]' : 'font-medium'}>{item.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-5 border-t border-[#D2C9BF] bg-[#F4F0EB] space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-[#6B5F57] mb-2 inline-flex items-center gap-1"><Moon size={11} />Snooze for</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {snoozeOptions.map((o) => (
                <Button key={o.label} variant="secondary" size="sm" disabled={busy !== null} onClick={() => snooze(o.minutes)} title={o.hint} className="w-full">
                  {o.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button variant="ghost" onClick={dismiss} disabled={busy !== null}>Dismiss</Button>
            <Button variant="primary" size="md" className="flex-1" onClick={complete} loading={busy === 'complete'} disabled={busy === 'snooze'} icon={<Check size={15} />}>
              Mark Completed
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
