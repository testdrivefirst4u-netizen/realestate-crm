import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { LeadsClient } from './LeadsClient';

export const metadata: Metadata = { title: VIEW_TITLES.leads };

export default async function LeadsPage() {
  await requireView('leads');
  return <LeadsClient />;
}
