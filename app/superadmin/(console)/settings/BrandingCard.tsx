'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ExternalLink, Save } from 'lucide-react';
import type { BrandingInput } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../_lib/api';
import { fmtDateTime } from '../../_lib/format';
import { useToast } from '../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, Skeleton, TextField } from '../../_components/ui';

type Form = Required<BrandingInput>;
const EMPTY: Form = { platformName: '', legalCompany: '', legalEmail: '', legalAddress: '', legalJurisdiction: '', legalUpdated: '' };
const isPlaceholder = (v: string) => /^\[.*\]$|\[City\]/.test(v);

/** Platform name and the company details printed on /privacy, /terms and /data-deletion. */
export function BrandingCard() {
  const toast = useToast();
  const uid = useId();
  const branding = useResource(() => call('getBranding', {}), []);
  const b = branding.data;
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load the saved values into the form; placeholders start empty so they are not saved as real data.
  useEffect(() => {
    if (!b) return;
    const pick = (v: string) => (isPlaceholder(v) ? '' : v);
    setForm({
      platformName: b.platformName, legalCompany: pick(b.legalCompany), legalEmail: pick(b.legalEmail),
      legalAddress: pick(b.legalAddress), legalJurisdiction: pick(b.legalJurisdiction), legalUpdated: b.legalUpdated,
    });
  }, [b]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const missing = b ? (['legalCompany', 'legalEmail', 'legalAddress', 'legalJurisdiction'] as const).filter((k) => isPlaceholder(b[k])) : [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      branding.setData(await call('saveBranding', form));
      toast('Branding and legal details saved — the legal pages show them now.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card aria-labelledby={`${uid}-b`}>
      <CardHeader
        id={`${uid}-b`}
        title="Branding & legal"
        description="Your platform name and the company details printed on the public Privacy, Terms and Data-deletion pages (Meta and Google check these)."
      />
      {!b && branding.loading ? (
        <div className="space-y-3 p-5"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>
      ) : (
        <form onSubmit={save} className="space-y-4 px-5 pb-5 pt-4" noValidate>
          <ErrorBox message={branding.error} onRetry={branding.reload} />
          {missing.length > 0 && (
            <p className="rounded-lg border border-[#F2D5A8] bg-[#FFF8EC] px-4 py-3 text-[13.5px] text-[#7A4A0C]">
              The legal pages still show placeholders for {missing.length} field{missing.length === 1 ? '' : 's'}. Fill them in before submitting the Meta app for review.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Platform name" value={form.platformName} onChange={set('platformName')} maxLength={80} hint="Shown on the legal pages, e.g. “Broaddcast CRM”." />
            <TextField label="Company legal name" value={form.legalCompany} onChange={set('legalCompany')} maxLength={160} placeholder="e.g. Broaddcast Business Solutions Pvt. Ltd." />
            <TextField label="Privacy contact e-mail" type="email" value={form.legalEmail} onChange={set('legalEmail')} maxLength={200} placeholder="privacy@yourcompany.com" hint="Shown publicly — use a business inbox." />
            <TextField label="Jurisdiction (courts)" value={form.legalJurisdiction} onChange={set('legalJurisdiction')} maxLength={120} placeholder="e.g. Hyderabad, India" />
            <TextField label="Registered address" value={form.legalAddress} onChange={set('legalAddress')} maxLength={300} placeholder="Street, City, State, PIN, India" className="sm:col-span-2" />
            <TextField label="“Last updated” date" value={form.legalUpdated} onChange={set('legalUpdated')} maxLength={40} hint="Change it whenever you edit these details." />
          </div>
          <ErrorBox message={error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving} icon={<Save className="h-4 w-4" aria-hidden />}>Save</Button>
            <a href="/privacy" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13.5px] font-medium text-[#8F6C49] underline-offset-2 hover:underline">
              View Privacy page <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
            {b?.updatedAt && <span className="text-[12.5px] text-[#7A6F64]">Last saved {fmtDateTime(b.updatedAt)}{b.updatedBy ? ` by ${b.updatedBy}` : ''}</span>}
          </div>
        </form>
      )}
    </Card>
  );
}
