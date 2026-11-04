'use client';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { cx, focusRing } from './ui';

type Tone = 'success' | 'error';
interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}

const ToastCtx = createContext<(message: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

/** One message: the bar at the bottom is its timer, so it closes when the bar runs out, and hovering pauses both. */
function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const color = item.tone === 'success' ? '#07BC0C' : '#E74C3C';
  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="crm-toast-in pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-lg bg-white text-[#2B2F33] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
    >
      <div className="flex items-start gap-2.5 p-3 pb-3.5 text-[14px]">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white" style={{ background: color }}>
          {item.tone === 'success' ? <Check size={13} strokeWidth={3} aria-hidden /> : <X size={13} strokeWidth={3} aria-hidden />}
        </span>
        <p className="min-w-0 flex-1 safe-text-wrap">{item.message}</p>
        <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className={cx('rounded p-0.5 text-[#9AA0A6] hover:text-[#2B2F33]', focusRing)}>
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div
        aria-hidden="true"
        className="crm-toast-timer absolute bottom-0 left-0 h-[3px] w-full"
        style={{ background: color, animationDuration: item.tone === 'error' ? '8000ms' : '5000ms', animationPlayState: paused ? 'paused' : 'running' }}
        onAnimationEnd={onDismiss}
      />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback((message: string, tone: Tone = 'success') => {
    const id = ++seq.current;
    setItems((all) => [...all.slice(-3), { id, tone, message }]);
  }, []);
  const value = useMemo(() => push, [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed right-4 top-4 z-[70] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />)}
      </div>
    </ToastCtx.Provider>
  );
}
