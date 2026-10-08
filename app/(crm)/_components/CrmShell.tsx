'use client';

/**
 * The signed-in CRM frame, rendered once by app/(crm)/layout.tsx and kept across navigations:
 * the data engine (sync, optimistic writes, alarms), sidebar, top bar and every app-wide overlay
 * (lead drawer, add lead, copilot, library, CSV, notifications).
 *
 * Screens are App Router pages that read the engine through `useCrm()`. The open lead lives in the
 * URL (`?lead=ENQ-0001`) on any screen, so it survives reloads and back/forward closes it.
 */
import React, { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Sidebar } from '@/src/components/Sidebar';
import { Topbar } from '@/src/components/Topbar';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { Toasts } from '@/src/components/Toasts';
import { PageSkeleton, VIEW_SKELETON } from '@/src/components/Skeletons';
import { AppLogo } from '@/src/components/AppLogo';
import { LeadDetailModal } from '@/src/modules/leads/LeadDetailModal';
import { AddLeadModal } from '@/src/modules/leads/AddLeadModal';
import { AlarmModal } from '@/src/modules/tasks/AlarmModal';
import { NotificationDrawer } from '@/src/modules/notifications/NotificationDrawer';
import type { CopilotContext, OpenCopilot } from '@/src/modules/ai/copilotContext';
import { useCrmEngine, type CrmEngine, type CrmEngineInit } from '@/src/core/engine';
import { notifications } from '@/src/core/notifications';
import { SIGNED_OUT_REASON_KEY } from '@/src/core/persistence';
import { F } from '@/src/core/config';
import { TenantProvider, companyOf, hasFeature, resolveFeatures, type FeatureName } from '@/src/core/tenant';
import { DEFAULT_VIEW, viewAllowed, viewFromPath, viewHref, type ViewId } from '@/src/core/views';
import { initGlobalFontAutoScaler } from '@/src/utils/fontSizeAdjuster';
import type { NotificationItem } from '@/src/types/crm';
import { searchLeads } from '@/src/core/analytics';
import type { SearchGroup, SearchHit } from '@/src/core/globalSearch';

const CopilotDrawer = lazy(() => import('@/src/modules/ai/CopilotDrawer').then((m) => ({ default: m.CopilotDrawer })));
const LibraryModal = lazy(() => import('@/src/components/LibraryModal').then((m) => ({ default: m.LibraryModal })));
const CsvImportExportModal = lazy(() => import('@/src/components/CsvImportExportModal').then((m) => ({ default: m.CsvImportExportModal })));

export interface CrmContextValue {
  engine: CrmEngine;
  /** Open a lead's detail drawer (`?lead=…` on the current screen). */
  openLead: (id: string) => void;
  openAddLead: () => void;
  openLibrary: (query?: string) => void;
  /** Undefined when the plan has no AI. */
  openCopilot: OpenCopilot | undefined;
  /** Dashboard / copilot drill-down: show these leads on the Leads screen. */
  showLeads: (label: string, ids: string[]) => void;
  leadFilter: { label: string; ids: Set<string> } | null;
  clearLeadFilter: () => void;
  on: (feature: FeatureName) => boolean;
  /** AI buttons (reframe, summary, suggestions…) need both a configured key and the plan's AI feature. */
  aiConfigured: boolean;
  rmOptions: string[];
}

const CrmContext = createContext<CrmContextValue | null>(null);

export function useCrm(): CrmContextValue {
  const ctx = useContext(CrmContext);
  if (!ctx) throw new Error('useCrm() is only available inside the CRM layout');
  return ctx;
}

export function CrmShell({ init, children }: { init: CrmEngineInit; children: React.ReactNode }) {
  const engine = useCrmEngine(init);
  const { data, currentUser, sync, authStatus } = engine;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentView = viewFromPath(pathname);

  // Screens use window, localStorage and the clock while rendering: they render after hydration
  // (the server sends the frame; the engine loads the data in the browser anyway).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /* ---------------------------- lead drawer ----------------------------- */

  const selectedLeadId = searchParams.get('lead') || null;
  /** True while the open drawer was opened by a history entry of ours — closing it then goes Back. */
  const leadPushedRef = useRef(false);
  useEffect(() => {
    if (!selectedLeadId) leadPushedRef.current = false;
  }, [selectedLeadId]);

  const urlWith = useCallback(
    (lead: string | null) => {
      const q = new URLSearchParams(searchParams.toString());
      if (lead) q.set('lead', lead);
      else q.delete('lead');
      const qs = q.toString();
      return `${pathname}${qs ? `?${qs}` : ''}`;
    },
    [pathname, searchParams]
  );

  const openLead = useCallback(
    (id: string) => {
      if (selectedLeadId) {
        router.replace(urlWith(id), { scroll: false }); // switching leads replaces the entry
      } else {
        leadPushedRef.current = true;
        router.push(urlWith(id), { scroll: false });
      }
    },
    [router, selectedLeadId, urlWith]
  );

  const closeLead = useCallback(() => {
    if (leadPushedRef.current) router.back(); // undo the entry that opened it, so Back does not reopen it
    else router.replace(urlWith(null), { scroll: false });
  }, [router, urlWith]);

  const selectedLead = useMemo(() => data.leads.find((l) => l[F.ID] === selectedLeadId) || null, [data.leads, selectedLeadId]);
  // `?lead=` pointing at a lead that does not exist (deleted, mistyped) → drop it once the data is in.
  const leadMissing = sync.hasLoadedOnce && !!selectedLeadId && !selectedLead;
  useEffect(() => {
    if (leadMissing) router.replace(urlWith(null), { scroll: false });
  }, [leadMissing, router, urlWith]);

  /* ------------------------------ features ------------------------------ */

  const serverSettings = data.serverSettings;
  const features = useMemo(() => resolveFeatures(serverSettings), [serverSettings]);
  const on = useCallback((name: FeatureName) => hasFeature(serverSettings, name), [serverSettings]);
  const companyName = companyOf(serverSettings)?.name || '';
  const aiOn = on('aiCopilot');
  const aiConfigured = !!data.settings.aiConfigured && aiOn;
  const libraryOn = on('projectLibrary');
  const rmOptions = useMemo(() => data.config.options[F.RM] || [], [data.config]);

  // The server checked the screen before rendering; the plan or role can still change while the app is open.
  const currentViewAllowed = !currentView || viewAllowed(currentView, serverSettings, engine.can);
  useEffect(() => {
    if (!currentViewAllowed) router.replace(viewHref(DEFAULT_VIEW));
  }, [currentViewAllowed, router]);

  /* ------------------------------ sign-out ------------------------------ */

  const signingOutRef = useRef(false);
  const handleLogout = useCallback(async () => {
    signingOutRef.current = true;
    await engine.logout();
    router.replace('/login');
  }, [engine, router]);

  // The server ended the session (expired, revoked, company suspended): sign in again, then come back here.
  useEffect(() => {
    if (authStatus !== 'login' || signingOutRef.current) return;
    try {
      if (sync.lastError) sessionStorage.setItem(SIGNED_OUT_REASON_KEY, sync.lastError);
    } catch {
      /* ignore */
    }
    const here = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(here)}`);
  }, [authStatus, sync.lastError, router]);

  /* ------------------------------ overlays ------------------------------ */

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isAddLeadOpen, setIsAddLeadOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [libraryInitialQuery, setLibraryInitialQuery] = useState('');
  const [isCsvModalOpen, setIsCsvModalOpen] = useState(false);
  const [isChatbotOpen, setIsChatbotOpen] = useState(false);
  const [copilotPrefill, setCopilotPrefill] = useState('');
  const [copilotContext, setCopilotContext] = useState<CopilotContext | undefined>(undefined);
  const [isNotificationDrawerOpen, setIsNotificationDrawerOpen] = useState(false);
  const [notifItems, setNotifItems] = useState<NotificationItem[]>([]);
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission>('default');

  useEffect(() => notifications.subscribe(setNotifItems), []);
  useEffect(() => setBrowserPermission(notifications.getBrowserPermission()), []);
  useEffect(() => initGlobalFontAutoScaler(), []);

  /** Opens the Copilot drawer — optionally with a question to send and the record the user is looking at. */
  const openCopilotDrawer: OpenCopilot = useCallback((prefill, context) => {
    setCopilotPrefill(prefill || '');
    setCopilotContext(context);
    setIsChatbotOpen(true);
  }, []);
  const openCopilot = aiOn ? openCopilotDrawer : undefined;

  const openLibrary = useCallback((query = '') => {
    setLibraryInitialQuery(query);
    setIsLibraryOpen(true);
  }, []);
  const openAddLead = useCallback(() => setIsAddLeadOpen(true), []);

  /* ------------------------ Leads drill-down filter ---------------------- */

  const [leadFilter, setLeadFilter] = useState<{ label: string; ids: Set<string> } | null>(null);
  const showLeads = useCallback(
    (label: string, ids: string[]) => {
      setLeadFilter({ label, ids: new Set(ids) });
      router.push(viewHref('leads'));
    },
    [router]
  );
  const clearLeadFilter = useCallback(() => setLeadFilter(null), []);
  // The filter belongs to the Leads screen: leaving it (sidebar, back button…) drops it.
  // Only a path change counts — the filter is set one render before the navigation to /leads lands.
  useEffect(() => {
    if (currentView !== 'leads') setLeadFilter(null);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = useCallback((view: ViewId) => router.push(viewHref(view)), [router]);
  /* ---------------------------- Global search ---------------------------- */

  const canManageTeam = engine.can('users.manageAgents');
  const searchData = useMemo(
    () => ({
      templates: data.templates, tasks: data.tasks, notes: data.notes, checklist: data.checklist, inventory: data.inventory,
      documents: data.documents, segments: data.segments, users: canManageTeam ? data.users : undefined,
    }),
    [data.templates, data.tasks, data.notes, data.checklist, data.inventory, data.documents, data.segments, data.users, canManageTeam]
  );
  /** Open a screen with its own search box pre-filled (`?q=`). */
  const goSearch = useCallback((view: ViewId, q: string) => router.push(q ? `${viewHref(view)}?q=${encodeURIComponent(q)}` : viewHref(view)), [router]);
  const onSearchSelect = useCallback(
    (hit: SearchHit, query: string) => {
      if (hit.kind === 'template') goSearch('templates', hit.title);
      else if (hit.kind === 'unit') goSearch('inventory', hit.id);
      else if (hit.kind === 'document') goSearch('documents', hit.title);
      else if (hit.kind === 'segment') goTo('segments');
      else if (hit.kind === 'user') router.push('/settings?section=users');
      else if (hit.kind === 'task' || hit.kind === 'note' || hit.kind === 'checklist') goTo('tasks');
      else goSearch('leads', query);
    },
    [goSearch, goTo, router]
  );
  const onSearchShowAll = useCallback(
    (g: SearchGroup, query: string) => {
      if (g.kind === 'lead') showLeads(`Search: “${query}”`, searchLeads(data.leads, query, data.leads.length).map((l) => l[F.ID]));
      else if (g.kind === 'template') goSearch('templates', query);
      else if (g.kind === 'unit') goSearch('inventory', query);
      else if (g.kind === 'document') goSearch('documents', query);
      else if (g.kind === 'user') router.push('/settings?section=users');
      else goTo(g.view as ViewId);
    },
    [data.leads, goSearch, goTo, router, showLeads]
  );

  const openRecord = (recordType?: string, recordId?: string) => {
    if (!recordId) return;
    if (recordType === 'Lead') openLead(recordId);
    else if (recordType === 'Task') goTo('tasks');
    else if (recordType === 'Chat') goTo('chat360');
    else if (recordType === 'Inventory') goTo('inventory');
    else if (recordType === 'Developer') goTo('settings');
    setIsNotificationDrawerOpen(false);
  };

  const ctx = useMemo<CrmContextValue>(
    () => ({ engine, openLead, openAddLead, openLibrary, openCopilot, showLeads, leadFilter, clearLeadFilter, on, aiConfigured, rmOptions }),
    [engine, openLead, openAddLead, openLibrary, openCopilot, showLeads, leadFilter, clearLeadFilter, on, aiConfigured, rmOptions]
  );

  const unreadCount = notifItems.filter((n) => !n.read).length;
  const refreshNow = () => engine.refresh({ silent: false, force: true });

  return (
    <CrmContext.Provider value={ctx}>
      <TenantProvider settings={serverSettings}>
        <div className="flex h-screen bg-[#F4F0EB] text-[#3D3530] overflow-hidden">
          <Sidebar
            currentView={currentView}
            onNavigate={() => setIsMobileSidebarOpen(false)}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            isMobileOpen={isMobileSidebarOpen}
            onCloseMobile={() => setIsMobileSidebarOpen(false)}
            sync={sync}
            isOnline={engine.isOnline}
            currentUser={currentUser}
            can={engine.can}
            features={features}
            onLogout={handleLogout}
            unreadChats={0}
          />

          <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
            <Topbar
              currentView={currentView}
              leads={data.leads}
              onOpenLead={openLead}
              onOpenAddLead={openAddLead}
              onOpenLibrary={() => openLibrary('')}
              onOpenChatbot={(prefill) => openCopilotDrawer(prefill)}
              onOpenCsvModal={() => setIsCsvModalOpen(true)}
              onSyncNow={refreshNow}
              sync={sync}
              unreadCount={unreadCount}
              onToggleNotificationDrawer={() => setIsNotificationDrawerOpen(!isNotificationDrawerOpen)}
              onToggleSidebarMobile={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
              currentUser={currentUser}
              can={engine.can}
              aiEnabled={aiOn}
              searchData={searchData}
              onSearchSelect={onSearchSelect}
              onSearchShowAll={onSearchShowAll}
            />

            <main className="flex-1 overflow-y-auto">
              <ErrorBoundary scope={`view:${currentView || pathname}`} inline resetKey={pathname}>
                {mounted ? children : <PageSkeleton variant={currentView ? VIEW_SKELETON[currentView] : undefined} />}
              </ErrorBoundary>
            </main>
          </div>

          {mounted && (
            <>
              <LeadDetailModal
                lead={selectedLead}
                config={data.config}
                settings={data.settings}
                currentUser={currentUser}
                isOpen={Boolean(selectedLeadId)}
                onClose={closeLead}
                onSaveLead={engine.updateLead}
                onAppendRemark={engine.appendRemark}
                onTrashLead={engine.trashLead}
                onAddTask={engine.addTask}
                canTrash={engine.can('leads.trash')}
                canEdit={engine.can('leads.edit')}
                aiConfigured={aiConfigured}
                chatEnabled={!!serverSettings?.chat360Configured}
                callsFeature={on('calls')}
                whatsappFeature={on('chat360')}
                tasks={data.tasks}
                inventory={data.inventory}
                onOpenCopilot={openCopilot}
              />

              <AddLeadModal isOpen={isAddLeadOpen} onClose={() => setIsAddLeadOpen(false)} config={data.config} leads={data.leads} currentUser={currentUser} onAddLead={engine.addLead} aiConfigured={aiConfigured} />

              <Suspense fallback={null}>
                {libraryOn && isLibraryOpen && (
                  <LibraryModal
                    isOpen={isLibraryOpen}
                    onClose={() => {
                      setIsLibraryOpen(false);
                      setLibraryInitialQuery('');
                    }}
                    initialQuery={libraryInitialQuery}
                  />
                )}
                {isCsvModalOpen && <CsvImportExportModal isOpen={isCsvModalOpen} onClose={() => setIsCsvModalOpen(false)} leads={data.leads} onImport={engine.importLeads} canImport={engine.can('leads.import')} />}
                {aiOn && isChatbotOpen && (
                  <CopilotDrawer
                    isOpen={isChatbotOpen}
                    onClose={() => setIsChatbotOpen(false)}
                    leads={data.leads}
                    tasks={data.tasks}
                    inventory={data.inventory}
                    currentUser={currentUser}
                    aiConfigured={aiConfigured}
                    aiModel={data.settings.geminiModel}
                    projectLibrary={libraryOn}
                    companyName={companyName}
                    prefill={copilotPrefill}
                    context={copilotContext}
                    canAct={engine.can('ai.actions')}
                    actions={{ addTask: engine.addTask, setLeadStage: engine.setLeadStage, appendRemark: engine.appendRemark, updateLead: engine.updateLead }}
                    onOpenLead={openLead}
                    onShowLeads={(label, ids) => {
                      showLeads(label, ids);
                      setIsChatbotOpen(false);
                    }}
                  />
                )}
              </Suspense>

              <AlarmModal task={engine.activeAlarmTask} onSnooze={engine.snoozeAlarm} onComplete={engine.completeAlarm} onDismiss={engine.dismissAlarm} onOpenLead={openLead} />

              <NotificationDrawer
                isOpen={isNotificationDrawerOpen}
                onClose={() => setIsNotificationDrawerOpen(false)}
                notifications={notifItems}
                browserPermission={browserPermission}
                onRequestBrowserPermission={async () => setBrowserPermission(await notifications.requestBrowserPermission())}
                onOpenRecord={openRecord}
              />
            </>
          )}

          <Toasts />
          <div className="hidden"><AppLogo size="xs" /></div>
        </div>
      </TenantProvider>
    </CrmContext.Provider>
  );
}
