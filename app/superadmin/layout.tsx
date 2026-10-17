import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Super Admin — Amaya Platform', template: '%s · Super Admin' },
  description: 'Platform administration for the Amaya CRM.',
  robots: { index: false, follow: false },
};

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="crm-ocean min-h-screen bg-[#F2F7FB] text-[#0F2233]">{children}</div>;
}
