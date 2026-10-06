import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { DocumentsClient } from './DocumentsClient';

export const metadata: Metadata = { title: VIEW_TITLES.documents };

export default async function DocumentsPage() {
  await requireView('documents');
  return <DocumentsClient />;
}
