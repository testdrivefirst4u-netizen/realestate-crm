import type { Metadata } from 'next';
import { CompanyDetailClient } from './CompanyDetailClient';

export const metadata: Metadata = { title: 'Company' };

export default function CompanyDetailPage() {
  return <CompanyDetailClient />;
}
