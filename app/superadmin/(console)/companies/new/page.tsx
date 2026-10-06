import type { Metadata } from 'next';
import { NewCompanyClient } from './NewCompanyClient';

export const metadata: Metadata = { title: 'New company' };

export default function NewCompanyPage() {
  return <NewCompanyClient />;
}
