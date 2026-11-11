/**
 * Lead › Journey, once a unit is booked: the customer side of the relationship and the RERA payment schedule.
 *
 *   Engagement   health (engaged / cooling / gone quiet), recent touches from every channel, and a quick log for
 *                touches the CRM cannot see (event attended, progress update e-mailed, family meeting…)
 *   Customer     the SOP steps after booking (welcome call, owner, community preview, agreement, referral,
 *                possession, move-in) with what is due now
 *   Payments     the schedule from the registered plan: each instalment, its demand, paid / outstanding, days late
 *                and interest accrued (shown, never charged), the 10 % limit before registration, receipts
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, FileText, Printer } from 'lucide-react';
import { api } from '../../../core/api';
import { toAppError } from '../../../core/errors';
import { formatDateTime, formatRelative } from '../../../core/dates';
import { formatINR } from '../../../core/format';
import { ENGAGEMENT_CHANNELS, ENGAGEMENT_KINDS, type DemandLetter, type EngagementData, type PaymentPlan, type PaymentStatement, type Person } from '../../../core/journeyTypes';
import type { InventoryUnit } from '../../../types/crm';
import { Button, ErrorState, Field, InlineNotice, Select, cx, inputCls } from '../../../components/ui';

const sectionTitle = 'text-[11px] font-bold uppercase tracking-[0.08em] text-[#5E778C]';
const HEALTH: Record<string, { label: string; cls: string }> = {
  engaged: { label: 'Engaged', cls: 'bg-[#EAF4F3] text-[#0B4F4C]' },
  cooling: { label: 'Cooling', cls: 'bg-[#FDF3E7] text-[#92400E]' },
  cold: { label: 'Gone quiet', cls: 'bg-[#FAF0EC] text-[#8A3E28]' },
  new: { label: 'Too early to tell', cls: 'bg-[#F2F7FB] text-[#0B2A44]' },
};
const STATUS_CLS: Record<string, string> = { paid: 'text-[#0E8A86]', overdue: 'text-[#B06A55] font-semibold', 'part paid': 'text-[#92400E]', demanded: 'text-[#0B2A44]', 'not due': 'text-[#7E93A6]' };

export const EngagementSection: React.FC<{ leadId: string; people: Person[]; canEdit: boolean; active: boolean; users: Array<{ id: string; name: string; role: string }>; canAssign: boolean }> = ({ leadId, people, canEdit, active, users, canAssign }) => {
  const [data, setData] = useState<EngagementData | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ channel: 'whatsapp', kind: 'progressUpdate', note: '', personId: '', responded: false });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api.customer.engagement(leadId));
      setError('');
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
  }, [leadId]);
  useEffect(() => {
    if (active && !data) void load();
  }, [active, data, load]);

  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    setMsg('');
    try {
      await fn();
      setMsg(done);
      await load();
    } catch (e) {
      setMsg(toAppError(e).userMessage);
    } finally {
      setBusy('');
    }
  };
  if (error) return <ErrorState title="Could not load engagement" message={error} onRetry={load} compact />;
  if (!data) return <div className="h-20 rounded-lg bg-[#F2F7FB] animate-pulse" aria-label="Loading engagement" />;
  const h = HEALTH[data.health.state];

  return (
    <div className="space-y-6">
      <section aria-labelledby="eng-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 id="eng-h" className={sectionTitle}>Engagement</h4>
          <span className={cx('text-[11px] font-semibold px-2 py-0.5 rounded-full', h.cls)}>{h.label}</span>
        </div>
        <p className="text-xs text-[#5E778C] mt-1">
          {data.health.lastResponseAt ? <>Last responded {formatRelative(data.health.lastResponseAt)}</> : 'No response recorded yet'} · {data.health.touches30} touch{data.health.touches30 === 1 ? '' : 'es'} and {data.health.responses30} response{data.health.responses30 === 1 ? '' : 's'} in 30 days
        </p>
        {data.people.length > 1 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {data.people.map((p) => <li key={p.personId} className={cx('text-[11px] px-2 py-1 rounded-full', HEALTH[p.state].cls)}>{p.name}: {HEALTH[p.state].label.toLowerCase()}</li>)}
          </ul>
        )}
        {canEdit && (
          <form className="mt-3 grid grid-cols-2 sm:grid-cols-[auto_auto_1fr_auto] gap-2 items-end" onSubmit={(e) => { e.preventDefault(); void run('log', () => api.customer.log({ leadId, ...form, personId: form.personId || undefined }), 'Logged.').then(() => setForm((f) => ({ ...f, note: '', responded: false }))); }}>
            <Field label="Channel"><Select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} options={ENGAGEMENT_CHANNELS} /></Field>
            <Field label="What"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} options={ENGAGEMENT_KINDS.map((k) => ({ value: k.id, label: k.label }))} /></Field>
            <Field label="Note" className="col-span-2 sm:col-span-1"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={inputCls} placeholder="October site photos to the family group" /></Field>
            <Button type="submit" variant="secondary" loading={busy === 'log'}>Log touch</Button>
            {people.length > 1 && (
              <Field label="With" className="col-span-2 sm:col-span-2"><Select value={form.personId} onChange={(e) => setForm({ ...form, personId: e.target.value })} options={[{ value: '', label: 'The family' }, ...people.map((p) => ({ value: p.id, label: p.name }))]} /></Field>
            )}
            <label className="col-span-2 sm:col-span-2 inline-flex items-center gap-2 text-xs text-[#0B2A44] min-h-9"><input type="checkbox" checked={form.responded} onChange={(e) => setForm({ ...form, responded: e.target.checked })} className="w-4 h-4 accent-[#0B2A44]" />They responded</label>
          </form>
        )}
        {msg && <InlineNotice tone={msg === 'Logged.' || msg.startsWith('Owner') || msg.endsWith('done.') ? 'success' : 'warning'} className="mt-2">{msg}</InlineNotice>}
        <ul className="mt-3 divide-y divide-[#EEF3F8] border border-[#E3EDF5] rounded-xl bg-white max-h-56 overflow-y-auto">
          {!data.touches.length && <li className="px-3 py-2.5 text-xs text-[#7E93A6]">Nothing in the last 90 days.</li>}
          {data.touches.slice(0, 20).map((t, i) => (
            <li key={i} className="px-3 py-2 flex items-baseline gap-3 text-xs">
              <span className={cx('w-16 flex-shrink-0 font-semibold', t.direction === 'in' || t.responded ? 'text-[#0E8A86]' : 'text-[#5E778C]')}>{t.direction === 'in' ? 'From them' : t.responded ? 'Answered' : 'To them'}</span>
              <span className="flex-1 min-w-0 truncate text-[#0B2A44]">{t.source === 'engagement' ? (ENGAGEMENT_KINDS.find((k) => k.id === t.kind)?.label || t.kind) : t.channel}{t.note ? ` · ${t.note}` : ''}</span>
              <span className="text-[#7E93A6] tabular-nums flex-shrink-0">{formatRelative(t.at)}</span>
            </li>
          ))}
        </ul>
      </section>

      {data.customer && (
        <section aria-labelledby="cust-h">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 id="cust-h" className={sectionTitle}>Customer since {formatDateTime(data.customer.bookedAt, '').split(',')[0]}</h4>
            <span className="text-xs text-[#5E778C]">Owner: <strong className="text-[#0B2A44] font-semibold">{data.customer.owner || 'not assigned'}</strong></span>
          </div>
          {canAssign && !data.customer.owner && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Customer owner"><Select value="" onChange={(e) => e.target.value && void run('owner', () => api.customer.assignOwner(leadId, e.target.value), 'Owner assigned.')} options={[{ value: '', label: 'Choose who looks after this customer' }, ...users.map((u) => ({ value: u.id, label: u.name }))]} /></Field>
            </div>
          )}
          <ol className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {data.customer.steps.map((s) => {
              const due = data.customer!.due.find((d) => d.key === s.step || (s.step === 'referralAsked' && d.key === 'referralAsk'));
              return (
                <li key={s.step} className={cx('flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs', s.at ? 'border-[#0E8A86]/25 bg-[#EAF4F3]/60' : due?.late ? 'border-[#B06A55]/40 bg-[#FAF0EC]' : 'border-[#E3EDF5] bg-white')}>
                  {s.at ? <CheckCircle2 size={14} className="text-[#0E8A86] flex-shrink-0" aria-hidden /> : <Circle size={14} className="text-[#7E93A6] flex-shrink-0" aria-hidden />}
                  <span className="flex-1 min-w-0 text-[#0B2A44] font-medium">{s.label}</span>
                  {s.at ? <span className="text-[#5E778C]">{formatRelative(s.at)}</span> : due ? <span className={due.late ? 'text-[#B06A55] font-semibold' : 'text-[#92400E]'}>due</span> : null}
                  {!s.at && canEdit && ['possession', 'moveIn'].includes(s.step) && <Button size="xs" variant="ghost" onClick={() => run(s.step, () => api.customer.markStep(leadId, s.step), `${s.label}: done.`)}>Done</Button>}
                </li>
              );
            })}
          </ol>
          {data.customer.due.some((d) => d.key === 'progressUpdate' || d.key === 'reengage') && (
            <p className="text-[11px] text-[#5E778C] mt-2">{data.customer.due.filter((d) => d.key === 'progressUpdate' || d.key === 'reengage').map((d) => d.label).join(' · ')} — log it above once sent.</p>
          )}
        </section>
      )}
    </div>
  );
};

export const PaymentSection: React.FC<{ unit: InventoryUnit; canApprove: boolean; canEdit: boolean; active: boolean }> = ({ unit, canApprove, canEdit, active }) => {
  const [st, setSt] = useState<PaymentStatement | null>(null);
  const [plans, setPlans] = useState<PaymentPlan[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [planId, setPlanId] = useState('');
  const [agreementNo, setAgreementNo] = useState('');
  const [receipt, setReceipt] = useState({ amount: '', reference: '', mode: 'bank' });
  const [letter, setLetter] = useState<DemandLetter | null>(null);
  const letterRef = useRef<HTMLDivElement>(null);
  // the letter opens below the table: bring it into view (and give it focus) so the click visibly does something
  useEffect(() => {
    if (letter) letterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (letter) letterRef.current?.focus();
  }, [letter]);
  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.customer.statement(unit.inventoryId), api.customer.plans()]);
      setSt(s);
      setPlans(p.plans);
      setError('');
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
  }, [unit.inventoryId]);
  useEffect(() => {
    if (active && !st) void load();
  }, [active, st, load]);
  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: done });
      await load();
    } catch (e) {
      setMsg({ tone: 'warning', text: toAppError(e).userMessage });
    } finally {
      setBusy('');
    }
  };
  if (error) return <ErrorState title="Could not load payments" message={error} onRetry={load} compact />;
  if (!st) return <div className="h-20 rounded-lg bg-[#F2F7FB] animate-pulse" aria-label="Loading payments" />;
  const t = st.totals;

  return (
    <section aria-labelledby="pay-h" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id="pay-h" className={sectionTitle}>Payments · {st.unitNumber}</h4>
        <span className="text-[11px] text-[#5E778C]">{st.planName ? `${st.planName}${st.deviation ? ' · deviation' : ''}` : st.lines.length ? 'Custom schedule (deviation)' : 'No schedule yet'}</span>
      </div>

      {!st.lines.length && (
        canApprove && plans.length ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run('apply', () => api.customer.applyPlan(unit.inventoryId, planId), 'Payment plan applied. Booking instalment demanded.'); }}>
            <Field label="Registered payment plan" className="min-w-60"><Select value={planId} onChange={(e) => setPlanId(e.target.value)} options={[{ value: '', label: 'Choose' }, ...plans.map((p) => ({ value: p._id, label: `${p.name} · ${p.agreementRef}` }))]} /></Field>
            <Button type="submit" variant="primary" disabled={!planId} loading={busy === 'apply'}>Apply plan</Button>
          </form>
        ) : (
          <p className="text-xs text-[#5E778C]">{plans.length ? 'A manager applies the registered payment plan.' : 'No payment plan has been entered from the registered agreement yet (Team › Construction & plans).'}</p>
        )
      )}

      {st.lines.length > 0 && (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl overflow-hidden border border-[#E3EDF5] bg-[#E3EDF5] text-xs">
            {([['Agreed (excl. GST)', t.agreed], ['Received', t.paid], ['Demanded, unpaid', t.outstandingDemanded], ['Overdue', t.overdue]] as Array<[string, number]>).map(([k, v]) => (
              <div key={k} className="bg-white px-3 py-2"><dt className="text-[#5E778C]">{k}</dt><dd className={cx('font-bold tabular-nums mt-0.5', k === 'Overdue' && v ? 'text-[#B06A55]' : 'text-[#0B2A44]')}>{formatINR(v)}</dd></div>
            ))}
          </dl>
          {t.advanceCap !== null && (
            <InlineNotice tone="info">Agreement for sale not registered yet: at most {formatINR(t.advanceCap)} (10 %) can be demanded or received until it is (RERA, Section 13).</InlineNotice>
          )}
          <div className="overflow-x-auto rounded-xl border border-[#E3EDF5] bg-white">
            <table className="w-full text-xs">
              <thead className="text-left text-[#5E778C]">
                <tr className="border-b border-[#EEF3F8]"><th scope="col" className="px-3 py-2 font-semibold">Instalment</th><th scope="col" className="px-3 py-2 font-semibold text-right">Amount</th><th scope="col" className="px-3 py-2 font-semibold text-right">GST</th><th scope="col" className="px-3 py-2 font-semibold">Status</th><th scope="col" className="px-3 py-2 font-semibold"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {st.lines.map((l) => (
                  <tr key={l.id} className="border-b last:border-0 border-[#EEF3F8] align-top">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-[#0B2A44]">{l.label}<div className="text-[10px] font-normal text-[#7E93A6]">{l.demandNo || l.trigger}</div></th>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatINR(l.amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#5E778C] whitespace-nowrap">{formatINR(l.gst)}</td>
                    <td className={cx('px-3 py-2', STATUS_CLS[l.status])}>
                      {l.status}{l.status === 'part paid' ? ` · ${formatINR(l.outstanding)} left` : ''}
                      {l.dueDate && l.status !== 'paid' && <div className="text-[10px] text-[#7E93A6] font-normal">due {formatDateTime(l.dueDate, '').split(',')[0]}{l.daysLate ? ` · ${l.daysLate} days late` : ''}</div>}
                      {l.interestAccrued > 0 && <div className="text-[10px] font-normal">interest accrued {formatINR(l.interestAccrued)} (not charged)</div>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {l.demandNo ? <Button size="xs" variant="ghost" icon={<FileText size={12} />} onClick={() => api.customer.demandLetter(unit.inventoryId, l.id).then(setLetter, (e) => setMsg({ tone: 'warning', text: toAppError(e).userMessage }))}>Letter</Button>
                        : canApprove && l.trigger === 'possession' ? <Button size="xs" variant="ghost" loading={busy === l.id} onClick={() => run(l.id, () => api.customer.raiseDemand(unit.inventoryId, l.id), 'Demand raised.')}>Raise demand</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#5E778C]">
            GST is shown separately ({formatINR(t.gst)} in all). {st.interestRatePct ? `Interest for delay at ${st.interestRatePct} % a year (${st.interestRateSource || 'source not recorded'}); shown, not charged.` : 'No interest rate is set (Settings): interest for delay is not calculated.'}
          </p>
        </>
      )}

      {st.lines.length > 0 && !st.agreementRegisteredAt && canApprove && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run('agr', () => api.customer.recordAgreement(unit.inventoryId, agreementNo), 'Agreement recorded. Its instalment is demanded.'); }}>
          <Field label="Agreement for sale registered — document no." className="min-w-60"><input value={agreementNo} onChange={(e) => setAgreementNo(e.target.value)} className={inputCls} placeholder="e.g. MDL/1234/2026" required /></Field>
          <Button type="submit" variant="secondary" loading={busy === 'agr'}>Record registration</Button>
        </form>
      )}
      {st.agreementRegisteredAt && <p className="text-[11px] text-[#0E8A86]">Agreement registered {formatDateTime(st.agreementRegisteredAt, '').split(',')[0]} · {st.agreementDocumentNo}</p>}

      {st.lines.length > 0 && canEdit && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run('rcpt', () => api.customer.recordReceipt({ unitId: unit.inventoryId, amount: Number(receipt.amount), reference: receipt.reference, mode: receipt.mode }), 'Receipt recorded.').then(() => setReceipt({ amount: '', reference: '', mode: 'bank' })); }}>
          <Field label="Received (₹)" className="w-36"><input type="number" min={1} value={receipt.amount} onChange={(e) => setReceipt({ ...receipt, amount: e.target.value })} className={inputCls} required /></Field>
          <Field label="Mode" className="w-28"><Select value={receipt.mode} onChange={(e) => setReceipt({ ...receipt, mode: e.target.value })} options={['bank', 'cheque', 'upi', 'card', 'other']} /></Field>
          <Field label="Reference" className="flex-1 min-w-40"><input value={receipt.reference} onChange={(e) => setReceipt({ ...receipt, reference: e.target.value })} className={inputCls} placeholder="NEFT / UTR / cheque no." required /></Field>
          <Button type="submit" variant="secondary" loading={busy === 'rcpt'}>Record receipt</Button>
        </form>
      )}
      {msg && <InlineNotice tone={msg.tone}>{msg.text}</InlineNotice>}

      {letter && (
        <div ref={letterRef} tabIndex={-1} role="region" aria-label="Demand letter" className="rounded-xl border border-[#D3E3F0] bg-white p-4 text-xs leading-relaxed print:border-0">
          <div className="flex justify-between gap-2"><strong className="text-sm text-[#0B2A44]">Payment demand {letter.demandNo}</strong><span>{letter.date}</span></div>
          <p className="mt-2">To {letter.to} · Unit {letter.unit}{letter.project ? ` · TG-RERA ${letter.project}` : ''}</p>
          <p className="mt-1">As per the registered agreement for sale ({letter.agreementRef}), the instalment <strong>{letter.instalment}</strong> is due by <strong>{letter.dueDate}</strong>:</p>
          <table className="mt-2 text-xs"><tbody>
            <tr><td className="pr-6">Instalment</td><td className="text-right tabular-nums">{formatINR(letter.amount)}</td></tr>
            <tr><td className="pr-6">GST</td><td className="text-right tabular-nums">{formatINR(letter.gst)}</td></tr>
            <tr><td className="pr-6 font-semibold">Total</td><td className="text-right tabular-nums font-semibold">{formatINR(letter.total)}</td></tr>
          </tbody></table>
          <p className="mt-2 text-[#5E778C]">{letter.note}</p>
          <div className="mt-3 flex gap-2 print:hidden"><Button size="xs" variant="secondary" icon={<Printer size={12} />} onClick={() => window.print()}>Print</Button><Button size="xs" variant="ghost" onClick={() => setLetter(null)}>Close</Button></div>
          <p className="mt-2 text-[10px] text-[#7E93A6] print:hidden">The CRM does not send this. Check it, then send it the usual way.</p>
        </div>
      )}
    </section>
  );
};
