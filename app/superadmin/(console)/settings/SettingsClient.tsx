'use client';
import { useId, useState, type FormEvent } from 'react';
import { FileKey2, PlugZap, Save, Trash2 } from 'lucide-react';
import type { PlatformActions } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../_lib/api';
import { fmtDateTime } from '../../_lib/format';
import { ConfirmDialog } from '../../_components/Modal';
import { CopyRow } from '../../_components/SecretPanel';
import { useToast } from '../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, PageHeader, Skeleton, TextAreaField } from '../../_components/ui';
import { GoogleOAuthSection } from './GoogleOAuthSection';
import { MetaSettingsCard } from './MetaSettingsCard';
import { BrandingCard } from './BrandingCard';
import { Field, Guide, StatusPill, TestResult } from './SettingsParts';

type GoogleSettings = PlatformActions['getGoogleSettings']['res'];

/**
 * Client-side sanity checks on a pasted service-account key. Returns an error message or ''.
 * Messages never echo the key's content, and the key is never logged.
 */
function checkServiceAccountJson(text: string): string {
  const raw = text.trim();
  if (!raw) return 'Paste the contents of the JSON key file.';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'This is not valid JSON. Paste the whole downloaded key file, from the opening { to the closing }.';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'The key must be a JSON object.';
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'service_account') return 'This is not a service-account key ("type" must be "service_account"). Create a key for a service account, not an OAuth client.';
  if (typeof o.client_email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(o.client_email)) return 'The key has no "client_email".';
  if (typeof o.private_key !== 'string' || !o.private_key.includes('PRIVATE KEY')) return 'The key has no "private_key".';
  return '';
}

function StatusSkeleton() {
  return (
    <div role="status" aria-label="Loading Google settings" className="space-y-4 p-5">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-12 w-full" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    </div>
  );
}

function StatusPanel({ s }: { s: GoogleSettings }) {
  return (
    <div className="space-y-4 px-5 pb-5 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill configured={s.configured} />
        {s.source === 'env' && <span className="text-[13px] text-[#6B6158]">from the environment</span>}
        {s.source === 'platform' && <span className="text-[13px] text-[#6B6158]">stored encrypted in the platform</span>}
      </div>

      {s.source === 'env' ? (
        <p className="rounded-lg border border-[#E4DCD2] bg-[#FBF9F6] px-4 py-3 text-[13.5px] text-[#3B342E]">
          Set by the <span className="font-mono">GOOGLE_SERVICE_ACCOUNT_JSON</span> environment variable — change it there. It cannot be edited from this console.
        </p>
      ) : s.source === 'none' || !s.configured ? (
        <p className="text-[13.5px] text-[#6B6158]">
          No service account yet. Companies can still use “Connect with Google” when the OAuth client above is configured.
        </p>
      ) : null}

      {s.configured && s.serviceAccountEmail && (
        <>
          <CopyRow label="Service-account e-mail" value={s.serviceAccountEmail} />
          <p className="text-[13px] text-[#6B6158]">
            Companies share their sheets with this address — <strong className="font-medium text-[#3B342E]">Viewer</strong> to import leads,{' '}
            <strong className="font-medium text-[#3B342E]">Editor</strong> to export leads or write the import status column.
          </p>
        </>
      )}

      {s.configured && (
        <dl className="grid gap-4 sm:grid-cols-3">
          <Field label="Project ID">{s.projectId ? <span className="font-mono">{s.projectId}</span> : '—'}</Field>
          <Field label="Updated">{s.updatedAt ? fmtDateTime(s.updatedAt) : '—'}</Field>
          <Field label="Updated by">{s.updatedBy || '—'}</Field>
        </dl>
      )}
    </div>
  );
}

function HowToGuide() {
  return (
    <Guide title="How to create the service account">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            Open the{' '}
            <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="font-medium text-[#1D2F3F] underline underline-offset-2">
              Google Cloud Console
            </a>{' '}
            and create a project (or select an existing one).
          </li>
          <li>
            Go to <strong className="font-medium">APIs &amp; Services → Library</strong>, search for <strong className="font-medium">Google Sheets API</strong> and click <strong className="font-medium">Enable</strong>.
          </li>
          <li>
            Go to <strong className="font-medium">IAM &amp; Admin → Service accounts</strong> and click <strong className="font-medium">Create service account</strong>. Give it a name (e.g. “Amaya CRM sheets”). No roles are needed — skip the optional steps.
          </li>
          <li>
            Open the new service account, go to the <strong className="font-medium">Keys</strong> tab, click <strong className="font-medium">Add key → Create new key</strong>, choose <strong className="font-medium">JSON</strong> and create it. A <span className="font-mono">.json</span> file is downloaded.
          </li>
          <li>Open that file in a text editor, copy everything and paste it into the box below, then save.</li>
          <li>
            Companies then share their Google Sheets with the service-account e-mail shown above — <strong className="font-medium">Viewer</strong> is enough to import leads; <strong className="font-medium">Editor</strong> is needed to export leads or to write the import status back.
          </li>
        </ol>
        <p className="mt-3 text-[13px] text-[#6B6158]">Keep the key file private and delete the downloaded copy once it is saved here — it is stored encrypted.</p>
    </Guide>
  );
}

export function SettingsClient() {
  const toast = useToast();
  const uid = useId();
  const settings = useResource(() => call('getGoogleSettings', {}), []);
  const s = settings.data;

  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const editable = s ? s.source !== 'env' : false;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const problem = checkServiceAccountJson(json);
    setJsonError(problem);
    if (problem) return;
    setSaving(true);
    setSaveError('');
    try {
      const updated = await call('setGoogleServiceAccount', { json: json.trim() });
      settings.setData(updated);
      setJson('');
      setTest(null);
      toast('Google service account saved.');
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setRemoveError('');
    try {
      const updated = await call('setGoogleServiceAccount', { json: '' });
      settings.setData(updated);
      setRemoveOpen(false);
      setTest(null);
      toast('Google service account removed.');
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await call('testGoogleServiceAccount', {});
      setTest(res);
    } catch (err) {
      setTest({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHeader title="Platform settings" description="Settings that apply to every company on the platform." />

      <BrandingCard />

      <Card aria-labelledby={`${uid}-g`}>
        <CardHeader
          id={`${uid}-g`}
          title="Google Sheets"
          description="Lets every company import leads from and export leads to Google Sheets — by connecting a Google account (recommended) or by sharing sheets with the platform service account."
          actions={s ? <StatusPill configured={s.oauthConfigured || s.configured} /> : null}
        />

        <ErrorBox message={settings.error} onRetry={settings.reload} className="m-4" />
        {settings.loading && !s ? <StatusSkeleton /> : null}

        {s && <GoogleOAuthSection s={s} onUpdated={settings.setData} />}

        {s && (
          <section aria-labelledby={`${uid}-sa`} className="border-t border-[#EFE9E2]">
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
              <div className="min-w-0">
                <h3 id={`${uid}-sa`} className="flex items-center gap-2 text-[15px] font-semibold text-[#14202B]">
                  <FileKey2 className="h-4 w-4 text-[#A9825A]" aria-hidden />
                  Service account (alternative)
                </h3>
                <p className="mt-1 text-[13.5px] text-[#6B6158]">One Google service account; companies share their sheets with its e-mail address.</p>
              </div>
              {s.configured ? (
                <Button variant="secondary" size="sm" loading={testing} onClick={runTest} icon={<PlugZap className="h-3.5 w-3.5" aria-hidden />}>
                  Test connection
                </Button>
              ) : null}
            </div>

            <StatusPanel s={s} />

            {test && <TestResult test={test} />}

            {editable && (
              <form onSubmit={save} noValidate className="space-y-4 border-t border-[#EFE9E2] p-5" aria-labelledby={`${uid}-f`}>
                <h4 id={`${uid}-f`} className="text-[14px] font-semibold text-[#14202B]">
                  {s.configured ? 'Replace the JSON key' : 'Add the JSON key'}
                </h4>
                <TextAreaField
                  label="Service-account JSON key"
                  value={json}
                  onChange={(e) => {
                    setJson(e.target.value);
                    setJsonError('');
                    setSaveError('');
                  }}
                  error={jsonError}
                  hint="Paste the whole downloaded .json file. It is checked here, sent once over HTTPS and stored encrypted; it is never shown again."
                  placeholder={'{\n  "type": "service_account",\n  "project_id": "…",\n  "private_key": "-----BEGIN PRIVATE KEY-----…",\n  "client_email": "…@….iam.gserviceaccount.com",\n  …\n}'}
                  rows={8}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  data-1p-ignore
                  data-lpignore="true"
                  className="[&_textarea]:font-mono [&_textarea]:text-[12.5px]"
                />
                <ErrorBox message={saveError} />
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" loading={saving} disabled={!json.trim()} icon={<Save className="h-4 w-4" aria-hidden />}>
                    Save key
                  </Button>
                  {s.configured && s.source === 'platform' && (
                    <Button variant="danger-outline" onClick={() => setRemoveOpen(true)} disabled={saving} icon={<Trash2 className="h-4 w-4" aria-hidden />}>
                      Remove
                    </Button>
                  )}
                </div>
              </form>
            )}

            <div className="border-t border-[#EFE9E2] p-5">
              <HowToGuide />
            </div>
          </section>
        )}
      </Card>

      <MetaSettingsCard />

      <ConfirmDialog
        open={removeOpen}
        onClose={() => {
          if (removing) return;
          setRemoveOpen(false);
          setRemoveError('');
        }}
        busy={removing}
        error={removeError}
        onConfirm={remove}
        tone="danger"
        title="Remove the Google service account?"
        confirmLabel="Remove key"
        description="Every Google Sheet import and export that uses the service account stops until a new key is added (those using a connected Google account keep working). Sheets keep their sharing settings; a new key for a different service account would need them to be shared again."
      />
    </>
  );
}
