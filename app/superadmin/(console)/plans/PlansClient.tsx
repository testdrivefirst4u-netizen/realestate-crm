'use client';
import { useState } from 'react';
import { Check, Layers, Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import type { Plan } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../_lib/api';
import { FEATURE_KEYS, FEATURE_LABELS, fmtPrice } from '../../_lib/format';
import { ConfirmDialog } from '../../_components/Modal';
import { useToast } from '../../_components/Toast';
import { Button, Card, EmptyState, ErrorBox, PageHeader, Skeleton } from '../../_components/ui';
import { PlanDialog } from './PlanDialog';

export function PlansClient() {
  const toast = useToast();
  const plans = useResource(() => call('listPlans', {}), []);
  const [editing, setEditing] = useState<{ plan: Plan | null } | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const onSaved = (p: Plan) => {
    const list = plans.data || [];
    const exists = list.some((x) => x.id === p.id);
    plans.setData(exists ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]);
    toast(exists ? `Plan “${p.name}” saved.` : `Plan “${p.name}” created.`);
    setEditing(null);
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError('');
    try {
      await call('deletePlan', { id: deleting.id });
      plans.setData((plans.data || []).filter((x) => x.id !== deleting.id));
      toast(`Plan “${deleting.name}” deleted.`);
      setDeleting(null);
    } catch (e) {
      setDeleteError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Plans"
        description="Templates for seat limits and feature access. Prices are for display only."
        actions={
          <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing({ plan: null })}>
            New plan
          </Button>
        }
      />
      <ErrorBox message={plans.error} onRetry={plans.reload} className="mb-6" />

      {!plans.data && plans.loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="space-y-3 p-5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-24 w-full" />
            </Card>
          ))}
        </div>
      ) : plans.data && plans.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers className="h-5 w-5" aria-hidden />}
            title="No plans yet"
            description="Create a plan before adding companies."
            action={
              <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing({ plan: null })}>
                New plan
              </Button>
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.data?.map((p) => (
            <li key={p.id}>
              <Card className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-3 px-5 pt-5">
                  <div className="min-w-0">
                    <h2 className="text-[16px] font-semibold">{p.name}</h2>
                    <p className="font-mono text-[12.5px] text-[#7A6F64]">{p.id}</p>
                  </div>
                  <p className="text-right">
                    <span className="block text-[1.25rem] font-semibold text-[#14202B] tabular-nums">{fmtPrice(p.priceMonthly, p.currency)}</span>
                    <span className="text-[12.5px] text-[#7A6F64]">per month</span>
                  </p>
                </div>
                {p.description && <p className="px-5 pt-2 text-[13.5px] text-[#5E554D]">{p.description}</p>}
                <p className="mx-5 mt-3 inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[#1D2F3F]">
                  <Users className="h-4 w-4 text-[#A9825A]" aria-hidden />
                  {p.maxUsers === 0 ? 'Unlimited users' : `Up to ${p.maxUsers} users`}
                </p>
                <ul className="mt-3 flex-1 space-y-1.5 px-5 pb-4" aria-label={`Features in ${p.name}`}>
                  {FEATURE_KEYS.map((k) => {
                    const on = Boolean(p.features?.[k]);
                    return (
                      <li key={k} className={on ? 'flex items-center gap-2 text-[13.5px] text-[#26211E]' : 'flex items-center gap-2 text-[13.5px] text-[#A39888]'}>
                        {on ? <Check className="h-3.5 w-3.5 text-[#067647]" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                        <span>
                          {FEATURE_LABELS[k]}
                          <span className="sr-only">{on ? ' (included)' : ' (not included)'}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex justify-end gap-2 border-t border-[#EFE9E2] bg-[#FBF9F6] px-5 py-3 rounded-b-xl">
                  <Button variant="ghost" size="sm" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />} onClick={() => setDeleting(p)} aria-label={`Delete plan ${p.name}`}>
                    Delete
                  </Button>
                  <Button variant="secondary" size="sm" icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} onClick={() => setEditing({ plan: p })} aria-label={`Edit plan ${p.name}`}>
                    Edit
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <PlanDialog open={Boolean(editing)} plan={editing?.plan ?? null} onClose={() => setEditing(null)} onSaved={onSaved} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => {
          if (busy) return;
          setDeleting(null);
          setDeleteError('');
        }}
        busy={busy}
        error={deleteError}
        onConfirm={remove}
        tone="danger"
        title={`Delete plan “${deleting?.name ?? ''}”?`}
        confirmLabel="Delete plan"
        description="Plans that are still assigned to a company cannot be deleted."
      />
    </>
  );
}
