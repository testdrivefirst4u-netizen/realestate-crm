import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { BotChatsClient } from './BotChatsClient';

export const metadata: Metadata = { title: VIEW_TITLES.webchat };

export default async function WebchatPage() {
  await requireView('webchat');
  return <BotChatsClient />;
}
