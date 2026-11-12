import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { TodayClient } from './TodayClient';

export const metadata: Metadata = { title: VIEW_TITLES.today };

export default async function TodayPage() {
  await requireView('today');
  return <TodayClient />;
}
