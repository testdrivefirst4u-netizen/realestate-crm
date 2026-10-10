import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  LayoutDashboard, Users, MessageCircle, CheckSquare, Building2, Settings, Plus, ChevronLeft, ChevronRight, LogOut, UserCircle2, X,
  type LucideIcon,
} from 'lucide-react';
import { SyncState, UserAccount } from '../types/crm';
import { AppLogo, useLogoSrc } from './AppLogo';
import { Avatar } from './Avatar';
import { useCompany } from '../core/tenant';
import { type ViewId, VIEW_TITLES, viewAllowed, viewHref } from '../core/views';
import { formatRelative } from '../core/dates';
import { Permission, roleLabel } from '../core/rbac';

export type { ViewId };

/** Counts shown next to menu entries (0 / missing = no badge). */
export interface SidebarCounts {
  leads?: number;
  followupsToday?: number;
  tasksPending?: number;
  unreadChats?: number;
}

interface SidebarProps {
  /** Screen of the current URL (null on a path that is not a screen). */
  currentView: ViewId | null;
  /** Called when a navigation link is followed (closes the mobile drawer). */
  onNavigate?: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
  sync: SyncState;
  isOnline: boolean;
  currentUser: UserAccount | null;
  can: (p: Permission) => boolean;
  /** Resolved feature switches (see core/tenant.tsx); missing keys fall back to the defaults. */
  features: Record<string, boolean>;
  onLogout: () => void;
  onNewEnquiry?: () => void;
  counts?: SidebarCounts;
  /** @deprecated Use `counts.unreadChats`. */
  unreadChats?: number;
}

interface Item { id: ViewId; label: string; count?: number; urgent?: boolean }
interface Group { id: string; label: string; icon: LucideIcon; items: Item[] }

/** The 14 screens in six groups: one rail icon per group, the panel lists them all. */
function buildGroups(counts: SidebarCounts): Group[] {
  return [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard, items: [{ id: 'dashboard', label: 'Dashboard' }, { id: 'reports', label: 'Reports' }, { id: 'audit', label: 'Audit Log' }] },
    { id: 'leads', label: 'Leads', icon: Users, items: [{ id: 'leads', label: 'All Leads', count: counts.leads }, { id: 'kanban', label: 'Enquiry Status' }, { id: 'followups', label: 'Follow-ups', count: counts.followupsToday, urgent: true }, { id: 'segments', label: 'Client Segments' }] },
    { id: 'messages', label: 'Messages', icon: MessageCircle, items: [{ id: 'chat360', label: 'WhatsApp (Chat360)', count: counts.unreadChats, urgent: true }, { id: 'calls', label: 'Call History' }, { id: 'templates', label: 'Templates' }] },
    { id: 'work', label: 'Work', icon: CheckSquare, items: [{ id: 'tasks', label: 'Tasks & Notes', count: counts.tasksPending }, { id: 'documents', label: 'Documents' }] },
    { id: 'property', label: 'Property', icon: Building2, items: [{ id: 'inventory', label: 'Inventory' }] },
    { id: 'settings', label: 'Settings', icon: Settings, items: [{ id: 'settings', label: 'Settings' }] },
  ];
}

const Count: React.FC<{ item: Item; dark?: boolean }> = ({ item, dark }) =>
  item.count ? (
    <span className={`text-[11px] font-extrabold rounded-full px-2 py-px ${item.urgent ? 'bg-[#FFE6DD] text-[#A1301A]' : dark ? 'bg-[#1D5585] text-[#E6F1FA]' : 'bg-[#EEF4F9] text-[#5E778C]'}`}>{item.count > 999 ? '999+' : item.count}</span>
  ) : null;

export const Sidebar: React.FC<SidebarProps> = ({ currentView, onNavigate, isCollapsed, onToggleCollapse, isMobileOpen, onCloseMobile, sync, isOnline, currentUser, can, features, onLogout, onNewEnquiry, counts = {}, unreadChats }) => {
  const company = useCompany();
  const logo = useLogoSrc();
  const allowed = (v: ViewId) => viewAllowed(v, { features }, can);
  const groups = buildGroups({ ...counts, unreadChats: counts.unreadChats ?? unreadChats })
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.id)) }))
    .filter((g) => g.items.length > 0);
  const activeGroup = groups.find((g) => g.items.some((i) => i.id === currentView))?.id;

  const [flyout, setFlyout] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the popup menu / profile pill on an outside click or Escape.
  useEffect(() => {
    if (!flyout && !profileOpen) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) { setFlyout(null); setProfileOpen(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setFlyout(null); setProfileOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [flyout, profileOpen]);
  useEffect(() => { setFlyout(null); setProfileOpen(false); }, [currentView, isCollapsed]);

  const offline = !isOnline || sync.status === 'offline';
  const syncBad = offline || sync.status === 'error';
  const syncText = offline ? 'Offline' : sync.status === 'error' ? 'Sync error' : sync.status === 'syncing' || sync.status === 'loading' ? 'Syncing…' : sync.lastSyncAt ? `Synced ${formatRelative(sync.lastSyncAt)}` : 'Connecting…';
  const go = () => { setFlyout(null); setProfileOpen(false); onNavigate?.(); };
  const unread = (g: Group) => g.items.some((i) => i.urgent && i.count);

  /** `expanded`: the white panel is shown (always on the mobile drawer). */
  const render = (expanded: boolean, mobile: boolean) => (
    <div ref={mobile ? undefined : rootRef} className={`relative flex h-full rounded-[28px] bg-white shadow-[0_10px_30px_rgba(11,42,68,0.10)] select-none`}>
      {/* Rail */}
      <div className="relative w-[72px] flex-none bg-[#0A1F33] rounded-[28px] flex flex-col items-center pt-5 pb-3.5 gap-1.5">
        <Link href={viewHref('dashboard')} onClick={go} className="mb-4 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]" title={company?.name || 'CRM'}>
          <AppLogo size="sm" />
        </Link>
        {!expanded && onNewEnquiry && (
          <button type="button" onClick={() => { go(); onNewEnquiry(); }} className="mb-2 w-11 h-11 rounded-[14px] bg-[#36B3F2] text-[#04263D] flex items-center justify-center hover:brightness-110" aria-label="New Enquiry" title="New Enquiry"><Plus size={20} strokeWidth={2.6} /></button>
        )}
        {groups.map((g) => {
          const Icon = g.icon;
          const on = g.id === activeGroup;
          const firstHref = viewHref(g.items[0].id);
          const button = (
            <span className={`w-11 h-11 rounded-[14px] flex items-center justify-center ${on ? 'bg-[#16466E] text-white' : 'text-[#7FA3C2] group-hover:text-white'}`}>
              <Icon size={22} strokeWidth={1.8} />
            </span>
          );
          return (
            <div key={g.id} className="relative w-full flex justify-center">
              {expanded ? (
                <Link href={firstHref} onClick={go} className="group relative w-full h-[50px] flex items-center justify-center focus-visible:outline-none" title={g.label} aria-label={g.label}>
                  {button}
                  {on && <span className="absolute right-0 top-3 bottom-3 w-1 rounded-l bg-[#36B3F2]" />}
                  {unread(g) && <span className="absolute top-2.5 right-4 w-[9px] h-[9px] rounded-full bg-[#FF8A65] ring-2 ring-[#0A1F33]" />}
                </Link>
              ) : (
                <button type="button" onClick={() => { setProfileOpen(false); setFlyout(flyout === g.id ? null : g.id); }} aria-haspopup="menu" aria-expanded={flyout === g.id}
                  className="group relative w-full h-[50px] flex items-center justify-center focus-visible:outline-none" title={g.label} aria-label={g.label}>
                  {button}
                  {on && <span className="absolute right-0 top-3 bottom-3 w-1 rounded-l bg-[#36B3F2]" />}
                  {unread(g) && <span className="absolute top-2.5 right-4 w-[9px] h-[9px] rounded-full bg-[#FF8A65] ring-2 ring-[#0A1F33]" />}
                </button>
              )}
              {!expanded && flyout === g.id && (
                <div role="menu" aria-label={g.label} className="absolute left-[78px] top-0 z-50 min-w-[200px] rounded-xl bg-[#16466E] p-1.5 shadow-[0_12px_30px_rgba(4,26,45,0.35)]">
                  <span className="absolute -left-1.5 top-[18px] w-3 h-3 bg-[#16466E] rotate-45" />
                  <div className="relative px-2.5 pt-1 pb-1.5 text-[10.5px] font-extrabold tracking-wider uppercase text-[#7FD0F7]">{g.label}</div>
                  {g.items.map((i) => (
                    <Link key={i.id} href={viewHref(i.id)} onClick={go} role="menuitem" aria-current={currentView === i.id ? 'page' : undefined}
                      className={`relative flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] ${currentView === i.id ? 'bg-[#1D5585] text-white font-bold' : 'text-[#E6F1FA] hover:bg-[#1D5585]'}`}>
                      <span>{i.label}</span><Count item={i} dark />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="flex-1" />
        {!expanded && !mobile && (
          <button type="button" onClick={onToggleCollapse} className="mb-2 w-9 h-9 rounded-full border-2 border-[#36B3F2] text-[#36B3F2] flex items-center justify-center hover:bg-[#16466E]" aria-label="Expand navigation" title="Expand navigation"><ChevronRight size={16} strokeWidth={2.6} /></button>
        )}
        <div className="flex flex-col items-center gap-1 mb-2.5 text-[10px] font-bold" title={`CRM server · ${syncText}`} style={{ color: syncBad ? '#F3B3A3' : '#7EE2AE' }}>
          <span className={`w-2 h-2 rounded-full ${sync.status === 'syncing' || sync.status === 'loading' ? 'animate-pulse' : ''}`} style={{ background: syncBad ? '#F3B3A3' : '#7EE2AE' }} />
          {offline ? 'Offline' : sync.status === 'error' ? 'Error' : 'Synced'}
        </div>
        <button type="button" onClick={() => { setFlyout(null); setProfileOpen(!profileOpen); }} aria-haspopup="dialog" aria-expanded={profileOpen} aria-label="Your profile"
          className="rounded-full ring-[3px] ring-[#16466E] hover:ring-[#36B3F2] focus-visible:outline-none focus-visible:ring-[#36B3F2]">
          <Avatar user={currentUser} size="md" />
        </button>
        {profileOpen && (
          <div role="dialog" aria-label="Your profile" className={`absolute bottom-3 z-50 flex items-center gap-2.5 whitespace-nowrap rounded-full bg-white py-1 pl-4 pr-1 shadow-[0_10px_30px_rgba(11,42,68,0.18)] ${mobile ? 'left-2 right-2 bottom-16' : 'left-[64px]'}`}>
            <span className="text-sm text-[#5E778C]"><strong className="text-[#0A1F33]">{currentUser?.name || 'Guest'}</strong>{currentUser ? ` · ${roleLabel(currentUser.role)}` : ''}</span>
            <Link href={`${viewHref('settings')}?section=profile`} onClick={go} className="inline-flex items-center gap-1.5 rounded-full bg-[#EEF4F9] px-3.5 py-2 text-xs font-extrabold tracking-wide text-[#0A1F33] hover:bg-[#E0F0FF]"><UserCircle2 size={14} />PROFILE</Link>
            <button type="button" onClick={() => { setProfileOpen(false); onLogout(); }} className="inline-flex items-center gap-1.5 rounded-full bg-[#0A1F33] px-3.5 py-2 text-xs font-extrabold tracking-wide text-white hover:bg-[#16466E]"><LogOut size={14} />SIGN OUT</button>
          </div>
        )}
      </div>

      {/* Panel */}
      {expanded && (
        <nav aria-label="Main menu" className="w-[232px] flex-none flex flex-col pl-5 pr-4 pt-5 pb-4 min-h-0">
          <div className="flex items-start justify-between gap-2">
            {logo.src ? (
              <Link href={viewHref('dashboard')} onClick={go} className="min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]" title={company?.name || 'CRM'}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logo.src} alt={company?.name || 'Company logo'} onError={logo.onError} className="h-12 w-auto max-w-full object-contain object-left" />
              </Link>
            ) : (
              <div className="min-w-0">
                <div className="text-[19px] font-bold text-[#0A1F33] leading-tight truncate" title={company?.name || 'CRM'}>{company?.name || 'CRM'}</div>
                <div className="text-xs text-[#7E93A6] truncate">{company?.tagline || 'Sales CRM'}</div>
              </div>
            )}
            {mobile && <button type="button" onClick={onCloseMobile} className="p-1.5 -mr-1 rounded-md text-[#5E778C] hover:text-[#0A1F33]" aria-label="Close menu"><X size={18} /></button>}
          </div>
          {onNewEnquiry && (
            <button type="button" onClick={() => { go(); onNewEnquiry(); }} className="mt-3 h-[42px] rounded-xl bg-[#36B3F2] text-[#04263D] text-[13.5px] font-extrabold flex items-center justify-center gap-2 hover:brightness-105">
              <Plus size={17} strokeWidth={2.6} />New Enquiry
            </button>
          )}

          <div className="flex-1 overflow-y-auto -mr-2 pr-2 mt-1">
            {groups.map((g) => (
              <div key={g.id}>
                <div className={`text-[11px] font-extrabold tracking-[.08em] uppercase mt-3 mb-1 ${g.id === activeGroup ? 'text-[#0B6BB0]' : 'text-[#0A1F33]'}`}>{g.label}</div>
                <div className="border-l border-[#DCE8F2] ml-1 flex flex-col">
                  {g.items.map((i) => {
                    const on = currentView === i.id;
                    return (
                      <Link key={i.id} href={viewHref(i.id)} onClick={go} aria-current={on ? 'page' : undefined}
                        className={`-ml-px flex items-center justify-between gap-2 rounded-r-[10px] border-l-2 py-1.5 pl-4 pr-2.5 text-sm ${on ? 'border-[#0B6BB0] bg-[#EEF6FC] font-bold text-[#0B6BB0]' : 'border-transparent text-[#5E778C] hover:bg-[#EEF6FC] hover:text-[#0F2233]'}`}>
                        <span className="truncate">{i.label || VIEW_TITLES[i.id]}</span><Count item={i} />
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="pt-3 flex flex-col gap-2.5">
            <Link href={viewHref('settings')} onClick={go} className="block rounded-xl bg-[#F2F7FB] px-3 py-2 text-xs hover:bg-[#E6F1FA]" title={`CRM server · ${syncText}`}>
              <span className="flex items-center justify-between"><span className="font-bold text-[#0A1F33]">CRM server</span><span className="font-bold" style={{ color: syncBad ? '#A1301A' : '#14653F' }}>● {offline ? 'Offline' : sync.status === 'error' ? 'Sync error' : sync.status === 'syncing' || sync.status === 'loading' ? 'Syncing' : 'Synced'}</span></span>
              {sync.lastSyncAt && <span className="block text-[11px] text-[#7E93A6] mt-0.5 truncate">Updated {formatRelative(sync.lastSyncAt)}</span>}
            </Link>
            {!mobile && (
              <button type="button" onClick={onToggleCollapse} className="self-start flex items-center gap-2.5 h-11 rounded-full bg-[#0A1F33] pl-1.5 pr-4 text-[13px] font-bold text-[#7FD0F7] hover:bg-[#16466E]">
                <span className="w-8 h-8 rounded-full border-2 border-[#36B3F2] flex items-center justify-center"><ChevronLeft size={16} strokeWidth={2.6} className="text-[#36B3F2]" /></span>
                Collapse navigation
              </button>
            )}
            <div className="flex items-center gap-2 text-[10.5px] text-[#7E93A6]" title="Developed by Broaddcast">
              <span className="whitespace-nowrap">Developed by</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/BroaddCast-Logo-blue.svg" alt="Broaddcast" className="h-6 w-auto" />
            </div>
          </div>
        </nav>
      )}
    </div>
  );

  return (
    <>
      <div className="hidden lg:flex h-screen py-3 pl-3 z-30">{render(!isCollapsed, false)}</div>
      {isMobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/40" onClick={onCloseMobile} />
          <div className="relative h-full p-2">{render(true, true)}</div>
        </div>
      )}
    </>
  );
};
