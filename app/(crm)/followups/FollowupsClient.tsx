'use client';

import { FollowupsView } from '@/src/modules/followups/FollowupsView';
import { useCrm } from '../_components/CrmShell';

export function FollowupsClient() {
  const { engine, openLead } = useCrm();
  const { data, currentUser } = engine;
  return (
    <FollowupsView leads={data.leads} config={data.config} settings={data.settings} currentUser={currentUser} onOpenLead={openLead} onUpdateLeadStage={engine.setLeadStage} onAppendRemark={engine.appendRemark} />
  );
}
