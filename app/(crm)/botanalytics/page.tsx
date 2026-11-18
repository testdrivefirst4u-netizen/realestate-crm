import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { BotAnalyticsClient } from './BotAnalyticsClient';

export const metadata: Metadata = { title: VIEW_TITLES.botanalytics };

export default async function BotAnalyticsPage() {
  await requireView('botanalytics');
  return <BotAnalyticsClient />;
}
