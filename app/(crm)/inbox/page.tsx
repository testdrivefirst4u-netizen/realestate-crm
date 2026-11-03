import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { InboxClient } from './InboxClient';

export const metadata: Metadata = { title: VIEW_TITLES.inbox };

export default async function InboxPage() {
  await requireView('inbox');
  return <InboxClient />;
}
