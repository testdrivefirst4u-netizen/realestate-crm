/**
 * Settings › Google Sheets — access (connected Google accounts / platform service account), sheet imports
 * (lead sources of type 'google_sheet') and exports.
 * Plan feature `googleSheets`; viewing needs `settings.view`, managing `settings.edit` (the server enforces both).
 * Returning from "Connect with Google": `?googleConnected=<id>` or `?googleError=<message>` (read by App, passed in here).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, ExternalLink, FileSpreadsheet, KeyRound, Lock, LogIn, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Unplug, Upload, UserRound } from 'lucide-react';
import type { LeadSource } from '../../../../server/core/leadSourceTypes';
import type { GoogleConnection, GoogleStatus, SheetExport } from '../../../../server/core/sheetTypes';
import { api } from '../../../core/api';
import { formatDateTime, formatDistance } from '../../../core/dates';
import { reportError, toAppError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { useFeature } from '../../../core/tenant';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, InlineNotice, LoadingState } from '../../../components/ui';
import type { CanFn } from '../types';
import { CopyButton } from '../leadSources/IntegrationGuide';
import { ExportDialog } from './ExportDialog';
import { NOT_CONFIGURED_TEXT } from './SheetImportFields';
import { SheetSummary, syncSheetSource } from './sheetSource';
import { authLabel, googleErrorText, intervalLabel, isConnectionInUse, sheetsAccessConfigured, spreadsheetHref } from './sheetUtils';
import { useGoogleConnections, useGoogleStatus } from './useGoogleStatus';

export interface GoogleSheetsSectionProps {
  can: CanFn;
  /** Switch to Settings › Lead sources. */
  onOpenLeadSources?: () => void;
  /** Connection id from a finished "Connect with Google" (`?googleConnected=`). */
  googleConnected?: string | null;
  /** Why "Connect with Google" did not finish (`?googleError=`). */
  googleError?: string | null;
  /** The Google part of the settings link has been taken over. */
  onGoogleLinkConsumed?: () => void;
}

const errMsg = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const GoogleSheetsSection: React.FC<GoogleSheetsSectionProps> = (props) => {
  const enabled = useFeature('googleSheets');
  if (!props.can('settings.view')) return null;
  if (!enabled) {
    return (
      <Card title="Google Sheets">
        <EmptyState
          icon={<Lock size={22} />}
          title="Not included in your plan"
          description="Importing leads from Google Sheets and exporting leads to Google Sheets are not part of your company’s plan — ask your platform administrator to enable them."
        />
      </Card>
    );
  }
  return <GoogleSheetsScreen {...props} />;
};

/** "Connect with Google" is a full-page navigation (Google consent, then back to /settings). */
function goToConnect(url: string) {
  if (url) window.location.assign(url);
}

const GoogleSheetsScreen: React.FC<GoogleSheetsSectionProps> = ({ can, onOpenLeadSources, googleConnected, googleError, onGoogleLinkConsumed }) => {
  const canManage = can('settings.edit');
  const google = useGoogleStatus(true);
  const oauth = !!google.status?.oauthConfigured;
  const conns = useGoogleConnections(oauth);
  const accessOk = sheetsAccessConfigured(google.status);
  /** Bumped after a forced disconnect (imports/exports were paused) to reload both lists. */
  const [reloadToken, setReloadToken] = useState(0);

  // Return from "Connect with Google": a success notice once the list (with the new account) is loaded, or the error.
  const [justConnected, setJustConnected] = useState<string | null>(googleConnected || null);
  const [connectNotice, setConnectNotice] = useState('');
  const [connectError, setConnectError] = useState(() => googleErrorText(googleError));
  useEffect(() => {
    if (googleConnected || googleError) onGoogleLinkConsumed?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!justConnected || !google.status) return;
    if (oauth && conns.connections === null && !conns.error) return; // still loading
    const c = (conns.connections || []).find((x) => x.id === justConnected);
    setConnectNotice(c ? `Google account connected: ${c.email}` : 'Google account connected');
    toast('Google account connected', c?.email || undefined, 'success');
    setJustConnected(null);
  }, [justConnected, google.status, oauth, conns.connections, conns.error]);

  const reloadAll = () => {
    google.reload();
    conns.reload();
  };
  const connectUrl = canManage && google.status?.oauthConfigured ? google.status.connectUrl : '';

  return (
    <div className="space-y-4">
      <Card
        title="Access to your sheets"
        subtitle="How the CRM opens your Google Sheets. Each import and export chooses one of these."
        actions={<Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={google.loading || conns.loading} onClick={reloadAll} aria-label="Refresh Google Sheets access" />}
      >
        <div className="space-y-3">
          {connectNotice && (
            <div role="status" className="flex items-start justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900">
              <span className="font-semibold break-all">{connectNotice}</span>
              <Button size="xs" variant="ghost" onClick={() => setConnectNotice('')}>Dismiss</Button>
            </div>
          )}
          {connectError && (
            <div role="alert" className="rounded-lg border border-[#B06A55]/40 bg-[#FAF0EC] p-3 text-xs text-[#8A3E28] space-y-2">
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span><b>Could not connect the Google account.</b> {connectError}</span>
              </div>
              <div className="flex items-center gap-2">
                {connectUrl && <Button size="xs" variant="primary" icon={<LogIn size={11} />} onClick={() => goToConnect(connectUrl)}>Try again</Button>}
                <Button size="xs" variant="ghost" onClick={() => setConnectError('')}>Dismiss</Button>
              </div>
            </div>
          )}

          {google.error && <ErrorState compact title="Could not load the Google Sheets status" message={google.error} onRetry={google.reload} />}
          {!google.status && !google.error && <LoadingState label="Checking Google Sheets…" className="py-6" />}
          {google.status && !accessOk && <InlineNotice tone="warning">{NOT_CONFIGURED_TEXT}</InlineNotice>}
          {google.status && accessOk && (
            <div className={google.status.oauthConfigured && google.status.configured ? 'grid gap-3 lg:grid-cols-2 items-start' : 'grid gap-3'}>
              {google.status.oauthConfigured && (
                <ConnectionsPanel
                  connectUrl={connectUrl}
                  canManage={canManage}
                  connections={conns.connections}
                  loading={conns.loading}
                  error={conns.error}
                  onReload={conns.reload}
                  onChanged={(paused) => {
                    conns.reload();
                    if (paused) setReloadToken((n) => n + 1);
                  }}
                />
              )}
              {google.status.configured && <ServiceAccountPanel email={google.status.serviceAccountEmail} />}
            </div>
          )}
        </div>
      </Card>

      <ImportsCard canManage={canManage} onOpenLeadSources={onOpenLeadSources} connections={conns.connections} reloadToken={reloadToken} />
      <ExportsCard canManage={canManage} google={google.status} configured={accessOk} connections={conns.connections} reloadToken={reloadToken} />
    </div>
  );
};

/* -------------------------------- Access ---------------------------------- */

const panelCls = 'rounded-xl border border-[#D3E3F0] bg-[#FFFFFF] p-4 space-y-3';
const usedByText = (n: number) => `${n} ${n === 1 ? 'import/export' : 'imports/exports'}`;

const ConnectionsPanel: React.FC<{
  /** '' when the user cannot connect accounts. */
  connectUrl: string;
  canManage: boolean;
  connections: GoogleConnection[] | null;
  loading: boolean;
  error: string;
  onReload: () => void;
  /** After a disconnect; `paused` = imports/exports were paused by a forced disconnect. */
  onChanged: (paused: boolean) => void;
}> = ({ connectUrl, canManage, connections, loading, error, onReload, onChanged }) => {
  /** `conflict` = the server's CONFLICT message (imports/exports use it) — the next confirm forces. */
  const [confirm, setConfirm] = useState<{ conn: GoogleConnection; conflict: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const disconnect = async () => {
    if (!confirm) return;
    const force = !!confirm.conflict;
    setBusy(true);
    try {
      await api.sheets.disconnectConnection(confirm.conn.id, force);
      toast('Google account disconnected', force ? `${confirm.conn.email} — the imports and exports that used it are paused.` : confirm.conn.email, 'success');
      setConfirm(null);
      onChanged(force);
    } catch (e) {
      const err = toAppError(reportError('sheets.disconnectConnection', e));
      if (!force && isConnectionInUse(err)) setConfirm({ conn: confirm.conn, conflict: err.userMessage || 'Imports or exports still use this Google account.' });
      else toast('Could not disconnect the Google account', err.userMessage, 'alert');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={panelCls} role="group" aria-labelledby="gs-oauth-title">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 space-y-1">
          <h4 id="gs-oauth-title" className="text-sm font-bold text-[#0B2A44] flex items-center gap-1.5"><UserRound size={15} className="text-[#0B6BB0]" aria-hidden="true" /> Connect a Google account</h4>
          <Badge tone="sage">Recommended — no key file</Badge>
        </div>
        {connectUrl && <Button size="sm" variant="primary" icon={<LogIn size={13} />} onClick={() => goToConnect(connectUrl)}>Connect Google account</Button>}
      </div>
      <p className="text-[11px] text-[#5E778C] leading-relaxed">You sign in with the Google account that can open your sheets; the CRM only gets access to spreadsheets.</p>

      {error && <ErrorState compact title="Could not load the connected accounts" message={error} onRetry={onReload} />}
      {!connections && loading && <LoadingState label="Loading connected accounts…" className="py-3" />}
      {connections && connections.length === 0 && (
        <p className="text-[11px] text-[#7E93A6]">{canManage ? 'No Google account connected yet.' : 'No Google account connected yet — an administrator can connect one.'}</p>
      )}
      {connections && connections.length > 0 && (
        <ul className="space-y-2" aria-label="Connected Google accounts">
          {connections.map((c) => (
            <li key={c.id} className="rounded-lg border border-[#D3E3F0] bg-white p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-[#0B2A44] break-all">{c.email}</span>
                    <Badge tone={c.status === 'Active' ? 'sage' : 'rust'}>{c.status}</Badge>
                  </div>
                  <div className="text-[10px] text-[#7E93A6] mt-0.5">
                    Connected{c.connectedBy ? ` by ${c.connectedBy}` : ''}
                    {c.connectedAt ? <> · <span title={formatDateTime(c.connectedAt)}>{formatDistance(c.connectedAt)}</span></> : null}
                    {' · '}used by {usedByText(Number(c.usedBy || 0))}
                  </div>
                </div>
                {canManage && (
                  <Button size="xs" variant="ghost" icon={<Unplug size={11} />} aria-label={`Disconnect ${c.email}`} onClick={() => setConfirm({ conn: c, conflict: '' })}>Disconnect</Button>
                )}
              </div>
              {c.status === 'Error' && (
                <div role="alert" className="flex items-start justify-between gap-2 rounded-md bg-[#FAF0EC] border border-[#B06A55]/40 p-2 text-[11px] text-[#8A3E28]">
                  <span className="flex items-start gap-1.5 min-w-0">
                    <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <span className="break-words">{c.lastError || 'Google access no longer works — reconnect.'}</span>
                  </span>
                  {connectUrl && <Button size="xs" variant="primary" icon={<RefreshCw size={11} />} onClick={() => goToConnect(connectUrl)}>Reconnect</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!confirm}
        danger
        title={confirm?.conflict ? 'This Google account is still in use' : 'Disconnect this Google account?'}
        confirmLabel={confirm?.conflict ? 'Disconnect anyway — pauses those imports/exports' : 'Disconnect'}
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={disconnect}
        message={
          confirm?.conflict ? (
            <>
              <span className="block mb-2">{confirm.conflict}</span>
              Disconnecting <b className="break-all">{confirm.conn.email}</b> anyway pauses the imports and exports that use it until you choose another access for them.
            </>
          ) : (
            <>
              The CRM’s access for <b className="break-all">{confirm?.conn.email}</b> is revoked at Google.
              {confirm && confirm.conn.usedBy > 0 ? ` It is used by ${usedByText(confirm.conn.usedBy)}.` : ''}
            </>
          )
        }
      />
    </div>
  );
};

const ServiceAccountPanel: React.FC<{ email: string }> = ({ email }) => (
  <div className={panelCls} role="group" aria-labelledby="gs-sa-title">
    <h4 id="gs-sa-title" className="text-sm font-bold text-[#0B2A44] flex items-center gap-1.5"><KeyRound size={15} className="text-[#0B6BB0]" aria-hidden="true" /> Share with the platform service account</h4>
    <p className="text-[11px] text-[#0F2233] leading-relaxed">
      <b>Share your sheets with this address</b> (Share → add people). <b>Viewer</b> is enough to import; <b>Editor</b> is needed for exports and for the import status column.
    </p>
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 break-all text-xs font-mono bg-white border border-[#D3E3F0] rounded-lg px-3 py-2 text-[#0B2A44]" aria-label="Service account e-mail">{email}</code>
      <CopyButton value={email} ariaLabel="Copy the service account e-mail" />
    </div>
  </div>
);

/* -------------------------------- Imports --------------------------------- */

const ImportsCard: React.FC<{ canManage: boolean; onOpenLeadSources?: () => void; connections: GoogleConnection[] | null; reloadToken: number }> = ({ canManage, onOpenLeadSources, connections, reloadToken }) => {
  const [sources, setSources] = useState<LeadSource[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.leadSources.list();
      setSources(all.filter((s) => s.type === 'google_sheet'));
      setError('');
    } catch (e) {
      setError(errMsg('sheets.imports', e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadToken]);

  const sync = async (s: LeadSource) => {
    setSyncing(s.id);
    if (await syncSheetSource(s)) await load();
    setSyncing(null);
  };

  const manageLink = onOpenLeadSources ? (
    <Button size="sm" variant="ghost" icon={<ArrowRight size={13} />} onClick={onOpenLeadSources}>Manage in Lead sources</Button>
  ) : null;

  return (
    <Card
      title="Imports"
      subtitle="Sheets whose new rows become leads. They are lead sources — add or change them in Lead sources."
      actions={
        <>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={loading} onClick={load} aria-label="Refresh imports" />
          {manageLink}
        </>
      }
    >
      {error && <ErrorState compact title="Could not load the imports" message={error} onRetry={load} className="mb-3" />}
      {!sources && loading && <LoadingState label="Loading imports…" className="py-6" />}
      {sources && sources.length === 0 && (
        <EmptyState
          icon={<FileSpreadsheet size={22} />}
          title="No sheet imports yet"
          description={canManage ? 'In Lead sources, click “Add source” and choose “Google Sheet (import)”.' : 'An administrator can add one in Lead sources.'}
          action={canManage ? manageLink || undefined : undefined}
        />
      )}
      {sources && sources.length > 0 && (
        <ul className="grid gap-3 xl:grid-cols-2">
          {sources.map((s) => (
            <li key={s.id} className="rounded-xl border border-[#D3E3F0] bg-[#FFFFFF] p-4 space-y-2.5" aria-label={`Import ${s.name}`}>
              <div className="flex items-center gap-1.5 flex-wrap">
                <FileSpreadsheet size={15} className="text-[#0B6BB0]" aria-hidden="true" />
                <h4 className="text-sm font-bold text-[#0B2A44] truncate">{s.name}</h4>
                <Badge tone={s.status === 'Active' ? 'sage' : 'amber'}>{s.status}</Badge>
              </div>
              <SheetSummary sheet={s.config?.sheet} connections={connections} />
              <div className="text-[11px] text-[#5E778C]">
                {Number(s.stats?.created || 0).toLocaleString('en-GB')} leads created · {Number(s.stats?.duplicates || 0).toLocaleString('en-GB')} duplicates
              </div>
              {canManage && (
                <Button size="xs" variant="primary" icon={<RefreshCw size={11} />} loading={syncing === s.id} onClick={() => sync(s)}>Sync now</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

/* -------------------------------- Exports --------------------------------- */

const ExportsCard: React.FC<{ canManage: boolean; google: GoogleStatus | null; configured: boolean; connections: GoogleConnection[] | null; reloadToken: number }> = ({ canManage, google, configured, connections, reloadToken }) => {
  const [rows, setRows] = useState<SheetExport[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<SheetExport | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SheetExport | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.sheets.listExports());
      setError('');
    } catch (e) {
      setError(errMsg('sheets.listExports', e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadToken]);

  const upsert = (x: SheetExport) => setRows((prev) => (prev ? (prev.some((r) => r.id === x.id) ? prev.map((r) => (r.id === x.id ? x : r)) : [...prev, x]) : [x]));

  const run = async (x: SheetExport) => {
    setBusy(`run:${x.id}`);
    try {
      const r = await api.sheets.runExport(x.id);
      upsert(r);
      if (r.lastError) toast('Export failed', r.lastError, 'alert');
      else toast('Export finished', `${Number(r.lastRows || 0).toLocaleString('en-GB')} rows written to “${r.tab}”.`, 'success');
    } catch (e) {
      toast('Could not run the export', errMsg('sheets.runExport', e), 'alert');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (x: SheetExport) => {
    const status = x.status === 'Active' ? 'Paused' : 'Active';
    setBusy(`toggle:${x.id}`);
    try {
      upsert(await api.sheets.updateExport(x.id, { status }));
      toast(status === 'Paused' ? 'Export paused' : 'Export resumed', x.name, 'success');
    } catch (e) {
      toast('Could not change the status', errMsg('sheets.updateExport', e), 'alert');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.sheets.removeExport(deleting.id);
      setRows((prev) => (prev ? prev.filter((r) => r.id !== deleting.id) : prev));
      toast('Export deleted', deleting.name, 'success');
      setDeleting(null);
    } catch (e) {
      toast('Could not delete the export', errMsg('sheets.removeExport', e), 'alert');
    } finally {
      setDeleteBusy(false);
    }
  };

  const newButton = canManage ? (
    <Button size="sm" variant="primary" icon={<Plus size={13} />} disabled={!configured} title={configured ? undefined : NOT_CONFIGURED_TEXT} onClick={() => setEditing('new')}>New export</Button>
  ) : null;

  return (
    <Card
      title="Exports"
      subtitle="A live copy of your leads in a Google Sheet. The CRM is the master copy: edits made in the sheet are overwritten on the next export."
      actions={
        <>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={loading} onClick={load} aria-label="Refresh exports" />
          {newButton}
        </>
      }
    >
      {error && <ErrorState compact title="Could not load the exports" message={error} onRetry={load} className="mb-3" />}
      {!rows && loading && <LoadingState label="Loading exports…" className="py-6" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={<Upload size={22} />}
          title="No exports yet"
          description={canManage ? 'Create an export to keep your leads in a Google Sheet for management reports or other tools.' : 'An administrator can create one.'}
          action={newButton || undefined}
        />
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[#D3E3F0] bg-white">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#E6EFF6] border-b border-[#D3E3F0] text-[#5E778C] uppercase font-bold tracking-wider text-[10px]">
                <th className="p-2.5">Name</th>
                <th className="p-2.5">Sheet · tab · access</th>
                <th className="p-2.5">Columns</th>
                <th className="p-2.5">Interval</th>
                <th className="p-2.5">Status</th>
                <th className="p-2.5">Last export</th>
                <th className="p-2.5 text-right">Rows</th>
                {canManage && <th className="p-2.5"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E6EFF6]">
              {rows.map((x) => {
                const href = spreadsheetHref(x.spreadsheetUrl, x.spreadsheetId);
                const cols = (x.columns?.headers?.length || 0) + (x.columns?.includeFollowups ? 1 : 0);
                return (
                  <tr key={x.id} className="align-top">
                    <td className="p-2.5">
                      <div className="font-semibold text-[#0B2A44]">{x.name}</div>
                      <div className="text-[10px] text-[#7E93A6]">{x.id}{x.columns?.includeTrash ? ' · includes Trash' : ''}</div>
                    </td>
                    <td className="p-2.5 max-w-[200px]">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#0B6BB0] hover:underline font-semibold">
                          Open <ExternalLink size={11} aria-hidden="true" /><span className="sr-only">spreadsheet of {x.name} (opens in a new tab)</span>
                        </a>
                      ) : <span className="text-[#7E93A6]">—</span>}
                      <div className="text-[#0F2233] truncate">{x.tab}</div>
                      <div className="text-[10px] text-[#7E93A6] truncate" title={authLabel(x.auth, connections)}>{authLabel(x.auth, connections)}</div>
                    </td>
                    <td className="p-2.5 whitespace-nowrap">{cols}{x.columns?.includeFollowups ? <span className="text-[10px] text-[#7E93A6]"> incl. follow-ups</span> : null}</td>
                    <td className="p-2.5 whitespace-nowrap">{intervalLabel(x.intervalMinutes)}</td>
                    <td className="p-2.5">
                      <Badge tone={x.lastError ? 'rust' : x.status === 'Active' ? 'sage' : 'amber'}>{x.lastError ? 'Error' : x.status}</Badge>
                      {x.lastError && x.status === 'Paused' && <div className="text-[10px] text-[#7E93A6] mt-0.5">Paused</div>}
                    </td>
                    <td className="p-2.5 whitespace-nowrap">
                      {x.lastSyncAt ? <span title={formatDateTime(x.lastSyncAt)}>{formatDistance(x.lastSyncAt)}</span> : <span className="text-[#7E93A6]">never</span>}
                    </td>
                    <td className="p-2.5 text-right whitespace-nowrap">{x.lastSyncAt ? Number(x.lastRows || 0).toLocaleString('en-GB') : '—'}</td>
                    {canManage && (
                      <td className="p-2.5">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          <Button size="xs" variant="primary" icon={<RefreshCw size={11} />} loading={busy === `run:${x.id}`} disabled={!configured} onClick={() => run(x)}>Run now</Button>
                          <Button size="xs" icon={x.status === 'Active' ? <Pause size={11} /> : <Play size={11} />} loading={busy === `toggle:${x.id}`} onClick={() => toggle(x)}>
                            {x.status === 'Active' ? 'Pause' : 'Resume'}
                          </Button>
                          <Button size="xs" variant="ghost" icon={<Pencil size={11} />} aria-label={`Edit ${x.name}`} onClick={() => setEditing(x)} />
                          <Button size="xs" variant="ghost" icon={<Trash2 size={11} />} aria-label={`Delete ${x.name}`} onClick={() => setDeleting(x)} />
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.some((x) => x.lastError) && (
            <ul className="border-t border-[#D3E3F0] p-2.5 space-y-1">
              {rows.filter((x) => x.lastError).map((x) => (
                <li key={x.id} className="flex items-start gap-1.5 text-[11px] text-[#8A3E28]">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="break-words"><b>{x.name}</b> — last error: {x.lastError}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editing && (
        <ExportDialog
          existing={editing === 'new' ? undefined : editing}
          google={google}
          connections={connections}
          onClose={() => setEditing(null)}
          onSaved={(x) => {
            upsert(x);
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        danger
        title="Delete this export?"
        confirmLabel="Delete export"
        loading={deleteBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={remove}
        message={<>“{deleting?.name}” stops updating. The spreadsheet and the rows already written to it are <b>not</b> deleted.</>}
      />
    </Card>
  );
};
