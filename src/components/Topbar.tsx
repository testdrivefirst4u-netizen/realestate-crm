import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, BookOpen, Plus, Bell, Sparkles, FileSpreadsheet, Menu, Users, MessageSquareQuote, CheckSquare, StickyNote, ListChecks, Building2, FileText, Layers, UserCircle2, ArrowRight } from 'lucide-react';
import { Lead, SyncState, UserAccount } from '../types/crm';
import { AppLogo } from './AppLogo';
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
  /** @deprecated The avatar moved to the sidebar; still accepted so callers compile. */
  currentUser?: UserAccount | null;
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
  <>{highlightParts(text, terms).map((p, i) => (p.hit ? <mark key={i} className="bg-[#D6EEFC] text-inherit rounded-sm">{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</>
);

export const Topbar: React.FC<TopbarProps> = ({ currentView, leads, onOpenLead, onOpenAddLead, onOpenLibrary, onOpenChatbot, onOpenCsvModal, unreadCount, onToggleNotificationDrawer, onToggleSidebarMobile, can, aiEnabled, searchData, onSearchSelect, onSearchShowAll }) => {
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
    <header className="h-[68px] px-3 sm:px-6 bg-white border-b border-[#DCE8F2] flex items-center gap-2 sm:gap-3 z-20">
      {/* Phones: menu + current screen (the sidebar holds the navigation on larger screens) */}
      <div className="lg:hidden flex items-center gap-2 min-w-0">
        <button onClick={onToggleSidebarMobile} className="p-2 rounded-lg text-[#0B2A44] hover:bg-[#F2F7FB]" aria-label="Menu"><Menu size={19} /></button>
        <AppLogo size="xs" />
        <h1 className="hidden sm:block text-base font-bold text-[#0B2A44] tracking-tight truncate">{(currentView && VIEW_TITLES[currentView]) || company?.name || 'CRM'}</h1>
      </div>

        <div ref={ref} className="relative flex-1 min-w-0 max-w-[460px] ml-auto lg:ml-0">
          <div className="relative flex items-center">
            <Search size={16} className="absolute left-3 text-[#5E778C] pointer-events-none" />
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
              className="w-full bg-[#F2F7FB] text-[#0F2233] text-[13.5px] pl-9 pr-3 py-2.5 rounded-xl border border-[#DCE8F2] placeholder:text-[#7E93A6] focus:outline-none focus:border-[#36B3F2] focus:bg-white transition"
            />
          </div>
          {open && q.trim() && (
            <div id="global-search-results" role="listbox" aria-label="Search results" className="fixed left-3 right-3 top-15 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-md mt-1.5 bg-white rounded-xl shadow-xl border border-[#D3E3F0] overflow-hidden z-50 max-h-[70vh] overflow-y-auto">
              {aiEnabled && (
                <button type="button" onClick={() => { onOpenChatbot(q.trim()); close(); }} className="w-full flex items-center gap-2 p-3 text-left text-xs bg-[#F7FAFD] hover:bg-[#F2F7FB] border-b border-[#E6EFF6]">
                  <Sparkles size={14} className="text-[#0B6BB0] flex-shrink-0" />
                  <span className="truncate">Ask Copilot: <strong className="text-[#0B2A44]">“{q.trim()}”</strong></span>
                </button>
              )}
              {groups.length > 0 ? groups.map((g) => (
                <div key={g.kind} role="group" aria-label={g.label} className="border-b border-[#E6EFF6] last:border-none pb-1">
                  <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#0B5E9C]">{g.label} <span className="font-medium text-[#8EA3B5]">{g.total}</span></span>
                    {g.total > g.hits.length && onSearchShowAll && (
                      <button type="button" onClick={() => showAll(g)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0B5E9C] hover:underline">
                        Show all {g.total} <ArrowRight size={11} />
                      </button>
                    )}
                  </div>
                  {g.hits.map((hit) => {
                    const idx = flat.indexOf(hit);
                    const on = idx === active;
                    return (
                      <button key={hit.kind + hit.id} type="button" role="option" aria-selected={on} onMouseEnter={() => setActive(idx)} onClick={() => select(hit)}
                        className={`w-full flex items-start gap-2.5 px-3 py-2 text-left ${on ? 'bg-[#F2F7FB]' : 'hover:bg-[#F7FAFD]'}`}>
                        <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#F2F7FB] text-[#0B5E9C]">{KIND_ICON[hit.kind]}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-[#0B2A44]"><Marked text={hit.title} terms={terms} /></span>
                          {hit.subtitle && <span className="block truncate text-[11px] text-[#5E778C]"><Marked text={hit.subtitle} terms={terms} /></span>}
                          {hit.snippet && hit.snippet !== hit.title && <span className="mt-0.5 block text-[11px] leading-snug text-[#6F8698] line-clamp-2"><Marked text={hit.snippet} terms={terms} /></span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )) : (
                <div className="p-4 text-center text-xs text-[#7E93A6]">Nothing in the CRM matches “{q.trim()}”</div>
              )}
            </div>
          )}
        </div>

      <div className="hidden lg:block flex-1" />
      <div className="flex items-center gap-2 sm:gap-2.5 flex-none">
        {aiEnabled && (
          <button onClick={() => onOpenChatbot()} className="inline-flex items-center gap-2 px-3 sm:px-4 h-11 rounded-xl text-[13.5px] font-bold bg-[#0B2A44] text-white hover:bg-[#123A5C]" title="AI Copilot" aria-label="AI Copilot">
            <Sparkles size={16} className="text-[#36B3F2]" /><span className="hidden sm:inline">AI Copilot</span>
          </button>
        )}
        {(can('leads.import') || can('leads.export')) && (
          <button onClick={onOpenCsvModal} className="hidden md:inline-flex items-center gap-2 px-4 h-11 rounded-xl text-[13.5px] font-bold border border-[#D3E3F0] bg-white text-[#0F2233] hover:bg-[#F2F7FB]" title="CSV import / export">
            <FileSpreadsheet size={16} className="text-[#0B6BB0]" /><span>CSV</span>
          </button>
        )}
        {libraryEnabled && (
        <button onClick={onOpenLibrary} className="hidden md:inline-flex items-center gap-2 px-4 h-11 rounded-xl text-[13.5px] font-bold border border-[#D3E3F0] bg-white text-[#0F2233] hover:bg-[#F2F7FB]" title="Project knowledge library">
          <BookOpen size={16} className="text-[#0B6BB0]" /><span>Library</span>
        </button>
        )}
        <button onClick={onToggleNotificationDrawer} className="relative w-11 h-11 rounded-xl border border-[#D3E3F0] bg-white text-[#0F2233] hover:bg-[#F2F7FB] flex items-center justify-center" title="Notifications" aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}>
          <Bell size={18} />
          {unreadCount > 0 && <span className="absolute top-1 right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-[#FF8A65] text-[#3A1205] text-[10px] font-extrabold flex items-center justify-center">{unreadCount > 9 ? '9+' : unreadCount}</span>}
        </button>
        {/* New Enquiry lives in the sidebar; on phones (no sidebar) it is here */}
        {can('leads.create') && (
          <button onClick={onOpenAddLead} className="lg:hidden w-11 h-11 rounded-xl bg-[#36B3F2] text-[#04263D] flex items-center justify-center" aria-label="New Enquiry" title="New Enquiry">
            <Plus size={19} strokeWidth={2.6} />
          </button>
        )}
      </div>
    </header>
  );
};
