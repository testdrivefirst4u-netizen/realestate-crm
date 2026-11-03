import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { AnalyticsClient } from './AnalyticsClient';

export const metadata: Metadata = { title: VIEW_TITLES.analytics };

export default async function AnalyticsPage() {
  await requireView('analytics');
  return <AnalyticsClient />;
}
