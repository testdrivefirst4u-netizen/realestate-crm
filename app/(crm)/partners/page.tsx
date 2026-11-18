import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { PartnersClient } from './PartnersClient';

export const metadata: Metadata = { title: VIEW_TITLES.partners };

export default async function PartnersPage() {
  await requireView('partners');
  return <PartnersClient />;
}
