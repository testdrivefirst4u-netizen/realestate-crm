import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { KanbanClient } from './KanbanClient';

export const metadata: Metadata = { title: VIEW_TITLES.kanban };

export default async function KanbanPage() {
  await requireView('kanban');
  return <KanbanClient />;
}
