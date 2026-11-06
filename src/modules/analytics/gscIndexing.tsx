/**
 * Search Console › URL inspection, Pages and Sitemaps, laid out as in Google's. Google gives no total of indexed pages
 * and no history through its API, so Pages counts the pages checked one by one and has no chart over time.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Search, XCircle } from 'lucide-react';
import { api, type IndexingSummary, type SearchSitemap, type UrlInspection } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';
import { full } from './gscShared';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const longDate = (s: string) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const words = (s: string) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'N/A');
const INDEXING: Record<string, string> = { INDEXING_ALLOWED: 'Yes', BLOCKED_BY_META_TAG: "No: 'noindex' in the page's meta tag", BLOCKED_BY_HTTP_HEADER: "No: 'noindex' in the HTTP header", BLOCKED_BY_ROBOTS_TXT: 'No: blocked by robots.txt' };
const ROBOTS: Record<string, string> = { ALLOWED: 'Yes', DISALLOWED: 'No: blocked by robots.txt' };
const CRAWLED: Record<string, string> = { MOBILE: 'Googlebot smartphone', DESKTOP: 'Googlebot desktop' };

export const InspectionPage: React.FC<{ url: string; site: string }> = ({ url, site }) => {
  const [result, setResult] = useState<UrlInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!url) return;
    let live = true;
    setBusy(true);
    setResult(null);
    setFailed('');
    api.searchConsole.inspect(url)
      .then((r) => { if (live) setResult(r); })
      .catch((e) => { if (live) setFailed(errText('gsc.inspect', e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [url]);
  const on = result?.verdict === 'PASS';
  const row = (label: string, value: React.ReactNode) => <div className="grid gap-0.5 border-t border-[#F1F3F4] py-2 sm:grid-cols-[210px_1fr]"><dt className="text-xs text-[#5F6368]">{label}</dt><dd className="min-w-0 break-words text-[13px] text-[#202124]">{value}</dd></div>;
  const list = (items: string[]) => (items.length ? items.map((s) => <span key={s} className="block break-all">{s}</span>) : 'None detected');
  return (
    <div className="space-y-3">
      <h1 className="text-[22px] font-normal text-[#202124]">URL inspection</h1>
      {!url && <p className="rounded-lg border border-[#DADCE0] bg-white p-8 text-center text-[13px] text-[#5F6368]">Enter a full address of {site || 'your website'} in the box at the top to see what Google knows about it.</p>}
      {busy && <p className="rounded-lg border border-[#DADCE0] bg-white p-8 text-center text-[13px] text-[#5F6368]">Asking Google…</p>}
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {result && (
        <>
          <p className="break-all text-xs text-[#5F6368]">{result.url}</p>
          <section className="rounded-lg border border-[#DADCE0] bg-white p-4">
            <div className="flex items-start gap-3">
              {on ? <CheckCircle2 size={28} className="flex-none text-[#137333]" /> : <XCircle size={28} className="flex-none text-[#5F6368]" />}
              <div className="min-w-0">
                <h2 className="text-[18px] font-normal text-[#202124]">{on ? 'URL is on Google' : 'URL is not on Google'}</h2>
                <p className="mt-0.5 text-[13px] text-[#5F6368]">{on ? 'It can appear in Google search results.' : 'This page is not in Google\'s index, so it will not appear in search results.'}</p>
              </div>
              {result.link && <a href={result.link} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex flex-none items-center gap-1 text-xs font-medium text-[#1967D2] hover:underline">Open in Google <ExternalLink size={12} /></a>}
            </div>
          </section>
          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 p-4 text-left">
              {on ? <CheckCircle2 size={18} className="flex-none text-[#137333]" /> : <XCircle size={18} className="flex-none text-[#5F6368]" />}
              <span className="min-w-0 flex-1"><b className="block text-[13px] font-medium text-[#202124]">Page indexing</b><span className="block text-xs text-[#5F6368]">{result.coverage || words(result.verdict)}</span></span>
              <ChevronDown size={18} className={cx('flex-none text-[#5F6368] transition-transform', open && 'rotate-180')} />
            </button>
            {open && (
              <dl className="px-4 pb-3">
                <h3 className="pb-1 pt-1 text-xs font-medium text-[#202124]">Discovery</h3>
                {row('Sitemaps', list(result.sitemaps))}
                {row('Referring pages', list(result.referrers))}
                <h3 className="pb-1 pt-3 text-xs font-medium text-[#202124]">Crawl</h3>
                {row('Last crawl', result.lastCrawl ? new Date(result.lastCrawl).toLocaleString() : 'N/A')}
                {row('Crawled as', CRAWLED[result.crawledAs] || words(result.crawledAs))}
                {row('Crawl allowed?', ROBOTS[result.robots] || words(result.robots))}
                {row('Page fetch', words(result.pageFetch))}
                {row('Indexing allowed?', INDEXING[result.indexing] || words(result.indexing))}
                <h3 className="pb-1 pt-3 text-xs font-medium text-[#202124]">Indexing</h3>
                {row('User-declared canonical', result.userCanonical || 'None')}
                {row('Google-selected canonical', result.googleCanonical || 'N/A')}
              </dl>
            )}
          </section>
          <p className="text-[11px] text-[#5F6368]">Test live URL and Request indexing are only available in Google's own tool. Use Open in Google for those.</p>
        </>
      )}
    </div>
  );
};

export const PagesPage: React.FC<{ canCheck: boolean; onInspect: (url: string) => void }> = ({ canCheck, onInspect }) => {
  const [data, setData] = useState<IndexingSummary | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [more, setMore] = useState(false);
  const [view, setView] = useState<{ kind: 'reason' | 'indexed' | 'all'; reason?: string }>({ kind: 'all' });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    api.searchConsole.indexing().then(setData).catch((e) => setFailed(errText('gsc.indexing', e)));
  }, []);
  useEffect(() => setPage(0), [view, q]);
  const check = async () => {
    setBusy(true);
    try {
      const r = await api.searchConsole.checkIndexing();
      setData(r);
      setNote(r.note);
      setMore(r.more);
      toast(`${r.justChecked} page${r.justChecked === 1 ? '' : 's'} checked`, undefined, r.justChecked ? 'success' : 'info');
    } catch (e) {
      toast('Could not check pages', errText('gsc.check', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  const rows = (data?.rows || []).filter((r) => {
    if (view.kind === 'indexed' && !(r.checkedAt && !r.error && r.verdict === 'PASS')) return false;
    if (view.kind === 'reason' && !(r.checkedAt && !r.error && r.verdict !== 'PASS' && (r.coverage || 'Reason not given') === view.reason)) return false;
    return !q.trim() || r.url.toLowerCase().includes(q.trim().toLowerCase());
  });
  const perPage = 25;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const at = Math.min(page, pages - 1);
  const checked = data ? data.indexed + data.notIndexed : 0;
  const heading = view.kind === 'indexed' ? 'Indexed pages' : view.kind === 'reason' ? view.reason : 'All listed pages';
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-normal text-[#202124]">Page indexing</h1>
        {data?.lastChecked && <span className="text-[11px] text-[#5F6368]">Last checked {longDate(data.lastChecked)}</span>}
        {canCheck && <Button variant="primary" size="sm" loading={busy} icon={<RefreshCw size={13} />} onClick={() => void check()}>{more ? 'Check more pages' : 'Check pages'}</Button>}
      </header>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {note && <InlineNotice tone="warning">{note}</InlineNotice>}
      {!data && !failed && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}
      {data && (
        <>
          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-t-lg">
              <button type="button" onClick={() => setView({ kind: 'all' })} className="bg-[#5F6368] p-3 text-left text-white hover:brightness-110"><span className="block text-xs">Not indexed</span><span className="mt-1 block text-[26px] leading-tight">{full(data.notIndexed)}</span><span className="block text-[11px] text-white/90">pages</span></button>
              <button type="button" onClick={() => setView({ kind: 'indexed' })} className="bg-[#137333] p-3 text-left text-white hover:brightness-110"><span className="block text-xs">Indexed</span><span className="mt-1 block text-[26px] leading-tight">{full(data.indexed)}</span><span className="block text-[11px] text-white/90">pages</span></button>
            </div>
            <div className="p-4">
              {checked > 0 ? (
                <div className="flex h-3 gap-0.5 overflow-hidden rounded" role="img" aria-label={`${data.indexed} indexed, ${data.notIndexed} not indexed`}>
                  {data.notIndexed > 0 && <i className="bg-[#9AA0A6]" style={{ flex: data.notIndexed }} />}
                  {data.indexed > 0 && <i className="bg-[#137333]" style={{ flex: data.indexed }} />}
                </div>
              ) : <p className="text-[13px] text-[#5F6368]">No pages checked yet.{canCheck ? ' Click Check pages to start.' : ''}</p>}
              <p className="mt-2 text-[11px] text-[#5F6368]">
                {data.unchecked > 0 ? `${full(data.unchecked)} of ${full(data.total)} listed pages are not checked yet. ` : ''}
                {data.failed > 0 ? `${full(data.failed)} could not be checked and will be tried again. ` : ''}
                Counted from the pages in your sitemaps, checked one by one (about 2,000 a day, {full(data.usedToday)} used today), so this can differ from Google's own Pages report. Google gives no history, so there is no chart over time.
              </p>
            </div>
          </section>

          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <h2 className="px-4 pb-2 pt-3 text-[15px] font-medium text-[#202124]">Why pages aren't indexed</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr className="border-y border-[#E8EAED] text-[11.5px] text-[#5F6368]"><th scope="col" className="px-4 py-2 text-left font-medium">Reason</th><th scope="col" className="px-4 py-2 text-right font-medium">Pages</th></tr></thead>
                <tbody className="divide-y divide-[#F1F3F4]">
                  {!data.reasons.length ? <tr><td colSpan={2} className="p-6 text-center text-[13px] text-[#5F6368]">Nothing to show</td></tr> : data.reasons.map((r) => (
                    <tr key={r.reason} className={cx('text-[13px] text-[#202124] hover:bg-[#F8F9FA]', view.reason === r.reason && 'bg-[#E8F0FE]')}>
                      <td className="px-4 py-2.5"><button type="button" className="text-left hover:text-[#1967D2] hover:underline" onClick={() => setView({ kind: 'reason', reason: r.reason })}>{r.reason}</button></td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{full(r.pages)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={() => setView({ kind: 'indexed' })} className="flex w-full items-center gap-2 border-t border-[#E8EAED] px-4 py-3 text-left text-[13px] font-medium text-[#1967D2] hover:bg-[#F8F9FA]"><CheckCircle2 size={16} className="text-[#137333]" /> View data about indexed pages <ChevronRight size={15} className="ml-auto" /></button>
          </section>

          {data.total > 0 && (
            <section className="rounded-lg border border-[#DADCE0] bg-white">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <h2 className="min-w-0 flex-1 text-[15px] font-medium text-[#202124]">{heading}</h2>
                {view.kind !== 'all' && <button type="button" className="text-xs font-medium text-[#1967D2] hover:underline" onClick={() => setView({ kind: 'all' })}>Show all</button>}
                <input className={cx(inputCls, 'w-full py-1.5 sm:w-56')} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter pages" aria-label="Filter pages" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse">
                  <thead><tr className="border-y border-[#E8EAED] text-left text-[11.5px] text-[#5F6368]"><th scope="col" className="px-4 py-2 font-medium">URL</th><th scope="col" className="px-3 py-2 font-medium">Status</th><th scope="col" className="px-3 py-2 font-medium">Last crawled</th>{canCheck && <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Inspect</span></th>}</tr></thead>
                  <tbody className="divide-y divide-[#F1F3F4]">
                    {!rows.length ? <tr><td colSpan={4} className="p-6 text-center text-[13px] text-[#5F6368]">No pages</td></tr> : rows.slice(at * perPage, (at + 1) * perPage).map((r) => (
                      <tr key={r.url} className="text-[13px] text-[#202124] hover:bg-[#F8F9FA]">
                        <td className="max-w-[380px] truncate px-4 py-2" title={r.url}>{r.url}</td>
                        <td className="px-3 py-2 text-xs">{r.error ? <span className="text-[#A50E0E]" title={r.error}>Could not check</span> : !r.checkedAt ? <span className="text-[#5F6368]">Not checked yet</span> : r.verdict === 'PASS' ? <span className="font-medium text-[#137333]">Indexed</span> : <span>{r.coverage || 'Not indexed'}</span>}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs">{longDate(r.lastCrawl)}</td>
                        {canCheck && <td className="px-2 py-1"><button type="button" aria-label={`Inspect ${r.url}`} title="Inspect URL" onClick={() => onInspect(r.url)} className="rounded-full p-2 text-[#5F6368] hover:bg-[#F1F3F4]"><Search size={14} /></button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-end gap-2 px-3 py-2 text-xs text-[#5F6368]">
                {data.total > data.rows.length && <span className="mr-auto">Showing the first {full(data.rows.length)} of {full(data.total)} pages.</span>}
                <span className="tabular-nums">{rows.length ? `${at * perPage + 1}-${Math.min(rows.length, (at + 1) * perPage)} of ${full(rows.length)}` : '0 of 0'}</span>
                <button type="button" aria-label="Previous page" disabled={at === 0} onClick={() => setPage(at - 1)} className="rounded-full p-2 hover:bg-[#F1F3F4] disabled:opacity-30"><ChevronLeft size={16} /></button>
                <button type="button" aria-label="Next page" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} className="rounded-full p-2 hover:bg-[#F1F3F4] disabled:opacity-30"><ChevronRight size={16} /></button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
};

export const SitemapsPage: React.FC<{ settingsLink: React.ReactNode }> = ({ settingsLink }) => {
  const [data, setData] = useState<{ sitemaps: SearchSitemap[]; sitemapsError: string; error: string } | null>(null);
  const [failed, setFailed] = useState('');
  const load = useCallback(() => {
    api.searchConsole.sitemaps().then(setData).catch((e) => setFailed(errText('gsc.sitemaps', e)));
  }, []);
  useEffect(() => load(), [load]);
  const status = (s: SearchSitemap) => (s.pending ? <span className="text-[#5F6368]">Pending</span> : s.errors > 0 ? <span className="font-medium text-[#A50E0E]">{full(s.errors)} error{s.errors === 1 ? '' : 's'}</span> : s.warnings > 0 ? <span className="font-medium text-[#B06000]">{full(s.warnings)} warning{s.warnings === 1 ? '' : 's'}</span> : <span className="font-medium text-[#137333]">Success</span>);
  return (
    <div className="space-y-3">
      <h1 className="text-[22px] font-normal text-[#202124]">Sitemaps</h1>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {data?.error && <InlineNotice tone="warning">{data.error} {settingsLink}</InlineNotice>}
      {data?.sitemapsError && <InlineNotice tone="warning">{data.sitemapsError}</InlineNotice>}
      {!data && !failed && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}
      {data && !data.error && (
        <section className="rounded-lg border border-[#DADCE0] bg-white">
          <h2 className="px-4 pb-2 pt-3 text-[15px] font-medium text-[#202124]">Submitted sitemaps</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse">
              <thead><tr className="border-y border-[#E8EAED] text-left text-[11.5px] text-[#5F6368]"><th scope="col" className="px-4 py-2 font-medium">Sitemap</th><th scope="col" className="px-3 py-2 font-medium">Type</th><th scope="col" className="px-3 py-2 font-medium">Submitted</th><th scope="col" className="px-3 py-2 font-medium">Last read</th><th scope="col" className="px-3 py-2 font-medium">Status</th><th scope="col" className="px-4 py-2 text-right font-medium">Discovered pages</th></tr></thead>
              <tbody className="divide-y divide-[#F1F3F4]">
                {!data.sitemaps.length ? <tr><td colSpan={6} className="p-8 text-center text-[13px] text-[#5F6368]">No sitemap submitted to Google for this website</td></tr> : data.sitemaps.map((s) => (
                  <tr key={s.path} className="text-[13px] text-[#202124]">
                    <td className="max-w-[320px] truncate px-4 py-2.5" title={s.path}>{s.path}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{s.type}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{longDate(s.lastSubmitted)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{longDate(s.lastDownloaded)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{status(s)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{full(s.submitted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="text-[11px] text-[#5F6368]">Sitemaps are added in Google's own Search Console. This connection is read only.</p>
    </div>
  );
};
