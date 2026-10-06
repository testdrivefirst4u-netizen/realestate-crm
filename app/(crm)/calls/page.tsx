import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { CallsClient } from './CallsClient';

export const metadata: Metadata = { title: VIEW_TITLES.calls };

export default async function CallsPage() {
  await requireView('calls');
  return <CallsClient />;
}
