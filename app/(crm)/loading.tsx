'use client';

/**
 * Shown straight away while the next CRM screen loads (the sidebar and top bar stay put): a skeleton
 * shaped like that screen. The access check still runs in the layout before anything streams.
 */
import { usePathname } from 'next/navigation';
import { PageSkeleton, VIEW_SKELETON } from '@/src/components/Skeletons';
import { viewFromPath } from '@/src/core/views';

export default function Loading() {
  const view = viewFromPath(usePathname());
  return <PageSkeleton variant={view ? VIEW_SKELETON[view] : undefined} />;
}
