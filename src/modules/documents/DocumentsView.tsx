import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, Calendar, ExternalLink, File, FileSpreadsheet, FileText, Image as ImageIcon, Link2, Plus, Search, Trash2, User, X } from 'lucide-react';
import { CrmDocument, Lead } from '../../types/crm';
import { F } from '../../core/config';
import { searchLeads } from '../../core/analytics';
import { formatDate } from '../../core/dates';
import { toast } from '../../core/notifications';
import { Button, Card, EmptyState, Field, InlineNotice, Modal, Select, inputCls } from '../../components/ui';

export interface DocumentsViewProps {
  documents: CrmDocument[];
  leads: Lead[];
  onAddDocument: (d: Partial<CrmDocument>) => Promise<boolean>;
  onDeleteDocument: (id: string) => Promise<boolean>;
  /** Opens the project Library — absent when the company's plan has no project library. */
  onOpenLibrary?: (query?: string) => void;
  onOpenLead: (id: string) => void;
  /** Text search to start with (from the top-bar search, via `?q=`). */
  initialQuery?: string;
}

const CATEGORIES = ['Brochure', 'Floor Plans', 'Legal & RERA', 'Pricing', 'Customer Document', 'General'];
const PAGE = 48;
// category pill colours and a file-type glyph derived from the link's extension
const CAT_COLOR: Record<string, { bg: string; fg: string }> = {
  Brochure: { bg: '#EAF2FB', fg: '#0B5E9C' }, 'Floor Plans': { bg: '#E7F6EF', fg: '#0B7A43' }, 'Legal & RERA': { bg: '#F3EEFB', fg: '#6D3BBF' },
  Pricing: { bg: '#FFF4E0', fg: '#B45309' }, 'Customer Document': { bg: '#E8F0FE', fg: '#1559C0' }, General: { bg: '#EEF3F7', fg: '#5E778C' },
};
const catColor = (c?: string) => CAT_COLOR[c || 'General'] || CAT_COLOR.General;
function fileKind(url?: string): { Icon: typeof FileText; bg: string; fg: string } {
  const ext = (url || '').split(/[?#]/)[0].split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return { Icon: FileText, bg: '#FDECEC', fg: '#D93025' };
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'svg'].includes(ext)) return { Icon: ImageIcon, bg: '#E7F6EF', fg: '#0B7A43' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { Icon: FileSpreadsheet, bg: '#E7F6EF', fg: '#0B7A43' };
  if (['doc', 'docx', 'txt', 'ppt', 'pptx'].includes(ext)) return { Icon: FileText, bg: '#E8F0FE', fg: '#1559C0' };
  if (url) return { Icon: Link2, bg: '#EEF3F7', fg: '#5E778C' };
  return { Icon: File, bg: '#EEF3F7', fg: '#7E93A6' };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export const DocumentsView: React.FC<DocumentsViewProps> = ({ documents, leads, onAddDocument, onDeleteDocument, onOpenLibrary, onOpenLead, initialQuery = '' }) => {
  const [search, setSearch] = useState(initialQuery);
  useEffect(() => setSearch(initialQuery), [initialQuery]);
  const [category, setCategory] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // add form
  const [name, setName] = useState('');
  const [formCategory, setFormCategory] = useState(CATEGORIES[0]);
  const [fileUrl, setFileUrl] = useState('');
  const [description, setDescription] = useState('');
  const [leadQuery, setLeadQuery] = useState('');
  const [leadId, setLeadId] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => setLimit(PAGE), [search, category]);

  const leadById = useMemo(() => new Map(leads.map((l) => [l[F.ID], l])), [leads]);
  const categories = useMemo(() => {
    const set = new Set<string>(CATEGORIES);
    documents.forEach((d) => d.category && set.add(d.category));
    return Array.from(set);
  }, [documents]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return documents
      .filter((d) => {
        if (category && d.category !== category) return false;
        if (!q) return true;
        const lead = d.leadId ? leadById.get(d.leadId) : undefined;
        return (
          String(d.name || '').toLowerCase().includes(q) ||
          String(d.description || '').toLowerCase().includes(q) ||
          String(d.category || '').toLowerCase().includes(q) ||
          String(d.leadId || '').toLowerCase().includes(q) ||
          String(lead?.[F.NAME] || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => String(b.uploadedDate || '').localeCompare(String(a.uploadedDate || '')));
  }, [documents, search, category, leadById]);

  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit]);
  const leadMatches = useMemo(() => (leadQuery.trim() ? searchLeads(leads, leadQuery, 8) : []), [leads, leadQuery]);
  const selectedLead = leadId ? leadById.get(leadId) : undefined;

  const resetForm = () => {
    setName('');
    setFormCategory(CATEGORIES[0]);
    setFileUrl('');
    setDescription('');
    setLeadQuery('');
    setLeadId('');
    setFormError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const url = fileUrl.trim();
    if (!n) return setFormError('Give the document a title.');
    if (!url || !isHttpUrl(url)) return setFormError('Enter the full link to the file (it must start with https://).');
    setSaving(true);
    setFormError(null);
    const ok = await onAddDocument({ name: n, category: formCategory, fileUrl: url, description: description.trim(), leadId: leadId || undefined });
    setSaving(false);
    if (ok) {
      toast('Document added', n, 'success');
      resetForm();
      setAddOpen(false);
    }
  };

  const confirmDelete = async (id: string) => {
    setDeleting(true);
    const ok = await onDeleteDocument(id);
    setDeleting(false);
    setDeleteId(null);
    if (ok) toast('Document removed', undefined, 'info');
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight">Documents & Collateral</h2>
          <p className="text-xs text-[#5E778C] mt-0.5">Brochures, floor plans, legal papers and customer files — uploaded to the CRM or linked from cloud storage.{onOpenLibrary ? ' Project knowledge lives in the Library.' : ''}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {onOpenLibrary && <Button variant="gold" onClick={() => onOpenLibrary()} icon={<BookOpen size={14} />}>Open Library</Button>}
          <Button variant="primary" onClick={() => { resetForm(); setAddOpen(true); }} icon={<Plus size={14} />}>Add Document</Button>
        </div>
      </div>

      <div className="bg-[#E6EFF6] p-3 sm:p-4 rounded-xl border border-[#D3E3F0] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-[260px] max-w-xl">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7E93A6]" />
            <input type="text" placeholder="Search title, description, category or customer…" value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputCls} !pl-8`} />
          </div>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} options={categories} placeholder="All categories" className="!w-auto" />
        </div>
        <span className="text-xs text-[#5E778C] font-medium">{filtered.length} file{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {documents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText size={22} />}
            title="No documents yet"
            description="Add a link to a brochure, floor plan or price sheet stored in cloud storage (Google Drive, OneDrive…). Files uploaded from a lead’s Documents tab appear here too."
            action={<Button variant="primary" onClick={() => { resetForm(); setAddOpen(true); }} icon={<Plus size={14} />}>Add the first document</Button>}
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card><EmptyState icon={<Search size={22} />} title="Nothing matches" description="Try a different search term or clear the category filter." action={<Button variant="secondary" onClick={() => { setSearch(''); setCategory(''); }}>Clear filters</Button>} /></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((doc) => {
              const lead = doc.leadId ? leadById.get(doc.leadId) : undefined;
              const confirming = deleteId === doc.id;
              const kind = fileKind(doc.fileUrl);
              const cat = catColor(doc.category);
              return (
                <div key={doc.id} className="group flex flex-col rounded-2xl border border-[#E3EDF5] bg-white p-4 shadow-[0_1px_2px_rgba(11,42,68,.05)] transition hover:border-[#0B6BB0] hover:shadow-[0_8px_20px_-12px_rgba(11,42,68,.3)]">
                  <div className="flex items-start gap-3">
                    <span className="grid h-11 w-11 flex-none place-items-center rounded-xl" style={{ background: kind.bg, color: kind.fg }}><kind.Icon size={20} aria-hidden="true" /></span>
                    <div className="min-w-0 flex-1">
                      <h4 className="break-words text-[13.5px] font-bold leading-snug text-[#0B2A44]">{doc.name}</h4>
                      <span className="mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ background: cat.bg, color: cat.fg }}>{doc.category || 'General'}</span>
                    </div>
                    {confirming ? (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="font-medium text-[#8A3E28]">Delete?</span>
                        <Button variant="danger" size="xs" loading={deleting} onClick={() => confirmDelete(doc.id)}>Yes</Button>
                        <button onClick={() => setDeleteId(null)} className="p-1 text-[#7E93A6] hover:text-[#0B2A44]" aria-label="Cancel"><X size={12} /></button>
                      </div>
                    ) : (
                      <button onClick={() => setDeleteId(doc.id)} className="grid h-8 w-8 flex-none place-items-center rounded-lg text-[#9AA7B4] transition-colors hover:bg-[#FEF2F3] hover:text-[#D93025]" title="Delete document"><Trash2 size={15} /></button>
                    )}
                  </div>
                  <p className="mt-2.5 line-clamp-3 flex-1 break-words text-xs leading-relaxed text-[#5E778C]">{doc.description || 'No description provided.'}</p>
                  {(lead || doc.leadId) && (
                    <button onClick={() => doc.leadId && onOpenLead(doc.leadId)} className="mt-2.5 inline-flex max-w-full items-center gap-1 self-start rounded-md bg-[#0B2A44]/[.08] px-2 py-0.5 text-[11px] font-semibold text-[#0B2A44] hover:bg-[#0B2A44]/[.14]" title="Open the enquiry">
                      <User size={11} className="flex-none" /><span className="truncate">{lead ? lead[F.NAME] : doc.leadId}</span><span className="flex-none font-mono opacity-60">· {doc.leadId}</span>
                    </button>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#EEF4F9] pt-3">
                    <span className="inline-flex items-center gap-1 text-[10px] text-[#7E93A6]" title={doc.uploadedBy ? `Added by ${doc.uploadedBy}` : undefined}>
                      <Calendar size={11} />{formatDate(doc.uploadedDate, '—')}{doc.uploadedBy ? ` · ${doc.uploadedBy}` : ''}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {onOpenLibrary && <Button variant="secondary" size="xs" onClick={() => onOpenLibrary(doc.name)} icon={<BookOpen size={11} />} title="Search the Library for this document">Library</Button>}
                      {doc.fileUrl && isHttpUrl(doc.fileUrl) ? (
                        <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-[#0B2A44] px-3 py-1 text-[11px] font-semibold text-white transition hover:brightness-110">Open <ExternalLink size={11} /></a>
                      ) : (
                        <span className="text-[10px] italic text-[#7E93A6]">No link</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {filtered.length > visible.length && (
            <div className="text-center">
              <Button variant="secondary" size="xs" onClick={() => setLimit((n) => n + PAGE)}>Show more ({filtered.length - visible.length} remaining)</Button>
            </div>
          )}
        </>
      )}

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add document"
        subtitle="Link a file stored in cloud storage (Google Drive, OneDrive…)"
        width="sm"
        footer={<><Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={saving}>Save document</Button></>}
      >
        <form onSubmit={submit} className="space-y-4">
          <Field label="Document title *">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Master payment schedule" required />
          </Field>
          <Field label="Category">
            <Select value={formCategory} onChange={(e) => setFormCategory(e.target.value)} options={categories} />
          </Field>
          <Field label="File link *" hint="Paste a sharing link that your team can open (e.g. Google Drive: Anyone with the link → Viewer).">
            <input type="url" className={inputCls} value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} placeholder="https://drive.google.com/file/d/…" required />
          </Field>
          <Field label="Description">
            <textarea rows={2} className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What the file is for, version, audience…" />
          </Field>
          <Field label="Linked enquiry (optional)" hint="Search by name, phone or enquiry ID to attach this document to a customer.">
            {selectedLead ? (
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-[#D3E3F0] bg-[#F2F7FB] text-xs">
                <span className="font-semibold text-[#0B2A44] truncate">{selectedLead[F.NAME]} <span className="font-mono text-[#7E93A6]">· {selectedLead[F.ID]}</span></span>
                <button type="button" onClick={() => { setLeadId(''); setLeadQuery(''); }} className="text-[#7E93A6] hover:text-[#0B2A44]" aria-label="Remove link"><X size={13} /></button>
              </div>
            ) : (
              <div className="relative">
                <input className={inputCls} value={leadQuery} onChange={(e) => setLeadQuery(e.target.value)} placeholder="Start typing a name or phone…" />
                {leadMatches.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-[#D3E3F0] rounded-lg shadow-lg max-h-48 overflow-y-auto text-xs">
                    {leadMatches.map((l) => (
                      <button type="button" key={l[F.ID]} onClick={() => { setLeadId(l[F.ID]); setLeadQuery(''); }} className="w-full text-left px-3 py-2 hover:bg-[#F2F7FB] flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#0B2A44] truncate">{l[F.NAME]}</span>
                        <span className="font-mono text-[10px] text-[#7E93A6]">{l[F.ID]}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Field>
          {formError && <InlineNotice tone="warning">{formError}</InlineNotice>}
          <button type="submit" className="hidden" aria-hidden="true" />
        </form>
      </Modal>
    </div>
  );
};
