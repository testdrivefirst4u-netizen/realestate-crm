'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoginScreen } from '@/src/modules/auth/LoginScreen';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { Toasts } from '@/src/components/Toasts';
import { AppError, toAppError } from '@/src/core/errors';
import { SIGNED_OUT_REASON_KEY, saveSession } from '@/src/core/persistence';
import { toast } from '@/src/core/notifications';
import type { AuthSession } from '@/src/types/crm';

type LoginResult = { area: 'crm' | 'superadmin'; redirect: string; user: { name?: string } } & Partial<AuthSession>;

const isConsolePath = (p: string | null) => !!p && (p === '/superadmin' || p.startsWith('/superadmin/'));

/** POST /api/auth/login — the server decides whether these are super admin or company credentials. */
async function signIn(email: string, password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw toAppError(e);
  }
  const body = await res.json().catch(() => null);
  if (body?.status === 'success') return body.data;
  const code = res.status === 429 ? 'RATE_LIMIT' : res.status === 403 ? 'FORBIDDEN' : res.status >= 500 ? 'SERVER' : 'VALIDATION';
  throw new AppError(code, body?.message || `Sign-in failed (HTTP ${res.status})`);
}

export function LoginClient({ next, photoUrl }: { next: string | null; photoUrl?: string | null }) {
  const router = useRouter();
  /** Why the last session ended (e.g. the company was suspended), handed over by the CRM shell — shown once. */
  const [reason, setReason] = useState<string | undefined>(undefined);
  useEffect(() => {
    try {
      const r = sessionStorage.getItem(SIGNED_OUT_REASON_KEY);
      if (r) {
        sessionStorage.removeItem(SIGNED_OUT_REASON_KEY);
        setReason(r);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const login = async (email: string, password: string) => {
    const r = await signIn(email, password);
    if (r.area === 'superadmin') {
      router.replace(isConsolePath(next) ? next! : r.redirect);
      return;
    }
    saveSession({ token: 'cookie', user: r.user as AuthSession['user'], expiresAt: r.expiresAt || '' });
    toast(`Welcome, ${r.user?.name || ''}`.trim(), undefined, 'success');
    router.replace(next && !isConsolePath(next) ? next : r.redirect);
  };

  return (
    <ErrorBoundary scope="login">
      <LoginScreen status="login" lastError={reason} onLogin={login} photoUrl={photoUrl} />
      <Toasts />
    </ErrorBoundary>
  );
}
