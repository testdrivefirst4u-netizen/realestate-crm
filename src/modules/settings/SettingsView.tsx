import React, { useEffect, useMemo, useState } from 'react';
import { Building2, FileSpreadsheet, Inbox, Monitor, Plug, RefreshCw, Trash2, UserCircle2, Users } from 'lucide-react';
import { CRMSettings, CrmDocument, InventoryUnit, Lead, MessageTemplate, ServerSettings, SyncState, UserAccount } from '../../types/crm';
import { api } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { Permission } from '../../core/rbac';
import { InlineNotice, Tabs } from '../../components/ui';
import { SyncSection } from './SyncSection';
import { DisplaySection } from './DisplaySection';
import { ProfileSection } from './ProfileSection';
import { UsersSection } from './UsersSection';
import { IntegrationsSection } from './IntegrationsSection';
import { RecycleBinSection } from './RecycleBinSection';
import { CompanySection } from './CompanySection';
import { LeadSourcesSection } from './leadSources/LeadSourcesSection';
import { GoogleSheetsSection } from './sheets/GoogleSheetsSection';
import { ServerSettingsExt } from './types';
import { SettingsLink, initialSettingsSection } from './meta/metaUtils';

export interface SettingsViewProps {
  settings: CRMSettings;
  serverSettings?: ServerSettings;
  sync: SyncState;
  currentUser: UserAccount | null;
  can: (p: Permission) => boolean;
  users: UserAccount[];
  rmOptions: string[];
  trashedLeads: Lead[];
  inventory: InventoryUnit[];
  templates: MessageTemplate[];
  documents: CrmDocument[];
  onUpdateLocalSettings: (patch: Partial<CRMSettings>) => void;
  onApplyServerSettings: (s: ServerSettings) => void;
  onRestoreLead: (id: string) => Promise<boolean>;
  onPermanentlyDeleteLead: (id: string) => Promise<boolean>;
  onSyncNow: () => void;
  onRefreshAll: () => void;
  /** Own name / profile photo (engine.updateProfile) — updates the session so the sidebar refreshes at once. */
  onUpdateProfile?: (data: { name?: string; avatar?: string | null }) => Promise<UserAccount | null>;
  /** Lead Stage dropdown options (data.config.options['Lead Stage']) — default stage of lead sources. */
  stageOptions?: string[];
  /** Open a lead's detail drawer (`?lead=`) — links in the lead-source intake log. */
  onOpenLead?: (id: string) => void;
  /** Deep link from the URL (`?section=`, `?metaConnect=`, `?metaError=`, `?googleConnected=`, `?googleError=` — e.g. the return from a Facebook or Google login), read once on mount. */
  link?: SettingsLink | null;
  /** The Facebook / Google part of `link` has been taken over by Lead sources / Google Sheets. */
  onLinkConsumed?: () => void;
}

const SECTION_IDS = ['sync', 'display', 'profile', 'company', 'users', 'integrations', 'leadSources', 'googleSheets', 'recycle'] as const;
type SectionId = (typeof SECTION_IDS)[number];

export const SettingsView: React.FC<SettingsViewProps> = (props) => {
  const { settings, serverSettings, sync, currentUser, can, users, rmOptions, trashedLeads, onUpdateLocalSettings, onApplyServerSettings, onRestoreLead, onPermanentlyDeleteLead, onSyncNow, onRefreshAll, onUpdateProfile, stageOptions, onOpenLead, link, onLinkConsumed } = props;

  const [settingsError, setSettingsError] = useState<string | null>(null);

  const sections = useMemo(() => {
    const list: Array<{ id: SectionId; label: string; icon: React.ReactNode; show: boolean; badge?: React.ReactNode }> = [
      { id: 'sync', label: 'Sync & preferences', icon: <RefreshCw size={14} />, show: true },
      { id: 'display', label: 'Display & branding', icon: <Monitor size={14} />, show: true },
      { id: 'profile', label: 'My profile', icon: <UserCircle2 size={14} />, show: true },
      { id: 'company', label: 'Company & plan', icon: <Building2 size={14} />, show: can('users.manage') },
      { id: 'users', label: 'Users & roles', icon: <Users size={14} />, show: can('users.manage') },
      { id: 'integrations', label: 'Integrations', icon: <Plug size={14} />, show: can('settings.view') },
      { id: 'leadSources', label: 'Lead sources', icon: <Inbox size={14} />, show: can('settings.view') },
      { id: 'googleSheets', label: 'Google Sheets', icon: <FileSpreadsheet size={14} />, show: can('settings.view') },
      { id: 'recycle', label: 'Recycle bin', icon: <Trash2 size={14} />, show: can('leads.trash') || can('leads.delete'), badge: trashedLeads.length || undefined },
    ];
    return list.filter((s) => s.show);
  }, [can, trashedLeads.length]);

  const [active, setActive] = useState<SectionId>(() => initialSettingsSection<SectionId>(link, SECTION_IDS, 'sync'));
  useEffect(() => {
    if (!sections.some((s) => s.id === active)) setActive(sections[0]?.id || 'sync');
  }, [sections, active]);

  // The bootstrap only carries public settings; load the full (masked) settings once for admins/managers.
  useEffect(() => {
    if (!can('settings.view')) return;
    let cancelled = false;
    (async () => {
      try {
        const full = await api.settings.get();
        if (!cancelled) {
          onApplyServerSettings(full);
          setSettingsError(null);
        }
      } catch (e) {
        if (cancelled) return;
        const err = reportError('settings.get', e);
        setSettingsError(toAppError(err).userMessage);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ext = serverSettings as ServerSettingsExt | undefined;
  const base = { settings, serverSettings: ext, currentUser, can, onApplyServerSettings };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Settings</h2>
        <p className="text-xs text-[#6B5F57] mt-0.5">Sync, integrations, users and this device’s display preferences</p>
      </div>

      {settingsError && (active === 'integrations' || active === 'sync') && (
        <InlineNotice tone="warning">Could not load the full server settings — some values may be stale. {settingsError}</InlineNotice>
      )}

      <div className="flex flex-col lg:flex-row gap-5 items-start">
        <nav className="w-full lg:w-56 flex-shrink-0 lg:sticky lg:top-4">
          <Tabs<SectionId>
            tabs={sections.map((s) => ({ id: s.id, label: s.label, icon: s.icon, badge: s.badge }))}
            value={active}
            onChange={setActive}
            className="w-full lg:flex-col lg:items-stretch"
          />
        </nav>

        <div className="flex-1 min-w-0 w-full">
          {active === 'sync' && <SyncSection {...base} sync={sync} onUpdateLocalSettings={onUpdateLocalSettings} onSyncNow={onSyncNow} />}
          {active === 'display' && <DisplaySection />}
          {active === 'profile' && <ProfileSection currentUser={currentUser} onRefreshAll={onRefreshAll} onUpdateProfile={onUpdateProfile} />}
          {active === 'company' && can('users.manage') && <CompanySection serverSettings={serverSettings} users={users} />}
          {active === 'users' && can('users.manage') && <UsersSection users={users} currentUser={currentUser} onRefreshAll={onRefreshAll} onUpdateProfile={onUpdateProfile} />}
          {active === 'integrations' && can('settings.view') && <IntegrationsSection {...base} rmOptions={rmOptions} onUpdateLocalSettings={onUpdateLocalSettings} />}
          {active === 'leadSources' && can('settings.view') && <LeadSourcesSection can={can} stageOptions={stageOptions || []} rmOptions={rmOptions} onOpenLead={onOpenLead} metaConnect={link?.metaConnect} metaError={link?.metaError} onMetaLinkConsumed={onLinkConsumed} />}
          {active === 'googleSheets' && can('settings.view') && <GoogleSheetsSection can={can} onOpenLeadSources={() => setActive('leadSources')} googleConnected={link?.googleConnected} googleError={link?.googleError} onGoogleLinkConsumed={onLinkConsumed} />}
          {active === 'recycle' && <RecycleBinSection trashedLeads={trashedLeads} can={can} onRestoreLead={onRestoreLead} onPermanentlyDeleteLead={onPermanentlyDeleteLead} />}
        </div>
      </div>
    </div>
  );
};
