'use client';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LogIn, Save, Trash2 } from 'lucide-react';
import type { PlatformActions } from '@/server/platform/contract';
import { call, errorMessage } from '../../_lib/api';
import { ConfirmDialog } from '../../_components/Modal';
import { CopyRow } from '../../_components/SecretPanel';
import { useToast } from '../../_components/Toast';
import { Button, ErrorBox, Pill, TextField, cx, focusRing } from '../../_components/ui';
import { Field, Guide, StatusPill } from './SettingsParts';

type GoogleSettings = PlatformActions['getGoogleSettings']['res'];

/** `<project number>-<id>.apps.googleusercontent.com` */
const CLIENT_ID_RE = /^\d+-[a-z0-9_]+\.apps\.googleusercontent\.com$/i;
const LOCAL_REDIRECT_URI = 'http://localhost:3000/api/integrations/google/callback';

const B = ({ children }: { children: ReactNode }) => <strong className="font-medium">{children}</strong>;
const Code = ({ children }: { children: ReactNode }) => <span className="rounded bg-white px-1 font-mono text-[12.5px] ring-1 ring-inset ring-[#E4DCD2]">{children}</span>;

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx('rounded font-medium text-[#1D2F3F] underline underline-offset-2', focusRing)}>
      {children}
    </a>
  );
}

function OAuthGuide({ redirectUri }: { redirectUri: string }) {
  return (
    <Guide title="How to create the OAuth client">
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Open the <ExtLink href="https://console.cloud.google.com/">Google Cloud Console</ExtLink> and select a project (or create one).
        </li>
        <li>
          Go to <B>APIs &amp; Services → Library</B>, search for <B>Google Sheets API</B> and click <B>Enable</B>.
        </li>
        <li>
          Go to <B>APIs &amp; Services › OAuth consent screen</B>. Choose the user type <B>External</B>, then fill in the <B>App name</B>, the <B>User support e-mail</B> and the{' '}
          <B>Developer contact e-mail</B>.
        </li>
        <li>
          Under <B>Scopes</B> (Data access), click <B>Add or remove scopes</B> and add <Code>https://www.googleapis.com/auth/spreadsheets</Code>.
        </li>
        <li>
          Under <B>Test users</B> (Audience), add the Google accounts that will connect — up to 100 while the app is in <B>Testing</B>.
        </li>
        <li>
          Go to <B>Credentials › Create credentials › OAuth client ID</B>, choose the application type <B>Web application</B> and, under <B>Authorised redirect URIs</B>, add{' '}
          {redirectUri ? <Code>{redirectUri}</Code> : 'the Authorised redirect URI shown above'}. Click <B>Create</B>.
        </li>
        <li>
          Copy the <B>Client ID</B> and the <B>Client Secret</B> into the form above and save.
        </li>
      </ol>
      <div className="mt-3 space-y-2 text-[13px] text-[#6B6158]">
        <p>
          <B>Testing mode:</B> while the consent screen is in Testing, Google expires the access after <B>7 days</B> — companies then have to reconnect. Publish the app to avoid this.
        </p>
        <p>
          <B>Publishing:</B> <Code>…/auth/spreadsheets</Code> is a sensitive scope, so publishing the app requires Google verification (a privacy policy, a homepage and a demo video of
          the connect flow).
        </p>
      </div>
    </Guide>
  );
}

/** Platform settings → Google → "Connect with Google": the platform's OAuth client (Client ID + Secret). */
export function GoogleOAuthSection({ s, onUpdated }: { s: GoogleSettings; onUpdated: (s: GoogleSettings) => void }) {
  const toast = useToast();
  const uid = useId();

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  // Fill the Client ID once the stored value first loads (later reloads keep unsaved edits).
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (!filled) {
      setClientId(s.oauthClientId || '');
      setFilled(true);
    }
  }, [s, filled]);

  const fromEnv = s.oauthSource === 'env';
  const secretStored = s.oauthSource === 'platform' && s.oauthSecretSet;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const id = clientId.trim();
    const secret = clientSecret.trim();
    const errs: { clientId?: string; clientSecret?: string } = {};
    if (!id) errs.clientId = 'Enter the Client ID (Credentials › OAuth 2.0 Client IDs).';
    else if (!CLIENT_ID_RE.test(id)) errs.clientId = 'A Client ID looks like 123456789012-abc123def456.apps.googleusercontent.com.';
    if (!secret && !secretStored) errs.clientSecret = 'Enter the Client Secret.';
    else if (secret && /\s/.test(secret)) errs.clientSecret = 'The Client Secret contains no spaces — copy it again.';
    setErrors(errs);
    if (errs.clientId || errs.clientSecret) return;

    setSaving(true);
    setSaveError('');
    try {
      const updated = await call('setGoogleOAuthClient', { clientId: id, clientSecret: secret });
      onUpdated(updated);
      setClientId(updated.oauthClientId || id);
      setClientSecret('');
      toast('Google OAuth client saved.');
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
      const updated = await call('setGoogleOAuthClient', { clientId: '' });
      onUpdated(updated);
      setClientId('');
      setClientSecret('');
      setRemoveOpen(false);
      toast('Google OAuth client removed.');
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section aria-labelledby={`${uid}-h`} className="border-t border-[#EFE9E2]">
      <div className="space-y-4 p-5">
        <div>
          <h3 id={`${uid}-h`} className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-[#14202B]">
            <LogIn className="h-4 w-4 text-[#A9825A]" aria-hidden />
            Connect with Google
            <Pill>Recommended — no key file</Pill>
          </h3>
          <p className="mt-1 text-[13.5px] text-[#6B6158]">
            Company admins sign in with their own Google account and pick their sheets — nothing to share with a service account. Needs one Google OAuth client for the platform.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill configured={s.oauthConfigured} />
          {s.oauthSource === 'env' && <span className="text-[13px] text-[#6B6158]">from the environment</span>}
          {s.oauthSource === 'platform' && <span className="text-[13px] text-[#6B6158]">stored in the platform (Client Secret encrypted)</span>}
        </div>

        {fromEnv ? (
          <p className="rounded-lg border border-[#E4DCD2] bg-[#FBF9F6] px-4 py-3 text-[13.5px] text-[#3B342E]">
            Set by the <span className="font-mono">GOOGLE_OAUTH_CLIENT_ID</span> and <span className="font-mono">GOOGLE_OAUTH_CLIENT_SECRET</span> environment variables — change them there.
            They cannot be edited from this console.
          </p>
        ) : !s.oauthConfigured ? (
          <p className="text-[13.5px] text-[#6B6158]">No OAuth client yet. Until one is added, companies cannot connect a Google account. Follow the guide below, then save the Client ID and Client Secret.</p>
        ) : null}

        <dl className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID">{s.oauthClientId ? <span className="font-mono break-all">{s.oauthClientId}</span> : '—'}</Field>
          <Field label="Client Secret">
            {s.oauthSecretSet ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#ECFDF3] px-2.5 py-0.5 text-[12.5px] font-medium text-[#067647] ring-1 ring-inset ring-[#ABEFC6]">
                <KeyRound className="h-3.5 w-3.5" aria-hidden /> Stored
              </span>
            ) : (
              'Not set'
            )}
          </Field>
        </dl>

        {s.oauthRedirectUri && (
          <div className="space-y-1.5">
            <CopyRow label="Authorised redirect URI" value={s.oauthRedirectUri} />
            <p className="text-[13px] text-[#6B6158]">
              Add this under the OAuth client&apos;s <strong className="font-medium text-[#3B342E]">Authorised redirect URIs</strong>.
              {s.oauthRedirectUri !== LOCAL_REDIRECT_URI && (
                <>
                  {' '}
                  For local testing, <span className="font-mono break-all">{LOCAL_REDIRECT_URI}</span> also works if <span className="font-mono">APP_URL</span> is set to{' '}
                  <span className="font-mono">http://localhost:3000</span> — add it as a second URI.
                </>
              )}
            </p>
          </div>
        )}
      </div>

      {!fromEnv && (
        <form onSubmit={save} noValidate className="space-y-4 border-t border-[#EFE9E2] p-5" aria-labelledby={`${uid}-f`}>
          <h4 id={`${uid}-f`} className="text-[14px] font-semibold text-[#14202B]">
            {s.oauthConfigured ? 'OAuth client' : 'Add the OAuth client'}
          </h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Client ID"
              required
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setErrors((x) => ({ ...x, clientId: undefined }));
                setSaveError('');
              }}
              error={errors.clientId}
              placeholder="123456789012-abc….apps.googleusercontent.com"
              hint="Credentials › OAuth 2.0 Client IDs."
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
            />
            <TextField
              label="Client Secret"
              required={!secretStored}
              type="password"
              value={clientSecret}
              onChange={(e) => {
                setClientSecret(e.target.value);
                setErrors((x) => ({ ...x, clientSecret: undefined }));
                setSaveError('');
              }}
              error={errors.clientSecret}
              placeholder={secretStored ? '•••• stored' : 'GOCSPX-…'}
              hint={secretStored ? '•••• stored — leave empty to keep the current secret.' : 'Stored encrypted; never shown again.'}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={200}
              data-1p-ignore
              data-lpignore="true"
            />
          </div>
          <ErrorBox message={saveError} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={saving} icon={<Save className="h-4 w-4" aria-hidden />}>
              Save
            </Button>
            {s.oauthSource === 'platform' && s.oauthConfigured && (
              <Button variant="danger-outline" onClick={() => setRemoveOpen(true)} disabled={saving} icon={<Trash2 className="h-4 w-4" aria-hidden />}>
                Remove
              </Button>
            )}
          </div>
        </form>
      )}

      <div className="border-t border-[#EFE9E2] p-5">
        <OAuthGuide redirectUri={s.oauthRedirectUri} />
      </div>

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
        title="Remove the Google OAuth client?"
        confirmLabel="Remove client"
        description="Companies can no longer connect Google accounts, and imports and exports that use a connected Google account stop until a client is added again. Imports and exports that use the service account are not affected."
      />
    </section>
  );
}
