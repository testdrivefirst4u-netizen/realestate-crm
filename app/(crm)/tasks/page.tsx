import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { TasksClient } from './TasksClient';

export const metadata: Metadata = { title: VIEW_TITLES.tasks };

export default async function TasksPage() {
  await requireView('tasks');
  return <TasksClient />;
}
