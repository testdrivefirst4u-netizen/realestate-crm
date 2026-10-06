import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, BookOpen, Plus, Bell, Sparkles, FileSpreadsheet, Menu } from 'lucide-react';
import { Lead, SyncState, UserAccount } from '../types/crm';
import { AppLogo } from './AppLogo';
import { Avatar } from './Avatar';
import { F } from '../core/config';
import { searchLeads } from '../core/analytics';
import { Permission } from '../core/rbac';
import { StageBadge } from './ui';
import { formatPhone } from '../core/phone';
import { useCompany, useFeature } from '../core/tenant';
import { VIEW_TITLES, type ViewId } from '../core/views';

interface TopbarProps {
  currentView: ViewId | null;
  leads: Lead[];
  onOpenLead: (leadId: string) => void;
  onOpenAddLead: () => void;
  onOpenLibrary: () => void;
  onOpenChatbot: (prefill?: string) => void;
  onOpenCsvModal: () => void;
  /**
   * @deprecated No longer rendered — the top-bar Sync button was removed (auto-sync keeps running in
   * the engine; the Dashboard has its own Refresh). Still accepted so existing callers compile.
   */
  onSyncNow?: () => void;
  /** @deprecated Unused since the Sync button was removed; still accepted so existing callers compile. */
  sync?: SyncState;
  unreadCount: number;
  onToggleNotificationDrawer: () => void;
  onToggleSidebarMobile?: () => void;
  currentUser: UserAccount | null;
  can: (p: Permission) => boolean;
  aiEnabled: boolean;
}

export const Topbar: React.FC<TopbarProps> = ({ currentView, leads, onOpenLead, onOpenAddLead, onOpenLibrary, onOpenChatbot, onOpenCsvModal, unreadCount, onToggleNotificationDrawer, onToggleSidebarMobile, currentUser, can, aiEnabled }) => {
  const company = useCompany();
  const libraryEnabled = useFeature('projectLibrary');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const results = useMemo(() => (q.trim() ? searchLeads(leads, q, 8) : []), [leads, q]);
  const isQuestion = q.trim().split(/\s+/).length >= 3 || /\?$/.test(q.trim());

  return (
    <header className="h-16 px-3 sm:px-6 bg-[#FDFCFA] border-b border-[#D2C9BF] flex items-center justify-between gap-3 z-20 shadow-xs">
      <div className="flex items-center gap-2 min-w-0">
        <button onClick={onToggleSidebarMobile} className="lg:hidden p-2 rounded-md text-[#1D2F3F] hover:bg-[#F4F0EB]" aria-label="Menu"><Menu size={18} /></button>
        <div className="lg:hidden"><AppLogo size="xs" /></div>
        <h1 className="text-base sm:text-lg md:text-xl font-bold text-[#1D2F3F] tracking-tight truncate">{(currentView && VIEW_TITLES[currentView]) || company?.name || 'CRM'}</h1>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <div ref={ref} className="relative w-36 sm:w-52 md:w-64">
          <div className="relative flex items-center">
            <Search size={15} className="absolute left-3 text-[#9E948D] pointer-events-none" />
            <input
              type="text" value={q}
              onChange={(e) => { setQ(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (results.length === 1 && !isQuestion) { onOpenLead(results[0][F.ID]); setQ(''); setOpen(false); }
                  else if (aiEnabled && q.trim()) { onOpenChatbot(q.trim()); setQ(''); setOpen(false); }
                }
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder={aiEnabled ? 'Search or ask the Copilot…' : 'Search leads, phone, notes…'}
              className="w-full bg-[#F4F0EB] text-[#3D3530] text-xs pl-9 pr-3 py-2 rounded-full border border-[#D2C9BF] focus:outline-none focus:border-[#A9825A] focus:bg-white transition"
            />
          </div>
          {open && q.trim() && (
            <div className="absolute top-full left-0 right-0 sm:w-96 mt-1.5 bg-white rounded-xl shadow-xl border border-[#D2C9BF] overflow-hidden z-50 max-h-96 overflow-y-auto">
              {aiEnabled && (
                <button onClick={() => { onOpenChatbot(q.trim()); setQ(''); setOpen(false); }} className="w-full flex items-center gap-2 p-3 text-left text-xs bg-[#FAF7F2] hover:bg-[#F4F0EB] border-b border-[#ECE8E1]">
                  <Sparkles size={14} className="text-[#A9825A] flex-shrink-0" />
                  <span className="truncate">Ask Copilot: <strong className="text-[#1D2F3F]">“{q.trim()}”</strong></span>
                </button>
              )}
              {results.length > 0 ? results.map((lead) => (
                <div key={lead[F.ID]} onClick={() => { setOpen(false); setQ(''); onOpenLead(lead[F.ID]); }} className="p-3 hover:bg-[#F4F0EB] cursor-pointer border-b border-[#ECE8E1] last:border-none flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#1D2F3F] truncate">{lead[F.NAME]} <span className="text-[10px] font-mono text-[#A9825A] ml-1">{lead[F.ID]}</span></div>
                    <div className="text-xs text-[#9E948D] mt-0.5 truncate">{formatPhone(lead[F.PHONE])}{lead[F.EMAIL] ? ` · ${lead[F.EMAIL]}` : ''}</div>
                  </div>
                  <div className="text-right flex-shrink-0"><StageBadge stage={lead[F.STAGE]} /><div className="text-[10px] text-[#6B5F57] mt-1">{lead[F.UNIT_TYPE] || ''}</div></div>
                </div>
              )) : (
                <div className="p-4 text-center text-xs text-[#9E948D]">No leads match “{q}”</div>
              )}
            </div>
          )}
        </div>

        {aiEnabled && (
          <button onClick={() => onOpenChatbot()} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-[#1D2F3F] text-white hover:brightness-110 shadow-xs" title="AI Copilot">
            <Sparkles size={14} className="text-[#E7D8C6]" /><span className="hidden sm:inline">AI Copilot</span>
          </button>
        )}
        {(can('leads.import') || can('leads.export')) && (
          <button onClick={onOpenCsvModal} className="hidden md:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium border border-[#D2C9BF] bg-white text-[#1D2F3F] hover:bg-[#F4F0EB]" title="CSV import / export">
            <FileSpreadsheet size={14} className="text-[#A9825A]" /><span>CSV</span>
          </button>
        )}
        {libraryEnabled && (
        <button onClick={onOpenLibrary} className="hidden md:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-[#A9825A] text-white hover:brightness-105 shadow-xs" title="Project knowledge library">
          <BookOpen size={14} /><span>Library</span>
        </button>
        )}
        <button onClick={onToggleNotificationDrawer} className="relative p-2 rounded-md text-[#1D2F3F] hover:bg-[#F4F0EB]" title="Notifications">
          <Bell size={18} />
          {unreadCount > 0 && <span className="absolute top-1 right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-[#A9825A] text-white text-[10px] font-bold flex items-center justify-center">{unreadCount > 9 ? '9+' : unreadCount}</span>}
        </button>
        <Avatar user={currentUser} size="md" title={`${currentUser?.name || ''} · ${currentUser?.role || ''}`} />
        {can('leads.create') && (
          <button onClick={onOpenAddLead} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#1D2F3F] text-white hover:brightness-110 shadow-xs">
            <Plus size={15} /><span className="hidden sm:inline">New Enquiry</span>
          </button>
        )}
      </div>
    </header>
  );
};
