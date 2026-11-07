import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { ChatbotsClient } from './ChatbotsClient';

export const metadata: Metadata = { title: VIEW_TITLES.chatbots };

export default async function ChatbotsPage() {
  await requireView('chatbots');
  return <ChatbotsClient />;
}
