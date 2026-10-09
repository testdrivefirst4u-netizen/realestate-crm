/**
 * Lead detail → Files tab: documents stored with the lead on the CRM server
 * (api.storage.listLeadFiles / api.storage.uploadLeadFile).
 */
import React, { useMemo, useRef, useState } from 'react';
import { ExternalLink, FileText, Paperclip, RefreshCw, Upload } from 'lucide-react';
import { CrmDocument, Lead } from '../../../types/crm';
import { F } from '../../../core/config';
import { api } from '../../../core/api';
import { compareDates, formatDateTime } from '../../../core/dates';
import { reportError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { Badge, Button, EmptyState, ErrorState, Field, InlineNotice, Select, cx, inputCls } from '../../../components/ui';
import { MAX_UPLOAD_BYTES, fileToBase64, formatBytes, useLazyResource } from '../shared';
import { ListSkeleton } from '../../../components/Skeletons';

const CATEGORIES = ['Documents', 'Other Files'];

export const FilesTab: React.FC<{ lead: Lead; active: boolean; onChanged?: () => void }> = ({ lead, active, onChanged }) => {
  const id = String(lead[F.ID]);
  const files = useLazyResource<CrmDocument[]>(active, () => api.storage.listLeadFiles(id), 'leads.files');

  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const list = useMemo(() => [...(files.data || [])].sort((a, b) => compareDates(a.uploadedDate, b.uploadedDate, false)), [files.data]);

  const upload = async () => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Share it from cloud storage and paste the link in a note.`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const doc = await api.storage.uploadLeadFile(id, category, file.name, file.type || 'application/octet-stream', base64, description.trim() || undefined);
      files.setData((prev) => [doc, ...(prev || []).filter((d) => d.id !== doc.id)]);
      toast('File uploaded', `${doc.name} → ${category}`, 'success');
      setFile(null);
      setDescription('');
      if (inputRef.current) inputRef.current.value = '';
      onChanged?.();
    } catch (e) {
      setError(reportError('leads.fileUpload', e).userMessage);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-[#F2F7FB] p-4 rounded-xl border border-[#D3E3F0] space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-[#0B2A44]">
          <Upload size={14} className="text-[#0B6BB0]" />
          Upload a file to this enquiry
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="File" hint={file ? `${file.name} · ${formatBytes(file.size)}` : `Up to ${formatBytes(MAX_UPLOAD_BYTES)} — ID proofs, agreements, floor plans…`}>
            <input
              ref={inputRef}
              type="file"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setError(null);
              }}
              className={cx(inputCls, 'file:mr-3 file:px-2.5 file:py-1 file:rounded-md file:border-0 file:bg-[#0B2A44] file:text-white file:text-[11px] file:font-semibold')}
            />
          </Field>
          <Field label="Folder">
            <Select value={category} onChange={(e) => setCategory(e.target.value)} options={CATEGORIES} />
          </Field>
        </div>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Aadhaar copy of the prospect's son" className={inputCls} />
        </Field>
        {error && <InlineNotice tone="warning">{error}</InlineNotice>}
        <div className="flex justify-end">
          <Button variant="gold" onClick={() => void upload()} disabled={!file} loading={uploading} icon={<Upload size={12} />}>
            Upload
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase font-bold tracking-wider text-[#5E778C]">Files{files.data ? ` · ${list.length}` : ''}</div>
        <Button variant="ghost" size="xs" onClick={() => void files.reload()} loading={files.loading} icon={<RefreshCw size={11} />}>
          Refresh
        </Button>
      </div>
      {files.loading && !files.data && <ListSkeleton rows={3} label="Loading files…" />}
      {files.error && !files.data && <ErrorState compact title="Files could not load" message={files.error} onRetry={() => void files.reload()} />}
      {files.data && list.length === 0 && <EmptyState icon={<Paperclip size={20} />} title="No files yet" description="Documents, call recordings and transcripts for this enquiry are stored with it on the CRM server and listed here." className="py-6" />}

      <div className="space-y-2">
        {list.map((d) => (
          <div key={d.id} className="bg-white rounded-xl border border-[#D3E3F0] p-3 shadow-2xs flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="mt-0.5 w-7 h-7 rounded-lg bg-[#0B2A44]/10 text-[#0B2A44] flex items-center justify-center flex-shrink-0">
                <FileText size={13} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[#0B2A44] hover:text-[#0B6BB0] inline-flex items-center gap-1 break-all">
                    {d.name} <ExternalLink size={10} className="flex-shrink-0" />
                  </a>
                  {d.category && <Badge tone="muted">{d.category}</Badge>}
                </div>
                {d.description && <div className="text-xs text-[#0F2233] mt-0.5 leading-relaxed">{d.description}</div>}
                <div className="text-[10px] text-[#7E93A6] mt-1">
                  {formatDateTime(d.uploadedDate, '—')}
                  {d.uploadedBy && ` · ${d.uploadedBy}`}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
