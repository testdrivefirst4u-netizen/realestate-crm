/**
 * Public lead intake — website forms and generic webhooks (contract: server/core/leadSourceTypes.ts).
 *
 *   POST /api/inbound/leads
 *     key:   `Authorization: Bearer <key>` | `X-Api-Key: <key>` | field `_key` | query `?_key=`
 *     body:  JSON, application/x-www-form-urlencoded or multipart/form-data (files ignored), ≤ 100 KB
 *     extras: `_gotcha` honeypot, `_redirect` (https URL on an allowed origin → 303 with ?lead=ok|error),
 *             `Idempotency-Key` header or `_submission_id` field
 *   → 201 { status:'success', data:{ leadId, duplicate } } | 4xx/5xx { status:'error', code, message }
 *
 * The key alone identifies the company (platform `apiKeys` holds its SHA-256) — unknown key 401;
 * paused source, suspended company or a plan without `websiteApi` 403; foreign Origin 403; 60/min per key
 * and 20/min per IP → 429. OPTIONS (CORS preflight cannot carry the key) is answered for any origin;
 * the POST itself is checked against the source's allowed origins.
 */
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantById } from '@/server/platform/registry';
import { logError } from '@/server/core/events';
import { flatValue, ingestLead, rateHit, sourcesCol, type IngestResult } from '@/server/modules/intake';
import { resolveApiKey, toSource } from '@/server/modules/leadSources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BODY = 100 * 1024;
const PER_KEY_PER_MIN = 60;
const PER_IP_PER_MIN = 20;

/* ---------------------------------- CORS --------------------------------- */

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Api-Key, Idempotency-Key';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

const json = (body: unknown, status: number, headers: Record<string, string>) => NextResponse.json(body, { status, headers });
const err = (status: number, code: string, message: string, headers: Record<string, string>) => json({ status: 'error', code, message }, status, headers);

/* ---------------------------------- body --------------------------------- */

class BodyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function addField(out: Record<string, unknown>, k: string, v: string) {
  if (k in out && out[k] !== '') out[k] = `${flatValue(out[k])}, ${v}`;
  else out[k] = v;
}

async function readFields(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) throw new BodyError(413, 'VALIDATION', 'Request body is too large (max 100 KB)');
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY) throw new BodyError(413, 'VALIDATION', 'Request body is too large (max 100 KB)');
  if (!buf.byteLength) return {};
  const type = (req.headers.get('content-type') || '').toLowerCase();
  const out: Record<string, unknown> = {};
  if (type.includes('multipart/form-data')) {
    let fd: FormData;
    try {
      fd = await new Response(buf, { headers: { 'content-type': req.headers.get('content-type') || '' } }).formData();
    } catch {
      throw new BodyError(400, 'VALIDATION', 'Invalid multipart body');
    }
    fd.forEach((v, k) => {
      if (typeof v === 'string') addField(out, k, v); // files are ignored
    });
    return out;
  }
  const text = new TextDecoder().decode(buf);
  const looksJson = /^\s*[{[]/.test(text);
  if (type.includes('json') || (!type.includes('x-www-form-urlencoded') && looksJson)) {
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      throw new BodyError(400, 'VALIDATION', 'Invalid JSON body');
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new BodyError(400, 'VALIDATION', 'The JSON body must be an object of field → value');
    return j as Record<string, unknown>;
  }
  new URLSearchParams(text).forEach((v, k) => addField(out, k, v));
  return out;
}

function bearer(req: Request): string {
  const a = req.headers.get('authorization') || '';
  const m = a.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : '').trim();
}

/** Validated `_redirect` target, or null (JSON answer). */
function redirectTarget(raw: unknown, allowed: string[], req: Request): URL | null {
  const s = flatValue(raw).trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (allowed.length) return allowed.includes(u.origin) ? u : null;
  const from = req.headers.get('origin') || req.headers.get('referer') || '';
  try {
    return from && new URL(from).host === u.host ? u : null;
  } catch {
    return null;
  }
}

function redirect(u: URL, ok: boolean, headers: Record<string, string>) {
  const target = new URL(u.toString());
  target.searchParams.set('lead', ok ? 'ok' : 'error');
  return new NextResponse(null, { status: 303, headers: { ...headers, Location: target.toString() } });
}

/* --------------------------------- handlers ------------------------------ */

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  const open = corsHeaders(origin); // used until the source (and its allowed origins) is known
  const url = new URL(req.url);
  const ip = ((req.headers.get('x-forwarded-for') || '').split(',')[0] || req.headers.get('x-real-ip') || '').trim();

  let fields: Record<string, unknown>;
  try {
    fields = await readFields(req);
  } catch (e: any) {
    if (e instanceof BodyError) return err(e.status, e.code, e.message, open);
    return err(400, 'VALIDATION', 'The request body could not be read', open);
  }

  const key = (bearer(req) || req.headers.get('x-api-key') || flatValue(fields._key) || url.searchParams.get('_key') || '').trim();
  if (!key) return err(401, 'AUTH_REQUIRED', 'API key missing (Authorization: Bearer <key>, X-Api-Key header or _key field)', open);

  try {
    const ref = await resolveApiKey(key);
    if (!ref) return err(401, 'AUTH_REQUIRED', 'Invalid API key', open);
    const tenant = await getTenantById(ref.companyId);
    if (!tenant) return err(401, 'AUTH_REQUIRED', 'Invalid API key', open);
    if (tenant.status !== 'Active') return err(403, 'FORBIDDEN', 'This account is suspended', open);
    if (!tenant.features.websiteApi) return err(403, 'FORBIDDEN', "Website forms & lead API are not included in this company's plan", open);

    return await runWithTenant(tenant, () => handleInCompany(req, fields, ref.sourceId, origin, ip, url, open));
  } catch (e: any) {
    console.error('[inbound-leads]', e);
    return err(500, 'INTERNAL', 'Something went wrong on the server. The error has been logged.', open);
  }
}

async function handleInCompany(req: Request, fields: Record<string, unknown>, sourceId: string, origin: string | null, ip: string, url: URL, open: Record<string, string>) {
  try {
    const doc = await (await sourcesCol()).findOne({ _id: sourceId });
    if (!doc) return err(401, 'AUTH_REQUIRED', 'Invalid API key', open);
    // Google Sheet sources pull rows themselves and never accept pushed submissions (they have no key either).
    if (doc.type === 'google_sheet') return err(403, 'FORBIDDEN', 'This lead source imports from Google Sheets and does not accept submissions', open);
    // Meta sources receive leads from Facebook (webhook + Graph API) only.
    if (doc.type === 'meta') return err(403, 'FORBIDDEN', 'This lead source receives Meta (Facebook / Instagram) Lead Ads and does not accept submissions', open);
    const source = { ...doc, config: toSource(doc).config };
    const allowed = source.config.allowedOrigins || [];
    if (origin && allowed.length && !allowed.includes(origin)) {
      return err(403, 'FORBIDDEN', 'This website is not allowed to send leads to this source', { 'Cache-Control': 'no-store', Vary: 'Origin' });
    }
    const headers = corsHeaders(origin);
    if (source.status !== 'Active') return err(403, 'FORBIDDEN', 'This lead source is paused', headers);

    if (!(await rateHit('key', source._id, PER_KEY_PER_MIN)) || !(await rateHit('ip', ip, PER_IP_PER_MIN))) {
      return err(429, 'RATE_LIMIT', 'Too many submissions — please try again in a minute', { ...headers, 'Retry-After': '60' });
    }

    const back = redirectTarget(fields._redirect ?? url.searchParams.get('_redirect'), allowed, req);
    const idem = req.headers.get('idempotency-key') || flatValue(fields._submission_id);
    const r: IngestResult = await ingestLead(source, fields, { ip, origin: origin || req.headers.get('referer') || '', idempotencyKey: idem });

    const spam = r.status === 'rejected' && r.message === 'spam (honeypot)';
    const ok = r.status === 'created' || r.status === 'duplicate' || spam;
    if (back) return redirect(back, ok, headers);
    if (spam) return json({ status: 'success', data: { leadId: '', duplicate: false } }, 201, headers);
    if (ok) return json({ status: 'success', data: { leadId: r.leadId, duplicate: r.duplicate } }, 201, headers);
    if (r.status === 'rejected') return err(400, 'VALIDATION', r.message || 'The submission was rejected', headers);
    return err(500, 'INTERNAL', 'The enquiry could not be saved. It has been logged and can be retried.', headers);
  } catch (e: any) {
    console.error('[inbound-leads]', e);
    await logError('inbound:leads', 'INTERNAL', e?.message, e?.stack, 'inbound');
    return err(500, 'INTERNAL', 'Something went wrong on the server. The error has been logged.', open);
  }
}
