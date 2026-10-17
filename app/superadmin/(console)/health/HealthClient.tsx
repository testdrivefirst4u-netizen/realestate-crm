'use client';
import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import type { HealthJob } from '@/server/platform/contract';
import { call, useResource } from '../../_lib/api';
import { fmtDateTime } from '../../_lib/format';
import { Button, Card, CardHeader, ErrorBox, PageHeader, Table, TableSkeleton, cx, td, th } from '../../_components/ui';

const STATUS: Record<HealthJob['status'], { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]' },
  late: { label: 'Late', cls: 'bg-[#FFFAEB] text-[#93370D] ring-[#FEDF89]' },
  failing: { label: 'Failing', cls: 'bg-[#FEF3F2] text-[#B42318] ring-[#FECDCA]' },
  never: { label: 'Never ran', cls: 'bg-[#EEF4F9] text-[#3F5A70] ring-[#DCE8F2]' },
};

const every = (min: number) => (min >= 1440 ? 'Daily' : min >= 60 ? `Every ${min / 60} h` : `Every ${min} min`);
const ms = (n: number) => (n >= 60000 ? `${Math.round(n / 6000) / 10} min` : n >= 1000 ? `${Math.round(n / 100) / 10} s` : `${n} ms`);

/** A rejected call after the last good run = the scheduler is calling with a wrong CRON_SECRET. */
const rejectedRecently = (j: HealthJob) => !!j.lastRejectedAt && (!j.lastOkAt || j.lastRejectedAt > j.lastOkAt);

export function HealthClient() {
  const health = useResource(() => call('platformHealth', {}), []);
  const { reload } = health;
  useEffect(() => {
    const t = setInterval(reload, 60000);
    return () => clearInterval(t);
  }, [reload]);
  const d = health.data;
  const problems = d ? d.jobs.filter((j) => j.status !== 'ok' || rejectedRecently(j)).length + (d.metaQueue.failed ? 1 : 0) : 0;

  return (
    <>
      <PageHeader
        title="Platform health"
        description="Scheduled jobs, the Facebook lead queue and the latest errors of every company. Refreshes every minute."
        actions={<Button variant="secondary" onClick={reload} loading={health.loading && Boolean(d)} icon={<RefreshCw className="h-4 w-4" aria-hidden />}>Refresh</Button>}
      />
      <ErrorBox message={health.error} onRetry={reload} className="mb-4" />

      {d && (
        <div role="status" className={cx('mb-5 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-[14px]', problems ? 'border-[#FEDF89] bg-[#FFFAEB] text-[#93370D]' : 'border-[#ABEFC6] bg-[#ECFDF3] text-[#067647]')}>
          <span className={cx('h-2.5 w-2.5 rounded-full', problems ? 'bg-[#F79009]' : 'bg-[#12B76A]')} aria-hidden />
          <strong className="font-semibold">{problems ? `${problems} thing${problems === 1 ? '' : 's'} need attention` : 'All systems running normally'}</strong>
          <span className="text-[13px] opacity-80">Checked {fmtDateTime(d.checkedAt)}</span>
        </div>
      )}

      <Card className="mb-5">
        <CardHeader title="Scheduled jobs" description="Called by GitHub Actions / Vercel Cron with the CRON_SECRET. Late = two runs missed in a row." />
        {!d ? <TableSkeleton rows={4} cols={6} /> : (
          <Table label="Scheduled jobs">
            <thead>
              <tr><th className={th}>Job</th><th className={th}>Expected</th><th className={th}>Last run</th><th className={th}>Result</th><th className={th}>Status</th></tr>
            </thead>
            <tbody className="divide-y divide-[#E3EDF5]">
              {d.jobs.map((j) => (
                <tr key={j.id} className={j.status === 'ok' && !rejectedRecently(j) ? '' : 'bg-[#FFFCF5]'}>
                  <td className={td}>
                    <div className="font-semibold">{j.label}</div>
                    <div className="font-mono text-[12px] text-[#5E778C]">{j.path}</div>
                  </td>
                  <td className={td}>{every(j.everyMin)}</td>
                  <td className={td}>
                    {j.lastRunAt ? fmtDateTime(j.lastRunAt) : '—'}
                    {j.lastRunAt && <div className="text-[12px] text-[#5E778C]">took {ms(j.durationMs)}</div>}
                  </td>
                  <td className={cx(td, 'max-w-[380px]')}>
                    <div className="truncate" title={j.lastError || j.summary}>{j.lastError || j.summary || '—'}</div>
                    {rejectedRecently(j) && (
                      <div className="mt-1 text-[12px] font-medium text-[#B42318]">
                        Calls are being rejected (last {fmtDateTime(j.lastRejectedAt)}): the scheduler&rsquo;s CRON_SECRET does not match the server&rsquo;s.
                      </div>
                    )}
                  </td>
                  <td className={td}>
                    <span className={cx('inline-flex rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset', STATUS[j.status].cls)}>{STATUS[j.status].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title="Facebook lead queue" description="Leads received by the webhook, waiting to be fetched." />
          {!d ? <TableSkeleton rows={1} cols={3} /> : (
            <div className="grid grid-cols-3 gap-3 p-5 text-center">
              {([['Waiting', d.metaQueue.pending], ['Failed', d.metaQueue.failed], ['Delivered · 24 h', d.metaQueue.done24h]] as const).map(([label, n]) => (
                <div key={label} className={cx('rounded-lg border p-3', label === 'Failed' && n ? 'border-[#FECDCA] bg-[#FEF3F2]' : 'border-[#E3EDF5]')}>
                  <div className="text-[22px] font-semibold text-[#0B2A44]">{n}</div>
                  <div className="text-[12px] text-[#5E778C]">{label}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Latest errors · all companies" description="From each company's error log, newest first." />
          {!d ? <TableSkeleton rows={5} cols={3} /> : !d.errors.length ? (
            <p className="p-5 text-[14px] text-[#5E778C]">No errors recorded.</p>
          ) : (
            <ol className="max-h-[420px] divide-y divide-[#E3EDF5] overflow-y-auto">
              {d.errors.map((e, i) => (
                <li key={i} className="px-5 py-3 text-[14px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-[#EEF4F9] px-1.5 py-0.5 font-mono text-[11px] text-[#16466E]">{e.code || 'ERROR'}</span>
                    <span className="font-medium">{e.company}</span>
                    <span className="text-[12px] text-[#5E778C]">{fmtDateTime(e.at)} · {e.scope}</span>
                  </div>
                  <p className="mt-1 break-words text-[#233B50]">{e.message}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
