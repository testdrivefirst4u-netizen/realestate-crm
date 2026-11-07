'use client';

import { F } from '@/src/core/config';
import { CampaignsView } from '@/src/modules/campaigns/CampaignsView';
import { useCrm } from '../_components/CrmShell';

export function WhatsappCampaignsClient() {
  const { engine } = useCrm();
  const { data } = engine;
  const options = data.config.options;
  return <CampaignsView leads={data.leads} segments={data.segments || []} stages={(options[F.STAGE] || []).filter((s) => s !== 'Trash')} sources={options[F.SOURCE] || []} rms={options[F.RM] || []} />;
}
