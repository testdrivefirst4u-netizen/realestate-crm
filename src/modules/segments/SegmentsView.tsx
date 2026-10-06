import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Edit, Layers, MessageSquare, Phone, Plus, Trash2 } from 'lucide-react';
import { ClientSegment, CRMConfig, Lead, SegmentOperator, SegmentRule } from '../../types/crm';
import { DEFAULT_SETTINGS, F, STAGES } from '../../core/config';
import { formatDate, formatDateTime, formatRelative } from '../../core/dates';
import { downloadText, toCsv } from '../../core/format';
import { fillTemplate, formatPhone, telLink, toE164Digits, whatsappLink } from '../../core/phone';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, InlineNotice, Modal, Select, StageBadge, inputCls, labelCls } from '../../components/ui';
import {
  RELATIVE_DATE_HINT,
  SEGMENT_FIELDS,
  SEGMENT_OPERATORS,
  SegmentationService,
  describeRule,
  isDateField,
} from '../../services/segmentationService';

export interface SegmentsViewProps {
  segments: ClientSegment[];
  leads: Lead[];
  config: CRMConfig;
  onOpenLead: (id: string) => void;
  onCreateSegment: (s: Omit<ClientSegment, 'id' | 'createdAt'>) => void;
  onUpdateSegment: (id: string, patch: Partial<ClientSegment>) => void;
  onDeleteSegment: (id: string) => void;
}

const PAGE = 50;
const DEFAULT_RULE: SegmentRule = { field: F.STAGE, operator: 'equals', value: STAGES.HOT };

interface FormState {
  name: string;
  description: string;
  color: string;
  matchType: 'ALL' | 'ANY';
  rules: SegmentRule[];
}

const emptyForm = (): FormState => ({ name: '', description: '', color: '#1D2F3F', matchType: 'ANY', rules: [{ ...DEFAULT_RULE }] });

export const SegmentsView: React.FC<SegmentsViewProps> = ({ segments, leads, config, onOpenLead, onCreateSegment, onUpdateSegment, onDeleteSegment }) => {
  const [activeId, setActiveId] = useState<string>(segments[0]?.id || '');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  // keep a valid selection when segments change (deleted / first load)
  useEffect(() => {
    if (!segments.some((s) => s.id === activeId)) setActiveId(segments[0]?.id || '');
  }, [segments, activeId]);

  useEffect(() => setLimit(PAGE), [activeId]);

  /* ----------------------------- matching ------------------------------- */

  const leadsBySegment = useMemo(() => {
    const now = new Date();
    const map = new Map<string, Lead[]>();
    for (const s of segments) map.set(s.id, SegmentationService.getSegmentLeads(s, leads, now));
    return map;
  }, [segments, leads]);

  const activeSegment = useMemo(() => segments.find((s) => s.id === activeId) || null, [segments, activeId]);
  const segmentLeads = useMemo(() => (activeSegment ? leadsBySegment.get(activeSegment.id) || [] : []), [activeSegment, leadsBySegment]);
  const stats = useMemo(() => SegmentationService.statsFor(segmentLeads), [segmentLeads]);
  const visibleLeads = useMemo(() => segmentLeads.slice(0, limit), [segmentLeads, limit]);

  /* ------------------------------- form --------------------------------- */

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (seg: ClientSegment) => {
    setEditingId(seg.id);
    setForm({ name: seg.name, description: seg.description || '', color: seg.color || '#1D2F3F', matchType: seg.matchType, rules: seg.rules.map((r) => ({ ...r })) });
    setFormError(null);
    setModalOpen(true);
  };

  const setRule = (idx: number, patch: Partial<SegmentRule>) =>
    setForm((f) => ({ ...f, rules: f.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return setFormError('Give the segment a name.');
    const rules = form.rules.map((r) => ({ ...r, value: String(r.value ?? '').trim() })).filter((r) => r.field && r.operator);
    if (!rules.length) return setFormError('Add at least one rule.');
    const bad = rules.find((r) => !r.value && r.operator !== 'equals' && r.operator !== 'not_equals');
    if (bad) return setFormError(`The rule on "${bad.field}" needs a value.`);
    const payload = { name, description: form.description.trim(), color: form.color, matchType: form.matchType, rules };
    if (editingId) {
      onUpdateSegment(editingId, payload);
      toast('Segment updated', name, 'success');
    } else {
      onCreateSegment(payload);
    }
    setModalOpen(false);
  };

  const confirmDeleteSegment = () => {
    if (!activeSegment) return;
    const name = activeSegment.name;
    onDeleteSegment(activeSegment.id);
    setConfirmDelete(false);
    toast('Segment deleted', name, 'info');
  };

  /* ------------------------------ actions ------------------------------- */

  const copyPhones = async () => {
    const phones = Array.from(new Set(segmentLeads.map((l) => toE164Digits(l[F.PHONE])).filter((p) => p.length >= 10)));
    if (!phones.length) return toast('No phone numbers', 'None of the clients in this segment has a valid phone number.', 'warning');
    try {
      await navigator.clipboard.writeText(phones.map((p) => `+${p}`).join(', '));
      toast('Phone numbers copied', `${phones.length} number${phones.length === 1 ? '' : 's'} copied to the clipboard`, 'success');
    } catch {
      toast('Copy failed', 'Your browser blocked clipboard access.', 'warning');
    }
  };

  const exportCsv = () => {
    if (!activeSegment || !segmentLeads.length) return;
    const headers = [F.ID, F.NAME, F.PHONE, F.EMAIL, F.STAGE, F.UNIT_TYPE, F.SOURCE, F.SITE_VISIT_STATUS, F.RM, F.ENQUIRY_DATE, F.NEXT_FOLLOWUP];
    const rows = segmentLeads.map((l) => ({
      ...Object.fromEntries(headers.map((h) => [h, l[h] ?? ''])),
      [F.PHONE]: formatPhone(l[F.PHONE]),
      [F.ENQUIRY_DATE]: formatDateTime(l[F.ENQUIRY_DATE]),
      [F.NEXT_FOLLOWUP]: formatDateTime(l[F.NEXT_FOLLOWUP]),
    }));
    const slug = activeSegment.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'segment';
    downloadText(`Segment_${slug}.csv`, toCsv(headers, rows));
    toast('Export ready', `${segmentLeads.length} clients exported`, 'success');
  };

  const waText = (l: Lead) => (l[F.RM] ? fillTemplate(DEFAULT_SETTINGS.waTemplate, { name: l[F.NAME], rm: l[F.RM] }) : undefined);

  /* ------------------------------- render ------------------------------- */

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Client Segments & Audiences</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">Saved filters over the live enquiry list — by stage, unit, source, follow-up dates and more</p>
        </div>
        <Button variant="primary" onClick={openCreate} icon={<Plus size={14} />}>New Segment</Button>
      </div>

      {segments.length === 0 ? (
        <Card>
          <EmptyState icon={<Layers size={22} />} title="No segments yet" description="Create a segment to group clients by stage, unit type, source or follow-up status. Segments update automatically as leads change." action={<Button variant="primary" onClick={openCreate} icon={<Plus size={14} />}>Create segment</Button>} />
        </Card>
      ) : (
        <>
          {/* Segment selector */}
          <div className="flex gap-2 overflow-x-auto pb-1 select-none">
            {segments.map((seg) => {
              const selected = seg.id === activeSegment?.id;
              const count = leadsBySegment.get(seg.id)?.length || 0;
              return (
                <button key={seg.id} onClick={() => setActiveId(seg.id)} className={`px-3.5 py-2 rounded-xl border text-xs font-semibold flex items-center gap-2 flex-shrink-0 transition ${selected ? 'bg-[#1D2F3F] text-white border-[#1D2F3F] shadow-sm' : 'bg-white text-[#1D2F3F] border-[#D2C9BF] hover:bg-[#F4F0EB]'}`}>
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color || '#A9825A' }} />
                  <span className="truncate max-w-[220px]">{seg.name}</span>
                  <span className="font-mono text-[11px] opacity-80">({count})</span>
                </button>
              );
            })}
          </div>

          {activeSegment && (
            <div className="space-y-4">
              <Card>
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: activeSegment.color }} />
                      <h3 className="text-lg font-bold text-[#1D2F3F] truncate">{activeSegment.name}</h3>
                      <Badge tone="muted">Match {activeSegment.matchType}</Badge>
                    </div>
                    <p className="text-xs text-[#6B5F57]">{activeSegment.description || 'Custom client segment'}</p>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {activeSegment.rules.map((r, i) => (
                        <span key={i} className="text-[11px] px-2 py-0.5 rounded-md bg-[#F4F0EB] border border-[#D2C9BF] text-[#3D3530]">{describeRule(r)}</span>
                      ))}
                    </div>
                    {activeSegment.createdAt && (
                      <div className="text-[10px] text-[#9E948D] pt-1">Created {formatDate(activeSegment.createdAt)}{activeSegment.createdBy ? ` by ${activeSegment.createdBy}` : ''}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                    <Button variant="secondary" onClick={copyPhones} icon={<Copy size={13} />} disabled={!segmentLeads.length}>Copy numbers</Button>
                    <Button variant="gold" onClick={exportCsv} icon={<Download size={13} />} disabled={!segmentLeads.length}>Export ({segmentLeads.length})</Button>
                    <Button variant="secondary" onClick={() => openEdit(activeSegment)} icon={<Edit size={13} />} title="Edit segment rules">Edit</Button>
                    <Button variant="danger" onClick={() => setConfirmDelete(true)} icon={<Trash2 size={13} />} title="Delete segment">Delete</Button>
                  </div>
                </div>
              </Card>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-[#F4F0EB] p-4 rounded-xl border border-[#D2C9BF] min-w-0">
                  <span className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57] block truncate">Clients in segment</span>
                  <div className="text-xl sm:text-2xl font-bold text-[#1D2F3F] mt-1">{stats.total}</div>
                </div>
                <div className="bg-[#F4F0EB] p-4 rounded-xl border border-[#D2C9BF] min-w-0">
                  <span className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57] block truncate">Average engagement score</span>
                  <div className="text-xl sm:text-2xl font-bold text-[#A9825A] mt-1">{stats.avgScore} <span className="text-xs font-normal text-[#6B5F57]">/ 5</span></div>
                </div>
                <div className="bg-[#F4F0EB] p-4 rounded-xl border border-[#D2C9BF] min-w-0">
                  <span className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57] block truncate">Unit preferences</span>
                  <div className="text-xs text-[#1D2F3F] font-semibold mt-2 truncate">
                    {Object.keys(stats.unitsCount).length ? Object.entries(stats.unitsCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u, c]) => `${u} (${c})`).join(', ') : 'No preference recorded'}
                  </div>
                </div>
              </div>

              <Card padded={false}>
                <div className="p-4 border-b border-[#D2C9BF] bg-[#EDE8E0] rounded-t-2xl flex items-center justify-between gap-2">
                  <span className="font-bold text-sm text-[#1D2F3F]">Clients in “{activeSegment.name}” ({segmentLeads.length})</span>
                  <span className="text-xs text-[#6B5F57] hidden sm:inline">Click a row to open the enquiry</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-white border-b border-[#ECE8E1] text-[10px] uppercase tracking-wider text-[#6B5F57] font-bold">
                        <th className="p-3">ID</th>
                        <th className="p-3">Prospect</th>
                        <th className="p-3">Phone</th>
                        <th className="p-3">Stage</th>
                        <th className="p-3">Unit</th>
                        <th className="p-3">Site visit</th>
                        <th className="p-3">RM</th>
                        <th className="p-3">Next follow-up</th>
                        <th className="p-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#ECE8E1]">
                      {visibleLeads.length === 0 ? (
                        <tr><td colSpan={9} className="p-8 text-center text-[#9E948D]">No clients currently match this segment’s rules.</td></tr>
                      ) : visibleLeads.map((lead) => {
                        const id = lead[F.ID];
                        const phone = lead[F.PHONE];
                        return (
                          <tr key={id} onClick={() => onOpenLead(id)} className="hover:bg-[#F4F0EB] cursor-pointer transition">
                            <td className="p-3 font-semibold text-[#A9825A] whitespace-nowrap">{id}</td>
                            <td className="p-3 font-bold text-[#1D2F3F]">{lead[F.NAME] || '—'}</td>
                            <td className="p-3 text-[#3D3530] whitespace-nowrap">{formatPhone(phone) || '—'}</td>
                            <td className="p-3"><StageBadge stage={lead[F.STAGE]} /></td>
                            <td className="p-3 text-[#6B5F57]">{lead[F.UNIT_TYPE] || '—'}</td>
                            <td className="p-3 text-[#6B5F57] text-[11px]">{lead[F.SITE_VISIT_STATUS] || '—'}</td>
                            <td className="p-3 text-[#3D3530]">{lead[F.RM] || '—'}</td>
                            <td className="p-3 text-[#3D3530] whitespace-nowrap">{formatRelative(lead[F.NEXT_FOLLOWUP], '—')}</td>
                            <td className="p-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              {phone && (
                                <>
                                  <a href={telLink(phone)} className="inline-flex p-1.5 rounded-md bg-[#F4F0EB] text-[#1D2F3F] hover:bg-[#EBE5DC] mr-1" title="Call"><Phone size={12} /></a>
                                  <a href={whatsappLink(phone, waText(lead))} target="_blank" rel="noreferrer" className="inline-flex p-1.5 rounded-md bg-[#F4F0EB] text-[#3C573A] hover:bg-[#EBE5DC]" title="WhatsApp"><MessageSquare size={12} /></a>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {segmentLeads.length > visibleLeads.length && (
                  <div className="p-3 border-t border-[#ECE8E1] text-center">
                    <Button variant="secondary" size="xs" onClick={() => setLimit((n) => n + PAGE)}>Show more ({segmentLeads.length - visibleLeads.length} remaining)</Button>
                  </div>
                )}
              </Card>
            </div>
          )}
        </>
      )}

      {/* Create / edit */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? 'Edit client segment' : 'Create client segment'}
        subtitle="Rules are evaluated live against the enquiry list"
        width="lg"
        footer={<><Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit}>{editingId ? 'Save changes' : 'Create segment'}</Button></>}
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Segment name *" className="sm:col-span-2">
              <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Kompally walk-ins" required />
            </Field>
            <Field label="Colour tag">
              <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="w-full h-9 p-1 rounded-lg border border-[#D2C9BF] bg-white cursor-pointer" />
            </Field>
          </div>
          <Field label="Description / purpose">
            <input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Clients seeking 2 or 3 BHK who visited the site" />
          </Field>
          <Field label="Match condition">
            <Select value={form.matchType} onChange={(e) => setForm({ ...form, matchType: e.target.value as 'ALL' | 'ANY' })} options={[{ value: 'ALL', label: 'Match ALL rules (AND)' }, { value: 'ANY', label: 'Match ANY rule (OR)' }]} />
          </Field>

          <div className="space-y-2.5 pt-2 border-t border-[#ECE8E1]">
            <div className="flex items-center justify-between">
              <span className={labelCls}>Rules</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => setForm((f) => ({ ...f, rules: [...f.rules, { field: F.STAGE, operator: 'equals', value: '' }] }))} icon={<Plus size={12} />}>Add rule</Button>
            </div>
            {form.rules.map((rule, idx) => {
              const options = config.options[rule.field] || [];
              const dateField = isDateField(rule.field);
              const listId = `seg-opts-${idx}`;
              return (
                <div key={idx} className="p-3 bg-[#F4F0EB] rounded-xl border border-[#D2C9BF] space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-[1.2fr_1fr_1.4fr_auto] gap-2 items-center">
                    <Select value={rule.field} onChange={(e) => setRule(idx, { field: e.target.value, value: '' })} options={SEGMENT_FIELDS} className="!text-[11px]" />
                    <Select value={rule.operator} onChange={(e) => setRule(idx, { operator: e.target.value as SegmentOperator })} options={SEGMENT_OPERATORS} className="!text-[11px]" />
                    <div>
                      <input list={options.length ? listId : undefined} className={`${inputCls} !text-[11px]`} value={rule.value} onChange={(e) => setRule(idx, { value: e.target.value })} placeholder={dateField ? 'today, now, +7d, -30d or 2026-10-01' : options.length ? 'Choose or type a value' : 'Value'} />
                      {options.length > 0 && <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
                    </div>
                    <button type="button" onClick={() => setForm((f) => ({ ...f, rules: f.rules.length > 1 ? f.rules.filter((_, i) => i !== idx) : f.rules }))} disabled={form.rules.length <= 1} className="p-1.5 text-[#9E948D] hover:text-[#8A3E28] disabled:opacity-30 justify-self-end" title="Remove rule"><Trash2 size={13} /></button>
                  </div>
                  {dateField && <div className="text-[10px] text-[#9E948D]">{RELATIVE_DATE_HINT}</div>}
                </div>
              );
            })}
          </div>

          {formError && <InlineNotice tone="warning">{formError}</InlineNotice>}
          <button type="submit" className="hidden" aria-hidden="true" />
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete segment?"
        danger
        confirmLabel="Delete"
        message={<>“{activeSegment?.name}” will be removed. The clients themselves are not affected.</>}
        onConfirm={confirmDeleteSegment}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
};
