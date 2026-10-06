import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { SegmentsClient } from './SegmentsClient';

export const metadata: Metadata = { title: VIEW_TITLES.segments };

export default async function SegmentsPage() {
  await requireView('segments');
  return <SegmentsClient />;
}
