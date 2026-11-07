'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Plus, RefreshCw, Wallet } from 'lucide-react';
import type { WhatsappCreditsCompany, WhatsappPricingView } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../_lib/api';
import { Modal } from '../../_components/Modal';
import { useToast } from '../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, PageHeader, SelectField, Table, TableSkeleton, TextField, cx, td, th } from '../../_components/ui';

const rupees = (n: number) => (n < 0 ? '-' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TYPES = [{ id: 'marketing', label: 'Marketing' }, { id: 'utility', label: 'Utility' }, { id: 'authentication', label: 'Authentication' }, { id: 'service', label: 'Replies' }] as const;
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const lastMonths = (from: string) => Array.from({ length: 12 }, (_, i) => {
  const d = new Date(`${from}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - i);
  return d.toISOString().slice(0, 7);
});
const newRequestId = () => crypto.randomUUID();

function AddCreditModal({ company, onClose, onDone }: { company: WhatsappCreditsCompany; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'add' | 'correction'>('add');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // the same id for every try of this form: a double click or a retry cannot add twice
  const requestId = useRef(newRequestId());
  const n = Number(amount);
  const after = company.balance + (Number.isFinite(n) ? n : 0);
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      await call('addWhatsappCredits', { companyId: company.companyId, amount: n, kind, reference, note, requestId: requestId.current });
      toast(`${rupees(n)} ${kind === 'add' ? 'added for' : 'correction on'} ${company.name}`);
      onDone();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} busy={busy} title={`Credits for ${company.name}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!amount.trim()}>Save</Button></>}>
      <div className="space-y-3">
        <SelectField label="What is this?" value={kind} onChange={(e) => setKind(e.target.value as 'add' | 'correction')}>
          <option value="add">Payment received: add credits</option>
          <option value="correction">Correction: up or down, with a reason</option>
        </SelectField>
        <TextField label="Amount in ₹ (1 credit = ₹1, before GST)" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        <TextField label={kind === 'add' ? 'Payment reference (UTR, UPI or invoice number)' : 'Reference (optional)'} value={reference} onChange={(e) => setReference(e.target.value)} />
        <TextField label={kind === 'add' ? 'Note (optional, the client sees this)' : 'Reason (the client sees this)'} value={note} onChange={(e) => setNote(e.target.value)} />
        {amount.trim() && Number.isFinite(n) && <p className="text-[13px] text-[#3F5A70]">Balance after this: <b className="tabular-nums">{rupees(after)}</b></p>}
        <p className="text-[12px] text-[#5E778C]">This cannot be edited afterwards. A mistake is fixed with a correction, so the history stays complete.</p>
        {problem && <ErrorBox message={problem} />}
      </div>
    </Modal>
  );
}

function PricingCard({ pricing, onSaved }: { pricing: WhatsappPricingView; onSaved: () => void }) {
  const toast = useToast();
  const [p, setP] = useState(pricing);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(pricing), [pricing]);
  const setRate = (table: 'prices' | 'costs', id: string, v: string) => setP((x) => ({ ...x, [table]: { ...x[table], [id]: v as unknown as number } }));
  const save = async () => {
    setBusy(true);
    try {
      await call('saveWhatsappPricing', p);
      toast('Prices saved');
      onSaved();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mb-5">
      <CardHeader title="Prices" description="Per delivered message, before GST, for Indian numbers. Update Meta's cost when Meta or your partner changes it." actions={<Button onClick={() => void save()} loading={busy}>Save prices</Button>} />
      <Table label="Prices">
        <thead><tr><th className={th}>Type</th><th className={th}>Client pays (₹)</th><th className={th}>Meta's cost (₹)</th><th className={th}>Your margin</th></tr></thead>
        <tbody className="divide-y divide-[#E3EDF5]">
          {TYPES.map((t) => {
            const margin = Number(p.prices[t.id]) - Number(p.costs[t.id]);
            return (
              <tr key={t.id}>
                <td className={td}>{t.label}</td>
                <td className={td}><input aria-label={`${t.label} price`} className="w-24 rounded-lg border border-[#C4D6E6] px-2 py-1.5 text-[13px] tabular-nums" type="number" step="0.0001" min={0} value={p.prices[t.id]} onChange={(e) => setRate('prices', t.id, e.target.value)} /></td>
                <td className={td}><input aria-label={`${t.label} cost`} className="w-24 rounded-lg border border-[#C4D6E6] px-2 py-1.5 text-[13px] tabular-nums" type="number" step="0.0001" min={0} value={p.costs[t.id]} onChange={(e) => setRate('costs', t.id, e.target.value)} /></td>
                <td className={cx(td, 'tabular-nums', margin < 0 ? 'font-semibold text-[#B42318]' : 'text-[#0A1F33]')}>
                  {margin < 0 && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />}₹{margin.toFixed(4)}{margin < 0 ? ' loss on each message' : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <div className="grid gap-3 border-t border-[#E6EFF6] p-5 sm:grid-cols-2">
        <TextField label="Warn the client below (₹)" type="number" min={0} value={String(p.lowBalanceAt)} onChange={(e) => setP((x) => ({ ...x, lowBalanceAt: e.target.value as unknown as number }))} />
        <TextField label="Replies allowed each month at zero credits" hint="So a customer who wrote in is not ignored. These take the balance below zero, and you pay Meta for any past the free 1,000." type="number" min={0} value={String(p.replyGrace)} onChange={(e) => setP((x) => ({ ...x, replyGrace: e.target.value as unknown as number }))} />
      </div>
    </Card>
  );
}

export function WhatsappCreditsClient() {
  const [month, setMonth] = useState('');
  const data = useResource(() => call('whatsappCreditsOverview', month ? { month } : {}), [month]);
  const d = data.data;
  const [adding, setAdding] = useState<WhatsappCreditsCompany | null>(null);
  const tiles = d ? [
    { label: 'Client balances', value: rupees(d.totals.balance), hint: 'What you still owe clients in messages' },
    { label: 'Credits added', value: rupees(d.totals.added), hint: monthName(d.month) },
    { label: 'Used by clients', value: rupees(d.totals.used), hint: `${d.totals.messages.toLocaleString('en-IN')} messages` },
    { label: "Meta's cost", value: rupees(d.totals.metaCost), hint: 'Check against your partner\'s bill' },
    { label: 'Your margin', value: rupees(d.totals.margin), hint: 'Before any partner fee and GST' },
  ] : [];
  return (
    <>
      <PageHeader eyebrow="Customers" icon={<Wallet className="h-6 w-6" />} title="WhatsApp credits"
        description="Clients pay BroaddCast and you add their credits here. Clients see their balance and usage, never Meta's cost or your margin."
        actions={<span className="flex items-center gap-2">
          {d && <select aria-label="Month" className="rounded-lg border border-[#C4D6E6] bg-white px-2.5 py-2 text-[13px]" value={d.month} onChange={(e) => setMonth(e.target.value)}>{lastMonths(d.thisMonth).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</select>}
          <Button variant="secondary" onClick={data.reload} loading={data.loading && Boolean(d)} icon={<RefreshCw className="h-4 w-4" aria-hidden />}>Refresh</Button>
        </span>} />
      <ErrorBox message={data.error} onRetry={data.reload} className="mb-4" />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {(d ? tiles : [0, 1, 2, 3, 4].map(() => null)).map((t, i) => (
          <Card key={i} className="p-4">
            {t ? <><div className="text-[13px] text-[#5E778C]">{t.label}</div><div className="mt-1 text-[1.35rem] font-semibold tabular-nums text-[#0A1F33]">{t.value}</div><div className="text-[12px] text-[#5E778C]">{t.hint}</div></> : <div className="h-[72px]" />}
          </Card>
        ))}
      </div>

      <Card className="mb-5">
        <CardHeader title="Clients" description="Companies with the WhatsApp credits switch on (Companies › the company › features)." />
        {!d ? <TableSkeleton rows={3} cols={8} /> : !d.companies.length ? (
          <p className="px-5 py-8 text-center text-[13px] text-[#5E778C]">No company has WhatsApp credits turned on yet.</p>
        ) : (
          <Table label="Clients">
            <thead><tr><th className={th}>Company</th><th className={th}>Balance</th><th className={th}>Added</th><th className={th}>Used</th><th className={th}>Messages</th><th className={th}>Meta's cost</th><th className={th}>Margin</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-[#E3EDF5]">
              {d.companies.map((c) => (
                <tr key={c.companyId}>
                  <td className={td}>
                    <span className="font-semibold text-[#0A1F33]">{c.name}</span>
                    {!c.direct && <span className="block text-[12px] text-[#93370D]">WhatsApp direct is off, so nothing is charged yet.</span>}
                    {c.mismatch !== 0 && <span className="block text-[12px] font-semibold text-[#B42318]"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />Balance differs from its history by {rupees(c.mismatch)}. Check before adding credits.</span>}
                  </td>
                  <td className={cx(td, 'tabular-nums font-semibold', c.low && 'text-[#B42318]')}>{rupees(c.balance)}{c.low && <span className="block text-[12px] font-normal">Low</span>}{c.held > 0 && <span className="block text-[12px] font-normal text-[#5E778C]">{rupees(c.held)} held</span>}</td>
                  <td className={cx(td, 'tabular-nums')}>{rupees(c.addedMonth)}</td>
                  <td className={cx(td, 'tabular-nums')}>{rupees(c.usedMonth)}</td>
                  <td className={cx(td, 'tabular-nums')}>{c.messages.toLocaleString('en-IN')}{c.freeMessages > 0 && <span className="block text-[12px] text-[#5E778C]">{c.freeMessages.toLocaleString('en-IN')} free</span>}</td>
                  <td className={cx(td, 'tabular-nums')}>{rupees(c.metaCostMonth)}</td>
                  <td className={cx(td, 'tabular-nums', c.marginMonth < 0 && 'text-[#B42318]')}>{rupees(c.marginMonth)}</td>
                  <td className={td}><Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(c)}>Add credits</Button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {d && <PricingCard pricing={d.pricing} onSaved={data.reload} />}
      {adding && <AddCreditModal company={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); data.reload(); }} />}
    </>
  );
}
