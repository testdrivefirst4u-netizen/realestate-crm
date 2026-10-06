import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { InventoryClient } from './InventoryClient';

export const metadata: Metadata = { title: VIEW_TITLES.inventory };

export default async function InventoryPage() {
  await requireView('inventory');
  return <InventoryClient />;
}
