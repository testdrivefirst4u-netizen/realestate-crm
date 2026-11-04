import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { CompetitorsClient } from './CompetitorsClient';

export const metadata: Metadata = { title: VIEW_TITLES.competitors };

export default async function CompetitorsPage() {
  await requireView('competitors');
  return <CompetitorsClient />;
}
