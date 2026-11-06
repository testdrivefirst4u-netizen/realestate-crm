/**
 * Ads manager › Meta table (plan feature adsControl): campaigns, ad sets and ads of the company's connected ad accounts
 * with the columns people know from Meta Ads Manager, for a chosen date range. Read only; pause / budget go through
 * setCampaignStatus / setCampaignBudget (modules/adsControl.ts), which work on any Meta campaign, ad set or ad id.
 *
 * Objects = GET act_<id>/campaigns | adsets | ads. Figures = GET act_<id>/insights at that level with the ad sets' own
 *           attribution setting (use_unified_attribution_setting), so they should match Ads Manager.
 * Results = the action the objective / optimisation goal counts (resultAction). Meta decides this itself on its screen,
 *           so an unusual goal can show a different figure there.
 */
import type { ActionMap } from '../core/actions';
import { fail } from '../core/errors';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { metaAdsAccess } from './adConversions';

export type AdsLevel = 'campaign' | 'adset' | 'ad';
const DATE_PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month', 'maximum'];
const SHOWN_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'WITH_ISSUES', 'IN_PROCESS'];
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

const OBJECT_FIELDS: Record<AdsLevel, string> = {
  campaign: 'id,name,status,effective_status,objective,bid_strategy,daily_budget,lifetime_budget,start_time,stop_time',
  adset: 'id,name,status,effective_status,campaign_id,campaign{name,objective},bid_strategy,optimization_goal,daily_budget,lifetime_budget,start_time,end_time',
  ad: 'id,name,status,effective_status,campaign_id,adset_id,campaign{name,objective},adset{name,optimization_goal},creative{thumbnail_url}',
};
const METRICS = 'reach,impressions,frequency,spend,clicks,ctr,cpc,cpm,inline_link_clicks,inline_link_click_ctr,cost_per_inline_link_click,actions';
const RANKINGS = 'quality_ranking,engagement_rate_ranking,conversion_rate_ranking';

const LEADS = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped'];
const BY_GOAL: Record<string, { label: string; types: string[] }> = {
  LEAD_GENERATION: { label: 'Leads', types: LEADS },
  QUALITY_LEAD: { label: 'Leads', types: LEADS },
  LINK_CLICKS: { label: 'Link clicks', types: ['link_click'] },
  LANDING_PAGE_VIEWS: { label: 'Landing page views', types: ['landing_page_view'] },
  POST_ENGAGEMENT: { label: 'Post engagements', types: ['post_engagement'] },
  CONVERSATIONS: { label: 'Messaging conversations', types: ['onsite_conversion.messaging_conversation_started_7d'] },
  OFFSITE_CONVERSIONS: { label: 'Website conversions', types: ['offsite_conversion.fb_pixel_lead', 'lead', 'offsite_conversion.fb_pixel_purchase', 'purchase'] },
  VIDEO_VIEWS: { label: 'Video views', types: ['video_view'] },
  THRUPLAY: { label: 'Video views', types: ['video_view'] },
  REACH: { label: 'Reach', types: ['@reach'] },
  IMPRESSIONS: { label: 'Impressions', types: ['@impressions'] },
};
const GOAL_OF_OBJECTIVE: Record<string, string> = {
  OUTCOME_LEADS: 'LEAD_GENERATION', LEAD_GENERATION: 'LEAD_GENERATION',
  OUTCOME_TRAFFIC: 'LINK_CLICKS', LINK_CLICKS: 'LINK_CLICKS',
  OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT', POST_ENGAGEMENT: 'POST_ENGAGEMENT', MESSAGES: 'CONVERSATIONS',
  OUTCOME_SALES: 'OFFSITE_CONVERSIONS', CONVERSIONS: 'OFFSITE_CONVERSIONS',
  OUTCOME_AWARENESS: 'REACH', BRAND_AWARENESS: 'REACH', REACH: 'REACH', VIDEO_VIEWS: 'VIDEO_VIEWS',
};

/** What counts as a result: the ad set's optimisation goal, else what the campaign's objective normally optimises for. */
export function resultAction(objective: string, goal: string): { label: string; types: string[] } | null {
  return BY_GOAL[goal] || BY_GOAL[GOAL_OF_OBJECTIVE[objective]] || null;
}

export interface MetaAdsRow {
  id: string; level: AdsLevel; name: string; accountId: string; currency: string;
  campaignId: string; campaignName: string; adsetId: string; adsetName: string;
  status: string; delivery: string; objective: string; optimizationGoal: string; bidStrategy: string;
  /** In the account's currency; null when not set on this object. */
  dailyBudget: number | null; lifetimeBudget: number | null;
  start: string; end: string; thumbnail: string;
  resultLabel: string; results: number | null; costPerResult: number | null;
  spend: number | null; reach: number | null; impressions: number | null; frequency: number | null;
  clicks: number | null; ctr: number | null; cpc: number | null; cpm: number | null;
  linkClicks: number | null; linkCtr: number | null; linkCpc: number | null;
  leads: number | null; landingPageViews: number | null;
  qualityRanking: string; engagementRanking: string; conversionRanking: string;
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Meta sends budgets in the currency's smallest unit (paise). */
const money = (v: unknown): number | null => {
  const n = num(v);
  return n === null || n === 0 ? null : n / 100;
};
const actionCount = (actions: any[] | undefined, types: string[]): number | null => {
  for (const t of types) {
    const hit = (actions || []).find((a) => a?.action_type === t);
    if (hit) return num(hit.value);
  }
  return null;
};

/** Every page of a list (bounded, so a huge account cannot run the request out of time). */
async function allPages(path: string, token: string, params: Record<string, string | number>): Promise<any[]> {
  const out: any[] = [];
  let after = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await graph<{ data?: any[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, { token, params: { ...params, ...(after ? { after } : {}) } });
    out.push(...(j.data || []));
    after = j.paging?.next ? String(j.paging?.cursors?.after || '') : '';
    if (!after) break;
  }
  return out;
}

export function buildRow(o: any, m: any, level: AdsLevel, account: { id: string; currency: string }): MetaAdsRow {
  const objective = String(o.objective || o.campaign?.objective || '');
  const goal = String(o.optimization_goal || o.adset?.optimization_goal || '');
  const action = resultAction(objective, goal);
  const spend = num(m?.spend);
  let results: number | null = null;
  if (m && action) {
    const special = action.types[0].startsWith('@') ? action.types[0].slice(1) : '';
    results = special ? num(m[special]) : actionCount(m.actions, action.types);
  }
  return {
    id: String(o.id), level, name: String(o.name || o.id), accountId: account.id, currency: account.currency || 'INR',
    campaignId: String(level === 'campaign' ? o.id : o.campaign_id || ''), campaignName: String(level === 'campaign' ? o.name || '' : o.campaign?.name || ''),
    adsetId: String(level === 'adset' ? o.id : o.adset_id || ''), adsetName: String(level === 'adset' ? o.name || '' : o.adset?.name || ''),
    status: String(o.status || ''), delivery: String(o.effective_status || o.status || ''),
    objective, optimizationGoal: goal, bidStrategy: String(o.bid_strategy || ''),
    dailyBudget: money(o.daily_budget), lifetimeBudget: money(o.lifetime_budget),
    start: String(o.start_time || ''), end: String(o.stop_time || o.end_time || ''),
    thumbnail: /^https:\/\//.test(String(o.creative?.thumbnail_url || '')) ? String(o.creative.thumbnail_url) : '',
    resultLabel: action?.label || '', results, costPerResult: results && spend !== null ? spend / results : null,
    spend, reach: num(m?.reach), impressions: num(m?.impressions), frequency: num(m?.frequency),
    clicks: num(m?.clicks), ctr: num(m?.ctr), cpc: num(m?.cpc), cpm: num(m?.cpm),
    linkClicks: num(m?.inline_link_clicks), linkCtr: num(m?.inline_link_click_ctr), linkCpc: num(m?.cost_per_inline_link_click),
    leads: actionCount(m?.actions, LEADS), landingPageViews: actionCount(m?.actions, ['landing_page_view']),
    qualityRanking: String(m?.quality_ranking || ''), engagementRanking: String(m?.engagement_rate_ranking || ''), conversionRanking: String(m?.conversion_rate_ranking || ''),
  };
}

/** A preset, or a custom since / until (yyyy-mm-dd), as Meta's insights parameters. */
export function dateParams(d: any): Record<string, string> {
  const since = String(d?.since || '');
  const until = String(d?.until || '');
  if (since || until) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(since) || !re.test(until) || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until)) || since > until) throw fail('VALIDATION', 'Choose a start date on or before the end date.');
    return { time_range: JSON.stringify({ since, until }) };
  }
  const preset = String(d?.preset || 'last_7d');
  if (!DATE_PRESETS.includes(preset)) throw fail('VALIDATION', 'Choose a date range.');
  return { date_preset: preset };
}

export async function listMetaAds(d: any): Promise<{ connected: boolean; accounts: Array<{ id: string; name: string; currency: string }>; rows: MetaAdsRow[]; previous?: MetaAdsRow[]; errors: Array<{ account: string; message: string }> }> {
  const level = d?.level as AdsLevel;
  if (!['campaign', 'adset', 'ad'].includes(level)) throw fail('VALIDATION', 'Choose campaigns, ad sets or ads.');
  const dates = dateParams(d);
  // the same campaigns and ads over a second period, to compare
  const comparing = !!(d?.compareSince || d?.compareUntil);
  const earlier = comparing ? dateParams({ since: d.compareSince, until: d.compareUntil }) : null;
  const acc = await metaAdsAccess();
  if (!acc) return { connected: false, accounts: [], rows: [], errors: [] };
  const edge = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adsets' : 'ads';
  const idKey = `${level}_id`;
  const rows: MetaAdsRow[] = [];
  const previous: MetaAdsRow[] = [];
  const errors: Array<{ account: string; message: string }> = [];
  const metricFields = `${idKey},${METRICS}${level === 'ad' ? ',' + RANKINGS : ''}`;
  await Promise.all(acc.accounts.map(async (a) => {
    try {
      const [objects, metrics, metricsBefore] = await Promise.all([
        allPages(`${a.id}/${edge}`, acc.token, { fields: OBJECT_FIELDS[level], effective_status: JSON.stringify(SHOWN_STATUSES), limit: PAGE_SIZE }),
        allPages(`${a.id}/insights`, acc.token, { level, fields: metricFields, use_unified_attribution_setting: 'true', limit: PAGE_SIZE, ...dates }),
        // the main figures still show if the earlier period cannot be read
        earlier
          ? allPages(`${a.id}/insights`, acc.token, { level, fields: metricFields, use_unified_attribution_setting: 'true', limit: PAGE_SIZE, ...earlier }).catch((e: any) => {
              errors.push({ account: a.name, message: `The earlier period could not be read: ${truncate(e?.message || String(e), 260)}` });
              return null;
            })
          : Promise.resolve(null),
      ]);
      const byId = new Map(metrics.map((m) => [String(m[idKey]), m]));
      for (const o of objects) rows.push(buildRow(o, byId.get(String(o.id)), level, a));
      if (metricsBefore) {
        const before = new Map(metricsBefore.map((m) => [String(m[idKey]), m]));
        for (const o of objects) previous.push(buildRow(o, before.get(String(o.id)), level, a));
      }
    } catch (e: any) {
      errors.push({ account: a.name, message: truncate(e?.message || String(e), 300) });
    }
  }));
  rows.sort((x, y) => Number(y.delivery === 'ACTIVE') - Number(x.delivery === 'ACTIVE') || (y.spend || 0) - (x.spend || 0) || x.name.localeCompare(y.name));
  return { connected: true, accounts: acc.accounts, rows, ...(comparing ? { previous } : {}), errors };
}

export const actions: ActionMap = {
  listMetaAds: { fn: (d) => listMetaAds(d), perm: 'leads.viewAll' },
};
