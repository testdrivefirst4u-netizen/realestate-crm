import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { WhatsappCreditsClient } from './WhatsappCreditsClient';

export const metadata: Metadata = { title: VIEW_TITLES.whatsappcredits };

export default async function WhatsappCreditsPage() {
  await requireView('whatsappcredits');
  return <WhatsappCreditsClient />;
}
