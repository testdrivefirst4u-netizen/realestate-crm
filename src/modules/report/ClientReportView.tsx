/**
 * Client Report (/clientreport): a branded, printable monthly marketing report a company can show its clients.
 * Pulls together ad spend (Meta + Google), social content & engagement, audience/followers, Google Business Profile,
 * reviews, website analytics and leads/bookings for a chosen month. Fast sources (spend, posts, leads) show at once;
 * slow live sources (social insights, GBP, reviews, GA4) load in parallel and fall back gracefully when not connected.
 * "Download PDF" prints just the report via a print stylesheet. Read-only.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, Link2, RefreshCw, RotateCw, Star } from 'lucide-react';
import { api, type AnalyticsReport, type BusinessPerformance, type BusinessProfileData, type BusinessReviews, type ClientReportShareView, type FollowerAccount, type InsightsOverview, type SocialPost, type SpendRow } from '../../core/api';
import type { Lead } from '../../types/crm';
import { F } from '../../core/config';
import { enquiryDate, isBooked } from '../../core/analytics';
import { useCompany } from '../../core/tenant';
import { reportError, toAppError } from '../../core/errors';
import { Button, Card, KpiTile, cx } from '../../components/ui';

const errText = (s: string, e: unknown) => toAppError(reportError(s, e)).userMessage;
const nf = (n: number) => Math.round(n).toLocaleString('en-IN');
const inr = (n: number) => `₹${nf(n)}`;
const pct = (cur: number, prev: number): number | null => (prev ? Math.round(((cur - prev) / prev) * 100) : cur ? null : 0);
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthLabel = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };
const rangeOf = (ym: string) => { const [y, m] = ym.split('-').map(Number); return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) }; };
const prevOf = (ym: string) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 2, 1); return monthKey(d); };

const Delta: React.FC<{ v: number | null; suffix?: string }> = ({ v, suffix = '%' }) => {
  if (v === null) return <span className="text-[#0B6BB0]">new</span>;
  return <span className={cx('font-semibold', v > 0 ? 'text-emerald-600' : v < 0 ? 'text-[#B06A55]' : 'text-[#8296A6]')}>{v > 0 ? '▲' : v < 0 ? '▼' : '•'} {Math.abs(v)}{suffix}</span>;
};
/** A report section with a title; shows a loading line or a graceful "not connected" note. */
const Section: React.FC<{ title: string; hint?: string; loading?: boolean; empty?: string; children?: React.ReactNode }> = ({ title, hint, loading, empty, children }) => (
  <Card title={title} subtitle={hint} className="break-inside-avoid">
    {loading ? <p className="text-xs text-[#5E778C]">Loading…</p> : empty ? <p className="text-sm text-[#8296A6]">{empty}</p> : children}
  </Card>
);

type Slow<T> = { data: T | null; loading: boolean; error: string };
const slow0 = <T,>(): Slow<T> => ({ data: null, loading: true, error: '' });

export const ClientReportView: React.FC<{ leads: Lead[] }> = ({ leads }) => {
  const company = useCompany();
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [spend, setSpend] = useState<SpendRow[] | null>(null);
  const [posts, setPosts] = useState<{ cur: SocialPost[]; prev: SocialPost[] } | null>(null);
  const [insights, setInsights] = useState<Slow<InsightsOverview>>(slow0);
  const [gbp, setGbp] = useState<Slow<BusinessProfileData>>(slow0);
  const [reviews, setReviews] = useState<Slow<BusinessReviews>>(slow0);
  const [perf, setPerf] = useState<Slow<BusinessPerformance>>(slow0);
  const [web, setWeb] = useState<Slow<AnalyticsReport>>(slow0);
  const [followerHist, setFollowerHist] = useState<FollowerAccount[] | null>(null);
  const [snapping, setSnapping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<ClientReportShareView | null>(null);
  const [recipients, setRecipients] = useState('');
  const [shareErr, setShareErr] = useState('');
  const [savingShare, setSavingShare] = useState(false);
  const [copied, setCopied] = useState(false);

  const { from, to } = useMemo(() => rangeOf(month), [month]);
  const prevMonth = useMemo(() => prevOf(month), [month]);
  const prevRange = useMemo(() => rangeOf(prevMonth), [prevMonth]);

  // fast: posts for the chosen month and the previous one (metrics are stored on the doc)
  const loadFast = useCallback(async () => {
    try {
      const [cur, prev] = await Promise.all([
        api.posts.list({ from: from.toISOString(), to: to.toISOString(), statuses: ['published'], limit: 200 }),
        api.posts.list({ from: prevRange.from.toISOString(), to: prevRange.to.toISOString(), statuses: ['published'], limit: 200 }),
      ]);
      setPosts({ cur: cur.posts, prev: prev.posts });
    } catch { setPosts({ cur: [], prev: [] }); }
  }, [from, to, prevRange.from, prevRange.to]);

  // slow live sources — each fails to its own graceful fallback, never blocks the report
  const loadSlow = useCallback(() => {
    setInsights(slow0()); setGbp(slow0()); setReviews(slow0()); setPerf(slow0()); setWeb(slow0());
    api.posts.insights({ days: 30 }).then((d) => setInsights({ data: d, loading: false, error: '' })).catch((e) => setInsights({ data: null, loading: false, error: errText('report.insights', e) }));
    api.analytics.report({ report: 'snapshot', from: dayKey(from), to: dayKey(new Date(to.getTime() - 86400000)) }).then((d) => setWeb({ data: d, loading: false, error: '' })).catch((e) => setWeb({ data: null, loading: false, error: errText('report.web', e) }));
    api.businessProfile.performance({ preset: 'last28' }).then((d) => setPerf({ data: d, loading: false, error: '' })).catch((e) => setPerf({ data: null, loading: false, error: errText('report.perf', e) }));
    api.businessProfile.get({}).then((d) => {
      setGbp({ data: d, loading: false, error: d.error || '' });
      if (d.location && !d.error) api.businessProfile.reviews({ location: d.location }).then((r) => setReviews({ data: r, loading: false, error: r.error || '' })).catch((e) => setReviews({ data: null, loading: false, error: errText('report.reviews', e) }));
      else setReviews({ data: null, loading: false, error: 'Connect Google Business Profile to include reviews.' });
    }).catch((e) => { setGbp({ data: null, loading: false, error: errText('report.gbp', e) }); setReviews({ data: null, loading: false, error: 'Connect Google Business Profile to include reviews.' }); });
  }, [from, to]);

  const loadAll = useCallback(async () => { setBusy(true); try { await Promise.all([loadFast(), (async () => loadSlow())()]); } finally { setBusy(false); } }, [loadFast, loadSlow]);
  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => { api.team.spend().then((r) => setSpend(r.rows)).catch(() => setSpend([])); }, []);
  useEffect(() => { api.posts.followerHistory().then((r) => setFollowerHist(r.accounts)).catch(() => setFollowerHist([])); }, []);
  useEffect(() => { api.clientReport.share().then((s) => { setShare(s); setRecipients(s.recipients.join(', ')); }).catch((e) => setShareErr(errText('report.share', e))); }, []);

  // ---- derived figures ----
  const spendCur = useMemo(() => (spend || []).filter((r) => r.month === month), [spend, month]);
  const spendPrev = useMemo(() => (spend || []).filter((r) => r.month === prevMonth), [spend, prevMonth]);
  const sum = (rows: SpendRow[], src?: 'meta' | 'google') => rows.filter((r) => !src || r.source === src).reduce((t, r) => t + (r.amount || 0), 0);
  const spendTotal = sum(spendCur), spendTotalPrev = sum(spendPrev);

  const sumMetric = (ps: SocialPost[], k: 'likes' | 'comments' | 'shares') => ps.reduce((t, p) => t + (p.metrics?.[k] || 0), 0);
  const engCur = posts ? { posts: posts.cur.length, likes: sumMetric(posts.cur, 'likes'), comments: sumMetric(posts.cur, 'comments'), shares: sumMetric(posts.cur, 'shares') } : null;
  const engPrev = posts ? { posts: posts.prev.length, likes: sumMetric(posts.prev, 'likes'), comments: sumMetric(posts.prev, 'comments'), shares: sumMetric(posts.prev, 'shares') } : null;
  const topPosts = useMemo(() => (posts?.cur || []).slice().sort((a, b) => ((b.metrics?.likes || 0) + (b.metrics?.comments || 0)) - ((a.metrics?.likes || 0) + (a.metrics?.comments || 0))).slice(0, 4), [posts]);

  const leadsCur = useMemo(() => leads.filter((l) => { const d = enquiryDate(l); return d && d >= from && d < to; }), [leads, from, to]);
  const leadsPrev = useMemo(() => leads.filter((l) => { const d = enquiryDate(l); return d && d >= prevRange.from && d < prevRange.to; }), [leads, prevRange.from, prevRange.to]);
  const bookedCur = leadsCur.filter(isBooked).length, bookedPrev = leadsPrev.filter(isBooked).length;
  const bySource = useMemo(() => {
    const m = new Map<string, { n: number; booked: number }>();
    for (const l of leadsCur) { const s = String(l[F.SOURCE] || 'Other') || 'Other'; const row = m.get(s) || { n: 0, booked: 0 }; row.n++; if (isBooked(l)) row.booked++; m.set(s, row); }
    return [...m.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.n - a.n).slice(0, 8);
  }, [leadsCur]);

  const followers = (insights.data?.accounts || []).reduce((t, a) => t + (a.followers || 0), 0);
  // month-on-month follower growth from stored monthly snapshots (empty until the cron has run across two months)
  const snapAt = useCallback((key: string, ym: string): number | null => (followerHist || []).find((x) => x.key === key)?.points.find((p) => p.month === ym)?.followers ?? null, [followerHist]);
  const followerDelta = useCallback((key: string): number | null => { const c = snapAt(key, month), p = snapAt(key, prevMonth); return c != null && p != null ? c - p : null; }, [snapAt, month, prevMonth]);
  const followerGrowth = useMemo(() => {
    let net = 0, has = false;
    for (const a of followerHist || []) { const d = followerDelta(a.key); if (d != null) { net += d; has = true; } }
    return has ? net : null;
  }, [followerHist, followerDelta]);
  const rating = gbp.data?.rating?.average || null;
  const newReviews = (reviews.data?.reviews || []).filter((r) => { const d = new Date(r.createdAt); return d >= from && d < to; }).length;

  const emailsFrom = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const saveShare = async (patch: Partial<Pick<ClientReportShareView, 'enabled' | 'emailMonthly'>> & { recipients?: string }) => {
    if (!share) return;
    setSavingShare(true);
    try {
      const next = await api.clientReport.setShare({ enabled: patch.enabled ?? share.enabled, emailMonthly: patch.emailMonthly ?? share.emailMonthly, recipients: emailsFrom(patch.recipients ?? recipients) });
      setShare(next); setRecipients(next.recipients.join(', ')); setShareErr('');
    } catch (e) { setShareErr(errText('report.share.save', e)); } finally { setSavingShare(false); }
  };
  const rotateToken = async () => { setSavingShare(true); try { const n = await api.clientReport.rotateToken(); setShare(n); setShareErr(''); } catch (e) { setShareErr(errText('report.share.rotate', e)); } finally { setSavingShare(false); } };
  const shareLink = share?.url ? `${share.url}?m=${month}` : '';
  const copyLink = () => { if (shareLink && navigator.clipboard) navigator.clipboard.writeText(shareLink).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };

  const printPdf = () => window.print();
  const snapshotNow = async () => {
    setSnapping(true);
    try { const r = await api.posts.snapshotFollowersNow(); setFollowerHist(r.accounts); }
    catch (e) { reportError('report.snapshot', e); }
    finally { setSnapping(false); }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      {/* print rules: only #client-report prints, cleanly */}
      <style>{`@media print{body *{visibility:hidden!important}#client-report,#client-report *{visibility:visible!important}#client-report{position:absolute;left:0;top:0;width:100%}.no-print{display:none!important}#client-report .shadow-xs,#client-report [class*="shadow"]{box-shadow:none!important}}`}</style>

      <div className="no-print flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-bold text-[#0B2A44]">Client Report</h2>
          <p className="text-xs text-[#5E778C]">A branded monthly marketing summary to share with the client.</p>
        </div>
        <input type="month" value={month} max={monthKey(new Date())} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-[#D3E3F0] bg-white px-3 py-2 text-sm text-[#0B2A44] focus:border-[#0B6BB0] focus:outline-none" aria-label="Report month" />
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={busy ? 'animate-spin' : ''} />} disabled={busy} onClick={() => void loadAll()}>Refresh</Button>
        <Button variant="gold" size="sm" icon={<Download size={14} />} onClick={printPdf}>Download PDF</Button>
      </div>

      {/* Share with client — a revocable public link + optional monthly e-mail (not part of the printed report) */}
      {share && (
        <Card className="no-print" title="Share with client" subtitle="A no-login link clients can open, and an optional monthly e-mail. Turning sharing off or rotating the link blocks old links at once.">
          <label className="flex items-center gap-2.5 text-sm text-[#0B2A44]">
            <input type="checkbox" checked={share.enabled} disabled={savingShare} onChange={(e) => void saveShare({ enabled: e.target.checked })} className="h-4 w-4 rounded border-[#C4D6E6] text-[#0B6BB0] focus:ring-[#0B6BB0]" />
            <span className="font-semibold">Public share link</span>
            <span className="text-[#8296A6]">— anyone with the link can view this report</span>
          </label>

          {share.enabled && (
            <>
              {shareLink ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#D3E3F0] bg-[#F7FBFE] px-3 py-2">
                    <Link2 size={14} className="flex-none text-[#0B6BB0]" />
                    <span className="truncate font-mono text-[12px] text-[#44505C]">{shareLink}</span>
                  </div>
                  <Button variant="secondary" size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</Button>
                  <Button variant="secondary" size="sm" onClick={() => window.open(shareLink, '_blank', 'noopener')}>Open</Button>
                  <Button variant="secondary" size="sm" icon={<RotateCw size={13} className={savingShare ? 'animate-spin' : ''} />} disabled={savingShare} onClick={() => void rotateToken()}>Rotate link</Button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-[#8296A6]">A link will appear here once saved. (Set APP_URL for the full address.)</p>
              )}

              <label className="mt-4 flex items-center gap-2.5 text-sm text-[#0B2A44]">
                <input type="checkbox" checked={share.emailMonthly} disabled={savingShare} onChange={(e) => void saveShare({ emailMonthly: e.target.checked })} className="h-4 w-4 rounded border-[#C4D6E6] text-[#0B6BB0] focus:ring-[#0B6BB0]" />
                <span className="font-semibold">E-mail a monthly summary</span>
                <span className="text-[#8296A6]">— sent on the 1st for the month just ended</span>
              </label>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[#8296A6]">Client e-mail(s)</label>
                  <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="client@example.com, owner@example.com" className="w-full rounded-lg border border-[#D3E3F0] bg-white px-3 py-2 text-sm text-[#0B2A44] focus:border-[#0B6BB0] focus:outline-none" />
                </div>
                <Button variant="primary" size="sm" disabled={savingShare} onClick={() => void saveShare({})}>Save recipients</Button>
              </div>
            </>
          )}
          {shareErr && <p className="mt-2 text-xs text-[#B42318]">{shareErr}</p>}
        </Card>
      )}

      <div id="client-report" className="space-y-4">
        {/* branded header */}
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-[#D3E3F0] bg-white p-5">
          <div className="flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-xl bg-[#F2F7FB]">
            {company?.logo ? <img src={company.logo} alt="" className="max-h-full max-w-full object-contain p-1" /> : <span className="text-lg font-bold text-[#0B6BB0]">{(company?.name || 'C')[0]}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-[#0B2A44]">{company?.name || 'Marketing Report'}</h1>
            <p className="text-sm text-[#5E778C]">Marketing Report · <b>{monthLabel(month)}</b></p>
          </div>
          <div className="text-right text-[11px] text-[#8296A6]">Prepared {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        </div>

        {/* headline */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile compact tone="gold" label="Ad spend" value={inr(spendTotal)} trend={{ value: pct(spendTotal, spendTotalPrev) }} />
          <KpiTile compact tone="sage" label="Leads" value={nf(leadsCur.length)} trend={{ value: pct(leadsCur.length, leadsPrev.length) }} />
          <KpiTile compact label="Bookings" value={nf(bookedCur)} trend={{ value: pct(bookedCur, bookedPrev) }} />
          <KpiTile compact label="Followers" value={insights.loading ? '…' : nf(followers)} hint={followerGrowth != null ? `${followerGrowth >= 0 ? '+' : ''}${nf(followerGrowth)} this month` : 'current total'} />
          <KpiTile compact label="Rating" value={rating ? `${rating.toFixed(1)}★` : '—'} hint={reviews.data ? `${newReviews} new this month` : undefined} />
        </div>

        {/* audience */}
        <Section title="Audience" hint="Followers per connected account" loading={insights.loading} empty={insights.error && !insights.data ? 'Connect Instagram / Facebook to show audience growth.' : undefined}>
          <div className="grid gap-2 sm:grid-cols-2">
            {(insights.data?.accounts || []).map((a) => {
              const d = followerDelta(a.key);
              return (
                <div key={a.key} className="flex items-center justify-between rounded-lg border border-[#EEF3F7] px-3 py-2.5">
                  <span className="text-sm font-semibold capitalize text-[#0B2A44]">{a.name} <span className="font-normal text-[#8296A6]">· {a.kind}</span></span>
                  <span className="flex items-baseline gap-2">
                    {d != null && <span className={cx('text-[11px] font-semibold', d > 0 ? 'text-emerald-600' : d < 0 ? 'text-[#B06A55]' : 'text-[#8296A6]')}>{d > 0 ? '▲' : d < 0 ? '▼' : '•'} {d > 0 ? '+' : ''}{nf(d)}</span>}
                    <span className="text-lg font-bold tabular-nums text-[#0B2A44]">{a.followers != null ? nf(a.followers) : '—'}</span>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-[11px] text-[#8296A6]">{followerGrowth != null ? 'Change shown is month-on-month, from stored monthly snapshots.' : 'Follower growth is month-on-month and appears once snapshots span two months — captured monthly, or on demand below.'}</p>
            <Button className="no-print ml-auto" variant="secondary" size="sm" icon={<RefreshCw size={12} className={snapping ? 'animate-spin' : ''} />} disabled={snapping} onClick={() => void snapshotNow()}>{snapping ? 'Saving…' : "Snapshot today's followers"}</Button>
          </div>
        </Section>

        {/* content & engagement */}
        <Section title="Content & engagement" hint={monthLabel(month)}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {[['Posts', engCur?.posts, engPrev?.posts], ['Likes', engCur?.likes, engPrev?.likes], ['Comments', engCur?.comments, engPrev?.comments], ['Shares', engCur?.shares, engPrev?.shares]].map(([label, c, p]) => (
              <div key={label as string} className="rounded-lg border border-[#EEF3F7] p-3">
                <div className="text-xl font-bold tabular-nums text-[#0B2A44]">{c == null ? '…' : nf(c as number)}</div>
                <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#8296A6]">{label as string}</div>
                <div className="mt-1 text-[11px]"><Delta v={pct((c as number) || 0, (p as number) || 0)} /></div>
              </div>
            ))}
          </div>
          {topPosts.length > 0 && <>
            <p className="mb-2 mt-4 text-[11px] font-bold uppercase tracking-wide text-[#8296A6]">Top posts</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {topPosts.map((p) => (
                <div key={p.id} className="overflow-hidden rounded-lg border border-[#EEF3F7]">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="aspect-video w-full object-cover" /> : <div className="aspect-video w-full bg-[#F2F7FB]" />}
                  <div className="p-2"><p className="line-clamp-2 text-[11px] text-[#44505C]">{p.text || 'No caption'}</p><p className="mt-1 text-[11px] font-semibold text-[#0B2A44]">♥ {nf(p.metrics?.likes || 0)} · 💬 {nf(p.metrics?.comments || 0)}</p></div>
                </div>
              ))}
            </div>
          </>}
        </Section>

        {/* paid */}
        <Section title="Paid advertising — Meta & Google" hint={monthLabel(month)} empty={!spendCur.length ? 'No ad spend recorded for this month.' : undefined}>
          <div className="grid grid-cols-3 gap-2.5">
            <KpiTile compact tone="gold" label="Total spend" value={inr(spendTotal)} trend={{ value: pct(spendTotal, spendTotalPrev) }} />
            <KpiTile compact label="Meta" value={inr(sum(spendCur, 'meta'))} hint={`${nf(spendCur.filter((r) => r.source === 'meta').length)} campaigns`} />
            <KpiTile compact label="Google" value={inr(sum(spendCur, 'google'))} hint={`${nf(spendCur.filter((r) => r.source === 'google').length)} campaigns`} />
          </div>
          {spendCur.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead><tr className="border-b border-[#EEF3F7] text-left text-[11px] font-bold uppercase tracking-wide text-[#8296A6]"><th className="py-2">Campaign</th><th className="py-2">Platform</th><th className="py-2 text-right">Spend</th></tr></thead>
                <tbody>
                  {spendCur.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 12).map((r, i) => (
                    <tr key={i} className="border-b border-[#F3F7FA] last:border-0"><td className="py-2 font-medium text-[#0B2A44]">{r.campaign}</td><td className="py-2 capitalize text-[#5E778C]">{r.source || '—'}</td><td className="py-2 text-right tabular-nums font-semibold text-[#0B2A44]">{inr(r.amount || 0)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[11px] text-[#8296A6]">Cost per lead this month: <b className="text-[#0B2A44]">{leadsCur.length ? inr(spendTotal / leadsCur.length) : '—'}</b></p>
        </Section>

        {/* leads */}
        <Section title="Leads & bookings" hint={monthLabel(month)}>
          <div className="grid grid-cols-3 gap-2.5">
            <KpiTile compact tone="sage" label="New leads" value={nf(leadsCur.length)} trend={{ value: pct(leadsCur.length, leadsPrev.length) }} />
            <KpiTile compact label="Bookings" value={nf(bookedCur)} trend={{ value: pct(bookedCur, bookedPrev) }} />
            <KpiTile compact label="Conversion" value={`${leadsCur.length ? Math.round((bookedCur / leadsCur.length) * 100) : 0}%`} />
          </div>
          {bySource.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[360px] text-sm">
                <thead><tr className="border-b border-[#EEF3F7] text-left text-[11px] font-bold uppercase tracking-wide text-[#8296A6]"><th className="py-2">Source</th><th className="py-2 text-right">Leads</th><th className="py-2 text-right">Bookings</th></tr></thead>
                <tbody>
                  {bySource.map((r) => (<tr key={r.source} className="border-b border-[#F3F7FA] last:border-0"><td className="py-2 font-medium text-[#0B2A44]">{r.source}</td><td className="py-2 text-right tabular-nums">{nf(r.n)}</td><td className="py-2 text-right tabular-nums font-semibold text-[#067647]">{nf(r.booked)}</td></tr>))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* GBP */}
        <Section title="Google Business Profile" hint="Last 28 days" loading={perf.loading} empty={perf.error && !perf.data ? 'Connect Google Business Profile to include this.' : undefined}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {[['Profile views', perf.data?.totals?.views], ['Calls', perf.data?.totals?.calls], ['Directions', perf.data?.totals?.directions], ['Website clicks', perf.data?.totals?.website]].map(([label, v]) => (
              <div key={label as string} className="rounded-lg border border-[#EEF3F7] p-3"><div className="text-xl font-bold tabular-nums text-[#0B2A44]">{v == null ? '—' : nf(v as number)}</div><div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#8296A6]">{label as string}</div></div>
            ))}
          </div>
          {rating && <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-[#0B2A44]"><Star size={15} className="fill-[#F5A524] text-[#F5A524]" /> <b>{rating.toFixed(1)}</b> average · {nf(gbp.data?.rating?.total || 0)} reviews{reviews.data ? ` · ${newReviews} new this month` : ''}</p>}
        </Section>

        {/* website */}
        <Section title="Website" hint={monthLabel(month)} loading={web.loading} empty={web.error && !web.data ? 'Connect Website Analytics to include this.' : undefined}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {Object.entries(web.data?.totals || {}).slice(0, 4).map(([k, v]) => {
              const m = (web.data?.metrics || []).find((x) => x.id === k);
              return <div key={k} className="rounded-lg border border-[#EEF3F7] p-3"><div className="text-xl font-bold tabular-nums text-[#0B2A44]">{nf(v)}</div><div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#8296A6]">{m?.label || k}</div></div>;
            })}
          </div>
        </Section>

        <p className="pt-1 text-center text-[11px] text-[#8296A6]">Prepared by {company?.name || 'your team'} · Figures are for {monthLabel(month)} unless noted. Live figures (followers, Google, website) are as fetched today.</p>
      </div>
    </div>
  );
};
