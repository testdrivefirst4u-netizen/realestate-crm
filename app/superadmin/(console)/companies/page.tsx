import type { Metadata } from 'next';
import { CompaniesClient } from './CompaniesClient';

export const metadata: Metadata = { title: 'Companies' };

export default function CompaniesPage() {
  return <CompaniesClient />;
}
