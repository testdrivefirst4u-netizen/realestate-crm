/**
 * Settings › Facebook sync — proof that every Facebook / Instagram lead reached the CRM.
 * Per Page: health, Facebook vs CRM per form (read live from Facebook), Sync now; the latest leads with how long
 * each took to arrive; failed webhook leads with Retry.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../../core/api';
import { reportError } from '../../core/errors';
import { formatDateTime, formatRelative } from '../../core/dates';
import type { MetaSyncPage, MetaSyncReport } from '../../../server/core/metaTypes';
import { Button, Card, EmptyState, InlineNotice, cx } from '../../components/ui';

const ago = (iso: string) => (iso ? formatRelative(iso) : 'never');
const delay = (s: number | null) => (s === null ? '—' : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`);

/** Overall state of a Page: what an admin needs to do, if anything. */
function pageState(p: MetaSyncPage): { ok: boolean; text: string } {
  if (p.status !== 'Active') return { ok: false, text: 'Paused — no leads are imported from this Page.' };
  if (!p.subscribed) return { ok: false, text: 'Not subscribed to new leads — press Check in Lead sources.' };
  if (p.lastError) return { ok: false, text: p.lastError };
  const missing = p.forms?.reduce((n, f) => n + f.missing7, 0) || 0;
  if (missing) return { ok: false, text: `${missing} lead${missing === 1 ? '' : 's'} from the last 7 days ${missing === 1 ? 'is' : 'are'} on Facebook but not in the CRM — press Sync now.` };
  return { ok: true, text: 'Receiving leads in real time.' };
}

export const MetaSyncSection: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const [report, setReport] = useState<MetaSyncReport | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (compare: boolean) => {
    setError(null);
    if (compare) setComparing(true);
    try {
      setReport(await api.meta.syncReport(compare));
    } catch (e) {
      setError(reportError('meta.sync', e).userMessage);
    }
    if (compare) setComparing(false);
  }, []);

  useEffect(() => {
    // quick report first, then the live Facebook comparison
    void load(false).then(() => load(true));
  }, [load]);

  const syncNow = async (sourceId: string) => {
    setBusy(sourceId);
    setNotice(null);
    try {
      const r = await api.meta.backfill(sourceId, 7);
      setNotice(`Sync finished: ${r.message}.`);
      await load(true);
    } catch (e) {
      setError(reportError('meta.backfill', e).userMessage);
    }
    setBusy(null);
  };

  const retry = async () => {
    setBusy('retry');
    setNotice(null);
    try {
      const r = await api.meta.retryLeads();
      setNotice(r.retried ? `${r.retried} lead${r.retried === 1 ? '' : 's'} retried: ${r.results.filter((x) => x.status === 'done').length} imported.` : 'Nothing to retry.');
      await load(false);
    } catch (e) {
      setError(reportError('meta.retry', e).userMessage);
    }
    setBusy(null);
  };

  if (!report && !error) return <Card title="Facebook sync"><p className="text-sm text-[#5E778C] py-4">Loading…</p></Card>;

  return (
    <div className="space-y-4">
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}
      {notice && <InlineNotice tone="success">{notice}</InlineNotice>}

      {report && !report.pages.length && (
        <Card title="Facebook sync">
          <EmptyState title="No Facebook Page connected" description="Connect a Page in Settings › Lead sources to receive Facebook and Instagram leads." />
        </Card>
      )}

      {report?.pages.map((p) => {
        const st = pageState(p);
        return (
          <Card
            key={p.sourceId}
            title={p.pageName || p.name}
            subtitle={<>Last lead {ago(p.lastLeadAt)} · backup check {ago(p.lastQuickSyncAt)} · daily check {ago(p.lastBackfillAt)}</>}
            actions={canEdit && p.status === 'Active' ? (
              <Button variant="primary" onClick={() => void syncNow(p.sourceId)} loading={busy === p.sourceId} disabled={!!busy && busy !== p.sourceId} icon={<RefreshCw size={13} />}>Sync now</Button>
            ) : undefined}
          >
            <div role="status" className={cx('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm mb-4', st.ok ? 'border-[#ABEFC6] bg-[#ECFDF3] text-[#067647]' : 'border-[#FEDF89] bg-[#FFFAEB] text-[#93370D]')}>
              {st.ok ? <CheckCircle2 size={17} className="mt-px flex-none" /> : <AlertTriangle size={17} className="mt-px flex-none" />}
              <span>{st.text}{p.recovered > 0 && <span className="block text-xs opacity-80 mt-0.5">The backup checks have recovered {p.recovered} lead{p.recovered === 1 ? '' : 's'} Facebook did not deliver instantly (last {ago(p.lastRecoveredAt)}).</span>}</span>
            </div>

            <h4 className="text-sm font-bold text-[#0B2A44] mb-2">Facebook vs CRM, per form</h4>
            {p.compareError && <InlineNotice tone="warning">Could not read the forms from Facebook: {p.compareError}</InlineNotice>}
            {!p.forms && !p.compareError && <p className="text-xs text-[#7E93A6] py-2">{comparing ? 'Reading the forms from Facebook…' : 'Not compared yet.'}</p>}
            {p.forms && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[#5E778C]">
                      <th scope="col" className="py-2 pr-3 font-semibold">Form</th>
                      <th scope="col" className="py-2 px-2 font-semibold text-right">Facebook today</th>
                      <th scope="col" className="py-2 px-2 font-semibold text-right">CRM today</th>
                      <th scope="col" className="py-2 px-2 font-semibold text-right">Facebook 7 days</th>
                      <th scope="col" className="py-2 px-2 font-semibold text-right">CRM 7 days</th>
                      <th scope="col" className="py-2 pl-2 font-semibold text-right">Missing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.forms.map((f) => (
                      <tr key={f.id} className="border-t border-[#E3EDF5]">
                        <td className="py-2 pr-3"><span className="font-medium text-[#0B2A44]">{f.name}</span>{f.status !== 'ACTIVE' && <span className="ml-1.5 text-[11px] text-[#7E93A6]">({f.status.toLowerCase()})</span>}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{f.fbToday}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{f.crmToday}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{f.fb7}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{f.crm7}</td>
                        <td className={cx('py-2 pl-2 text-right tabular-nums font-bold', f.missing7 ? 'text-[#B42318]' : 'text-[#067647]')}>{f.missing7}</td>
                      </tr>
                    ))}
                    {!p.forms.length && <tr><td colSpan={6} className="py-3 text-xs text-[#7E93A6]">No lead forms on this Page.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}

      {report && report.pages.length > 0 && (
        <Card title="Latest Facebook leads" subtitle="Newest first. Arrival time = from the moment the form was submitted to the moment the lead was in the CRM.">
          {!report.feed.length ? <p className="text-sm text-[#7E93A6]">No Facebook leads yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm border-collapse">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-[#5E778C]">
                    <th scope="col" className="py-2 pr-3 font-semibold">Received</th>
                    <th scope="col" className="py-2 px-2 font-semibold">Lead</th>
                    <th scope="col" className="py-2 px-2 font-semibold">Form · campaign</th>
                    <th scope="col" className="py-2 px-2 font-semibold">Result</th>
                    <th scope="col" className="py-2 pl-2 font-semibold text-right">Arrived in</th>
                  </tr>
                </thead>
                <tbody>
                  {report.feed.map((r, i) => (
                    <tr key={i} className="border-t border-[#E3EDF5] align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-[#5E778C]">{formatDateTime(r.at)}</td>
                      <td className="py-2 px-2"><span className="font-semibold text-[#0B6BB0]">{r.leadId || '—'}</span>{r.name && <span className="block text-xs text-[#5E778C]">{r.name}{r.platform ? ` · ${r.platform}` : ''}</span>}</td>
                      <td className="py-2 px-2 text-xs"><span className="block text-[#0B2A44]">{r.form || '—'}</span>{r.campaign && <span className="text-[#7E93A6]">{r.campaign}</span>}</td>
                      <td className="py-2 px-2 text-xs"><span className={cx('font-semibold', r.status === 'created' ? 'text-[#067647]' : r.status === 'duplicate' ? 'text-[#0B6BB0]' : 'text-[#B42318]')}>{r.status}</span>{r.status !== 'created' && r.message && <span className="block text-[#7E93A6]">{r.message}</span>}</td>
                      <td className="py-2 pl-2 text-right tabular-nums">{delay(r.delaySec)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {report && report.pages.length > 0 && (
        <Card
          title="Problems"
          subtitle="Webhook leads that failed, are being retried or were skipped in the last 7 days."
          actions={canEdit && report.problems.some((x) => x.status === 'failed' || x.status === 'dead') ? (
            <Button variant="secondary" onClick={() => void retry()} loading={busy === 'retry'} disabled={!!busy && busy !== 'retry'} icon={<RotateCcw size={13} />}>Retry failed</Button>
          ) : undefined}
        >
          {!report.problems.length ? (
            <p className="flex items-center gap-2 text-sm text-[#067647]"><CheckCircle2 size={16} />No problems — every webhook lead was imported.</p>
          ) : (
            <ul className="divide-y divide-[#E3EDF5] text-sm">
              {report.problems.map((x) => (
                <li key={x.id} className="py-2.5 flex flex-wrap gap-x-3 gap-y-1">
                  <span className={cx('text-xs font-bold uppercase', x.status === 'skipped' ? 'text-[#5E778C]' : 'text-[#B42318]')}>{x.status}</span>
                  <span className="font-mono text-xs text-[#5E778C]">{x.id}</span>
                  <span className="text-xs text-[#7E93A6]">{formatDateTime(x.receivedAt)}{x.attempts ? ` · ${x.attempts} attempt${x.attempts === 1 ? '' : 's'}` : ''}</span>
                  <span className="basis-full text-[#233B50]">{x.error || '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {report && <p className="text-xs text-[#7E93A6]">Checked {formatDateTime(report.checkedAt)} · <button type="button" className="underline min-h-[32px]" onClick={() => void load(true)}>Refresh</button></p>}
    </div>
  );
};
