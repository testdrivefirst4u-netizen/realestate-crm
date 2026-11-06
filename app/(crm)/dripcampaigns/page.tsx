import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { DripCampaignsClient } from './DripCampaignsClient';

export const metadata: Metadata = { title: VIEW_TITLES.dripcampaigns };

export default async function DripCampaignsPage() {
  await requireView('dripcampaigns');
  return <DripCampaignsClient />;
}
