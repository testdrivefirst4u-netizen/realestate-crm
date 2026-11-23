'use client';

import { useState } from 'react';
import { Share2 } from 'lucide-react';
import { DashboardView } from '@/src/modules/dashboard/DashboardView';
import { ShareDashboardModal } from '@/src/modules/dashboard/ShareDashboardModal';
import { Button } from '@/src/components/ui';
import { useCrm } from '../_components/CrmShell';

export function DashboardClient() {
  const { engine, openLead, showLeads, rmOptions } = useCrm();
  const { data, sync, currentUser } = engine;
  const canShare = engine.can('integrations.connect');
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <>
      <DashboardView
        leads={data.leads}
        tasks={data.tasks}
        rmOptions={rmOptions}
        sync={sync}
        greeting={data.customization?.dashboardGreeting}
        userName={currentUser?.name}
        onRefresh={() => engine.refresh({ silent: false, force: true })}
        onFilterClick={showLeads}
        onOpenLead={openLead}
        headerExtra={canShare ? <Button variant="secondary" size="sm" icon={<Share2 size={13} />} onClick={() => setShareOpen(true)}>Share link</Button> : undefined}
      />
      {shareOpen && <ShareDashboardModal onClose={() => setShareOpen(false)} />}
    </>
  );
}
