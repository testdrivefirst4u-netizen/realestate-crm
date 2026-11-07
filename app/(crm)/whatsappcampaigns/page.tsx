import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { WhatsappCampaignsClient } from './WhatsappCampaignsClient';

export const metadata: Metadata = { title: VIEW_TITLES.whatsappcampaigns };

export default async function WhatsappCampaignsPage() {
  await requireView('whatsappcampaigns');
  return <WhatsappCampaignsClient />;
}
