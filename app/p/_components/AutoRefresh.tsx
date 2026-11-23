'use client';
import { useEffect } from 'react';
/** Reloads the public page on an interval so a left-open dashboard stays current (default 30 min). */
export function AutoRefresh({ everyMs = 1_800_000 }: { everyMs?: number }) {
  useEffect(() => { const t = setInterval(() => window.location.reload(), everyMs); return () => clearInterval(t); }, [everyMs]);
  return null;
}
