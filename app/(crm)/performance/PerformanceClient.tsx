'use client';

import { PerformanceView } from '@/src/modules/mis/PerformanceView';
import { useCrm } from '../_components/CrmShell';

export function PerformanceClient() {
  const { engine, showLeads } = useCrm();
  return <PerformanceView leads={engine.data.leads} sync={engine.sync} onRefresh={() => engine.refresh({ silent: false, force: true })} onShowLeads={showLeads} />;
}
