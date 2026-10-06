import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { FollowupsClient } from './FollowupsClient';

export const metadata: Metadata = { title: VIEW_TITLES.followups };

export default async function FollowupsPage() {
  await requireView('followups');
  return <FollowupsClient />;
}
