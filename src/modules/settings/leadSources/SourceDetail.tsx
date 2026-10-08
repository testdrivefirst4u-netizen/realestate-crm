import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FlaskConical, KeyRound, ListChecks, Pause, Play, RefreshCw, RotateCcw, Save, Settings2, Trash2 } from 'lucide-react';
import type { InboundLogEntry, InboundStatus, LeadSource } from '../../../../server/core/leadSourceTypes';
import type { GoogleConnection, GoogleStatus } from '../../../../server/core/sheetTypes';
import { api } from '../../../core/api';
import { formatDateTime, formatDistance } from '../../../core/dates';
import { reportError, toAppError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { Badge, Button, ConfirmDialog, ErrorState, InlineNotice, Modal, Select, Tabs, cx, inputCls, labelCls } from '../../../components/ui';
import { ApiKeyPanel, CodeBlock, IntegrationGuide } from './IntegrationGuide';
import { SourceForm, SourceFormState, formStateFromSource, formToRequest } from './SourceForm';
import { SAMPLE_PAYLOAD, STATUS_OPTIONS, TYPE_LABEL, canRetry, parseSamplePayload, statusTone, usesApiKey } from './leadSourceUtils';
import { SheetSummary, syncSheetSource } from '../sheets/sheetSource';
import { FormFilterPicker, MetaLastError, MetaSourceActions, MetaSummary } from '../meta/MetaLeads';
import { formFilterFrom, formFilterToIds } from '../meta/metaUtils';
import { ListSkeleton } from '../../../components/Skeletons';

type DetailTab = 'settings' | 'test' | 'log' | 'guide';

export interface SourceDetailProps {
  source: LeadSource;
  canManage: boolean;
  stageOptions: string[];
  rmOptions: string[];
  initialTab?: DetailTab;
  onClose: () => void;
  onChanged: (s: LeadSource) => void;
  onDeleted: (id: string) => void;
  onOpenLead?: (id: string) => void;
  /** Platform Google status (Google Sheet imports). */
  google?: GoogleStatus | null;
  /** Connected Google accounts ("Connect with Google"). */
  connections?: GoogleConnection[] | null;
  /** After "Sync now" (reload the list for the new last-sync values). */
  onSynced?: () => void;
  /** Facebook login URL ("Reconnect" for a Meta Page whose connection expired). */
  metaConnectUrl?: string;
}

const errMsg = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const SourceDetail: React.FC<SourceDetailProps> = ({ source, canManage, stageOptions, rmOptions, initialTab = 'settings', onClose, onChanged, onDeleted, onOpenLead, google = null, connections = null, onSynced, metaConnectUrl }) => {
  const isSheet = source.type === 'google_sheet';
  const isMeta = source.type === 'meta';
  /** No API key: no integration guide, no key rotation and no sample-payload test. */
  const keyless = !usesApiKey(source.type);
  const [tab, setTab] = useState<DetailTab>(keyless && (initialTab === 'guide' || initialTab === 'test') ? 'settings' : initialTab);
  const [syncing, setSyncing] = useState(false);
  const [form, setForm] = useState<SourceFormState>(() => formStateFromSource(source));
  /** Meta Pages only: which lead forms create leads (config.meta.formIds; empty = all). */
  const [formFilter, setFormFilter] = useState(() => formFilterFrom(source.config?.meta));
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [freshKey, setFreshKey] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setForm(formStateFromSource(source));
    setFormFilter(formFilterFrom(source.config?.meta));
  }, [source]);

  const save = async () => {
    const req = formToRequest(form);
    const errors = [...req.errors];
    let config = req.config;
    if (isMeta) {
      const ff = formFilterToIds(formFilter);
      if (ff.error) errors.push(ff.error);
      // The server keeps the Page, token and status fields; only the form filter is changed here.
      if (source.config?.meta) config = { ...config, meta: { ...source.config.meta, formIds: ff.formIds } };
    }
    setFormErrors(errors);
    if (errors.length) return;
    setSaving(true);
    try {
      const updated = await api.leadSources.update(source.id, { name: req.name, config });
      onChanged(updated);
      toast('Lead source saved', updated.name, 'success');
    } catch (e) {
      toast('Could not save the lead source', errMsg('leadSources.update', e), 'alert');
    } finally {
      setSaving(false);
    }
  };

  const pausedText = isSheet
    ? 'The sheet is not read until you resume it.'
    : isMeta
      ? 'Leads from this Page are not added until you resume it.'
      : 'New submissions are rejected until you resume it.';

  const toggleStatus = async () => {
    const status = source.status === 'Active' ? 'Paused' : 'Active';
    setToggling(true);
    try {
      const updated = await api.leadSources.update(source.id, { status });
      onChanged(updated);
      toast(status === 'Paused' ? 'Source paused' : 'Source resumed', status === 'Paused' ? pausedText : 'Accepting leads again.', 'success');
    } catch (e) {
      toast('Could not change the status', errMsg('leadSources.status', e), 'alert');
    } finally {
      setToggling(false);
    }
  };

  const rotate = async () => {
    setRotating(true);
    try {
      const r = await api.leadSources.rotateKey(source.id);
      onChanged(r.source);
      setFreshKey(r.apiKey);
      setConfirmRotate(false);
      setTab('guide');
      toast('New API key created', 'The old key no longer works — update your website or webhook.', 'success');
    } catch (e) {
      toast('Could not rotate the key', errMsg('leadSources.rotateKey', e), 'alert');
    } finally {
      setRotating(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    if (await syncSheetSource(source)) onSynced?.();
    setSyncing(false);
  };

  const allTabs: Array<{ id: DetailTab; label: string; icon: React.ReactNode }> = [
    { id: 'settings', label: 'Settings', icon: <Settings2 size={13} /> },
    { id: 'test', label: 'Test mapping', icon: <FlaskConical size={13} /> },
    { id: 'log', label: 'Intake log', icon: <ListChecks size={13} /> },
    { id: 'guide', label: 'Integration guide', icon: <BookOpen size={13} /> },
  ];
  // A sheet import or a Meta Page has no API key: no integration guide and no sample-payload test.
  const tabs = keyless ? allTabs.filter((t) => t.id === 'settings' || t.id === 'log') : allTabs;
  const meta = source.config?.meta;
  const metaError = isMeta ? meta?.lastError || source.stats?.lastError || '' : '';

  return (
    <>
      <Modal
        open
        side
        onClose={onClose}
        title={source.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <Badge tone="navy">{TYPE_LABEL[source.type] || source.type}</Badge>
            <Badge tone={source.status === 'Active' ? 'sage' : 'amber'}>{source.status}</Badge>
            {!keyless && source.keyPrefix && <code className="font-mono text-[11px]">{source.keyPrefix}…</code>}
            <span>· {source.id}</span>
          </span>
        }
        footer={
          tab === 'settings' && canManage ? (
            <>
              <Button variant="ghost" onClick={() => { setForm(formStateFromSource(source)); setFormFilter(formFilterFrom(source.config?.meta)); setFormErrors([]); }}>Reset</Button>
              <Button variant="primary" icon={<Save size={13} />} loading={saving} onClick={save}>Save changes</Button>
            </>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button size="xs" icon={source.status === 'Active' ? <Pause size={12} /> : <Play size={12} />} loading={toggling} onClick={toggleStatus}>
                {source.status === 'Active' ? 'Pause' : 'Resume'}
              </Button>
              {isMeta ? (
                <MetaSourceActions source={source} onRefresh={() => onSynced?.()} onDisconnected={(id) => onDeleted(id)} />
              ) : (
                <>
                  {isSheet ? (
                    <Button size="xs" icon={<RefreshCw size={12} />} loading={syncing} onClick={syncNow}>Sync now</Button>
                  ) : (
                    <Button size="xs" icon={<KeyRound size={12} />} onClick={() => setConfirmRotate(true)}>Rotate key</Button>
                  )}
                  <Button size="xs" variant="danger" icon={<Trash2 size={12} />} onClick={() => setConfirmDelete(true)}>Delete</Button>
                </>
              )}
            </div>
          )}
          {source.status === 'Paused' && <InlineNotice tone="warning">This source is paused — {pausedText.charAt(0).toLowerCase()}{pausedText.slice(1)}</InlineNotice>}
          {isSheet && source.config?.sheet && (
            <div className="rounded-lg border border-[#D2C9BF] bg-white p-3">
              <SheetSummary sheet={source.config.sheet} connections={connections} />
            </div>
          )}
          {isMeta && (
            <div className="rounded-lg border border-[#D2C9BF] bg-white p-3 space-y-2">
              <MetaSummary meta={meta} lastReceivedAt={source.stats?.lastReceivedAt} />
              <MetaLastError message={metaError} connectUrl={metaConnectUrl} canManage={canManage} />
            </div>
          )}

          <Tabs<DetailTab> tabs={tabs} value={tab} onChange={setTab} />

          {tab === 'settings' && (
            <div className="space-y-3">
              {!canManage && <InlineNotice>You can view this source. Only administrators can change it.</InlineNotice>}
              {formErrors.length > 0 && (
                <div role="alert" className="p-3 rounded-lg border border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28] text-xs space-y-0.5">
                  {formErrors.map((e) => <div key={e}>{e}</div>)}
                </div>
              )}
              <SourceForm value={form} onChange={setForm} stageOptions={stageOptions} rmOptions={rmOptions} typeLocked disabled={!canManage || saving} idPrefix={`ls-edit-${source.id}`} google={google} connections={connections} />
              {isMeta && (
                <div>
                  <div className={labelCls}>Lead forms</div>
                  <p className="text-[10px] text-[#9E948D] mb-2">Which of the Page’s lead forms create leads. “All forms” includes forms you create later. Click “Check connection” to refresh the list.</p>
                  <FormFilterPicker forms={meta?.forms || []} value={formFilter} onChange={setFormFilter} idPrefix={`ls-edit-${source.id}-forms`} disabled={!canManage || saving} label="Lead forms" />
                </div>
              )}
              <div className="text-[10px] text-[#9E948D]">
                {isMeta && meta?.connectedAt
                  ? <>Connected {formatDateTime(meta.connectedAt, '—')}{meta.connectedBy ? ` by ${meta.connectedBy}` : ''}</>
                  : <>Created {formatDateTime(source.createdAt, '—')}{source.createdBy ? ` by ${source.createdBy}` : ''}</>}
                {isMeta && meta?.lastBackfillAt ? <> · last fetched {formatDateTime(meta.lastBackfillAt)}</> : null}
              </div>
            </div>
          )}

          {tab === 'test' && !keyless && <TestMapping sourceId={source.id} />}

          {tab === 'log' && <IntakeLog sourceId={source.id} canManage={canManage} onOpenLead={onOpenLead ? (id) => { onClose(); onOpenLead(id); } : undefined} />}

          {tab === 'guide' && !keyless && (
            <div className="space-y-4">
              {freshKey && <ApiKeyPanel apiKey={freshKey} />}
              <IntegrationGuide apiKey={freshKey || undefined} initialTab={source.type === 'webhook' ? 'zapier' : 'html'} redirectUrl={source.config?.allowedOrigins?.[0] ? `${source.config.allowedOrigins[0]}/thank-you` : undefined} />
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmRotate}
        title="Rotate the API key?"
        danger
        confirmLabel="Rotate key"
        loading={rotating}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={rotate}
        message={<>A new key is created and the old key <b>stops working immediately</b>. Forms and webhooks using it will fail until you update them with the new key.</>}
      />

      {confirmDelete && <DeleteDialog source={source} onCancel={() => setConfirmDelete(false)} onDeleted={() => { setConfirmDelete(false); onDeleted(source.id); }} />}
    </>
  );
};

/* ------------------------------ Delete ----------------------------------- */

const DeleteDialog: React.FC<{ source: LeadSource; onCancel: () => void; onDeleted: () => void }> = ({ source, onCancel, onDeleted }) => {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const match = typed.trim() === source.name.trim();
  const del = async () => {
    if (!match) return;
    setBusy(true);
    try {
      await api.leadSources.remove(source.id);
      toast('Lead source deleted', source.name, 'success');
      onDeleted();
    } catch (e) {
      toast('Could not delete the source', errMsg('leadSources.remove', e), 'alert');
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      width="sm"
      onClose={onCancel}
      title="Delete lead source?"
      footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="danger" disabled={!match} loading={busy} onClick={del} icon={<Trash2 size={13} />}>Delete source</Button></>}
    >
      <div className="space-y-3 text-sm text-[#3D3530]">
        <p>
          {source.type === 'google_sheet'
            ? 'The sheet is no longer read. The sheet itself is not changed, and leads it already created stay in the CRM.'
            : 'Its API key stops working at once and submissions to it are refused. Leads it already created stay in the CRM.'}
        </p>
        <div>
          <label htmlFor="ls-delete-confirm" className={labelCls}>Type <span className="normal-case font-mono text-[#1D2F3F]">{source.name}</span> to confirm</label>
          <input id="ls-delete-confirm" className={inputCls} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') del(); }} />
        </div>
      </div>
    </Modal>
  );
};

/* ---------------------------- Test mapping -------------------------------- */

const TestMapping: React.FC<{ sourceId: string }> = ({ sourceId }) => {
  const [text, setText] = useState(SAMPLE_PAYLOAD);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ lead: Record<string, string>; warnings: string[] } | null>(null);
  const run = async () => {
    const parsed = parseSamplePayload(text);
    if (!parsed.ok) {
      setError(parsed.error);
      setResult(null);
      return;
    }
    setError('');
    setBusy(true);
    try {
      setResult(await api.leadSources.preview(sourceId, parsed.payload));
    } catch (e) {
      setResult(null);
      setError(errMsg('leadSources.preview', e));
    } finally {
      setBusy(false);
    }
  };
  const entries = result ? Object.entries(result.lead).filter(([, v]) => String(v ?? '') !== '') : [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-[#6B5F57]">Paste a sample of what your form or service sends (JSON). Nothing is saved — this only shows how it would become a lead with the <b>saved</b> settings.</p>
      <div>
        <label htmlFor={`ls-test-${sourceId}`} className={labelCls}>Sample payload (JSON)</label>
        <textarea id={`ls-test-${sourceId}`} className={cx(inputCls, 'font-mono h-44')} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </div>
      <Button variant="primary" icon={<FlaskConical size={13} />} loading={busy} onClick={run}>Test mapping</Button>
      {error && <ErrorState compact title="Could not test the mapping" message={error} />}
      {result && (
        <div className="space-y-2">
          {result.warnings.length > 0 && (
            <InlineNotice tone="warning">
              <ul className="list-disc pl-4 space-y-0.5">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </InlineNotice>
          )}
          <div className="rounded-lg border border-[#D2C9BF] bg-white overflow-hidden">
            <div className="px-3 py-2 bg-[#EDE8E0] text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Lead fields</div>
            {entries.length === 0 ? (
              <div className="p-3 text-xs text-[#9E948D]">No lead fields were recognised.</div>
            ) : (
              <dl className="divide-y divide-[#ECE8E1] text-xs">
                {entries.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-3 py-2">
                    <dt className="font-semibold text-[#6B5F57]">{k}</dt>
                    <dd className="text-[#1D2F3F] break-words whitespace-pre-wrap">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ----------------------------- Intake log --------------------------------- */

export const IntakeLog: React.FC<{ sourceId?: string; canManage: boolean; onOpenLead?: (id: string) => void }> = ({ sourceId, canManage, onOpenLead }) => {
  const [status, setStatus] = useState<InboundStatus | ''>('');
  const [rows, setRows] = useState<InboundLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.leadSources.log({ sourceId, status, limit: 200 }));
      setError('');
    } catch (e) {
      setError(errMsg('leadSources.log', e));
    } finally {
      setLoading(false);
    }
  }, [sourceId, status]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = async (entry: InboundLogEntry) => {
    setRetrying(entry.id);
    try {
      const updated = await api.leadSources.retry(entry.id);
      setRows((prev) => (prev ? prev.map((r) => (r.id === entry.id ? updated : r)) : prev));
      if (updated.status === 'created' || updated.status === 'duplicate') toast('Submission processed', updated.leadId ? `Lead ${updated.leadId}` : updated.message, 'success');
      else toast('Still not accepted', updated.message || updated.status, 'warning');
    } catch (e) {
      toast('Retry failed', errMsg('leadSources.retry', e), 'alert');
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="w-44">
          <label htmlFor={`ls-log-status-${sourceId || 'all'}`} className={labelCls}>Status</label>
          <Select id={`ls-log-status-${sourceId || 'all'}`} value={status} options={STATUS_OPTIONS} placeholder="All statuses" onChange={(e) => setStatus(e.target.value as InboundStatus | '')} />
        </div>
        <Button size="sm" icon={<RefreshCw size={12} />} loading={loading} onClick={load}>Refresh</Button>
      </div>
      {error && <ErrorState compact message={error} onRetry={load} />}
      {!rows && loading && <ListSkeleton rows={4} label="Loading the intake log…" />}
      {rows && (
        <div className="overflow-x-auto rounded-lg border border-[#D2C9BF] bg-white">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#EDE8E0] border-b border-[#D2C9BF] text-[#6B5F57] uppercase font-bold tracking-wider text-[10px]">
                <th className="p-2.5 w-6"><span className="sr-only">Details</span></th>
                <th className="p-2.5">Time</th>
                <th className="p-2.5">Status</th>
                <th className="p-2.5">Lead</th>
                <th className="p-2.5">Message</th>
                <th className="p-2.5">Origin</th>
                <th className="p-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#ECE8E1]">
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="p-6 text-center text-[#9E948D]">{status ? 'No submissions with this status.' : 'No submissions received yet.'}</td></tr>
              ) : rows.map((r) => {
                const expanded = open === r.id;
                return (
                  <React.Fragment key={r.id}>
                    <tr className="align-top">
                      <td className="p-2.5">
                        <button className="text-[#6B5F57] hover:text-[#1D2F3F]" aria-expanded={expanded} aria-label={expanded ? 'Hide payload' : 'Show payload'} onClick={() => setOpen(expanded ? null : r.id)}>
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="p-2.5 whitespace-nowrap text-[#3D3530]" title={formatDateTime(r.receivedAt)}>{formatDateTime(r.receivedAt, '—')}</td>
                      <td className="p-2.5"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                      <td className="p-2.5 whitespace-nowrap">
                        {r.leadId ? (
                          onOpenLead ? <button className="font-mono text-[#A9825A] hover:underline font-semibold" onClick={() => onOpenLead(r.leadId)}>{r.leadId}</button> : <span className="font-mono">{r.leadId}</span>
                        ) : <span className="text-[#9E948D]">—</span>}
                      </td>
                      <td className="p-2.5 text-[#3D3530] max-w-[220px] break-words">{r.message || <span className="text-[#9E948D]">—</span>}{!sourceId && r.sourceName ? <div className="text-[10px] text-[#9E948D]">{r.sourceName}</div> : null}</td>
                      <td className="p-2.5 text-[#6B5F57] break-all max-w-[160px]">{r.origin || <span className="text-[#9E948D]">server</span>}</td>
                      <td className="p-2.5 text-right">
                        {canManage && canRetry(r.status) && (
                          <Button size="xs" icon={<RotateCcw size={11} />} loading={retrying === r.id} onClick={() => retry(r)}>Retry</Button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-[#FDFCFA]">
                        <td colSpan={7} className="p-3">
                          <div className="text-[10px] text-[#9E948D] mb-1.5">ID {r.id}{r.ip ? ` · IP ${r.ip}` : ''} · {formatDistance(r.receivedAt)}</div>
                          <CodeBlock code={JSON.stringify(r.payload || {}, null, 2)} label="Received payload" />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
