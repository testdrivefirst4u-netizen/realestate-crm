import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { MisClient } from './MisClient';

export const metadata: Metadata = { title: VIEW_TITLES.mis };

export default async function MisPage() {
  await requireView('mis');
  return <MisClient />;
}
