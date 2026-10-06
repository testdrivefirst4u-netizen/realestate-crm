import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar, ViewId } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toasts } from './components/Toasts';
import { LoadingState } from './components/ui';
import { AppLogo } from './components/AppLogo';

import { DashboardView } from './modules/dashboard/DashboardView';
import { LoginScreen } from './modules/auth/LoginScreen';
import { LeadsView } from './modules/leads/LeadsView';
import { LeadDetailModal } from './modules/leads/LeadDetailModal';
import type { CopilotContext, OpenCopilot } from './modules/ai/copilotContext';
import { AddLeadModal } from './modules/leads/AddLeadModal';
import { KanbanView } from './modules/leads/KanbanView';
import { FollowupsView } from './modules/followups/FollowupsView';
import { TasksView } from './modules/tasks/TasksView';
import { AlarmModal } from './modules/tasks/AlarmModal';
import { NotificationDrawer } from './modules/notifications/NotificationDrawer';

import { useCrmEngine } from './core/engine';
import { notifications } from './core/notifications';
import { F, STAGES } from './core/config';
import { TenantProvider, companyOf, documentTitleFor, hasFeature, resolveFeatures } from './core/tenant';
import { initGlobalFontAutoScaler } from './utils/fontSizeAdjuster';
import { Lead, NotificationItem } from './types/crm';
import { EMPTY_SETTINGS_LINK, SettingsLink, hasSettingsLink, parseSettingsLink, stripSettingsLinkParams } from './modules/settings/meta/metaUtils';

// Heavy / secondary modules are code-split so the first paint stays fast.
const ReportsView = lazy(() => import('./modules/reports/ReportsView').then((m) => ({ default: m.ReportsView })));
const InventoryView = lazy(() => import('./modules/inventory/InventoryView').then((m) => ({ default: m.InventoryView })));
const Chat360View = lazy(() => import('./modules/chat360/Chat360View').then((m) => ({ default: m.Chat360View })));
const CallsView = lazy(() => import('./modules/calls/CallsView').then((m) => ({ default: m.CallsView })));
const SettingsView = lazy(() => import('./modules/settings/SettingsView').then((m) => ({ default: m.SettingsView })));
const AuditLogsView = lazy(() => import('./modules/audit/AuditLogsView').then((m) => ({ default: m.AuditLogsView })));
const SegmentsView = lazy(() => import('./modules/segments/SegmentsView').then((m) => ({ default: m.SegmentsView })));
const DocumentsView = lazy(() => import('./modules/documents/DocumentsView').then((m) => ({ default: m.DocumentsView })));
const TemplatesView = lazy(() => import('./modules/templates/TemplatesView').then((m) => ({ default: m.TemplatesView })));
const CopilotDrawer = lazy(() => import('./modules/ai/CopilotDrawer').then((m) => ({ default: m.CopilotDrawer })));
const LibraryModal = lazy(() => import('./components/LibraryModal').then((m) => ({ default: m.LibraryModal })));
const CsvImportExportModal = lazy(() => import('./components/CsvImportExportModal').then((m) => ({ default: m.CsvImportExportModal })));

/* ------------------------------------------------------------------------ */
/* URL routing: /<view>?lead=<Enquiry ID>                                    */
/* ------------------------------------------------------------------------ */

const VIEW_IDS: ViewId[] = ['dashboard', 'leads', 'segments', 'kanban', 'followups', 'tasks', 'inventory', 'chat360', 'calls', 'documents', 'templates', 'reports', 'audit', 'settings'];
const DEFAULT_VIEW: ViewId = 'dashboard';

interface Route {
  view: ViewId;
  /** Lead whose detail drawer is open (`?lead=ENQ-0001`). */
  lead: string | null;
}

/** `/leads` → leads; `/`, unknown or nested paths → the dashboard. */
function viewFromPath(pathname: string): ViewId | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  const v = decodeURIComponent(parts[0]).toLowerCase() as ViewId;
  return VIEW_IDS.includes(v) ? v : null;
}

function readRoute(): Route {
  const { pathname, search } = window.location;
  return { view: viewFromPath(pathname) || DEFAULT_VIEW, lead: new URLSearchParams(search).get('lead') || null };
}

function routeUrl(route: Route): string {
  const q = new URLSearchParams(window.location.search);
  if (route.lead) q.set('lead', route.lead);
  else q.delete('lead');
  const qs = q.toString();
  return `/${route.view}${qs ? `?${qs}` : ''}${window.location.hash}`;
}

export default function App() {
  const engine = useCrmEngine();
  const { data, currentUser, sync, authStatus } = engine;

  // The URL is the source of truth for the view and the open lead; history entries make back/forward work.
  const [route, setRoute] = useState<Route>(() => readRoute());
  const routeRef = useRef(route);
  routeRef.current = route;
  const currentView = route.view;
  const selectedLeadId = route.lead;
  /** `/settings?section=…&metaConnect=…|metaError=…|googleConnected=…|googleError=…` (deep links, the return from a Facebook or Google login): read once, then removed from the URL. */
  const [settingsLink, setSettingsLink] = useState<SettingsLink>(() => (route.view === 'settings' ? parseSettingsLink(window.location.search) : EMPTY_SETTINGS_LINK));

  /** Render `next` and record it in the browser history (`leadOverlay` marks an entry that only opened a lead). */
  const navigate = useCallback((next: Partial<Route>, opts: { replace?: boolean; leadOverlay?: boolean } = {}) => {
    const r: Route = { ...routeRef.current, ...next };
    const url = routeUrl(r);
    const state = { crmLeadOverlay: !!opts.leadOverlay };
    if (opts.replace) window.history.replaceState(state, '', url);
    else if (url !== window.location.pathname + window.location.search + window.location.hash) window.history.pushState(state, '', url);
    routeRef.current = r;
    setRoute(r);
  }, []);
  const setCurrentView = useCallback((view: ViewId) => navigate({ view, lead: null }), [navigate]);
  /** Open a lead's detail drawer (`?lead=…`). Switching from one open lead to another replaces the entry. */
  const setSelectedLeadId = useCallback(
    (id: string | null) => {
      if (id) {
        const switching = !!routeRef.current.lead;
        navigate({ lead: id }, switching ? { replace: true, leadOverlay: !!window.history.state?.crmLeadOverlay } : { leadOverlay: true });
      } else if (window.history.state?.crmLeadOverlay) {
        window.history.back(); // closing = undoing the entry that opened it, so Back does not reopen the drawer
      } else {
        navigate({ lead: null }, { replace: true });
      }
    },
    [navigate]
  );

  useEffect(() => {
    // One-shot settings parameters must not stay in the URL (reload / sharing would replay them).
    const stripped = stripSettingsLinkParams(window.location.search);
    if (stripped !== window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname + stripped + window.location.hash);
    // `/`, unknown or nested paths → canonical `/dashboard` (keeps any ?lead=…).
    if (viewFromPath(window.location.pathname) !== routeRef.current.view) window.history.replaceState(window.history.state, '', routeUrl(routeRef.current));
    const onPop = () => {
      const r = readRoute();
      routeRef.current = r;
      setRoute(r);
      if (viewFromPath(window.location.pathname) !== r.view) window.history.replaceState(window.history.state, '', routeUrl(r));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Leaving Settings drops an unused deep link (it only applies to the first visit).
  useEffect(() => {
    if (currentView !== 'settings' && hasSettingsLink(settingsLink)) setSettingsLink(EMPTY_SETTINGS_LINK);
  }, [currentView, settingsLink]);

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const [isAddLeadOpen, setIsAddLeadOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [libraryInitialQuery, setLibraryInitialQuery] = useState('');
  const [isCsvModalOpen, setIsCsvModalOpen] = useState(false);
  const [isChatbotOpen, setIsChatbotOpen] = useState(false);
  const [copilotPrefill, setCopilotPrefill] = useState('');
  const [copilotContext, setCopilotContext] = useState<CopilotContext | undefined>(undefined);
  /** Opens the Copilot drawer — optionally with a question to send and the record the user is looking at. */
  const openCopilot: OpenCopilot = (prefill, context) => {
    setCopilotPrefill(prefill || '');
    setCopilotContext(context);
    setIsChatbotOpen(true);
  };
  const [isNotificationDrawerOpen, setIsNotificationDrawerOpen] = useState(false);

  const [notifItems, setNotifItems] = useState<NotificationItem[]>([]);
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission>(notifications.getBrowserPermission());

  // Dashboard → Leads drill-down
  const [leadFilter, setLeadFilter] = useState<{ label: string; ids: Set<string> } | null>(null);

  useEffect(() => notifications.subscribe(setNotifItems), []);
  useEffect(() => initGlobalFontAutoScaler(), []);

  const handleOpenLead = useCallback((id: string) => setSelectedLeadId(id), [setSelectedLeadId]);
  const handleOpenLibrary = (query = '') => {
    setLibraryInitialQuery(query);
    setIsLibraryOpen(true);
  };

  const handleDashboardFilter = (label: string, ids: string[]) => {
    setLeadFilter({ label, ids: new Set(ids) });
    setCurrentView('leads');
  };

  const openRecord = (recordType?: string, recordId?: string) => {
    if (!recordId) return;
    if (recordType === 'Lead') {
      setSelectedLeadId(recordId);
    } else if (recordType === 'Task') {
      setCurrentView('tasks');
    } else if (recordType === 'Chat') {
      setCurrentView('chat360');
    } else if (recordType === 'Inventory') {
      setCurrentView('inventory');
    } else if (recordType === 'Developer') {
      setCurrentView('settings');
    }
    setIsNotificationDrawerOpen(false);
  };

  const selectedLead = useMemo(() => data.leads.find((l) => l[F.ID] === selectedLeadId) || null, [data.leads, selectedLeadId]);
  const displayLeads = useMemo(() => (leadFilter ? data.leads.filter((l) => leadFilter.ids.has(l[F.ID])) : data.leads), [data.leads, leadFilter]);
  const rmOptions = useMemo(() => data.config.options[F.RM] || [], [data.config]);
  const trashedLeads = useMemo(() => data.leads.filter((l) => l[F.STAGE] === STAGES.TRASH), [data.leads]);
  const unreadCount = notifItems.filter((n) => !n.read).length;
  // Plan features of the signed-in user's company (defaults until the settings are loaded) — see core/tenant.tsx.
  const serverSettings = data.serverSettings;
  const features = useMemo(() => resolveFeatures(serverSettings), [serverSettings]);
  const on = (name: Parameters<typeof hasFeature>[1]) => hasFeature(serverSettings, name);
  const company = companyOf(serverSettings);
  const aiOn = on('aiCopilot');
  /** AI buttons (reframe, summary, suggestions…) need both a configured key and the plan's AI feature. */
  const aiConfigured = !!data.settings.aiConfigured && aiOn;
  const libraryOn = on('projectLibrary');
  const copilot: OpenCopilot | undefined = aiOn ? openCopilot : undefined;

  // Browser tab: "<Company> · CRM" (just "CRM" before sign-in).
  const companyName = company?.name || '';
  useEffect(() => {
    document.title = documentTitleFor(authStatus === 'ready' && companyName ? { name: companyName } : null);
  }, [authStatus, companyName]);

  // The drill-down filter belongs to the Leads view; leaving it (sidebar, back button…) drops it.
  useEffect(() => {
    if (currentView !== 'leads') setLeadFilter(null);
  }, [currentView]);

  // A typed or bookmarked URL must not open a view the sidebar would hide (same rules as Sidebar).
  const viewAllowed = (v: ViewId) => {
    switch (v) {
      case 'chat360': return on('chat360') && engine.can('chat.view');
      case 'calls': return on('calls') && engine.can('calls.view');
      case 'inventory': return on('inventory') && engine.can('inventory.view');
      case 'segments': return on('segments');
      case 'documents': return on('documents');
      case 'templates': return on('templates');
      case 'reports': return on('reports') && engine.can('reports.view');
      case 'audit': return engine.can('audit.view');
      default: return true;
    }
  };
  const currentViewAllowed = authStatus !== 'ready' || viewAllowed(currentView);
  useEffect(() => {
    if (!currentViewAllowed) navigate({ view: DEFAULT_VIEW }, { replace: true });
  }, [currentViewAllowed, navigate]);

  // `?lead=` pointing at a lead that does not exist (deleted, mistyped) → drop it once the data is in.
  const leadMissing = authStatus === 'ready' && sync.hasLoadedOnce && !!selectedLeadId && !selectedLead;
  useEffect(() => {
    if (leadMissing) navigate({ lead: null }, { replace: true });
  }, [leadMissing, navigate]);

  /* ------------------------------- auth gate ------------------------------ */
  if (authStatus !== 'ready') {
    return (
      <ErrorBoundary scope="login">
        <LoginScreen
          status={authStatus}
          lastError={sync.lastError}
          onLogin={engine.login}
        />
        <Toasts />
      </ErrorBoundary>
    );
  }

  return (
    <TenantProvider settings={serverSettings}>
    <div className="flex h-screen bg-[#F4F0EB] text-[#3D3530] overflow-hidden">
      <Sidebar
        currentView={currentView}
        onSelectView={(v) => {
          setCurrentView(v);
          setIsMobileSidebarOpen(false);
        }}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        isMobileOpen={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
        sync={sync}
        isOnline={engine.isOnline}
        currentUser={currentUser}
        can={engine.can}
        features={features}
        onLogout={engine.logout}
        unreadChats={0}
      />

      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        <Topbar
          currentView={currentView}
          leads={data.leads}
          onOpenLead={handleOpenLead}
          onOpenAddLead={() => setIsAddLeadOpen(true)}
          onOpenLibrary={() => handleOpenLibrary('')}
          onOpenChatbot={(prefill) => openCopilot(prefill)}
          onOpenCsvModal={() => setIsCsvModalOpen(true)}
          onSyncNow={() => engine.refresh({ silent: false, force: true })}
          sync={sync}
          unreadCount={unreadCount}
          onToggleNotificationDrawer={() => setIsNotificationDrawerOpen(!isNotificationDrawerOpen)}
          onToggleSidebarMobile={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
          currentUser={currentUser}
          can={engine.can}
          aiEnabled={aiOn}
        />

        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary scope={`view:${currentView}`} inline resetKey={currentView}>
            <Suspense fallback={<LoadingState label="Loading module…" />}>
              {currentView === 'dashboard' && (
                <DashboardView
                  leads={data.leads}
                  tasks={data.tasks}
                  rmOptions={rmOptions}
                  sync={sync}
                  greeting={data.customization?.dashboardGreeting}
                  onRefresh={() => engine.refresh({ silent: false, force: true })}
                  onFilterClick={handleDashboardFilter}
                  onOpenLead={handleOpenLead}
                />
              )}

              {currentView === 'leads' && (
                <LeadsView
                  leads={displayLeads}
                  config={data.config}
                  onOpenLead={handleOpenLead}
                  activeFilterLabel={leadFilter?.label || null}
                  onClearActiveFilter={() => setLeadFilter(null)}
                  canExport={engine.can('leads.export')}
                  onOpenAddLead={() => setIsAddLeadOpen(true)}
                  sync={sync}
                />
              )}

              {currentView === 'segments' && (
                <SegmentsView
                  segments={data.segments || []}
                  leads={data.leads}
                  config={data.config}
                  onOpenLead={handleOpenLead}
                  onCreateSegment={engine.createSegment}
                  onUpdateSegment={engine.updateSegment}
                  onDeleteSegment={engine.deleteSegment}
                />
              )}

              {currentView === 'kanban' && (
                <KanbanView leads={data.leads} config={data.config} onOpenLead={handleOpenLead} onUpdateLeadStage={engine.setLeadStage} onOpenAddLead={() => setIsAddLeadOpen(true)} />
              )}

              {currentView === 'followups' && (
                <FollowupsView leads={data.leads} config={data.config} settings={data.settings} currentUser={currentUser} onOpenLead={handleOpenLead} onUpdateLeadStage={engine.setLeadStage} onAppendRemark={engine.appendRemark} />
              )}

              {currentView === 'tasks' && (
                <TasksView
                  tasks={data.tasks}
                  notes={data.notes}
                  checklist={data.checklist}
                  leads={data.leads}
                  users={data.users || []}
                  onAddTask={engine.addTask}
                  onUpdateTask={engine.updateTask}
                  onToggleTask={engine.toggleTask}
                  onDeleteTask={engine.deleteTask}
                  onToggleTaskChecklist={engine.toggleTaskChecklist}
                  onAddNote={engine.addNote}
                  onDeleteNote={engine.deleteNote}
                  onAddChecklist={engine.addChecklist}
                  onToggleChecklist={engine.toggleChecklist}
                  onDeleteChecklist={engine.deleteChecklist}
                  onOpenLead={handleOpenLead}
                />
              )}

              {currentView === 'inventory' && (
                <InventoryView
                  inventory={data.inventory}
                  leads={data.leads}
                  sync={sync}
                  canEdit={engine.can('inventory.edit')}
                  onUpdateUnit={engine.updateUnit}
                  onAddUnit={engine.addUnit}
                  onImportInventory={engine.importInventory}
                  onRefresh={() => engine.refresh({ silent: true, force: true })}
                  onOpenLead={handleOpenLead}
                />
              )}

              {currentView === 'chat360' && (
                <Chat360View
                  leads={data.leads}
                  currentUser={currentUser}
                  configured={!!data.serverSettings?.chat360Configured}
                  canSend={engine.can('chat.send')}
                  onOpenLead={handleOpenLead}
                  onAddTask={engine.addTask}
                  onAppendRemark={engine.appendRemark}
                  onUpdateLead={engine.updateLead}
                  onGoToSettings={() => setCurrentView('settings')}
                  onAddLead={engine.addLead}
                  templates={data.templates}
                  aiEnabled={aiConfigured && engine.can('ai.use')}
                  onOpenCopilot={copilot}
                />
              )}

              {currentView === 'calls' && (
                <CallsView leads={data.leads} currentUser={currentUser} settings={data.settings} aiConfigured={aiConfigured} onOpenLead={handleOpenLead} onAppendRemark={engine.appendRemark} onUpdateLead={engine.updateLead} />
              )}

              {currentView === 'documents' && (
                <DocumentsView documents={data.documents} leads={data.leads} onAddDocument={engine.saveDocument} onDeleteDocument={engine.deleteDocument} onOpenLibrary={libraryOn ? handleOpenLibrary : undefined} onOpenLead={handleOpenLead} />
              )}

              {currentView === 'templates' && (
                <TemplatesView templates={data.templates} onAddTemplate={engine.saveTemplate} onUpdateTemplate={(id, patch) => engine.saveTemplate({ id, ...patch })} onDeleteTemplate={engine.deleteTemplate} currentUser={currentUser} />
              )}

              {currentView === 'reports' && (
                <ReportsView leads={data.leads} tasks={data.tasks} config={data.config} onOpenLead={handleOpenLead} canExport={engine.can('reports.export')} />
              )}

              {currentView === 'audit' && <AuditLogsView />}

              {currentView === 'settings' && (
                <SettingsView
                  settings={data.settings}
                  serverSettings={data.serverSettings}
                  sync={sync}
                  currentUser={currentUser}
                  can={engine.can}
                  users={data.users || []}
                  rmOptions={rmOptions}
                  trashedLeads={trashedLeads}
                  inventory={data.inventory}
                  templates={data.templates}
                  documents={data.documents}
                  onUpdateLocalSettings={engine.updateLocalSettings}
                  onApplyServerSettings={engine.applyServerSettings}
                  onRestoreLead={engine.restoreLead}
                  onPermanentlyDeleteLead={engine.deleteLeadPermanently}
                  onSyncNow={() => engine.refresh({ silent: false, force: true })}
                  onUpdateProfile={engine.updateProfile}
                  onRefreshAll={() => engine.refresh({ silent: true, force: true })}
                  stageOptions={data.config.options[F.STAGE] || []}
                  onOpenLead={handleOpenLead}
                  link={settingsLink}
                  onLinkConsumed={() => setSettingsLink(EMPTY_SETTINGS_LINK)}
                />
              )}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      {/* Lead detail drawer */}
      <LeadDetailModal
        lead={selectedLead}
        config={data.config}
        settings={data.settings}
        currentUser={currentUser}
        isOpen={Boolean(selectedLeadId)}
        onClose={() => setSelectedLeadId(null)}
        onSaveLead={engine.updateLead}
        onAppendRemark={engine.appendRemark}
        onTrashLead={engine.trashLead}
        onAddTask={engine.addTask}
        canTrash={engine.can('leads.trash')}
        canEdit={engine.can('leads.edit')}
        aiConfigured={aiConfigured}
        chatEnabled={!!data.serverSettings?.chat360Configured}
        callsFeature={on('calls')}
        whatsappFeature={on('chat360')}
        tasks={data.tasks}
        inventory={data.inventory}
        onOpenCopilot={copilot}
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
            onOpenLead={handleOpenLead}
            onShowLeads={(label, ids) => {
              handleDashboardFilter(label, ids);
              setIsChatbotOpen(false);
            }}
          />
        )}
      </Suspense>

      <AlarmModal task={engine.activeAlarmTask} onSnooze={engine.snoozeAlarm} onComplete={engine.completeAlarm} onDismiss={engine.dismissAlarm} onOpenLead={handleOpenLead} />

      <NotificationDrawer
        isOpen={isNotificationDrawerOpen}
        onClose={() => setIsNotificationDrawerOpen(false)}
        notifications={notifItems}
        browserPermission={browserPermission}
        onRequestBrowserPermission={async () => setBrowserPermission(await notifications.requestBrowserPermission())}
        onOpenRecord={openRecord}
      />

      <Toasts />
      <div className="hidden"><AppLogo size="xs" /></div>
    </div>
    </TenantProvider>
  );
}

export type { Lead };
