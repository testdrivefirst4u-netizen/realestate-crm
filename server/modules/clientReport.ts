/**
 * Client Report delivery: a revocable public share link and a monthly summary e-mail.
 *
 * - The authed /clientreport screen renders live (session RPCs). This module adds the *delivery* layer:
 *   a branded, no-login public page (/r/<slug>/<token>) and a once-a-month e-mail to the client.
 * - The public page can't call session RPCs, so clientReportData(month) aggregates the stored, reliable sources
 *   server-side (ad spend, published posts, leads/bookings, follower snapshots). Live-only sources (GA4, Google
 *   Business Profile, live social insights) are intentionally left off the public page — they need live integration
 *   calls that can fail and would leak connection errors to a public URL.
 * - The share link is revocable: a per-company token in settings, gated by an on/off flag. Rotating the token or
 *   turning sharing off breaks every old link immediately.
 */
import type { ActionMap } from '../core/actions';
import type { Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { settingsAll, settingSet } from '../core/settings';
import { randomToken } from '../core/utils';
import { enquiryDate, isBooked } from '../../src/core/analytics';
import type { Lead } from '../../src/types/crm';
import { getAllLeads } from './leads';
import { listPosts } from './socialPosts';
import { getCampaignSpend } from './salesOps';
import { followerHistory } from './followerSnapshots';

const F = CFG.LEAD;
const K = {
  enabled: 'clientReport.shareEnabled',
  token: 'clientReport.shareToken',
  recipients: 'clientReport.recipients',
  email: 'clientReport.emailMonthly',
  lastEmailed: 'clientReport.lastEmailedMonth',
};

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };
const rangeOf = (ym: string) => { const [y, m] = ym.split('-').map(Number); return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) }; };
const prevOf = (ym: string) => { const [y, m] = ym.split('-').map(Number); return monthKey(new Date(y, m - 2, 1)); };
const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const splitEmails = (s: string) => String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/* --------------------------------- data --------------------------------- */

export interface ClientReportData {
  company: { name: string; logo: string; sector: string };
  month: string; monthLabel: string; preparedAt: string;
  spend: { total: number; totalPrev: number; meta: number; google: number; metaCampaigns: number; googleCampaigns: number; top: Array<{ campaign: string; source: string; amount: number }> };
  leads: { total: number; totalPrev: number; booked: number; bookedPrev: number; costPerLead: number | null; bySource: Array<{ source: string; n: number; booked: number }> };
  engagement: { posts: number; likes: number; comments: number; shares: number; prev: { posts: number; likes: number; comments: number; shares: number }; top: Array<{ id: string; text: string; imageUrl: string; likes: number; comments: number }> };
  audience: { accounts: Array<{ key: string; kind: string; name: string; followers: number | null; delta: number | null }>; netGrowth: number | null };
}

/** Aggregate the stored report figures for a month (runs in the current tenant). Serializable; no live integration calls. */
export async function clientReportData(month: string): Promise<ClientReportData> {
  if (!isMonth(month)) month = monthKey(new Date());
  const t = currentTenant();
  const { from, to } = rangeOf(month);
  const prevMonth = prevOf(month);
  const prevRange = rangeOf(prevMonth);

  const [spendRes, curPosts, prevPosts, allLeads, hist] = await Promise.all([
    getCampaignSpend().catch(() => ({ rows: [] as Array<{ campaign: string; month: string; amount: number; source?: string }> })),
    listPosts({ from: from.toISOString(), to: to.toISOString(), statuses: ['published'], limit: 200 }).catch(() => ({ posts: [] as any[] })),
    listPosts({ from: prevRange.from.toISOString(), to: prevRange.to.toISOString(), statuses: ['published'], limit: 200 }).catch(() => ({ posts: [] as any[] })),
    getAllLeads().then((r) => r.leads).catch(() => [] as any[]),
    followerHistory().catch(() => ({ accounts: [] as Array<{ key: string; kind: string; name: string; points: Array<{ month: string; followers: number }> }> })),
  ]);

  // spend
  const rows = spendRes.rows || [];
  const curSpend = rows.filter((r) => r.month === month);
  const prevSpend = rows.filter((r) => r.month === prevMonth);
  const sum = (rs: typeof rows, src?: string) => rs.filter((r) => !src || r.source === src).reduce((s, r) => s + num(r.amount), 0);

  // leads (reuse the same display-keyed data + enquiry-date / booked logic the authed report uses)
  const leads = allLeads as unknown as Lead[];
  const inRange = (l: Lead, a: Date, b: Date) => { const d = enquiryDate(l); return !!d && d >= a && d < b; };
  const leadsCur = leads.filter((l) => inRange(l, from, to));
  const leadsPrev = leads.filter((l) => inRange(l, prevRange.from, prevRange.to));
  const bySourceMap = new Map<string, { n: number; booked: number }>();
  for (const l of leadsCur) { const s = String((l as any)[F.SOURCE] || 'Other') || 'Other'; const row = bySourceMap.get(s) || { n: 0, booked: 0 }; row.n++; if (isBooked(l)) row.booked++; bySourceMap.set(s, row); }
  const spendTotal = sum(curSpend);

  // engagement
  const metric = (ps: any[], k: string) => ps.reduce((s, p) => s + num(p?.metrics?.[k]), 0);
  const cp = curPosts.posts || [], pp = prevPosts.posts || [];

  // audience (stored snapshots)
  const snapAt = (key: string, ym: string) => hist.accounts.find((a) => a.key === key)?.points.find((p) => p.month === ym)?.followers ?? null;
  let net = 0, hasNet = false;
  const accounts = hist.accounts.map((a) => {
    const cur = snapAt(a.key, month), prev = snapAt(a.key, prevMonth);
    const delta = cur != null && prev != null ? cur - prev : null;
    if (delta != null) { net += delta; hasNet = true; }
    return { key: a.key, kind: a.kind, name: a.name, followers: cur ?? (a.points.length ? a.points[a.points.length - 1].followers : null), delta };
  });

  return {
    company: { name: t?.name || 'Marketing Report', logo: t?.logo || '', sector: t?.sector || 'realestate' },
    month, monthLabel: monthLabel(month), preparedAt: new Date().toISOString(),
    spend: {
      total: spendTotal, totalPrev: sum(prevSpend), meta: sum(curSpend, 'meta'), google: sum(curSpend, 'google'),
      metaCampaigns: curSpend.filter((r) => r.source === 'meta').length, googleCampaigns: curSpend.filter((r) => r.source === 'google').length,
      top: curSpend.slice().sort((a, b) => num(b.amount) - num(a.amount)).slice(0, 10).map((r) => ({ campaign: r.campaign, source: r.source || '', amount: num(r.amount) })),
    },
    leads: {
      total: leadsCur.length, totalPrev: leadsPrev.length, booked: leadsCur.filter(isBooked).length, bookedPrev: leadsPrev.filter(isBooked).length,
      costPerLead: leadsCur.length ? Math.round(spendTotal / leadsCur.length) : null,
      bySource: [...bySourceMap.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.n - a.n).slice(0, 8),
    },
    engagement: {
      posts: cp.length, likes: metric(cp, 'likes'), comments: metric(cp, 'comments'), shares: metric(cp, 'shares'),
      prev: { posts: pp.length, likes: metric(pp, 'likes'), comments: metric(pp, 'comments'), shares: metric(pp, 'shares') },
      top: cp.slice().sort((a, b) => (num(b?.metrics?.likes) + num(b?.metrics?.comments)) - (num(a?.metrics?.likes) + num(a?.metrics?.comments))).slice(0, 4)
        .map((p) => ({ id: String(p.id), text: String(p.text || ''), imageUrl: String(p.imageUrl || ''), likes: num(p?.metrics?.likes), comments: num(p?.metrics?.comments) })),
    },
    audience: { accounts, netGrowth: hasNet ? net : null },
  };
}

/* ------------------------------ share link ------------------------------ */

const base = () => (process.env.APP_URL || '').trim().replace(/\/+$/, '');
const shareUrl = (slug: string, token: string) => (token ? `${base()}/r/${encodeURIComponent(slug)}/${token}` : '');

export interface ClientReportShare { enabled: boolean; emailMonthly: boolean; recipients: string[]; url: string; slug: string }

export async function getClientReportShare(_d: unknown, _ctx: Ctx): Promise<ClientReportShare> {
  const s = await settingsAll();
  const t = currentTenant();
  return { enabled: s[K.enabled] === '1', emailMonthly: s[K.email] === '1', recipients: splitEmails(s[K.recipients] || ''), url: shareUrl(t?.slug || '', s[K.token] || ''), slug: t?.slug || '' };
}

export async function setClientReportShare(d: any, ctx: Ctx): Promise<ClientReportShare> {
  const actor = ctx.user?.name || ctx.user?.email || 'System';
  const enabled = !!d?.enabled;
  const emailMonthly = !!d?.emailMonthly;
  const recipients = Array.isArray(d?.recipients) ? d.recipients : splitEmails(String(d?.recipients || ''));
  const clean = [...new Set(recipients.map((x: string) => x.trim().toLowerCase()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 20);
  if (emailMonthly && !clean.length) throw fail('VALIDATION', 'Add at least one client e-mail address to send the monthly report.');
  const s = await settingsAll();
  if (enabled && !s[K.token]) await settingSet(K.token, randomToken(24), actor); // mint a token the first time sharing is turned on
  await settingSet(K.enabled, enabled ? '1' : '', actor);
  await settingSet(K.email, emailMonthly ? '1' : '', actor);
  await settingSet(K.recipients, clean.join(', '), actor);
  return getClientReportShare({}, ctx);
}

export async function rotateClientReportShareToken(_d: unknown, ctx: Ctx): Promise<ClientReportShare> {
  await settingSet(K.token, randomToken(24), ctx.user?.name || ctx.user?.email || 'System');
  return getClientReportShare({}, ctx);
}

/** Verify a public share token (in the current tenant) and return the report, or throw NOT_FOUND. Used by /r/<slug>/<token>. */
export async function clientReportByToken(token: string, month: string): Promise<ClientReportData> {
  const s = await settingsAll();
  if (s[K.enabled] !== '1' || !s[K.token] || !token || token !== s[K.token]) throw fail('NOT_FOUND', 'This report link is not available.');
  return clientReportData(month);
}

/* ---------------------------- monthly e-mail ---------------------------- */

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function summaryText(r: ClientReportData, url: string): string {
  const d = r.spend.total - r.spend.totalPrev;
  const lines = [
    `${r.company.name} — Marketing Report`,
    r.monthLabel,
    '',
    `Ad spend: ${inr(r.spend.total)} (Meta ${inr(r.spend.meta)} · Google ${inr(r.spend.google)})${r.spend.totalPrev ? ` — ${d >= 0 ? '+' : ''}${inr(d)} vs last month` : ''}`,
    `New leads: ${r.leads.total}${r.leads.totalPrev ? ` (was ${r.leads.totalPrev})` : ''}`,
    `Bookings: ${r.leads.booked}`,
    r.leads.costPerLead != null ? `Cost per lead: ${inr(r.leads.costPerLead)}` : '',
    `Posts published: ${r.engagement.posts} · ${r.engagement.likes} likes · ${r.engagement.comments} comments`,
    r.audience.netGrowth != null ? `Follower growth: ${r.audience.netGrowth >= 0 ? '+' : ''}${r.audience.netGrowth}` : '',
    '',
    url ? `See the full report: ${url}?m=${r.month}` : '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * Once a month (per company), e-mail the previous month's report to the configured recipients. Best-effort, gated by
 * a stored "last emailed month" so a daily cron sends it at most once. Needs SMTP_URL + MAIL_FROM and sharing enabled
 * with the monthly e-mail turned on. Returns true if an e-mail was sent.
 */
export async function sendMonthlyClientReport(now = new Date()): Promise<boolean> {
  const s = await settingsAll();
  if (s[K.email] !== '1' || s[K.enabled] !== '1') return false;
  const recipients = splitEmails(s[K.recipients] || '');
  if (!recipients.length) return false;
  const smtp = process.env.SMTP_URL?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!smtp || !from) return false;
  const lastMonth = prevOf(monthKey(now)); // report the month that just ended
  if (s[K.lastEmailed] === lastMonth) return false; // already sent this month
  const t = currentTenant();
  const data = await clientReportData(lastMonth);
  const url = shareUrl(t?.slug || '', s[K.token] || '');
  const nodemailer = (await import('nodemailer')).default;
  await nodemailer.createTransport(smtp).sendMail({ from, to: recipients.join(', '), subject: `${data.company.name} — Marketing Report, ${data.monthLabel}`, text: summaryText(data, url) });
  await settingSet(K.lastEmailed, lastMonth, 'System');
  return true;
}

export const actions: ActionMap = {
  getClientReportShare: { fn: getClientReportShare, perm: 'reports.view' },
  setClientReportShare: { fn: setClientReportShare, perm: 'settings.edit' },
  rotateClientReportShareToken: { fn: rotateClientReportShareToken, perm: 'settings.edit' },
};
