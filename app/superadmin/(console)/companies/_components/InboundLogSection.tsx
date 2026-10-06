'use client';
import { Fragment, useId, useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, RefreshCw } from 'lucide-react';
import type { InboundLogEntry, InboundStatus, LeadSource } from '@/server/platform/contract';
import { call, useResource } from '../../../_lib/api';
import { fmtDateTimeSec } from '../../../_lib/format';
import { Button, Card, CardHeader, EmptyState, ErrorBox, Table, TableSkeleton, cx, focusRing, td, th, toolbarControl } from '../../../_components/ui';

const STATUS_LABELS: Record<InboundStatus, string> = { created: 'Created', duplicate: 'Duplicate', rejected: 'Rejected', failed: 'Failed' };
const STATUS_TONES: Record<InboundStatus, string> = {
  created: 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]',
  duplicate: 'bg-[#EFF4FF] text-[#3538CD] ring-[#C7D7FE]',
  rejected: 'bg-[#FFFAEB] text-[#B54708] ring-[#FEDF89]',
  failed: 'bg-[#FEF3F2] text-[#B42318] ring-[#FECDCA]',
};

export function InboundStatusBadge({ status }: { status: InboundStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12.5px] font-medium ring-1 ring-inset', STATUS_TONES[status] || STATUS_TONES.rejected)}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function PayloadViewer({ entry }: { entry: InboundLogEntry }) {
  const fields = Object.entries(entry.payload || {});
  return (
    <div className="space-y-3">
      {fields.length === 0 ? (
        <p className="text-[13.5px] text-[#7A6F64]">No fields were received.</p>
      ) : (
        <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[minmax(8rem,max-content)_1fr]">
          {fields.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="font-mono text-[#7A6F64]">{k}</dt>
              <dd className="min-w-0 break-words font-mono text-[#26211E]">{v === '' ? <span className="text-[#9A8F84]">(empty)</span> : v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      <p className="text-[12.5px] text-[#7A6F64]">
        Entry <span className="font-mono">{entry.id}</span>
        {entry.ip && (
          <>
            {' '}· IP <span className="font-mono">{entry.ip}</span>
          </>
        )}
        {' '}· The API key and honeypot are never stored.
      </p>
    </div>
  );
}

export function InboundLogSection({ companyId, sources }: { companyId: string; sources: LeadSource[] }) {
  const [sourceId, setSourceId] = useState('');
  const [status, setStatus] = useState<InboundStatus | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const uid = useId();
  const log = useResource(() => call('companyInboundLog', { companyId, sourceId: sourceId || undefined, status, limit: 200 }), [companyId, sourceId, status]);
  const rows = log.data || [];
  const filtered = Boolean(sourceId || status);

  return (
    <Card aria-labelledby={`${uid}-h`}>
      <CardHeader
        id={`${uid}-h`}
        title="Intake log"
        description="The latest 200 submissions received on this company's lead-source keys."
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw className={cx('h-3.5 w-3.5', log.loading && 'animate-spin')} aria-hidden />} onClick={log.reload} disabled={log.loading}>
            Refresh
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3 border-b border-[#EFE9E2] px-5 py-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-src`} className="text-[12.5px] font-medium text-[#3B342E]">
            Source
          </label>
          <select id={`${uid}-src`} className={cx(toolbarControl, 'w-56')} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-st`} className="text-[12.5px] font-medium text-[#3B342E]">
            Status
          </label>
          <select id={`${uid}-st`} className={cx(toolbarControl, 'w-44')} value={status} onChange={(e) => setStatus(e.target.value as InboundStatus | '')}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as InboundStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-1"
            onClick={() => {
              setSourceId('');
              setStatus('');
            }}
          >
            Clear filters
          </Button>
        )}
        <p className="ml-auto self-center text-[13px] text-[#7A6F64]" aria-live="polite">
          {log.loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`}
        </p>
      </div>

      <ErrorBox message={log.error} onRetry={log.reload} className="m-4" />
      {log.loading && !log.data ? (
        <TableSkeleton rows={5} cols={6} />
      ) : rows.length === 0 && !log.error ? (
        <EmptyState
          icon={<Inbox className="h-5 w-5" aria-hidden />}
          title={filtered ? 'No matching submissions' : 'Nothing received yet'}
          description={filtered ? 'Try another source or status.' : 'Submissions to any of this company’s lead-source keys will appear here.'}
        />
      ) : rows.length > 0 ? (
        <Table label="Intake log">
          <thead className="bg-[#FBF9F6]">
            <tr className="border-b border-[#EFE9E2]">
              <th scope="col" className={cx(th, 'w-10')}>
                <span className="sr-only">Details</span>
              </th>
              <th scope="col" className={th}>Time (IST)</th>
              <th scope="col" className={th}>Source</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Lead</th>
              <th scope="col" className={th}>Message</th>
              <th scope="col" className={th}>Origin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1ECE6]">
            {rows.map((r) => {
              const expanded = open === r.id;
              const panelId = `${uid}-p-${r.id}`;
              return (
                <Fragment key={r.id}>
                  <tr className={cx('hover:bg-[#FBF9F6]', expanded && 'bg-[#FBF9F6]')}>
                    <td className={cx(td, 'py-2 pr-0')}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        aria-label={`${expanded ? 'Hide' : 'Show'} payload of the ${fmtDateTimeSec(r.receivedAt)} submission`}
                        onClick={() => setOpen(expanded ? null : r.id)}
                        className={cx('rounded-md p-1 text-[#7A6F64] hover:bg-[#EFE9E2] hover:text-[#1D2F3F]', focusRing)}
                      >
                        {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      </button>
                    </td>
                    <td className={cx(td, 'whitespace-nowrap text-[13.5px] text-[#5E554D]')}>{fmtDateTimeSec(r.receivedAt)}</td>
                    <td className={cx(td, 'text-[13.5px]')}>
                      <span className="block max-w-[14rem] truncate" title={r.sourceName}>
                        {r.sourceName || r.sourceId}
                      </span>
                    </td>
                    <td className={td}>
                      <InboundStatusBadge status={r.status} />
                    </td>
                    <td className={cx(td, 'whitespace-nowrap font-mono text-[13px]')}>{r.leadId || '—'}</td>
                    <td className={cx(td, 'text-[13.5px] text-[#4A423B]')}>
                      <span className="block max-w-[22rem] break-words">{r.message || '—'}</span>
                    </td>
                    <td className={cx(td, 'text-[13px] text-[#5E554D]')}>
                      <span className="block max-w-[14rem] truncate font-mono" title={r.origin}>
                        {r.origin || '—'}
                      </span>
                    </td>
                  </tr>
                  {expanded && (
                    <tr id={panelId}>
                      <td colSpan={7} className="bg-[#FBF9F6] px-5 pb-4 pt-1">
                        <div className="rounded-lg border border-[#E4DCD2] bg-white px-4 py-3">
                          <PayloadViewer entry={r} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}
