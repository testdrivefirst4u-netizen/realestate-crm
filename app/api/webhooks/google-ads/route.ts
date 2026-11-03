/**
 * POST /api/webhooks/google-ads — Google Ads lead form "Webhook integration" (lead source of type google_ads,
 * plan feature googleAdsLeads). The key is the source's API key, sent by Google as `google_key` (or `?_key=`).
 * Idempotent by Google's lead id; Google's "Send test data" is logged as received but makes no lead.
 *   → 200 { status:'success', data:{ leadId, duplicate } } | 4xx/5xx { status:'error', code, message }
 */
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantById } from '@/server/platform/registry';
import { logError } from '@/server/core/events';
import { clientIp } from '@/server/core/request';
import { ingestLead, rateHit, sourcesCol } from '@/server/modules/intake';
import { resolveApiKey, toSource } from '@/server/modules/leadSources';
import { isGoogleTest, mapGoogleAdsLead, type GoogleAdsLeadBody } from '@/server/modules/googleAdsLeads';
import { googleCampaignName } from '@/server/modules/googleMarketing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 100 * 1024;
const PER_KEY_PER_MIN = 120;
const err = (status: number, code: string, message: string) => NextResponse.json({ status: 'error', code, message }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request) {
  const raw = await req.text().catch(() => '');
  if (raw.length > MAX_BODY) return err(413, 'VALIDATION', 'Request body is too large (max 100 KB)');
  let body: GoogleAdsLeadBody;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return err(400, 'VALIDATION', 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err(400, 'VALIDATION', 'Invalid JSON body');
  const key = String(body.google_key || new URL(req.url).searchParams.get('_key') || '').trim();
  if (!key) return err(401, 'AUTH_REQUIRED', 'Key missing: type the lead source key into the lead form webhook "Key" box');

  try {
    const ref = await resolveApiKey(key);
    const tenant = ref ? await getTenantById(ref.companyId) : null;
    if (!ref || !tenant) return err(401, 'AUTH_REQUIRED', 'Invalid key');
    if (tenant.status !== 'Active') return err(403, 'FORBIDDEN', 'This account is suspended');
    if (!tenant.features.googleAdsLeads) return err(403, 'FORBIDDEN', "Google Ads lead forms are not included in this company's plan");
    return await runWithTenant(tenant, async () => {
      const doc = await (await sourcesCol()).findOne({ _id: ref.sourceId });
      if (!doc) return err(401, 'AUTH_REQUIRED', 'Invalid key');
      if (doc.type !== 'google_ads') return err(403, 'FORBIDDEN', 'This key belongs to a lead source that is not a Google Ads lead form source');
      if (doc.status !== 'Active') return err(403, 'FORBIDDEN', 'This lead source is paused');
      if (!(await rateHit('key', doc._id, PER_KEY_PER_MIN))) return err(429, 'RATE_LIMIT', 'Too many leads in a minute; Google will retry');
      const source = { ...doc, config: toSource(doc).config };
      const test = isGoogleTest(body);
      const leadId = String(body.lead_id || '').trim().slice(0, 200);
      const fields = mapGoogleAdsLead(body);
      // the campaign's name (known after the Google Ads spend sync) instead of its number
      const name = body.campaign_id ? await googleCampaignName(String(body.campaign_id)).catch(() => '') : '';
      if (name) fields.meta_campaign = name;
      const r = await ingestLead(source, fields, {
        ip: clientIp(req.headers),
        origin: 'google_ads',
        idempotencyKey: leadId ? `gads:${test ? 'test:' : ''}${leadId}` : '',
        test,
      });
      if (r.status === 'created' || r.status === 'duplicate' || test) return NextResponse.json({ status: 'success', data: { leadId: r.leadId, duplicate: r.duplicate, test } }, { status: 200 });
      if (r.status === 'rejected') return err(400, 'VALIDATION', r.message || 'The lead was rejected');
      return err(500, 'INTERNAL', 'The lead could not be saved. It has been logged and will be accepted when Google retries.');
    });
  } catch (e: any) {
    console.error('[google-ads-leads]', e);
    await logError('webhook:google-ads', 'INTERNAL', e?.message, e?.stack, 'webhook').catch(() => undefined);
    return err(500, 'INTERNAL', 'Something went wrong on the server. The error has been logged.');
  }
}
