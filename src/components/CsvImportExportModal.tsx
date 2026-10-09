/**
 * CSV Import & Export — the server performs the import; this modal only analyses the file,
 * previews the column mapping / conflicts / notes, and sends the rows with the chosen strategy.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eye,
  FileDown,
  FileSpreadsheet,
  Loader2,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { Lead } from '../types/crm';
import { F, STAGES } from '../core/config';
import { formatDateTime } from '../core/dates';
import { Badge, Button, InlineNotice, Modal, Tabs, cx, inputCls, labelCls } from './ui';
import {
  CSVParseResult,
  CSVRowPreview,
  ConflictResolutionStrategy,
  IMPORT_STRATEGIES,
  collectExportHeaders,
  downloadSampleTemplate,
  exportLeadsToCSV,
  parseAndAnalyzeCSV,
} from '../services/csvService';
import { sound } from '../services/sound';

interface CsvImportExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  leads: Lead[];
  onImport: (leads: Lead[], strategy: string) => Promise<{ created: number; updated: number } | null>;
  canImport: boolean;
}

type TabId = 'import' | 'export';
type PreviewFilter = 'ALL' | 'NEW' | 'UPDATE' | 'DUPLICATE' | 'WARNINGS';

interface ImportOutcome {
  created: number;
  updated: number;
  skipped: number;
  sent: number;
  strategy: ConflictResolutionStrategy;
  fileName: string;
}

const DEFAULT_STRATEGY: ConflictResolutionStrategy = 'SKIP';

const statusTone = (s: CSVRowPreview['status']) => (s === 'NEW' ? 'sage' : s === 'UPDATE' ? 'amber' : 'rust');
const statusLabel = (row: CSVRowPreview) =>
  row.status === 'NEW' ? 'New lead' : row.status === 'UPDATE' ? `Matches ${row.matchedExisting?.[F.ID] || 'existing'}` : `Duplicate of row ${row.duplicateOfRow}`;

const confidenceLabel = { EXACT: 'Exact', FUZZY: 'Matched', NONE: 'Not in file' } as const;

export const CsvImportExportModal: React.FC<CsvImportExportModalProps> = ({ isOpen, onClose, leads, onImport, canImport }) => {
  const [activeTab, setActiveTab] = useState<TabId>(canImport ? 'import' : 'export');

  // Import — file & analysis
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [isParsing, setIsParsing] = useState(false);
  const [parseResult, setParseResult] = useState<CSVParseResult | null>(null);
  const [strategy, setStrategy] = useState<ConflictResolutionStrategy>(DEFAULT_STRATEGY);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [dragging, setDragging] = useState(false);
  const [inputKey, setInputKey] = useState(0); // remounts the file input so the same file can be chosen again
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Preview controls
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>('ALL');
  const [previewSearch, setPreviewSearch] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [showMapping, setShowMapping] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [sampleLimit, setSampleLimit] = useState(10);

  const resetFileState = useCallback(() => {
    setFileName('');
    setFileSize(0);
    setIsParsing(false);
    setParseResult(null);
    setStrategy(DEFAULT_STRATEGY);
    setErrorMessage(null);
    setDragging(false);
    setPreviewFilter('ALL');
    setPreviewSearch('');
    setSelectedRowIndex(null);
    setShowMapping(false);
    setShowErrors(false);
    setSampleLimit(10);
    setInputKey((k) => k + 1);
  }, []);

  const resetAll = useCallback(() => {
    resetFileState();
    setOutcome(null);
    setIsImporting(false);
    setActiveTab(canImport ? 'import' : 'export');
  }, [resetFileState, canImport]);

  // Reset everything whenever the modal closes (App unmounts it, but keep the guarantee).
  useEffect(() => {
    if (!isOpen) resetAll();
  }, [isOpen, resetAll]);

  // Users without import rights only ever see the export tab.
  useEffect(() => {
    if (!canImport && activeTab === 'import') setActiveTab('export');
  }, [canImport, activeTab]);

  const handleClose = useCallback(() => {
    if (isImporting) return;
    resetAll();
    onClose();
  }, [isImporting, resetAll, onClose]);

  const handleFile = useCallback(
    async (file: File) => {
      resetFileState();
      setOutcome(null);
      setFileName(file.name);
      setFileSize(file.size);
      setIsParsing(true);
      try {
        const text = await file.text();
        const result = parseAndAnalyzeCSV(text, leads);
        setParseResult(result);
        if (!result.previewRows.length) setErrorMessage(result.errors[0] || 'No importable rows were found in this file.');
      } catch (err: any) {
        setErrorMessage(err?.message || 'Could not read this file. Please make sure it is a valid CSV.');
      } finally {
        setIsParsing(false);
      }
    },
    [leads, resetFileState]
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };
  const openFilePicker = () => {
    if (!isImporting) fileInputRef.current?.click();
  };

  const handleExecuteImport = async () => {
    if (!parseResult || !parseResult.validLeads.length || isImporting) return;
    setIsImporting(true);
    setErrorMessage(null);
    let res: { created: number; updated: number } | null = null;
    try {
      res = await onImport(parseResult.validLeads, strategy);
    } catch {
      res = null;
    }
    setIsImporting(false);
    if (!res) {
      setErrorMessage('The import did not complete — see the notification for details. Your preview is still here: fix the file or try again.');
      return;
    }
    setOutcome({
      created: res.created,
      updated: res.updated,
      skipped: strategy === 'SKIP' ? parseResult.conflicts.length : 0,
      sent: parseResult.validLeads.length,
      strategy,
      fileName,
    });
    resetFileState();
    sound.playSuccess();
    try {
      confetti({ particleCount: 70, spread: 60, origin: { y: 0.6 } });
    } catch {
      /* decorative only */
    }
  };

  /* ------------------------------ derived ------------------------------- */

  const exportHeaders = useMemo(() => collectExportHeaders(leads), [leads]);
  const exportFollowupCount = useMemo(() => exportHeaders.filter((h) => /^Follow-up \d+$/.test(h)).length, [exportHeaders]);

  const warningsCount = useMemo(() => parseResult?.previewRows.filter((r) => r.warnings.length > 0).length || 0, [parseResult]);
  const mappedCount = useMemo(() => parseResult?.columnMappings.filter((m) => m.confidence !== 'NONE').length || 0, [parseResult]);

  const filteredRows = useMemo(() => {
    const rows = parseResult?.previewRows || [];
    const q = previewSearch.trim().toLowerCase();
    return rows.filter((row) => {
      if (previewFilter === 'NEW' && row.status !== 'NEW') return false;
      if (previewFilter === 'UPDATE' && row.status !== 'UPDATE') return false;
      if (previewFilter === 'DUPLICATE' && row.status !== 'DUPLICATE') return false;
      if (previewFilter === 'WARNINGS' && row.warnings.length === 0) return false;
      if (!q) return true;
      return [row.lead[F.NAME], row.lead[F.PHONE], row.lead[F.EMAIL], row.lead[F.STAGE], row.lead[F.ID]].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [parseResult, previewFilter, previewSearch]);

  const displayedRows = useMemo(() => filteredRows.slice(0, sampleLimit), [filteredRows, sampleLimit]);
  const selectedRow = useMemo(() => parseResult?.previewRows.find((r) => r.rowIndex === selectedRowIndex) || null, [parseResult, selectedRowIndex]);

  if (!isOpen) return null;

  const tabs: Array<{ id: TabId; label: React.ReactNode; icon?: React.ReactNode; badge?: React.ReactNode }> = [
    ...(canImport ? [{ id: 'import' as TabId, label: 'Import CSV', icon: <Upload size={13} /> }] : []),
    { id: 'export', label: 'Export', icon: <Download size={13} />, badge: leads.length },
  ];

  const readyToImport = !!parseResult && parseResult.validLeads.length > 0 && !outcome;
  const conflictVerb = strategy === 'SKIP' ? 'skipped' : strategy === 'OVERWRITE' ? 'updated' : 'created as copies';

  const footer = readyToImport ? (
    <>
      <div className="mr-auto text-xs text-[#0F2233] min-w-0">
        <div className="font-bold text-[#0B2A44] flex items-center gap-1.5">
          <CheckCircle2 size={14} className="text-[#0E8A86]" />
          <span>{parseResult!.validLeads.length} record{parseResult!.validLeads.length === 1 ? '' : 's'} ready</span>
        </div>
        <div className="text-[11px] text-[#5E778C] mt-0.5">
          {parseResult!.brandNewLeads.length} to create
          {parseResult!.conflicts.length > 0 && ` · ${parseResult!.conflicts.length} matching existing → ${conflictVerb}`}
          {parseResult!.inFileDuplicates.length > 0 && ` · ${parseResult!.inFileDuplicates.length} in-file duplicate${parseResult!.inFileDuplicates.length === 1 ? '' : 's'} left out`}
        </div>
      </div>
      <Button variant="ghost" onClick={resetFileState} disabled={isImporting}>Cancel</Button>
      <Button variant="primary" onClick={handleExecuteImport} loading={isImporting} icon={<Upload size={13} />}>
        {isImporting ? 'Importing…' : `Import ${parseResult!.validLeads.length} record${parseResult!.validLeads.length === 1 ? '' : 's'}`}
      </Button>
    </>
  ) : (
    <Button variant="secondary" onClick={handleClose} disabled={isImporting}>Close</Button>
  );

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      width="xl"
      title={
        <span className="inline-flex items-center gap-2">
          <FileSpreadsheet size={18} className="text-[#0B6BB0]" />
          CSV Import & Export
        </span>
      }
      subtitle="Preview the column mapping, duplicates and formatting notes before anything is written. The server assigns Enquiry IDs."
      footer={footer}
    >
      <div className="space-y-4 text-xs">
        <Tabs tabs={tabs} value={activeTab} onChange={(t) => !isImporting && setActiveTab(t)} />

        {errorMessage && (
          <InlineNotice tone="warning" className="flex items-start justify-between gap-3">
            <span className="inline-flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </span>
            <button onClick={() => setErrorMessage(null)} className="text-amber-900/60 hover:text-amber-900" aria-label="Dismiss"><X size={14} /></button>
          </InlineNotice>
        )}

        {/* ------------------------------ EXPORT ------------------------------ */}
        {activeTab === 'export' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="bg-white p-5 rounded-xl border border-[#D3E3F0] shadow-xs space-y-3">
              <div>
                <span className={labelCls}>Full database export</span>
                <h4 className="text-base font-bold text-[#0B2A44]">All leads as CSV</h4>
              </div>
              <p className="text-[#5E778C] leading-relaxed">
                Exports every lead with all {exportHeaders.length} columns present in the data
                {exportFollowupCount > 0 && <> — including {exportFollowupCount} Follow-up column{exportFollowupCount === 1 ? '' : 's'}</>}.
                Dates are written as “01 Oct 2026, 05:30 PM” and the file is UTF-8 with BOM so Excel opens it correctly.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="primary" size="md" icon={<Download size={14} />} disabled={!leads.length} onClick={() => exportLeadsToCSV(leads)}>
                  Download {leads.length} lead{leads.length === 1 ? '' : 's'}
                </Button>
                {!leads.length && <span className="text-[#7E93A6]">No leads to export yet.</span>}
              </div>
            </section>

            <section className="bg-white p-5 rounded-xl border border-[#D3E3F0] shadow-xs space-y-3">
              <div>
                <span className={labelCls}>Import template</span>
                <h4 className="text-base font-bold text-[#0B2A44]">Sample CSV with the expected columns</h4>
              </div>
              <p className="text-[#5E778C] leading-relaxed">
                Three sample rows using the configured stages, sources and unit types. Leave <strong>{F.ID}</strong> blank — the CRM assigns it. Only <strong>{F.NAME}</strong> is required; dates may be dd/MM/yyyy, yyyy-MM-dd HH:mm or the CRM display format.
              </p>
              <div className="pt-1">
                <Button variant="secondary" size="md" icon={<FileDown size={14} />} onClick={() => downloadSampleTemplate()}>Download template</Button>
              </div>
            </section>
          </div>
        )}

        {/* ------------------------------ IMPORT ------------------------------ */}
        {activeTab === 'import' && canImport && (
          <div className="space-y-4">
            <input ref={fileInputRef} key={inputKey} type="file" accept=".csv,text/csv,text/plain" onChange={onFileInput} className="hidden" />

            {/* Result of the last import */}
            {outcome && (
              <section className="bg-white p-5 rounded-xl border border-[#0E8A86]/50 shadow-xs space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#0E8A86]/15 text-[#3C573A] flex items-center justify-center shrink-0"><CheckCircle2 size={20} /></div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-base font-bold text-[#0B2A44]">Import complete</h4>
                    <p className="text-[#5E778C] mt-0.5 truncate">{outcome.fileName} · {outcome.sent} record{outcome.sent === 1 ? '' : 's'} sent · {IMPORT_STRATEGIES.find((s) => s.id === outcome.strategy)?.label}</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Metric label="Created" value={outcome.created} tone="sage" />
                  <Metric label="Updated" value={outcome.updated} tone="gold" />
                  <Metric label="Skipped" value={outcome.skipped} hint={outcome.skipped ? 'Matched existing leads' : undefined} />
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button variant="secondary" icon={<Upload size={13} />} onClick={openFilePicker}>Import another file</Button>
                  <Button variant="primary" onClick={handleClose}>Done</Button>
                </div>
              </section>
            )}

            {/* Drop zone */}
            {!outcome && !parseResult && !isParsing && (
              <div
                role="button"
                tabIndex={0}
                onClick={openFilePicker}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFilePicker(); } }}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
                className={cx('block border-2 border-dashed rounded-xl p-8 text-center transition cursor-pointer focus:outline-none focus:border-[#0B6BB0]', dragging ? 'border-[#0B6BB0] bg-[#F2F7FB]' : 'border-[#A9BDCD] bg-[#F2F7FB]/50 hover:bg-[#F2F7FB]')}
              >
                <Upload size={28} className="mx-auto text-[#0B6BB0] mb-2.5" />
                <span className="text-base font-bold text-[#0B2A44] block mb-1.5">Choose a CSV file, or drop it here</span>
                <p className="text-[#5E778C] max-w-md mx-auto mb-4 leading-relaxed">
                  We parse the headers, map them to CRM fields, normalise dates and stages, and flag duplicates — nothing is written until you confirm.
                </p>
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white border border-[#D3E3F0] text-[#0B2A44] text-[11px] font-semibold">
                  <FileDown size={13} className="text-[#0B6BB0]" />
                  Need the format? Use the template on the Export tab
                </span>
              </div>
            )}

            {isParsing && (
              <div className="flex items-center justify-center gap-3 py-10 text-[#0B6BB0] font-semibold">
                <Loader2 size={18} className="animate-spin" />
                <span>Reading columns, matching CRM fields and checking for duplicates…</span>
              </div>
            )}

            {parseResult && !isParsing && (
              <div className="space-y-4">
                {/* File bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-white border border-[#D3E3F0]">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-[#F2F7FB] text-[#0B2A44] flex items-center justify-center font-mono font-bold text-[10px] shrink-0">CSV</div>
                    <div className="min-w-0">
                      <div className="font-bold text-[#0B2A44] truncate">{fileName || 'Uploaded file'}</div>
                      <div className="text-[11px] text-[#5E778C]">
                        {parseResult.totalRowsParsed} data row{parseResult.totalRowsParsed === 1 ? '' : 's'} · {parseResult.detectedHeaders.length} columns · {fileSize ? `${Math.max(1, Math.round(fileSize / 1024))} KB` : '—'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" icon={<Upload size={13} />} disabled={isImporting} onClick={openFilePicker}>Different file</Button>
                    <Button variant="ghost" onClick={resetFileState} disabled={isImporting}>Clear</Button>
                  </div>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <Metric label="To import" value={parseResult.validLeads.length} hint={`from ${parseResult.totalRowsParsed} rows`} />
                  <Metric label="New leads" value={parseResult.brandNewLeads.length} tone="sage" hint="IDs assigned by the server" />
                  <Metric label="Match existing" value={parseResult.conflicts.length} tone="gold" hint="By Enquiry ID or phone" />
                  <Metric label="In-file duplicates" value={parseResult.inFileDuplicates.length} tone={parseResult.inFileDuplicates.length ? 'rust' : undefined} hint={parseResult.inFileDuplicates.length ? 'Left out' : 'None'} />
                  <Metric label="Notes" value={warningsCount} tone={warningsCount ? 'amber' : undefined} hint={warningsCount ? 'Rows to glance at' : 'All clean'} />
                </div>

                {parseResult.unknownStages.length > 0 && (
                  <InlineNotice tone="warning">
                    <strong>Unrecognised stage{parseResult.unknownStages.length === 1 ? '' : 's'}:</strong> {parseResult.unknownStages.join(', ')}. These rows are imported as typed and will not be counted in pipeline KPIs. Configured stages: {Object.values(STAGES).filter((s) => s !== STAGES.DELETED).join(', ')}.
                  </InlineNotice>
                )}

                {parseResult.errors.length > 0 && (
                  <InlineNotice tone="info">
                    <button onClick={() => setShowErrors(!showErrors)} className="font-semibold inline-flex items-center gap-1 hover:underline">
                      {parseResult.errors.length} row{parseResult.errors.length === 1 ? '' : 's'} skipped {showErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {showErrors && (
                      <ul className="mt-1.5 space-y-0.5 list-disc pl-4 text-[11px]">
                        {parseResult.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                        {parseResult.errors.length > 20 && <li>…and {parseResult.errors.length - 20} more</li>}
                      </ul>
                    )}
                  </InlineNotice>
                )}

                {/* Column mapping */}
                <div className="bg-white rounded-xl border border-[#D3E3F0] overflow-hidden">
                  <button onClick={() => setShowMapping(!showMapping)} className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-[#F2F7FB]/50 transition">
                    <span className="flex items-center gap-2">
                      <SlidersHorizontal size={14} className="text-[#0B6BB0]" />
                      <span className="font-semibold text-[#0B2A44]">Column mapping</span>
                      <span className="text-[11px] text-[#5E778C]">
                        {mappedCount} of {parseResult.columnMappings.length} CRM fields found
                        {parseResult.followupColumns.length > 0 && ` · ${parseResult.followupColumns.length} follow-up column${parseResult.followupColumns.length === 1 ? '' : 's'}`}
                        {parseResult.unmappedHeaders.length > 0 && ` · ${parseResult.unmappedHeaders.length} ignored`}
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-[#0B6BB0] font-semibold">{showMapping ? 'Hide' : 'Show'}{showMapping ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                  </button>
                  {showMapping && (
                    <div className="p-4 border-t border-[#D3E3F0] bg-[#FFFFFF] space-y-3">
                      <p className="text-[11px] text-[#5E778C]">
                        Each CSV column feeds at most one CRM field. Fields that are not in the file stay blank — no defaults are invented, so an overwrite never erases existing data.
                      </p>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {parseResult.columnMappings.map((m) => (
                          <div key={m.crmField} className={cx('p-2 rounded-lg border text-[11px]', m.confidence === 'NONE' ? 'bg-[#F2F7FB]/60 border-[#E6EFF6]' : 'bg-white border-[#D3E3F0]/80')}>
                            <span className="font-semibold text-[#0B2A44] block truncate">{m.crmField}</span>
                            <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                              <span className="font-mono text-[#5E778C] truncate">{m.csvHeader ? `← ${m.csvHeader}` : '—'}</span>
                              <span className={cx('font-semibold shrink-0', m.confidence === 'EXACT' ? 'text-[#3C573A]' : m.confidence === 'FUZZY' ? 'text-[#0B5E9C]' : 'text-[#7E93A6]')}>{confidenceLabel[m.confidence]}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {parseResult.followupColumns.length > 0 && (
                        <div className="text-[11px] text-[#5E778C]"><span className="font-semibold text-[#0F2233]">Follow-up columns: </span><span className="font-mono text-[10px]">{parseResult.followupColumns.join(', ')}</span></div>
                      )}
                      {parseResult.unmappedHeaders.length > 0 && (
                        <div className="text-[11px] text-[#5E778C]"><span className="font-semibold text-[#0F2233]">Ignored columns: </span><span className="font-mono text-[10px]">{parseResult.unmappedHeaders.join(', ')}</span></div>
                      )}
                    </div>
                  )}
                </div>

                {/* Preview table */}
                <div className="bg-white rounded-xl border border-[#D3E3F0] shadow-xs overflow-hidden">
                  <div className="p-3 border-b border-[#D3E3F0] bg-[#FFFFFF] flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5 overflow-x-auto">
                      <FilterChip active={previewFilter === 'ALL'} onClick={() => setPreviewFilter('ALL')}>All ({parseResult.previewRows.length})</FilterChip>
                      <FilterChip active={previewFilter === 'NEW'} onClick={() => setPreviewFilter('NEW')} activeCls="bg-[#0E8A86] text-white">New ({parseResult.brandNewLeads.length})</FilterChip>
                      <FilterChip active={previewFilter === 'UPDATE'} onClick={() => setPreviewFilter('UPDATE')} activeCls="bg-[#0B6BB0] text-white">Matches ({parseResult.conflicts.length})</FilterChip>
                      {parseResult.inFileDuplicates.length > 0 && (
                        <FilterChip active={previewFilter === 'DUPLICATE'} onClick={() => setPreviewFilter('DUPLICATE')} activeCls="bg-[#B06A55] text-white">Duplicates ({parseResult.inFileDuplicates.length})</FilterChip>
                      )}
                      {warningsCount > 0 && (
                        <FilterChip active={previewFilter === 'WARNINGS'} onClick={() => setPreviewFilter('WARNINGS')} activeCls="bg-amber-700 text-white">Notes ({warningsCount})</FilterChip>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#7E93A6]" />
                        <input type="text" value={previewSearch} onChange={(e) => setPreviewSearch(e.target.value)} placeholder="Search rows…" className={cx(inputCls, 'pl-7 py-1.5 w-40 sm:w-48')} />
                      </div>
                      <select value={sampleLimit} onChange={(e) => setSampleLimit(Number(e.target.value))} className={cx(inputCls, 'py-1.5 w-auto')}>
                        <option value={10}>Show 10</option>
                        <option value={25}>Show 25</option>
                        <option value={100}>Show 100</option>
                        <option value={100000}>Show all</option>
                      </select>
                    </div>
                  </div>

                  <div className="overflow-x-auto max-h-80">
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-[#E6EFF6] text-[#5E778C] text-[10px] font-bold uppercase tracking-wider sticky top-0 z-10 border-b border-[#D3E3F0]">
                        <tr>
                          <th className="py-2.5 px-3 w-12 text-center">Row</th>
                          <th className="py-2.5 px-3">Action</th>
                          <th className="py-2.5 px-3">Prospect</th>
                          <th className="py-2.5 px-3">Phone</th>
                          <th className="py-2.5 px-3">Email</th>
                          <th className="py-2.5 px-3">Stage</th>
                          <th className="py-2.5 px-3">Unit</th>
                          <th className="py-2.5 px-3">Source</th>
                          <th className="py-2.5 px-3">Enquiry date</th>
                          <th className="py-2.5 px-3 text-center">Checks</th>
                          <th className="py-2.5 px-3 text-right">Raw</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E6EFF6]">
                        {displayedRows.length === 0 ? (
                          <tr><td colSpan={11} className="py-8 text-center text-[#7E93A6]">No rows match this filter.</td></tr>
                        ) : (
                          displayedRows.map((row) => {
                            const selected = selectedRowIndex === row.rowIndex;
                            return (
                              <tr key={row.rowIndex} className={cx('transition hover:bg-[#F2F7FB]/60', selected && 'bg-[#F2F7FB]', row.status === 'DUPLICATE' && 'opacity-70')}>
                                <td className="py-2 px-3 font-mono text-[11px] text-[#5E778C] text-center">#{row.rowIndex}</td>
                                <td className="py-2 px-3 whitespace-nowrap"><Badge tone={statusTone(row.status)}>{statusLabel(row)}</Badge></td>
                                <td className="py-2 px-3 font-semibold text-[#0B2A44] whitespace-nowrap">{row.lead[F.NAME]}</td>
                                <td className="py-2 px-3 font-mono text-[11px] text-[#0F2233] whitespace-nowrap">{row.lead[F.PHONE] || <span className="text-[#B06A55] italic">missing</span>}</td>
                                <td className="py-2 px-3 text-[#5E778C] truncate max-w-[160px]">{row.lead[F.EMAIL] || <span className="text-[#7E93A6]">—</span>}</td>
                                <td className="py-2 px-3 whitespace-nowrap">
                                  {row.lead[F.STAGE] ? (
                                    <span className={cx('inline-flex items-center gap-1.5', row.unknownStage && 'text-amber-800')} title={row.unknownStage ? 'Not a configured stage' : undefined}>
                                      {row.unknownStage && <AlertTriangle size={11} />}
                                      {row.lead[F.STAGE]}
                                    </span>
                                  ) : (
                                    <span className="text-[#7E93A6]">{row.status === 'UPDATE' ? 'unchanged' : `${STAGES.NEW} (default)`}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-[#0F2233] whitespace-nowrap">{row.lead[F.UNIT_TYPE] || <span className="text-[#7E93A6]">—</span>}</td>
                                <td className="py-2 px-3 text-[#5E778C] whitespace-nowrap">{row.lead[F.SOURCE] || <span className="text-[#7E93A6]">—</span>}</td>
                                <td className="py-2 px-3 text-[#5E778C] whitespace-nowrap">{formatDateTime(row.lead[F.ENQUIRY_DATE]) || <span className="text-[#7E93A6]">{row.status === 'NEW' ? 'now (server)' : '—'}</span>}</td>
                                <td className="py-2 px-3 text-center whitespace-nowrap">
                                  {row.warnings.length === 0 ? (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-[#3C573A] font-semibold" title="All checks passed"><CheckCircle2 size={13} />Ready</span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-800 font-semibold cursor-help" title={row.warnings.join(' • ')}><AlertTriangle size={13} />{row.warnings.length} note{row.warnings.length === 1 ? '' : 's'}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-right whitespace-nowrap">
                                  <button onClick={() => setSelectedRowIndex(selected ? null : row.rowIndex)} className="p-1 rounded-md hover:bg-[#E6EFF6] text-[#0B6BB0] hover:text-[#0B2A44] transition" title="Inspect raw values vs mapped fields"><Eye size={14} /></button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="p-2.5 border-t border-[#D3E3F0] bg-[#FFFFFF] text-[11px] text-[#5E778C] flex items-center justify-between gap-2">
                    <span>Showing {displayedRows.length} of {filteredRows.length} rows{previewSearch && ` matching “${previewSearch}”`}</span>
                    <span className="text-[10px] text-[#7E93A6] hidden sm:inline">Use the eye icon to compare a row with the original CSV values</span>
                  </div>
                </div>

                {/* Inspector */}
                {selectedRow && (
                  <div className="bg-[#E6EFF6]/70 p-4 rounded-xl border border-[#D3E3F0] space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-[#0B2A44] text-sm">Row #{selectedRow.rowIndex}</span>
                        <span className="font-semibold text-[#0B2A44]">{selectedRow.lead[F.NAME]}</span>
                        <Badge tone={statusTone(selectedRow.status)}>{statusLabel(selectedRow)}{selectedRow.conflictReason ? ` · ${selectedRow.conflictReason === 'ID_MATCH' ? 'same Enquiry ID' : 'same phone'}` : ''}</Badge>
                      </div>
                      <button onClick={() => setSelectedRowIndex(null)} className="text-[#5E778C] hover:text-[#0B2A44]" aria-label="Close inspector"><X size={15} /></button>
                    </div>
                    {selectedRow.warnings.length > 0 && (
                      <InlineNotice tone="warning">
                        <strong>Notes: </strong>{selectedRow.warnings.join(' • ')}
                      </InlineNotice>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="bg-white p-3 rounded-lg border border-[#D3E3F0]">
                        <span className={cx(labelCls, 'border-b border-[#D3E3F0] pb-1 mb-2')}>Mapped CRM record</span>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                          {[
                            [F.ID, selectedRow.lead[F.ID] || (selectedRow.status === 'UPDATE' ? selectedRow.matchedExisting?.[F.ID] : 'assigned on import')],
                            [F.NAME, selectedRow.lead[F.NAME]],
                            [F.PHONE, selectedRow.lead[F.PHONE]],
                            [F.EMAIL, selectedRow.lead[F.EMAIL]],
                            [F.STAGE, selectedRow.lead[F.STAGE]],
                            [F.SOURCE, selectedRow.lead[F.SOURCE]],
                            [F.UNIT_TYPE, selectedRow.lead[F.UNIT_TYPE]],
                            [F.PURCHASE_OR_RENT, selectedRow.lead[F.PURCHASE_OR_RENT]],
                            [F.SITE_VISIT_STATUS, selectedRow.lead[F.SITE_VISIT_STATUS]],
                            [F.RM, selectedRow.lead[F.RM]],
                            [F.ENQUIRY_DATE, formatDateTime(selectedRow.lead[F.ENQUIRY_DATE])],
                            [F.NEXT_FOLLOWUP, formatDateTime(selectedRow.lead[F.NEXT_FOLLOWUP])],
                            [F.LAST_FOLLOWUP, formatDateTime(selectedRow.lead[F.LAST_FOLLOWUP])],
                            [F.NOTES, selectedRow.lead[F.NOTES]],
                          ].map(([k, v]) => (
                            <React.Fragment key={k as string}>
                              <dt className="text-[#5E778C]">{k}</dt>
                              <dd className="text-[#0B2A44] font-medium break-words whitespace-pre-wrap">{v || <span className="text-[#7E93A6] italic">blank</span>}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      </div>
                      <div className="bg-white p-3 rounded-lg border border-[#D3E3F0] max-h-64 overflow-y-auto">
                        <span className={cx(labelCls, 'border-b border-[#D3E3F0] pb-1 mb-2')}>Original CSV values</span>
                        <div className="space-y-1 font-mono text-[10px]">
                          {Object.entries(selectedRow.raw).map(([key, val]) => (
                            <div key={key} className="flex items-start justify-between gap-2 border-b border-[#F2F7FB] py-0.5">
                              <span className="text-[#5E778C] truncate max-w-[45%]">{key}</span>
                              <span className="text-[#0B2A44] text-right font-medium break-all whitespace-pre-wrap">{val || <span className="text-[#7E93A6] italic">empty</span>}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    {selectedRow.matchedExisting && (
                      <div className="bg-white p-3 rounded-lg border border-[#D3E3F0] text-[11px]">
                        <span className={cx(labelCls, 'mb-1')}>Existing CRM record it matches</span>
                        <span className="text-[#0B2A44] font-semibold">{selectedRow.matchedExisting[F.ID]}</span> · {selectedRow.matchedExisting[F.NAME]} · {selectedRow.matchedExisting[F.PHONE]} · {selectedRow.matchedExisting[F.STAGE]}
                        {selectedRow.matchedExisting[F.RM] && <> · RM {selectedRow.matchedExisting[F.RM]}</>}
                      </div>
                    )}
                  </div>
                )}

                {/* Strategy */}
                {parseResult.conflicts.length > 0 ? (
                  <div className="bg-white p-4 rounded-xl border border-[#D3E3F0] space-y-2.5">
                    <div className="flex items-center gap-2">
                      <Copy size={14} className="text-[#0B6BB0]" />
                      <span className="font-bold text-[#0B2A44] text-sm">{parseResult.conflicts.length} row{parseResult.conflicts.length === 1 ? '' : 's'} match existing leads — what should happen?</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                      {IMPORT_STRATEGIES.map((s) => (
                        <label key={s.id} className={cx('p-3 rounded-xl border cursor-pointer transition', strategy === s.id ? 'border-[#0B6BB0] bg-[#F2F7FB]/60 shadow-xs' : 'border-[#D3E3F0] hover:bg-[#F2F7FB]/30')}>
                          <div className="flex items-start gap-2.5">
                            <input type="radio" name="conflictStrategy" value={s.id} checked={strategy === s.id} onChange={() => setStrategy(s.id)} className="mt-0.5 accent-[#0B2A44]" disabled={isImporting} />
                            <div>
                              <div className="font-bold text-[#0B2A44]">{s.label}</div>
                              <div className="text-[11px] text-[#5E778C] mt-0.5 leading-relaxed">{s.description}</div>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : parseResult.validLeads.length > 0 ? (
                  <InlineNotice tone="success">No row matches an existing lead — all {parseResult.validLeads.length} will be created as new enquiries.</InlineNotice>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

/* ------------------------------ bits ---------------------------------- */

const Metric: React.FC<{ label: string; value: number; hint?: string; tone?: 'sage' | 'gold' | 'rust' | 'amber' }> = ({ label, value, hint, tone }) => {
  const tones = {
    sage: 'bg-[#0E8A86]/10 border-[#0E8A86]/40 text-[#3C573A]',
    gold: 'bg-[#0B6BB0]/10 border-[#0B6BB0]/40 text-[#0B5E9C]',
    rust: 'bg-[#FAF0EC] border-[#B06A55]/40 text-[#8A3E28]',
    amber: 'bg-[#FFF8E1] border-amber-300 text-[#92400E]',
  };
  return (
    <div className={cx('p-3 rounded-xl border', tone ? tones[tone] : 'bg-white border-[#D3E3F0] text-[#0B2A44]')}>
      <span className="text-[10px] uppercase tracking-wider font-bold opacity-80 block">{label}</span>
      <div className="text-xl font-bold mt-0.5">{value}</div>
      {hint && <span className="text-[10px] opacity-80 block mt-0.5 truncate">{hint}</span>}
    </div>
  );
};

const FilterChip: React.FC<{ active: boolean; onClick: () => void; activeCls?: string; children: React.ReactNode }> = ({ active, onClick, activeCls = 'bg-[#0B2A44] text-white', children }) => (
  <button onClick={onClick} className={cx('px-2.5 py-1 rounded-md text-xs font-semibold transition whitespace-nowrap', active ? activeCls : 'text-[#5E778C] hover:bg-[#E6EFF6]')}>{children}</button>
);
