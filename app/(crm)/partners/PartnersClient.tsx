'use client';

import { PartnersView } from '@/src/modules/partners/PartnersView';
import { useCrm } from '../_components/CrmShell';

export function PartnersClient() {
  const { engine } = useCrm();
  return <PartnersView canManage={engine.can('partners.manage')} canSeeMoney={engine.can('partners.commission')} />;
}
