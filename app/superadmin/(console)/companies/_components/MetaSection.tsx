'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, Megaphone, RefreshCw, RotateCcw, Settings2 } from 'lucide-react';
import type { CompanyDetail, PlatformActions } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../../_lib/api';
import { FEATURE_LABELS, fmtDateTime, fmtNum } from '../../../_lib/format';
import { normaliseFeatures } from '../../../_components/FeatureToggles';
import { Modal } from '../../../_components/Modal';
import { useToast } from '../../../_components/Toast';
import { Button, Card, CardHeader, EmptyState, ErrorBox, Skeleton, StatusBadge, Table, TableSkeleton, TextAreaField, TextField, cx, focusRing, td, th } from '../../../_components/ui';

type MetaPageRow = PlatformActions['companyMeta']['res'][number];

/** Permissions the Page access token needs (Graph API Explorer → "Permissions"). */
export const META_TOKEN_PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_manage_ads', 'leads_retrieval', 'business_management'];

const NUMERIC_ID = /^\d{5,25}$/;

/** Only numeric Page ids become links (never anything taken verbatim from stored data). */
function PageLink({ pageId, name }: { pageId: string; name: string }) {
  if (!NUMERIC_ID.test(pageId)) return <span className="font-mono text-[12px] text-[#7A6F64]">{pageId || '—'}</span>;
  return (
    <a
      href={`https://facebook.com/${pageId}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cx('inline-flex items-center gap-1 rounded font-mono text-[12px] text-[#1D2F3F] underline-offset-2 hover:underline', focusRing)}
      aria-label={`Open the Facebook Page ${name} (opens in a new tab)`}
    >
      {pageId} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

function FormsCell({ meta }: { meta: MetaPageRow['meta'] }) {
  const ids = meta?.formIds || [];
  if (!ids.length) return <span className="text-[#6B6158]">All forms{meta?.forms?.length ? ` (${meta.forms.length})` : ''}</span>;
  const names = ids.map((id) => meta.forms?.find((f) => f.id === id)?.name || id);
  return (
    <span className="block max-w-[16rem] break-words text-[13px] text-[#3B342E]" title={names.join(', ')}>
      {names.length} selected: {names.join(', ')}
    </span>
  );
}

function SubscribedBadge({ subscribed }: { subscribed: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium ring-1 ring-inset whitespace-nowrap',
        subscribed ? 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]' : 'bg-[#FEF3F2] text-[#B42318] ring-[#F7C5BF]',
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {subscribed ? 'Subscribed' : 'Not subscribed'}
    </span>
  );
}

function PagesTable({ rows }: { rows: MetaPageRow[] }) {
  return (
    <Table label="Connected Facebook Pages">
      <thead className="bg-[#FBF9F6]">
        <tr>
          <th scope="col" className={th}>Page</th>
          <th scope="col" className={th}>Forms</th>
          <th scope="col" className={th}>Webhook</th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={th}>Last lead</th>
          <th scope="col" className={cx(th, 'text-right')}>Received</th>
          <th scope="col" className={cx(th, 'text-right')}>Created</th>
          <th scope="col" className={cx(th, 'text-right')}>Duplicates</th>
          <th scope="col" className={cx(th, 'text-right')}>Failed</th>
          <th scope="col" className={th}>Last error</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#F1ECE6]">
        {rows.map((r) => {
          const m = r.meta;
          const lastLead = m?.lastLeadAt || r.stats?.lastReceivedAt;
          return (
            <tr key={r.sourceId}>
              <td className={td}>
                <span className="font-medium text-[#14202B]">{m?.pageName || r.name}</span>
                <span className="block">
                  <PageLink pageId={m?.pageId || ''} name={m?.pageName || r.name} />
                </span>
                {m?.connectedAt && (
                  <span className="block text-[12px] text-[#7A6F64]">
                    Connected {fmtDateTime(m.connectedAt)}
                    {m.connectedBy ? ` by ${m.connectedBy}` : ''}
                  </span>
                )}
              </td>
              <td className={td}>
                <FormsCell meta={m} />
              </td>
              <td className={td}>
                <SubscribedBadge subscribed={Boolean(m?.subscribed)} />
              </td>
              <td className={td}>
                <StatusBadge status={r.status} />
              </td>
              <td className={cx(td, 'whitespace-nowrap')}>{lastLead ? fmtDateTime(lastLead) : 'Never'}</td>
              <td className={cx(td, 'text-right tabular-nums')}>{fmtNum(r.stats?.received ?? 0)}</td>
              <td className={cx(td, 'text-right tabular-nums', (r.stats?.created ?? 0) > 0 && 'text-[#067647]')}>{fmtNum(r.stats?.created ?? 0)}</td>
              <td className={cx(td, 'text-right tabular-nums', (r.stats?.duplicates ?? 0) > 0 && 'text-[#3538CD]')}>{fmtNum(r.stats?.duplicates ?? 0)}</td>
              <td className={cx(td, 'text-right tabular-nums', (r.stats?.failed ?? 0) > 0 && 'font-semibold text-[#B42318]')}>{fmtNum(r.stats?.failed ?? 0)}</td>
              <td className={td}>
                {m?.lastError ? (
                  <span className="block max-w-[22rem] break-words text-[13px] text-[#912018]">
                    <AlertTriangle className="mr-1 inline h-3.5 w-3.5 -translate-y-px" aria-hidden />
                    {m.lastError}
                  </span>
                ) : (
                  <span className="text-[#7A6F64]">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** Parses "one form id per line / comma separated" into ids, or returns the first bad entry. */
function parseFormIds(text: string): { ids: string[]; bad: string } {
  const ids: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim();
    if (!v) continue;
    if (!NUMERIC_ID.test(v)) return { ids: [], bad: v };
    if (!ids.includes(v)) ids.push(v);
  }
  return { ids, bad: '' };
}

interface ConnectForm {
  pageId: string;
  token: string;
  forms: string;
}
const EMPTY: ConnectForm = { pageId: '', token: '', forms: '' };

function ConnectPageDialog({ open, onClose, company, onConnected }: { open: boolean; onClose: () => void; company: CompanyDetail; onConnected: (sourceId: string) => void }) {
  const [f, setF] = useState<ConnectForm>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof ConnectForm, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setF(EMPTY);
      setErrors({});
      setError('');
    }
  }, [open]);

  const set = <K extends keyof ConnectForm>(k: K, v: ConnectForm[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setError('');
  };

  const close = () => {
    if (busy) return;
    setF(EMPTY); // never keep a pasted token around
    onClose();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const errs: Partial<Record<keyof ConnectForm, string>> = {};
    const pageId = f.pageId.trim();
    const token = f.token.replace(/\s+/g, '');
    if (!pageId) errs.pageId = 'Enter the numeric Page ID.';
    else if (!NUMERIC_ID.test(pageId)) errs.pageId = 'A Page ID is a number (found under the Page’s About › Page transparency, or in Graph API Explorer).';
    if (!token) errs.token = 'Paste the Page access token.';
    else if (token.length < 40 || !/^[A-Za-z0-9_-]+$/.test(token)) errs.token = 'This does not look like an access token. Copy the whole token from Graph API Explorer.';
    const { ids, bad } = parseFormIds(f.forms);
    if (bad) errs.forms = `“${bad}” is not a lead form ID (form IDs are numbers).`;
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    setError('');
    try {
      const res = await call('connectCompanyMetaPage', { companyId: company.id, pageId, pageAccessToken: token, ...(ids.length ? { formIds: ids } : {}) });
      setF(EMPTY);
      onConnected(res.sourceId);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      busy={busy}
      size="lg"
      title="Connect a Facebook Page on behalf"
      description={`For ${company.name}. Normally the company's admin connects Pages with “Continue with Facebook” in CRM settings — use this when they can't.`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="connect-meta-page" loading={busy} icon={<Link2 className="h-4 w-4" aria-hidden />}>
            Connect Page
          </Button>
        </>
      }
    >
      <form id="connect-meta-page" onSubmit={submit} noValidate className="space-y-4">
        <div className="rounded-lg border border-[#E4DCD2] bg-[#FBF9F6] px-4 py-3 text-[13.5px] leading-relaxed text-[#3B342E]">
          <p className="font-medium text-[#1D2F3F]">How to get a Page access token</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5">
            <li>
              Sign in to Facebook as someone with full control of the company&apos;s Page and open{' '}
              <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener noreferrer" className={cx('rounded font-medium text-[#1D2F3F] underline underline-offset-2', focusRing)}>
                Graph API Explorer
              </a>
              .
            </li>
            <li>Under “Meta App” choose the platform&apos;s app; under “Permissions” add:</li>
          </ol>
          <ul className="my-1.5 flex flex-wrap gap-1.5 pl-5">
            {META_TOKEN_PERMISSIONS.map((p) => (
              <li key={p} className="rounded bg-white px-1.5 py-0.5 font-mono text-[12px] text-[#26211E] ring-1 ring-inset ring-[#E4DCD2]">
                {p}
              </li>
            ))}
          </ul>
          <ol start={3} className="list-decimal space-y-1 pl-5">
            <li>Click “Generate Access Token” and approve, then under “User or Page” select the company&apos;s Page — the token shown is now the Page token.</li>
            <li>Copy the token and the Page ID here. A token generated from a long-lived user token (Access Token Debugger › Extend) does not expire.</li>
          </ol>
        </div>

        <TextField
          label="Page ID"
          required
          value={f.pageId}
          onChange={(e) => set('pageId', e.target.value)}
          error={errors.pageId}
          placeholder="e.g. 104857392018475"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={25}
        />
        <TextAreaField
          label="Page access token"
          required
          value={f.token}
          onChange={(e) => set('token', e.target.value)}
          error={errors.token}
          hint="Sent once over HTTPS, checked with Meta and stored encrypted. It is never shown again."
          placeholder="EAAG…"
          rows={4}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore
          data-lpignore="true"
          className="[&_textarea]:font-mono [&_textarea]:text-[12.5px] [&_textarea]:break-all"
        />
        <TextAreaField
          label="Lead form IDs (optional)"
          value={f.forms}
          onChange={(e) => set('forms', e.target.value)}
          error={errors.forms}
          hint="One per line or comma-separated. Leave empty to take leads from every form of the Page."
          placeholder={'1234567890123456\n2345678901234567'}
          rows={2}
          spellCheck={false}
          autoComplete="off"
        />
        <ErrorBox message={error} />
      </form>
    </Modal>
  );
}

/** Company detail → Integrations: the company's connected Facebook Pages (Meta Lead Ads). */
export function MetaSection({ company, onSaved, onSourcesChanged }: { company: CompanyDetail; onSaved: (c: CompanyDetail) => void; onSourcesChanged?: () => void }) {
  const toast = useToast();
  const uid = useId();
  const pages = useResource(() => call('companyMeta', { companyId: company.id }), [company.id]);
  const platform = useResource(() => call('getMetaSettings', {}), []);
  const [enabling, setEnabling] = useState(false);
  const [featureError, setFeatureError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const featureOn = company.features?.metaLeads === true;
  const rows = pages.data || [];
  const notConfigured = platform.data ? !platform.data.configured : false;
  const failedTotal = rows.reduce((n, r) => n + (r.stats?.failed ?? 0), 0);

  const enable = async () => {
    setEnabling(true);
    setFeatureError('');
    try {
      const updated = await call('updateCompany', { id: company.id, patch: { features: { ...normaliseFeatures(company.features), metaLeads: true } } });
      onSaved(updated);
      toast(`${FEATURE_LABELS.metaLeads} switched on.`);
    } catch (e) {
      setFeatureError(errorMessage(e));
    } finally {
      setEnabling(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      const res = await call('retryMetaQueue', { companyId: company.id });
      toast(res.retried ? `${fmtNum(res.retried)} failed lead${res.retried === 1 ? '' : 's'} queued again.` : 'No failed leads to retry.');
      pages.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setRetrying(false);
    }
  };

  const reload = () => {
    pages.reload();
    platform.reload();
  };

  const connectButton = (
    <Button size="sm" icon={<Link2 className="h-3.5 w-3.5" aria-hidden />} onClick={() => setConnecting(true)} disabled={notConfigured}>
      Connect a Page on behalf
    </Button>
  );

  return (
    <Card aria-labelledby={`${uid}-meta`}>
      <CardHeader
        id={`${uid}-meta`}
        title="Meta Lead Ads (Facebook / Instagram)"
        description="Facebook Pages whose Lead Ads forms (on Facebook and Instagram) send leads straight into this company's CRM. The company connects Pages in CRM settings → Lead sources."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={reload}
              loading={(pages.loading && Boolean(pages.data)) || (platform.loading && Boolean(platform.data))}
              icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              aria-label="Refresh Meta Lead Ads"
            >
              Refresh
            </Button>
            {rows.length > 0 && (
              <Button variant="secondary" size="sm" loading={retrying} onClick={retry} icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}>
                Retry failed leads{failedTotal > 0 ? ` (${fmtNum(failedTotal)})` : ''}
              </Button>
            )}
            {(rows.length > 0 || pages.loading) && connectButton}
          </>
        }
      />

      <div className="space-y-3 px-5 pt-4">
        {featureOn ? (
          <p className="flex items-center gap-2 text-[13.5px] text-[#3B342E]">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#067647]" aria-hidden />
            Plan feature “{FEATURE_LABELS.metaLeads}”: <span className="font-medium text-[#067647]">on for this company</span>
          </p>
        ) : (
          <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-[14px] text-[#93370D]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p>{FEATURE_LABELS.metaLeads} is switched off for this company — leads from its Pages are not imported and it cannot connect new Pages.</p>
              <ErrorBox message={featureError} className="mt-2" />
            </div>
            <Button size="sm" variant="secondary" loading={enabling} onClick={enable}>
              Switch it on
            </Button>
          </div>
        )}

        {platform.loading && !platform.data ? (
          <Skeleton className="h-5 w-72" />
        ) : platform.error ? (
          <ErrorBox message={`Could not check the platform Meta app: ${platform.error}`} onRetry={platform.reload} />
        ) : notConfigured ? (
          <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-[#F7C5BF] bg-[#FEF3F2] px-4 py-3 text-[14px] text-[#912018]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">The platform&apos;s Meta app is not configured yet, so no company can connect Facebook Pages or receive Lead Ads.</p>
            <Link href="/superadmin/settings" className={cx('inline-flex items-center gap-1.5 rounded font-medium text-[#912018] underline underline-offset-2', focusRing)}>
              <Settings2 className="h-4 w-4" aria-hidden /> Set it up in Platform settings
            </Link>
          </div>
        ) : null}
      </div>

      <ErrorBox message={pages.error} onRetry={pages.reload} className="mx-5 mt-4" />

      {pages.loading && !pages.data ? (
        <div className="pb-2 pt-2">
          <TableSkeleton rows={2} cols={6} />
        </div>
      ) : pages.data && rows.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="h-5 w-5" aria-hidden />}
          title="No Facebook Pages connected"
          description="The company's administrators connect Pages with “Continue with Facebook” in CRM settings → Lead sources, or you can connect one on their behalf with a Page access token."
          action={connectButton}
        />
      ) : pages.data ? (
        <div className={cx('pb-2 pt-3 transition-opacity', pages.loading && 'opacity-60')}>
          <PagesTable rows={rows} />
        </div>
      ) : (
        <div className="pb-4" />
      )}

      <ConnectPageDialog
        open={connecting}
        onClose={() => setConnecting(false)}
        company={company}
        onConnected={() => {
          toast('Facebook Page connected.');
          pages.reload();
          onSourcesChanged?.();
        }}
      />
    </Card>
  );
}
