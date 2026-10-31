import type { Metadata } from 'next';
import { StorageClient } from './StorageClient';

export const metadata: Metadata = { title: 'Database storage' };

export default function StoragePage() {
  return <StorageClient />;
}
