'use client';
/**
 * Database storage: each company's database size, which collections use the space, how much they grew per day,
 * and the largest records in a collection — to see what is making the database grow.
 */
import { Fragment, useEffect, useState } from 'react';
import { Database, HardDrive, RefreshCw, TrendingUp, Rows3, Building2 } from 'lucide-react';
import type { StorageCompany, StorageLargestItem } from '@/server/platform/contract';
import { call, useResource } from '../../_lib/api';
import { fmtDateTime, fmtNum } from '../../_lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorBox, PageHeader, StatCard, Table, TableSkeleton, cx, td, th } from '../../_components/ui';

/** What each collection holds, in words the team uses. */
const WHAT: Record<string, string> = {
  leads: 'Leads', archivedLeads: 'Deleted leads (archive)', activities: 'Lead timeline', events: 'Notifications & events',
  waMessages: 'WhatsApp messages', waContacts: 'WhatsApp contacts', chat360WebhookEvents: 'Chat360 webhook log', calls: 'Call history',
  'files.chunks': 'Uploaded files & call recordings (content)', 'files.files': 'Uploaded files & call recordings (list)',
  auditLogs: 'Audit log', errorLogs: 'Error log', sessions: 'Sign-in sessions', loginAttempts: 'Sign-in attempts', tasks: 'Tasks',
  units: 'Inventory units', documents: 'Documents', templates: 'Message templates', notes: 'Notes', checklistItems: 'Checklists',
  reportSnapshots: 'Report snapshots', projectLibrary: 'Project Library', libraryUploads: 'Library uploads in progress', users: 'Users',
  settings: 'Settings', secrets: 'Saved keys', counters: 'Number counters', meta: 'Background job markers', dropdownOptions: 'Dropdown options',
  inboundLog: 'Website / Meta lead log', leadSources: 'Lead sources', storageSnapshots: 'Storage history (this page)', jobRuns: 'Scheduled job runs',
  metaLeadQueue: 'Facebook lead queue', companies: 'Companies', platformAudit: 'Console audit log',
};

export function fmtBytes(n: number | null | undefined): string {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(v >= 104857600 ? 0 : 1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${Math.round(v)} B`;
}

/** "+1.2 MB" in amber when it grew, green when it shrank, "—" before there is history. */
function Growth({ bytes, records }: { bytes: number | null; records?: number | null }) {
  if (bytes === null) return <span className="text-[#98A2B3]" title="Shown from tomorrow: needs yesterday's snapshot to compare">—</span>;
  const tone = bytes > 0 ? 'text-[#B54708]' : bytes < 0 ? 'text-[#067647]' : 'text-[#5E778C]';
  return (
    <span className={cx('tabular-nums whitespace-nowrap', tone)}>
      {bytes > 0 ? '+' : bytes < 0 ? '−' : ''}{fmtBytes(bytes)}
      {records != null && records !== 0 && <span className="block text-[11.5px] text-[#5E778C]">{records > 0 ? '+' : '−'}{fmtNum(Math.abs(records))} records</span>}
    </span>
  );
}

function Sparkline({ points }: { points: Array<{ day: string; size: number }> }) {
  if (points.length < 2) return <span className="text-[11.5px] text-[#98A2B3]">builds up daily</span>;
  const w = 96, h = 26, max = Math.max(...points.map((p) => p.size)), min = Math.min(...points.map((p) => p.size));
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => (max === min ? h / 2 : h - 2 - ((v - min) / (max - min)) * (h - 4));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.size).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Size over ${points.length} days, from ${fmtBytes(points[0].size)} to ${fmtBytes(points[points.length - 1].size)}`}>
      <path d={`${d} L${w} ${h} L0 ${h} Z`} fill="#2E90FA" opacity="0.12" />
      <path d={d} fill="none" stroke="#1570EF" strokeWidth="1.6" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].size)} r="2.4" fill="#1570EF" />
    </svg>
  );
}

export function StorageClient() {
  const [refresh, setRefresh] = useState(0);
  const overview = useResource(() => call('storageOverview', { refresh: refresh > 0 }), [refresh]);
  const d = overview.data;
  const [picked, setPicked] = useState('');
  useEffect(() => {
    if (d && !picked && d.companies.length) setPicked((d.companies.find((c) => c.companyId !== 'platform') || d.companies[0]).companyId);
  }, [d, picked]);
  const company = d?.companies.find((c) => c.companyId === picked) || null;
  const biggest = d?.companies[0];

  return (
    <>
      <PageHeader eyebrow="Overview" icon={<Database className="h-6 w-6" />}
        title="Database storage"
        description="How much space each company's database uses, which collections take it, and how much they grow each day. A snapshot is taken daily; growth appears from the second day."
        actions={<Button variant="secondary" onClick={() => setRefresh((n) => n + 1)} loading={overview.loading && Boolean(d)} icon={<RefreshCw className="h-4 w-4" aria-hidden />}>Measure now</Button>}
      />
      <ErrorBox message={overview.error} onRetry={overview.reload} className="mb-4" />

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total size (all companies)" value={d ? fmtBytes(d.total.size) : '—'} note={d ? `${fmtBytes(d.total.storageSize)} on disk (compressed)` : undefined} icon={<HardDrive className="h-5 w-5" />} loading={!d} />
        <StatCard label="Grew since yesterday" value={d ? (d.total.growth1d === null ? '—' : `${d.total.growth1d >= 0 ? '+' : '−'}${fmtBytes(d.total.growth1d)}`) : '—'} note={d && d.total.growth1d === null ? 'Shown from the second day' : 'Data + indexes, all companies'} icon={<TrendingUp className="h-5 w-5" />} tone="amber" loading={!d} />
        <StatCard label="Records" value={d ? fmtNum(d.total.count) : '—'} note="Every document in every collection" icon={<Rows3 className="h-5 w-5" />} loading={!d} />
        <StatCard label="Biggest database" value={biggest ? biggest.name : '—'} note={biggest ? `${fmtBytes(biggest.size)}${biggest.topCollection ? ` · mostly ${WHAT[biggest.topCollection.name] || biggest.topCollection.name}` : ''}` : undefined} icon={<Building2 className="h-5 w-5" />} loading={!d} />
      </div>

      <Card className="mb-5">
        <CardHeader title="Companies" description={d ? `Measured ${fmtDateTime(d.checkedAt)}. Select a company to see its collections.` : 'Measuring…'} />
        {!d ? <TableSkeleton rows={4} cols={7} /> : !d.companies.length ? (
          <EmptyState icon={<Database className="h-6 w-6" />} title="Nothing measured yet" description="Select Measure now." />
        ) : (
          <Table label="Storage by company">
            <thead><tr><th className={th}>Company</th><th className={th}>Size</th><th className={th}>On disk</th><th className={th}>Records</th><th className={th}>Since yesterday</th><th className={th}>Last 7 days</th><th className={th}>Uses most</th><th className={th}>30 days</th></tr></thead>
            <tbody>
              {d.companies.map((c: StorageCompany) => (
                <tr key={c.companyId} onClick={() => setPicked(c.companyId)} className={cx('cursor-pointer border-t border-[#EEF2F6] hover:bg-[#F7FAFD]', picked === c.companyId && 'bg-[#EFF8FF]')}>
                  <td className={td}><button type="button" className="text-left font-semibold text-[#0B2A44] hover:underline" onClick={() => setPicked(c.companyId)}>{c.name}</button><span className="block text-[11.5px] text-[#5E778C]">{c.dbName} · {c.collections} collections</span></td>
                  <td className={cx(td, 'font-semibold tabular-nums')}>{fmtBytes(c.size)}</td>
                  <td className={cx(td, 'tabular-nums text-[#5E778C]')}>{fmtBytes(c.storageSize)}</td>
                  <td className={cx(td, 'tabular-nums')}>{fmtNum(c.count)}</td>
                  <td className={td}><Growth bytes={c.growth1d} records={c.records1d} /></td>
                  <td className={td}><Growth bytes={c.growth7d} /></td>
                  <td className={td}>{c.topCollection ? <><span className="font-medium">{WHAT[c.topCollection.name] || c.topCollection.name}</span><span className="block text-[11.5px] text-[#5E778C]">{fmtBytes(c.topCollection.size)} · {c.size ? Math.round((c.topCollection.size / c.size) * 100) : 0}%</span></> : '—'}</td>
                  <td className={td}><Sparkline points={c.series} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {company && <CompanyCollections key={company.companyId + refresh} company={company} />}
    </>
  );
}

function CompanyCollections({ company }: { company: StorageCompany }) {
  const res = useResource(() => call('storageCompany', { companyId: company.companyId }), [company.companyId]);
  const [open, setOpen] = useState('');
  const rows = res.data?.collections || [];
  const growing = rows.filter((r) => (r.growth1d || 0) > 0).sort((a, b) => (b.growth1d || 0) - (a.growth1d || 0)).slice(0, 3);
  return (
    <Card>
      <CardHeader title={`${company.name} · collections`} description={`What uses the space in ${company.dbName}, largest first. Select Largest records to see the biggest items in a collection.`} />
      <ErrorBox message={res.error} onRetry={res.reload} className="mx-5 mb-3" />
      {growing.length > 0 && (
        <div className="mx-5 mb-3 rounded-xl border border-[#FEDF89] bg-[#FFFAEB] px-4 py-2.5 text-[13.5px] text-[#93370D]">
          <strong className="font-semibold">Growing most since yesterday:</strong>{' '}
          {growing.map((g, i) => <span key={g.name}>{i ? ', ' : ''}{WHAT[g.name] || g.name} (+{fmtBytes(g.growth1d)})</span>)}
        </div>
      )}
      {!res.data ? <TableSkeleton rows={6} cols={7} /> : (
        <Table label={`Collections of ${company.name}`}>
          <thead><tr><th className={th}>Collection</th><th className={th}>Records</th><th className={th}>Size</th><th className={th}>Share</th><th className={th}>Avg record</th><th className={th}>Since yesterday</th><th className={th}>Last 7 days</th><th className={th} /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.name}>
                <tr className="border-t border-[#EEF2F6]">
                  <td className={td}><span className="font-semibold text-[#0B2A44]">{WHAT[r.name] || r.name}</span><span className="block font-mono text-[11.5px] text-[#5E778C]">{r.name}</span></td>
                  <td className={cx(td, 'tabular-nums')}>{fmtNum(r.count)}</td>
                  <td className={cx(td, 'tabular-nums font-semibold')}>{fmtBytes(r.size)}<span className="block text-[11.5px] font-normal text-[#5E778C]">data {fmtBytes(r.dataSize)} · index {fmtBytes(r.indexSize)}</span></td>
                  <td className={cx(td, 'min-w-[120px]')}>
                    <div className="h-2 w-full rounded-full bg-[#EEF2F6]" aria-hidden><div className="h-2 rounded-full bg-[#1570EF]" style={{ width: `${Math.max(r.share * 100, r.size ? 1.5 : 0)}%` }} /></div>
                    <span className="text-[11.5px] tabular-nums text-[#5E778C]">{(r.share * 100).toFixed(1)}%</span>
                  </td>
                  <td className={cx(td, 'tabular-nums text-[#5E778C]')}>{r.avgRecord ? fmtBytes(r.avgRecord) : '—'}</td>
                  <td className={td}><Growth bytes={r.growth1d} records={r.records1d} /></td>
                  <td className={td}><Growth bytes={r.growth7d} /></td>
                  <td className={cx(td, 'text-right')}>{r.count > 0 && <Button variant="secondary" size="sm" onClick={() => setOpen(open === r.name ? '' : r.name)}>{open === r.name ? 'Hide' : 'Largest records'}</Button>}</td>
                </tr>
                {open === r.name && (
                  <tr><td colSpan={8} className="bg-[#F7FAFD] px-5 py-3"><Largest companyId={company.companyId} collection={r.name} /></td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Largest({ companyId, collection }: { companyId: string; collection: string }) {
  const res = useResource(() => call('storageLargest', { companyId, collection }), [companyId, collection]);
  if (res.error) return <ErrorBox message={res.error} onRetry={res.reload} />;
  if (!res.data) return <p className="text-[13px] text-[#5E778C]">Finding the largest records…</p>;
  if (!res.data.length) return <p className="text-[13px] text-[#5E778C]">No records.</p>;
  return (
    <ol className="space-y-1 text-[13px]">
      {res.data.map((x: StorageLargestItem, i) => (
        <li key={x.id} className="flex flex-wrap items-baseline gap-x-3">
          <span className="w-5 text-right tabular-nums text-[#98A2B3]">{i + 1}</span>
          <span className="w-20 font-semibold tabular-nums text-[#0B2A44]">{fmtBytes(x.size)}</span>
          <span className="font-mono text-[12px] text-[#1570EF]">{x.id}</span>
          {x.label && <span className="text-[#344054]">{x.label}</span>}
          {x.at && <span className="text-[#98A2B3]">{fmtDateTime(x.at)}</span>}
        </li>
      ))}
    </ol>
  );
}
