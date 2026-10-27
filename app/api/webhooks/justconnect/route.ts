/**
 * POST /api/webhooks/justconnect?company=<company id> — JustConnect call events (call_log.started / ringing / answered /
 * ended) for one company. Signed: X-JC-Signature "t=<unix>,v1=<hex HMAC-SHA256 of '<t>.<raw body>'>" with the company's
 * webhook signing secret (JUSTCONNECT_WEBHOOK_SECRET); older than 5 minutes is refused. Answers 2xx at once (JustConnect
 * wants an answer within 8 seconds) and does the slow work — recording copy, AI — afterwards.
 */
import { after, NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { getSecret } from '@/server/core/settings';
import { logError } from '@/server/core/events';
import { getTenantById } from '@/server/platform/registry';
import { announceRinging, finishCall, ingestJcCall, type JcCall } from '@/server/modules/jcCalls';
import { validJcSignature } from '@/server/integrations/justconnect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_BODY = 256 * 1024;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  const companyId = new URL(req.url).searchParams.get('company') || '';
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  const tenant = companyId ? await getTenantById(companyId) : null;
  // unknown company: a final 4xx so JustConnect stops retrying
  if (!tenant || tenant.status !== 'Active') return json({ error: 'unknown company' }, 404);

  return runWithTenant(tenant, async () => {
    const secret = (await getSecret('JUSTCONNECT_WEBHOOK_SECRET')).trim();
    if (!secret) return json({ error: 'webhook secret not set in the CRM' }, 401);
    if (!validJcSignature(raw, req.headers.get('x-jc-signature') || '', secret)) return json({ error: 'bad signature' }, 401);

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'bad json' }, 400);
    }
    const event = String(body?.event || req.headers.get('x-jc-event') || '');
    const call = body?.call as JcCall | undefined;
    if (!event.startsWith('call_log.') || !call?.id) return json({ ok: true, ignored: event || 'no event' });

    try {
      const res = await ingestJcCall(call, undefined, event === 'call_log.ringing' ? body?.ringing : null);
      after(() => runWithTenant(tenant, async () => {
        if (event === 'call_log.ringing') await announceRinging(call, body?.ringing);
        if (res.callId && res.ended) await finishCall(res.callId);
      }).catch(() => undefined));
      return json({ ok: true, callId: res.callId || null });
    } catch (e: any) {
      await logError('justconnect.webhook', 'INTERNAL', e?.message, e?.stack, '', { event, callId: call.id });
      return json({ error: 'not saved' }, 500); // JustConnect retries; the sync catches up anyway
    }
  });
}
