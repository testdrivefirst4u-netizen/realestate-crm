/**
 * Settings › Lead sources — website forms and webhooks that create leads through POST /api/inbound/leads.
 * Google Sheet imports (type 'google_sheet') pull rows from a shared sheet instead (plan feature `googleSheets`).
 * Facebook Pages (type 'meta') are connected through a Facebook login (plan feature `metaLeads`).
 * Plan feature `websiteApi`, `googleSheets` or `metaLeads`; viewing needs `settings.view`, managing `settings.edit` (the server enforces both).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, Facebook, FileSpreadsheet, Globe, Lock, Plus, RefreshCw, Settings2, Webhook } from 'lucide-react';
import type { GoogleConnection, GoogleStatus } from '../../../../server/core/sheetTypes';
import type { LeadSource } from '../../../../server/core/leadSourceTypes';
import { api } from '../../../core/api';
import { formatDateTime, formatDistance } from '../../../core/dates';
import { reportError, toAppError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { useFeature } from '../../../core/tenant';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal } from '../../../components/ui';
import type { CanFn } from '../types';
import { ApiKeyPanel, IntegrationGuide } from './IntegrationGuide';
import { SourceDetail } from './SourceDetail';
import { SourceForm, SourceFormState, emptyFormState, formToRequest } from './SourceForm';
import { TYPE_LABEL, usableStages, usesApiKey } from './leadSourceUtils';
import { NOT_CONFIGURED_TEXT } from '../sheets/SheetImportFields';
import { intervalLabel, sheetsAccessConfigured } from '../sheets/sheetUtils';
import { SheetSummary, syncSheetSource } from '../sheets/sheetSource';
import { useGoogleConnections, useGoogleStatus } from '../sheets/useGoogleStatus';
import { MetaConnectDialog, MetaConnectPanel, MetaErrorNotice, MetaLastError, MetaSourceActions, MetaStatusWithUrl, MetaSummary, useMetaStatus } from '../meta/MetaLeads';
import { metaErrorText } from '../meta/metaUtils';

export interface LeadSourcesSectionProps {
  can: CanFn;
  /** Lead Stage dropdown options (engine data: config.options['Lead Stage']). */
  stageOptions: string[];
  /** Assigned RM dropdown options. */
  rmOptions: string[];
  /** Opens a lead's detail drawer (`?lead=`). */
  onOpenLead?: (id: string) => void;
  /** Pending Facebook connection id from the login redirect (`?metaConnect=`). */
  metaConnect?: string | null;
  /** Why the Facebook login did not finish (`?metaError=`). */
  metaError?: string | null;
  /** Called once the screen has taken `metaConnect` / `metaError` (so they are not shown again). */
  onMetaLinkConsumed?: () => void;
}

const errMsg = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const LeadSourcesSection: React.FC<LeadSourcesSectionProps> = (props) => {
  const apiEnabled = useFeature('websiteApi');
  const sheetsEnabled = useFeature('googleSheets');
  const metaEnabled = useFeature('metaLeads');
  if (!props.can('settings.view')) return null;
  // A Facebook login that just finished is still shown (the server refuses it when the plan does not allow it).
  if (!apiEnabled && !sheetsEnabled && !metaEnabled && !props.metaConnect && !props.metaError) {
    return (
      <Card title="Lead sources">
        <EmptyState
          icon={<Lock size={22} />}
          title="Not included in your plan"
          description="Website forms, the lead API, Google Sheets and Facebook / Instagram lead ads are not part of your company’s plan — ask your platform administrator to enable them."
        />
      </Card>
    );
  }
  return <LeadSourcesScreen {...props} stageOptions={usableStages(props.stageOptions)} apiEnabled={apiEnabled} sheetsEnabled={sheetsEnabled} metaEnabled={metaEnabled} />;
};

function sectionSubtitle(apiEnabled: boolean, sheetsEnabled: boolean, metaEnabled: boolean): string {
  const parts: string[] = [];
  if (apiEnabled) parts.push('website enquiry forms and webhooks (Zapier, Make, IndiaMART, landing-page tools)');
  if (sheetsEnabled) parts.push('Google Sheets');
  if (metaEnabled) parts.push('Facebook / Instagram lead ads');
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || 'Lead sources';
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} that create leads automatically.`;
}

type ScreenProps = LeadSourcesSectionProps & { apiEnabled: boolean; sheetsEnabled: boolean; metaEnabled: boolean };

const LeadSourcesScreen: React.FC<ScreenProps> = ({ can, stageOptions, rmOptions, onOpenLead, apiEnabled, sheetsEnabled, metaEnabled, metaConnect, metaError, onMetaLinkConsumed }) => {
  const canManage = can('settings.edit');
  const canAdd = canManage && (apiEnabled || sheetsEnabled);
  const google = useGoogleStatus(sheetsEnabled);
  const googleConns = useGoogleConnections(sheetsEnabled && !!google.status?.oauthConfigured);
  // Also needed for a returning Facebook login ("Connect again") before the plan features are known.
  const meta = useMetaStatus(metaEnabled || !!metaConnect || !!metaError);
  const [pendingId, setPendingId] = useState<string | null>(metaConnect || null);
  const [metaNotice, setMetaNotice] = useState<string>(() => metaErrorText(metaError));
  const [syncing, setSyncing] = useState<string | null>(null);
  const [sources, setSources] = useState<LeadSource[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ source: LeadSource; apiKey: string } | null>(null);
  const [detail, setDetail] = useState<{ id: string; tab?: 'settings' | 'guide' | 'log' } | null>(null);
  const [guideFor, setGuideFor] = useState<LeadSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSources(await api.leadSources.list());
      setError('');
    } catch (e) {
      setError(errMsg('leadSources.list', e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The URL parameters were taken over into local state — let the app forget them.
  useEffect(() => {
    if (metaConnect || metaError) onMetaLinkConsumed?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upsert = (s: LeadSource) => setSources((prev) => (prev ? (prev.some((x) => x.id === s.id) ? prev.map((x) => (x.id === s.id ? s : x)) : [...prev, s]) : [s]));
  const remove = (id: string) => setSources((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
  const detailSource = detail && sources ? sources.find((s) => s.id === detail.id) || null : null;
  const connectUrl = canManage && meta.status?.configured ? meta.status.connectUrl : undefined;

  const syncNow = async (s: LeadSource) => {
    setSyncing(s.id);
    if (await syncSheetSource(s)) await load();
    setSyncing(null);
  };

  const emptyText = metaEnabled && !apiEnabled && !sheetsEnabled
    ? 'Connect a Facebook Page above and the leads from its lead ads arrive automatically. '
    : apiEnabled
      ? 'A lead source gives your website form or an outside service its own API key. '
      : 'A Google Sheet lead source reads new rows from a sheet you share with the CRM. ';

  return (
    <div className="space-y-4">
      <Card
        title="Lead sources"
        subtitle={sectionSubtitle(apiEnabled, sheetsEnabled, metaEnabled)}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={loading} onClick={load} aria-label="Refresh lead sources" />
            {canAdd && <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add source</Button>}
          </>
        }
      >
        <div className="space-y-3">
          {metaNotice && <MetaErrorNotice message={metaNotice} connectUrl={connectUrl} onDismiss={() => setMetaNotice('')} />}
          {metaEnabled && canManage && <MetaConnectPanel status={meta.status} loading={meta.loading} error={meta.error} onRetry={meta.reload} />}
          {error && <ErrorState compact title="Could not load the lead sources" message={error} onRetry={load} />}
          {!sources && loading && <LoadingState label="Loading lead sources…" />}
          {sources && sources.length === 0 && (
            <EmptyState
              icon={<Globe size={22} />}
              title="No lead sources yet"
              description={
                <>
                  {emptyText}
                  Every enquiry becomes a lead here — with the stage, RM and duplicate handling you choose — and is recorded in an intake log so nothing gets lost.
                  {!canManage && ' Ask an administrator to add one.'}
                </>
              }
              action={canAdd ? <Button variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add source</Button> : undefined}
            />
          )}
          {sources && sources.length > 0 && (
            <div className="grid gap-3 xl:grid-cols-2">
              {sources.map((s) => (
                <SourceCard
                  key={s.id}
                  source={s}
                  onOpen={() => setDetail({ id: s.id })}
                  onGuide={() => setGuideFor(s)}
                  onLog={() => setDetail({ id: s.id, tab: 'log' })}
                  onSync={() => syncNow(s)}
                  syncing={syncing === s.id}
                  canManage={canManage}
                  connectUrl={connectUrl}
                  connections={googleConns.connections}
                  onRefresh={load}
                  onRemoved={remove}
                />
              ))}
            </div>
          )}
        </div>
      </Card>

      {pendingId && (
        <MetaConnectDialog
          pendingId={pendingId}
          stageOptions={stageOptions}
          rmOptions={rmOptions}
          connectUrl={connectUrl}
          onClose={() => setPendingId(null)}
          onConnected={() => {
            setPendingId(null);
            load();
          }}
        />
      )}

      {adding && (
        <AddSourceDialog
          stageOptions={stageOptions}
          rmOptions={rmOptions}
          apiEnabled={apiEnabled}
          sheetsEnabled={sheetsEnabled}
          google={google.status}
          connections={googleConns.connections}
          onClose={() => setAdding(false)}
          onCreated={(r) => {
            upsert(r.source);
            setAdding(false);
            // A sheet import has no API key — there is nothing to copy and no integration guide.
            if (r.apiKey && usesApiKey(r.source.type)) setCreated(r);
          }}
        />
      )}

      {created && (
        <Modal
          open
          width="lg"
          onClose={() => setCreated(null)}
          title={`“${created.source.name}” is ready`}
          subtitle="Copy the key and connect your website or service."
          footer={<Button variant="primary" onClick={() => setCreated(null)}>I’ve copied the key</Button>}
        >
          <div className="space-y-5">
            <ApiKeyPanel apiKey={created.apiKey} />
            <div>
              <h4 className="text-sm font-bold text-[#1D2F3F] mb-2">Integration guide</h4>
              <IntegrationGuide apiKey={created.apiKey} initialTab={created.source.type === 'webhook' ? 'zapier' : 'html'} redirectUrl={created.source.config?.allowedOrigins?.[0] ? `${created.source.config.allowedOrigins[0]}/thank-you` : undefined} />
            </div>
          </div>
        </Modal>
      )}

      {guideFor && usesApiKey(guideFor.type) && (
        <Modal open width="lg" onClose={() => setGuideFor(null)} title={`Integration guide · ${guideFor.name}`} subtitle={<>Key starts with <code className="font-mono">{guideFor.keyPrefix}…</code></>}>
          <IntegrationGuide initialTab={guideFor.type === 'webhook' ? 'zapier' : 'html'} redirectUrl={guideFor.config?.allowedOrigins?.[0] ? `${guideFor.config.allowedOrigins[0]}/thank-you` : undefined} />
        </Modal>
      )}

      {detailSource && (
        <SourceDetail
          key={detailSource.id}
          source={detailSource}
          canManage={canManage}
          stageOptions={stageOptions}
          rmOptions={rmOptions}
          initialTab={detail?.tab}
          onClose={() => setDetail(null)}
          onChanged={upsert}
          onDeleted={(id) => {
            setDetail(null);
            setSources((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
          }}
          onOpenLead={onOpenLead}
          google={google.status}
          connections={googleConns.connections}
          onSynced={load}
          metaConnectUrl={connectUrl}
        />
      )}
    </div>
  );
};

/* ------------------------------- Card ------------------------------------ */

const Stat: React.FC<{ label: string; value: number; tone?: string }> = ({ label, value, tone }) => (
  <div className="min-w-0">
    <div className={`text-base font-bold leading-tight ${tone || 'text-[#1D2F3F]'}`}>{Number(value || 0).toLocaleString('en-GB')}</div>
    <div className="text-[9px] uppercase font-bold tracking-wider text-[#9E948D] truncate">{label}</div>
  </div>
);

const SourceCard: React.FC<{
  source: LeadSource;
  canManage: boolean;
  onOpen: () => void;
  onGuide: () => void;
  onLog: () => void;
  onSync: () => void;
  syncing: boolean;
  /** Facebook login URL for "Reconnect" (Meta Pages; undefined when Meta is not set up or the user cannot manage). */
  connectUrl?: string;
  /** Connected Google accounts (to name the account a sheet import uses). */
  connections?: GoogleConnection[] | null;
  onRefresh: () => void;
  onRemoved: (id: string) => void;
}> = ({ source: s, canManage, onOpen, onGuide, onLog, onSync, syncing, connectUrl, connections, onRefresh, onRemoved }) => {
  const st = s.stats || ({} as LeadSource['stats']);
  const isSheet = s.type === 'google_sheet';
  const isMeta = s.type === 'meta';
  const lastError = isMeta ? s.config?.meta?.lastError || st.lastError : st.lastError;
  return (
    <article className="rounded-xl border border-[#D2C9BF] bg-[#FDFCFA] p-4 space-y-3" aria-label={`Lead source ${s.name}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={isMeta ? 'text-[#1877F2]' : 'text-[#A9825A]'} aria-hidden="true">
              {s.type === 'website' ? <Globe size={15} /> : isSheet ? <FileSpreadsheet size={15} /> : isMeta ? <Facebook size={15} /> : <Webhook size={15} />}
            </span>
            <h4 className="text-sm font-bold text-[#1D2F3F] truncate">{s.name}</h4>
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge tone="navy">{TYPE_LABEL[s.type] || s.type}</Badge>
            <Badge tone={s.status === 'Active' ? 'sage' : 'amber'}>{s.status}</Badge>
            {usesApiKey(s.type) && s.keyPrefix && <code className="text-[10px] font-mono text-[#6B5F57]" title="Start of the API key">{s.keyPrefix}…</code>}
          </div>
        </div>
      </div>
      {isSheet && <SheetSummary sheet={s.config?.sheet} connections={connections} />}
      {isMeta && <MetaSummary meta={s.config?.meta} lastReceivedAt={st.lastReceivedAt} />}
      <div className="grid grid-cols-5 gap-2">
        <Stat label="Received" value={st.received} />
        <Stat label="Created" value={st.created} tone="text-[#3C573A]" />
        <Stat label="Duplicates" value={st.duplicates} tone="text-[#86633E]" />
        <Stat label="Rejected" value={st.rejected} tone="text-[#92400E]" />
        <Stat label="Failed" value={st.failed} tone="text-[#8A3E28]" />
      </div>
      {!isMeta && (
        <div className="text-[11px] text-[#6B5F57]">
          {isSheet ? 'Last lead:' : 'Last received:'} {st.lastReceivedAt ? <span title={formatDateTime(st.lastReceivedAt)}>{formatDistance(st.lastReceivedAt)}</span> : <span className="text-[#9E948D]">never</span>}
        </div>
      )}
      {isMeta ? (
        <MetaLastError message={lastError || ''} connectUrl={connectUrl} canManage={canManage} />
      ) : lastError ? (
        <div className="flex items-start gap-1.5 text-[11px] text-[#8A3E28] bg-[#FAF0EC] border border-[#B06A55]/30 rounded-lg px-2.5 py-1.5">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          <span className="break-words">Last error: {lastError}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Button size="xs" variant="primary" icon={<Settings2 size={11} />} onClick={onOpen}>{canManage ? 'Manage' : 'Details'}</Button>
        {isSheet ? (
          canManage && <Button size="xs" icon={<RefreshCw size={11} />} loading={syncing} onClick={onSync}>Sync now</Button>
        ) : isMeta ? (
          canManage && <MetaSourceActions source={s} onRefresh={onRefresh} onDisconnected={onRemoved} />
        ) : (
          <Button size="xs" icon={<BookOpen size={11} />} onClick={onGuide}>Integration guide</Button>
        )}
        <Button size="xs" variant="ghost" onClick={onLog}>Intake log</Button>
      </div>
    </article>
  );
};

/* ------------------------------ Add dialog -------------------------------- */

const AddSourceDialog: React.FC<{
  stageOptions: string[];
  rmOptions: string[];
  apiEnabled: boolean;
  sheetsEnabled: boolean;
  google: GoogleStatus | null;
  connections: GoogleConnection[] | null;
  onClose: () => void;
  onCreated: (r: { source: LeadSource; apiKey: string }) => void;
}> = ({ stageOptions, rmOptions, apiEnabled, sheetsEnabled, google, connections, onClose, onCreated }) => {
  const [form, setForm] = useState<SourceFormState>(() => {
    const f = emptyFormState(apiEnabled ? 'website' : 'google_sheet');
    if (stageOptions.length && !stageOptions.includes(f.defaultStage)) f.defaultStage = stageOptions[0];
    return f;
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const isSheet = form.type === 'google_sheet';
  const sheetBlocked = isSheet && !sheetsAccessConfigured(google);

  const submit = async () => {
    if (sheetBlocked) {
      setErrors([google ? NOT_CONFIGURED_TEXT : 'Still checking whether Google Sheets is set up — try again in a moment.']);
      return;
    }
    const req = formToRequest(form);
    setErrors(req.errors);
    if (req.errors.length) return;
    setBusy(true);
    try {
      const r = await api.leadSources.create({ name: req.name, type: req.type, config: req.config });
      const iv = r.source.config?.sheet?.intervalMinutes;
      toast('Lead source created', isSheet ? `${r.source.name} — new rows are read ${iv ? intervalLabel(iv).toLowerCase() : 'when you click Sync now'}.` : r.source.name, 'success');
      onCreated(r);
    } catch (e) {
      setErrors([errMsg('leadSources.create', e)]);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      width="lg"
      onClose={onClose}
      title="Add lead source"
      subtitle={isSheet ? 'New rows of the sheet become leads; every row is recorded in the intake log.' : 'Each source gets its own API key and intake log.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Plus size={13} />} loading={busy} disabled={isSheet && !!google && !sheetsAccessConfigured(google)} onClick={submit}>Create source</Button></>}
    >
      <div className="space-y-3">
        {errors.length > 0 && (
          <div role="alert" className="p-3 rounded-lg border border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28] text-xs space-y-0.5">
            {errors.map((e) => <div key={e}>{e}</div>)}
          </div>
        )}
        <SourceForm value={form} onChange={setForm} stageOptions={stageOptions} rmOptions={rmOptions} disabled={busy} idPrefix="ls-new" allowSheet={sheetsEnabled} allowApi={apiEnabled} google={google} connections={connections} />
      </div>
    </Modal>
  );
};
