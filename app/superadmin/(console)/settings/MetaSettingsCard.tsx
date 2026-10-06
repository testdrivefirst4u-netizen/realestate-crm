'use client';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, PlugZap, RefreshCw, RotateCcw, Save, Settings2 } from 'lucide-react';
import type { PlatformActions } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../_lib/api';
import { fmtDateTime, fmtNum } from '../../_lib/format';
import { ConfirmDialog } from '../../_components/Modal';
import { CopyRow } from '../../_components/SecretPanel';
import { useToast } from '../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, Skeleton, TextField, cx, focusRing } from '../../_components/ui';
import { Field, Guide, StatusPill, TestResult } from './SettingsParts';

type MetaSettings = PlatformActions['getMetaSettings']['res'];

const DEFAULT_GRAPH_VERSION = 'v23.0';
const GRAPH_VERSION_RE = /^v\d{2}\.\d$/;
const APP_ID_RE = /^\d{5,25}$/;
const LOGIN_CONFIG_RE = /^\d{5,25}$/;

/** Permissions to request Advanced Access for in App Review. */
const APP_REVIEW_PERMISSIONS = ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_manage_ads', 'business_management'];

interface Form {
  appId: string;
  appSecret: string;
  graphVersion: string;
  loginConfigId: string;
}

function formFrom(s: MetaSettings | null): Form {
  return { appId: s?.appId || '', appSecret: '', graphVersion: s?.graphVersion || DEFAULT_GRAPH_VERSION, loginConfigId: s?.loginConfigId || '' };
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx('rounded font-medium text-[#1D2F3F] underline underline-offset-2', focusRing)}>
      {children}
    </a>
  );
}

const B = ({ children }: { children: ReactNode }) => <strong className="font-medium">{children}</strong>;
const Code = ({ children }: { children: ReactNode }) => <span className="rounded bg-white px-1 font-mono text-[12.5px] ring-1 ring-inset ring-[#E4DCD2]">{children}</span>;

function MetaGuide() {
  return (
    <Guide title="How to set up the Meta app">
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Open <ExtLink href="https://developers.facebook.com/apps/">developers.facebook.com</ExtLink> → <B>My Apps</B> → <B>Create app</B>, and choose the app type <B>Business</B>. Connect it to the platform&apos;s Business portfolio.
        </li>
        <li>
          In the app dashboard, add the products <B>Facebook Login for Business</B> and <B>Webhooks</B>.
        </li>
        <li>
          <B>Webhooks</B>: choose the object <B>Page</B> and click <B>Subscribe to this object</B>. Paste the <B>Webhook callback URL</B> and the <B>Verify token</B> shown above, then click <B>Verify and save</B>. In the list of fields, subscribe to <Code>leadgen</Code>.
        </li>
        <li>
          <B>Facebook Login for Business › Settings</B>: add the <B>OAuth redirect URI</B> shown above under <B>Valid OAuth Redirect URIs</B> and save. Optionally create a <B>Configuration</B> (with the permissions below) and paste its ID into the form.
        </li>
        <li>
          <B>App settings › Basic</B>: fill in the <B>Privacy policy URL</B>, the <B>User data deletion</B> URL and the <B>Category</B>. Copy the <B>App ID</B> and the <B>App Secret</B> (click Show) into the form above and save, then click <B>Test</B>.
        </li>
        <li>
          <B>App Review › Permissions and features</B>: request <B>Advanced Access</B> for{' '}
          {APP_REVIEW_PERMISSIONS.map((p, i) => (
            <span key={p}>
              <Code>{p}</Code>
              {i < APP_REVIEW_PERMISSIONS.length - 1 ? ', ' : ''}
            </span>
          ))}
          . Include a screencast of the connect flow (CRM settings → Lead sources → Continue with Facebook → choose a Page → a test lead arriving).
        </li>
        <li>
          Complete <B>Business verification</B> for the Business portfolio that owns the app.
        </li>
        <li>
          Switch the app mode from <B>Development</B> to <B>Live</B>.
        </li>
      </ol>
      <p className="mt-3">
        Test it end-to-end with the <ExtLink href="https://developers.facebook.com/tools/lead-ads-testing">Lead Ads Testing Tool</ExtLink>: pick a connected Page and form, create a test lead and check that it appears in the company&apos;s CRM.
      </p>
      <p className="mt-2 text-[13px] text-[#6B6158]">
        Companies whose Business uses the <B>Leads Access Manager</B> must allow this app: <B>Meta Business Suite › Settings › Integrations › Leads access</B> → choose the Page → <B>CRMs</B> → add the app. Otherwise Meta refuses to hand over their leads.
      </p>
    </Guide>
  );
}

function MetaSkeleton() {
  return (
    <div role="status" aria-label="Loading Meta settings" className="space-y-4 p-5">
      <Skeleton className="h-5 w-40" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function QueueStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] font-medium uppercase tracking-wide text-[#7A6F64]">{label}</dt>
      <dd className={cx('mt-0.5 text-[15px] font-semibold tabular-nums text-[#14202B]', value > 0 && tone)}>{fmtNum(value)}</dd>
    </div>
  );
}

/** Platform settings → Meta (Facebook / Instagram) Lead Ads: the platform's single Meta app. */
export function MetaSettingsCard() {
  const toast = useToast();
  const uid = useId();
  const settings = useResource(() => call('getMetaSettings', {}), []);
  const s = settings.data;

  const [f, setF] = useState<Form>(formFrom(null));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const [retrying, setRetrying] = useState(false);

  const [regenOpen, setRegenOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState('');

  // Fill the form from the stored values once they first load (later reloads keep unsaved edits).
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (s && !filled) {
      setF(formFrom(s));
      setFilled(true);
    }
  }, [s, filled]);

  const editable = s ? s.source !== 'env' : false;
  const queue = s?.queue;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setSaveError('');
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const errs: Partial<Record<keyof Form, string>> = {};
    const appId = f.appId.trim();
    const appSecret = f.appSecret.trim();
    const graphVersion = f.graphVersion.trim() || DEFAULT_GRAPH_VERSION;
    const loginConfigId = f.loginConfigId.trim();
    if (!appId) errs.appId = 'Enter the App ID (App settings › Basic).';
    else if (!APP_ID_RE.test(appId)) errs.appId = 'The App ID is a number.';
    if (!appSecret && !(s?.configured && s.source === 'platform')) errs.appSecret = 'Enter the App Secret (App settings › Basic › Show).';
    else if (appSecret && !/^[a-f0-9]{32}$/i.test(appSecret)) errs.appSecret = 'An App Secret is 32 letters and digits (0–9, a–f).';
    if (!GRAPH_VERSION_RE.test(graphVersion)) errs.graphVersion = `Use the form vNN.N, e.g. ${DEFAULT_GRAPH_VERSION}.`;
    if (loginConfigId && !LOGIN_CONFIG_RE.test(loginConfigId)) errs.loginConfigId = 'The configuration ID is a number.';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSaving(true);
    setSaveError('');
    try {
      const updated = await call('setMetaSettings', { appId, appSecret, graphVersion, loginConfigId });
      settings.setData(updated);
      setF(formFrom(updated));
      setTest(null);
      toast('Meta app settings saved.');
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await call('testMetaSettings', {}));
    } catch (err) {
      setTest({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      const res = await call('retryMetaQueue', { companyId: '' });
      toast(res.retried ? `${fmtNum(res.retried)} failed lead${res.retried === 1 ? '' : 's'} queued again.` : 'No failed leads to retry.');
      settings.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setRetrying(false);
    }
  };

  const regenerate = async () => {
    if (!s) return;
    setRegenerating(true);
    setRegenError('');
    try {
      const updated = await call('setMetaSettings', { appId: s.appId, appSecret: '', verifyToken: '__generate__' });
      settings.setData(updated);
      setRegenOpen(false);
      toast('New verify token generated — update it in the Meta app’s Webhooks settings.');
    } catch (err) {
      setRegenError(errorMessage(err));
    } finally {
      setRegenerating(false);
    }
  };

  const secretStored = Boolean(s?.configured && s.source === 'platform');

  return (
    <Card aria-labelledby={`${uid}-m`} className="mt-6">
      <CardHeader
        id={`${uid}-m`}
        title="Meta (Facebook / Instagram) Lead Ads"
        description="One Meta app receives Lead Ads from every company's connected Facebook Pages (forms on Facebook and Instagram) through a single webhook."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={settings.reload}
              loading={settings.loading && Boolean(s)}
              icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              aria-label="Refresh Meta settings"
            >
              Refresh
            </Button>
            {s?.configured ? (
              <Button variant="secondary" size="sm" loading={testing} onClick={runTest} icon={<PlugZap className="h-3.5 w-3.5" aria-hidden />}>
                Test
              </Button>
            ) : null}
          </>
        }
      />

      <ErrorBox message={settings.error} onRetry={settings.reload} className="m-4" />

      {settings.loading && !s ? (
        <MetaSkeleton />
      ) : s ? (
        <div className="space-y-5 p-5">
          {/* Status */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill configured={s.configured} />
            {s.source === 'env' && <span className="text-[13px] text-[#6B6158]">from the environment</span>}
            {s.source === 'platform' && <span className="text-[13px] text-[#6B6158]">stored in the platform (App Secret encrypted)</span>}
          </div>

          {s.source === 'env' ? (
            <p className="rounded-lg border border-[#E4DCD2] bg-[#FBF9F6] px-4 py-3 text-[13.5px] text-[#3B342E]">
              Set by the <span className="font-mono">META_APP_ID</span>, <span className="font-mono">META_APP_SECRET</span>, <span className="font-mono">META_VERIFY_TOKEN</span>,{' '}
              <span className="font-mono">META_GRAPH_VERSION</span> and <span className="font-mono">META_LOGIN_CONFIG_ID</span> environment variables — change them there. They cannot be edited from this console.
            </p>
          ) : !s.configured ? (
            <p className="text-[13.5px] text-[#6B6158]">
              No Meta app yet. Until one is added, companies cannot connect Facebook Pages and no Lead Ads are received. Follow the guide below, then save the App ID and App Secret.
            </p>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="App ID">{s.appId ? <span className="font-mono">{s.appId}</span> : '—'}</Field>
            <Field label="Graph API version">{s.graphVersion ? <span className="font-mono">{s.graphVersion}</span> : '—'}</Field>
            <Field label="Login configuration ID">{s.loginConfigId ? <span className="font-mono">{s.loginConfigId}</span> : 'Not set (standard Facebook Login)'}</Field>
            <Field label="Updated">{s.updatedAt ? fmtDateTime(s.updatedAt) : '—'}</Field>
            <Field label="Updated by">{s.updatedBy || '—'}</Field>
          </dl>

          {/* Lead queue */}
          {queue && (
            <section aria-labelledby={`${uid}-q`} className="rounded-lg border border-[#EFE9E2] bg-[#FBF9F6] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`${uid}-q`} className="text-[13px] font-semibold uppercase tracking-wide text-[#6B6158]">
                  Lead queue (all companies)
                </h3>
                <Button variant="secondary" size="sm" loading={retrying} onClick={retry} disabled={!queue.failed} icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}>
                  Retry failed
                </Button>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-3">
                <QueueStat label="Pending" value={queue.pending} tone="text-[#B54708]" />
                <QueueStat label="Failed" value={queue.failed} tone="text-[#B42318]" />
                <QueueStat label="Done (24 h)" value={queue.done24h} tone="text-[#067647]" />
              </dl>
            </section>
          )}

          {/* Values for the Meta app dashboard */}
          <section aria-labelledby={`${uid}-v`} className="space-y-3">
            <div>
              <h3 id={`${uid}-v`} className="text-[14px] font-semibold text-[#14202B]">
                Paste into the Meta app dashboard
              </h3>
              <p className="mt-0.5 text-[13px] text-[#7A6F64]">Webhooks › Page (field <span className="font-mono">leadgen</span>) and Facebook Login › Settings.</p>
            </div>
            {s.webhookUrl && <CopyRow label="Webhook callback URL" value={s.webhookUrl} />}
            {s.verifyToken ? (
              <div className="space-y-1.5">
                <CopyRow label="Verify token" value={s.verifyToken} />
                {editable && (
                  <Button variant="ghost" size="sm" onClick={() => setRegenOpen(true)} icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />}>
                    Generate new
                  </Button>
                )}
              </div>
            ) : (
              editable && <p className="text-[13.5px] text-[#6B6158]">No verify token yet — one is generated when the app is saved.</p>
            )}
            {s.oauthRedirectUri && <CopyRow label="OAuth redirect URI" value={s.oauthRedirectUri} />}
          </section>
        </div>
      ) : null}

      {test && <TestResult test={test} okLabel="The Meta app works. " failLabel="The Meta app check failed. " />}

      {s && editable && (
        <form onSubmit={save} noValidate className="space-y-4 border-t border-[#EFE9E2] p-5" aria-labelledby={`${uid}-f`}>
          <h3 id={`${uid}-f`} className="flex items-center gap-2 text-[14px] font-semibold text-[#14202B]">
            <Settings2 className="h-4 w-4 text-[#A9825A]" aria-hidden />
            {s.configured ? 'Meta app' : 'Add the Meta app'}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="App ID"
              required
              value={f.appId}
              onChange={(e) => set('appId', e.target.value)}
              error={errors.appId}
              placeholder="e.g. 1234567890123456"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={25}
            />
            <TextField
              label="App Secret"
              required={!secretStored}
              type="password"
              value={f.appSecret}
              onChange={(e) => set('appSecret', e.target.value)}
              error={errors.appSecret}
              placeholder={secretStored ? '•••• stored' : '32-character secret'}
              hint={secretStored ? '•••• stored — leave empty to keep the current secret.' : 'Stored encrypted; never shown again.'}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={64}
              data-1p-ignore
              data-lpignore="true"
            />
            <TextField
              label="Graph API version"
              value={f.graphVersion}
              onChange={(e) => set('graphVersion', e.target.value)}
              error={errors.graphVersion}
              placeholder={DEFAULT_GRAPH_VERSION}
              hint={`Format vNN.N. Defaults to ${DEFAULT_GRAPH_VERSION}.`}
              autoComplete="off"
              spellCheck={false}
              maxLength={8}
            />
            <TextField
              label="Login for Business configuration ID"
              value={f.loginConfigId}
              onChange={(e) => set('loginConfigId', e.target.value)}
              error={errors.loginConfigId}
              placeholder="Optional"
              hint="Facebook Login for Business › Configurations. Leave empty to request the permissions directly."
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={25}
            />
          </div>
          <ErrorBox message={saveError} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={saving} icon={<Save className="h-4 w-4" aria-hidden />}>
              Save
            </Button>
            {s.configured && (
              <Button variant="secondary" loading={testing} disabled={saving} onClick={runTest} icon={<PlugZap className="h-4 w-4" aria-hidden />}>
                Test
              </Button>
            )}
          </div>
        </form>
      )}

      <div className="border-t border-[#EFE9E2] p-5">
        <MetaGuide />
      </div>

      <ConfirmDialog
        open={regenOpen}
        onClose={() => {
          if (regenerating) return;
          setRegenOpen(false);
          setRegenError('');
        }}
        busy={regenerating}
        error={regenError}
        onConfirm={regenerate}
        tone="danger"
        title="Generate a new verify token?"
        confirmLabel="Generate new token"
        description="The current token stops matching. Paste the new token into the Meta app (Webhooks › Page › Edit subscription) right away, or Meta cannot re-verify the webhook. Leads already subscribed keep arriving, signed with the App Secret."
      />
    </Card>
  );
}
