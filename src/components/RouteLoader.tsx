'use client';

/**
 * Plays the BroaddCast loader (public/brand-loader.js) whenever someone moves to another page: straight away
 * on a click of a link to a different path, and on back/forward or a programmatic router.push. It closes once
 * the new page is in place (after its short minimum). Query or hash changes on the same page do not count.
 */
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

declare global {
  interface Window {
    bcLoaderShow?: () => void;
    bcLoaderDone?: () => void;
  }
}

export function RouteLoader() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
      const url = new URL(a.href, location.href);
      // files, downloads and API links never change the page
      if (url.origin !== location.origin || url.pathname === location.pathname || url.pathname.startsWith('/api/')) return;
      window.bcLoaderShow?.();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.bcLoaderShow?.(); // back/forward or router.push: no click started it
    window.bcLoaderDone?.();
  }, [pathname]);

  return null;
}
