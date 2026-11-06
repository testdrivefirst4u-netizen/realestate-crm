import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { SearchConsoleClient } from './SearchConsoleClient';

export const metadata: Metadata = { title: VIEW_TITLES.searchconsole };

export default async function SearchConsolePage() {
  await requireView('searchconsole');
  return <SearchConsoleClient />;
}
