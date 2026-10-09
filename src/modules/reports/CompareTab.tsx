/**
 * Reports › Compare — two months side by side through core/analytics.compareMonths.
 * Direction colours honour `lowerIsBetter` (fewer overdue follow-ups is green).
 */
import React, { useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Lead, TaskItem } from '../../types/crm';
import { Breakdown, ComparisonRow, KpiSnapshot, RMPerformance, compareMonths } from '../../core/analytics';
import { monthLabel } from '../../core/dates';
import { formatNumber, formatPercent } from '../../core/format';
import { Button, Card, DataTable, cx } from '../../components/ui';
import { DIRECTION_GLYPH, MonthSelect, ReportTable, SectionNote, TONE_CLS, changeTone, fmtDiff, fmtMetric, fmtPctChange, row, table, useRegisterTables } from './reportShared';

interface Props {
  leads: Lead[];
  tasks: TaskItem[];
  rm?: string;
  months: string[];
  defaultPrev: string;
  defaultCurr: string;
  onTables: (tables: ReportTable[]) => void;
}

export const CompareTab: React.FC<Props> = ({ leads, tasks, rm, months, defaultPrev, defaultCurr, onTables }) => {
  const [prevKey, setPrevKey] = useState(defaultPrev);
  const [currKey, setCurrKey] = useState(defaultCurr);

  const cmp = useMemo(() => compareMonths(leads, tasks, prevKey, currKey, { rm }), [leads, tasks, prevKey, currKey, rm]);
  const prevLabel = monthLabel(prevKey, true);
  const currLabel = monthLabel(currKey, true);
  const rangeLabel = `${prevLabel} vs ${currLabel}${rm ? ` · ${rm}` : ''}`;

  const tables = useMemo<ReportTable[]>(() => {
    const h = ['Metric', prevLabel, currLabel, 'Difference', '% Change'];
    const comparison = table('compare', 'Month comparison', rangeLabel, h, cmp.rows.map((r) => row(h, [r.metric, fmtMetric(r.previous, r.format), fmtMetric(r.current, r.format), fmtDiff(r.difference, r.format), fmtPctChange(r.pctChange)])));
    return [comparison, sourceComparisonTable(cmp.previous, cmp.current, prevLabel, currLabel, rangeLabel), rmComparisonTable(cmp.previous, cmp.current, prevLabel, currLabel, rangeLabel)];
  }, [cmp, prevLabel, currLabel, rangeLabel]);
  useRegisterTables(onTables, tables);

  const swap = () => {
    setPrevKey(currKey);
    setCurrKey(prevKey);
  };

  return (
    <div className="space-y-5">
      <Card
        title="Month-on-month comparison"
        subtitle="Same attribution rules as the monthly report; green means the change is an improvement"
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <MonthSelect label="Previous month" value={prevKey} onChange={setPrevKey} months={months} />
            <Button variant="ghost" size="xs" onClick={swap} icon={<ArrowLeftRight size={13} />} title="Swap months" aria-label="Swap months" />
            <MonthSelect label="Current month" value={currKey} onChange={setCurrKey} months={months} />
          </div>
        }
        padded={false}
      >
        <DataTable<ComparisonRow>
          rows={cmp.rows}
          keyFn={(r) => r.metric}
          columns={[
            { key: 'metric', label: 'Metric', render: (r) => <span className="font-semibold text-[#0B2A44]">{r.metric}</span> },
            { key: 'previous', label: prevLabel, align: 'right', render: (r) => fmtMetric(r.previous, r.format) },
            { key: 'current', label: currLabel, align: 'right', render: (r) => <span className="font-bold text-[#0B2A44]">{fmtMetric(r.current, r.format)}</span> },
            { key: 'difference', label: 'Difference', align: 'right', render: (r) => <span className={cx('font-semibold', TONE_CLS[changeTone(r)])}>{fmtDiff(r.difference, r.format)}</span> },
            {
              key: 'pctChange', label: '% Change', align: 'right',
              render: (r) => (
                <span className={cx('inline-flex items-center gap-1 font-bold', TONE_CLS[changeTone(r)])} title={r.lowerIsBetter ? 'Lower is better' : 'Higher is better'}>
                  <span>{DIRECTION_GLYPH[r.direction]}</span>
                  <span>{fmtPctChange(r.pctChange)}</span>
                </span>
              ),
            },
          ]}
        />
        <div className="px-5 pb-4">
          <SectionNote>“new” means there was nothing in the previous month to compare against. For overdue follow-ups, pending tasks, lost leads and response time a decrease is shown as an improvement.</SectionNote>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title={`Source-wise · ${prevLabel}`} subtitle={`${cmp.previous.totalEnquiries} enquiries`} padded={false}><MiniSourceTable rows={cmp.previous.bySource} /></Card>
        <Card title={`Source-wise · ${currLabel}`} subtitle={`${cmp.current.totalEnquiries} enquiries`} padded={false}><MiniSourceTable rows={cmp.current.bySource} /></Card>
        <Card title={`RM-wise · ${prevLabel}`} subtitle={`${cmp.previous.bookings} bookings`} padded={false}><MiniRMTable rows={cmp.previous.byRM} /></Card>
        <Card title={`RM-wise · ${currLabel}`} subtitle={`${cmp.current.bookings} bookings`} padded={false}><MiniRMTable rows={cmp.current.byRM} /></Card>
      </div>
    </div>
  );
};

/* ------------------------------- mini tables ----------------------------- */

const MiniSourceTable: React.FC<{ rows: Breakdown[] }> = ({ rows }) => (
  <DataTable<Breakdown>
    dense
    rows={rows}
    keyFn={(r) => r.key}
    empty="No enquiries"
    columns={[
      { key: 'label', label: 'Source', render: (r) => <span className="font-semibold text-[#0B2A44]">{r.label}</span> },
      { key: 'count', label: 'Enq', align: 'right', render: (r) => formatNumber(r.count) },
      { key: 'siteVisits', label: 'Visits', align: 'right', render: (r) => formatNumber(r.siteVisits) },
      { key: 'bookings', label: 'Booked', align: 'right', render: (r) => <span className="font-bold text-[#2E7D32]">{formatNumber(r.bookings)}</span> },
      { key: 'conversionRate', label: 'Conv', align: 'right', render: (r) => formatPercent(r.conversionRate, 0) },
    ]}
  />
);

const MiniRMTable: React.FC<{ rows: RMPerformance[] }> = ({ rows }) => (
  <DataTable<RMPerformance>
    dense
    rows={rows}
    keyFn={(r) => r.rm}
    empty="No RM activity"
    columns={[
      { key: 'rm', label: 'RM', render: (r) => <span className="font-semibold text-[#0B2A44]">{r.rm}</span> },
      { key: 'enquiries', label: 'Enq', align: 'right', render: (r) => formatNumber(r.enquiries) },
      { key: 'siteVisits', label: 'Visits', align: 'right', render: (r) => formatNumber(r.siteVisits) },
      { key: 'bookings', label: 'Booked', align: 'right', render: (r) => <span className="font-bold text-[#2E7D32]">{formatNumber(r.bookings)}</span> },
      { key: 'conversionRate', label: 'Conv', align: 'right', render: (r) => formatPercent(r.conversionRate, 0) },
      { key: 'followupsOverdue', label: 'Overdue', align: 'right', render: (r) => <span className={r.followupsOverdue ? 'font-bold text-[#B06A55]' : 'text-[#7E93A6]'}>{formatNumber(r.followupsOverdue)}</span> },
    ]}
  />
);

/* ----------------------------- export builders --------------------------- */

function sourceComparisonTable(prev: KpiSnapshot, curr: KpiSnapshot, prevLabel: string, currLabel: string, range: string): ReportTable {
  const h = ['Source', `Enquiries ${prevLabel}`, `Enquiries ${currLabel}`, `Site Visits ${prevLabel}`, `Site Visits ${currLabel}`, `Bookings ${prevLabel}`, `Bookings ${currLabel}`, `Conv % ${prevLabel}`, `Conv % ${currLabel}`];
  const keys = [...new Set([...curr.bySource.map((s) => s.key), ...prev.bySource.map((s) => s.key)])];
  const p = new Map(prev.bySource.map((s) => [s.key, s]));
  const c = new Map(curr.bySource.map((s) => [s.key, s]));
  return table(
    'compare-source',
    'Source comparison',
    range,
    h,
    keys.map((k) => {
      const a = p.get(k), b = c.get(k);
      return row(h, [k, a?.count ?? 0, b?.count ?? 0, a?.siteVisits ?? 0, b?.siteVisits ?? 0, a?.bookings ?? 0, b?.bookings ?? 0, formatPercent(a?.conversionRate ?? 0, 1), formatPercent(b?.conversionRate ?? 0, 1)]);
    })
  );
}

function rmComparisonTable(prev: KpiSnapshot, curr: KpiSnapshot, prevLabel: string, currLabel: string, range: string): ReportTable {
  const h = ['RM', `Enquiries ${prevLabel}`, `Enquiries ${currLabel}`, `Site Visits ${prevLabel}`, `Site Visits ${currLabel}`, `Bookings ${prevLabel}`, `Bookings ${currLabel}`, `Conv % ${prevLabel}`, `Conv % ${currLabel}`, `Follow-ups Completed ${prevLabel}`, `Follow-ups Completed ${currLabel}`];
  const keys = [...new Set([...curr.byRM.map((s) => s.rm), ...prev.byRM.map((s) => s.rm)])];
  const p = new Map(prev.byRM.map((s) => [s.rm, s]));
  const c = new Map(curr.byRM.map((s) => [s.rm, s]));
  return table(
    'compare-rm',
    'RM comparison',
    range,
    h,
    keys.map((k) => {
      const a = p.get(k), b = c.get(k);
      return row(h, [k, a?.enquiries ?? 0, b?.enquiries ?? 0, a?.siteVisits ?? 0, b?.siteVisits ?? 0, a?.bookings ?? 0, b?.bookings ?? 0, formatPercent(a?.conversionRate ?? 0, 1), formatPercent(b?.conversionRate ?? 0, 1), a?.followupsCompleted ?? 0, b?.followupsCompleted ?? 0]);
    })
  );
}
