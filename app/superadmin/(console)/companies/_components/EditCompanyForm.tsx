'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CompanyDetail, Plan, PlatformActions } from '@/server/platform/contract';
import { call, errorMessage } from '../../../_lib/api';
import { EMAIL_RE } from '../../../_lib/format';
import { normaliseFeatures } from '../../../_components/FeatureToggles';
import { useToast } from '../../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, SelectField, TextAreaField, TextField } from '../../../_components/ui';
import { LogoUpload } from './LogoUpload';

type Patch = PlatformActions['updateCompany']['req']['patch'];

function fromCompany(c: CompanyDetail) {
  return {
    name: c.name,
    tagline: c.tagline || '',
    logo: c.logo || '',
    plan: c.plan,
    maxUsers: String(c.maxUsers),
    contactName: c.contactName || '',
    contactEmail: c.contactEmail || '',
    contactPhone: c.contactPhone || '',
    notes: c.notes || '',
  };
}

export function EditCompanyForm({ company, plans, onSaved }: { company: CompanyDetail; plans: Plan[]; onSaved: (c: CompanyDetail) => void }) {
  const toast = useToast();
  const initial = useMemo(() => fromCompany(company), [company]);
  const [f, setF] = useState(initial);
  const [applyPlanFeatures, setApplyPlanFeatures] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => setF(initial), [initial]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const dirty = (Object.keys(f) as Array<keyof typeof f>).some((k) => f[k] !== initial[k]);
  const planChanged = f.plan !== initial.plan;

  const maxUsersNum = Number(f.maxUsers);
  const errs = {
    name: !f.name.trim() ? 'Enter the company name.' : '',
    maxUsers: f.maxUsers === '' || !Number.isInteger(maxUsersNum) || maxUsersNum < 0 ? 'Enter a whole number (0 = unlimited).' : '',
    contactEmail: f.contactEmail.trim() && !EMAIL_RE.test(f.contactEmail.trim()) ? 'Enter a valid e-mail address.' : '',
  };
  const show = (k: keyof typeof errs) => (submitted ? errs[k] : '');
  const seatWarning = maxUsersNum > 0 && maxUsersNum < company.activeUsers ? `${company.activeUsers} users are active — more than the new limit. Existing users keep access, but no new users can be added.` : '';

  const onPlan = (id: string) => {
    const p = plans.find((x) => x.id === id);
    setF((s) => ({ ...s, plan: id, maxUsers: p ? String(p.maxUsers) : s.maxUsers }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(errs).some(Boolean)) return;
    const patch: Patch = {};
    if (f.name.trim() !== initial.name) patch.name = f.name.trim();
    if (f.tagline.trim() !== initial.tagline) patch.tagline = f.tagline.trim();
    if (f.logo !== initial.logo) patch.logo = f.logo;
    if (f.plan !== initial.plan) patch.plan = f.plan;
    if (maxUsersNum !== company.maxUsers) patch.maxUsers = maxUsersNum;
    if (f.contactName.trim() !== initial.contactName) patch.contactName = f.contactName.trim();
    if (f.contactEmail.trim() !== initial.contactEmail) patch.contactEmail = f.contactEmail.trim();
    if (f.contactPhone.trim() !== initial.contactPhone) patch.contactPhone = f.contactPhone.trim();
    if (f.notes.trim() !== initial.notes) patch.notes = f.notes.trim();
    if (planChanged && applyPlanFeatures) {
      const p = plans.find((x) => x.id === f.plan);
      if (p) patch.features = normaliseFeatures(p.features);
    }
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setError('');
    try {
      const updated = await call('updateCompany', { id: company.id, patch });
      onSaved(updated);
      setSubmitted(false);
      toast('Company details saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Company profile" description="Name, branding, plan and contact details." />
      <form onSubmit={submit} noValidate>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <TextField label="Company name" value={f.name} onChange={(e) => set('name', e.target.value)} required error={show('name')} maxLength={120} />
          <TextField label="Tagline" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={140} hint="Shown under the name in the CRM sidebar when the company has no logo." />
          <div className="sm:col-span-2">
            <LogoUpload value={f.logo} onChange={(v) => set('logo', v)} name={f.name || company.name} disabled={busy} />
          </div>
          <SelectField label="Plan" value={f.plan} onChange={(e) => onPlan(e.target.value)}>
            {!plans.some((p) => p.id === f.plan) && <option value={f.plan}>{f.plan} (unknown plan)</option>}
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Maximum users"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={f.maxUsers}
            onChange={(e) => set('maxUsers', e.target.value)}
            error={show('maxUsers')}
            hint={seatWarning || '0 = unlimited'}
          />
          {planChanged && (
            <label className="flex items-start gap-2.5 rounded-lg border border-[#E7DCCF] bg-[#FBF7F2] px-3 py-2.5 text-[13.5px] text-[#4A423B] sm:col-span-2">
              <input type="checkbox" checked={applyPlanFeatures} onChange={(e) => setApplyPlanFeatures(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1D2F3F]" />
              <span>Also apply the new plan&apos;s feature set (replaces the current feature toggles).</span>
            </label>
          )}
          <TextField label="Contact name" value={f.contactName} onChange={(e) => set('contactName', e.target.value)} />
          <TextField label="Contact e-mail" type="email" value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} error={show('contactEmail')} />
          <TextField label="Contact phone" type="tel" value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
          <TextAreaField label="Notes" className="sm:col-span-2" value={f.notes} onChange={(e) => set('notes', e.target.value)} hint="Internal only — not visible to the company." />
        </div>
        <div className="space-y-3 border-t border-[#EFE9E2] px-5 py-3">
          <ErrorBox message={error} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty && <span className="mr-auto text-[13px] text-[#8F6C49]">Unsaved changes</span>}
            <Button
              variant="secondary"
              disabled={!dirty || busy}
              onClick={() => {
                setF(initial);
                setSubmitted(false);
                setError('');
              }}
            >
              Discard
            </Button>
            <Button type="submit" loading={busy} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
