import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { SettingsClient } from './SettingsClient';

export const metadata: Metadata = { title: VIEW_TITLES.settings };

export default async function SettingsPage() {
  await requireView('settings');
  return <SettingsClient />;
}
