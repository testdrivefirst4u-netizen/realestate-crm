import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { PerformanceClient } from './PerformanceClient';

export const metadata: Metadata = { title: VIEW_TITLES.performance };

export default async function PerformancePage() {
  await requireView('performance');
  return <PerformanceClient />;
}
