import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { ReportsClient } from './ReportsClient';

export const metadata: Metadata = { title: VIEW_TITLES.reports };

export default async function ReportsPage() {
  await requireView('reports');
  return <ReportsClient />;
}
