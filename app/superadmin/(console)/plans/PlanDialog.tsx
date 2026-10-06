'use client';
import { useEffect, useState, type FormEvent } from 'react';
import type { Plan } from '@/server/platform/contract';
import { call, errorMessage } from '../../_lib/api';
import { slugError, slugify } from '../../_lib/format';
import { FeatureToggles, allFeatures, normaliseFeatures, type Features } from '../../_components/FeatureToggles';
import { Modal } from '../../_components/Modal';
import { Button, TextAreaField, TextField } from '../../_components/ui';

interface FormState {
  id: string;
  name: string;
  description: string;
  maxUsers: string;
  priceMonthly: string;
  currency: string;
  features: Features;
}

function toForm(p: Plan | null): FormState {
  return p
    ? {
        id: p.id,
        name: p.name,
        description: p.description || '',
        maxUsers: String(p.maxUsers),
        priceMonthly: String(p.priceMonthly),
        currency: p.currency || 'INR',
        features: normaliseFeatures(p.features),
      }
    : { id: '', name: '', description: '', maxUsers: '10', priceMonthly: '0', currency: 'INR', features: allFeatures(true) };
}

/** Create (plan = null) or edit a plan. The id is fixed once created. */
export function PlanDialog({ open, plan, onClose, onSaved }: { open: boolean; plan: Plan | null; onClose: () => void; onSaved: (p: Plan) => void }) {
  const isNew = !plan;
  const [f, setF] = useState<FormState>(() => toForm(plan));
  const [idTouched, setIdTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setF(toForm(plan));
    setIdTouched(false);
    setSubmitted(false);
    setError('');
  }, [open, plan]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const maxUsers = Number(f.maxUsers);
  const price = Number(f.priceMonthly);
  const errs = {
    id: isNew ? slugError(f.id) : '',
    name: !f.name.trim() ? 'Enter a plan name.' : '',
    maxUsers: f.maxUsers === '' || !Number.isInteger(maxUsers) || maxUsers < 0 ? 'Enter a whole number (0 = unlimited).' : '',
    priceMonthly: f.priceMonthly === '' || !Number.isFinite(price) || price < 0 ? 'Enter a price of 0 or more.' : '',
    currency: !/^[A-Za-z]{3}$/.test(f.currency.trim()) ? 'Use a 3-letter currency code, e.g. INR.' : '',
  };
  const show = (k: keyof typeof errs) => (submitted ? errs[k] : '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    setError('');
    try {
      const saved = await call('savePlan', {
        plan: {
          id: f.id,
          name: f.name.trim(),
          description: f.description.trim(),
          maxUsers,
          priceMonthly: price,
          currency: f.currency.trim().toUpperCase(),
          features: f.features,
        },
      });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title={isNew ? 'New plan' : `Edit ${plan!.name}`}
      description={isNew ? 'Plans set the default seat limit and features for new companies.' : 'Changes apply to new companies; existing companies keep their own settings.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="sa-plan-form" loading={busy}>
            {isNew ? 'Create plan' : 'Save plan'}
          </Button>
        </>
      }
    >
      <form id="sa-plan-form" onSubmit={submit} noValidate className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            value={f.name}
            onChange={(e) => {
              const name = e.target.value;
              setF((s) => ({ ...s, name, id: isNew && !idTouched ? slugify(name) : s.id }));
            }}
            required
            error={show('name')}
            maxLength={60}
          />
          <TextField
            label="Plan ID"
            value={f.id}
            onChange={(e) => {
              setIdTouched(true);
              set('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
            }}
            disabled={!isNew}
            required
            maxLength={40}
            spellCheck={false}
            className="[&_input]:font-mono"
            error={show('id')}
            hint={isNew ? 'Lowercase letters, digits and hyphens. Cannot be changed later.' : 'The ID cannot be changed.'}
          />
          <TextAreaField label="Description" className="sm:col-span-2" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={300} />
          <TextField label="Maximum users" type="number" inputMode="numeric" min={0} step={1} value={f.maxUsers} onChange={(e) => set('maxUsers', e.target.value)} error={show('maxUsers')} hint="0 = unlimited" />
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <TextField label="Price / month" type="number" inputMode="decimal" min={0} step="any" value={f.priceMonthly} onChange={(e) => set('priceMonthly', e.target.value)} error={show('priceMonthly')} hint="Display only" />
            <TextField label="Currency" value={f.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} error={show('currency')} className="[&_input]:uppercase" />
          </div>
        </div>
        <FeatureToggles value={f.features} onChange={(v) => set('features', v)} legend="Included features" />
        {error && (
          <p role="alert" className="rounded-lg border border-[#F7C5BF] bg-[#FEF3F2] px-3 py-2 text-[13.5px] text-[#912018]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
