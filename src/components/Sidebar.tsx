import React from 'react';
import Link from 'next/link';
import {
  LayoutDashboard, Users, MessageCircle, CheckSquare, Building2, Settings, ChevronLeft, ChevronRight, LogOut, UserCircle2, X,
  ChartColumn, TrendingUp, FileChartColumn, SquareKanban, CalendarClock, ChartPie, PhoneCall, LayoutTemplate, FolderOpen, ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { SyncState, UserAccount } from '../types/crm';
import { AppLogo } from './AppLogo';
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
  counts?: SidebarCounts;
  /** @deprecated Use `counts.unreadChats`. */
  unreadChats?: number;
}

interface Item { id: ViewId; label: string; icon: LucideIcon; count?: number; urgent?: boolean }
interface Group { id: string; label: string; items: Item[] }

/** The screens, in sections; every screen has its own icon (the collapsed sidebar shows the icons alone). */
function buildGroups(counts: SidebarCounts): Group[] {
  return [
    { id: 'overview', label: 'Overview', items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }, { id: 'mis', label: 'Sales MIS', icon: ChartColumn },
      { id: 'performance', label: 'YTD / MTD', icon: TrendingUp }, { id: 'reports', label: 'Reports', icon: FileChartColumn },
    ] },
    { id: 'leads', label: 'Leads', items: [
      { id: 'leads', label: 'All Leads', icon: Users, count: counts.leads }, { id: 'kanban', label: 'Enquiry Status', icon: SquareKanban },
      { id: 'followups', label: 'Follow-ups', icon: CalendarClock, count: counts.followupsToday, urgent: true }, { id: 'segments', label: 'Client Segments', icon: ChartPie },
    ] },
    { id: 'messages', label: 'Messages', items: [
      { id: 'chat360', label: 'WhatsApp (Chat360)', icon: MessageCircle, count: counts.unreadChats, urgent: true }, { id: 'calls', label: 'Call History', icon: PhoneCall },
    ] },
    { id: 'work', label: 'Workspace', items: [
      { id: 'inventory', label: 'Inventory', icon: Building2 }, { id: 'tasks', label: 'Tasks & Notes', icon: CheckSquare, count: counts.tasksPending },
      { id: 'templates', label: 'Templates', icon: LayoutTemplate }, { id: 'documents', label: 'Documents', icon: FolderOpen },
    ] },
    { id: 'admin', label: 'Admin', items: [{ id: 'settings', label: 'Settings', icon: Settings }, { id: 'audit', label: 'Audit Log', icon: ShieldCheck }] },
  ];
}

const countText = (n: number) => (n > 999 ? '999+' : String(n));

export const Sidebar: React.FC<SidebarProps> = ({ currentView, onNavigate, isCollapsed, onToggleCollapse, isMobileOpen, onCloseMobile, sync, isOnline, currentUser, can, features, onLogout, counts = {}, unreadChats }) => {
  const company = useCompany();
  const allowed = (v: ViewId) => viewAllowed(v, { features }, can);
  const groups = buildGroups({ ...counts, unreadChats: counts.unreadChats ?? unreadChats })
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.id)) }))
    .filter((g) => g.items.length > 0);

  const offline = !isOnline || sync.status === 'offline';
  const syncBad = offline || sync.status === 'error';
  const syncLabel = offline ? 'Offline' : sync.status === 'error' ? 'Sync error' : sync.status === 'syncing' || sync.status === 'loading' ? 'Syncing' : 'Synced';
  const syncText = offline ? 'Offline' : sync.status === 'error' ? 'Sync error' : sync.status === 'syncing' || sync.status === 'loading' ? 'Syncing…' : sync.lastSyncAt ? `Synced ${formatRelative(sync.lastSyncAt)}` : 'Connecting…';
  const go = () => onNavigate?.();

  /** One screen: icon + label (+ count); icons only when the sidebar is narrow. */
  const link = (i: Item, narrow: boolean, mobile: boolean) => {
    const on = currentView === i.id;
    const Icon = i.icon;
    return (
      <Link
        key={i.id}
        href={viewHref(i.id)}
        onClick={go}
        aria-current={on ? 'page' : undefined}
        title={narrow ? i.label : undefined}
        aria-label={narrow ? i.label : undefined}
        className={`group relative flex items-center rounded-xl transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2] ${narrow ? 'justify-center h-11 w-11 mx-auto' : `gap-3 px-3 ${mobile ? 'min-h-[44px]' : 'h-10'}`} ${
          on ? 'bg-gradient-to-r from-[#1E6FB0] to-[#175A92] text-white shadow-[0_6px_18px_rgba(10,60,110,0.45)]' : 'text-[#BFD3E6] hover:bg-white/[0.07] hover:text-white'
        }`}
      >
        {on && !narrow && <span className="absolute -left-3 top-2 bottom-2 w-1 rounded-r-full bg-[#5CC8FF]" />}
        <Icon size={18} strokeWidth={on ? 2.2 : 1.8} className={`shrink-0 ${on ? 'text-white' : 'text-[#8FB2D1] group-hover:text-white'}`} />
        {!narrow && <span className={`truncate flex-1 text-[13.5px] ${on ? 'font-bold' : 'font-medium'}`}>{i.label || VIEW_TITLES[i.id]}</span>}
        {!narrow && !!i.count && (
          <span className={`text-[11px] font-extrabold rounded-full px-2 py-px ${i.urgent ? 'bg-[#FF8A65] text-[#3D1206]' : on ? 'bg-white/20 text-white' : 'bg-white/10 text-[#D7E6F3]'}`}>{countText(i.count)}</span>
        )}
        {narrow && !!i.count && (
          <span className={`absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-[#0B2A44] ${i.urgent ? 'bg-[#FF8A65]' : 'bg-[#5CC8FF]'}`} aria-hidden="true" />
        )}
      </Link>
    );
  };

  /** The whole sidebar: navy panel, sections, profile and sync at the bottom. */
  const panel = (narrow: boolean, mobile: boolean) => (
    <nav
      aria-label="Main menu"
      className={`relative h-full flex flex-col rounded-[24px] bg-gradient-to-b from-[#0E3253] via-[#0B2A44] to-[#081E33] text-white shadow-[0_14px_40px_rgba(8,30,51,0.35)] select-none overflow-hidden ${
        mobile ? 'w-[min(300px,calc(100vw-24px))]' : narrow ? 'w-[76px]' : 'w-[256px]'
      }`}
    >
      {/* soft light in the corner */}
      <span aria-hidden="true" className="pointer-events-none absolute -top-24 -right-20 w-56 h-56 rounded-full bg-[#2E8BD8]/20 blur-3xl" />

      {/* company */}
      <div className={`relative flex items-center ${narrow ? 'justify-center pt-5 pb-4' : 'gap-3 px-5 pt-5 pb-4'}`}>
        <Link href={viewHref('dashboard')} onClick={go} className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]" title={company?.name || 'CRM'}>
          <AppLogo size="sm" />
        </Link>
        {!narrow && (
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold leading-tight truncate" title={company?.name || 'CRM'}>{company?.name || 'CRM'}</div>
            <div className="text-[11px] text-[#8FB2D1] truncate">{company?.tagline || 'Sales CRM'}</div>
          </div>
        )}
        {mobile && (
          <button type="button" onClick={onCloseMobile} className="w-10 h-10 -mr-2 flex items-center justify-center rounded-lg text-[#BFD3E6] hover:text-white hover:bg-white/10" aria-label="Close menu"><X size={20} /></button>
        )}
      </div>

      {/* screens */}
      <div className={`relative flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-none ${narrow ? 'px-2' : 'px-3'} pb-3`}>
        {groups.map((g, gi) => (
          <div key={g.id} className={gi ? 'mt-4' : 'mt-1'}>
            {narrow
              ? gi > 0 && <div className="mx-3 mb-3 border-t border-white/10" aria-hidden="true" />
              : <div className="px-3 mb-1.5 text-[10.5px] font-bold tracking-[.12em] uppercase text-[#6F94B6]">{g.label}</div>}
            <div className="flex flex-col gap-0.5">{g.items.map((i) => link(i, narrow, mobile))}</div>
          </div>
        ))}
      </div>

      {/* you, the server, collapse */}
      <div className={`relative border-t border-white/10 ${narrow ? 'px-2 py-3' : 'px-3 py-3'} flex flex-col gap-2.5`}>
        {narrow ? (
          <>
            <span className="mx-auto w-2 h-2 rounded-full" style={{ background: syncBad ? '#F3B3A3' : '#7EE2AE' }} title={`CRM server · ${syncText}`} aria-label={`CRM server ${syncLabel}`} role="img" />
            <Link href={`${viewHref('settings')}?section=profile`} onClick={go} className="mx-auto rounded-full ring-2 ring-white/15 hover:ring-[#5CC8FF]" title={currentUser ? `${currentUser.name} · ${roleLabel(currentUser.role)}` : 'Your profile'} aria-label="Your profile">
              <Avatar user={currentUser} size="md" />
            </Link>
            <button type="button" onClick={onToggleCollapse} className="mx-auto w-9 h-9 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20" aria-label="Expand navigation" title="Expand navigation"><ChevronRight size={16} strokeWidth={2.6} /></button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 rounded-2xl bg-white/[0.06] p-2.5">
              <Avatar user={currentUser} size="md" />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[13px] font-bold truncate">{currentUser?.name || 'Guest'}</div>
                {currentUser && <div className="text-[11px] text-[#8FB2D1] truncate">{roleLabel(currentUser.role)}</div>}
              </div>
              <Link href={`${viewHref('settings')}?section=profile`} onClick={go} className={`${mobile ? 'w-10 h-10' : 'w-8 h-8'} rounded-lg text-[#BFD3E6] flex items-center justify-center hover:bg-white/10 hover:text-white`} aria-label="Profile" title="Profile"><UserCircle2 size={17} /></Link>
              <button type="button" onClick={() => { go(); onLogout(); }} className={`${mobile ? 'w-10 h-10' : 'w-8 h-8'} rounded-lg text-[#BFD3E6] flex items-center justify-center hover:bg-[#FF8A65]/20 hover:text-[#FFB59E]`} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
            </div>
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="min-w-0 text-[11px] truncate" title={`CRM server · ${syncText}`}>
                <span className="font-bold" style={{ color: syncBad ? '#F3B3A3' : '#7EE2AE' }}>● {syncLabel}</span>
                {sync.lastSyncAt && <span className="text-[#6F94B6]"> · {formatRelative(sync.lastSyncAt)}</span>}
              </span>
              {!mobile && (
                <button type="button" onClick={onToggleCollapse} className="w-8 h-8 flex-none rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20" aria-label="Collapse navigation" title="Collapse navigation">
                  <ChevronLeft size={15} strokeWidth={2.6} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 px-1 text-[10px] text-[#6F94B6]" title="Developed by Broaddcast">
              <span className="whitespace-nowrap">Developed by</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/broaddcast_logo-white.svg" alt="Broaddcast" className="h-4 w-auto opacity-80" />
            </div>
          </>
        )}
      </div>
    </nav>
  );

  return (
    <>
      <div className="hidden lg:flex h-full py-3 pl-3 z-30">{panel(isCollapsed, false)}</div>
      {isMobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-[#04121F]/55 backdrop-blur-[2px]" onClick={onCloseMobile} />
          <div className="relative h-full p-2">{panel(false, true)}</div>
        </div>
      )}
    </>
  );
};
