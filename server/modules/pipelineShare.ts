/**
 * Pipeline dashboard data + a revocable public share link (no login). The aggregation is computed server-side and
 * used by both the in-app Pipeline screen and the public link, so they always match. No customer phone/e-mail is
 * included. The share link is a per-company token in settings behind an on/off flag — rotate or switch off to break it.
 */
import type { ActionMap } from '../core/actions';
import { type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { appUrl, settingSet, settingsAll } from '../core/settings';
import { currentTenant } from '../core/tenant';
import { randomToken, truncate } from '../core/utils';
import { getAllLeads } from './leads';

const S = CFG.STAGES;
const K = { enabled: 'pipeline.shareEnabled', token: 'pipeline.shareToken' };

export interface PipelineRow { label: string; count: number }
export interface PeriodStat { label: string; leads: number; bookings: number }
export interface PipelineData {
  company: string;
  generatedAt: string;
  kpis: { leads: number; qualified: number; siteVisits: number; bookings: number; bookingValue: number };
  /** YTD / MTD: this month vs last month, and the year to date. */
  mtd: PeriodStat;
  prevMonth: PeriodStat;
  ytd: PeriodStat;
  weeks: Array<{ label: string; count: number }>;
  byStage: PipelineRow[];
  bySource: PipelineRow[];
  byOwner: PipelineRow[];
  /** Why leads were lost — the disqualified / lost stages, with counts. */
  byDisqualReason: PipelineRow[];
}

const weekStart = (d: Date) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - day); return x; };
const tally = (m: Map<string, number>): PipelineRow[] => [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);

/** Aggregate the pipeline from the company's own leads + inventory. Read-only; no PII. */
export async function pipelineData(): Promise<PipelineData> {
  const leads = await (await col<any>(CFG.COLL.LEADS)).find({ stage: { $nin: [S.DELETED, S.TRASH] } }, { projection: { stage: 1, source: 1, assignedRm: 1, siteVisitStatus: 1, createdAt: 1, enquiryDate: 1 } }).toArray();
  const units = await (await col<any>(CFG.COLL.INVENTORY)).find({ status: { $in: ['Booked', 'Sold'] } }, { projection: { status: 1, quotedAmount: 1, price: 1 } }).toArray();

  const stage = new Map<string, number>(), source = new Map<string, number>(), owner = new Map<string, number>(), disq = new Map<string, number>();
  const weeks = Array.from({ length: 8 }, (_, i) => { const s = weekStart(new Date()); s.setDate(s.getDate() - (7 - i) * 7); return { start: s.getTime(), label: s.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), count: 0 }; });
  let qualified = 0, bookings = 0, siteVisits = 0;

  const now = new Date();
  const mKey = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  const thisMonth = mKey(now);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = mKey(lastMonthDate);
  const thisYear = String(now.getFullYear());
  const mL = (dt: Date) => dt.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const period = (label: string) => ({ label, leads: 0, bookings: 0 });
  const mtd = period(mL(now)), prevMonth = period(mL(lastMonthDate)), ytd = period(thisYear);

  for (const l of leads) {
    const st = String(l.stage || S.NEW) || S.NEW;
    const booked = st === S.BOOKED;
    bump(stage, st);
    bump(source, String(l.source || '').trim() || 'Unknown');
    bump(owner, String(l.assignedRm || '').trim() || 'Unassigned');
    if (st === S.QUALIFIED || st === S.HOT || st === S.BOOKED) qualified++;
    if (booked) bookings++;
    if (/complete|walk|visited|\bdone\b/i.test(String(l.siteVisitStatus || ''))) siteVisits++;
    if (/disqualif|lost/i.test(st)) bump(disq, st);
    const d0 = l.enquiryDate || l.createdAt;
    if (d0) {
      const dt = new Date(d0);
      const ws = weekStart(dt).getTime(); const w = weeks.find((x) => x.start === ws); if (w) w.count++;
      const mk = mKey(dt);
      if (mk === thisMonth) { mtd.leads++; if (booked) mtd.bookings++; }
      else if (mk === lastMonth) { prevMonth.leads++; if (booked) prevMonth.bookings++; }
      if (String(dt.getFullYear()) === thisYear) { ytd.leads++; if (booked) ytd.bookings++; }
    }
  }
  const bookingValue = units.reduce((s, u) => s + (Number(u.quotedAmount) || Number(u.price) || 0), 0);

  return {
    company: currentTenant()?.name || 'Company',
    generatedAt: new Date().toISOString(),
    kpis: { leads: leads.length, qualified, siteVisits, bookings, bookingValue },
    mtd, prevMonth, ytd,
    weeks: weeks.map((w) => ({ label: w.label, count: w.count })),
    byStage: tally(stage), bySource: tally(source), byOwner: tally(owner), byDisqualReason: tally(disq),
  };
}

/* ------------------------------ share link ------------------------------ */

const shareUrl = (slug: string, token: string) => (token ? `${appUrl()}/p/${encodeURIComponent(slug)}/${token}` : '');

export interface PipelineShare { enabled: boolean; url: string; slug: string }

export async function getPipelineShare(): Promise<PipelineShare> {
  const s = await settingsAll();
  const slug = currentTenant()?.slug || '';
  return { enabled: s[K.enabled] === '1', url: s[K.enabled] === '1' ? shareUrl(slug, s[K.token] || '') : '', slug };
}

export async function setPipelineShare(d: any, ctx: Ctx): Promise<PipelineShare> {
  const actor = ctx.user?.name || ctx.user?.email || 'System';
  const enabled = !!d?.enabled;
  const s = await settingsAll();
  if (enabled && !s[K.token]) await settingSet(K.token, randomToken(24), actor);
  await settingSet(K.enabled, enabled ? '1' : '', actor);
  return getPipelineShare();
}

export async function rotatePipelineShareToken(_d: unknown, ctx: Ctx): Promise<PipelineShare> {
  await settingSet(K.token, randomToken(24), ctx.user?.name || ctx.user?.email || 'System');
  return getPipelineShare();
}

function assertToken(s: Record<string, string>, token: string) {
  if (s[K.enabled] !== '1' || !s[K.token] || truncate(String(token || ''), 64) !== s[K.token]) throw fail('FORBIDDEN', 'This link is not active.');
}

/** Validate a public share token and return the pipeline data, or throw (link off / wrong token). */
export async function pipelineByToken(token: string): Promise<PipelineData> {
  assertToken(await settingsAll(), token);
  return pipelineData();
}

export interface PublicAnalytics { company: string; leads: any[]; sources: string[]; pipeline: PipelineData }

/**
 * The data behind the public, no-login dashboard tabs (Dashboard / Sales MIS / YTD-MTD / Pipeline). The real screens
 * render from this. Every lead is masked first: the customer's name is replaced with "Lead ####", and phone, e-mail
 * and notes are removed — so nothing personal leaves the CRM, only the analytics.
 */
export async function publicAnalyticsByToken(token: string): Promise<PublicAnalytics> {
  assertToken(await settingsAll(), token);
  const F = CFG.LEAD;
  const { leads } = await getAllLeads();
  const masked = leads.map((l: any) => ({ ...l, [F.NAME]: `Lead ${String(l[F.ID] || '').replace(/\D/g, '').slice(-4) || '—'}`, [F.PHONE]: '', [F.EMAIL]: '', [F.NOTES]: '' }));
  const sources = [...new Set(leads.map((l: any) => String(l[F.SOURCE] || '').trim()).filter(Boolean))].sort();
  return { company: currentTenant()?.name || 'Company', leads: masked, sources, pipeline: await pipelineData() };
}

export const actions: ActionMap = {
  getPipelineShare: { fn: () => getPipelineShare(), perm: 'reports.view' },
  setPipelineShare: { fn: (d, ctx) => setPipelineShare(d, ctx), perm: 'integrations.connect' },
  rotatePipelineShareToken: { fn: (d, ctx) => rotatePipelineShareToken(d, ctx), perm: 'integrations.connect' },
};
