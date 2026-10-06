import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { Chat360Client } from './Chat360Client';

export const metadata: Metadata = { title: VIEW_TITLES.chat360 };

export default async function Chat360Page() {
  await requireView('chat360');
  return <Chat360Client />;
}
