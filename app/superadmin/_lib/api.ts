'use client';
/**
 * Typed client for the platform (Super Admin) RPC endpoint. Only *types* come from the contract —
 * no server module is ever imported into the browser bundle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlatformActionName, PlatformActions } from '@/server/platform/contract';

/** The one sign-in page for CRM users and super admins (/superadmin/login only remains for first-run setup). */
export const LOGIN_PATH = '/login';
const PUBLIC_ACTIONS = new Set<PlatformActionName>(['saStatus', 'saLogin', 'saSetup']);

export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Sends the browser to the console login (remembering where it was), unless it is already there. */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname.startsWith(LOGIN_PATH)) return;
  window.location.assign(`${LOGIN_PATH}?next=${encodeURIComponent(here)}`);
}

export async function call<A extends PlatformActionName>(
  action: A,
  data: PlatformActions[A]['req'],
): Promise<PlatformActions[A]['res']> {
  let res: Response;
  try {
    res = await fetch('/api/platform/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ action, data }),
    });
  } catch {
    throw new ApiError('NETWORK', 'Could not reach the server. Check your connection and try again.', 0);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  }
  if (!body || typeof body !== 'object') {
    throw new ApiError('INTERNAL', `Unexpected response from the server (HTTP ${res.status}).`, res.status);
  }
  const env = body as { status?: string; data?: unknown; code?: string; message?: string };
  if (env.status === 'success') return env.data as PlatformActions[A]['res'];

  const code = env.code || 'INTERNAL';
  if (code === 'AUTH_REQUIRED' && !PUBLIC_ACTIONS.has(action)) redirectToLogin();
  throw new ApiError(code, env.message || 'Something went wrong. Please try again.', res.status);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}

export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'AUTH_REQUIRED';
}

/** Loads data on mount / when `deps` change. Keeps the previous data while reloading. */
export function useResource<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    loaderRef.current().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
