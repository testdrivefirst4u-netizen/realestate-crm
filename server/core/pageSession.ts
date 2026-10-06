/**
 * Session for server-rendered CRM pages (layouts and pages, not route handlers).
 *
 * Same checks as `/api/rpc`: the cookie's company must exist and be Active, and the token must be a
 * live session of an enabled user in that company. `cache` makes the layout and the page of one
 * request share a single lookup.
 */
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestBase } from './request';
import { runWithTenant } from './tenant';
import { validateSession, type PublicUser } from './auth';
import { settingsPublic } from './settings';
import { getTenantById } from '../platform/registry';
import { can } from '../../src/core/rbac';
import { DEFAULT_VIEW, viewAllowed, viewFromPath, viewHref, type ViewId } from '../../src/core/views';
import type { UserAccount } from '../../src/types/crm';

export interface PageSession {
  user: PublicUser;
  expiresAt: string;
  /** The company's settings that every signed-in user may see (features, branding, time zone…). */
  settings: Awaited<ReturnType<typeof settingsPublic>>;
}

/** Request header set by proxy.ts (which spells it out itself): path + query of the page being rendered (for `/login?next=`). */
export const CRM_URL_HEADER = 'x-crm-url';

export const getPageSession = cache(async (): Promise<PageSession | null> => {
  const base = await requestBase();
  if (!base.companyId || !base.token) return null;
  const tenant = await getTenantById(base.companyId);
  if (!tenant || tenant.status !== 'Active') return null;
  return runWithTenant(tenant, async () => {
    const s = await validateSession(base.token);
    if (!s) return null;
    return { ...s, settings: await settingsPublic() };
  });
});

/** A same-origin path to return to after sign-in, or null (protects against open redirects). */
export function safeNextPath(raw: string | null | undefined): string | null {
  const v = String(raw || '');
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || v.startsWith('/login')) return null;
  return v;
}

/**
 * The signed-in session, or a redirect to the sign-in page that comes back to this URL. Also applies
 * the screen gate of the requested URL here, before the layout streams anything, so a full page load
 * of a screen the plan or role excludes gets a real 307 (pages repeat the check for client navigations,
 * which do not re-render the layout).
 */
export async function requirePageSession(): Promise<PageSession> {
  const url = safeNextPath((await headers()).get(CRM_URL_HEADER));
  const session = await getPageSession();
  if (!session) redirect(url && url !== viewHref(DEFAULT_VIEW) ? `/login?next=${encodeURIComponent(url)}` : '/login');
  const view = viewFromPath(url?.split('?')[0]);
  if (view && !mayOpen(session, view)) redirect(viewHref(DEFAULT_VIEW));
  return session;
}

function mayOpen(session: PageSession, view: ViewId) {
  const user = session.user as unknown as UserAccount;
  return viewAllowed(view, session.settings, (p) => can(user, p));
}

/** Gate a CRM screen: signed in, and the plan + role allow it (same rule as the sidebar) — else the dashboard. */
export async function requireView(view: ViewId): Promise<PageSession> {
  const session = await requirePageSession();
  if (!mayOpen(session, view)) redirect(viewHref(DEFAULT_VIEW));
  return session;
}
