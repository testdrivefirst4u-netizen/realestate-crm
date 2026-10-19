/**
 * Phone navigation (below lg): a floating tab bar — Home, Leads, Follow-ups, WhatsApp (or Tasks) and More (opens the
 * full menu drawer). New enquiries are added from the Leads screen. The sidebar stays the navigation on larger screens.
 */
import React from 'react';
import Link from 'next/link';
import { CalendarClock, CheckSquare, Home, Menu, MessageCircle, Users } from 'lucide-react';
import { viewHref, type ViewId } from '../core/views';
import { cx } from './ui';

export interface MobileTabBarProps {
  currentView: ViewId | null;
  /** Show the WhatsApp tab (plan + permission); otherwise Tasks takes its place. */
  showChats: boolean;
  followupsToday?: number;
  unreadChats?: number;
  tasksPending?: number;
  /** Opens the full menu (sidebar drawer). */
  onMore: () => void;
}

const Badge: React.FC<{ n?: number }> = ({ n }) =>
  n ? (
    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#36B3F2] text-[#04263D] text-[10px] font-extrabold leading-[18px] text-center ring-2 ring-white">
      {n > 99 ? '99+' : n}
    </span>
  ) : null;

export const MobileTabBar: React.FC<MobileTabBarProps> = ({ currentView, showChats, followupsToday, unreadChats, tasksPending, onMore }) => {
  const tabs: Array<{ id: ViewId; label: string; icon: React.ReactNode; count?: number }> = [
    { id: 'dashboard', label: 'Home', icon: <Home size={20} /> },
    { id: 'leads', label: 'Leads', icon: <Users size={20} /> },
    { id: 'followups', label: 'Follow-ups', icon: <CalendarClock size={20} />, count: followupsToday },
    showChats
      ? { id: 'chat360', label: 'WhatsApp', icon: <MessageCircle size={20} />, count: unreadChats }
      : { id: 'tasks', label: 'Tasks', icon: <CheckSquare size={20} />, count: tasksPending },
  ];
  return (
    <div className="lg:hidden fixed inset-x-0 bottom-0 z-30 pointer-events-none" style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }}>
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#F2F7FB] via-[#F2F7FB]/90 to-transparent" aria-hidden="true" />
      <nav aria-label="Main" className="relative mx-auto max-w-md px-4 pointer-events-auto">
        <div className="h-[62px] px-1.5 rounded-full bg-white border border-[#E6EFF6] shadow-[0_8px_24px_rgba(10,31,51,0.12)] flex items-center justify-around">
          {tabs.map((t) => {
            const on = currentView === t.id;
            return (
              <Link
                key={t.id}
                href={viewHref(t.id)}
                aria-label={t.label}
                aria-current={on ? 'page' : undefined}
                title={t.label}
                className={cx(
                  'relative w-12 h-12 rounded-full flex items-center justify-center transition-colors',
                  on ? 'bg-[#0A1F33] text-white shadow-[0_4px_10px_rgba(10,31,51,0.25)]' : 'text-[#7E93A6] hover:text-[#0A1F33]',
                )}
              >
                {t.icon}
                <Badge n={t.count} />
              </Link>
            );
          })}
          <button type="button" onClick={onMore} aria-label="More screens" title="More" className="w-12 h-12 rounded-full flex items-center justify-center text-[#7E93A6] hover:text-[#0A1F33]">
            <Menu size={20} />
          </button>
        </div>
      </nav>
    </div>
  );
};
