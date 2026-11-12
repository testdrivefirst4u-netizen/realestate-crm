/**
 * Team › Construction & payment plans (managers). Certifying a stage raises the payment demands that wait on it;
 * plans are entered from Amaya's registered agreement for sale; the interest rate is entered with its source.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { formatDateTime } from '../../core/dates';
import type { ConstructionStage, PaymentPlan } from '../../core/journeyTypes';
import { Button, Field, InlineNotice, Select, cx, inputCls } from '../../components/ui';

type Row = { label: string; percent: string; trigger: string; stageKey: string };
const TRIGGERS = [{ value: 'booking', label: 'On booking' }, { value: 'agreement', label: 'On registered agreement' }, { value: 'stage', label: 'Construction stage' }, { value: 'possession', label: 'On possession' }];

export const ConstructionPanel: React.FC = () => {
  const [stages, setStages] = useState<ConstructionStage[] | null>(null);
  const [plans, setPlans] = useState<PaymentPlan[]>([]);
  const [rera, setRera] = useState({ interestRatePct: '', interestRateSource: '', projectNumber: '' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [newStage, setNewStage] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState({ name: '', agreementRef: '', gstPct: '5', noticeDays: '15' });
  const [rows, setRows] = useState<Row[]>([{ label: 'On booking', percent: '10', trigger: 'booking', stageKey: '' }, { label: 'On agreement', percent: '', trigger: 'agreement', stageKey: '' }]);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.customer.plans(), api.customer.reraSettings()]);
      setStages(p.stages);
      setPlans(p.plans);
      setRera(r);
    } catch (e) {
      setMsg({ tone: 'warning', text: toAppError(e).userMessage });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (what: string, fn: () => Promise<unknown>, done: (r: any) => string) => {
    setBusy(what);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: 'success', text: done(r) });
      await load();
      return true;
    } catch (e) {
      setMsg({ tone: 'warning', text: toAppError(e).userMessage });
      return false;
    } finally {
      setBusy('');
    }
  };
  const certify = (s: ConstructionStage) => {
    const ref = window.prompt(`Certificate reference for "${s.label}" (architect / engineer)`);
    if (ref) void run(s._id, () => api.customer.certify(s._id, ref), (r) => (r.alreadyCertified ? 'Already certified.' : `${s.label} certified. ${r.demands} payment demand${r.demands === 1 ? '' : 's'} raised for review.`));
  };
  const total = rows.reduce((a, r) => a + (Number(r.percent) || 0), 0);

  return (
    <section aria-labelledby="h-construction" className="space-y-4">
      <h2 id="h-construction" className="text-sm font-bold text-[#0B2A44]">Construction &amp; payment plans</h2>
      {msg && <InlineNotice tone={msg.tone}>{msg.text}</InlineNotice>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <h3 className="text-xs font-semibold text-[#5E778C] mb-1.5">Construction stages</h3>
          <ul className="rounded-xl border border-[#E3EDF5] bg-white divide-y divide-[#EEF3F8]">
            {!stages && <li className="h-10 animate-pulse" />}
            {stages && !stages.length && <li className="px-3 py-2.5 text-xs text-[#7E93A6]">No stages yet. Add them in the order of the agreement's payment plan.</li>}
            {stages?.map((s) => (
              <li key={s._id} className="px-3 py-2 flex items-center gap-3 text-xs">
                <span className="flex-1 min-w-0 font-medium text-[#0B2A44]">{s.label}</span>
                {s.certifiedOn ? <span className="text-[#0E8A86]">Certified {formatDateTime(s.certifiedOn, '').split(',')[0]} · {s.certificateRef}</span> : <Button size="xs" variant="secondary" loading={busy === s._id} onClick={() => certify(s)}>Certify complete</Button>}
              </li>
            ))}
          </ul>
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); const label = newStage.trim(); if (!label) return; void run('stage', () => api.customer.saveStages([...(stages || []).map((s) => ({ key: s._id, label: s.label })), { key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30), label }]), () => 'Stage added.').then((ok) => ok && setNewStage('')); }}>
            <input value={newStage} onChange={(e) => setNewStage(e.target.value)} className={inputCls} placeholder="e.g. Completion of 3rd floor slab" aria-label="New construction stage" />
            <Button type="submit" size="sm" variant="ghost" icon={<Plus size={12} />} loading={busy === 'stage'}>Add</Button>
          </form>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-[#5E778C] mb-1.5">Registration and interest</h3>
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run('rera', () => api.customer.saveReraSettings(rera), () => 'Saved.'); }}>
            <Field label="TG-RERA project registration no."><input value={rera.projectNumber} onChange={(e) => setRera({ ...rera, projectNumber: e.target.value })} className={inputCls} /></Field>
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <Field label="Interest % a year"><input type="number" step="0.01" min={0} value={rera.interestRatePct} onChange={(e) => setRera({ ...rera, interestRatePct: e.target.value })} className={inputCls} placeholder="e.g. 10.7" /></Field>
              <Field label="Source of the rate" hint="SBI rate + 2 % under the TS RERA Rules; confirm with counsel"><input value={rera.interestRateSource} onChange={(e) => setRera({ ...rera, interestRateSource: e.target.value })} className={inputCls} placeholder="SBI MCLR on 1 Nov 2026 + 2 %" /></Field>
            </div>
            <div className="flex justify-end"><Button type="submit" variant="secondary" size="sm" loading={busy === 'rera'}>Save</Button></div>
          </form>
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold text-[#5E778C]">Payment plans (from the registered agreement for sale)</h3>
          {!planOpen && <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => setPlanOpen(true)}>New plan</Button>}
        </div>
        <ul className="mt-1.5 rounded-xl border border-[#E3EDF5] bg-white divide-y divide-[#EEF3F8]">
          {!plans.length && <li className="px-3 py-2.5 text-xs text-[#7E93A6]">No plan yet. Enter it exactly as in the agreement filed with TG-RERA.</li>}
          {plans.map((p) => (
            <li key={p._id} className="px-3 py-2 text-xs">
              <div className="font-semibold text-[#0B2A44]">{p.name} <span className="font-normal text-[#5E778C]">· {p.agreementRef} · GST {p.gstPct} % · {p.noticeDays} days to pay</span></div>
              <div className="text-[#5E778C] mt-0.5">{p.stages.map((s) => `${s.label} ${s.percent} %`).join(' · ')}</div>
            </li>
          ))}
        </ul>
        {planOpen && (
          <form className="mt-2 rounded-xl border border-[#0B6BB0]/30 bg-[#F7FAFD] p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void run('plan', () => api.customer.savePlan({ ...plan, gstPct: Number(plan.gstPct), noticeDays: Number(plan.noticeDays), stages: rows.map((r) => ({ label: r.label, percent: Number(r.percent), trigger: r.trigger, ...(r.trigger === 'stage' ? { stageKey: r.stageKey } : {}) })) } as any), () => 'Plan saved.').then((ok) => ok && setPlanOpen(false)); }}>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_5rem_6rem] gap-2">
              <Field label="Name"><input value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} className={inputCls} placeholder="Construction-linked plan, Phase 1" required /></Field>
              <Field label="Registered agreement reference"><input value={plan.agreementRef} onChange={(e) => setPlan({ ...plan, agreementRef: e.target.value })} className={inputCls} placeholder="TG-RERA no. · agreement version" required /></Field>
              <Field label="GST %"><input type="number" step="0.01" value={plan.gstPct} onChange={(e) => setPlan({ ...plan, gstPct: e.target.value })} className={inputCls} /></Field>
              <Field label="Days to pay"><input type="number" value={plan.noticeDays} onChange={(e) => setPlan({ ...plan, noticeDays: e.target.value })} className={inputCls} /></Field>
            </div>
            <table className="w-full text-xs"><tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="pr-2 pb-1.5"><input value={r.label} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={inputCls} aria-label={`Instalment ${i + 1} name`} /></td>
                  <td className="pr-2 pb-1.5 w-20"><input type="number" step="0.01" value={r.percent} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} className={inputCls} aria-label={`Instalment ${i + 1} percent`} placeholder="%" /></td>
                  <td className="pr-2 pb-1.5 w-44"><Select value={r.trigger} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, trigger: e.target.value } : x)))} options={TRIGGERS} aria-label={`Instalment ${i + 1} due`} /></td>
                  <td className="pr-2 pb-1.5 w-44">{r.trigger === 'stage' && <Select value={r.stageKey} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, stageKey: e.target.value } : x)))} options={[{ value: '', label: 'Which stage' }, ...(stages || []).map((s) => ({ value: s._id, label: s.label }))]} aria-label={`Instalment ${i + 1} stage`} />}</td>
                  <td className="pb-1.5 w-8"><button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove instalment ${i + 1}`} className="p-2 text-[#7E93A6] hover:text-[#B06A55]"><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody></table>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button type="button" size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => setRows([...rows, { label: '', percent: '', trigger: 'stage', stageKey: '' }])}>Instalment</Button>
              <span className={cx('text-xs tabular-nums', total === 100 ? 'text-[#0E8A86]' : 'text-[#92400E]')}>Total {total} %{total !== 100 ? ' — must be 100 %' : ''}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setPlanOpen(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={busy === 'plan'} disabled={total !== 100}>Save plan</Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
};
