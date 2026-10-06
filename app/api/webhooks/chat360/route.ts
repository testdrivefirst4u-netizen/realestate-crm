/**
 * Chat360 (WhatsApp) inbound webhook — successor of `/exec?source=chat360&secret=…` (apps-script/04_Router.gs).
 *
 *   POST /api/webhooks/chat360            header  x-webhook-secret: <CHAT360_WEBHOOK_SECRET>
 *   POST /api/webhooks/chat360?secret=<CHAT360_WEBHOOK_SECRET>
 *   GET  (same URL, payload in the query string) is accepted for parity with the Apps Script doGet.
 *
 * JSON or form bodies. A missing/wrong secret → 403. After authentication the response is always HTTP 200
 * ({status:'success'|'error'}) so Chat360 does not retry forever on our own errors (they are logged).
 */
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantBySlug } from '@/server/platform/registry';
import { getSecret } from '@/server/core/settings';
import { safeEqual, truncate } from '@/server/core/utils';
import { logError } from '@/server/core/events';
import { handleWebhook } from '@/server/modules/chat360';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY = 1024 * 1024;
const RESERVED = ['secret', 'source', 'company'];

async function readPayload(req: Request, url: URL): Promise<{ payload: any; raw: string }> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { if (!RESERVED.includes(k)) query[k] = v; });
  if (req.method === 'GET') return { payload: query, raw: '' };
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) throw Object.assign(new Error('Payload too large'), { code: 'VALIDATION' });
  if ((req.headers.get('content-type') || '').toLowerCase().includes('multipart/form-data')) {
    const fd = await req.formData();
    const form: Record<string, string> = {};
    fd.forEach((v, k) => { if (!RESERVED.includes(k) && typeof v === 'string') form[k] = v; });
    return { payload: { ...query, ...form }, raw: '' };
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw Object.assign(new Error('Payload too large'), { code: 'VALIDATION' });
  const type = (req.headers.get('content-type') || '').toLowerCase();
  if (raw && !type.includes('x-www-form-urlencoded')) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') return { payload: j, raw };
    } catch { /* fall through to form parsing */ }
  }
  if (raw && (type.includes('x-www-form-urlencoded') || /^[^{[]*=/.test(raw))) {
    const form: Record<string, string> = {};
    new URLSearchParams(raw).forEach((v, k) => { if (!RESERVED.includes(k)) form[k] = v; });
    for (const k of Object.keys(form)) {
      // some providers send a JSON document in a single form field
      if (/^\s*[{[]/.test(form[k])) { try { (form as any)[k] = JSON.parse(form[k]); } catch { /* keep string */ } }
    }
    return { payload: { ...query, ...form }, raw };
  }
  return { payload: query, raw };
}

async function handleInCompany(req: Request) {
  const url = new URL(req.url);
  const expected = await getSecret('CHAT360_WEBHOOK_SECRET');
  const given = req.headers.get('x-webhook-secret') || url.searchParams.get('secret') || '';
  if (!expected || !given || !safeEqual(given, expected)) {
    return NextResponse.json({ status: 'error', code: 'FORBIDDEN', message: 'Invalid webhook secret' }, { status: 403 });
  }
  let raw = '';
  try {
    const p = await readPayload(req, url);
    raw = p.raw;
    const data = await handleWebhook(p.payload);
    return NextResponse.json({ status: 'success', data }, { status: 200 });
  } catch (err: any) {
    await logError('webhook:chat360', err?.code || 'INTERNAL', err?.message, err?.stack, 'webhook', { raw: truncate(raw, 1500) });
    // Always 200 so the provider does not retry forever on our own bugs.
    return NextResponse.json({ status: 'error', code: err?.code || 'INTERNAL', message: 'Webhook could not be processed; the error has been logged.' }, { status: 200 });
  }
}

/** The company is chosen by `?company=<slug>` (shown with the full URL in Settings → Integrations). */
async function handle(req: Request) {
  const tenant = await getTenantBySlug(new URL(req.url).searchParams.get('company') || '');
  if (!tenant || tenant.status !== 'Active') {
    return NextResponse.json({ status: 'error', code: 'NOT_FOUND', message: 'Unknown or inactive company' }, { status: 404 });
  }
  return runWithTenant(tenant, () => handleInCompany(req));
}

export const POST = handle;
export const GET = handle;
