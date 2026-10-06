'use client';
import { useId, useState } from 'react';
import { AlertTriangle, FileSpreadsheet, Globe, KeyRound, Megaphone, Pause, Play, Plus, Trash2, Webhook } from 'lucide-react';
import type { CompanyDetail, LeadSource } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../../_lib/api';
import { FEATURE_LABELS, fmtDateTime, fmtNum } from '../../../_lib/format';
import { normaliseFeatures } from '../../../_components/FeatureToggles';
import { ConfirmDialog } from '../../../_components/Modal';
import { useToast } from '../../../_components/Toast';
import { Button, Card, CardHeader, EmptyState, ErrorBox, Pill, Skeleton, StatusBadge, cx } from '../../../_components/ui';
import { InboundLogSection } from './InboundLogSection';
import { CreateLeadSourceDialog, DUPLICATE_LABELS, KeyRevealModal, SOURCE_TYPE_LABELS, hasApiKey } from './LeadSourceDialogs';
import { MetaSection } from './MetaSection';
import { SheetsSection } from './SheetsSection';

type Pending = { kind: 'rotate' | 'delete'; source: LeadSource } | null;

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] font-medium uppercase tracking-wide text-[#7A6F64]">{label}</dt>
      <dd className={cx('mt-0.5 text-[15px] font-semibold tabular-nums text-[#14202B]', value > 0 && tone)}>{fmtNum(value)}</dd>
    </div>
  );
}

function SourceRow({
  source,
  busy,
  onToggle,
  onRotate,
  onDelete,
}: {
  source: LeadSource;
  busy: boolean;
  onToggle: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const s = source.stats;
  const cfg = source.config;
  const keyed = hasApiKey(source.type);
  const TypeIcon = source.type === 'webhook' ? Webhook : source.type === 'google_sheet' ? FileSpreadsheet : source.type === 'meta' ? Megaphone : Globe;
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F4EEE7] text-[#A9825A]">
            <TypeIcon className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14.5px] font-semibold text-[#14202B]">{source.name}</h3>
              <StatusBadge status={source.status} />
              <Pill>{SOURCE_TYPE_LABELS[source.type] || source.type}</Pill>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-[#6B6158]">
              <span className="font-mono">{source.id}</span>
              <span aria-hidden>·</span>
              {keyed && source.keyPrefix && (
                <>
                  <span>
                    Key <span className="font-mono text-[#26211E]">{source.keyPrefix}…</span>
                  </span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>Enquiry Source “{cfg?.sourceLabel || SOURCE_TYPE_LABELS[source.type]}”</span>
              {cfg?.duplicates && (
                <>
                  <span aria-hidden>·</span>
                  <span>Duplicates: {DUPLICATE_LABELS[cfg.duplicates]?.toLowerCase() || cfg.duplicates}</span>
                </>
              )}
            </p>
            <p className="mt-0.5 text-[12.5px] text-[#7A6F64]">
              {keyed
                ? cfg?.allowedOrigins?.length
                  ? `Allowed websites: ${cfg.allowedOrigins.join(', ')}`
                  : 'Accepts any website'
                : source.type === 'meta'
                  ? `Receives Lead Ads from the Facebook Page${cfg?.meta?.pageName ? ` “${cfg.meta.pageName}”` : ''}${cfg?.meta?.pageId ? ` (${cfg.meta.pageId})` : ''}`
                  : `Imports rows from a shared Google Sheet${cfg?.sheet?.tab ? ` (tab “${cfg.sheet.tab}”)` : ''}`}{' '}
              · Created {fmtDateTime(source.createdAt)}
              {source.createdBy ? ` by ${source.createdBy}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            icon={source.status === 'Active' ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
            onClick={onToggle}
            aria-label={`${source.status === 'Active' ? 'Pause' : 'Resume'} ${source.name}`}
          >
            {source.status === 'Active' ? 'Pause' : 'Resume'}
          </Button>
          {keyed && (
            <Button variant="secondary" size="sm" icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />} onClick={onRotate} disabled={busy} aria-label={`Rotate key of ${source.name}`}>
              Rotate key
            </Button>
          )}
          <Button variant="danger-outline" size="sm" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />} onClick={onDelete} disabled={busy} aria-label={`Delete ${source.name}`}>
            Delete
          </Button>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-3 rounded-lg border border-[#EFE9E2] bg-[#FBF9F6] px-4 py-3 sm:grid-cols-5">
        <Stat label="Received" value={s?.received ?? 0} />
        <Stat label="Created" value={s?.created ?? 0} tone="text-[#067647]" />
        <Stat label="Duplicates" value={s?.duplicates ?? 0} tone="text-[#3538CD]" />
        <Stat label="Rejected" value={s?.rejected ?? 0} tone="text-[#B54708]" />
        <Stat label="Failed" value={s?.failed ?? 0} tone="text-[#B42318]" />
      </dl>
      <p className="mt-2 text-[13px] text-[#6B6158]">
        Last received: <span className="text-[#26211E]">{s?.lastReceivedAt ? fmtDateTime(s.lastReceivedAt) : 'Never'}</span>
      </p>
      {s?.lastError && (
        <p className="mt-1 flex items-start gap-1.5 text-[13px] text-[#912018]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">Last error: {s.lastError}</span>
        </p>
      )}
    </li>
  );
}

export function IntegrationsTab({ company, onSaved }: { company: CompanyDetail; onSaved: (c: CompanyDetail) => void }) {
  const toast = useToast();
  const uid = useId();
  const sources = useResource(() => call('listCompanyLeadSources', { companyId: company.id }), [company.id]);
  const list = sources.data || [];

  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rotated, setRotated] = useState<{ source: LeadSource; apiKey: string } | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [featureError, setFeatureError] = useState('');

  const apiOff = company.features?.websiteApi === false;

  const replace = (s: LeadSource) => sources.setData(list.map((x) => (x.id === s.id ? s : x)));

  const enableApi = async () => {
    setEnabling(true);
    setFeatureError('');
    try {
      const updated = await call('updateCompany', { id: company.id, patch: { features: { ...normaliseFeatures(company.features), websiteApi: true } } });
      onSaved(updated);
      toast(`${FEATURE_LABELS.websiteApi} switched on.`);
    } catch (e) {
      setFeatureError(errorMessage(e));
    } finally {
      setEnabling(false);
    }
  };

  const toggle = async (s: LeadSource) => {
    const status = s.status === 'Active' ? 'Paused' : 'Active';
    setToggling(s.id);
    try {
      const updated = await call('updateCompanyLeadSource', { companyId: company.id, id: s.id, patch: { status } });
      replace(updated);
      toast(`${s.name} ${status === 'Active' ? 'resumed' : 'paused'}.`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setToggling(null);
    }
  };

  const closePending = () => {
    if (busy) return;
    setPending(null);
    setError('');
  };

  const confirm = async () => {
    if (!pending) return;
    const { source } = pending;
    setBusy(true);
    setError('');
    try {
      if (pending.kind === 'rotate') {
        const res = await call('rotateCompanyLeadSourceKey', { companyId: company.id, id: source.id });
        replace(res.source);
        setPending(null);
        setRotated(res);
      } else {
        await call('deleteCompanyLeadSource', { companyId: company.id, id: source.id });
        sources.setData(list.filter((x) => x.id !== source.id));
        setPending(null);
        toast(`${source.name} deleted.`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const createButton = (
    <Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setCreating(true)}>
      Create source on behalf
    </Button>
  );

  return (
    <div className="space-y-6">
      {apiOff && (
        <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-[14px] text-[#93370D]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p>Website forms &amp; lead API is switched off for this company — leads sent to its keys are refused.</p>
            <ErrorBox message={featureError} className="mt-2" />
          </div>
          <Button size="sm" variant="secondary" loading={enabling} onClick={enableApi}>
            Switch it on
          </Button>
        </div>
      )}

      <Card aria-labelledby={`${uid}-src`}>
        <CardHeader
          id={`${uid}-src`}
          title="Lead sources"
          description="Website forms, webhooks, Google Sheet imports and Facebook Pages that bring leads straight into this company's CRM. Website and webhook sources each have their own API key."
          actions={list.length > 0 || sources.loading ? createButton : null}
        />
        <ErrorBox message={sources.error} onRetry={sources.reload} className="m-4" />
        {sources.loading && !sources.data ? (
          <div role="status" aria-label="Loading lead sources" className="divide-y divide-[#F1ECE6]">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-3 px-5 py-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3.5 w-72" />
                  </div>
                </div>
                <Skeleton className="h-14 w-full" />
              </div>
            ))}
          </div>
        ) : list.length === 0 && !sources.error ? (
          <EmptyState
            icon={<Globe className="h-5 w-5" aria-hidden />}
            title="No lead sources yet"
            description="The company's administrators can add one in CRM settings, or you can create one on their behalf."
            action={createButton}
          />
        ) : (
          <ul className="divide-y divide-[#F1ECE6]">
            {list.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                busy={toggling === s.id}
                onToggle={() => toggle(s)}
                onRotate={() => setPending({ kind: 'rotate', source: s })}
                onDelete={() => setPending({ kind: 'delete', source: s })}
              />
            ))}
          </ul>
        )}
      </Card>

      <InboundLogSection companyId={company.id} sources={list} />

      <SheetsSection company={company} onSaved={onSaved} />

      <MetaSection company={company} onSaved={onSaved} onSourcesChanged={sources.reload} />

      <CreateLeadSourceDialog
        open={creating}
        onClose={() => setCreating(false)}
        company={company}
        onCreated={(s) => {
          sources.setData([...list, s]);
          toast(`${s.name} created.`);
        }}
      />

      <ConfirmDialog
        open={Boolean(pending)}
        onClose={closePending}
        busy={busy}
        error={error}
        onConfirm={confirm}
        tone="danger"
        title={pending?.kind === 'rotate' ? 'Rotate API key?' : 'Delete lead source?'}
        confirmLabel={pending?.kind === 'rotate' ? 'Rotate key' : 'Delete source'}
        description={
          pending?.kind === 'rotate'
            ? `The current key for “${pending.source.name}” stops working immediately. Forms and integrations using it must be updated with the new key.`
            : `“${pending?.source.name}” and its key are removed. Submissions sent to it will be refused. Leads already created are kept.`
        }
      />

      <KeyRevealModal open={Boolean(rotated)} onClose={() => setRotated(null)} result={rotated} />
    </div>
  );
}
