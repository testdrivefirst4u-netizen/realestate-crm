/**
 * Reports › Till Date — everything since the first enquiry (core/analytics.tillDateReport).
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, PhoneCall, Target, Trophy, Users, Layers } from 'lucide-react';
import { Lead, TaskItem } from '../../types/crm';
import { MonthPoint, tillDateReport } from '../../core/analytics';
import { formatDate } from '../../core/dates';
import { formatNumber, formatPercent } from '../../core/format';
import { Button, Card, DataTable, KpiTile } from '../../components/ui';
import { DrillDown, DrillState, LeadIndex, RMTable, ReportTable, SectionNote, SourceTable, StageDistribution, kpiSummaryTable, monthlyTrendTable, rmTable, sourceTable, stageTable, row, useRegisterTables } from './reportShared';

interface Props {
  leads: Lead[];
  tasks: TaskItem[];
  rm?: string;
  index: LeadIndex;
  onOpenLead?: (id: string) => void;
  onTables: (tables: ReportTable[]) => void;
}

const TREND_PAGE = 24;

export const TillDateTab: React.FC<Props> = ({ leads, tasks, rm, index, onOpenLead, onTables }) => {
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [trendVisible, setTrendVisible] = useState(TREND_PAGE);

  const report = useMemo(() => tillDateReport(leads, tasks, { rm }), [leads, tasks, rm]);
  const { snapshot, monthly, firstEnquiryDate, totalFollowups } = report;
  const since = firstEnquiryDate ? `Since ${formatDate(firstEnquiryDate)}` : 'No enquiries yet';
  const rangeLabel = rm ? `${since} · ${rm}` : since;

  const tables = useMemo<ReportTable[]>(() => {
    const kpis = kpiSummaryTable(snapshot, 'Till-date KPIs', rangeLabel);
    const h = kpis.headers;
    kpis.rows.splice(0, 0, row(h, ['First enquiry', firstEnquiryDate ? formatDate(firstEnquiryDate) : '—']), row(h, ['Total follow-ups logged', totalFollowups]));
    return [
      kpis,
      monthlyTrendTable(monthly, 'Monthly trend', rangeLabel),
      sourceTable(snapshot.bySource, 'Source performance · till date', rangeLabel),
      rmTable(snapshot.byRM, 'RM performance · till date', rangeLabel),
      stageTable(snapshot.byStage, 'Stage distribution · till date', rangeLabel),
    ];
  }, [snapshot, monthly, firstEnquiryDate, totalFollowups, rangeLabel]);
  useRegisterTables(onTables, tables);

  const show = (label: string, ids: string[]) => setDrill({ label: `Till date · ${label}`, ids });

  const trendDesc = useMemo(() => [...monthly].reverse(), [monthly]);
  const trendRecent = useMemo(() => monthly.slice(-12), [monthly]);

  return (
    <div className="space-y-5">
      <Card title="Till-date summary" subtitle={since} actions={<span className="text-xs text-[#6B5F57]">{formatNumber(monthly.length)} month{monthly.length === 1 ? '' : 's'} of data</span>}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiTile label="Total Enquiries" value={snapshot.totalEnquiries} tone="navy" icon={<Users size={12} />} onClick={() => show('All enquiries', snapshot.ids.enquiries)} />
          <KpiTile label="Total Leads (open)" value={snapshot.openLeads} tone="white" icon={<Target size={12} />} hint="still in the pipeline" onClick={() => show('Open pipeline', snapshot.ids.open)} />
          <KpiTile label="Qualified" value={snapshot.qualifiedLeads} tone="white" icon={<CheckCircle2 size={12} />} hint={`${formatPercent(snapshot.qualificationRate, 0)} of enquiries`} onClick={() => show('Qualified', snapshot.ids.qualified)} />
          <KpiTile label="Site Visits (completed)" value={snapshot.siteVisitsCompleted} tone="gold" icon={<Building2 size={12} />} hint={`${formatPercent(snapshot.siteVisitRate, 0)} of enquiries`} onClick={() => show('Site visits completed', snapshot.ids.svCompleted)} />
          <KpiTile label="Bookings" value={snapshot.bookings} tone="sage" icon={<Trophy size={12} />} onClick={() => show('Bookings', snapshot.ids.booked)} />
          <KpiTile label="Overall Conversion" value={formatPercent(snapshot.conversionRate, 1)} tone="white" hint={`${snapshot.bookings} bookings / ${snapshot.totalEnquiries} enquiries`} />
          <KpiTile label="Total Follow-ups" value={totalFollowups} tone="white" icon={<PhoneCall size={12} />} hint="remarks logged on all leads" />
          <KpiTile label="Overdue Now" value={snapshot.followupsOverdue} tone="rust" icon={<AlertTriangle size={12} />} hint="active leads past their follow-up time" onClick={() => show('Overdue follow-ups', snapshot.ids.followupsOverdue)} />
        </div>
        <SectionNote>Click a tile to list the leads behind the number.</SectionNote>
      </Card>

      {drill && <DrillDown drill={drill} index={index} onOpenLead={onOpenLead} onClose={() => setDrill(null)} />}

      <Card title="Monthly trend" subtitle={trendRecent.length ? `Enquiries vs bookings · last ${trendRecent.length} month${trendRecent.length === 1 ? '' : 's'} charted, all months in the table` : 'No data yet'} actions={<Layers size={16} className="text-[#A9825A]" />}>
        {trendRecent.length > 0 && <TrendBars series={trendRecent} />}
        <div className="mt-4 -mx-5 border-t border-[#ECE8E1]">
          <DataTable<MonthPoint>
            dense
            rows={trendDesc.slice(0, trendVisible)}
            keyFn={(p) => p.key}
            empty="No months to show"
            columns={[
              { key: 'label', label: 'Month', render: (p) => <span className="font-semibold text-[#1D2F3F] whitespace-nowrap">{p.label}</span> },
              { key: 'enquiries', label: 'Enquiries', align: 'right', render: (p) => formatNumber(p.enquiries) },
              { key: 'qualified', label: 'Qualified', align: 'right', render: (p) => formatNumber(p.qualified) },
              { key: 'siteVisits', label: 'Site Visits', align: 'right', render: (p) => formatNumber(p.siteVisits) },
              { key: 'bookings', label: 'Bookings', align: 'right', render: (p) => <span className="font-bold text-[#2E7D32]">{formatNumber(p.bookings)}</span> },
              { key: 'conversionRate', label: 'Conv %', align: 'right', render: (p) => (p.enquiries ? formatPercent(p.conversionRate, 1) : '—') },
              { key: 'followupsCompleted', label: 'Follow-ups', align: 'right', render: (p) => formatNumber(p.followupsCompleted) },
              { key: 'tasks', label: 'Tasks', align: 'right', render: (p) => formatNumber(p.tasks) },
            ]}
          />
          {trendDesc.length > trendVisible && (
            <div className="text-center py-3 border-t border-[#ECE8E1]">
              <Button variant="ghost" onClick={() => setTrendVisible((v) => v + TREND_PAGE)}>Show more ({trendDesc.length - trendVisible} remaining)</Button>
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Card title="Source performance" subtitle={since} padded={false} className="xl:col-span-2">
          <SourceTable rows={snapshot.bySource} />
        </Card>
        <Card title="Lead-stage distribution" subtitle="Current stage of every counted lead">
          <StageDistribution rows={snapshot.byStage} total={snapshot.totalEnquiries} />
        </Card>
      </div>

      <Card title="RM performance" subtitle={`${since} · overdue follow-ups are as of now`} padded={false}>
        <RMTable rows={snapshot.byRM} />
      </Card>
    </div>
  );
};

/* -------------------------------- chart ---------------------------------- */

const TrendBars: React.FC<{ series: MonthPoint[] }> = ({ series }) => {
  const max = Math.max(1, ...series.map((p) => p.enquiries));
  return (
    <div>
      <div className="h-40 flex items-end gap-2 border-b border-[#ECE8E1] pb-1">
        {series.map((p) => (
          <div key={p.key} className="flex-1 flex flex-col items-center justify-end h-full group relative min-w-0">
            <div className="absolute -top-12 opacity-0 group-hover:opacity-100 transition pointer-events-none bg-[#1D2F3F] text-white p-2 rounded text-[10px] whitespace-nowrap z-10">
              <div className="font-bold text-[#E7D8C6]">{p.label}</div>
              <div>{p.enquiries} enquiries · {p.bookings} booked</div>
              <div>{p.siteVisits} visits · {p.enquiries ? formatPercent(p.conversionRate, 0) : '—'} conv.</div>
            </div>
            <div className="w-full flex items-end gap-0.5 h-full">
              <div className="flex-1 rounded-t bg-[#1D2F3F]" style={{ height: `${Math.max(3, (p.enquiries / max) * 100)}%` }} />
              <div className="flex-1 rounded-t bg-[#A9825A]" style={{ height: `${Math.max(2, (p.siteVisits / max) * 100)}%` }} />
              <div className="flex-1 rounded-t bg-[#7C8B78]" style={{ height: `${Math.max(2, (p.bookings / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-1">
        {series.map((p) => (
          <div key={p.key} className="flex-1 text-center text-[10px] text-[#6B5F57] truncate">
            {p.label.slice(0, 3)}
            <div className="font-bold text-[#1D2F3F]">{p.enquiries}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4 text-[10px] text-[#6B5F57] mt-2">
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#1D2F3F]" />Enquiries</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#A9825A]" />Site visits</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-[#7C8B78]" />Bookings</span>
      </div>
    </div>
  );
};
