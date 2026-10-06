/**
 * Reports — Monthly · Compare · Till Date · Performance · Export.
 *
 * Every number comes from core/analytics (KPI snapshots) or core/pipeline
 * (pipeline value & response time). This view only lays the figures out,
 * lets the user pick a period / RM and exports the visible table as CSV or
 * as a dated report snapshot on the server, served at /api/reports/<id> (api.settings.saveReportSnapshot).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ArrowLeftRight, BarChart3, CalendarRange, Download, ExternalLink, FileSpreadsheet, History, Save, TrendingUp, X } from 'lucide-react';
import { CRMConfig, Lead, TaskItem } from '../../types/crm';
import { F } from '../../core/config';
import { api } from '../../core/api';
import { availableMonths, countedLeads } from '../../core/analytics';
import { currentMonthKey, listMonths, previousMonthKey } from '../../core/dates';
import { reportError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { formatNumber } from '../../core/format';
import { Button, Card, EmptyState, ErrorState, InlineNotice, Select, Tabs } from '../../components/ui';
import { LeadIndex, ReportTable, downloadTable } from './reportShared';
import { MonthlyTab } from './MonthlyTab';
import { CompareTab } from './CompareTab';
import { TillDateTab } from './TillDateTab';
import { PerformanceTab } from './PerformanceTab';
import { ExportTab } from './ExportTab';

export interface ReportsViewProps {
  leads: Lead[];
  tasks: TaskItem[];
  config: CRMConfig;
  onOpenLead?: (id: string) => void;
  canExport: boolean;
}

type TabId = 'monthly' | 'compare' | 'tilldate' | 'performance' | 'export';

export const ReportsView: React.FC<ReportsViewProps> = ({ leads, tasks, config, onOpenLead, canExport }) => {
  const [tab, setTab] = useState<TabId>('monthly');
  const [rm, setRm] = useState('');
  const [tables, setTables] = useState<ReportTable[]>([]);
  const [selectedTable, setSelectedTable] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ url: string; title: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const rmOptions = useMemo(() => config.options[F.RM] || [], [config]);
  const index = useMemo<LeadIndex>(() => new Map(leads.map((l) => [String(l[F.ID] || ''), l])), [leads]);
  const counted = useMemo(() => countedLeads(leads).length, [leads]);

  // Month lists shared by the Monthly and Compare tabs (never hard-coded).
  const current = currentMonthKey();
  const previous = previousMonthKey(current);
  const months = useMemo(() => {
    const avail = availableMonths(leads, tasks);
    const earliest = avail[0] && avail[0] < previous ? avail[0] : previous;
    return listMonths(earliest, current);
  }, [leads, tasks, current, previous]);

  const registerTables = useCallback((t: ReportTable[]) => {
    setTables(t);
    setSelectedTable((i) => (i < t.length ? i : 0));
  }, []);

  const changeTab = (t: TabId) => {
    setTab(t);
    setSelectedTable(0);
    setSaveError(null);
  };

  const showEmpty = counted === 0 && tab !== 'export';
  const active = showEmpty ? undefined : tables[selectedTable];

  const handleCsv = () => {
    if (!active || !active.rows.length) return;
    downloadTable(active);
    toast('CSV downloaded', active.title, 'success');
  };

  const handleSave = async () => {
    if (!active || !active.rows.length || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.settings.saveReportSnapshot({ title: active.title, range: active.range, rows: active.rows });
      setSaved({ url: res.url, title: active.title });
      toast('Report snapshot saved', active.title, 'success');
    } catch (e) {
      const err = reportError('reports.saveSnapshot', e, { title: active.title, rows: active.rows.length });
      setSaveError(err.userMessage);
    } finally {
      setSaving(false);
    }
  };

  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
    { id: 'monthly', label: 'Monthly', icon: <CalendarRange size={14} /> },
    { id: 'compare', label: 'Compare', icon: <ArrowLeftRight size={14} /> },
    { id: 'tilldate', label: 'Till Date', icon: <History size={14} /> },
    { id: 'performance', label: 'Performance', icon: <TrendingUp size={14} /> },
    { id: 'export', label: 'Export', icon: <FileSpreadsheet size={14} /> },
  ];

  const canAct = !!active && active.rows.length > 0;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header + global filters */}
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1D2F3F] tracking-tight inline-flex items-center gap-2"><BarChart3 size={22} className="text-[#A9825A]" />Reports & Analytics</h2>
          <p className="text-xs text-[#6B5F57] mt-0.5">
            {formatNumber(counted)} counted leads · {formatNumber(tasks.length)} tasks{rm ? ` · filtered to ${rm}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Relationship manager" value={rm} onChange={(e) => setRm(e.target.value)} options={rmOptions} placeholder="All RMs" className="!w-auto" />
          {tables.length > 1 && (
            <Select
              aria-label="Table to export"
              value={String(selectedTable)}
              onChange={(e) => setSelectedTable(Number(e.target.value))}
              options={tables.map((t, i) => ({ value: String(i), label: `${t.title} (${t.rows.length})` }))}
              className="!w-auto max-w-[260px]"
            />
          )}
          <Button variant="secondary" onClick={handleCsv} disabled={!canAct} icon={<Download size={13} />} title={active ? `Download “${active.title}” as CSV` : 'Nothing to download'}>CSV</Button>
          {canExport && (
            <Button variant="primary" onClick={handleSave} loading={saving} disabled={!canAct} icon={<Save size={13} />} title={active ? `Save “${active.title}” as a report snapshot` : 'Nothing to save'}>
              Save snapshot
            </Button>
          )}
        </div>
      </div>

      {saved && (
        <InlineNotice tone="success" className="flex items-center justify-between gap-3">
          <span>
            <strong>{saved.title}</strong> saved as a report snapshot.{' '}
            <a href={saved.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold underline">
              Open snapshot <ExternalLink size={11} />
            </a>
          </span>
          <button onClick={() => setSaved(null)} className="p-1 rounded text-emerald-800/70 hover:text-emerald-900" aria-label="Dismiss"><X size={13} /></button>
        </InlineNotice>
      )}
      {saveError && <ErrorState compact title="Could not save the report" message={saveError} onRetry={handleSave} />}

      <Tabs tabs={tabs} value={tab} onChange={changeTab} />

      {showEmpty ? (
        <Card>
          <EmptyState
            title="No enquiries to report on yet"
            description="Reports are computed live from the Enquiry Log. Add the first enquiry, import a CSV or connect Chat360 and the monthly, comparison and performance reports fill in automatically."
            icon={<BarChart3 size={22} />}
          />
        </Card>
      ) : (
        <>
          {tab === 'monthly' && <MonthlyTab leads={leads} tasks={tasks} rm={rm || undefined} months={months} defaultMonth={current} index={index} onOpenLead={onOpenLead} onTables={registerTables} />}
          {tab === 'compare' && <CompareTab leads={leads} tasks={tasks} rm={rm || undefined} months={months} defaultPrev={previous} defaultCurr={current} onTables={registerTables} />}
          {tab === 'tilldate' && <TillDateTab leads={leads} tasks={tasks} rm={rm || undefined} index={index} onOpenLead={onOpenLead} onTables={registerTables} />}
          {tab === 'performance' && <PerformanceTab leads={leads} rm={rm || undefined} onOpenLead={onOpenLead} onTables={registerTables} />}
          {tab === 'export' && <ExportTab leads={leads} config={config} rm={rm} onRmChange={setRm} onOpenLead={onOpenLead} onTables={registerTables} />}
        </>
      )}
      <p className="text-[10px] text-[#9E948D]">
        {active ? `CSV / Save act on “${active.title}”${active.range ? ` (${active.range})` : ''}. ` : ''}
        Attribution: enquiries by enquiry date, visits and bookings by their own dates, follow-ups by remark time, tasks by due time; trashed leads are never counted.
      </p>
    </div>
  );
};
