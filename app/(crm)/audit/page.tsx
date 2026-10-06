import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { AuditClient } from './AuditClient';

export const metadata: Metadata = { title: VIEW_TITLES.audit };

export default async function AuditPage() {
  await requireView('audit');
  return <AuditClient />;
}
