/**
 * Reports › Monthly — one calendar month (CRM time zone) from core/analytics.monthlyReport.
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Building2, CalendarCheck, CheckCircle2, Clock, Flame, ListChecks, PhoneCall, Sparkles, Sun, Target, Timer, Trophy, Users } from 'lucide-react';
import { Lead, TaskItem } from '../../types/crm';
import { isNew, monthlyReport } from '../../core/analytics';
import { monthLabel } from '../../core/dates';
import { formatHours, formatPercent } from '../../core/format';
import { Card, KpiTile } from '../../components/ui';
import { DrillDown, DrillState, LeadIndex, MonthSelect, RMTable, ReportTable, SectionNote, SourceTable, StageDistribution, kpiSummaryTable, rmTable, sourceTable, stageTable, useRegisterTables } from './reportShared';

interface Props {
  leads: Lead[];
  tasks: TaskItem[];
  rm?: string;
  months: string[];
  defaultMonth: string;
  index: LeadIndex;
  onOpenLead?: (id: string) => void;
  onTables: (tables: ReportTable[]) => void;
}

export const MonthlyTab: React.FC<Props> = ({ leads, tasks, rm, months, defaultMonth, index, onOpenLead, onTables }) => {
  const [month, setMonth] = useState(defaultMonth);
  const [drill, setDrill] = useState<DrillState | null>(null);

  const snapshot = useMemo(() => monthlyReport(leads, tasks, month, { rm }), [leads, tasks, month, rm]);
  const label = monthLabel(month, true);
  const rangeLabel = rm ? `${label} · ${rm}` : label;

  // "New" has no id list in the snapshot: select the cohort leads that core classifies as new.
  const newIds = useMemo(() => snapshot.ids.enquiries.filter((id) => { const l = index.get(id); return !!l && isNew(l); }), [snapshot, index]);

  const tables = useMemo<ReportTable[]>(
    () => [
      kpiSummaryTable(snapshot, `Monthly KPIs · ${label}`, rangeLabel),
      sourceTable(snapshot.bySource, `Source-wise · ${label}`, rangeLabel),
      rmTable(snapshot.byRM, `RM-wise · ${label}`, rangeLabel),
      stageTable(snapshot.byStage, `Stage distribution · ${label}`, rangeLabel),
    ],
    [snapshot, label, rangeLabel]
  );
  useRegisterTables(onTables, tables);

  const show = (dlabel: string, ids: string[]) => setDrill({ label: `${label} · ${dlabel}`, ids });

  return (
    <div className="space-y-5">
      <Card
        title={`Monthly report · ${label}`}
        subtitle="Enquiries by enquiry date; visits and bookings by their own dates; follow-ups and tasks by due time"
        actions={<MonthSelect value={month} onChange={(k) => { setMonth(k); setDrill(null); }} months={months} />}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiTile label="Total Enquiries" value={snapshot.totalEnquiries} tone="navy" icon={<Users size={12} />} onClick={() => show('Enquiries', snapshot.ids.enquiries)} />
          <KpiTile label="New Leads" value={snapshot.newLeads} tone="light" icon={<Sparkles size={12} />} onClick={() => show('New leads', newIds)} />
          <KpiTile label="Qualified" value={snapshot.qualifiedLeads} tone="white" icon={<CheckCircle2 size={12} />} onClick={() => show('Qualified', snapshot.ids.qualified)} />
          <KpiTile label="Hot" value={snapshot.hotLeads} tone="rust" icon={<Flame size={12} />} onClick={() => show('Hot', snapshot.ids.hot)} />
          <KpiTile label="Warm" value={snapshot.warmLeads} tone="gold" icon={<Sun size={12} />} onClick={() => show('Warm', snapshot.ids.warm)} />
          <KpiTile label="Site Visits Scheduled" value={snapshot.siteVisitsScheduled} tone="white" icon={<CalendarCheck size={12} />} onClick={() => show('Site visits scheduled', snapshot.ids.svScheduled)} />
          <KpiTile label="Site Visits Completed" value={snapshot.siteVisitsCompleted} tone="white" icon={<Building2 size={12} />} hint={`${formatPercent(snapshot.siteVisitRate, 0)} of enquiries`} onClick={() => show('Site visits completed', snapshot.ids.svCompleted)} />
          <KpiTile label="Bookings" value={snapshot.bookings} tone="sage" icon={<Trophy size={12} />} onClick={() => show('Bookings', snapshot.ids.booked)} />
          <KpiTile label="Conversion Rate" value={formatPercent(snapshot.conversionRate, 1)} tone="white" icon={<Target size={12} />} hint={`${snapshot.bookings} / ${snapshot.totalEnquiries}`} />
          <KpiTile label="Follow-ups Completed" value={snapshot.followupsCompleted} tone="white" icon={<PhoneCall size={12} />} />
          <KpiTile label="Follow-ups Due" value={snapshot.followupsDue} tone="gold" icon={<Clock size={12} />} hint={snapshot.followupsOverdue ? `${snapshot.followupsOverdue} overdue` : undefined} onClick={() => show('Follow-ups due', snapshot.ids.followupsDue)} />
          <KpiTile label="Tasks" value={`${snapshot.pendingTasks} / ${snapshot.completedTasks}`} tone="white" icon={<ListChecks size={12} />} hint="pending / completed" />
          <KpiTile label="Avg First Response" value={formatHours(snapshot.avgResponseHours)} tone="white" icon={<Timer size={12} />} hint="enquiry → first follow-up" />
          <KpiTile label="Lost / Disqualified" value={snapshot.lostLeads} tone="white" icon={<AlertTriangle size={12} />} onClick={() => show('Lost / disqualified', snapshot.ids.lost)} />
        </div>
        <SectionNote>Click a tile to list the leads behind the number.</SectionNote>
      </Card>

      {drill && <DrillDown drill={drill} index={index} onOpenLead={onOpenLead} onClose={() => setDrill(null)} />}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Card title="Source-wise" subtitle={label} padded={false} className="xl:col-span-2">
          <SourceTable rows={snapshot.bySource} />
        </Card>
        <Card title="Lead-stage distribution" subtitle={label}>
          <StageDistribution rows={snapshot.byStage} total={snapshot.totalEnquiries} />
        </Card>
      </div>

      <Card title="RM-wise performance" subtitle={`${label} · overdue follow-ups are as of now`} padded={false}>
        <RMTable rows={snapshot.byRM} />
      </Card>
    </div>
  );
};
