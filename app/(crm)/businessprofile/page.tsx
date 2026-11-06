import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { BusinessProfileClient } from './BusinessProfileClient';

export const metadata: Metadata = { title: VIEW_TITLES.businessprofile };

export default async function BusinessProfilePage() {
  await requireView('businessprofile');
  return <BusinessProfileClient />;
}
