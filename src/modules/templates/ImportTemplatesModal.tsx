/**
 * Import message templates from a Word, Excel, CSV or text file.
 *
 * Pick a file → review what was found (tick rows, adjust type and name) → "Add N templates" saves the ticked rows
 * one at a time through `onAddTemplate` (optimistic, so each appears in the list straight away). Parsing happens
 * in the browser (importTemplates.ts); nothing is saved before the user confirms. Rows whose name and message
 * already exist are shown but cannot be ticked, and are skipped again at save time.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileSpreadsheet, FileText, FileUp, Info, Loader2, Type as TypeIcon, Upload, X } from 'lucide-react';
import { MessageTemplate } from '../../types/crm';
import { toast } from '../../core/notifications';
import { reportError } from '../../core/errors';
import { Badge, Bar, Button, InlineNotice, Modal, Select, cx, inputCls } from '../../components/ui';
import {
  DEFAULT_TEMPLATE_TYPE,
  MAX_TEMPLATE_FILE_BYTES,
  MAX_TEMPLATE_NAME_LENGTH,
  ParsedTemplate,
  TEMPLATE_FILE_ACCEPT,
  TEMPLATE_IMPORT_TIP,
  TemplateFileFormat,
  TemplateImportError,
  parseTemplateFileDetailed,
  templateFingerprint,
} from './importTemplates';

export interface ImportTemplatesModalProps {
  open: boolean;
  onClose: () => void;
  /** Templates already saved — a row with the same name and message is skipped. */
  existing: MessageTemplate[];
  /** Types offered in each row's type picker (the view's list); file types are added to it. */
  knownTypes: string[];
  onAddTemplate: (t: Partial<MessageTemplate>) => Promise<boolean>;
  /** Called after a run that added at least one template. */
  onImported?: (added: number) => void;
}

interface ReviewRow extends ParsedTemplate {
  key: string;
  selected: boolean;
  failed?: boolean;
  expanded?: boolean;
}

type Phase = 'pick' | 'reading' | 'review';

const FORMAT_LABEL: Record<TemplateFileFormat, string> = { docx: 'Word', xlsx: 'Excel', csv: 'CSV', text: 'Text' };
const MAX_MB = Math.round(MAX_TEMPLATE_FILE_BYTES / (1024 * 1024));
/** Consecutive failed saves after which the run stops (the backend is probably unreachable). */
const STOP_AFTER_FAILURES = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isLong = (message: string) => message.length > 240 || message.split('\n').length > 4;

export const ImportTemplatesModal: React.FC<ImportTemplatesModalProps> = ({ open, onClose, existing, knownTypes, onAddTemplate, onImported }) => {
  const [phase, setPhase] = useState<Phase>('pick');
  const [file, setFile] = useState<{ name: string; size: number; format?: TemplateFileFormat; found?: number } | null>(null);
  const [added, setAdded] = useState(0); // saved from this file so far (across retries)
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [inputKey, setInputKey] = useState(0); // remount the input so the same file can be picked again
  const [importing, setImporting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const stopRef = useRef(false);
  const readIdRef = useRef(0); // ignores the result of a file read that a newer pick replaced

  const existingKeys = useMemo(() => new Set(existing.map((t) => templateFingerprint(t.name, t.message))), [existing]);
  const existingKeysRef = useRef(existingKeys);
  useEffect(() => {
    existingKeysRef.current = existingKeys;
  }, [existingKeys]);

  const { selectable, chosen, existingCount } = useMemo(() => {
    const exists = (r: ReviewRow) => existingKeys.has(templateFingerprint(r.name, r.message));
    const selectableRows = rows.filter((r) => r.name.trim() && !exists(r));
    return { selectable: selectableRows, chosen: selectableRows.filter((r) => r.selected), existingCount: rows.filter(exists).length };
  }, [rows, existingKeys]);
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = chosen.length > 0 && !allChosen;
  }, [chosen.length, allChosen, phase]);

  const typeOptions = useMemo(() => {
    const set = new Set(knownTypes.filter(Boolean));
    rows.forEach((r) => r.type && set.add(r.type));
    return Array.from(set);
  }, [knownTypes, rows]);

  /* -------------------------------- file -------------------------------- */

  const openPicker = () => {
    if (!importing) inputRef.current?.click();
  };

  const readFile = async (f: File) => {
    if (importing) return;
    const id = ++readIdRef.current;
    setError(null);
    setWarnings([]);
    setRows([]);
    setAdded(0);
    setFile({ name: f.name, size: f.size });
    if (f.size > MAX_TEMPLATE_FILE_BYTES) {
      setPhase('pick');
      setError(`“${f.name}” is larger than ${MAX_MB} MB. Split it into smaller files and try again.`);
      return;
    }
    setPhase('reading');
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const result = await parseTemplateFileDetailed({ name: f.name, bytes }, { knownTypes });
      if (id !== readIdRef.current) return;
      setFile({ name: f.name, size: f.size, format: result.format, found: result.templates.length });
      if (!result.templates.length) {
        setPhase('pick');
        setError(`No templates were found in “${f.name}”. ${TEMPLATE_IMPORT_TIP}`);
        return;
      }
      setWarnings(result.warnings);
      setRows(
        result.templates.map((t, i) => ({
          ...t,
          key: `${id}:${i}`,
          // Intro text and templates you already have start unticked.
          selected: !t.unsure && !existingKeysRef.current.has(templateFingerprint(t.name, t.message)),
        }))
      );
      setPhase('review');
    } catch (e) {
      if (id !== readIdRef.current) return;
      if (!(e instanceof TemplateImportError)) reportError('templates.importFile', e, { size: f.size, type: f.type });
      setPhase('pick');
      setError(e instanceof TemplateImportError ? e.message : `“${f.name}” couldn’t be read. Check that it is a Word (.docx), Excel (.xlsx), CSV or text file.`);
    } finally {
      setInputKey((k) => k + 1);
    }
  };

  const chooseAnother = () => {
    readIdRef.current++;
    setPhase('pick');
    setFile(null);
    setRows([]);
    setWarnings([]);
    setError(null);
  };

  /* -------------------------------- rows -------------------------------- */

  const updateRow = (key: string, patch: Partial<ReviewRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const toggleAll = () => {
    const next = !allChosen;
    const keys = new Set(selectable.map((r) => r.key));
    setRows((rs) => rs.map((r) => (keys.has(r.key) ? { ...r, selected: next } : r)));
  };

  /* ------------------------------- import ------------------------------- */

  const runImport = async () => {
    if (importing || !chosen.length) return;
    const queue = chosen.map((r) => ({ key: r.key, type: r.type.trim() || DEFAULT_TEMPLATE_TYPE, name: r.name.trim(), message: r.message }));
    stopRef.current = false;
    setStopping(false);
    setImporting(true);
    setError(null);
    setProgress({ done: 0, total: queue.length });

    const saved = new Set<string>();
    const skipped = new Set<string>();
    const failed = new Set<string>();
    const seen = new Set<string>();
    let failuresInARow = 0;
    let gaveUp = false;
    for (let i = 0; i < queue.length && !stopRef.current; i++) {
      const item = queue[i];
      const fingerprint = templateFingerprint(item.name, item.message);
      if (seen.has(fingerprint) || existingKeysRef.current.has(fingerprint)) {
        skipped.add(item.key);
      } else {
        seen.add(fingerprint);
        let ok = false;
        try {
          ok = await onAddTemplate({ type: item.type, name: item.name, message: item.message });
        } catch (e) {
          reportError('templates.importSave', e);
        }
        if (ok) {
          saved.add(item.key);
          failuresInARow = 0;
        } else {
          failed.add(item.key);
          failuresInARow++;
        }
      }
      setProgress({ done: i + 1, total: queue.length });
      if (failuresInARow >= STOP_AFTER_FAILURES) {
        gaveUp = true;
        break;
      }
    }

    const stopped = stopRef.current;
    const notTried = queue.length - saved.size - skipped.size - failed.size;
    setImporting(false);
    setStopping(false);
    setRows((rs) => rs.filter((r) => !saved.has(r.key) && !skipped.has(r.key)).map((r) => (failed.has(r.key) ? { ...r, failed: true } : r)));
    setAdded((n) => n + saved.size);
    if (saved.size) onImported?.(saved.size);

    const summary = [
      saved.size || (!skipped.size && !failed.size) ? `${plural(saved.size, 'template')} added` : '',
      skipped.size ? `${skipped.size} already existed` : '',
      failed.size ? `${failed.size} could not be saved` : '',
      notTried ? `${notTried} not tried` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (!failed.size && !notTried) {
      toast(saved.size ? 'Templates imported' : 'Nothing new to import', summary, saved.size ? 'success' : 'info');
      onClose();
      return;
    }
    toast(stopped ? 'Import stopped' : saved.size ? 'Import incomplete' : 'Import failed', summary, stopped ? 'info' : saved.size ? 'warning' : 'alert');
    if (gaveUp) setError(`Stopped after ${STOP_AFTER_FAILURES} failed saves in a row — check your connection, then press “Add” to retry the remaining templates.`);
    else if (failed.size) setError(`${plural(failed.size, 'template')} could not be saved and ${failed.size === 1 ? 'is' : 'are'} still ticked below — press “Add” to try again.`);
  };

  const requestClose = () => {
    if (!importing) onClose();
  };

  /* ------------------------------- render ------------------------------- */

  const footer =
    phase === 'review' ? (
      <>
        <div className="mr-auto min-w-0 text-[11px] text-[#6B5F57]">
          {importing ? (
            <span className="font-semibold text-[#1D2F3F]">{stopping ? 'Stopping after this template…' : `Adding ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`}</span>
          ) : (
            <span>
              <strong className="text-[#1D2F3F]">{chosen.length}</strong> of {plural(rows.length, 'template')} selected
              {existingCount > 0 && ` · ${existingCount} already saved`}
            </span>
          )}
        </div>
        {importing ? (
          <Button
            variant="ghost"
            disabled={stopping}
            onClick={() => {
              stopRef.current = true;
              setStopping(true);
            }}
          >
            Stop
          </Button>
        ) : (
          <Button variant="ghost" onClick={requestClose}>Cancel</Button>
        )}
        <Button variant="primary" onClick={runImport} loading={importing} disabled={!chosen.length} icon={<FileUp size={13} />}>
          {importing ? 'Adding…' : `Add ${plural(chosen.length, 'template')}`}
        </Button>
      </>
    ) : (
      <Button variant="secondary" onClick={requestClose}>Close</Button>
    );

  return (
    <Modal
      open={open}
      onClose={requestClose}
      width="xl"
      title={
        <span className="inline-flex items-center gap-2">
          <FileUp size={18} className="text-[#A9825A]" />
          Import templates
        </span>
      }
      subtitle="Word, Excel, CSV or text — review what was found before anything is saved."
      footer={footer}
    >
      <div className="space-y-4 text-xs">
        <input
          ref={inputRef}
          key={inputKey}
          type="file"
          accept={TEMPLATE_FILE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f);
          }}
        />

        {error && (
          <InlineNotice tone="warning" className="flex items-start justify-between gap-3">
            <span className="inline-flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </span>
            <button onClick={() => setError(null)} className="text-amber-900/60 hover:text-amber-900" aria-label="Dismiss">
              <X size={14} />
            </button>
          </InlineNotice>
        )}

        {phase === 'pick' && (
          <>
            <div
              role="button"
              tabIndex={0}
              onClick={openPicker}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openPicker();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void readFile(f);
              }}
              className={cx(
                'block border-2 border-dashed rounded-xl p-8 text-center transition cursor-pointer focus:outline-none focus:border-[#A9825A]',
                dragging ? 'border-[#A9825A] bg-[#F4F0EB]' : 'border-[#B8AFA7] bg-[#F4F0EB]/50 hover:bg-[#F4F0EB]'
              )}
            >
              <Upload size={28} className="mx-auto text-[#A9825A] mb-2.5" />
              <span className="text-base font-bold text-[#1D2F3F] block mb-1.5">Choose a file, or drop it here</span>
              <p className="text-[#6B5F57] max-w-lg mx-auto leading-relaxed">
                Word (.docx), Excel (.xlsx), CSV or text (.txt, .md), up to {MAX_MB} MB. Every script found becomes a template you can review, rename or untick — nothing is saved until you press “Add”.
              </p>
              <span className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white border border-[#D2C9BF] text-[#1D2F3F] text-[11px] font-semibold">
                <Info size={13} className="text-[#A9825A] shrink-0" />
                {TEMPLATE_IMPORT_TIP}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Guide icon={<FileText size={14} />} title="Word">
                Each heading (Heading 1, 2… or a bold line) starts a template and the text below it is the message. A heading such as “Email scripts” with nothing under it sets the type of the templates that follow.
              </Guide>
              <Guide icon={<FileSpreadsheet size={14} />} title="Excel & CSV">
                One row per template with columns Type | Name | Message — a header row helps. One column per channel (Name | WhatsApp | Email) works too; every visible sheet with such a header is read.
              </Guide>
              <Guide icon={<TypeIcon size={14} />} title="Text & merge fields">
                {'Leave a blank line between templates; a short first line becomes the name. Merge fields such as {{customer name}}, [Name] or <RM> become {name}, {rm} and {unit}.'}
              </Guide>
            </div>
          </>
        )}

        {phase === 'reading' && (
          <div className="flex items-center justify-center gap-3 py-12 text-[#A9825A] font-semibold">
            <Loader2 size={18} className="animate-spin" />
            <span>Reading “{file?.name}” and looking for templates…</span>
          </div>
        )}

        {phase === 'review' && file && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-white border border-[#D2C9BF]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-[#F4F0EB] text-[#A9825A] flex items-center justify-center shrink-0">
                  {file.format === 'xlsx' || file.format === 'csv' ? <FileSpreadsheet size={16} /> : <FileText size={16} />}
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[#1D2F3F] truncate">{file.name}</div>
                  <div className="text-[11px] text-[#6B5F57]">
                    {file.format ? `${FORMAT_LABEL[file.format]} file · ` : ''}
                    {plural(file.found ?? rows.length, 'template')} found{added > 0 && ` · ${added} added`} · {Math.max(1, Math.round(file.size / 1024))} KB
                  </div>
                </div>
              </div>
              <Button variant="secondary" icon={<Upload size={13} />} disabled={importing} onClick={chooseAnother}>
                Different file
              </Button>
            </div>

            {warnings.length > 0 && (
              <InlineNotice tone="info">
                <ul className="space-y-0.5">
                  {warnings.map((w) => (
                    <li key={w} className="flex items-start gap-1.5">
                      <Info size={12} className="mt-0.5 shrink-0 text-[#A9825A]" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </InlineNotice>
            )}

            {importing && <Bar value={progress.done} max={progress.total} color="#7C8B78" />}

            <div className="bg-white rounded-xl border border-[#D2C9BF] shadow-xs overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-b border-[#D2C9BF] bg-[#FDFCFA]">
                <label className={cx('inline-flex items-center gap-2 font-semibold text-[#1D2F3F] select-none', selectable.length && !importing ? 'cursor-pointer' : 'opacity-60')}>
                  <input ref={selectAllRef} type="checkbox" className="w-3.5 h-3.5 accent-[#1D2F3F]" checked={allChosen} onChange={toggleAll} disabled={!selectable.length || importing} />
                  Select all
                </label>
                <span className="text-[11px] text-[#6B5F57]">Adjust a type or name before adding · untick anything you don’t need</span>
              </div>
              <div className="overflow-auto max-h-[52vh]">
                <table className="w-full min-w-[760px] text-left border-collapse">
                  <thead className="bg-[#EDE8E0] text-[#6B5F57] text-[10px] font-bold uppercase tracking-wider sticky top-0 z-10">
                    <tr>
                      <th className="py-2.5 px-3 w-10">
                        <span className="sr-only">Include</span>
                      </th>
                      <th className="py-2.5 px-2 w-40">Type</th>
                      <th className="py-2.5 px-2 w-64">Name</th>
                      <th className="py-2.5 px-3">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#ECE8E1]">
                    {rows.map((r) => {
                      const exists = existingKeys.has(templateFingerprint(r.name, r.message));
                      const nameMissing = !r.name.trim();
                      const canTick = !exists && !nameMissing;
                      return (
                        <tr key={r.key} className={cx('align-top transition', exists && 'bg-[#F4F0EB]/60', r.failed && 'bg-[#FAF0EC]/70', canTick && !r.selected && 'opacity-70')}>
                          <td className="py-3 px-3">
                            <input
                              type="checkbox"
                              className="w-3.5 h-3.5 mt-1.5 accent-[#1D2F3F]"
                              checked={canTick && r.selected}
                              disabled={!canTick || importing}
                              onChange={() => updateRow(r.key, { selected: !r.selected })}
                              aria-label={`Include ${r.name || 'template'}`}
                              title={exists ? 'A template with this name and message already exists' : nameMissing ? 'Give the template a name first' : undefined}
                            />
                          </td>
                          <td className="py-2.5 px-2">
                            <Select value={r.type} options={typeOptions} disabled={importing} onChange={(e) => updateRow(r.key, { type: e.target.value })} aria-label="Type" className="py-1.5" />
                          </td>
                          <td className="py-2.5 px-2">
                            <input
                              className={cx(inputCls, 'py-1.5', nameMissing && 'border-[#B06A55]')}
                              value={r.name}
                              maxLength={MAX_TEMPLATE_NAME_LENGTH}
                              disabled={importing}
                              placeholder="Template name"
                              aria-label="Template name"
                              onChange={(e) => updateRow(r.key, { name: e.target.value })}
                            />
                            <div className="text-[10px] mt-1 truncate" title={r.source}>
                              {nameMissing ? <span className="text-[#8A3E28] font-semibold">Name required</span> : <span className="text-[#9E948D]">{r.source}</span>}
                            </div>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className={cx('whitespace-pre-wrap break-words leading-relaxed text-[#3D3530]', !r.expanded && 'line-clamp-4')}>{r.message}</div>
                            {isLong(r.message) && (
                              <button type="button" className="mt-1 text-[11px] font-semibold text-[#A9825A] hover:text-[#1D2F3F]" onClick={() => updateRow(r.key, { expanded: !r.expanded })}>
                                {r.expanded ? 'Show less' : 'Show all'}
                              </button>
                            )}
                            {(exists || r.failed || r.notes?.length) && (
                              <div className="mt-1.5 space-y-1">
                                {(exists || r.failed) && (
                                  <div className="flex flex-wrap gap-1.5">
                                    {exists && <Badge tone="muted">Already saved</Badge>}
                                    {r.failed && <Badge tone="rust">Not saved — retry</Badge>}
                                  </div>
                                )}
                                {r.notes?.map((note) => (
                                  <div key={note} className="flex items-start gap-1 text-[10px] text-amber-800">
                                    <AlertTriangle size={11} className="mt-px shrink-0" />
                                    <span>{note}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

const Guide: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <div className="p-3.5 rounded-xl bg-white border border-[#D2C9BF]">
    <div className="flex items-center gap-1.5 font-bold text-[#1D2F3F] mb-1">
      <span className="text-[#A9825A]">{icon}</span>
      {title}
    </div>
    <p className="text-[11px] text-[#6B5F57] leading-relaxed">{children}</p>
  </div>
);
