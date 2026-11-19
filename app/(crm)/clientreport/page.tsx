import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { ClientReportClient } from './ClientReportClient';

export const metadata: Metadata = { title: VIEW_TITLES.clientreport };

export default async function ClientReportPage() {
  await requireView('clientreport');
  return <ClientReportClient />;
}
