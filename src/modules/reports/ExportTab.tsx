/**
 * Reports › Export — filtered lead list (enquiry-date range + stage / source / unit / RM)
 * with a preview and a CSV download. Dates in the file are formatted, never raw.
 */
import React, { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Filter } from 'lucide-react';
import { CRMConfig, Lead } from '../../types/crm';
import { F } from '../../core/config';
import { countedLeads, enquiryDate } from '../../core/analytics';
import { compareDates, formatDate, formatDateTime, inRange } from '../../core/dates';
import { formatNumber } from '../../core/format';
import { toast } from '../../core/notifications';
import { Button, Card, DataTable, DateFilterValue, DateRangeFilter, Field, Select, StageBadge, resolveDateFilter } from '../../components/ui';
import { ReportTable, downloadTable, row, table, useRegisterTables } from './reportShared';

interface Props {
  leads: Lead[];
  config: CRMConfig;
  rm: string;
  onRmChange: (rm: string) => void;
  onOpenLead?: (id: string) => void;
  onTables: (tables: ReportTable[]) => void;
}

const PREVIEW_ROWS = 20;

const EXPORT_HEADERS = [F.ID, F.ENQUIRY_DATE, F.NAME, F.PHONE, F.EMAIL, F.STAGE, F.SOURCE, F.UNIT_TYPE, F.PURCHASE_OR_RENT, F.SITE_VISIT_STATUS, F.SITE_VISIT_DATE, F.BOOKING_DATE, F.NEXT_FOLLOWUP, F.LAST_FOLLOWUP, F.RM, F.BROCHURE, F.RELATIONSHIP, F.ENQUIRED_FOR, F.NOTES];
const DATE_HEADERS = new Set<string>([F.ENQUIRY_DATE, F.SITE_VISIT_DATE, F.BOOKING_DATE, F.NEXT_FOLLOWUP, F.LAST_FOLLOWUP]);

export const ExportTab: React.FC<Props> = ({ leads, config, rm, onRmChange, onOpenLead, onTables }) => {
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ preset: 'all' });
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [unit, setUnit] = useState('');

  const range = useMemo(() => resolveDateFilter(dateFilter), [dateFilter]);
  const counted = useMemo(() => countedLeads(leads), [leads]);

  const filtered = useMemo(
    () =>
      counted
        .filter((l) => {
          if (range && !inRange(enquiryDate(l), range)) return false;
          if (stage && String(l[F.STAGE] || '') !== stage) return false;
          if (source && String(l[F.SOURCE] || '') !== source) return false;
          if (unit && String(l[F.UNIT_TYPE] || '') !== unit) return false;
          if (rm && String(l[F.RM] || '') !== rm) return false;
          return true;
        })
        .sort((a, b) => compareDates(enquiryDate(a), enquiryDate(b), false)),
    [counted, range, stage, source, unit, rm]
  );

  const filterLabel = useMemo(() => {
    const parts = [range ? range.label : 'All time'];
    if (stage) parts.push(stage);
    if (source) parts.push(source);
    if (unit) parts.push(unit);
    if (rm) parts.push(rm);
    return parts.join(' · ');
  }, [range, stage, source, unit, rm]);

  const tables = useMemo<ReportTable[]>(
    () => [
      table(
        'leads-export',
        'Lead export',
        filterLabel,
        EXPORT_HEADERS,
        filtered.map((l) =>
          row(
            EXPORT_HEADERS,
            EXPORT_HEADERS.map((h) => {
              if (h === F.ENQUIRY_DATE) return formatDate(enquiryDate(l));
              if (DATE_HEADERS.has(h)) return formatDateTime(l[h]);
              const v = l[h];
              return v === undefined || v === null ? '' : v;
            })
          )
        )
      ),
    ],
    [filtered, filterLabel]
  );
  useRegisterTables(onTables, tables);

  const download = () => {
    if (!filtered.length) return;
    downloadTable(tables[0]);
    toast('CSV downloaded', `${formatNumber(filtered.length)} leads`, 'success');
  };

  const reset = () => {
    setDateFilter({ preset: 'all' });
    setStage('');
    setSource('');
    setUnit('');
    onRmChange('');
  };

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><Filter size={16} className="text-[#0B6BB0]" />Filters</span>} subtitle="Leads are matched by enquiry date; trashed and deleted leads are never exported" actions={<Button variant="ghost" size="xs" onClick={reset}>Reset</Button>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <Field label="Enquiry date">
            <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
          </Field>
          <Field label="Lead stage">
            <Select value={stage} onChange={(e) => setStage(e.target.value)} options={config.options[F.STAGE] || []} placeholder="All stages" />
          </Field>
          <Field label="Enquiry source">
            <Select value={source} onChange={(e) => setSource(e.target.value)} options={config.options[F.SOURCE] || []} placeholder="All sources" />
          </Field>
          <Field label="Unit type">
            <Select value={unit} onChange={(e) => setUnit(e.target.value)} options={config.options[F.UNIT_TYPE] || []} placeholder="All unit types" />
          </Field>
          <Field label="Assigned RM" hint="Same as the RM filter above">
            <Select value={rm} onChange={(e) => onRmChange(e.target.value)} options={config.options[F.RM] || []} placeholder="All RMs" />
          </Field>
        </div>
        <div className="mt-4 pt-4 border-t border-[#E6EFF6] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-[#0B2A44]">
            Matching leads: <strong className="text-sm font-bold text-[#0B6BB0]">{formatNumber(filtered.length)}</strong> of {formatNumber(counted.length)}
            <span className="text-[#5E778C]"> · {filterLabel}</span>
          </div>
          <Button variant="gold" size="md" onClick={download} disabled={!filtered.length} icon={<FileSpreadsheet size={15} />}>Download CSV ({formatNumber(filtered.length)})</Button>
        </div>
      </Card>

      <Card title="Preview" subtitle={filtered.length > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} of ${formatNumber(filtered.length)} leads — the CSV contains all of them` : `${formatNumber(filtered.length)} lead${filtered.length === 1 ? '' : 's'}`} padded={false} actions={<Button variant="secondary" size="xs" onClick={download} disabled={!filtered.length} icon={<Download size={12} />}>CSV</Button>}>
        <DataTable<Lead>
          dense
          rows={filtered.slice(0, PREVIEW_ROWS)}
          keyFn={(l) => l[F.ID]}
          onRowClick={onOpenLead ? (l) => onOpenLead(l[F.ID]) : undefined}
          empty="No leads match these filters"
          columns={[
            { key: 'id', label: 'ID', render: (l) => <span className="font-mono text-[10px] text-[#0B6BB0]">{l[F.ID]}</span> },
            { key: 'date', label: 'Enquiry Date', render: (l) => <span className="whitespace-nowrap">{formatDate(enquiryDate(l), '—')}</span> },
            { key: 'name', label: 'Prospect', render: (l) => <span className="font-semibold text-[#0B2A44]">{l[F.NAME] || '—'}</span> },
            { key: 'phone', label: 'Phone', render: (l) => <span className="whitespace-nowrap">{l[F.PHONE] || '—'}</span> },
            { key: 'stage', label: 'Stage', render: (l) => <StageBadge stage={l[F.STAGE]} /> },
            { key: 'source', label: 'Source', render: (l) => l[F.SOURCE] || '—' },
            { key: 'unit', label: 'Unit', render: (l) => l[F.UNIT_TYPE] || '—' },
            { key: 'rm', label: 'RM', render: (l) => l[F.RM] || '—' },
            { key: 'next', label: 'Next Follow-up', render: (l) => <span className="whitespace-nowrap">{formatDateTime(l[F.NEXT_FOLLOWUP], '—')}</span> },
          ]}
        />
      </Card>
    </div>
  );
};
