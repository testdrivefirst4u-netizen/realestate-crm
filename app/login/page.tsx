/**
 * One sign-in page for everybody: company users (the server finds the company from the e-mail address)
 * and platform super admins (→ /superadmin). Already signed in → straight to `next` or the home of that area.
 */
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPageSession, safeNextPath } from '@/server/core/pageSession';
import { validateSaSession } from '@/server/platform/superAdmins';
import { PLATFORM_COOKIE } from '@/server/platform/cookie';
import { DEFAULT_VIEW, viewHref } from '@/src/core/views';
import { LoginClient } from './LoginClient';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false, follow: false } };

const isConsolePath = (p: string | null) => !!p && (p === '/superadmin' || p.startsWith('/superadmin/'));

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next: raw } = await searchParams;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  const consoleSession = async () => !!(await validateSaSession((await cookies()).get(PLATFORM_COOKIE)?.value || ''));

  if (isConsolePath(next)) {
    if (await consoleSession()) redirect(next!);
  } else {
    if (await getPageSession()) redirect(next || viewHref(DEFAULT_VIEW));
    if (!next && (await consoleSession())) redirect('/superadmin');
  }
  return <LoginClient next={next} />;
}
