/**
 * Public website-chatbot API for a company (no sign-in): used by the embeddable widget on company websites.
 *   POST /api/public/webchat/<slug>  { sessionId?, text?, replyId?, visitorId?, _gotcha? }
 *     → { sessionId, messages: Outgoing[], status, done, company }
 * A missing/ended/unknown sessionId starts a fresh chat on the company's one live bot. 404 when the company does
 * not exist, is suspended, the website chatbot is off, or no bot is live. Rate limited per IP. Never returns lead data.
 */
import { NextResponse } from 'next/server';
import { ApiError, errEnvelope } from '@/server/core/errors';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantBySlug } from '@/server/platform/registry';
import { rateHit } from '@/server/modules/intake';
import { webchatTurn } from '@/server/modules/webchat';
import { clientIp } from '@/server/core/request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = { VALIDATION: 400, FORBIDDEN: 404, NOT_FOUND: 404, RATE_LIMIT: 429 };

function cors(origin: string | null): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : {}),
  };
}
const json = (body: unknown, status: number, origin: string | null) => NextResponse.json(body, { status, headers: cors(origin) });

async function company(slug: string) {
  const t = await getTenantBySlug(String(slug || '').toLowerCase());
  return t && t.status === 'Active' ? t : null;
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get('origin')) });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const origin = req.headers.get('origin');
  const tenant = await company((await params).slug);
  if (!tenant) return json(errEnvelope('NOT_FOUND', 'No chatbot here'), 404, origin);
  let body: Record<string, unknown> = {};
  try {
    if (Number(req.headers.get('content-length') || 0) > 10_000) return json(errEnvelope('VALIDATION', 'Request is too large'), 413, origin);
    body = await req.json();
  } catch {
    return json(errEnvelope('VALIDATION', 'Invalid request'), 400, origin);
  }
  if (String(body._gotcha ?? '').trim()) return json({ status: 'success', data: { sessionId: '', messages: [], status: 'done', done: true } }, 200, origin); // bots: pretend done
  const ip = clientIp(req.headers);
  return runWithTenant(tenant, async () => {
    if (!(await rateHit('webchat-ip', ip, 60))) return json(errEnvelope('RATE_LIMIT', 'Too many messages — please wait a moment'), 429, origin);
    try {
      const r = await webchatTurn({
        sessionId: String(body.sessionId ?? ''), text: String(body.text ?? ''), replyId: String(body.replyId ?? ''),
        visitorId: String(body.visitorId ?? ''), origin: origin || '', ip,
      });
      return json({ status: 'success', data: r }, 200, origin);
    } catch (e: any) {
      if (e instanceof ApiError && STATUS[e.code]) return json(errEnvelope(e.code, e.message), STATUS[e.code], origin);
      console.error('[webchat]', e);
      return json(errEnvelope('INTERNAL', 'Something went wrong — please try again'), 500, origin);
    }
  });
}
