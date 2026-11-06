'use client';

import { BusinessProfileView } from '@/src/modules/businessProfile/BusinessProfileView';
import { useCrm } from '../_components/CrmShell';

export function BusinessProfileClient() {
  const { engine } = useCrm();
  return <BusinessProfileView canManage={engine.can('integrations.connect')} />;
}
