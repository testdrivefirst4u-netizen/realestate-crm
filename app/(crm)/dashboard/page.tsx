import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { DashboardClient } from './DashboardClient';

export const metadata: Metadata = { title: VIEW_TITLES.dashboard };

export default async function DashboardPage() {
  await requireView('dashboard');
  return <DashboardClient />;
}
