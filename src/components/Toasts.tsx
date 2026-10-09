import React, { useEffect, useState } from 'react';
import { CheckCircle2, Info, AlertTriangle, AlertOctagon, X } from 'lucide-react';
import { ToastItem } from '../types/crm';
import { notifications } from '../core/notifications';

/** Transient feedback for the user's own actions. Not persisted, never deduplicated. */
export const Toasts: React.FC = () => {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => notifications.subscribeToasts(setItems), []);
  if (!items.length) return null;
  const icon = (t: ToastItem['type']) =>
    t === 'success' ? <CheckCircle2 size={16} className="text-[#4A6B53]" /> : t === 'warning' ? <AlertTriangle size={16} className="text-[#D97706]" /> : t === 'alert' ? <AlertOctagon size={16} className="text-[#B06A55]" /> : <Info size={16} className="text-[#0B2A44]" />;
  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
      {items.map((t) => (
        <div key={t.id} className="pointer-events-auto bg-white border border-[#D3E3F0] shadow-lg rounded-xl p-3 flex items-start gap-2.5 animate-in slide-in-from-bottom-2 fade-in duration-200">
          <div className="mt-0.5">{icon(t.type)}</div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-[#0B2A44] truncate">{t.title}</div>
            {t.message && <div className="text-[11px] text-[#5E778C] mt-0.5 leading-snug break-words">{t.message}</div>}
          </div>
          <button onClick={() => notifications.dismissToast(t.id)} className="text-[#7E93A6] hover:text-[#0B2A44]" aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
};
