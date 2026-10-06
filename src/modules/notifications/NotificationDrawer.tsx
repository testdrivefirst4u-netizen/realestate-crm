/**
 * Notification Center — slide-over listing the deduplicated notifications from
 * core/notifications, grouped by day. Clicking an item marks it read and opens
 * the related record (lead / task / chat …) through App.openRecord.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bell, BellOff, BellRing, CheckCheck, CheckCircle2, Info, Trash2, X, ExternalLink } from 'lucide-react';
import { NotificationItem, NotificationType } from '../../types/crm';
import { notifications as notificationBus } from '../../core/notifications';
import { reportError } from '../../core/errors';
import { addDays, compareDates, dateKey, formatDate, formatTime, startOfToday, todayKey } from '../../core/dates';
import { Button, ConfirmDialog, EmptyState, Tabs, cx } from '../../components/ui';

export interface NotificationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  notifications: NotificationItem[];
  browserPermission: NotificationPermission;
  onRequestBrowserPermission: () => Promise<void> | void;
  onOpenRecord: (recordType?: string, recordId?: string) => void;
}

type Filter = 'all' | 'unread' | 'alerts';

const isAlert = (n: NotificationItem) => n.type === 'alert' || n.type === 'warning';

function TypeIcon({ type }: { type: NotificationType }) {
  switch (type) {
    case 'success':
      return <CheckCircle2 size={16} className="text-[#7C8B78]" />;
    case 'alert':
      return <BellRing size={16} className="text-[#B06A55]" />;
    case 'warning':
      return <AlertTriangle size={16} className="text-[#A9825A]" />;
    default:
      return <Info size={16} className="text-[#1D2F3F]" />;
  }
}

const RECORD_LABEL: Record<string, string> = { Lead: 'Open lead', Task: 'Open tasks', Chat: 'Open chat', Inventory: 'Open inventory', Developer: 'Open settings' };

export const NotificationDrawer: React.FC<NotificationDrawerProps> = ({ isOpen, onClose, notifications: items, browserPermission, onRequestBrowserPermission, onOpenRecord }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (!isOpen || confirmClear) return; // the confirm dialog owns Esc while open
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, confirmClear]);

  const unread = useMemo(() => items.filter((n) => !n.read).length, [items]);
  const alerts = useMemo(() => items.filter(isAlert).length, [items]);

  const filtered = useMemo(() => {
    const base = filter === 'unread' ? items.filter((n) => !n.read) : filter === 'alerts' ? items.filter(isAlert) : items;
    return [...base].sort((a, b) => compareDates(a.timestamp, b.timestamp, false));
  }, [items, filter]);

  const groups = useMemo(() => {
    const today = todayKey();
    const yesterday = dateKey(addDays(startOfToday(), -1));
    const out: Array<{ key: string; label: string; items: NotificationItem[] }> = [];
    for (const n of filtered) {
      const key = dateKey(n.timestamp) || 'unknown';
      let g = out[out.length - 1];
      if (!g || g.key !== key) {
        const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : key === 'unknown' ? 'Earlier' : formatDate(n.timestamp);
        g = { key, label, items: [] };
        out.push(g);
      }
      g.items.push(n);
    }
    return out;
  }, [filtered]);

  if (!isOpen) return null;

  const open = (n: NotificationItem) => {
    notificationBus.markAsRead(n.id);
    if (n.recordId) {
      onOpenRecord(n.recordType, n.recordId);
    } else if (n.link && /^https?:\/\//i.test(n.link)) {
      window.open(n.link, '_blank', 'noopener,noreferrer');
    }
  };

  const requestPermission = async () => {
    setRequesting(true);
    try {
      await onRequestBrowserPermission();
    } catch (e) {
      reportError('notifications.permission', e);
    } finally {
      setRequesting(false);
    }
  };

  const tabs: Array<{ id: Filter; label: string; badge?: React.ReactNode }> = [
    { id: 'all', label: 'All', badge: items.length },
    { id: 'unread', label: 'Unread', badge: unread },
    { id: 'alerts', label: 'Alerts', badge: alerts },
  ];

  const emptyCopy: Record<Filter, { title: string; description: string }> = {
    all: { title: 'No notifications yet', description: 'Task alarms, new enquiries, WhatsApp messages and sync events will appear here.' },
    unread: { title: 'You are all caught up', description: 'Every notification has been read.' },
    alerts: { title: 'No alerts', description: 'Overdue tasks and warnings show up here.' },
  };

  return (
    <>
      <div className="fixed inset-0 bg-[#1D2F3F]/40 backdrop-blur-xs z-50" onClick={onClose} />
      <aside className="fixed top-0 right-0 bottom-0 w-[420px] max-w-full bg-[#FDFCFA] z-50 shadow-2xl flex flex-col border-l border-[#D2C9BF] animate-in slide-in-from-right duration-200" role="dialog" aria-modal="true" aria-label="Notifications">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-[#D2C9BF] bg-white flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-[#1D2F3F] inline-flex items-center gap-2"><BellRing size={18} className="text-[#A9825A]" />Notifications</h3>
            <div className="text-xs text-[#6B5F57] mt-0.5">{unread > 0 ? `${unread} unread · ${items.length} total` : `${items.length} total`}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-[#9E948D] hover:text-[#1D2F3F] hover:bg-[#F4F0EB]" aria-label="Close"><X size={18} /></button>
        </div>

        {/* Desktop alerts */}
        <div className="px-4 py-3 bg-[#F4F0EB] border-b border-[#D2C9BF] text-xs">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[#3D3530] min-w-0">
              {browserPermission === 'granted' ? <Bell size={14} className="text-[#7C8B78] flex-shrink-0" /> : <BellOff size={14} className="text-[#A9825A] flex-shrink-0" />}
              <span className="truncate">{browserPermission === 'granted' ? 'Desktop alerts are on' : 'Desktop alerts are off'}</span>
            </div>
            {browserPermission !== 'granted' && (
              <Button variant="primary" size="xs" onClick={requestPermission} loading={requesting} icon={<Bell size={11} />}>Enable desktop alerts</Button>
            )}
          </div>
          {browserPermission === 'denied' && (
            <div className="text-[11px] text-[#8A3E28] mt-1.5">Notifications are blocked for this site in the browser. Allow them in the browser's site settings, then reload.</div>
          )}
        </div>

        {/* Filters & actions */}
        <div className="px-4 py-2.5 border-b border-[#ECE8E1] flex items-center justify-between gap-2 flex-wrap bg-[#FDFCFA]">
          <Tabs<Filter> tabs={tabs} value={filter} onChange={setFilter} />
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => notificationBus.markAllAsRead()} disabled={unread === 0} icon={<CheckCheck size={12} />}>Mark all read</Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmClear(true)} disabled={items.length === 0} icon={<Trash2 size={12} />}>Clear all</Button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-3">
          {groups.length === 0 ? (
            <EmptyState title={emptyCopy[filter].title} description={emptyCopy[filter].description} icon={<Bell size={22} />} />
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <section key={g.key}>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57] px-1 mb-1.5 sticky top-0 bg-[#FDFCFA]/95 py-1">{g.label}</div>
                  <div className="space-y-2">
                    {g.items.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => open(n)}
                        className={cx(
                          'w-full text-left p-3 rounded-lg border transition flex items-start gap-2.5',
                          n.read ? 'bg-white border-[#ECE8E1] hover:bg-[#FAF7F2]' : 'bg-[#F4F0EB] border-[#A9825A]/40 shadow-xs hover:border-[#A9825A]'
                        )}
                      >
                        <div className="mt-0.5 flex-shrink-0"><TypeIcon type={n.type} /></div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={cx('text-xs truncate', n.read ? 'font-semibold text-[#3D3530]' : 'font-bold text-[#1D2F3F]')}>{n.title}</span>
                            <span className="text-[10px] text-[#9E948D] flex-shrink-0 inline-flex items-center gap-1.5">
                              {formatTime(n.timestamp, '')}
                              {!n.read && <span className="w-2 h-2 rounded-full bg-[#A9825A]" aria-label="Unread" />}
                            </span>
                          </div>
                          {n.message && <p className="text-xs text-[#3D3530] mt-1 leading-relaxed break-words">{n.message}</p>}
                          {n.recordId && (
                            <div className="text-[10px] font-bold text-[#A9825A] mt-1.5 inline-flex items-center gap-1">
                              {RECORD_LABEL[n.recordType || ''] || 'Open'} <ExternalLink size={10} />
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </aside>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all notifications?"
        message="This removes every notification from the list on this device. It cannot be undone."
        confirmLabel="Clear all"
        danger
        onConfirm={() => {
          notificationBus.clearAll();
          setConfirmClear(false);
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
};
