import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Super Admin — Amaya Platform', template: '%s · Super Admin' },
  description: 'Platform administration for the Amaya CRM.',
  robots: { index: false, follow: false },
};

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#F4F0EB] text-[#26211E]">{children}</div>;
}
