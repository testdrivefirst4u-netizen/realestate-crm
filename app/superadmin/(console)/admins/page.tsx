import type { Metadata } from 'next';
import { AdminsClient } from './AdminsClient';

export const metadata: Metadata = { title: 'Super admins' };

export default function AdminsPage() {
  return <AdminsClient />;
}
