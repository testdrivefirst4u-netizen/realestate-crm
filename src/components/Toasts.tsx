import React, { useEffect, useState } from 'react';
import { Check, Info, AlertTriangle, X } from 'lucide-react';
import { ToastItem } from '../types/crm';
import { notifications } from '../core/notifications';

const LOOK: Record<ToastItem['type'], { bg: string; ink: string; icon: React.ReactNode }> = {
  success: { bg: '#07BC0C', ink: '#FFFFFF', icon: <Check size={13} strokeWidth={3} /> },
  info: { bg: '#3498DB', ink: '#FFFFFF', icon: <Info size={13} strokeWidth={3} /> },
  warning: { bg: '#F1C40F', ink: '#3A2B00', icon: <AlertTriangle size={13} strokeWidth={3} /> },
  alert: { bg: '#E74C3C', ink: '#FFFFFF', icon: <X size={13} strokeWidth={3} /> },
};

/** One message: the bar at the bottom is its timer, so it closes when the bar runs out, and hovering pauses both. */
const Toast: React.FC<{ item: ToastItem }> = ({ item }) => {
  const [paused, setPaused] = useState(false);
  const look = LOOK[item.type] || LOOK.info;
  const urgent = item.type === 'alert' || item.type === 'warning';
  return (
    <div
      role={urgent ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="crm-toast-in pointer-events-auto relative overflow-hidden rounded-lg bg-white text-[#2B2F33] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
    >
      <div className="flex items-start gap-2.5 p-3 pb-3.5">
        <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full" style={{ background: look.bg, color: look.ink }}>{look.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-[13px] font-semibold leading-snug">{item.title}</div>
          {item.message && <div className="mt-0.5 max-h-40 overflow-y-auto break-words text-xs leading-snug text-[#5F6368]">{item.message}</div>}
        </div>
        <button type="button" onClick={() => notifications.dismissToast(item.id)} className="flex-none text-[#9AA0A6] hover:text-[#2B2F33]" aria-label="Close"><X size={15} /></button>
      </div>
      <div
        aria-hidden="true"
        className="crm-toast-timer absolute bottom-0 left-0 h-[3px] w-full"
        style={{ background: look.bg, animationDuration: `${item.durationMs}ms`, animationPlayState: paused ? 'paused' : 'running' }}
        onAnimationEnd={() => notifications.dismissToast(item.id)}
      />
    </div>
  );
};

/** Transient feedback for the user's own actions. Not persisted, never deduplicated. */
export const Toasts: React.FC = () => {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => notifications.subscribeToasts(setItems), []);
  if (!items.length) return null;
  return (
    <div className="fixed top-4 right-4 z-[70] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
      {items.map((t) => <Toast key={t.id} item={t} />)}
    </div>
  );
};
