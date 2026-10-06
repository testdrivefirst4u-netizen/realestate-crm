import React from 'react';
import {
  LayoutDashboard, Users, KanbanSquare, CalendarClock, CheckSquare, Building2, FileText, MessageSquareQuote, BarChart3, Settings, ChevronLeft, ChevronRight,
  Database, Layers, History, LogOut, MessageCircle, PhoneCall, WifiOff, X,
} from 'lucide-react';
import { SyncState, UserAccount } from '../types/crm';
import { AppLogo } from './AppLogo';
import { Avatar } from './Avatar';
import { hasFeature, useCompany } from '../core/tenant';
import { formatRelative } from '../core/dates';
import { Permission } from '../core/rbac';
import { roleLabel } from '../core/rbac';

export type ViewId =
  | 'dashboard' | 'leads' | 'segments' | 'kanban' | 'followups' | 'tasks' | 'inventory' | 'chat360' | 'calls'
  | 'documents' | 'templates' | 'reports' | 'audit' | 'settings';

interface SidebarProps {
  currentView: ViewId;
  onSelectView: (view: ViewId) => void;
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
  unreadChats?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentView, onSelectView, isCollapsed, onToggleCollapse, isMobileOpen, onCloseMobile, sync, isOnline, currentUser, can, features, onLogout, unreadChats }) => {
  const company = useCompany();
  const on = (name: Parameters<typeof hasFeature>[1]) => hasFeature({ features }, name);
  const navItems: Array<{ id: ViewId; label: string; icon: any; show: boolean; badge?: number }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, show: true },
    { id: 'leads', label: 'All Leads', icon: Users, show: true },
    { id: 'kanban', label: 'Enquiry Status', icon: KanbanSquare, show: true },
    { id: 'followups', label: 'Follow-ups', icon: CalendarClock, show: true },
    { id: 'tasks', label: 'Tasks & Notes', icon: CheckSquare, show: true },
    { id: 'chat360', label: 'WhatsApp (Chat360)', icon: MessageCircle, show: on('chat360') && can('chat.view'), badge: unreadChats },
    { id: 'calls', label: 'Call History', icon: PhoneCall, show: on('calls') && can('calls.view') },
    { id: 'inventory', label: 'Inventory', icon: Building2, show: on('inventory') && can('inventory.view') },
    { id: 'segments', label: 'Client Segments', icon: Layers, show: on('segments') },
    { id: 'documents', label: 'Documents', icon: FileText, show: on('documents') },
    { id: 'templates', label: 'Templates', icon: MessageSquareQuote, show: on('templates') },
    { id: 'reports', label: 'Reports', icon: BarChart3, show: on('reports') && can('reports.view') },
    { id: 'audit', label: 'Audit Log', icon: History, show: can('audit.view') },
    { id: 'settings', label: 'Settings', icon: Settings, show: true },
  ];

  const statusText = !isOnline || sync.status === 'offline' ? 'Offline' : sync.status === 'error' ? 'Sync error' : sync.status === 'syncing' || sync.status === 'loading' ? 'Syncing…' : sync.lastSyncAt ? `Synced ${formatRelative(sync.lastSyncAt)}` : 'Connecting…';
  const statusTone = !isOnline || sync.status === 'offline' || sync.status === 'error' ? 'text-[#E7A98A]' : 'text-[#9FB49B]';

  const content = (
    <aside className={`relative flex flex-col bg-[#1D2F3F] text-[#E7D8C6] transition-all duration-300 z-30 select-none h-full ${isCollapsed ? 'lg:w-20' : 'lg:w-64'} w-72`}>
      <button onClick={onToggleCollapse} className="hidden lg:flex absolute -right-3 top-7 w-6 h-6 rounded-full bg-[#A9825A] text-white items-center justify-center hover:brightness-110 shadow-md z-40" title={isCollapsed ? 'Expand' : 'Collapse'}>
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
      <button onClick={onCloseMobile} className="lg:hidden absolute right-3 top-4 p-1.5 rounded-md text-[#E7D8C6]/70 hover:text-white" aria-label="Close menu"><X size={18} /></button>

      <div className="py-3.5 px-3.5 border-b border-[#E7D8C6]/15 flex items-center min-h-[64px] overflow-hidden">
        {isCollapsed ? (
          <div className="w-full hidden lg:flex justify-center"><AppLogo size="sm" /></div>
        ) : null}
        <div className={`flex items-center gap-2.5 w-full min-w-0 ${isCollapsed ? 'lg:hidden' : ''}`}>
          <AppLogo size="sm" className="flex-shrink-0" />
          <div className="flex flex-col min-w-0 flex-1 overflow-hidden">
            <span className="font-bold text-base text-white tracking-tight truncate leading-tight" title={company?.name || 'CRM'}>{company?.name || 'CRM'}</span>
            <span className="text-[10px] text-[#E7D8C6]/60 truncate">{company?.tagline || 'Sales CRM'}</span>
          </div>
        </div>
      </div>

      <nav className="flex-1 py-3 overflow-y-auto space-y-0.5 px-3">
        {navItems.filter((i) => i.show).map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button key={item.id} onClick={() => onSelectView(item.id)} title={isCollapsed ? item.label : undefined}
              className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all group ${isActive ? 'bg-[#E7D8C6]/12 text-white font-semibold border-l-4 border-[#A9825A]' : 'text-[#E7D8C6]/75 hover:bg-[#E7D8C6]/6 hover:text-white'}`}>
              <Icon size={18} className={`flex-shrink-0 ${isActive ? 'text-[#A9825A]' : 'text-[#E7D8C6]/60 group-hover:text-[#E7D8C6]'}`} />
              <span className={`truncate flex-1 text-left ${isCollapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
              {!!item.badge && <span className={`text-[10px] font-bold bg-[#A9825A] text-white rounded-full px-1.5 ${isCollapsed ? 'lg:hidden' : ''}`}>{item.badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="px-3 pt-2 pb-1 border-t border-[#E7D8C6]/15">
        <div className={`flex items-center gap-2.5 p-2 rounded-lg border border-[#E7D8C6]/10 ${isCollapsed ? 'lg:justify-center' : ''}`}>
          <Avatar user={currentUser} size="sm" className="ring-1 ring-[#E7D8C6]/25" title={isCollapsed && currentUser ? `${currentUser.name} · ${roleLabel(currentUser.role)}` : undefined} />
          <div className={`flex-1 overflow-hidden text-left ${isCollapsed ? 'lg:hidden' : ''}`}>
            <div className="text-xs font-semibold text-white truncate">{currentUser?.name || 'Guest'}</div>
            <div className="text-[10px] text-[#A9825A] truncate">{currentUser ? roleLabel(currentUser.role) : ''}</div>
          </div>
          <button onClick={onLogout} title="Sign out" className={`p-1.5 rounded-md text-[#E7D8C6]/60 hover:text-white hover:bg-[#E7D8C6]/10 ${isCollapsed ? 'lg:hidden' : ''}`}><LogOut size={14} /></button>
        </div>
      </div>

      <div className="p-3">
        <button onClick={() => onSelectView('settings')} className={`w-full flex items-center gap-2.5 p-2 rounded-lg bg-[#1D2F3F]/70 hover:bg-[#162330] border border-[#E7D8C6]/10 transition ${isCollapsed ? 'lg:justify-center' : ''}`} title="Server sync status">
          <div className="relative">
            {!isOnline ? <WifiOff size={16} className="text-[#E7A98A]" /> : <Database size={16} className={sync.status === 'error' ? 'text-[#E7A98A]' : 'text-[#7C8B78]'} />}
            {(sync.status === 'syncing' || sync.status === 'loading') && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-[#A9825A] animate-ping" />}
          </div>
          <div className={`flex flex-col text-left overflow-hidden ${isCollapsed ? 'lg:hidden' : ''}`}>
            <span className="text-[11px] font-semibold text-white truncate">CRM server</span>
            <span className={`text-[10px] truncate ${statusTone}`}>{statusText}</span>
          </div>
        </button>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden lg:flex h-screen">{content}</div>
      {isMobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/40" onClick={onCloseMobile} />
          <div className="relative h-full">{content}</div>
        </div>
      )}
    </>
  );
};
