/**
 * Meta (Facebook / Instagram) Lead Ads — UI pieces for Settings › Lead sources.
 * A connected Facebook Page is a lead source of type 'meta' (config.meta). Plan feature `metaLeads`;
 * viewing needs `settings.view`, managing `settings.edit` (the server enforces both). Contract: server/core/metaTypes.ts.
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CloudDownload, ExternalLink, Facebook, HelpCircle, Link2, Link2Off, RefreshCw, ShieldCheck } from 'lucide-react';
import type { MetaPendingPage, MetaSourceConfig, MetaStatus } from '../../../../server/core/metaTypes';
import type { LeadSource } from '../../../../server/core/leadSourceTypes';
import { api } from '../../../core/api';
import { formatDateTime, formatDistance } from '../../../core/dates';
import { reportError, toAppError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { Badge, Button, ErrorState, InlineNotice, LoadingState, Modal, Select, cx, inputCls, labelCls } from '../../../components/ui';
import { RoutingFields, emptyFormState } from '../leadSources/SourceForm';
import {
  BACKFILL_DAYS, ConnectDefaults, MetaForm, PageChoice, backfillDaysLabel, backfillResultText, buildConnectRequest, connectResultText, facebookPageUrl, formStatusLabel,
  formsSummary, initialChoices, isPendingGone, needsReconnect, pageSelectability,
} from './metaUtils';

export type MetaStatusWithUrl = MetaStatus & { connectUrl: string };

const errOf = (scope: string, e: unknown) => toAppError(reportError(scope, e));
const errMsg = (scope: string, e: unknown) => errOf(scope, e).userMessage;

export const NOT_SET_UP_TEXT = 'Meta Lead Ads isn’t set up on this platform yet; ask your platform administrator.';
export const LEADS_TESTING_TOOL_URL = 'https://developers.facebook.com/tools/lead-ads-testing';

/** Leave the CRM for the Facebook login (full page — the backend redirects back to /settings). */
export function goToMetaConnect(url: string) {
  if (url) window.location.assign(url);
}

/* -------------------------------- Status ---------------------------------- */

/** Platform Meta status + this user's connect URL (loaded once per mount; skipped when `enabled` is false). */
export function useMetaStatus(enabled: boolean): { status: MetaStatusWithUrl | null; error: string; loading: boolean; reload: () => void } {
  const [status, setStatus] = useState<MetaStatusWithUrl | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setStatus(await api.meta.status());
      setError('');
    } catch (e) {
      setError(errMsg('meta.status', e));
    } finally {
      setLoading(false);
    }
  }, [enabled]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { status, error, loading, reload };
}

/* ----------------------------- Connect panel ------------------------------- */

export const MetaConnectPanel: React.FC<{ status: MetaStatusWithUrl | null; loading: boolean; error: string; onRetry: () => void }> = ({ status, loading, error, onRetry }) => {
  const notSetUp = !!status && (!status.configured || !status.connectUrl);
  return (
    <section aria-labelledby="meta-connect-title" className="rounded-xl border border-[#D3E3F0] bg-white p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <span className="flex-shrink-0 w-9 h-9 rounded-lg bg-[#1877F2] text-white flex items-center justify-center" aria-hidden="true"><Facebook size={18} /></span>
          <div className="min-w-0">
            <h4 id="meta-connect-title" className="text-sm font-bold text-[#0B2A44]">Facebook & Instagram lead ads</h4>
            <p className="text-xs text-[#5E778C]">Connect a Facebook Page and every lead from its Instant Forms — on Facebook or Instagram — arrives here within seconds.</p>
          </div>
        </div>
        <div className="flex-shrink-0">
          <Button
            variant="primary"
            icon={<Facebook size={14} />}
            loading={loading && !status}
            disabled={!status || notSetUp}
            onClick={() => status && goToMetaConnect(status.connectUrl)}
            aria-describedby={notSetUp ? 'meta-not-set-up' : undefined}
          >
            Connect Facebook / Instagram
          </Button>
        </div>
      </div>
      {error && <ErrorState compact title="Could not check Meta Lead Ads" message={error} onRetry={onRetry} />}
      {notSetUp && <InlineNotice tone="warning"><span id="meta-not-set-up">{NOT_SET_UP_TEXT}</span></InlineNotice>}
      <MetaHelp />
    </section>
  );
};

export const MetaHelp: React.FC = () => {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="rounded-lg border border-[#E6EFF6] bg-[#FFFFFF]">
      <button type="button" className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#5E778C] hover:text-[#0B2A44]" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <HelpCircle size={13} aria-hidden="true" /> Help: testing and lead access
      </button>
      {open && (
        <ul id={id} className="px-3 pb-3 pl-8 list-disc space-y-1.5 text-xs text-[#0F2233]">
          <li>
            Test it with Meta’s{' '}
            <a href={LEADS_TESTING_TOOL_URL} target="_blank" rel="noopener noreferrer" className="text-[#0B6BB0] font-semibold hover:underline inline-flex items-center gap-0.5">
              Lead Ads Testing Tool <ExternalLink size={10} aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span>
            </a>{' '}
            (developers.facebook.com/tools/lead-ads-testing): choose the Page and form, submit a test lead and it appears in the intake log here.
          </li>
          <li>If your business uses Leads Access Manager, allow this CRM in Meta Business Suite → Settings → Integrations → Leads access — otherwise Facebook won’t send the leads.</li>
          <li>You need full control or advertiser access on a Page to connect it. Each Page can be linked to one CRM workspace only.</li>
        </ul>
      )}
    </div>
  );
};

/** The Facebook callback came back with `metaError`. */
export const MetaErrorNotice: React.FC<{ message: string; connectUrl?: string; onDismiss: () => void }> = ({ message, connectUrl, onDismiss }) => (
  <div role="alert" className="flex items-start gap-2 p-3 rounded-lg border border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28] text-xs">
    <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
    <div className="flex-1 min-w-0">
      <div className="font-bold">Facebook connection not completed</div>
      <div className="break-words">{message}</div>
    </div>
    <div className="flex gap-1.5 flex-shrink-0">
      {connectUrl && <Button size="xs" icon={<Facebook size={11} />} onClick={() => goToMetaConnect(connectUrl)}>Try again</Button>}
      <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>
    </div>
  </div>
);

/* ------------------------------ Form filter -------------------------------- */

export const FormFilterPicker: React.FC<{
  forms: MetaForm[];
  value: { allForms: boolean; formIds: string[] };
  onChange: (v: { allForms: boolean; formIds: string[] }) => void;
  idPrefix: string;
  disabled?: boolean;
  /** Label for the group (screen readers). */
  label: string;
}> = ({ forms, value, onChange, idPrefix, disabled, label }) => {
  // Saved ids that Facebook no longer lists are still shown so they can be removed.
  const unknown = value.formIds.filter((id) => !forms.some((f) => f.id === id));
  const all: MetaForm[] = [...forms, ...unknown.map((id) => ({ id, name: `Form ${id}`, status: 'UNKNOWN' }))];
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap gap-3 text-xs" role="radiogroup" aria-label={label}>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="radio" name={`${idPrefix}-forms`} className="accent-[#0B6BB0]" checked={value.allForms} onChange={() => onChange({ ...value, allForms: true })} />
          All forms
        </label>
        <label className={cx('inline-flex items-center gap-1.5', all.length ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed')}>
          <input type="radio" name={`${idPrefix}-forms`} className="accent-[#0B6BB0]" checked={!value.allForms} disabled={!all.length} onChange={() => onChange({ ...value, allForms: false })} />
          Only these forms
        </label>
      </div>
      {!all.length && <p className="text-[10px] text-[#7E93A6] mt-1">No lead forms found on this Page yet — new forms are included automatically.</p>}
      {!value.allForms && all.length > 0 && (
        <div className="mt-2 space-y-1 max-h-48 overflow-y-auto pr-1">
          {all.map((f) => {
            const on = value.formIds.includes(f.id);
            const st = formStatusLabel(f.status);
            return (
              <label key={f.id} className={cx('flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer', on ? 'border-[#0B6BB0] bg-[#F5F9FC]' : 'border-[#D3E3F0] bg-white')}>
                <input type="checkbox" className="accent-[#0B6BB0]" checked={on} onChange={() => onChange({ ...value, formIds: on ? value.formIds.filter((x) => x !== f.id) : [...value.formIds, f.id] })} />
                <span className="min-w-0 flex-1 truncate text-[#0B2A44]">{f.name || f.id}</span>
                {st && <Badge tone="muted">{st}</Badge>}
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
};

/* ----------------------------- Connect dialog ------------------------------ */

type PendingState =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; pages: MetaPendingPage[]; expiresAt: string };

export const MetaConnectDialog: React.FC<{
  pendingId: string;
  stageOptions: string[];
  rmOptions: string[];
  connectUrl?: string;
  onClose: () => void;
  onConnected: () => void;
}> = ({ pendingId, stageOptions, rmOptions, connectUrl, onClose, onConnected }) => {
  const [state, setState] = useState<PendingState>({ kind: 'loading' });
  const [choices, setChoices] = useState<Record<string, PageChoice>>({});
  const [defaults, setDefaults] = useState<ConnectDefaults>(() => {
    const f = emptyFormState('meta');
    return { sourceLabel: 'Facebook', defaultStage: stageOptions.includes(f.defaultStage) || !stageOptions.length ? f.defaultStage : stageOptions[0], assignmentMode: 'unassigned', rm: '', rms: [], duplicates: f.duplicates };
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const r = await api.meta.pending(pendingId);
      setChoices(initialChoices(r.pages || []));
      setState({ kind: 'ready', pages: r.pages || [], expiresAt: r.expiresAt });
    } catch (e) {
      const err = errOf('meta.pending', e);
      setState(isPendingGone(err) ? { kind: 'gone' } : { kind: 'error', message: err.userMessage });
    }
  }, [pendingId]);

  useEffect(() => {
    load();
  }, [load]);

  const pages = state.kind === 'ready' ? state.pages : [];
  const setChoice = (id: string, patch: Partial<PageChoice>) => setChoices((prev) => ({ ...prev, [id]: { ...(prev[id] || { checked: false, allForms: true, formIds: [] }), ...patch } }));
  const chosenCount = pages.filter((p) => choices[p.id]?.checked && pageSelectability(p).selectable).length;

  const submit = async () => {
    const { req, errors: errs } = buildConnectRequest(pendingId, pages, choices, defaults);
    setErrors(errs);
    if (errs.length) return;
    setBusy(true);
    try {
      const r = await api.meta.connect(req);
      const t = connectResultText(r, pages);
      toast(t.title, t.message, t.tone);
      onConnected();
    } catch (e) {
      const err = errOf('meta.connect', e);
      if (isPendingGone(err)) setState({ kind: 'gone' });
      else setErrors([err.userMessage]);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      width="lg"
      onClose={busy ? () => undefined : onClose}
      title="Choose Facebook Pages"
      subtitle="Leads from the chosen Pages’ lead forms (on Facebook and Instagram) become CRM leads."
      footer={
        state.kind === 'ready' ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" icon={<Link2 size={13} />} loading={busy} disabled={!chosenCount} onClick={submit}>
              {chosenCount > 1 ? `Connect ${chosenCount} Pages` : 'Connect'}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>Close</Button>
        )
      }
    >
      {state.kind === 'loading' && <LoadingState label="Loading your Facebook Pages…" />}
      {state.kind === 'error' && <ErrorState title="Could not load your Facebook Pages" message={state.message} onRetry={load} />}
      {state.kind === 'gone' && (
        <div className="text-center py-6 space-y-3">
          <p className="text-sm text-[#0F2233]">This Facebook login has expired or was already used — logins are kept for 30 minutes.</p>
          {connectUrl
            ? <Button variant="primary" icon={<Facebook size={14} />} onClick={() => goToMetaConnect(connectUrl)}>Connect again</Button>
            : <p className="text-xs text-[#5E778C]">Close this window and click “Connect Facebook / Instagram” again.</p>}
        </div>
      )}
      {state.kind === 'ready' && (
        <div className="space-y-4">
          {errors.length > 0 && (
            <div role="alert" className="p-3 rounded-lg border border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28] text-xs space-y-0.5">
              {errors.map((e) => <div key={e}>{e}</div>)}
            </div>
          )}
          {pages.length === 0 ? (
            <InlineNotice tone="warning">
              Facebook didn’t share any Pages. During the login choose “Edit settings” (or “Edit access”) and tick the Pages to connect, then{' '}
              {connectUrl ? <button type="button" className="font-semibold underline" onClick={() => goToMetaConnect(connectUrl)}>connect again</button> : 'connect again'}.
            </InlineNotice>
          ) : (
            <fieldset disabled={busy} className="space-y-2 min-w-0">
              <legend className={labelCls}>Pages</legend>
              {pages.map((p) => {
                const sel = pageSelectability(p);
                const c = choices[p.id] || { checked: false, allForms: true, formIds: [] };
                const cbId = `meta-page-${p.id}`;
                return (
                  <div key={p.id} className={cx('rounded-lg border p-3', c.checked && sel.selectable ? 'border-[#0B6BB0] bg-[#F5F9FC]' : 'border-[#D3E3F0] bg-white', !sel.selectable && 'opacity-70')}>
                    <div className="flex items-start gap-2">
                      <input id={cbId} type="checkbox" className="mt-0.5 accent-[#0B6BB0]" checked={c.checked && sel.selectable} disabled={!sel.selectable} aria-describedby={sel.reason ? `${cbId}-why` : undefined} onChange={(e) => setChoice(p.id, { checked: e.target.checked })} />
                      <div className="min-w-0 flex-1">
                        <label htmlFor={cbId} className={cx('text-sm font-bold text-[#0B2A44]', sel.selectable && 'cursor-pointer')}>{p.name || p.id}</label>
                        <div className="text-[10px] text-[#7E93A6]">
                          Page ID {p.id} · {p.forms?.length ? `${p.forms.length} lead form${p.forms.length === 1 ? '' : 's'}` : 'no lead forms yet'}
                        </div>
                        {sel.reason && <div id={`${cbId}-why`} className="text-[11px] text-[#8A3E28] mt-0.5">{sel.reason}</div>}
                      </div>
                      {p.alreadyConnected && <Badge tone="sage">Connected</Badge>}
                    </div>
                    {c.checked && sel.selectable && (
                      <div className="mt-2 pl-6">
                        <FormFilterPicker forms={p.forms || []} value={{ allForms: c.allForms, formIds: c.formIds }} onChange={(v) => setChoice(p.id, v)} idPrefix={cbId} label={`Lead forms of ${p.name}`} />
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
          {pages.length > 0 && (
            <fieldset disabled={busy} className="space-y-3 min-w-0 border-t border-[#E6EFF6] pt-4">
              <legend className="text-xs font-bold text-[#0B2A44]">Settings for the new sources <span className="font-normal text-[#5E778C]">(you can change them per Page later)</span></legend>
              <div>
                <label htmlFor="meta-defaults-label" className={labelCls}>Enquiry Source label</label>
                <input id="meta-defaults-label" className={inputCls} value={defaults.sourceLabel} maxLength={60} placeholder="Facebook" onChange={(e) => setDefaults({ ...defaults, sourceLabel: e.target.value })} />
                <div className="text-[10px] text-[#7E93A6] mt-1">Written to “Enquiry Source” on each new lead.</div>
              </div>
              <RoutingFields value={defaults} onChange={(patch) => setDefaults((d) => ({ ...d, ...patch }))} stageOptions={stageOptions} rmOptions={rmOptions} idPrefix="meta-defaults" />
            </fieldset>
          )}
          {state.expiresAt && <p className="text-[10px] text-[#7E93A6]">This Facebook login can be used until {formatDateTime(state.expiresAt)}.</p>}
        </div>
      )}
    </Modal>
  );
};

/* ------------------------------ Source parts ------------------------------- */

/** Page link, form filter, subscription and last lead of a connected Page. */
export const MetaSummary: React.FC<{ meta: MetaSourceConfig | null | undefined; lastReceivedAt?: string }> = ({ meta, lastReceivedAt }) => {
  const last = meta?.lastLeadAt || lastReceivedAt || '';
  return (
    <dl className="text-[11px] text-[#0F2233] grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt className="text-[#7E93A6]">Page</dt>
      <dd className="min-w-0 truncate">
        {meta?.pageId ? (
          <a href={facebookPageUrl(meta.pageId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#0B6BB0] hover:underline font-semibold">
            {meta.pageName || meta.pageId} <ExternalLink size={11} aria-hidden="true" /><span className="sr-only">(opens Facebook in a new tab)</span>
          </a>
        ) : <span className="text-[#7E93A6]">not set</span>}
      </dd>
      <dt className="text-[#7E93A6]">Forms</dt>
      <dd className="truncate" title={meta?.formIds?.length ? (meta.formIds.map((id) => meta.forms?.find((f) => f.id === id)?.name || id).join(', ')) : undefined}>{formsSummary(meta)}</dd>
      <dt className="text-[#7E93A6]">Webhook</dt>
      <dd>
        {meta?.subscribed
          ? <Badge tone="sage"><span className="inline-flex items-center gap-1"><ShieldCheck size={10} aria-hidden="true" />Subscribed</span></Badge>
          : <Badge tone="amber" title="Facebook is not sending this Page’s leads — click “Check connection”">Not subscribed</Badge>}
      </dd>
      <dt className="text-[#7E93A6]">Last lead</dt>
      <dd>{last ? <span title={formatDateTime(last)}>{formatDistance(last)}</span> : <span className="text-[#7E93A6]">none yet</span>}</dd>
    </dl>
  );
};

/** Last error of a Page, with a "Reconnect" button when the Facebook connection has expired. */
export const MetaLastError: React.FC<{ message: string; connectUrl?: string; canManage: boolean }> = ({ message, connectUrl, canManage }) => {
  if (!message) return null;
  const reconnect = needsReconnect(message);
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-[#8A3E28] bg-[#FAF0EC] border border-[#B06A55]/30 rounded-lg px-2.5 py-1.5">
      <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="break-words">Last error: {message}</span>
        {reconnect && (
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <span className="text-[#5E778C]">The Facebook connection has expired — log in with Facebook again to renew it.</span>
            {canManage && connectUrl && <Button size="xs" icon={<Facebook size={11} />} onClick={() => goToMetaConnect(connectUrl)}>Reconnect</Button>}
          </div>
        )}
      </div>
    </div>
  );
};

/** "Check connection", "Fetch recent leads" and "Disconnect" for a connected Page. */
export const MetaSourceActions: React.FC<{
  source: LeadSource;
  /** After check / backfill (reload the list for fresh values). */
  onRefresh: () => void;
  onDisconnected: (id: string) => void;
  size?: 'xs' | 'sm';
}> = ({ source, onRefresh, onDisconnected, size = 'xs' }) => {
  const [checking, setChecking] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const iconSize = size === 'xs' ? 11 : 12;

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.meta.check(source.id);
      const note = r.subscribed ? '' : ' Facebook is not sending this Page’s leads yet.';
      toast(r.ok ? 'Connection OK' : 'Connection problem', `${r.message || (r.ok ? `${source.name} is connected.` : 'Check failed.')}${note}`, r.ok && r.subscribed ? 'success' : 'warning');
      onRefresh();
    } catch (e) {
      toast('Could not check the connection', errMsg('meta.check', e), 'alert');
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Button size={size} icon={<RefreshCw size={iconSize} />} loading={checking} onClick={check}>Check connection</Button>
      <Button size={size} icon={<CloudDownload size={iconSize} />} onClick={() => setBackfillOpen(true)}>Fetch recent leads</Button>
      <Button size={size} variant="danger" icon={<Link2Off size={iconSize} />} onClick={() => setDisconnectOpen(true)}>Disconnect</Button>
      {backfillOpen && <BackfillDialog source={source} onClose={() => setBackfillOpen(false)} onDone={() => { setBackfillOpen(false); onRefresh(); }} />}
      {disconnectOpen && <DisconnectDialog source={source} onCancel={() => setDisconnectOpen(false)} onDone={() => { setDisconnectOpen(false); onDisconnected(source.id); }} />}
    </>
  );
};

const BackfillDialog: React.FC<{ source: LeadSource; onClose: () => void; onDone: () => void }> = ({ source, onClose, onDone }) => {
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.meta.backfill(source.id, Number(days));
      const t = backfillResultText(r);
      toast(`Fetched leads · ${source.name}`, t.message, t.tone);
      onDone();
    } catch (e) {
      setError(errMsg('meta.backfill', e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      width="sm"
      onClose={busy ? () => undefined : onClose}
      title="Fetch recent leads"
      subtitle={source.config?.meta?.pageName || source.name}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" icon={<CloudDownload size={13} />} loading={busy} onClick={run}>Fetch leads</Button></>}
    >
      <div className="space-y-3 text-sm text-[#0F2233]">
        <p className="text-xs">Reads the Page’s lead forms from Facebook and adds any leads the CRM missed. Leads already in the CRM are not duplicated.</p>
        <div>
          <label htmlFor={`meta-backfill-${source.id}`} className={labelCls}>Period</label>
          <Select id={`meta-backfill-${source.id}`} value={days} disabled={busy} options={BACKFILL_DAYS.map((d) => ({ value: String(d), label: backfillDaysLabel(d) }))} onChange={(e) => setDays(e.target.value)} />
        </div>
        {error && <ErrorState compact title="Could not fetch the leads" message={error} />}
      </div>
    </Modal>
  );
};

const DisconnectDialog: React.FC<{ source: LeadSource; onCancel: () => void; onDone: () => void }> = ({ source, onCancel, onDone }) => {
  const [busy, setBusy] = useState(false);
  const pageName = source.config?.meta?.pageName || source.name;
  const run = async () => {
    setBusy(true);
    try {
      await api.meta.disconnect(source.id);
      toast('Page disconnected', `${pageName} — no new leads will arrive from it.`, 'success');
      onDone();
    } catch (e) {
      toast('Could not disconnect the Page', errMsg('meta.disconnect', e), 'alert');
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      width="sm"
      onClose={busy ? () => undefined : onCancel}
      title="Disconnect this Facebook Page?"
      footer={<><Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button><Button variant="danger" icon={<Link2Off size={13} />} loading={busy} onClick={run}>Disconnect</Button></>}
    >
      <div className="space-y-2 text-sm text-[#0F2233] leading-relaxed">
        <p><b>{pageName}</b> stops sending new leads to the CRM, and the lead source and its saved Facebook access are removed.</p>
        <p className="flex items-start gap-1.5 text-xs text-[#3C573A]"><CheckCircle2 size={13} className="flex-shrink-0 mt-0.5" aria-hidden="true" />Leads it already created stay in the CRM. You can connect the Page again at any time.</p>
      </div>
    </Modal>
  );
};
