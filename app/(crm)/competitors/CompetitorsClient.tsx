'use client';

import { CompetitorsView } from '@/src/modules/competitors/CompetitorsView';
import { useCrm } from '../_components/CrmShell';

export function CompetitorsClient() {
  const { engine } = useCrm();
  return <CompetitorsView canChange={engine.can('marketing.manage')} />;
}
