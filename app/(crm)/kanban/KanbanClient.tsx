'use client';

import { KanbanView } from '@/src/modules/leads/KanbanView';
import { useCrm } from '../_components/CrmShell';

export function KanbanClient() {
  const { engine, openLead, openAddLead } = useCrm();
  const { data } = engine;
  return <KanbanView leads={data.leads} config={data.config} onOpenLead={openLead} onUpdateLeadStage={engine.setLeadStage} onOpenAddLead={openAddLead} />;
}
