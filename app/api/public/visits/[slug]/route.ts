/**
 * Public site-visit booking API for a company (no sign-in): used by /book/<slug> and by company websites.
 *   GET  /api/public/visits/<slug>  →  { company, location, instructions, slotMinutes, days: [{date, slots:[{at,label,left}]}] }
 *   POST /api/public/visits/<slug>  { name, phone, email?, at, unit?, notes?, _gotcha? }  →  { at }
 * 404 when the company does not exist, is suspended, or has online booking switched off. Bookings are rate
 * limited per IP; `_gotcha` is a honeypot (keep it empty and hidden). Never returns lead data.
 */
import { NextResponse } from 'next/server';
import { ApiError, errEnvelope } from '@/server/core/errors';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantBySlug } from '@/server/platform/registry';
import { rateHit } from '@/server/modules/intake';
import { bookVisit, listSlots, visitConfig } from '@/server/modules/visits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMIT: 429 };

function cors(origin: string | null): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : {}),
  };
}

const json = (body: unknown, status: number, origin: string | null) => NextResponse.json(body, { status, headers: cors(origin) });
const notFound = (origin: string | null) => json(errEnvelope('NOT_FOUND', 'Online visit booking is not available'), 404, origin);

async function company(slug: string) {
  const t = await getTenantBySlug(String(slug || '').toLowerCase());
  return t && t.status === 'Active' ? t : null;
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get('origin')) });
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = req.headers.get('origin');
  const tenant = await company((await params).slug);
  if (!tenant) return notFound(origin);
  return runWithTenant(tenant, async () => {
    const cfg = await visitConfig();
    if (!cfg.enabled) return notFound(origin);
    return json({
      status: 'success',
      data: {
        company: { name: tenant.name, tagline: tenant.tagline || '', logo: tenant.logo || '' },
        location: cfg.location, instructions: cfg.instructions, slotMinutes: cfg.slotMinutes,
        days: await listSlots(cfg),
      },
    }, 200, origin);
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = req.headers.get('origin');
  const tenant = await company((await params).slug);
  if (!tenant) return notFound(origin);
  let body: Record<string, unknown> = {};
  try {
    const type = req.headers.get('content-type') || '';
    if (Number(req.headers.get('content-length') || 0) > 20_000) return json(errEnvelope('VALIDATION', 'Request is too large'), 413, origin);
    body = type.includes('application/json') ? await req.json() : Object.fromEntries((await req.formData()).entries());
  } catch {
    return json(errEnvelope('VALIDATION', 'Invalid request'), 400, origin);
  }
  if (String(body._gotcha ?? '').trim()) return json({ status: 'success', data: { at: String(body.at ?? '') } }, 201, origin); // bots: pretend success
  const ip = ((req.headers.get('x-forwarded-for') || '').split(',')[0] || req.headers.get('x-real-ip') || '').trim();
  return runWithTenant(tenant, async () => {
    if (!(await rateHit('visit-ip', ip, 6))) return json(errEnvelope('RATE_LIMIT', 'Too many bookings from this connection — please wait a minute'), 429, origin);
    try {
      const r = await bookVisit(body);
      return json({ status: 'success', data: { at: r.at } }, 201, origin);
    } catch (e: any) {
      if (e instanceof ApiError && STATUS[e.code]) return json(errEnvelope(e.code, e.message), STATUS[e.code], origin);
      console.error('[visits:book]', e);
      return json(errEnvelope('INTERNAL', 'Something went wrong — please try again or call us'), 500, origin);
    }
  });
}
