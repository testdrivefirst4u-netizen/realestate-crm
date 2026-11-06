/**
 * Search Console, /searchconsole (server: modules/searchConsole.ts), laid out as in Google's: website selector and menu
 * on the left, Overview, Performance, URL inspection, Pages and Sitemaps. Parts: gscPerformance, gscIndexing, gscShared.
 */
import React, { useEffect, useState } from 'react';
import { BarChart3, ChevronRight, FileSearch, FileStack, Gauge, ListTree, Search, Settings } from 'lucide-react';
import { api, type IndexingSummary, type SearchPerformance, type SearchQuery } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { InlineNotice, cx, inputCls } from '../../components/ui';
import { InspectionPage, PagesPage, SitemapsPage } from './gscIndexing';
import { PerformancePage } from './gscPerformance';
import { compact, full, GscChart } from './gscShared';

type PageId = 'overview' | 'performance' | 'inspect' | 'pages' | 'sitemaps';
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const siteName = (s: string) => s.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');

const OverviewCard: React.FC<{ title: string; onOpen: () => void; children: React.ReactNode }> = ({ title, onOpen, children }) => (
  <section className="rounded-lg border border-[#DADCE0] bg-white">
    <div className="flex items-center gap-2 px-4 pt-3"><h2 className="min-w-0 flex-1 text-[15px] font-medium text-[#202124]">{title}</h2><button type="button" onClick={onOpen} className="inline-flex items-center gap-0.5 rounded px-2 py-1 text-xs font-medium text-[#1967D2] hover:bg-[#E8F0FE]">Full report <ChevronRight size={14} /></button></div>
    <div className="p-4 pt-2">{children}</div>
  </section>
);

const OverviewPage: React.FC<{ open: (p: PageId) => void; settingsLink: React.ReactNode }> = ({ open, settingsLink }) => {
  const [perf, setPerf] = useState<SearchPerformance | null>(null);
  const [pages, setPages] = useState<IndexingSummary | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let live = true;
    api.searchConsole.performance({ preset: 'last90' }).then((r) => { if (live) setPerf(r); }).catch((e) => { if (live) setFailed(errText('gsc.overview', e)); });
    api.searchConsole.indexing().then((r) => { if (live) setPages(r); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return (
    <div className="space-y-3">
      <h1 className="text-[22px] font-normal text-[#202124]">Overview</h1>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {perf?.error && <InlineNotice tone="warning">{perf.error} {settingsLink}</InlineNotice>}
      {!perf && !failed && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}
      {perf && !perf.error && perf.totals && (
        <OverviewCard title="Performance" onOpen={() => open('performance')}>
          <p className="mb-1 text-[13px] text-[#1A73E8]"><b className="font-medium">{compact(perf.totals.clicks)}</b> total web search clicks in the last 3 months</p>
          <GscChart days={perf.daily} selected={['clicks']} height={190} />
        </OverviewCard>
      )}
      {pages && !perf?.error && (
        <OverviewCard title="Indexing" onOpen={() => open('pages')}>
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-[13px] text-[#202124]">
            <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#9AA0A6]" /><b className="text-[18px] font-normal">{full(pages.notIndexed)}</b> not indexed pages</span>
            <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#137333]" /><b className="text-[18px] font-normal">{full(pages.indexed)}</b> indexed pages</span>
          </div>
          {!pages.total && <p className="mt-2 text-xs text-[#5F6368]">No pages checked yet. Open the report to check them.</p>}
        </OverviewCard>
      )}
    </div>
  );
};

export const SearchConsoleReport: React.FC<{ canCheck: boolean; canManage: boolean }> = ({ canCheck, canManage }) => {
  const [page, setPage] = useState<PageId>('overview');
  const [query, setQuery] = useState<SearchQuery>({ preset: 'last90', type: 'web', filters: [], compare: '' });
  const [sites, setSites] = useState<string[]>([]);
  const [site, setSite] = useState('');
  const [typed, setTyped] = useState('');
  const [inspected, setInspected] = useState('');
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (canManage) {
      api.searchConsole.get().then((v) => { setSites(v.sites); setSite(v.siteUrl); }).catch((e) => toast('Could not load Search Console', errText('gsc.get', e), 'alert'));
    } else {
      // the website is told by the report of those who cannot choose it
      api.searchConsole.sitemaps().then((v) => setSite(v.siteUrl)).catch(() => undefined);
    }
  }, [canManage]);

  const chooseSite = async (s: string) => {
    try {
      const v = await api.searchConsole.save(s);
      setSite(v.siteUrl);
      setInspected('');
      setTyped('');
      setRev((r) => r + 1);
    } catch (e) {
      toast('Website not changed', errText('gsc.save', e), 'alert');
    }
  };
  const inspect = (url: string) => {
    setTyped(url);
    setInspected(url);
    setPage('inspect');
  };
  const NAV: Array<{ group?: string; items: Array<{ id: PageId; label: string; icon: React.ReactNode }> }> = [
    { items: [{ id: 'overview', label: 'Overview', icon: <Gauge size={17} /> }, { id: 'performance', label: 'Performance', icon: <BarChart3 size={17} /> }, ...(canCheck ? [{ id: 'inspect' as PageId, label: 'URL inspection', icon: <FileSearch size={17} /> }] : [])] },
    { group: 'Indexing', items: [{ id: 'pages', label: 'Pages', icon: <FileStack size={17} /> }, { id: 'sitemaps', label: 'Sitemaps', icon: <ListTree size={17} /> }] },
  ];
  const settingsLink = canManage ? <a href="/settings?section=google" className="font-medium underline">Open Settings</a> : null;
  const siteControl = sites.length > 1 && canManage ? (
    <select className={cx(inputCls, 'truncate')} value={site} onChange={(e) => void chooseSite(e.target.value)} aria-label="Website">
      {!site && <option value="">Choose a website</option>}
      {sites.map((s) => <option key={s} value={s}>{siteName(s)}</option>)}
    </select>
  ) : site ? <p className="truncate rounded-lg border border-[#DADCE0] px-3 py-2 text-xs text-[#202124]" title={site}>{siteName(site)}</p> : null;

  return (
    <div className="flex min-h-full flex-col bg-[#F8F9FA] lg:flex-row">
      <nav aria-label="Search Console" className="hidden w-60 flex-none border-r border-[#DADCE0] bg-white py-3 pr-2 lg:block">
        <div className="mb-3 pl-3">{siteControl}</div>
        {NAV.map((g) => (
          <div key={g.group || 'top'} className="mb-1">
            {g.group && <h3 className="px-5 pb-1 pt-3 text-xs font-medium text-[#5F6368]">{g.group}</h3>}
            {g.items.map((i) => <button key={i.id} type="button" aria-current={page === i.id ? 'page' : undefined} onClick={() => setPage(i.id)} className={cx('flex w-full items-center gap-3.5 rounded-r-full py-2 pl-5 pr-3 text-left text-[13px]', page === i.id ? 'bg-[#E8F0FE] font-medium text-[#1967D2]' : 'text-[#3C4043] hover:bg-[#F1F3F4]')}>{i.icon}{i.label}</button>)}
          </div>
        ))}
        {settingsLink && <a href="/settings?section=google" className="mt-2 flex items-center gap-3.5 rounded-r-full border-t border-[#E8EAED] py-2.5 pl-5 pr-3 text-[13px] text-[#3C4043] hover:bg-[#F1F3F4]"><Settings size={17} />Settings</a>}
      </nav>

      <main className="min-w-0 flex-1">
        {canCheck && (
          <form className="border-b border-[#DADCE0] bg-white px-3 py-2 sm:px-5" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) inspect(typed.trim()); }}>
            <label className="relative block max-w-3xl">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5F6368]" />
              <input className="w-full rounded-lg border border-transparent bg-[#F1F3F4] py-2.5 pl-10 pr-3 text-[13px] text-[#202124] placeholder:text-[#5F6368] focus:border-[#1A73E8] focus:bg-white focus:outline-none" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`Inspect any URL in "${siteName(site) || 'your website'}"`} aria-label="Inspect a URL" />
            </label>
          </form>
        )}
        <div className="space-y-3 p-3 sm:p-5">
          <div className="grid gap-2 lg:hidden">
            {siteControl}
            <select className={inputCls} value={page} onChange={(e) => setPage(e.target.value as PageId)} aria-label="Report">
              {NAV.flatMap((g) => g.items).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </select>
          </div>
          <div key={rev}>
            {page === 'overview' && <OverviewPage open={setPage} settingsLink={settingsLink} />}
            {page === 'performance' && <PerformancePage query={query} onQuery={setQuery} settingsLink={settingsLink} />}
            {page === 'inspect' && <InspectionPage url={inspected} site={siteName(site)} />}
            {page === 'pages' && <PagesPage canCheck={canCheck} onInspect={inspect} />}
            {page === 'sitemaps' && <SitemapsPage settingsLink={settingsLink} />}
          </div>
        </div>
      </main>
    </div>
  );
};
