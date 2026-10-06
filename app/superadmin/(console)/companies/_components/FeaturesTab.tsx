'use client';
import { useEffect, useMemo, useState } from 'react';
import type { CompanyDetail, Plan } from '@/server/platform/contract';
import { call, errorMessage } from '../../../_lib/api';
import { FEATURE_KEYS } from '../../../_lib/format';
import { FeatureToggles, normaliseFeatures, type Features } from '../../../_components/FeatureToggles';
import { useToast } from '../../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox } from '../../../_components/ui';

export function FeaturesTab({ company, plans, onSaved }: { company: CompanyDetail; plans: Plan[]; onSaved: (c: CompanyDetail) => void }) {
  const toast = useToast();
  const initial = useMemo(() => normaliseFeatures(company.features), [company.features]);
  const [value, setValue] = useState<Features>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setValue(initial), [initial]);

  const plan = plans.find((p) => p.id === company.plan);
  const planFeatures = plan ? normaliseFeatures(plan.features) : null;
  const dirty = FEATURE_KEYS.some((k) => value[k] !== initial[k]);
  const matchesPlan = planFeatures ? FEATURE_KEYS.every((k) => value[k] === planFeatures[k]) : true;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const updated = await call('updateCompany', { id: company.id, patch: { features: value } });
      onSaved(updated);
      toast('Feature access updated.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-3xl">
      <CardHeader
        title="Feature access"
        description="Turn modules on or off for everyone in this company. Changes apply on their next page load."
        actions={
          planFeatures && !matchesPlan ? (
            <Button variant="ghost" size="sm" onClick={() => setValue(planFeatures)} disabled={busy}>
              Reset to {plan!.name} defaults
            </Button>
          ) : null
        }
      />
      <div className="px-5 py-3">
        <FeatureToggles value={value} onChange={setValue} disabled={busy} legend="Modules" columns={1} />
      </div>
      <div className="space-y-3 border-t border-[#EFE9E2] px-5 py-3">
        <ErrorBox message={error} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-[13px] text-[#8F6C49]">Unsaved changes</span>}
          <Button variant="secondary" disabled={!dirty || busy} onClick={() => setValue(initial)}>
            Discard
          </Button>
          <Button onClick={save} loading={busy} disabled={!dirty}>
            Save features
          </Button>
        </div>
      </div>
    </Card>
  );
}
