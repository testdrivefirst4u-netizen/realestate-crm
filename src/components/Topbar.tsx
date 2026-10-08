import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, BookOpen, Plus, Bell, Sparkles, FileSpreadsheet, Menu, Users, MessageSquareQuote, CheckSquare, StickyNote, ListChecks, Building2, FileText, Layers, UserCircle2, ArrowRight } from 'lucide-react';
import { Lead, SyncState, UserAccount } from '../types/crm';
import { AppLogo } from './AppLogo';
import { Avatar } from './Avatar';
import { globalSearch, highlightParts, queryTerms, type SearchData, type SearchGroup, type SearchHit, type SearchKind } from '../core/globalSearch';
import { Permission } from '../core/rbac';
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
  /** Everything else the global search looks through (leads come from `leads`). */
  searchData?: Omit<SearchData, 'leads'>;
  /** Open a non-lead result: its screen, filtered to the query. Leads open with `onOpenLead`. */
  onSearchSelect?: (hit: SearchHit, query: string) => void;
  /** "Show all N" for a group: open that screen filtered to the query. */
  onSearchShowAll?: (group: SearchGroup, query: string) => void;
}

const KIND_ICON: Record<SearchKind, React.ReactNode> = {
  lead: <Users size={14} />, template: <MessageSquareQuote size={14} />, task: <CheckSquare size={14} />, note: <StickyNote size={14} />,
  checklist: <ListChecks size={14} />, unit: <Building2 size={14} />, document: <FileText size={14} />, segment: <Layers size={14} />, user: <UserCircle2 size={14} />,
};

/** Text with the query words highlighted. */
const Marked: React.FC<{ text: string; terms: string[] }> = ({ text, terms }) => (
  <>{highlightParts(text, terms).map((p, i) => (p.hit ? <mark key={i} className="bg-[#F3E4CF] text-inherit rounded-sm">{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</>
);

export const Topbar: React.FC<TopbarProps> = ({ currentView, leads, onOpenLead, onOpenAddLead, onOpenLibrary, onOpenChatbot, onOpenCsvModal, unreadCount, onToggleNotificationDrawer, onToggleSidebarMobile, currentUser, can, aiEnabled, searchData, onSearchSelect, onSearchShowAll }) => {
  const company = useCompany();
  const libraryEnabled = useFeature('projectLibrary');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const groups = useMemo(() => (q.trim() ? globalSearch({ ...(searchData || {}), leads }, q, 5) : []), [leads, searchData, q]);
  const terms = useMemo(() => queryTerms(q), [q]);
  /** Every visible result in display order, for ↑ ↓ Enter. */
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const isQuestion = q.trim().split(/\s+/).length >= 3 || /\?$/.test(q.trim());

  const close = () => { setQ(''); setOpen(false); setActive(-1); };
  const select = (hit: SearchHit) => {
    const query = q.trim();
    close();
    if (hit.kind === 'lead') onOpenLead(hit.id);
    else onSearchSelect?.(hit, query);
  };
  const showAll = (g: SearchGroup) => {
    const query = q.trim();
    close();
    onSearchShowAll?.(g, query);
  };

  return (
    <header className="h-16 px-3 sm:px-6 bg-[#FDFCFA] border-b border-[#D2C9BF] flex items-center justify-between gap-3 z-20 shadow-xs">
      <div className="flex items-center gap-2 min-w-0">
        <button onClick={onToggleSidebarMobile} className="lg:hidden p-2 rounded-md text-[#1D2F3F] hover:bg-[#F4F0EB]" aria-label="Menu"><Menu size={18} /></button>
        <div className="lg:hidden"><AppLogo size="xs" /></div>
        <h1 className="text-base sm:text-lg md:text-xl font-bold text-[#1D2F3F] tracking-tight truncate">{(currentView && VIEW_TITLES[currentView]) || company?.name || 'CRM'}</h1>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <div ref={ref} className="relative w-36 sm:w-52 md:w-72">
          <div className="relative flex items-center">
            <Search size={15} className="absolute left-3 text-[#9E948D] pointer-events-none" />
            <input
              type="text" value={q}
              onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && flat.length) { e.preventDefault(); setOpen(true); setActive((i) => (i + 1) % flat.length); }
                else if (e.key === 'ArrowUp' && flat.length) { e.preventDefault(); setActive((i) => (i <= 0 ? flat.length - 1 : i - 1)); }
                else if (e.key === 'Enter' && q.trim()) {
                  if (active >= 0 && flat[active]) select(flat[active]);
                  else if (flat.length === 1 && !isQuestion) select(flat[0]);
                  else if (aiEnabled) { onOpenChatbot(q.trim()); close(); }
                  else if (flat.length) select(flat[0]);
                }
                else if (e.key === 'Escape') setOpen(false);
              }}
              role="combobox" aria-expanded={open && !!q.trim()} aria-controls="global-search-results" aria-autocomplete="list" aria-label="Search the CRM"
              placeholder={aiEnabled ? 'Search everything or ask the Copilot…' : 'Search leads, templates, tasks, units…'}
              className="w-full bg-[#F4F0EB] text-[#3D3530] text-xs pl-9 pr-3 py-2 rounded-full border border-[#D2C9BF] focus:outline-none focus:border-[#A9825A] focus:bg-white transition"
            />
          </div>
          {open && q.trim() && (
            <div id="global-search-results" role="listbox" aria-label="Search results" className="fixed left-3 right-3 top-15 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-md mt-1.5 bg-white rounded-xl shadow-xl border border-[#D2C9BF] overflow-hidden z-50 max-h-[70vh] overflow-y-auto">
              {aiEnabled && (
                <button type="button" onClick={() => { onOpenChatbot(q.trim()); close(); }} className="w-full flex items-center gap-2 p-3 text-left text-xs bg-[#FAF7F2] hover:bg-[#F4F0EB] border-b border-[#ECE8E1]">
                  <Sparkles size={14} className="text-[#A9825A] flex-shrink-0" />
                  <span className="truncate">Ask Copilot: <strong className="text-[#1D2F3F]">“{q.trim()}”</strong></span>
                </button>
              )}
              {groups.length > 0 ? groups.map((g) => (
                <div key={g.kind} role="group" aria-label={g.label} className="border-b border-[#ECE8E1] last:border-none pb-1">
                  <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#8A6942]">{g.label} <span className="font-medium text-[#A39990]">{g.total}</span></span>
                    {g.total > g.hits.length && onSearchShowAll && (
                      <button type="button" onClick={() => showAll(g)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#7A5B37] hover:underline">
                        Show all {g.total} <ArrowRight size={11} />
                      </button>
                    )}
                  </div>
                  {g.hits.map((hit) => {
                    const idx = flat.indexOf(hit);
                    const on = idx === active;
                    return (
                      <button key={hit.kind + hit.id} type="button" role="option" aria-selected={on} onMouseEnter={() => setActive(idx)} onClick={() => select(hit)}
                        className={`w-full flex items-start gap-2.5 px-3 py-2 text-left ${on ? 'bg-[#F4F0EB]' : 'hover:bg-[#FAF7F2]'}`}>
                        <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#F4F0EB] text-[#7A5B37]">{KIND_ICON[hit.kind]}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-[#1D2F3F]"><Marked text={hit.title} terms={terms} /></span>
                          {hit.subtitle && <span className="block truncate text-[11px] text-[#6B5F57]"><Marked text={hit.subtitle} terms={terms} /></span>}
                          {hit.snippet && hit.snippet !== hit.title && <span className="mt-0.5 block text-[11px] leading-snug text-[#8A7F77] line-clamp-2"><Marked text={hit.snippet} terms={terms} /></span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )) : (
                <div className="p-4 text-center text-xs text-[#9E948D]">Nothing in the CRM matches “{q.trim()}”</div>
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
