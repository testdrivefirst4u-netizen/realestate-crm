'use client';

import { ReportsView } from '@/src/modules/reports/ReportsView';
import { useCrm } from '../_components/CrmShell';

export function ReportsClient() {
  const { engine, openLead } = useCrm();
  const { data } = engine;
  return <ReportsView leads={data.leads} tasks={data.tasks} config={data.config} onOpenLead={openLead} canExport={engine.can('reports.export')} />;
}
