import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { saStatus } from '@/server/platform/superAdmins';
import { LoginClient } from './LoginClient';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

/**
 * Super admins sign in on the shared /login page. This page only remains for first-run setup
 * (creating the first super admin); once one exists it forwards to /login.
 */
export default async function SuperAdminLoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (!(await saStatus()).setupRequired) {
    const raw = (await searchParams).next;
    const next = Array.isArray(raw) ? raw[0] : raw;
    redirect(next && next.startsWith('/superadmin') && !next.startsWith('//') ? `/login?next=${encodeURIComponent(next)}` : '/login?next=%2Fsuperadmin');
  }
  return <LoginClient />;
}
