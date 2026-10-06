'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SettingsView } from '@/src/modules/settings/SettingsView';
import { EMPTY_SETTINGS_LINK, SettingsLink, parseSettingsLink, stripSettingsLinkParams } from '@/src/modules/settings/meta/metaUtils';
import { F, STAGES } from '@/src/core/config';
import { useCrm } from '../_components/CrmShell';

export function SettingsClient() {
  const { engine, openLead, rmOptions } = useCrm();
  const { data, sync, currentUser } = engine;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** `?section=…&metaConnect=…|metaError=…|googleConnected=…|googleError=…` (deep links, the return from a Facebook or Google login): read once, then removed from the URL. */
  const [link, setLink] = useState<SettingsLink>(() => parseSettingsLink(searchParams.toString()));
  useEffect(() => {
    // One-shot parameters must not stay in the URL (reload / sharing would replay them).
    const search = searchParams.toString();
    const stripped = stripSettingsLinkParams(search).replace(/^\?/, '');
    if (stripped !== search) router.replace(`${pathname}${stripped ? `?${stripped}` : ''}`, { scroll: false });
  }, [searchParams, pathname, router]);

  const trashedLeads = useMemo(() => data.leads.filter((l) => l[F.STAGE] === STAGES.TRASH), [data.leads]);

  return (
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
      onOpenLead={openLead}
      link={link}
      onLinkConsumed={() => setLink(EMPTY_SETTINGS_LINK)}
    />
  );
}
