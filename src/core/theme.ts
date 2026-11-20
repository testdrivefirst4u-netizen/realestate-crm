'use client';
/**
 * UI appearance mode: Day (light), Night (dark) or Auto (follow the device). The choice is saved per device in
 * localStorage and applied as `data-theme="light" | "dark"` on <html>; a tiny inline script in the root layout applies
 * it before first paint (no flash), and this module keeps it in sync while the app runs. Dark styling itself is rolled
 * out screen by screen behind the `[data-theme="dark"]` selector / Tailwind `dark:` variant.
 */
import { useEffect, useState } from 'react';

export type UiMode = 'day' | 'night' | 'auto';
export const UI_MODE_KEY = 'bcUiMode';

const systemDarkMql = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function readMode(): UiMode {
  try { const m = localStorage.getItem(UI_MODE_KEY); return m === 'night' || m === 'auto' ? m : 'day'; } catch { return 'day'; }
}
export function isDark(mode: UiMode): boolean {
  return mode === 'night' || (mode === 'auto' && !!systemDarkMql()?.matches);
}
export function applyMode(mode: UiMode): void {
  try { document.documentElement.setAttribute('data-theme', isDark(mode) ? 'dark' : 'light'); } catch { /* SSR / blocked */ }
}

/** Current mode + a setter that persists and applies it. Also re-applies when the system theme changes under "Auto". */
export function useUiMode(): [UiMode, (m: UiMode) => void] {
  const [mode, setModeState] = useState<UiMode>('day');
  useEffect(() => { setModeState(readMode()); }, []);
  useEffect(() => {
    const mql = systemDarkMql();
    if (!mql) return;
    const onChange = () => { if (readMode() === 'auto') applyMode('auto'); };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  const setMode = (m: UiMode) => {
    try { localStorage.setItem(UI_MODE_KEY, m); } catch { /* blocked */ }
    applyMode(m);
    setModeState(m);
  };
  return [mode, setMode];
}
