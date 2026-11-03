/**
 * Google Ads lead forms (plan feature `googleAdsLeads`): a lead source of type 'google_ads'.
 *
 * Google posts each lead form submission as JSON to POST /api/webhooks/google-ads with the key the company typed
 * in the form's "Webhook integration" (the source's API key) in `google_key`:
 *   { lead_id, form_id, campaign_id, adgroup_id, creative_id, gcl_id, is_test, api_version,
 *     user_column_data: [{ column_id: 'FULL_NAME' | 'PHONE_NUMBER' | …, column_name, string_value }] }
 * Standard columns become CRM fields; any other question keeps its own label (intake turns it into "Form: <question>").
 * The Google lead id and click id (gclid) stay in the intake log only (`_` keys), for later conversion reporting.
 */

const STANDARD: Record<string, string> = {
  FULL_NAME: 'name', FIRST_NAME: 'first_name', LAST_NAME: 'last_name',
  EMAIL: 'email', WORK_EMAIL: 'email', PHONE_NUMBER: 'phone', WORK_PHONE: 'phone',
  CITY: 'city', REGION: 'state', COUNTRY: 'country', POSTAL_CODE: 'Postal code',
  COMPANY_NAME: 'Company', JOB_TITLE: 'Job title', STREET_ADDRESS: 'Address',
};

export interface GoogleAdsLeadBody {
  lead_id?: unknown;
  form_id?: unknown;
  campaign_id?: unknown;
  adgroup_id?: unknown;
  creative_id?: unknown;
  gcl_id?: unknown;
  is_test?: unknown;
  google_key?: unknown;
  user_column_data?: Array<{ column_id?: unknown; column_name?: unknown; string_value?: unknown }>;
}

const s = (v: unknown, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

/** Google's payload → intake fields (field name → value). */
export function mapGoogleAdsLead(body: GoogleAdsLeadBody): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string) => {
    if (!v) return;
    if (out[k] && k !== 'email' && k !== 'phone') out[k] = `${out[k]}, ${v}`;
    else if (!out[k]) out[k] = v;
  };
  for (const c of Array.isArray(body.user_column_data) ? body.user_column_data.slice(0, 60) : []) {
    const id = s(c?.column_id, 80).toUpperCase();
    const value = s(c?.string_value, 500);
    if (!value) continue;
    const std = STANDARD[id];
    if (std) put(std, value);
    else put(s(c?.column_name, 160) || id.replace(/_/g, ' ').toLowerCase() || 'answer', value);
  }
  const campaign = s(body.campaign_id, 40), group = s(body.adgroup_id, 40), ad = s(body.creative_id, 40), form = s(body.form_id, 40);
  if (campaign) out.meta_campaign = `Google Ads campaign ${campaign}`;
  if (group) out.meta_ad_set = `Ad group ${group}`;
  if (ad) out.meta_ad = `Ad ${ad}`;
  if (form) out.meta_form = `Google form ${form}`;
  // kept in the intake log only
  if (s(body.lead_id)) out._google_lead_id = s(body.lead_id, 200);
  if (s(body.gcl_id)) out._gclid = s(body.gcl_id, 300);
  return out;
}

export const isGoogleTest = (body: GoogleAdsLeadBody) => body.is_test === true || body.is_test === 'true';
