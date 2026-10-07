/**
 * Public site-visit booking page: /book/<company slug>. No sign-in. Shows free slots and books a visit through
 * /api/public/visits/<slug>. 404 when the company does not exist, is suspended or has booking switched off.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantBySlug } from '@/server/platform/registry';
import { listSlots, visitConfig } from '@/server/modules/visits';
import { BookingClient } from './BookingClient';

export const dynamic = 'force-dynamic';

async function load(slug: string) {
  const tenant = await getTenantBySlug(String(slug || '').toLowerCase());
  if (!tenant || tenant.status !== 'Active') return null;
  return runWithTenant(tenant, async () => {
    const cfg = await visitConfig();
    if (!cfg.enabled) return null;
    return { company: { name: tenant.name, tagline: tenant.tagline || '', logo: tenant.logo || '' }, location: cfg.location, instructions: cfg.instructions, slotMinutes: cfg.slotMinutes, days: await listSlots(cfg) };
  });
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await load((await params).slug);
  return { title: data ? `Book a site visit · ${data.company.name}` : 'Book a site visit' };
}

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) notFound();
  return <BookingClient slug={slug} initial={data} />;
}
