'use client';

import { TodayView } from '@/src/modules/today/TodayView';
import { isViewOnly } from '@/src/core/rbac';
import { useCrm } from '../_components/CrmShell';

export function TodayClient() {
  const { engine, openLead } = useCrm();
  return (
    <TodayView currentUser={engine.currentUser} can={engine.can} viewOnly={isViewOnly(engine.currentUser)} users={engine.data.users || []} onOpenLead={openLead} />
  );
}
