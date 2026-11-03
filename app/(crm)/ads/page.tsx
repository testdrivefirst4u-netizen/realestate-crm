import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { AdsClient } from './AdsClient';

export const metadata: Metadata = { title: VIEW_TITLES.ads };

export default async function AdsPage() {
  await requireView('ads');
  return <AdsClient />;
}
