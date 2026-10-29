/**
 * "Add files" for the Project Library (admins and the chosen library editors): drop or pick PDF, Word (.docx),
 * Excel (.xlsx), CSV or text files. Each file is sent in ~3 MB pieces, then the server reads it into chapters and
 * passages and adds it as a new document — searchable straight away, with the original kept for download.
 */
import React, { useRef, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, FileText, FileType2, Loader2, UploadCloud, XCircle } from 'lucide-react';
import { api } from '../core/api';
import { toAppError } from '../core/errors';
import { projectLibrary } from '../documents/projectLibrary';
import { cx } from './ui';

const PART = 3_000_000;
const MAX_BYTES = 45 * 1024 * 1024;
export const LIBRARY_ACCEPT = '.pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md';

type Status = { id: string; name: string; state: 'sending' | 'reading' | 'done' | 'error'; pct: number; message: string; docId?: string };

/** The icon for a file by its name: PDF, spreadsheet, Word / text. */
export function FileKindIcon({ name, size = 18, className = '' }: { name: string; size?: number; className?: string }) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
  if (ext === 'pdf') return <FileType2 size={size} className={cx('text-rose-600', className)} />;
  if (['xlsx', 'xlsm', 'xls', 'csv'].includes(ext)) return <FileSpreadsheet size={size} className={cx('text-emerald-600', className)} />;
  return <FileText size={size} className={cx('text-[#0B6BB0]', className)} />;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const LibraryUpload: React.FC<{ disabled?: string; onAdded?: (docId: string) => void }> = ({ disabled, onAdded }) => {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Status[]>([]);
  const [over, setOver] = useState(false);
  const busy = items.some((i) => i.state === 'sending' || i.state === 'reading');
  const patch = (id: string, p: Partial<Status>) => setItems((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const addOne = async (file: File) => {
    const id = newId();
    setItems((l) => [{ id, name: file.name, state: 'sending', pct: 0, message: '' }, ...l]);
    try {
      if (file.size > MAX_BYTES) throw new Error('File is larger than 45 MB.');
      if (!file.size) throw new Error('The file is empty.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parts = Math.ceil(bytes.length / PART);
      for (let i = 0; i < parts; i++) {
        await api.library.uploadPart(id, i, toBase64(bytes.subarray(i * PART, (i + 1) * PART)));
        patch(id, { pct: Math.round(((i + 1) / parts) * 100) });
      }
      patch(id, { state: 'reading' });
      const r = await api.library.importFile({ uploadId: id, parts, name: file.name, mime: file.type || '' });
      projectLibrary.set(r);
      patch(id, { state: 'done', docId: r.added.id, message: `Added as “${r.added.title}” — ${r.added.chapters} ${r.added.chapters === 1 ? 'section' : 'sections'}, ${r.added.passages} passages` });
    } catch (e) {
      patch(id, { state: 'error', message: e instanceof Error && !('code' in e) ? e.message : toAppError(e).userMessage });
    }
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files || disabled) return;
    for (const f of Array.from(files).slice(0, 10)) await addOne(f); // one at a time: the server reads each in turn
  };

  return (
    <div className="space-y-2.5">
      <div
        role="button"
        tabIndex={0}
        aria-disabled={!!disabled}
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void addFiles(e.dataTransfer.files);
        }}
        className={cx(
          'rounded-2xl border-2 border-dashed px-4 py-5 text-center transition select-none',
          disabled ? 'border-[#D3E3F0] bg-[#F7FAFD] cursor-not-allowed opacity-70' : over ? 'border-[#0B6BB0] bg-[#EEF6FC] cursor-copy' : 'border-[#B9CCDB] bg-white hover:border-[#0B6BB0] hover:bg-[#F7FAFD] cursor-pointer',
        )}
      >
        <UploadCloud size={26} className="mx-auto text-[#0B6BB0]" />
        <p className="mt-1.5 text-sm font-semibold text-[#0B2A44]">{busy ? 'Adding files…' : 'Drop files here or click to choose'}</p>
        <p className="text-[11px] text-[#5E778C] mt-0.5">{disabled || 'PDF, Word (.docx), Excel (.xlsx), CSV or text · up to 45 MB each · the text becomes searchable'}</p>
        <div className="mt-2 flex justify-center gap-3 text-[11px] text-[#5E778C]">
          <span className="inline-flex items-center gap-1"><FileKindIcon name="a.pdf" size={13} /> PDF</span>
          <span className="inline-flex items-center gap-1"><FileKindIcon name="a.docx" size={13} /> Word</span>
          <span className="inline-flex items-center gap-1"><FileKindIcon name="a.xlsx" size={13} /> Excel</span>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept={LIBRARY_ACCEPT}
          className="hidden"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="rounded-xl border border-[#D3E3F0] bg-white divide-y divide-[#EAF1F7]">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileKindIcon name={it.name} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-[#0B2A44] truncate">{it.name}</div>
                {it.state === 'sending' && (
                  <div className="mt-1 h-1.5 rounded-full bg-[#E6EFF6] overflow-hidden"><div className="h-full bg-[#0B6BB0] transition-all" style={{ width: `${it.pct}%` }} /></div>
                )}
                {it.state === 'reading' && <div className="text-[11px] text-[#5E778C]">Reading the text… large or scanned PDFs can take a minute</div>}
                {(it.state === 'done' || it.state === 'error') && <div className={cx('text-[11px]', it.state === 'error' ? 'text-rose-700' : 'text-[#5E778C]')}>{it.message}</div>}
              </div>
              {it.state === 'sending' || it.state === 'reading' ? (
                <Loader2 size={16} className="animate-spin text-[#0B6BB0] shrink-0" />
              ) : it.state === 'done' ? (
                <span className="flex items-center gap-2 shrink-0">
                  {onAdded && it.docId && (
                    <button type="button" onClick={() => onAdded(it.docId!)} className="text-[11px] font-semibold text-[#0B6BB0] hover:underline">Open</button>
                  )}
                  <CheckCircle2 size={16} className="text-emerald-600" />
                </span>
              ) : (
                <XCircle size={16} className="text-rose-600 shrink-0" />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
