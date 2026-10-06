'use client';

import { DashboardView } from '@/src/modules/dashboard/DashboardView';
import { useCrm } from '../_components/CrmShell';

export function DashboardClient() {
  const { engine, openLead, showLeads, rmOptions } = useCrm();
  const { data, sync } = engine;
  return (
    <DashboardView
      leads={data.leads}
      tasks={data.tasks}
      rmOptions={rmOptions}
      sync={sync}
      greeting={data.customization?.dashboardGreeting}
      onRefresh={() => engine.refresh({ silent: false, force: true })}
      onFilterClick={showLeads}
      onOpenLead={openLead}
    />
  );
}
