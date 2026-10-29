'use client';

import { CallsView } from '@/src/modules/calls/CallsView';
import { useCrm } from '../_components/CrmShell';

export function CallsClient() {
  const { engine, openLead, createLeadForPhone, aiConfigured } = useCrm();
  const { data, currentUser } = engine;
  return (
    <CallsView
      leads={data.leads}
      currentUser={currentUser}
      settings={data.settings}
      aiConfigured={aiConfigured}
      onOpenLead={openLead}
      onCreateLead={engine.can('leads.create') ? createLeadForPhone : undefined}
      onAppendRemark={engine.appendRemark}
      onUpdateLead={engine.updateLead}
    />
  );
}
