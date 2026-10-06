'use client';

/**
 * Client-only entry for the CRM single-page app. src/App.tsx touches window / localStorage while it
 * initialises (session, preferences, notifications), so it is never rendered on the server.
 */
import dynamic from 'next/dynamic';

const App = dynamic(() => import('@/src/App'), {
  ssr: false,
  loading: () => <div className="min-h-screen bg-[#F4F0EB]" aria-busy="true" />,
});

export function CrmClient() {
  return <App />;
}
