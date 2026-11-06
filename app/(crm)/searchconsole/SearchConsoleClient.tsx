'use client';

import { SearchConsoleReport } from '@/src/modules/analytics/SearchConsoleReport';
import { useCrm } from '../_components/CrmShell';

export function SearchConsoleClient() {
  const { engine } = useCrm();
  return <SearchConsoleReport canCheck={engine.can('marketing.manage')} />;
}
