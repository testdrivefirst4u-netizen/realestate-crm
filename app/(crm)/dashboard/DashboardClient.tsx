'use client';

import { DashboardView } from '@/src/modules/dashboard/DashboardView';
import { useCrm } from '../_components/CrmShell';

export function DashboardClient() {
  const { engine, openLead, showLeads, rmOptions } = useCrm();
  const { data, sync, currentUser } = engine;
  return (
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
    />
  );
}
