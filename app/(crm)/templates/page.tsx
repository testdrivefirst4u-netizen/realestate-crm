import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { TemplatesClient } from './TemplatesClient';

export const metadata: Metadata = { title: VIEW_TITLES.templates };

export default async function TemplatesPage() {
  await requireView('templates');
  return <TemplatesClient />;
}
