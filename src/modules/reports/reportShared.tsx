/**
 * Shared pieces of the Reports module: export-table plumbing, KPI → row
 * builders and the small presentational tables reused by every tab.
 * Numbers always arrive pre-computed from core/analytics or core/pipeline.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Lead } from '../../types/crm';
import { F } from '../../core/config';
import { Breakdown, ComparisonRow, KpiSnapshot, MonthPoint, RMPerformance, enquiryDate } from '../../core/analytics';
import { compareDates, formatDate, formatDateTime, monthLabel, todayKey } from '../../core/dates';
import { downloadText, formatHours, formatNumber, formatPercent, toCsv } from '../../core/format';
import { Bar, Button, Card, DataTable, EmptyState, Select, StageBadge, cx } from '../../components/ui';

/* ------------------------------------------------------------------------ */
/* Export tables                                                             */
/* ------------------------------------------------------------------------ */

/** A table the toolbar can download as CSV or save as a report snapshot. */
export interface ReportTable {
  id: string;
  title: string;
  range: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

export type LeadIndex = Map<string, Lead>;

export function table(id: string, title: string, range: string, headers: string[], rows: Array<Record<string, unknown>>): ReportTable {
  return { id, title, range, headers, rows };
}

/** Build a row whose key order follows `headers` (the snapshot keeps Object.keys of row 0). */
export function row(headers: string[], values: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  headers.forEach((h, i) => (out[h] = values[i] ?? ''));
  return out;
}

export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'report';
}

export function downloadTable(t: ReportTable) {
  downloadText(`${slug(t.title)}_${todayKey()}.csv`, toCsv(t.headers, t.rows));
}

/** Tabs call this to hand their currently visible tables to the toolbar. */
export function useRegisterTables(onTables: (tables: ReportTable[]) => void, tables: ReportTable[]) {
  useEffect(() => {
    onTables(tables);
  }, [onTables, tables]);
}

/* --------------------------- KPI → rows builders ------------------------- */

export const KPI_LABELS: Array<{ id: keyof KpiSnapshot; label: string; format?: 'number' | 'percent' | 'hours' }> = [
  { id: 'totalEnquiries', label: 'Total Enquiries' },
  { id: 'newLeads', label: 'New Leads' },
  { id: 'openLeads', label: 'Open Leads' },
  { id: 'qualifiedLeads', label: 'Qualified' },
  { id: 'hotLeads', label: 'Hot' },
  { id: 'warmLeads', label: 'Warm' },
  { id: 'lostLeads', label: 'Lost / Disqualified' },
  { id: 'siteVisitsScheduled', label: 'Site Visits Scheduled' },
  { id: 'siteVisitsCompleted', label: 'Site Visits Completed' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'conversionRate', label: 'Conversion Rate', format: 'percent' },
  { id: 'qualificationRate', label: 'Qualification Rate', format: 'percent' },
  { id: 'siteVisitRate', label: 'Site Visit Rate', format: 'percent' },
  { id: 'followupsCompleted', label: 'Follow-ups Completed' },
  { id: 'followupsDue', label: 'Follow-ups Due' },
  { id: 'followupsOverdue', label: 'Follow-ups Overdue' },
  { id: 'pendingTasks', label: 'Pending Tasks' },
  { id: 'completedTasks', label: 'Completed Tasks' },
  { id: 'avgResponseHours', label: 'Avg First Response', format: 'hours' },
];

export function fmtMetric(v: number | null | undefined, format?: 'number' | 'percent' | 'hours'): string {
  if (format === 'percent') return formatPercent(v, 1);
  if (format === 'hours') return formatHours(v);
  return formatNumber(v);
}

export function kpiSummaryTable(s: KpiSnapshot, title: string, range: string): ReportTable {
  const headers = ['Metric', 'Value'];
  return table(
    'kpi',
    title,
    range,
    headers,
    KPI_LABELS.map((k) => row(headers, [k.label, fmtMetric(kpiValue(s, k.id), k.format)]))
  );
}

/** Numeric value of a snapshot field (null for the nullable averages / non-numeric fields). */
export function kpiValue(s: KpiSnapshot, id: keyof KpiSnapshot): number | null {
  const raw: unknown = s[id];
  return typeof raw === 'number' ? raw : null;
}

export function sourceTable(rows: Breakdown[], title: string, range: string): ReportTable {
  const headers = ['Source', 'Enquiries', 'Share %', 'Qualified', 'Site Visits', 'Bookings', 'Conv %'];
  return table(
    'source',
    title,
    range,
    headers,
    rows.map((r) => row(headers, [r.label, r.count, formatPercent(r.percent, 1), r.qualified ?? 0, r.siteVisits ?? 0, r.bookings ?? 0, formatPercent(r.conversionRate, 1)]))
  );
}

export function rmTable(rows: RMPerformance[], title: string, range: string): ReportTable {
  const headers = ['RM', 'Enquiries', 'Open', 'Hot', 'Qualified', 'Site Visits', 'Bookings', 'Conv %', 'Follow-ups Completed', 'Follow-ups Overdue', 'Avg Response', 'SLA 24h %'];
  return table(
    'rm',
    title,
    range,
    headers,
    rows.map((r) =>
      row(headers, [
        r.rm, r.enquiries, r.open, r.hot, r.qualified, r.siteVisits, r.bookings, formatPercent(r.conversionRate, 1), r.followupsCompleted, r.followupsOverdue,
        formatHours(r.avgResponseHours), r.slaWithin24hPercent === null ? '—' : formatPercent(r.slaWithin24hPercent, 0),
      ])
    )
  );
}

export function stageTable(rows: Breakdown[], title: string, range: string): ReportTable {
  const headers = ['Stage', 'Leads', 'Share %'];
  return table('stage', title, range, headers, rows.map((r) => row(headers, [r.label, r.count, formatPercent(r.percent, 1)])));
}

export function monthlyTrendTable(points: MonthPoint[], title: string, range: string): ReportTable {
  const headers = ['Month', 'Enquiries', 'Qualified', 'Hot', 'Site Visits', 'Bookings', 'Conv %', 'Follow-ups Completed', 'Tasks'];
  return table(
    'trend',
    title,
    range,
    headers,
    points.map((p) => row(headers, [p.label, p.enquiries, p.qualified, p.hot, p.siteVisits, p.bookings, formatPercent(p.conversionRate, 1), p.followupsCompleted, p.tasks]))
  );
}

/* ----------------------------- comparison fmt ---------------------------- */

export function fmtDiff(diff: number, format?: 'number' | 'percent' | 'hours'): string {
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  const abs = Math.abs(diff);
  if (format === 'percent') return `${sign}${formatPercent(abs, 1).replace('%', ' pts')}`;
  if (format === 'hours') return diff === 0 ? '—' : `${sign}${formatHours(abs)}`;
  return `${sign}${formatNumber(abs)}`;
}

export function fmtPctChange(p: number | null): string {
  if (p === null) return 'new';
  if (p === 0) return '0%';
  return `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;
}

export type Tone = 'good' | 'bad' | 'flat';
export function changeTone(r: ComparisonRow): Tone {
  if (r.direction === 'flat') return 'flat';
  const improved = r.lowerIsBetter ? r.direction === 'down' : r.direction === 'up';
  return improved ? 'good' : 'bad';
}
export const TONE_CLS: Record<Tone, string> = { good: 'text-[#2E7D32]', bad: 'text-[#B06A55]', flat: 'text-[#7E93A6]' };
export const DIRECTION_GLYPH: Record<ComparisonRow['direction'], string> = { up: '▲', down: '▼', flat: '•' };

/* ------------------------------------------------------------------------ */
/* Presentational pieces                                                     */
/* ------------------------------------------------------------------------ */

export const STAGE_COLORS: Record<string, string> = {
  New: '#0B2A44', Open: '#3A5D7C', Warm: '#0B6BB0', Hot: '#B06A55', Qualified: '#0E8A86', Booked: '#2E7D32',
  'Not Responding': '#D97706', DND: '#7E93A6', Junk: '#7E93A6', 'Disqualified - Budget': '#8A3E28', 'Disqualified - Location': '#8A3E28', 'Disqualified - Rental': '#8A3E28',
};

export const MonthSelect: React.FC<{ value: string; onChange: (key: string) => void; months: string[]; className?: string; label?: string }> = ({ value, onChange, months, className, label }) => {
  const options = useMemo(() => [...months].reverse().map((k) => ({ value: k, label: monthLabel(k, true) })), [months]);
  return <Select aria-label={label || 'Month'} value={value} onChange={(e) => onChange(e.target.value)} options={options} className={cx('!w-auto min-w-[160px]', className)} />;
};

export const SourceTable: React.FC<{ rows: Breakdown[]; dense?: boolean; onRowClick?: (r: Breakdown) => void }> = ({ rows, dense = true, onRowClick }) => (
  <DataTable<Breakdown>
    dense={dense}
    rows={rows}
    keyFn={(r) => r.key}
    onRowClick={onRowClick}
    empty="No enquiries in this period"
    columns={[
      { key: 'label', label: 'Source', render: (r) => <span className="font-semibold text-[#0B2A44]">{r.label}</span> },
      { key: 'count', label: 'Enquiries', align: 'right', render: (r) => <span>{formatNumber(r.count)} <span className="text-[#7E93A6] text-[10px]">({formatPercent(r.percent, 0)})</span></span> },
      { key: 'qualified', label: 'Qualified', align: 'right', render: (r) => formatNumber(r.qualified) },
      { key: 'siteVisits', label: 'Site Visits', align: 'right', render: (r) => formatNumber(r.siteVisits) },
      { key: 'bookings', label: 'Bookings', align: 'right', render: (r) => <span className="font-bold text-[#2E7D32]">{formatNumber(r.bookings)}</span> },
      { key: 'conversionRate', label: 'Conv %', align: 'right', render: (r) => <span className="font-semibold">{formatPercent(r.conversionRate, 1)}</span> },
    ]}
  />
);

const slaCls = (v: number | null) => (v === null ? 'bg-[#E6EFF6] text-[#5E778C]' : v >= 80 ? 'bg-[#E8F5E9] text-[#2E7D32]' : v >= 50 ? 'bg-[#FFF8E1] text-[#92400E]' : 'bg-[#FAF0EC] text-[#8A3E28]');

export const RMTable: React.FC<{ rows: RMPerformance[]; dense?: boolean }> = ({ rows, dense = true }) => (
  <DataTable<RMPerformance>
    dense={dense}
    rows={rows}
    keyFn={(r) => r.rm}
    empty="No RM activity in this period"
    columns={[
      { key: 'rm', label: 'RM', render: (r) => <span className="font-semibold text-[#0B2A44] whitespace-nowrap">{r.rm}</span> },
      { key: 'enquiries', label: 'Enq', align: 'right', render: (r) => formatNumber(r.enquiries) },
      { key: 'open', label: 'Open', align: 'right', render: (r) => formatNumber(r.open) },
      { key: 'hot', label: 'Hot', align: 'right', render: (r) => <span className={r.hot ? 'font-semibold text-[#B06A55]' : ''}>{formatNumber(r.hot)}</span> },
      { key: 'qualified', label: 'Qual.', align: 'right', render: (r) => formatNumber(r.qualified) },
      { key: 'siteVisits', label: 'Visits', align: 'right', render: (r) => formatNumber(r.siteVisits) },
      { key: 'bookings', label: 'Booked', align: 'right', render: (r) => <span className="font-bold text-[#2E7D32]">{formatNumber(r.bookings)}</span> },
      { key: 'conversionRate', label: 'Conv %', align: 'right', render: (r) => <span className="font-semibold">{formatPercent(r.conversionRate, 0)}</span> },
      { key: 'followupsCompleted', label: 'FU Done', align: 'right', render: (r) => formatNumber(r.followupsCompleted) },
      { key: 'followupsOverdue', label: 'FU Overdue', align: 'right', render: (r) => <span className={r.followupsOverdue ? 'font-bold text-[#B06A55]' : 'text-[#7E93A6]'}>{formatNumber(r.followupsOverdue)}</span> },
      { key: 'avgResponseHours', label: 'Avg Response', align: 'right', render: (r) => <span className="whitespace-nowrap">{formatHours(r.avgResponseHours)}</span> },
      {
        key: 'slaWithin24hPercent', label: 'SLA 24h', align: 'right',
        render: (r) => <span className={cx('px-2 py-0.5 rounded text-[10px] font-bold', slaCls(r.slaWithin24hPercent))}>{r.slaWithin24hPercent === null ? '—' : formatPercent(r.slaWithin24hPercent, 0)}</span>,
      },
    ]}
  />
);

export const StageDistribution: React.FC<{ rows: Breakdown[]; total: number; onClick?: (stage: string) => void }> = ({ rows, total, onClick }) => {
  if (!rows.length) return <EmptyState title="No leads in this period" className="py-6" />;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      <div className="w-full h-3.5 rounded-full overflow-hidden flex bg-[#E3EDF5]">
        {rows.map((r) => <div key={r.key} style={{ width: `${r.percent}%`, backgroundColor: STAGE_COLORS[r.key] || '#7E93A6' }} title={`${r.label}: ${r.count}`} />)}
      </div>
      <div className="mt-3 space-y-2">
        {rows.map((r) => {
          const Tag: any = onClick ? 'button' : 'div';
          return (
            <Tag key={r.key} onClick={onClick ? () => onClick(r.key) : undefined} className={cx('w-full text-left', onClick && 'group')}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="inline-flex items-center gap-1.5 min-w-0"><span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: STAGE_COLORS[r.key] || '#7E93A6' }} /><span className={cx('truncate text-[#0F2233]', onClick && 'group-hover:text-[#0B6BB0]')}>{r.label}</span></span>
                <span className="text-[#5E778C] flex-shrink-0 ml-2"><strong className="text-[#0B2A44]">{formatNumber(r.count)}</strong> · {formatPercent(r.percent, 0)}</span>
              </div>
              <Bar value={r.count} max={max} color={STAGE_COLORS[r.key] || '#7E93A6'} />
            </Tag>
          );
        })}
      </div>
      <div className="text-[10px] text-[#7E93A6] mt-2">{formatNumber(total)} enquiries · current stage of the leads enquired in the period</div>
    </div>
  );
};

/* ------------------------------- Drill-down ------------------------------ */

const DRILL_PAGE = 50;

export interface DrillState {
  label: string;
  ids: string[];
}

export const DrillDown: React.FC<{ drill: DrillState; index: LeadIndex; onOpenLead?: (id: string) => void; onClose: () => void }> = ({ drill, index, onOpenLead, onClose }) => {
  const [visible, setVisible] = useState(DRILL_PAGE);
  const leads = useMemo(() => {
    const seen = new Set<string>();
    const out: Lead[] = [];
    for (const id of drill.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const l = index.get(id);
      if (l) out.push(l);
    }
    return out.sort((a, b) => compareDates(enquiryDate(a), enquiryDate(b), false));
  }, [drill, index]);

  useEffect(() => setVisible(DRILL_PAGE), [drill]);

  const exportCsv = () => {
    const headers = [F.ID, F.NAME, F.PHONE, F.STAGE, F.SOURCE, F.UNIT_TYPE, F.RM, F.ENQUIRY_DATE, F.NEXT_FOLLOWUP];
    const rows = leads.map((l) =>
      row(headers, [l[F.ID], l[F.NAME], l[F.PHONE], l[F.STAGE], l[F.SOURCE], l[F.UNIT_TYPE], l[F.RM], formatDate(enquiryDate(l)), formatDateTime(l[F.NEXT_FOLLOWUP])])
    );
    downloadText(`${slug(drill.label)}_${todayKey()}.csv`, toCsv(headers, rows));
  };

  return (
    <Card
      className="border-[#0B6BB0]/50"
      title={<span>Drill-down · {drill.label}</span>}
      subtitle={`${formatNumber(leads.length)} lead${leads.length === 1 ? '' : 's'}${onOpenLead ? ' · click a row to open the profile' : ''}`}
      actions={
        <>
          <Button variant="secondary" size="xs" onClick={exportCsv} icon={<Download size={12} />} disabled={!leads.length}>CSV</Button>
          <Button variant="ghost" size="xs" onClick={onClose} icon={<X size={12} />}>Close</Button>
        </>
      }
    >
      {leads.length === 0 ? (
        <EmptyState title="No leads" description="Nothing matched this metric in the selected period." className="py-6" />
      ) : (
        <>
          <div className="divide-y divide-[#E6EFF6] -mx-2">
            {leads.slice(0, visible).map((l) => {
              const Tag: any = onOpenLead ? 'button' : 'div';
              return (
                <Tag key={l[F.ID]} onClick={onOpenLead ? () => onOpenLead(l[F.ID]) : undefined} className={cx('w-full flex items-center justify-between gap-3 px-2 py-2.5 text-left', onOpenLead && 'hover:bg-[#F2F7FB]')}>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#0B2A44] truncate">
                      {l[F.NAME] || '—'} <span className="text-[10px] font-mono text-[#0B6BB0] ml-1">{l[F.ID]}</span>
                    </div>
                    <div className="text-[11px] text-[#5E778C] truncate">
                      {l[F.SOURCE] || 'Source —'} · {l[F.UNIT_TYPE] || 'Unit —'} · RM {l[F.RM] || '—'}
                      {l[F.NEXT_FOLLOWUP] ? ` · Next follow-up ${formatDateTime(l[F.NEXT_FOLLOWUP])}` : ''}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-[11px] text-[#5E778C] mb-0.5">{formatDate(enquiryDate(l), '—')}</div>
                    <StageBadge stage={l[F.STAGE]} />
                  </div>
                </Tag>
              );
            })}
          </div>
          {leads.length > visible && (
            <div className="text-center pt-3">
              <Button variant="ghost" onClick={() => setVisible((v) => v + DRILL_PAGE)}>Show more ({leads.length - visible} remaining)</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

/* ------------------------------- Section hdr ----------------------------- */

export const SectionNote: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-[11px] text-[#7E93A6] mt-2 leading-relaxed">{children}</p>;
