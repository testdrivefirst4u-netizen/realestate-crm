/**
 * Ads manager (plan feature adsControl, screen /ads): the company's Meta and Google Ads campaigns with the last
 * 7 days' spend and CRM leads, pause / resume, daily budget, and an alert for a campaign spending without leads.
 * Uses the Facebook connection of Settings › Meta ads and the Google connection of Settings › Google.
 *
 * Meta    = GET act_<id>/campaigns (status, daily_budget in paise, insights last_7d); POST /<campaign> status /
 *           daily_budget (only when the budget is on the campaign; ad-set budgets are changed in Ads Manager).
 * Google  = GAQL campaign + campaign_budget (cost last 7 days); campaigns:mutate status, campaignBudgets:mutate amount.
 * Alerts  = daily: a campaign that spent at least the set amount in the last 7 days with no CRM lead from it →
 *           phone notification to Admins and Managers, at most once a week per campaign.
 * Changes need marketing.ads (Admins, Managers); every change is in the audit log.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { listActiveTenants } from '../platform/registry';
import { metaAdsAccess } from './adConversions';
import { adsCall, adsSearch } from './googleMarketing';
import { sendPush } from './push';

export type AdPlatform = 'meta' | 'google';
export interface AdCampaign {
  platform: AdPlatform;
  id: string;
  name: string;
  account: string;
  status: 'ACTIVE' | 'PAUSED' | 'OTHER';
  /** ₹ per day; null when the budget is on the ad sets (Meta) or shared. */
  dailyBudget: number | null;
  budgetRef: string;
  spend7: number;
  leads7: number;
}
interface AlertsDoc { _id: 'adsAlerts'; enabled: boolean; minSpend: number; sent?: Record<string, string> }
const alertsCol = () => col<AlertsDoc>(CFG.COLL.INTEGRATIONS);

async function leadsByCampaign(days = 7): Promise<Map<string, number>> {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await (await col<any>(CFG.COLL.LEADS)).aggregate<{ _id: string; n: number }>([
    { $match: { createdAt: { $gte: since }, 'extra.Campaign': { $exists: true, $ne: '' } } },
    { $group: { _id: '$extra.Campaign', n: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function metaCampaigns(): Promise<AdCampaign[]> {
  const acc = await metaAdsAccess();
  if (!acc) return [];
  const out: AdCampaign[] = [];
  for (const a of acc.accounts) {
    const j = await graph<{ data?: any[] }>(`${a.id}/campaigns`, { token: acc.token, params: {
      fields: 'id,name,status,daily_budget,insights.date_preset(last_7d){spend}', limit: 200,
      effective_status: JSON.stringify(['ACTIVE', 'PAUSED']),
    } });
    for (const c of j.data || []) {
      const budget = c.daily_budget ? Number(c.daily_budget) / 100 : null;
      out.push({
        platform: 'meta', id: String(c.id), name: String(c.name || c.id), account: a.name,
        status: c.status === 'ACTIVE' ? 'ACTIVE' : c.status === 'PAUSED' ? 'PAUSED' : 'OTHER',
        dailyBudget: budget, budgetRef: '', spend7: Number(c.insights?.data?.[0]?.spend || 0), leads7: 0,
      });
    }
  }
  return out;
}

async function googleCampaigns(): Promise<AdCampaign[]> {
  const doc = await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'google' });
  if (!doc?.adsCustomerId) return [];
  const rows = await adsSearch(doc.adsCustomerId, "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.resource_name, campaign_budget.explicitly_shared, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status != 'REMOVED'");
  const byId = new Map<string, AdCampaign>();
  for (const r of rows) {
    const id = String(r?.campaign?.id || '');
    if (!id) continue;
    const cur = byId.get(id);
    const spend = Number(r?.metrics?.costMicros || 0) / 1e6;
    if (cur) { cur.spend7 += spend; continue; }
    const shared = !!r?.campaignBudget?.explicitlyShared;
    byId.set(id, {
      platform: 'google', id, name: String(r?.campaign?.name || id), account: doc.adsCustomers?.find((c: any) => c.id === doc.adsCustomerId)?.name || doc.adsCustomerId,
      status: r?.campaign?.status === 'ENABLED' ? 'ACTIVE' : r?.campaign?.status === 'PAUSED' ? 'PAUSED' : 'OTHER',
      dailyBudget: shared ? null : Number(r?.campaignBudget?.amountMicros || 0) / 1e6 || null, budgetRef: shared ? '' : String(r?.campaignBudget?.resourceName || ''), spend7: spend, leads7: 0,
    });
  }
  return [...byId.values()];
}

export async function listAdCampaigns(): Promise<{ campaigns: AdCampaign[]; errors: Partial<Record<AdPlatform, string>>; alerts: { enabled: boolean; minSpend: number } }> {
  const errors: Partial<Record<AdPlatform, string>> = {};
  const [meta, google] = await Promise.all([
    metaCampaigns().catch((e) => { errors.meta = truncate(e?.message || String(e), 300); return [] as AdCampaign[]; }),
    googleCampaigns().catch((e) => { errors.google = truncate(e?.message || String(e), 300); return [] as AdCampaign[]; }),
  ]);
  const leads = await leadsByCampaign(7);
  const campaigns = [...meta, ...google].map((c) => ({ ...c, spend7: Math.round(c.spend7 * 100) / 100, leads7: leads.get(c.name) || 0 }))
    .sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || b.spend7 - a.spend7);
  const a = await (await alertsCol()).findOne({ _id: 'adsAlerts' });
  return { campaigns, errors, alerts: { enabled: a?.enabled ?? true, minSpend: a?.minSpend ?? 3000 } };
}

const googleCid = async () => String((await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'google' }))?.adsCustomerId || '');

export async function setCampaignStatus(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const platform = d?.platform === 'google' ? 'google' : d?.platform === 'meta' ? 'meta' : null;
  const id = String(d?.id || '').replace(/\D/g, '');
  const active = d?.status === 'ACTIVE';
  if (!platform || !id || !['ACTIVE', 'PAUSED'].includes(d?.status)) throw fail('VALIDATION', 'Choose a campaign and Pause or Resume.');
  if (platform === 'meta') {
    const acc = await metaAdsAccess();
    if (!acc) throw fail('VALIDATION', 'Connect with Facebook first (Settings › Meta ads).');
    await graph(id, { token: acc.token, method: 'POST', params: { status: active ? 'ACTIVE' : 'PAUSED' } });
  } else {
    const cid = await googleCid();
    if (!cid) throw fail('VALIDATION', 'Choose the Google Ads account first (Settings › Google).');
    await adsCall(`customers/${cid}/campaigns:mutate`, { operations: [{ update: { resourceName: `customers/${cid}/campaigns/${id}`, status: active ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }] });
  }
  await auditLog(ctx, active ? 'Campaign Resumed' : 'Campaign Paused', 'Campaign', `${platform}:${id}`, String(d?.name || ''));
  return { ok: true };
}

export async function setCampaignBudget(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const platform = d?.platform === 'google' ? 'google' : d?.platform === 'meta' ? 'meta' : null;
  const id = String(d?.id || '').replace(/\D/g, '');
  const amount = Math.round(Number(d?.daily) * 100) / 100;
  if (!platform || !id) throw fail('VALIDATION', 'Choose a campaign.');
  if (!Number.isFinite(amount) || amount < 100 || amount > 1000000) throw fail('VALIDATION', 'The daily budget must be between ₹100 and ₹10,00,000.');
  if (platform === 'meta') {
    const acc = await metaAdsAccess();
    if (!acc) throw fail('VALIDATION', 'Connect with Facebook first (Settings › Meta ads).');
    await graph(id, { token: acc.token, method: 'POST', params: { daily_budget: String(Math.round(amount * 100)) } });
  } else {
    const cid = await googleCid();
    const ref = String(d?.budgetRef || '');
    if (!cid || !/^customers\/\d+\/campaignBudgets\/\d+$/.test(ref)) throw fail('VALIDATION', 'This campaign uses a shared budget. Change it in Google Ads.');
    await adsCall(`customers/${cid}/campaignBudgets:mutate`, { operations: [{ update: { resourceName: ref, amountMicros: String(Math.round(amount * 1e6)) }, updateMask: 'amount_micros' }] });
  }
  await auditLog(ctx, 'Campaign Budget Changed', 'Campaign', `${platform}:${id}`, `${String(d?.name || '')} → ₹${amount}/day`);
  return { ok: true };
}

export async function saveAdAlerts(d: any, ctx: Ctx): Promise<{ enabled: boolean; minSpend: number }> {
  const minSpend = Math.round(Number(d?.minSpend));
  if (!Number.isFinite(minSpend) || minSpend < 500 || minSpend > 1000000) throw fail('VALIDATION', 'The amount must be between ₹500 and ₹10,00,000.');
  const enabled = d?.enabled !== false;
  await (await alertsCol()).updateOne({ _id: 'adsAlerts' }, { $set: { enabled, minSpend } }, { upsert: true });
  await auditLog(ctx, 'Ad Alerts Updated', 'Settings', 'adsAlerts', `${enabled ? 'On' : 'Off'} · ₹${minSpend}`);
  return { enabled, minSpend };
}

/** Daily: campaigns that spent at least the set amount in 7 days with no lead (once a week per campaign). */
export async function checkAdAlerts(now = new Date()): Promise<number> {
  const cfg = await (await alertsCol()).findOne({ _id: 'adsAlerts' });
  if (cfg && !cfg.enabled) return 0;
  const min = cfg?.minSpend ?? 3000;
  const { campaigns } = await listAdCampaigns();
  const sent = { ...(cfg?.sent || {}) };
  const weekAgo = now.getTime() - 7 * 86400000;
  const hits = campaigns.filter((c) => c.status === 'ACTIVE' && c.spend7 >= min && c.leads7 === 0 && !(sent[`${c.platform}:${c.id}`] && Date.parse(sent[`${c.platform}:${c.id}`]) > weekAgo));
  if (!hits.length) return 0;
  const ids = (await listUsers()).filter((u) => u.status !== 'Disabled' && (u.role === 'Admin' || u.role === 'Manager')).map((u) => u.id);
  for (const c of hits) {
    if (ids.length) await sendPush(ids, { title: `No leads: ${truncate(c.name, 60)}`, body: `${c.platform === 'meta' ? 'Meta' : 'Google Ads'} campaign spent ₹${Math.round(c.spend7).toLocaleString('en-IN')} in 7 days with no lead in the CRM.`, url: '/ads', tag: `ads-${c.platform}-${c.id}` }).catch(() => undefined);
    sent[`${c.platform}:${c.id}`] = now.toISOString();
  }
  await (await alertsCol()).updateOne({ _id: 'adsAlerts' }, { $set: { sent }, $setOnInsert: { enabled: true, minSpend: min } }, { upsert: true });
  return hits.length;
}

export async function runAdAlertsCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.adsControl) continue;
    try {
      const n = await runWithTenant(tenant, () => checkAdAlerts(now));
      if (n) out[tenant.slug] = n;
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

export const actions: ActionMap = {
  listAdCampaigns: { fn: () => listAdCampaigns(), perm: 'leads.viewAll' },
  setCampaignStatus: { fn: (d, ctx) => setCampaignStatus(d, ctx), perm: 'marketing.ads' },
  setCampaignBudget: { fn: (d, ctx) => setCampaignBudget(d, ctx), perm: 'marketing.ads' },
  saveAdAlerts: { fn: (d, ctx) => saveAdAlerts(d, ctx), perm: 'marketing.ads' },
};

