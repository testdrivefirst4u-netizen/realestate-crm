'use client';

import { AnalyticsReports } from '@/src/modules/analytics/AnalyticsReports';
import { useCrm } from '../_components/CrmShell';

export function AnalyticsClient() {
  const { engine } = useCrm();
  return <AnalyticsReports canCheckPages={engine.can('marketing.manage')} />;
}
