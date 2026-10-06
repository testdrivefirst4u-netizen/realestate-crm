/**
 * Signed-in CRM layout. Runs on the server for every full page load: validates the session cookie
 * (company active, session live, user enabled) and redirects to /login otherwise, then renders the
 * client shell with the user and the company's public settings so the frame (sidebar with the right
 * features, company name, user) is in the first HTML. The layout is kept across client navigations.
 */
import type { Metadata } from 'next';
import { CrmShell } from './_components/CrmShell';
import { getPageSession, requirePageSession } from '@/server/core/pageSession';
import { platformProductName } from '@/src/core/features';
import type { ServerSettings, UserAccount } from '@/src/types/crm';

export async function generateMetadata(): Promise<Metadata> {
  const company = (await getPageSession())?.settings.company?.name;
  const suffix = company ? `${company} · CRM` : platformProductName();
  return { title: { default: suffix, template: `%s · ${suffix}` }, robots: { index: false, follow: false } };
}

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePageSession();
  const init = {
    // The real token stays in the httpOnly cookie; the browser only ever sees this placeholder.
    session: { token: 'cookie', user: session.user as unknown as UserAccount, expiresAt: session.expiresAt },
    serverSettings: session.settings as unknown as ServerSettings,
  };
  return <CrmShell init={init}>{children}</CrmShell>;
}
