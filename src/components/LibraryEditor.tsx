/**
 * The Project Library's "Edit library" tab (Admins): Quick Reference Specs and every document — its details,
 * chapters and passages (one passage per line). Saved for the whole company; "Restore original" goes back to the
 * library built into the app. Passages keep their search tags while their text is unchanged.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { api } from '../core/api';
import { toAppError } from '../core/errors';
import { toast } from '../core/notifications';
import {
  LIBRARY_CATEGORIES, SECTION_ICONS, projectLibrary, useProjectLibrary,
  type LibraryCategory, type LibraryContent, type LibraryDoc, type LibraryPassage,
} from '../documents/projectLibrary';
import { Button, Field, Select, cx, inputCls } from './ui';

interface DraftChapter { title: string; text: string }
type DraftDoc = Omit<LibraryDoc, 'chapters'> & { chapters: DraftChapter[] };
interface DraftSection { category: string; docRef: string; icon: string; text: string }
interface Draft { documents: DraftDoc[]; sections: DraftSection[] }

const ICON_LABEL: Record<string, string> = { building: 'Building', shield: 'Shield', money: 'Money', heart: 'Heart', sparkles: 'Sparkles', map: 'Map pin', book: 'Book', file: 'Document' };

const toDraft = (c: LibraryContent): Draft => ({
  documents: c.documents.map((d) => ({ ...d, chapters: d.chapters.map((ch) => ({ title: ch.title, text: ch.passages.map((p) => p.text).join('\n') })) })),
  sections: c.sections.map((s) => ({ category: s.category, docRef: s.docRef, icon: s.icon, text: s.items.join('\n') })),
});

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** Draft → content; a passage whose text is unchanged keeps its tags and page number. */
function fromDraft(d: Draft, before: LibraryContent): LibraryContent {
  const kept = new Map<string, LibraryPassage>();
  for (const doc of before.documents) for (const ch of doc.chapters) for (const p of ch.passages) kept.set(`${doc.id}\n${p.text}`, p);
  return {
    documents: d.documents.map((doc) => ({
      ...doc,
      chapters: doc.chapters.map((ch) => ({
        title: ch.title.trim(),
        passages: lines(ch.text).map((t) => {
          const old = kept.get(`${doc.id}\n${t}`);
          return { text: t, tags: old?.tags || [], ...(old?.pageNumber ? { pageNumber: old.pageNumber } : {}) };
        }),
      })),
    })),
    sections: d.sections.map((s) => ({ category: s.category.trim(), docRef: s.docRef.trim(), icon: s.icon, items: lines(s.text) })),
  };
}

const newDocId = (docs: DraftDoc[]) => {
  let n = docs.length + 1;
  while (docs.some((d) => d.id === `doc-${n}`)) n++;
  return `doc-${n}`;
};

const move = <T,>(list: T[], i: number, by: -1 | 1): T[] => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

export const LibraryEditor: React.FC<{ onDirty: (dirty: boolean) => void }> = ({ onDirty }) => {
  const lib = useProjectLibrary();
  const [base, setBase] = useState<LibraryContent>(lib.content);
  const [draft, setDraft] = useState<Draft>(() => toDraft(lib.content));
  const [open, setOpen] = useState<string>('specs');
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => JSON.stringify(toDraft(base)) !== JSON.stringify(draft), [base, draft]);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  // the saved library arrived after the editor opened, and nothing was changed yet: show it
  useEffect(() => {
    if (!dirty && lib.content !== base) {
      setBase(lib.content);
      setDraft(toDraft(lib.content));
    }
  }, [lib.content]); // eslint-disable-line react-hooks/exhaustive-deps

  const doc = draft.documents.find((d) => d.id === open);
  const setDoc = (id: string, patch: Partial<DraftDoc>) => setDraft((p) => ({ ...p, documents: p.documents.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
  const setChapter = (id: string, i: number, patch: Partial<DraftChapter>) => {
    const d = draft.documents.find((x) => x.id === id);
    if (d) setDoc(id, { chapters: d.chapters.map((c, ci) => (ci === i ? { ...c, ...patch } : c)) });
  };
  const setSection = (i: number, patch: Partial<DraftSection>) => setDraft((p) => ({ ...p, sections: p.sections.map((s, si) => (si === i ? { ...s, ...patch } : s)) }));

  const addDocument = () => {
    const id = newDocId(draft.documents);
    setDraft((p) => ({
      ...p,
      documents: [...p.documents, {
        id, title: 'New document', shortName: 'New document', refName: 'Document', refTitle: '', idPrefix: '', category: 'Brochure' as LibraryCategory,
        badgeColor: '', summary: '', fileName: '', downloadUrl: '', chapters: [{ title: 'Chapter 1', text: '' }],
      }],
    }));
    setOpen(id);
  };

  const removeDocument = (id: string) => {
    const d = draft.documents.find((x) => x.id === id);
    if (!d || !window.confirm(`Remove “${d.title}” and all its passages from the library?`)) return;
    setDraft((p) => ({ ...p, documents: p.documents.filter((x) => x.id !== id) }));
    setOpen('specs');
  };

  const save = async () => {
    const missing = draft.documents.find((d) => !d.title.trim());
    if (missing) return toast('Not saved', 'Every document needs a title.', 'warning');
    setSaving(true);
    try {
      const content = fromDraft(draft, base);
      const r = await api.library.save(content);
      projectLibrary.set(r);
      const saved = r.content || content;
      setBase(saved);
      setDraft(toDraft(saved));
      toast('Library saved', 'Everyone in the company now sees the updated library.', 'success');
    } catch (e) {
      toast('Library not saved', toAppError(e).userMessage, 'alert');
    }
    setSaving(false);
  };

  const restore = async () => {
    if (!window.confirm('Go back to the original library? All edits made to the library are removed for everyone.')) return;
    setSaving(true);
    try {
      const r = await api.library.save(null);
      projectLibrary.set(r);
      const fresh = projectLibrary.get().content;
      setBase(fresh);
      setDraft(toDraft(fresh));
      setOpen('specs');
      toast('Original library restored', '', 'success');
    } catch (e) {
      toast('Not restored', toAppError(e).userMessage, 'alert');
    }
    setSaving(false);
  };

  const navBtn = (id: string, label: React.ReactNode) => (
    <button
      key={id}
      type="button"
      onClick={() => setOpen(id)}
      className={cx('w-full text-left px-3 py-2 rounded-lg text-xs font-semibold truncate transition', open === id ? 'bg-white text-[#0B2A44] border border-[#D3E3F0] shadow-xs' : 'text-[#5E778C] hover:bg-white/70 hover:text-[#0B2A44]')}
    >
      {label}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* what to edit */}
        <div className="w-full md:w-60 bg-[#F5F9FC] border-b md:border-b-0 md:border-r border-[#D3E3F0] p-3 overflow-y-auto shrink-0 space-y-1 max-h-48 md:max-h-none">
          {navBtn('specs', 'Quick Reference Specs')}
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[#7E93A6] pt-3 pb-1 px-1">Documents</div>
          {draft.documents.map((d) => navBtn(d.id, d.title || 'Untitled document'))}
          <button type="button" onClick={addDocument} className="w-full flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-[#0B6BB0] hover:bg-white/70">
            <Plus size={13} /> Add document
          </button>
        </div>

        {/* editor */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {open === 'specs' && (
            <>
              <p className="text-xs text-[#5E778C]">The summary cards on the Quick Reference Specs tab. One point per line.</p>
              {draft.sections.map((s, i) => (
                <div key={i} className="rounded-xl border border-[#D3E3F0] p-3 space-y-2.5 bg-white">
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_9rem_8rem_auto] gap-2 items-end">
                    <Field label="Heading"><input className={inputCls} value={s.category} onChange={(e) => setSection(i, { category: e.target.value })} /></Field>
                    <Field label="Source reference"><input className={inputCls} value={s.docRef} placeholder="Brochure 1:1" onChange={(e) => setSection(i, { docRef: e.target.value })} /></Field>
                    <Field label="Icon"><Select value={s.icon} options={SECTION_ICONS.map((v) => ({ value: v, label: ICON_LABEL[v] }))} onChange={(e) => setSection(i, { icon: e.target.value })} /></Field>
                    <div className="flex gap-1 pb-0.5">
                      <Button size="xs" variant="ghost" aria-label="Move up" title="Move up" onClick={() => setDraft((p) => ({ ...p, sections: move(p.sections, i, -1) }))} icon={<ArrowUp size={13} />} />
                      <Button size="xs" variant="ghost" aria-label="Move down" title="Move down" onClick={() => setDraft((p) => ({ ...p, sections: move(p.sections, i, 1) }))} icon={<ArrowDown size={13} />} />
                      <Button size="xs" variant="danger" aria-label="Remove section" title="Remove section" onClick={() => setDraft((p) => ({ ...p, sections: p.sections.filter((_, si) => si !== i) }))} icon={<Trash2 size={13} />} />
                    </div>
                  </div>
                  <Field label="Points (one per line)">
                    <textarea className={cx(inputCls, 'resize-y leading-relaxed')} rows={Math.min(12, Math.max(4, s.text.split('\n').length + 1))} value={s.text} onChange={(e) => setSection(i, { text: e.target.value })} />
                  </Field>
                </div>
              ))}
              <Button variant="secondary" icon={<Plus size={13} />} onClick={() => setDraft((p) => ({ ...p, sections: [...p.sections, { category: 'New section', docRef: '', icon: 'file', text: '' }] }))}>Add section</Button>
            </>
          )}

          {doc && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Title *" className="sm:col-span-2"><input className={inputCls} value={doc.title} onChange={(e) => setDoc(doc.id, { title: e.target.value })} /></Field>
                <Field label="Short name" hint="Shown on the reader and the documents folder"><input className={inputCls} value={doc.shortName} onChange={(e) => setDoc(doc.id, { shortName: e.target.value })} /></Field>
                <Field label="Name in references" hint={`Passages are quoted as “${doc.refName || 'Name'} 1:1”`}><input className={inputCls} value={doc.refName} maxLength={40} onChange={(e) => setDoc(doc.id, { refName: e.target.value })} /></Field>
                <Field label="Category"><Select value={doc.category} options={LIBRARY_CATEGORIES} onChange={(e) => setDoc(doc.id, { category: e.target.value as LibraryCategory })} /></Field>
                <Field label="File name"><input className={inputCls} value={doc.fileName} placeholder="Brochure.pdf" onChange={(e) => setDoc(doc.id, { fileName: e.target.value })} /></Field>
                <Field label="Download link" className="sm:col-span-2" hint="An https:// link (e.g. Google Drive) or a file in the app's /documents folder"><input className={inputCls} value={doc.downloadUrl} placeholder="https://…" onChange={(e) => setDoc(doc.id, { downloadUrl: e.target.value })} /></Field>
                <Field label="Summary" className="sm:col-span-2"><textarea className={cx(inputCls, 'resize-y')} rows={2} value={doc.summary} onChange={(e) => setDoc(doc.id, { summary: e.target.value })} /></Field>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[#E6EFF6]">
                <h4 className="text-sm font-bold text-[#0B2A44]">Chapters</h4>
                <span className="text-[11px] text-[#7E93A6]">One passage per line — each line becomes a searchable passage</span>
              </div>
              {doc.chapters.map((c, i) => (
                <div key={i} className="rounded-xl border border-[#D3E3F0] p-3 space-y-2.5 bg-white">
                  <div className="flex items-end gap-2">
                    <Field label={`Chapter ${i + 1} title`} className="flex-1"><input className={inputCls} value={c.title} onChange={(e) => setChapter(doc.id, i, { title: e.target.value })} /></Field>
                    <div className="flex gap-1 pb-0.5">
                      <Button size="xs" variant="ghost" aria-label="Move up" title="Move up" onClick={() => setDoc(doc.id, { chapters: move(doc.chapters, i, -1) })} icon={<ArrowUp size={13} />} />
                      <Button size="xs" variant="ghost" aria-label="Move down" title="Move down" onClick={() => setDoc(doc.id, { chapters: move(doc.chapters, i, 1) })} icon={<ArrowDown size={13} />} />
                      <Button size="xs" variant="danger" aria-label="Remove chapter" title="Remove chapter" onClick={() => window.confirm(`Remove chapter ${i + 1} and its passages?`) && setDoc(doc.id, { chapters: doc.chapters.filter((_, ci) => ci !== i) })} icon={<Trash2 size={13} />} />
                    </div>
                  </div>
                  <Field label={`Passages (${lines(c.text).length})`}>
                    <textarea className={cx(inputCls, 'resize-y leading-relaxed')} rows={Math.min(14, Math.max(4, c.text.split('\n').length + 1))} value={c.text} onChange={(e) => setChapter(doc.id, i, { text: e.target.value })} />
                  </Field>
                </div>
              ))}
              <div className="flex flex-wrap gap-2 justify-between">
                <Button variant="secondary" icon={<Plus size={13} />} onClick={() => setDoc(doc.id, { chapters: [...doc.chapters, { title: `Chapter ${doc.chapters.length + 1}`, text: '' }] })}>Add chapter</Button>
                <Button variant="danger" icon={<Trash2 size={13} />} onClick={() => removeDocument(doc.id)}>Remove document</Button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-[#D3E3F0] bg-[#F5F9FC] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] text-[#5E778C]">
          {dirty ? 'Unsaved changes' : lib.custom ? `Saved${lib.updatedBy ? ` by ${lib.updatedBy}` : ''}${lib.updatedAt ? ` · ${new Date(lib.updatedAt).toLocaleString()}` : ''}` : 'The original library (no edits saved yet)'}
        </span>
        <div className="flex flex-wrap gap-2">
          {lib.custom && <Button variant="ghost" icon={<RotateCcw size={13} />} disabled={saving} onClick={() => void restore()}>Restore original</Button>}
          <Button variant="secondary" disabled={!dirty || saving} onClick={() => setDraft(toDraft(base))}>Discard changes</Button>
          <Button variant="primary" icon={<Save size={13} />} loading={saving} disabled={!dirty} onClick={() => void save()}>Save library</Button>
        </div>
      </div>
    </div>
  );
};
