'use client';
import { useEffect, useState, type FormEvent } from 'react';
import type { CompanyDetail, DuplicateMode, LeadSource, LeadSourceType } from '@/server/platform/contract';
import { call, errorMessage } from '../../../_lib/api';
import { Modal } from '../../../_components/Modal';
import { CopyButton, CopyRow, OneTimeSecretPanel } from '../../../_components/SecretPanel';
import { Button, ErrorBox, SelectField, TextAreaField, TextField } from '../../../_components/ui';

export const SOURCE_TYPE_LABELS: Record<LeadSourceType, string> = {
  website: 'Website',
  webhook: 'Webhook',
  google_sheet: 'Google Sheet',
  meta: 'Facebook / Instagram',
};

/**
 * Key-based types the console can create on a company's behalf. Google Sheet imports are set up by the company;
 * Meta Pages are connected through Facebook login (or "Connect a Page on behalf" in the Meta section).
 */
type KeyedSourceType = Extract<LeadSourceType, 'website' | 'webhook'>;
const CREATABLE_SOURCE_TYPES: KeyedSourceType[] = ['website', 'webhook'];

/** Whether the source receives leads with an API key (website / webhook) — sheet imports and Meta Pages have no key. */
export function hasApiKey(type: LeadSourceType): boolean {
  return type === 'website' || type === 'webhook';
}

export const DUPLICATE_LABELS: Record<DuplicateMode, string> = {
  remark: 'Add a remark to the existing lead and notify',
  skip: 'Ignore the duplicate',
  create: 'Create a new lead anyway',
};

export const INBOUND_PATH = '/api/inbound/leads';

function useEndpoint(): string {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  return origin ? `${origin}${INBOUND_PATH}` : INBOUND_PATH;
}

function curlExample(endpoint: string, key: string): string {
  return [
    `curl -X POST "${endpoint}" \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"name":"Test Lead","phone":"+919800000000","email":"test@example.com","message":"Please call me back"}'`,
  ].join('\n');
}

/** The one-time key, the intake endpoint and a curl example. */
export function KeyReveal({ source, apiKey }: { source: LeadSource; apiKey: string }) {
  const endpoint = useEndpoint();
  const curl = curlExample(endpoint, apiKey);
  return (
    <div className="space-y-4">
      <OneTimeSecretPanel
        label="API key"
        value={apiKey}
        note={`This API key for “${source.name}” is shown only once. Copy it now and share it securely with the company — it cannot be retrieved later (rotate it to issue a new one).`}
      />
      <CopyRow label="Endpoint (POST)" value={endpoint} />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-medium uppercase tracking-wide text-[#7A6F64]">Example request</span>
          <CopyButton value={curl} label="Copy example request" />
        </div>
        <pre className="max-h-56 overflow-auto rounded-lg border border-[#E4DCD2] bg-[#14202B] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[#F4EEE7]">
          <code>{curl}</code>
        </pre>
        <p className="text-[12.5px] text-[#7A6F64]">
          The key can also be sent as an <span className="font-mono">X-Api-Key</span> header or a <span className="font-mono">_key</span> field. JSON, URL-encoded and multipart form bodies are accepted.
        </p>
      </div>
    </div>
  );
}

/** Shows a freshly issued key (after a rotation). */
export function KeyRevealModal({ open, onClose, result }: { open: boolean; onClose: () => void; result: { source: LeadSource; apiKey: string } | null }) {
  return (
    <Modal open={open} onClose={onClose} title="New API key" description={result ? `${result.source.name} · ${result.source.id}` : undefined} size="lg" footer={<Button onClick={onClose}>Done</Button>}>
      {result && <KeyReveal source={result.source} apiKey={result.apiKey} />}
    </Modal>
  );
}

interface Form {
  name: string;
  type: KeyedSourceType;
  sourceLabel: string;
  duplicates: DuplicateMode;
  origins: string;
}
const EMPTY: Form = { name: '', type: 'website', sourceLabel: '', duplicates: 'remark', origins: '' };

/** Parses "one website per line" into normalised origins, or returns the first bad line. */
function parseOrigins(text: string): { origins: string[]; bad: string } {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const u = new URL(/^https?:\/\//i.test(line) ? line : `https://${line}`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { origins: [], bad: line };
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch {
      return { origins: [], bad: line };
    }
  }
  return { origins: out, bad: '' };
}

export function CreateLeadSourceDialog({
  open,
  onClose,
  company,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  company: CompanyDetail;
  onCreated: (s: LeadSource) => void;
}) {
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ source: LeadSource; apiKey: string } | null>(null);

  useEffect(() => {
    if (open) {
      setF(EMPTY);
      setErrors({});
      setError('');
      setResult(null);
    }
  }, [open]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const errs: Partial<Record<keyof Form, string>> = {};
    const name = f.name.trim();
    if (!name) errs.name = 'Enter a name for this source.';
    else if (name.length > 80) errs.name = 'Keep the name under 80 characters.';
    const { origins, bad } = parseOrigins(f.origins);
    if (bad) errs.origins = `“${bad}” is not a valid website address.`;
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    setError('');
    try {
      const res = await call('createCompanyLeadSource', {
        companyId: company.id,
        name,
        type: f.type,
        config: {
          ...(f.sourceLabel.trim() ? { sourceLabel: f.sourceLabel.trim() } : {}),
          duplicates: f.duplicates,
          allowedOrigins: origins,
        },
      });
      setResult(res);
      onCreated(res.source);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal open={open} onClose={onClose} title="Lead source created" description={`${result.source.name} · ${result.source.id}`} size="lg" footer={<Button onClick={onClose}>Done</Button>}>
        <KeyReveal source={result.source} apiKey={result.apiKey} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title="Create lead source"
      description={`On behalf of ${company.name}. The API key is shown once after creation.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="create-lead-source" loading={busy}>
            Create source
          </Button>
        </>
      }
    >
      <form id="create-lead-source" onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Name" required value={f.name} onChange={(e) => set('name', e.target.value)} error={errors.name} placeholder="e.g. Main website enquiry form" maxLength={80} autoComplete="off" />
          <SelectField label="Type" value={f.type} onChange={(e) => set('type', e.target.value as KeyedSourceType)} hint={f.type === 'website' ? 'Forms posting from a browser.' : 'Server-to-server calls (Zapier, landing-page tools, …).'}>
            {CREATABLE_SOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {SOURCE_TYPE_LABELS[t]}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Enquiry Source label"
            value={f.sourceLabel}
            onChange={(e) => set('sourceLabel', e.target.value)}
            placeholder={SOURCE_TYPE_LABELS[f.type]}
            hint={`Written to “Enquiry Source” on new leads. Defaults to “${SOURCE_TYPE_LABELS[f.type]}”.`}
            maxLength={60}
            autoComplete="off"
          />
          <SelectField label="Duplicates" value={f.duplicates} onChange={(e) => set('duplicates', e.target.value as DuplicateMode)} hint="When the phone or e-mail already belongs to a lead.">
            {(Object.keys(DUPLICATE_LABELS) as DuplicateMode[]).map((d) => (
              <option key={d} value={d}>
                {DUPLICATE_LABELS[d]}
              </option>
            ))}
          </SelectField>
        </div>
        <TextAreaField
          label="Allowed websites"
          value={f.origins}
          onChange={(e) => set('origins', e.target.value)}
          error={errors.origins}
          placeholder={'https://www.example.com\nhttps://example.com'}
          hint="One per line. Browsers on other websites are refused. Leave empty to accept any website."
          rows={3}
          spellCheck={false}
        />
        <ErrorBox message={error} />
      </form>
    </Modal>
  );
}
