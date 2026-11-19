'use client';

import { ClientReportView } from '@/src/modules/report/ClientReportView';
import { useCrm } from '../_components/CrmShell';

export function ClientReportClient() {
  const { engine } = useCrm();
  return <ClientReportView leads={engine.data.leads} />;
}
