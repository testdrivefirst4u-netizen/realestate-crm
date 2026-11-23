'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps the public dashboard close to live. A soft refresh (router.refresh) re-fetches the
 * force-dynamic server data and re-renders in place — no white flash, the selected tab is kept.
 * It fires on a short interval and whenever the tab becomes visible again (e.g. switching back).
 */
export function AutoRefresh({ everyMs = 20_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, everyMs);
    const onVisible = () => { if (document.visibilityState === 'visible') router.refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [everyMs, router]);
  return null;
}
