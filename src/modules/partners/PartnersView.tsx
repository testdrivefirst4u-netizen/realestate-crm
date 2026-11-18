/**
 * Channel Partners (/partners, plan feature channelPartners; server: modules/partners.ts).
 *
 * A registry of brokers who bring leads, the commission rate for each (a default % with optional deal-value slabs),
 * and the brokerage accrued on the units their leads have booked. Attribution follows "first CP keeps it" for
 * CFG.CP_REGISTRATION_DAYS, enforced on the server. Commission figures are shown only with partners.commission.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Handshake, Pencil, Plus, RefreshCw, Search, Trash2, UserPlus, X } from 'lucide-react';
import { api, type ChannelPartner, type CommissionRow, type CommissionSlab, type PartnerLeadRow } from '../../core/api';
import { formatDate } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, ConfirmDialog, EmptyState, Field, InlineNotice, LoadingState, Modal, Select, cx, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const inr = (n: number | null | undefined) => (n === null || n === undefined ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'));
const pct = (n: number) => `${Number(n || 0)}%`;

/* ------------------------------ edit modal ------------------------------- */

interface PartnerForm {
  id?: string; name: string; firm: string; phone: string; email: string; pan: string; gst: string; reraId: string;
  defaultRate: string; slabs: CommissionSlab[]; status: 'Active' | 'Suspended'; notes: string;
}
const emptyForm: PartnerForm = { name: '', firm: '', phone: '', email: '', pan: '', gst: '', reraId: '', defaultRate: '2', slabs: [], status: 'Active', notes: '' };

const toForm = (p: ChannelPartner): PartnerForm => ({ id: p.id, name: p.name, firm: p.firm, phone: p.phone, email: p.email, pan: p.pan, gst: p.gst, reraId: p.reraId, defaultRate: String(p.defaultRate ?? ''), slabs: p.slabs || [], status: p.status, notes: p.notes });

const PartnerModal: React.FC<{ form: PartnerForm; onClose: () => void; onSaved: () => void }> = ({ form, onClose, onSaved }) => {
  const [f, setF] = useState(form);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof PartnerForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((v) => ({ ...v, [k]: e.target.value }));
  const setSlab = (i: number, k: keyof CommissionSlab, val: string) => setF((v) => ({ ...v, slabs: v.slabs.map((s, j) => (j === i ? { ...s, [k]: Number(val) || 0 } : s)) }));
  const addSlab = () => setF((v) => ({ ...v, slabs: [...v.slabs, { minValue: 0, rate: 0 }] }));
  const removeSlab = (i: number) => setF((v) => ({ ...v, slabs: v.slabs.filter((_, j) => j !== i) }));
  const save = async () => {
    setBusy(true);
    try {
      await api.partners.save({
        id: f.id, name: f.name, firm: f.firm, phone: f.phone, email: f.email, pan: f.pan, gst: f.gst, reraId: f.reraId,
        defaultRate: Number(f.defaultRate) || 0, slabs: f.slabs.filter((s) => s.minValue > 0 && s.rate > 0), status: f.status, notes: f.notes,
      });
      toast('Saved', f.id ? 'Channel partner updated.' : 'Channel partner added.', 'success');
      onSaved();
    } catch (e) {
      toast('Not saved', errText('partners.save', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width="lg" title={f.id ? `Edit ${form.name}` : 'Add a channel partner'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.name.trim()} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Partner name"><input className={inputCls} value={f.name} onChange={set('name')} maxLength={120} autoFocus /></Field>
          <Field label="Firm / agency"><input className={inputCls} value={f.firm} onChange={set('firm')} maxLength={120} /></Field>
          <Field label="Phone"><input className={inputCls} value={f.phone} onChange={set('phone')} maxLength={20} placeholder="98765 43210" /></Field>
          <Field label="Email"><input className={inputCls} value={f.email} onChange={set('email')} maxLength={160} /></Field>
          <Field label="PAN"><input className={inputCls} value={f.pan} onChange={set('pan')} maxLength={20} /></Field>
          <Field label="GST"><input className={inputCls} value={f.gst} onChange={set('gst')} maxLength={20} /></Field>
          <Field label="RERA agent reg. no."><input className={inputCls} value={f.reraId} onChange={set('reraId')} maxLength={40} /></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={[{ value: 'Active', label: 'Active' }, { value: 'Suspended', label: 'Suspended' }]} /></Field>
        </div>
        <Field label="Default commission" hint="Percent of the deal value (the unit's agreed/quoted amount) when a lead books.">
          <div className="flex items-center gap-2"><input className={cx(inputCls, 'w-24')} type="number" min={0} max={100} step="0.1" value={f.defaultRate} onChange={set('defaultRate')} /><span className="text-sm text-[#65676B]">% of deal value</span></div>
        </Field>
        <Field label="Deal-value slabs (optional)" hint="A higher rate for bigger deals: the highest slab whose minimum is ≤ the deal value wins, otherwise the default above.">
          <div className="space-y-2">
            {f.slabs.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-[#65676B]">Deal ≥</span>
                <input className={cx(inputCls, 'w-40')} type="number" min={0} step="1000" value={s.minValue || ''} onChange={(e) => setSlab(i, 'minValue', e.target.value)} placeholder="₹ e.g. 10000000" />
                <span className="text-xs text-[#65676B]">→</span>
                <input className={cx(inputCls, 'w-20')} type="number" min={0} max={100} step="0.1" value={s.rate || ''} onChange={(e) => setSlab(i, 'rate', e.target.value)} placeholder="%" />
                <span className="text-xs text-[#65676B]">%</span>
                <button type="button" onClick={() => removeSlab(i)} aria-label="Remove slab" className="rounded-lg p-1.5 text-[#B42318] hover:bg-[#FEF3F2]"><X size={15} /></button>
              </div>
            ))}
            <Button variant="secondary" size="xs" icon={<Plus size={12} />} onClick={addSlab}>Add a slab</Button>
          </div>
        </Field>
        <Field label="Notes"><textarea className={cx(inputCls, 'min-h-[72px]')} value={f.notes} onChange={set('notes')} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
};

/* ------------------------------ detail modal ----------------------------- */

const AttributeBox: React.FC<{ cpId: string; onDone: () => void }> = ({ cpId, onDone }) => {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Array<{ id: string; name: string; phone: string; stage: string; partnerId: string }> | null>(null);
  const [busy, setBusy] = useState('');
  const search = async () => {
    if (q.trim().length < 2) return;
    setBusy('search');
    try { setRows((await api.partners.findLeads(q.trim())).leads); } catch (e) { toast('Search failed', errText('partners.findLeads', e), 'alert'); } finally { setBusy(''); }
  };
  const attribute = async (leadId: string) => {
    setBusy(leadId);
    try { await api.partners.attributeLead(leadId, cpId); toast('Attributed', 'The lead is now registered to this partner.', 'success'); onDone(); }
    catch (e) { toast('Not attributed', errText('partners.attributeLead', e), 'alert'); }
    finally { setBusy(''); }
  };
  return (
    <div className="rounded-xl border border-[#DADDE1] bg-[#F7F9FB] p-3">
      <p className="mb-2 text-sm font-semibold text-[#1C1E21]">Attribute a lead to this partner</p>
      <div className="flex gap-2">
        <label className="relative flex-1"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#65676B]" />
          <input className={cx(inputCls, 'pl-8')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder="Search leads by phone or name" /></label>
        <Button variant="secondary" size="sm" loading={busy === 'search'} onClick={() => void search()}>Search</Button>
      </div>
      {rows !== null && (
        <div className="mt-2 divide-y divide-[#EBEEF1] overflow-hidden rounded-lg border border-[#EBEEF1] bg-white">
          {!rows.length && <p className="p-3 text-center text-xs text-[#65676B]">No leads match. Try the full phone number.</p>}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><b className="font-semibold text-[#1C1E21]">{r.name || '—'}</b> <span className="text-[#65676B]">· {r.phone} · {r.stage}</span></div>
              {r.partnerId === cpId ? <Badge tone="sage">Attributed</Badge> : r.partnerId ? <Badge tone="amber">Another partner</Badge> : (
                <Button variant="secondary" size="xs" icon={<UserPlus size={12} />} loading={busy === r.id} onClick={() => void attribute(r.id)}>Attribute</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const PartnerDetail: React.FC<{ id: string; canManage: boolean; canSeeMoney: boolean; onClose: () => void; onChanged: () => void }> = ({ id, canManage, canSeeMoney, onClose, onChanged }) => {
  const [p, setP] = useState<ChannelPartner | null>(null);
  const [leads, setLeads] = useState<PartnerLeadRow[] | null>(null);
  const [commissions, setCommissions] = useState<{ rows: CommissionRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [partner, lr] = await Promise.all([api.partners.get(id), api.partners.leads(id)]);
      setP(partner); setLeads(lr.leads);
      if (canSeeMoney) { const c = await api.partners.commissions(id); setCommissions({ rows: c.commissions, total: c.totalAccrued }); }
    } catch (e) { toast('Could not load', errText('partners.get', e), 'alert'); }
  }, [id, canSeeMoney]);
  useEffect(() => { void load(); }, [load]);
  const recompute = async () => {
    setBusy(true);
    try { const r = await api.partners.recompute(id); toast('Recomputed', `${r.updated} booked unit${r.updated === 1 ? '' : 's'} refreshed.`, 'success'); await load(); onChanged(); }
    catch (e) { toast('Failed', errText('partners.recompute', e), 'alert'); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} side panelKey={id} title={p ? p.name : 'Channel partner'} subtitle={p?.firm || undefined}
      footer={canManage && canSeeMoney ? <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={busy ? 'animate-spin' : ''} />} onClick={() => void recompute()}>Recompute commission</Button> : undefined}>
      {!p ? <LoadingState /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-[#65676B]">Phone</span><p className="font-medium text-[#1C1E21]">{p.phone || '—'}</p></div>
            <div><span className="text-[#65676B]">Email</span><p className="font-medium text-[#1C1E21] break-all">{p.email || '—'}</p></div>
            <div><span className="text-[#65676B]">RERA</span><p className="font-medium text-[#1C1E21]">{p.reraId || '—'}</p></div>
            <div><span className="text-[#65676B]">Status</span><p><Badge tone={p.status === 'Active' ? 'sage' : 'muted'}>{p.status}</Badge></p></div>
            <div><span className="text-[#65676B]">Default rate</span><p className="font-medium text-[#1C1E21]">{pct(p.defaultRate)}</p></div>
            {canSeeMoney && <div><span className="text-[#65676B]">Commission accrued</span><p className="font-semibold text-[#0B6BB0]">{inr(commissions?.total ?? p.commissionAccrued)}</p></div>}
          </div>
          {!!p.slabs.length && <div className="text-xs text-[#65676B]">Slabs: {p.slabs.map((s) => `≥${inr(s.minValue)} → ${pct(s.rate)}`).join(' · ')}</div>}

          {canManage && <AttributeBox cpId={id} onDone={() => { void load(); onChanged(); }} />}

          <div>
            <p className="mb-1 text-sm font-semibold text-[#1C1E21]">Leads ({leads?.length ?? 0})</p>
            <div className="divide-y divide-[#EBEEF1] overflow-hidden rounded-lg border border-[#EBEEF1]">
              {leads === null ? <div className="p-3"><LoadingState /></div> : !leads.length ? <p className="p-3 text-center text-xs text-[#65676B]">No leads attributed yet.</p> :
                leads.map((l) => (
                  <div key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1"><b className="font-semibold text-[#1C1E21]">{l.name || '—'}</b> <span className="text-[#65676B]">· {l.phone}</span><div className="text-xs text-[#65676B]">{l.registeredAt ? formatDate(l.registeredAt) : ''}</div></div>
                    {l.booked && <Badge tone="sage">Booked</Badge>}
                    <Badge tone="muted">{l.stage || 'New'}</Badge>
                  </div>
                ))}
            </div>
          </div>

          {canSeeMoney && (
            <div>
              <p className="mb-1 text-sm font-semibold text-[#1C1E21]">Commission</p>
              <div className="divide-y divide-[#EBEEF1] overflow-hidden rounded-lg border border-[#EBEEF1]">
                {commissions === null ? <div className="p-3"><LoadingState /></div> : !commissions.rows.length ? <p className="p-3 text-center text-xs text-[#65676B]">No bookings yet, so nothing has accrued.</p> :
                  commissions.rows.map((c) => (
                    <div key={c._id} className={cx('flex items-center gap-2 px-3 py-2 text-sm', c.status === 'void' && 'opacity-60')}>
                      <div className="min-w-0 flex-1"><b className="font-semibold text-[#1C1E21]">Unit {c.unitLabel}</b> <span className="text-[#65676B]">· {inr(c.dealValue)} × {pct(c.rate)}</span></div>
                      {c.status === 'void' ? <Badge tone="rust">Void</Badge> : <span className="font-semibold text-[#0B6BB0]">{inr(c.amount)}</span>}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

/* ------------------------------- main view ------------------------------- */

export const PartnersView: React.FC<{ canManage: boolean; canSeeMoney: boolean }> = ({ canManage, canSeeMoney }) => {
  const [rows, setRows] = useState<ChannelPartner[] | null>(null);
  const [failed, setFailed] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<PartnerForm | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<ChannelPartner | null>(null);
  const [delBusy, setDelBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows((await api.partners.list()).partners); setFailed(''); }
    catch (e) { setRows([]); setFailed(errText('partners.list', e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = (rows || []).filter((r) => !q || [r.name, r.firm, r.phone, r.email].some((v) => v.toLowerCase().includes(q.toLowerCase())));
  const totalAccrued = canSeeMoney ? (rows || []).reduce((s, r) => s + (r.commissionAccrued || 0), 0) : null;

  const toggleStatus = async (p: ChannelPartner) => {
    try { await api.partners.setStatus(p.id, p.status === 'Active' ? 'Suspended' : 'Active'); await load(); }
    catch (e) { toast('Failed', errText('partners.setStatus', e), 'alert'); }
  };
  const doDelete = async () => {
    if (!confirmDel) return;
    setDelBusy(true);
    try { await api.partners.remove(confirmDel.id); toast('Removed', 'Channel partner removed.', 'success'); setConfirmDel(null); await load(); }
    catch (e) { toast('Not removed', errText('partners.remove', e), 'alert'); }
    finally { setDelBusy(false); }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#65676B]" />
          <input className={cx(inputCls, 'pl-8')} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search partners" aria-label="Search partners" /></label>
        {canSeeMoney && rows && <Badge tone="navy" title="Total commission accrued across all partners">Accrued {inr(totalAccrued)}</Badge>}
        {canManage && <Button size="sm" icon={<Plus size={15} />} onClick={() => setEditing(emptyForm)}>Add partner</Button>}
      </div>

      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}

      {rows === null ? <LoadingState /> : !shown.length ? (
        <EmptyState icon={<Handshake size={28} />} title={q ? 'No partners match' : 'No channel partners yet'}
          description={q ? 'Try a different search.' : 'Add the brokers who bring you leads, set their commission, and attribute leads to them.'}
          action={canManage && !q ? <Button icon={<Plus size={15} />} onClick={() => setEditing(emptyForm)}>Add partner</Button> : undefined} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#DADDE1] bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[#F2F7FB] text-left text-xs uppercase tracking-wide text-[#65676B]">
              <tr>
                <th className="px-3 py-2 font-semibold">Partner</th>
                <th className="hidden px-3 py-2 font-semibold sm:table-cell">Rate</th>
                <th className="px-3 py-2 text-right font-semibold">Leads</th>
                <th className="px-3 py-2 text-right font-semibold">Bookings</th>
                {canSeeMoney && <th className="px-3 py-2 text-right font-semibold">Accrued</th>}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EBEEF1]">
              {shown.map((p) => (
                <tr key={p.id} className="hover:bg-[#F7F9FB]">
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => setDetail(p.id)} className="text-left">
                      <span className="font-semibold text-[#0B6BB0] hover:underline">{p.name}</span>
                      {p.status === 'Suspended' && <Badge tone="muted" className="ml-2">Suspended</Badge>}
                      <div className="text-xs text-[#65676B]">{[p.firm, p.phone].filter(Boolean).join(' · ') || '—'}</div>
                    </button>
                  </td>
                  <td className="hidden px-3 py-2 text-[#1C1E21] sm:table-cell">{pct(p.defaultRate)}{p.slabs.length ? ` +${p.slabs.length} slab${p.slabs.length === 1 ? '' : 's'}` : ''}</td>
                  <td className="px-3 py-2 text-right text-[#1C1E21]">{p.leads}</td>
                  <td className="px-3 py-2 text-right text-[#1C1E21]">{p.bookings}</td>
                  {canSeeMoney && <td className="px-3 py-2 text-right font-semibold text-[#0B6BB0]">{inr(p.commissionAccrued)}</td>}
                  <td className="px-3 py-2">
                    {canManage && (
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" onClick={() => setEditing(toForm(p))} aria-label="Edit" title="Edit" className="rounded-lg p-1.5 text-[#44505C] hover:bg-[#EDF1F5]"><Pencil size={15} /></button>
                        <button type="button" onClick={() => void toggleStatus(p)} className="rounded-lg px-2 py-1 text-xs font-semibold text-[#44505C] hover:bg-[#EDF1F5]">{p.status === 'Active' ? 'Suspend' : 'Activate'}</button>
                        <button type="button" onClick={() => setConfirmDel(p)} aria-label="Remove" title="Remove" className="rounded-lg p-1.5 text-[#B42318] hover:bg-[#FEF3F2]"><Trash2 size={15} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <PartnerModal form={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {detail && <PartnerDetail id={detail} canManage={canManage} canSeeMoney={canSeeMoney} onClose={() => setDetail(null)} onChanged={() => void load()} />}
      <ConfirmDialog open={!!confirmDel} title="Remove channel partner?" danger confirmLabel="Remove" loading={delBusy}
        message={confirmDel ? `Remove ${confirmDel.name}? This cannot be undone. Partners with attributed leads cannot be removed — suspend them instead.` : ''}
        onConfirm={() => void doDelete()} onCancel={() => setConfirmDel(null)} />
    </div>
  );
};
