'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import type { CompanyDetail, Plan } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../../_lib/api';
import { EMAIL_RE, fmtPrice, slugError, slugify } from '../../../_lib/format';
import { FeatureToggles, allFeatures, normaliseFeatures, type Features } from '../../../_components/FeatureToggles';
import { Button, Card, CardHeader, ErrorBox, LinkButton, SelectField, Skeleton, TextAreaField, TextField, cx, focusRing } from '../../../_components/ui';

const MIN_ADMIN_PW = 10;

interface FormState {
  name: string;
  slug: string;
  plan: string;
  maxUsers: string;
  features: Features;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
}

const EMPTY: FormState = {
  name: '',
  slug: '',
  plan: '',
  maxUsers: '0',
  features: allFeatures(true),
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  notes: '',
  adminName: '',
  adminEmail: '',
  adminPassword: '',
};

function applyPlan(f: FormState, plan: Plan | undefined): FormState {
  if (!plan) return f;
  return { ...f, plan: plan.id, maxUsers: String(plan.maxUsers), features: normaliseFeatures(plan.features) };
}

export function CreateCompanyForm({ onCreated }: { onCreated: (c: CompanyDetail, adminEmail: string, password?: string) => void }) {
  const plans = useResource(() => call('listPlans', {}), []);
  const [f, setF] = useState<FormState>(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Pick the first plan once plans load.
  useEffect(() => {
    if (plans.data && plans.data.length > 0 && !f.plan) setF((s) => applyPlan(s, plans.data![0]));
  }, [plans.data, f.plan]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const onName = (name: string) => setF((s) => ({ ...s, name, slug: slugTouched ? s.slug : slugify(name) }));

  const maxUsersNum = Number(f.maxUsers);
  const errs = {
    name: !f.name.trim() ? 'Enter the company name.' : '',
    slug: slugError(f.slug),
    plan: !f.plan ? 'Choose a plan.' : '',
    maxUsers: f.maxUsers === '' || !Number.isInteger(maxUsersNum) || maxUsersNum < 0 ? 'Enter a whole number (0 = unlimited).' : '',
    contactEmail: f.contactEmail.trim() && !EMAIL_RE.test(f.contactEmail.trim()) ? 'Enter a valid e-mail address.' : '',
    adminName: !f.adminName.trim() ? "Enter the administrator's name." : '',
    adminEmail: !EMAIL_RE.test(f.adminEmail.trim()) ? 'Enter a valid e-mail address.' : '',
    adminPassword: f.adminPassword && f.adminPassword.length < MIN_ADMIN_PW ? `Use at least ${MIN_ADMIN_PW} characters, or leave blank to generate one.` : '',
  };
  const show = (k: keyof typeof errs) => (submitted ? errs[k] : '');
  const selectedPlan = plans.data?.find((p) => p.id === f.plan);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(errs).some(Boolean)) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    setError('');
    const adminEmail = f.adminEmail.trim();
    try {
      const res = await call('createCompany', {
        name: f.name.trim(),
        slug: f.slug,
        plan: f.plan,
        maxUsers: maxUsersNum,
        features: f.features,
        contactName: f.contactName.trim(),
        contactEmail: f.contactEmail.trim(),
        contactPhone: f.contactPhone.trim(),
        notes: f.notes.trim(),
        admin: { name: f.adminName.trim(), email: adminEmail, ...(f.adminPassword ? { password: f.adminPassword } : {}) },
      });
      onCreated(res.company, adminEmail, res.adminTemporaryPassword);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const noPlans = plans.data && plans.data.length === 0;

  return (
    <form onSubmit={submit} noValidate className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader title="Company" description="The slug identifies the workspace and its database; it cannot be changed later." />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <TextField label="Company name" value={f.name} onChange={(e) => onName(e.target.value)} required error={show('name')} autoFocus maxLength={120} />
            <TextField
              label="Slug"
              value={f.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
              }}
              required
              maxLength={40}
              spellCheck={false}
              autoCapitalize="off"
              className="[&_input]:font-mono"
              error={f.slug || submitted ? (submitted || f.slug.length >= 2 ? errs.slug : '') : ''}
              hint="2–40 characters: lowercase letters, digits and hyphens."
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Plan & access" description="Choosing a plan fills in the seat limit and features; you can still adjust them." />
          <div className="space-y-5 p-5">
            {plans.error && <ErrorBox message={plans.error} onRetry={plans.reload} />}
            {noPlans && (
              <div role="alert" className="rounded-lg border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-[14px] text-[#93370D]">
                No plans exist yet.{' '}
                <Link href="/superadmin/plans" className={cx('rounded font-medium underline underline-offset-2', focusRing)}>
                  Create a plan
                </Link>{' '}
                before adding a company.
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {!plans.data && plans.loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <SelectField
                  label="Plan"
                  value={f.plan}
                  onChange={(e) => setF((s) => applyPlan(s, plans.data?.find((p) => p.id === e.target.value)))}
                  required
                  error={show('plan')}
                  disabled={!plans.data?.length}
                  hint={selectedPlan ? `${fmtPrice(selectedPlan.priceMonthly, selectedPlan.currency)} / month` : undefined}
                >
                  {!f.plan && <option value="">Select a plan</option>}
                  {plans.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </SelectField>
              )}
              <TextField
                label="Maximum users"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={f.maxUsers}
                onChange={(e) => set('maxUsers', e.target.value)}
                error={show('maxUsers')}
                hint="0 = unlimited"
              />
            </div>
            <FeatureToggles value={f.features} onChange={(v) => set('features', v)} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Contact" description="Who to reach about this account (optional)." />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <TextField label="Contact name" autoComplete="off" value={f.contactName} onChange={(e) => set('contactName', e.target.value)} />
            <TextField label="Contact e-mail" type="email" autoComplete="off" value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} error={show('contactEmail')} />
            <TextField label="Contact phone" type="tel" autoComplete="off" value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
            <TextAreaField label="Notes" className="sm:col-span-2" value={f.notes} onChange={(e) => set('notes', e.target.value)} hint="Internal only — not visible to the company." />
          </div>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="lg:sticky lg:top-24">
          <CardHeader title="First administrator" description="Gets the Admin role and can invite the rest of the team." />
          <div className="space-y-4 p-5">
            <TextField label="Name" autoComplete="off" value={f.adminName} onChange={(e) => set('adminName', e.target.value)} required error={show('adminName')} />
            <TextField label="E-mail" type="email" autoComplete="off" value={f.adminEmail} onChange={(e) => set('adminEmail', e.target.value)} required error={show('adminEmail')} />
            <TextField
              label="Password (optional)"
              type="password"
              autoComplete="new-password"
              value={f.adminPassword}
              onChange={(e) => set('adminPassword', e.target.value)}
              error={show('adminPassword')}
              hint="Leave blank to generate a temporary password, shown once after creation."
            />
          </div>
          <div className="space-y-3 border-t border-[#EFE9E2] p-5">
            <ErrorBox message={error} />
            {submitted && Object.values(errs).some(Boolean) && !error && (
              <p role="alert" className="text-[13.5px] text-[#B42318]">
                Please fix the highlighted fields.
              </p>
            )}
            <Button type="submit" loading={busy} disabled={Boolean(noPlans)} className="w-full">
              {busy ? 'Creating company…' : 'Create company'}
            </Button>
            <LinkButton href="/superadmin/companies" variant="ghost" className="w-full">
              Cancel
            </LinkButton>
          </div>
        </Card>
      </div>
    </form>
  );
}
