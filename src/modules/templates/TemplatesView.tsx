import React, { useMemo, useState } from 'react';
import { Check, Copy, Edit, Eye, EyeOff, FileUp, MessageSquareQuote, Plus, Trash2 } from 'lucide-react';
import { MessageTemplate, UserAccount } from '../../types/crm';
import { formatDateTime, formatRelative } from '../../core/dates';
import { fillTemplate } from '../../core/phone';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, InlineNotice, Modal, Select, Tabs, inputCls, labelCls } from '../../components/ui';
import { ImportTemplatesModal } from './ImportTemplatesModal';
import { TEMPLATE_IMPORT_TIP } from './importTemplates';
import { useCompany, useFeature } from '../../core/tenant';

export interface TemplatesViewProps {
  templates: MessageTemplate[];
  onAddTemplate: (t: Partial<MessageTemplate>) => Promise<boolean>;
  onUpdateTemplate: (id: string, patch: Partial<MessageTemplate>) => Promise<boolean>;
  onDeleteTemplate: (id: string) => Promise<boolean>;
  currentUser: UserAccount | null;
}

const TYPES = ['WhatsApp', 'Email', 'Follow-up', 'Site Visit', 'General'];
const TOKENS: Array<{ token: string; label: string }> = [
  { token: '{name}', label: 'Customer name' },
  { token: '{rm}', label: 'Your name (RM)' },
  { token: '{unit}', label: 'Unit type' },
  { token: '{time}', label: 'Date & time' },
];

export const TemplatesView: React.FC<TemplatesViewProps> = ({ templates, onAddTemplate, onUpdateTemplate, onDeleteTemplate, currentUser }) => {
  const company = useCompany();
  const projectName = useFeature('projectLibrary') ? 'Amaya by Vera Vita' : company?.name || 'Your project';
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [previewIds, setPreviewIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState(TYPES[0]);
  const [formName, setFormName] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const sampleVars = useMemo(
    () => ({ name: 'Rahul', rm: currentUser?.name || 'Your RM', unit: '2 BHK', time: formatDateTime(new Date()), project: projectName }),
    [currentUser, projectName]
  );

  const types = useMemo(() => {
    const set = new Set<string>(TYPES);
    templates.forEach((t) => t.type && set.add(t.type));
    return Array.from(set);
  }, [templates]);

  const filtered = useMemo(() => {
    const list = typeFilter === 'all' ? templates : templates.filter((t) => t.type === typeFilter);
    return [...list].sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  }, [templates, typeFilter]);

  const tabs = useMemo(
    () => [{ id: 'all', label: 'All', badge: templates.length }, ...types.map((t) => ({ id: t, label: t, badge: templates.filter((x) => x.type === t).length }))],
    [types, templates]
  );

  /* ------------------------------- form --------------------------------- */

  const openCreate = () => {
    setEditingId(null);
    setFormType(typeFilter !== 'all' ? typeFilter : TYPES[0]);
    setFormName('');
    setFormMessage('');
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (tpl: MessageTemplate) => {
    setEditingId(tpl.id);
    setFormType(tpl.type || TYPES[0]);
    setFormName(tpl.name || '');
    setFormMessage(tpl.message || '');
    setFormError(null);
    setModalOpen(true);
  };

  const insertToken = (token: string) => setFormMessage((m) => (m ? `${m}${/\s$/.test(m) ? '' : ' '}${token}` : token));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = formName.trim();
    const message = formMessage.trim();
    if (!name) return setFormError('Give the template a name.');
    if (!message) return setFormError('The message body cannot be empty.');
    setSaving(true);
    setFormError(null);
    const ok = editingId ? await onUpdateTemplate(editingId, { type: formType, name, message }) : await onAddTemplate({ type: formType, name, message });
    setSaving(false);
    if (ok) {
      toast(editingId ? 'Template updated' : 'Template saved', name, 'success');
      setModalOpen(false);
    }
  };

  const copy = async (tpl: MessageTemplate) => {
    const text = previewIds.has(tpl.id) ? fillTemplate(tpl.message, sampleVars) : tpl.message;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(tpl.id);
      setTimeout(() => setCopiedId((c) => (c === tpl.id ? null : c)), 2000);
    } catch {
      toast('Copy failed', 'Your browser blocked clipboard access.', 'warning');
    }
  };

  const togglePreview = (id: string) =>
    setPreviewIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const ok = await onDeleteTemplate(deleteTarget.id);
    setDeleting(false);
    if (ok) toast('Template deleted', deleteTarget.name, 'info');
    setDeleteTarget(null);
  };

  /* ------------------------------- render ------------------------------- */

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight">Message Templates</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">Standard replies for WhatsApp, email and follow-ups. Tokens: {TOKENS.map((t) => t.token).join(', ')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setImportOpen(true)} icon={<FileUp size={14} />} title="Create templates from the scripts in a Word, Excel, CSV or text file">Import from file</Button>
          <Button variant="primary" onClick={openCreate} icon={<Plus size={14} />}>New Template</Button>
        </div>
      </div>

      {templates.length > 0 && <Tabs tabs={tabs} value={typeFilter} onChange={setTypeFilter} />}

      {templates.length === 0 ? (
        <Card>
          <EmptyState
            icon={<MessageSquareQuote size={22} />}
            title="No templates yet"
            description={<>Create reusable messages for enquiries, site-visit confirmations and follow-ups, or import the scripts you already have in Word, Excel, CSV or text. Tokens such as {'{name}'} and {'{rm}'} are filled in when you use them.<span className="block mt-1.5 text-[#9E948D]">{TEMPLATE_IMPORT_TIP}</span></>}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="primary" onClick={openCreate} icon={<Plus size={14} />}>Create the first template</Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)} icon={<FileUp size={14} />}>Import from file</Button>
              </div>
            }
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card><EmptyState title={`No ${typeFilter} templates`} description="Create one or switch to another type." action={<Button variant="secondary" onClick={openCreate} icon={<Plus size={14} />}>New {typeFilter} template</Button>} /></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((tpl) => {
            const preview = previewIds.has(tpl.id);
            return (
              <div key={tpl.id} className="bg-white rounded-xl p-5 border border-[#D2C9BF] shadow-xs flex flex-col justify-between hover:border-[#A9825A] transition">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <Badge tone="gold">{tpl.type || 'General'}</Badge>
                    <div className="flex items-center gap-1">
                      <button onClick={() => togglePreview(tpl.id)} className={`p-1.5 rounded-md transition ${preview ? 'text-[#A9825A] bg-[#A9825A]/10' : 'text-[#9E948D] hover:text-[#1D2F3F]'}`} title={preview ? 'Show raw template' : 'Preview with sample values'}>
                        {preview ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button onClick={() => openEdit(tpl)} className="p-1.5 rounded-md text-[#9E948D] hover:text-[#1D2F3F] transition" title="Edit template"><Edit size={13} /></button>
                      <button onClick={() => setDeleteTarget(tpl)} className="p-1.5 rounded-md text-[#9E948D] hover:text-[#8A3E28] transition" title="Delete template"><Trash2 size={13} /></button>
                    </div>
                  </div>
                  <h4 className="text-sm font-bold text-[#1D2F3F] mb-2 break-words">{tpl.name}</h4>
                  <div className={`p-3.5 rounded-lg text-xs leading-relaxed whitespace-pre-wrap border mb-3 max-h-56 overflow-y-auto break-words ${preview ? 'bg-[#E8F0E7] border-[#7C8B78]/40 text-[#2F3F2D]' : 'bg-[#F4F0EB] border-[#D2C9BF]/60 text-[#3D3530]'}`}>
                    {preview ? fillTemplate(tpl.message, sampleVars) : tpl.message}
                  </div>
                </div>
                <div className="pt-3 border-t border-[#ECE8E1] flex items-center justify-between gap-2">
                  <span className="text-[10px] text-[#9E948D]">{preview ? 'Preview with sample values' : tpl.updated ? `Updated ${formatRelative(tpl.updated)}` : 'Tokens are filled when used'}</span>
                  <Button variant="primary" size="xs" onClick={() => copy(tpl)} icon={copiedId === tpl.id ? <Check size={12} /> : <Copy size={12} />}>{copiedId === tpl.id ? 'Copied' : preview ? 'Copy preview' : 'Copy text'}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? 'Edit template' : 'Create template'}
        subtitle="Use tokens so the message personalises itself when sent"
        width="lg"
        footer={<><Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={saving}>{editingId ? 'Save changes' : 'Save template'}</Button></>}
      >
        <form onSubmit={submit} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-4">
            <Field label="Channel / type">
              <Select value={formType} onChange={(e) => setFormType(e.target.value)} options={types} />
            </Field>
            <Field label="Template name *">
              <input className={inputCls} value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Post site-visit thank you" required />
            </Field>
            <Field label="Message *">
              <textarea rows={8} className={inputCls} value={formMessage} onChange={(e) => setFormMessage(e.target.value)} placeholder={'Hello {name}, this is {rm} from {project}. Thank you for visiting us today…'} required />
            </Field>
            <div>
              <span className={labelCls}>Insert token</span>
              <div className="flex flex-wrap gap-1.5">
                {TOKENS.map((t) => (
                  <button type="button" key={t.token} onClick={() => insertToken(t.token)} className="px-2 py-1 rounded-md bg-[#F4F0EB] border border-[#D2C9BF] text-[11px] font-mono text-[#1D2F3F] hover:border-[#A9825A]" title={t.label}>{t.token}</button>
                ))}
              </div>
            </div>
            {formError && <InlineNotice tone="warning">{formError}</InlineNotice>}
          </div>
          <div>
            <span className={labelCls}>Live preview</span>
            <div className="p-4 rounded-xl bg-[#E8F0E7] border border-[#7C8B78]/40 text-xs text-[#2F3F2D] leading-relaxed whitespace-pre-wrap min-h-[180px] break-words">
              {formMessage.trim() ? fillTemplate(formMessage, sampleVars) : <span className="text-[#7C8B78] italic">Type a message to see it with sample values…</span>}
            </div>
            <div className="text-[10px] text-[#9E948D] mt-2 leading-relaxed">
              Sample values: {TOKENS.map((t) => `${t.token} → ${(sampleVars as Record<string, string>)[t.token.slice(1, -1)]}`).join(' · ')}
            </div>
          </div>
          <button type="submit" className="hidden" aria-hidden="true" />
        </form>
      </Modal>

      {importOpen && (
        <ImportTemplatesModal
          open
          onClose={() => setImportOpen(false)}
          existing={templates}
          knownTypes={types}
          onAddTemplate={onAddTemplate}
          onImported={() => setTypeFilter('all')}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete template?"
        danger
        confirmLabel="Delete"
        loading={deleting}
        message={<>“{deleteTarget?.name}” will be removed for everyone. This cannot be undone.</>}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
