import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, Calendar, ExternalLink, FileText, Plus, Search, Trash2, User, X } from 'lucide-react';
import { CrmDocument, Lead } from '../../types/crm';
import { F } from '../../core/config';
import { searchLeads } from '../../core/analytics';
import { formatDate } from '../../core/dates';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, EmptyState, Field, InlineNotice, Modal, Select, inputCls } from '../../components/ui';

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
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Documents & Collateral</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">Brochures, floor plans, legal papers and customer files — uploaded to the CRM or linked from cloud storage.{onOpenLibrary ? ' Project knowledge lives in the Library.' : ''}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {onOpenLibrary && <Button variant="gold" onClick={() => onOpenLibrary()} icon={<BookOpen size={14} />}>Open Library</Button>}
          <Button variant="primary" onClick={() => { resetForm(); setAddOpen(true); }} icon={<Plus size={14} />}>Add Document</Button>
        </div>
      </div>

      <div className="bg-[#EDE8E0] p-3 sm:p-4 rounded-xl border border-[#D2C9BF] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-[260px] max-w-xl">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9E948D]" />
            <input type="text" placeholder="Search title, description, category or customer…" value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputCls} !pl-8`} />
          </div>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} options={categories} placeholder="All categories" className="!w-auto" />
        </div>
        <span className="text-xs text-[#6B5F57] font-medium">{filtered.length} file{filtered.length === 1 ? '' : 's'}</span>
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
              return (
                <div key={doc.id} className="bg-white rounded-xl p-5 border border-[#D2C9BF] shadow-xs flex flex-col justify-between hover:border-[#A9825A] transition">
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <Badge tone="gold">{doc.category || 'General'}</Badge>
                      {confirming ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-[#8A3E28] font-medium">Delete?</span>
                          <Button variant="danger" size="xs" loading={deleting} onClick={() => confirmDelete(doc.id)}>Yes</Button>
                          <button onClick={() => setDeleteId(null)} className="p-1 text-[#9E948D] hover:text-[#1D2F3F]" aria-label="Cancel"><X size={12} /></button>
                        </div>
                      ) : (
                        <button onClick={() => setDeleteId(doc.id)} className="p-1 text-[#9E948D] hover:text-[#8A3E28] transition" title="Delete document"><Trash2 size={13} /></button>
                      )}
                    </div>
                    <h4 className="text-sm font-bold text-[#1D2F3F] mb-1.5 leading-snug break-words">{doc.name}</h4>
                    <p className="text-xs text-[#6B5F57] leading-relaxed mb-3 break-words">{doc.description || 'No description provided.'}</p>
                    {(lead || doc.leadId) && (
                      <button onClick={() => doc.leadId && onOpenLead(doc.leadId)} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-[#1D2F3F]/10 text-[#1D2F3F] hover:bg-[#1D2F3F]/15 font-semibold mb-3" title="Open the enquiry">
                        <User size={11} />{lead ? lead[F.NAME] : doc.leadId}<span className="font-mono opacity-60">· {doc.leadId}</span>
                      </button>
                    )}
                  </div>
                  <div className="pt-3 border-t border-[#ECE8E1] flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] text-[#9E948D] inline-flex items-center gap-1" title={doc.uploadedBy ? `Added by ${doc.uploadedBy}` : undefined}>
                      <Calendar size={11} />{formatDate(doc.uploadedDate, '—')}{doc.uploadedBy ? ` · ${doc.uploadedBy}` : ''}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {onOpenLibrary && <Button variant="secondary" size="xs" onClick={() => onOpenLibrary(doc.name)} icon={<BookOpen size={11} />} title="Search the Library for this document">Library</Button>}
                      {doc.fileUrl && isHttpUrl(doc.fileUrl) ? (
                        <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-[11px] font-semibold bg-[#1D2F3F] text-white hover:brightness-110 transition">Open <ExternalLink size={11} /></a>
                      ) : (
                        <span className="text-[10px] text-[#9E948D] italic">No link</span>
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
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-[#D2C9BF] bg-[#F4F0EB] text-xs">
                <span className="font-semibold text-[#1D2F3F] truncate">{selectedLead[F.NAME]} <span className="font-mono text-[#9E948D]">· {selectedLead[F.ID]}</span></span>
                <button type="button" onClick={() => { setLeadId(''); setLeadQuery(''); }} className="text-[#9E948D] hover:text-[#1D2F3F]" aria-label="Remove link"><X size={13} /></button>
              </div>
            ) : (
              <div className="relative">
                <input className={inputCls} value={leadQuery} onChange={(e) => setLeadQuery(e.target.value)} placeholder="Start typing a name or phone…" />
                {leadMatches.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-[#D2C9BF] rounded-lg shadow-lg max-h-48 overflow-y-auto text-xs">
                    {leadMatches.map((l) => (
                      <button type="button" key={l[F.ID]} onClick={() => { setLeadId(l[F.ID]); setLeadQuery(''); }} className="w-full text-left px-3 py-2 hover:bg-[#F4F0EB] flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#1D2F3F] truncate">{l[F.NAME]}</span>
                        <span className="font-mono text-[10px] text-[#9E948D]">{l[F.ID]}</span>
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
