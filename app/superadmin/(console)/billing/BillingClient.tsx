'use client';
import { useState } from 'react';
import { CheckCircle2, FilePlus2, Pencil, Receipt, RefreshCw } from 'lucide-react';
import type { BillingInvoice, BillingSubscription } from '@/server/platform/contract';
import { call, errorMessage, useResource } from '../../_lib/api';
import { fmtPrice } from '../../_lib/format';
import { Modal } from '../../_components/Modal';
import { useToast } from '../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, PageHeader, SelectField, Table, TableSkeleton, TextAreaField, TextField, cx, td, th } from '../../_components/ui';

const SUB_STATUS: Record<BillingSubscription['status'], { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]' },
  trial: { label: 'Trial', cls: 'bg-[#EEF6FC] text-[#0B6BB0] ring-[#C4D6E6]' },
  overdue: { label: 'Overdue', cls: 'bg-[#FEF3F2] text-[#B42318] ring-[#FECDCA]' },
  complimentary: { label: 'Complimentary', cls: 'bg-[#EEF4F9] text-[#3F5A70] ring-[#DCE8F2]' },
  cancelled: { label: 'Cancelled', cls: 'bg-[#EEF4F9] text-[#5E778C] ring-[#DCE8F2]' },
};
const badge = (label: string, cls: string) => <span className={cx('inline-flex rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset whitespace-nowrap', cls)}>{label}</span>;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(new Date(day + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const addMonths = (day: string, n: number) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

function invoiceBadge(i: BillingInvoice) {
  if (i.status === 'paid') return badge('Paid', 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]');
  if (i.status === 'void') return badge('Void', 'bg-[#EEF4F9] text-[#5E778C] ring-[#DCE8F2]');
  return i.overdue ? badge('Overdue', 'bg-[#FEF3F2] text-[#B42318] ring-[#FECDCA]') : badge('Due', 'bg-[#FFFAEB] text-[#93370D] ring-[#FEDF89]');
}

export function BillingClient() {
  const data = useResource(() => call('billingOverview', {}), []);
  const toast = useToast();
  const [editSub, setEditSub] = useState<BillingSubscription | null>(null);
  const [newInv, setNewInv] = useState<BillingSubscription | null>(null);
  const [payInv, setPayInv] = useState<BillingInvoice | null>(null);
  const d = data.data;

  const voidInvoice = async (i: BillingInvoice) => {
    try {
      await call('setInvoiceStatus', { id: i.id, status: 'void' });
      toast(`${i.id} voided`);
      data.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const tiles = d
    ? [
        { label: 'Monthly recurring revenue', value: fmtPrice(d.mrr, d.currency), hint: `${d.payingCompanies} paying compan${d.payingCompanies === 1 ? 'y' : 'ies'}` },
        { label: 'Due in 30 days', value: fmtPrice(d.dueNext30, d.currency), hint: `${d.renewalsNext30} renewal${d.renewalsNext30 === 1 ? '' : 's'} coming up` },
        { label: 'Overdue', value: fmtPrice(d.overdue, d.currency), hint: d.overdueCount ? `${d.overdueCount} invoice${d.overdueCount === 1 ? '' : 's'}` : 'Nothing outstanding', bad: d.overdueCount > 0 },
        { label: 'Trials ending', value: String(d.trialsEnding), hint: 'in the next 14 days' },
      ]
    : [];

  return (
    <>
      <PageHeader eyebrow="Customers" icon={<Receipt className="h-6 w-6" />}
        title="Billing"
        description="Subscriptions and invoices for every company. Payments are recorded by hand until a payment gateway is connected."
        actions={<Button variant="secondary" onClick={data.reload} loading={data.loading && Boolean(d)} icon={<RefreshCw className="h-4 w-4" aria-hidden />}>Refresh</Button>}
      />
      <ErrorBox message={data.error} onRetry={data.reload} className="mb-4" />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(d ? tiles : [0, 1, 2, 3].map(() => null)).map((t, i) => (
          <Card key={i} className="p-4">
            {t ? (
              <>
                <div className="text-[13px] text-[#5E778C]">{t.label}</div>
                <div className={cx('mt-1 text-[1.6rem] font-semibold tabular-nums', t.bad ? 'text-[#B42318]' : 'text-[#0A1F33]')}>{t.value}</div>
                <div className="text-[12px] text-[#5E778C]">{t.hint}</div>
              </>
            ) : <div className="h-[72px]" />}
          </Card>
        ))}
      </div>

      <Card className="mb-5">
        <CardHeader title="Subscriptions" description="One per company. Companies without one show their plan's price in grey — set it up with Edit." />
        {!d ? <TableSkeleton rows={3} cols={6} /> : (
          <Table label="Subscriptions">
            <thead>
              <tr><th className={th}>Company</th><th className={th}>Plan</th><th className={th}>Amount</th><th className={th}>Renews</th><th className={th}>Status</th><th className={th}><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-[#E3EDF5]">
              {d.subscriptions.map((s) => (
                <tr key={s.companyId}>
                  <td className={td}><div className="font-semibold">{s.companyName}</div><div className="font-mono text-[12px] text-[#5E778C]">{s.companyId}{s.companyStatus !== 'Active' ? ` · ${s.companyStatus}` : ''}</div></td>
                  <td className={td}>{s.planName}</td>
                  <td className={cx(td, 'tabular-nums', !s.configured && 'text-[#7E93A6]')}>{fmtPrice(s.amount, s.currency)} <span className="text-[12px] text-[#5E778C]">/ {s.cycle === 'yearly' ? 'year' : 'month'}</span></td>
                  <td className={td}>{s.renewsOn || '—'}</td>
                  <td className={td}>{s.configured ? badge(SUB_STATUS[s.status].label, SUB_STATUS[s.status].cls) : badge('Not set up', 'bg-[#EEF4F9] text-[#5E778C] ring-[#DCE8F2]')}</td>
                  <td className={cx(td, 'whitespace-nowrap text-right')}>
                    <div className="inline-flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setEditSub(s)} icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}>Edit</Button>
                      <Button variant="secondary" size="sm" onClick={() => setNewInv(s)} icon={<FilePlus2 className="h-3.5 w-3.5" aria-hidden />}>Invoice</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Invoices" description="Newest first. Mark an invoice paid when the money arrives." />
        {!d ? <TableSkeleton rows={3} cols={6} /> : !d.invoices.length ? (
          <p className="p-5 text-[14px] text-[#5E778C]">No invoices yet — use Invoice next to a company.</p>
        ) : (
          <Table label="Invoices">
            <thead>
              <tr><th className={th}>Invoice</th><th className={th}>Company</th><th className={th}>Amount</th><th className={th}>Issued · due</th><th className={th}>Status</th><th className={th}><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-[#E3EDF5]">
              {d.invoices.map((i) => (
                <tr key={i.id} className={i.overdue ? 'bg-[#FFFCF5]' : ''}>
                  <td className={td}><div className="font-mono font-semibold">{i.id}</div><div className="text-[12px] text-[#5E778C]">{i.description}{i.periodFrom ? ` · ${i.periodFrom} – ${i.periodTo}` : ''}</div></td>
                  <td className={td}>{i.companyName}</td>
                  <td className={cx(td, 'tabular-nums')}>{fmtPrice(i.amount, i.currency)}</td>
                  <td className={td}>{i.issuedOn}<div className="text-[12px] text-[#5E778C]">due {i.dueOn}</div></td>
                  <td className={td}>{invoiceBadge(i)}{i.status === 'paid' && <div className="mt-1 text-[12px] text-[#5E778C]">{i.paidOn} · {i.method}{i.reference ? ` · ${i.reference}` : ''}</div>}</td>
                  <td className={cx(td, 'whitespace-nowrap text-right')}>
                    {i.status === 'due' && (
                      <div className="inline-flex gap-2">
                        <Button size="sm" onClick={() => setPayInv(i)} icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>Mark paid</Button>
                        <Button variant="ghost" size="sm" onClick={() => void voidInvoice(i)}>Void</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {editSub && <SubscriptionDialog sub={editSub} onClose={() => setEditSub(null)} onSaved={() => { setEditSub(null); data.reload(); toast('Subscription saved'); }} />}
      {newInv && <InvoiceDialog sub={newInv} onClose={() => setNewInv(null)} onSaved={(id) => { setNewInv(null); data.reload(); toast(`${id} created`); }} />}
      {payInv && d && <PaidDialog invoice={payInv} methods={d.paymentMethods} onClose={() => setPayInv(null)} onSaved={() => { setPayInv(null); data.reload(); toast(`${payInv.id} marked paid`); }} />}
    </>
  );
}

function SubscriptionDialog({ sub, onClose, onSaved }: { sub: BillingSubscription; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ amount: String(sub.amount), currency: sub.currency, cycle: sub.cycle, status: sub.status, startedOn: sub.startedOn || today(), renewsOn: sub.renewsOn || addMonths(today(), sub.cycle === 'yearly' ? 12 : 1), notes: sub.notes });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await call('saveSubscription', { companyId: sub.companyId, amount: Number(f.amount), currency: f.currency, cycle: f.cycle as 'monthly' | 'yearly', status: f.status as BillingSubscription['status'], startedOn: f.startedOn, renewsOn: f.renewsOn, notes: f.notes });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} busy={busy} title={`Subscription · ${sub.companyName}`} description={`Plan: ${sub.planName}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Save</Button></>}>
      <ErrorBox message={error} className="mb-3" />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Status" value={f.status} onChange={set('status')}>
          {Object.entries(SUB_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </SelectField>
        <SelectField label="Billing cycle" value={f.cycle} onChange={set('cycle')}>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </SelectField>
        <TextField label="Amount" type="number" min={0} step="1" value={f.amount} onChange={set('amount')} hint={f.cycle === 'yearly' ? 'Per year' : 'Per month'} />
        <TextField label="Currency" value={f.currency} onChange={set('currency')} maxLength={3} />
        <TextField label="Start date" type="date" value={f.startedOn} onChange={set('startedOn')} />
        <TextField label={f.status === 'trial' ? 'Trial ends' : 'Renews on'} type="date" value={f.renewsOn} onChange={set('renewsOn')} />
      </div>
      <TextAreaField label="Notes" value={f.notes} onChange={set('notes')} className="mt-4" placeholder="Discount, contract terms, contact for billing…" />
    </Modal>
  );
}

function InvoiceDialog({ sub, onClose, onSaved }: { sub: BillingSubscription; onClose: () => void; onSaved: (id: string) => void }) {
  const start = sub.renewsOn || today();
  const [f, setF] = useState({ amount: String(sub.amount), currency: sub.currency, description: `${sub.planName} plan`, periodFrom: start, periodTo: addDays(addMonths(start, sub.cycle === 'yearly' ? 12 : 1), -1), issuedOn: today(), dueOn: addDays(today(), 15) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await call('createInvoice', { companyId: sub.companyId, ...f, amount: Number(f.amount) });
      onSaved(r.id);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} busy={busy} title={`New invoice · ${sub.companyName}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Create invoice</Button></>}>
      <ErrorBox message={error} className="mb-3" />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Description" value={f.description} onChange={set('description')} className="sm:col-span-2" />
        <TextField label="Amount" type="number" min={0} step="1" value={f.amount} onChange={set('amount')} />
        <TextField label="Currency" value={f.currency} onChange={set('currency')} maxLength={3} />
        <TextField label="Period from" type="date" value={f.periodFrom} onChange={set('periodFrom')} />
        <TextField label="Period to" type="date" value={f.periodTo} onChange={set('periodTo')} />
        <TextField label="Issued on" type="date" value={f.issuedOn} onChange={set('issuedOn')} />
        <TextField label="Due on" type="date" value={f.dueOn} onChange={set('dueOn')} />
      </div>
    </Modal>
  );
}

function PaidDialog({ invoice, methods, onClose, onSaved }: { invoice: BillingInvoice; methods: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ method: methods[0] || 'Bank transfer', reference: '', paidOn: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await call('setInvoiceStatus', { id: invoice.id, status: 'paid', ...f });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} busy={busy} size="sm" title={`Mark ${invoice.id} paid`} description={`${invoice.companyName} · ${fmtPrice(invoice.amount, invoice.currency)}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Mark paid</Button></>}>
      <ErrorBox message={error} className="mb-3" />
      <div className="grid gap-4">
        <SelectField label="Paid by" value={f.method} onChange={set('method')}>
          {methods.map((m) => <option key={m}>{m}</option>)}
        </SelectField>
        <TextField label="Reference" value={f.reference} onChange={set('reference')} placeholder="UTR / transaction id / cheque no." />
        <TextField label="Payment date" type="date" value={f.paidOn} onChange={set('paidOn')} />
      </div>
    </Modal>
  );
}
