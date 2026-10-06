import type { Metadata } from 'next';
import { AuditClient } from './AuditClient';

export const metadata: Metadata = { title: 'Audit log' };

export default function AuditPage() {
  return <AuditClient />;
}
