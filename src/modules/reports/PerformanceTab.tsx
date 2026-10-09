/**
 * Reports › Performance — pipeline value, funnel, response-time SLA, RM velocity,
 * daily trend and unit mix for a rolling window (core/pipeline.calculatePerformanceMetrics).
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Award, Calendar, CheckCircle2, Clock, ExternalLink, IndianRupee, Layers, TrendingUp, Users, Zap } from 'lucide-react';
import { Lead } from '../../types/crm';
import { F } from '../../core/config';
import { countedLeads, enquiryDate, isActive, stageOf } from '../../core/analytics';
import { calculatePerformanceMetrics, getLeadEstimatedValue } from '../../core/pipeline';
import { formatDate, inRange } from '../../core/dates';
import { formatHours, formatINR, formatNumber, formatPercent } from '../../core/format';
import { Bar, Button, Card, EmptyState, InlineNotice, StageBadge, cx } from '../../components/ui';
import { ReportTable, SectionNote, row, table, useRegisterTables } from './reportShared';

interface Props {
  leads: Lead[];
  rm?: string;
  onOpenLead?: (id: string) => void;
  onTables: (tables: ReportTable[]) => void;
}

const WINDOWS = [7, 30, 60, 90];

const STAGE_THEME: Record<string, { bar: string; badge: string }> = {
  New: { bar: 'bg-[#0B2A44]', badge: 'bg-[#0B2A44]/10 text-[#0B2A44]' },
  Open: { bar: 'bg-[#3A5D7C]', badge: 'bg-[#3A5D7C]/10 text-[#3A5D7C]' },
  Warm: { bar: 'bg-[#0B6BB0]', badge: 'bg-[#0B6BB0]/15 text-[#0B5E9C]' },
  Hot: { bar: 'bg-[#B06A55]', badge: 'bg-[#B06A55]/15 text-[#8A3E28]' },
  Qualified: { bar: 'bg-[#0E8A86]', badge: 'bg-[#0E8A86]/20 text-[#3C573A]' },
  Booked: { bar: 'bg-[#2E7D32]', badge: 'bg-[#2E7D32]/15 text-[#1B5E20]' },
};

export const PerformanceTab: React.FC<Props> = ({ leads, rm, onOpenLead, onTables }) => {
  const [days, setDays] = useState(30);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);

  const perf = useMemo(() => calculatePerformanceMetrics(leads, days, rm || ''), [leads, days, rm]);
  const rangeLabel = `${formatDate(perf.range.start)} → ${formatDate(perf.range.end)}${rm ? ` · ${rm}` : ''}`;

  // Leads in the window (same selection core/pipeline uses) for the funnel drill-down and top opportunities.
  const windowLeads = useMemo(() => {
    const base = rm ? countedLeads(leads).filter((l) => String(l[F.RM] || '') === rm) : countedLeads(leads);
    return base.filter((l) => inRange(enquiryDate(l), perf.range));
  }, [leads, rm, perf.range]);

  const stageLeads = useMemo(() => (selectedStage ? windowLeads.filter((l) => stageOf(l) === selectedStage || (!stageOf(l) && selectedStage === 'New')) : []), [windowLeads, selectedStage]);

  const topOpportunities = useMemo(
    () => windowLeads.filter(isActive).map((l) => ({ lead: l, value: getLeadEstimatedValue(l) })).sort((a, b) => b.value - a.value).slice(0, 5),
    [windowLeads]
  );

  const tables = useMemo<ReportTable[]>(() => {
    const kh = ['Metric', 'Value'];
    const summary = table('perf-summary', `Performance summary · last ${days} days`, rangeLabel, kh, [
      row(kh, ['Leads in window', perf.leadsInWindow]),
      row(kh, ['Leads without enquiry date (excluded)', perf.leadsWithoutDate]),
      row(kh, ['Total pipeline value', formatINR(perf.totalPipelineValue)]),
      row(kh, ['Weighted pipeline value', formatINR(perf.weightedPipelineValue)]),
      row(kh, ['Average lead value', formatINR(perf.avgLeadValue)]),
      row(kh, ['Previous period pipeline value', perf.previousPeriodPipelineValue === null ? 'n/a' : formatINR(perf.previousPeriodPipelineValue)]),
      row(kh, ['Pipeline growth vs previous period', perf.pipelineGrowthPercent === null ? 'n/a' : formatPercent(perf.pipelineGrowthPercent, 1)]),
      row(kh, ['Deals booked', perf.bookedCount]),
      row(kh, ['Booked value', formatINR(perf.bookedValue)]),
      row(kh, ['Win conversion rate', formatPercent(perf.overallConversionRate, 1)]),
      row(kh, ['Qualification rate', formatPercent(perf.qualificationRate, 1)]),
      row(kh, ['Average first response', formatHours(perf.totalRespondedCount ? perf.avgResponseTimeHours : null)]),
      row(kh, ['Median first response', formatHours(perf.totalRespondedCount ? perf.medianResponseTimeHours : null)]),
      row(kh, ['24h SLA compliance', formatPercent(perf.slaCompliancePercent, 1)]),
      row(kh, ['Responded within 4h', formatPercent(perf.slaLightningFastPercent, 1)]),
      row(kh, ['Awaiting first contact', perf.unrespondedCount]),
    ]);
    const fh = ['Stage', 'Leads', 'Stage Value', 'Weighted Value', 'Pipeline Share %', 'Conversion to Next %', 'Win Rate %'];
    const funnel = table('perf-funnel', `Funnel · last ${days} days`, rangeLabel, fh, perf.funnelMetrics.map((m) => row(fh, [m.stage, m.count, formatINR(m.totalValue), formatINR(m.weightedValue), formatPercent(m.percentageOfPipeline, 1), m.conversionRateToNext, m.cumulativeWinRate])));
    const rh = ['RM', 'Leads', 'Responded', 'Avg Response', 'Median Response', 'SLA 24h %', 'Pipeline Value', 'Booked', 'Booked Value'];
    const rms = table('perf-rm', `RM performance · last ${days} days`, rangeLabel, rh, perf.rmMetrics.map((r) => row(rh, [r.rmName, r.totalLeads, r.respondedLeads, formatHours(r.respondedLeads ? r.avgResponseHours : null), formatHours(r.respondedLeads ? r.medianResponseHours : null), r.slaWithin24hPercent, formatINR(r.totalPipelineValue), r.bookedCount, formatINR(r.bookedValue)])));
    const sh = ['Source', 'Leads', 'Avg Response', 'Conv %', 'Pipeline Value'];
    const sources = table('perf-source', `Source velocity · last ${days} days`, rangeLabel, sh, perf.sourceMetrics.map((s) => row(sh, [s.source, s.totalLeads, formatHours(s.avgResponseHours || null), s.conversionRate, formatINR(s.totalValue)])));
    const dh = ['Date', 'New Leads', 'Value Added', 'Cumulative Value'];
    const daily = table('perf-daily', `Daily pipeline trend · last ${days} days`, rangeLabel, dh, perf.dailyTrend.map((p) => row(dh, [formatDate(p.date), p.newLeads, formatINR(p.addedValue), formatINR(p.cumulativeValue)])));
    const uh = ['Unit Type', 'Leads', 'Pipeline Value', 'Share %'];
    const units = table('perf-units', `Unit mix · last ${days} days`, rangeLabel, uh, perf.unitBreakdown.map((u) => row(uh, [u.unitType, u.count, formatINR(u.value), u.sharePercent])));
    return [summary, funnel, rms, sources, daily, units];
  }, [perf, days, rangeLabel]);
  useRegisterTables(onTables, tables);

  const growth = perf.pipelineGrowthPercent;
  const maxFunnel = Math.max(1, ...perf.funnelMetrics.map((m) => m.count));
  const maxDaily = Math.max(1, ...perf.dailyTrend.map((p) => p.addedValue));
  const noData = perf.leadsInWindow === 0;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <Card padded>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#5E778C]"><Calendar size={14} className="text-[#0B6BB0]" />Timeframe</span>
            <div className="inline-flex rounded-lg border border-[#D3E3F0] bg-[#F2F7FB] p-0.5">
              {WINDOWS.map((d) => (
                <button key={d} onClick={() => { setDays(d); setSelectedStage(null); }} className={cx('px-3 py-1.5 text-xs font-semibold rounded-md transition', days === d ? 'bg-[#0B2A44] text-white shadow-2xs' : 'text-[#5E778C] hover:text-[#0B2A44]')}>
                  Last {d} days
                </button>
              ))}
            </div>
          </div>
          <div className="text-xs text-[#5E778C]">
            {formatDate(perf.range.start)} → {formatDate(perf.range.end)} · <strong className="text-[#0B2A44]">{formatNumber(perf.leadsInWindow)}</strong> leads in window · {formatNumber(perf.totalActiveLeads)} counted overall
          </div>
        </div>
        {perf.leadsWithoutDate > 0 && (
          <InlineNotice tone="warning" className="mt-3">
            {formatNumber(perf.leadsWithoutDate)} lead{perf.leadsWithoutDate === 1 ? ' has' : 's have'} no enquiry date and {perf.leadsWithoutDate === 1 ? 'is' : 'are'} excluded from this report. Add the Enquiry Date on the lead profile to include {perf.leadsWithoutDate === 1 ? 'it' : 'them'}.
          </InlineNotice>
        )}
      </Card>

      {noData ? (
        <Card>
          <EmptyState title={`No enquiries in the last ${days} days`} description="Widen the timeframe or clear the RM filter to see pipeline and response-time metrics." icon={<TrendingUp size={22} />} />
        </Card>
      ) : (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              label={`Total Pipeline Value (${days}D)`}
              icon={<IndianRupee size={16} />}
              iconCls="bg-[#0B6BB0]/15 text-[#0B5E9C]"
              value={formatINR(perf.totalPipelineValue)}
              footLeft={<>Weighted: <strong className="text-[#0B2A44]">{formatINR(perf.weightedPipelineValue)}</strong></>}
              footRight={
                growth === null ? (
                  <span className="text-[#7E93A6] font-semibold" title="No leads in the previous period to compare against">n/a vs prior</span>
                ) : (
                  <span className={cx('inline-flex items-center gap-0.5 font-bold', growth >= 0 ? 'text-[#2E7D32]' : 'text-[#B06A55]')}>
                    {growth >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                    {Math.abs(growth).toFixed(1)}% vs prior
                  </span>
                )
              }
              note={`${formatNumber(perf.leadsInWindow)} prospects · avg ${formatINR(perf.avgLeadValue)} · prior period ${perf.previousPeriodPipelineValue === null ? 'n/a' : formatINR(perf.previousPeriodPipelineValue)}`}
            />
            <MetricCard
              label="Win Conversion Rate"
              icon={<Award size={16} />}
              iconCls="bg-[#0E8A86]/20 text-[#3C573A]"
              value={<span className="text-[#2E7D32]">{formatPercent(perf.overallConversionRate, 1)}</span>}
              footLeft={<>Booked: <strong className="text-[#0B2A44]">{perf.bookedCount} unit{perf.bookedCount === 1 ? '' : 's'}</strong></>}
              footRight={<span className="font-semibold text-[#2E7D32]">{formatINR(perf.bookedValue)}</span>}
              note={<>Qualification rate: <strong>{formatPercent(perf.qualificationRate, 1)}</strong> (Qualified + Booked)</>}
            />
            <MetricCard
              label="Avg Lead Response Time"
              icon={<Clock size={16} />}
              iconCls="bg-[#0B2A44]/10 text-[#0B2A44]"
              value={formatHours(perf.totalRespondedCount ? perf.avgResponseTimeHours : null)}
              footLeft={<>Median: <strong className="text-[#0B2A44]">{formatHours(perf.totalRespondedCount ? perf.medianResponseTimeHours : null)}</strong></>}
              footRight={
                <span className={cx('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold', perf.slaCompliancePercent >= 80 ? 'bg-[#2E7D32]/10 text-[#2E7D32]' : 'bg-[#D97706]/10 text-[#92400E]')}>
                  {perf.slaCompliancePercent.toFixed(0)}% within 24h
                </span>
              }
              note={<>{perf.totalRespondedCount} responded · <span className={perf.unrespondedCount > 0 ? 'text-[#B06A55] font-semibold' : ''}>{perf.unrespondedCount} awaiting first contact</span></>}
            />
            <MetricCard
              label="First Touch Velocity"
              icon={<Zap size={16} />}
              iconCls="bg-[#0B6BB0]/15 text-[#0B5E9C]"
              value={<span className="text-[#0B5E9C]">{perf.slaLightningFastPercent.toFixed(0)}%</span>}
              footLeft={<>Under 4 hours: <strong className="text-[#0B2A44]">{(perf.slaBuckets[0]?.count || 0) + (perf.slaBuckets[1]?.count || 0)} leads</strong></>}
              footRight={<span className="text-[11px] text-[#5E778C]">{perf.unrespondedCount === 0 ? 'All contacted' : 'Attention needed'}</span>}
              note="Share of responded leads contacted within 4 hours"
            />
          </div>

          {/* Funnel */}
          <Card
            title={<span className="inline-flex items-center gap-2"><Layers size={17} className="text-[#0B6BB0]" />Conversion by stage & sales funnel</span>}
            subtitle="Stage-to-stage advancement for the leads enquired in the window; click a stage to list its leads"
            actions={<span className="text-xs text-[#5E778C] bg-[#F2F7FB] px-3 py-1.5 rounded-lg border border-[#D3E3F0]/60">Funnel leads: <strong className="text-[#0B2A44]">{formatNumber(perf.leadsInWindow)}</strong></span>}
          >
            <div className="space-y-2.5">
              {perf.funnelMetrics.map((m, i) => {
                const theme = STAGE_THEME[m.stage] || { bar: 'bg-stone-500', badge: 'bg-stone-100 text-stone-700' };
                const selected = selectedStage === m.stage;
                const next = perf.funnelMetrics[i + 1];
                return (
                  <button
                    key={m.stage}
                    onClick={() => setSelectedStage(selected ? null : m.stage)}
                    className={cx('w-full text-left p-3.5 rounded-xl border transition', selected ? 'border-[#0B6BB0] bg-[#F7FAFD] ring-2 ring-[#0B6BB0]/20' : 'border-[#E6EFF6] hover:border-[#D3E3F0] hover:bg-[#FFFFFF]')}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-5 h-5 rounded-full bg-[#E6EFF6] text-[10px] font-bold text-[#5E778C] flex items-center justify-center flex-shrink-0">{i + 1}</span>
                        <span className="font-bold text-sm text-[#0B2A44]">{m.stage}</span>
                        <span className={cx('px-2 py-0.5 rounded text-[10px] font-bold', theme.badge)}>{m.count} prospect{m.count === 1 ? '' : 's'}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs flex-wrap">
                        <span className="text-[#5E778C]">Value <strong className="text-[#0B2A44]">{formatINR(m.totalValue)}</strong></span>
                        <span className="text-[#5E778C]">Share <strong className="text-[#0B2A44]">{formatPercent(m.percentageOfPipeline, 1)}</strong></span>
                        {next ? (
                          <span className="font-bold text-[#2E7D32] bg-[#E8F5E9] px-2 py-0.5 rounded text-[11px]">↓ {m.conversionRateToNext}% to {next.stage}</span>
                        ) : (
                          <span className="font-bold text-white bg-[#2E7D32] px-2 py-0.5 rounded text-[11px] inline-flex items-center gap-1"><CheckCircle2 size={12} />Won</span>
                        )}
                        <span className="text-[10px] text-[#7E93A6]">win rate {m.cumulativeWinRate}%</span>
                      </div>
                    </div>
                    <div className="w-full bg-[#E3EDF5] h-3 rounded-full overflow-hidden">
                      <div className={cx('h-full rounded-full transition-all duration-500', theme.bar)} style={{ width: `${Math.max(m.count ? 6 : 0, Math.round((m.count / maxFunnel) * 100))}%` }} />
                    </div>
                  </button>
                );
              })}
            </div>

            {selectedStage && (
              <div className="mt-4 p-4 rounded-xl bg-[#F7FAFD] border border-[#0B6BB0]/40">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#0B6BB0]">{selectedStage} · {formatNumber(stageLeads.length)} lead{stageLeads.length === 1 ? '' : 's'} in window</span>
                  <Button variant="ghost" size="xs" onClick={() => setSelectedStage(null)}>Close</Button>
                </div>
                {stageLeads.length === 0 ? (
                  <p className="text-xs text-[#5E778C] italic">No leads from this period are currently in this stage.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {stageLeads.slice(0, 30).map((l) => (
                      <LeadMiniCard key={l[F.ID]} lead={l} onOpenLead={onOpenLead} />
                    ))}
                    {stageLeads.length > 30 && <div className="text-xs text-[#5E778C] self-center">+ {stageLeads.length - 30} more — use the Export tab for the full list.</div>}
                  </div>
                )}
              </div>
            )}

            {perf.disqualifiedBreakdown.length > 0 && (
              <div className="border-t border-[#E6EFF6] pt-4 mt-5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#B06A55] block mb-2.5">Drop-off & disqualification</span>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5">
                  {perf.disqualifiedBreakdown.map((d) => (
                    <div key={d.reason} className="p-2.5 rounded-lg bg-[#FAF0EC] border border-[#B06A55]/20 text-xs">
                      <div className="text-[10px] text-[#8A3E28] font-semibold truncate" title={d.reason}>{d.reason}</div>
                      <div className="text-lg font-bold text-[#8A3E28] mt-0.5">{d.count}</div>
                      <div className="text-[10px] text-[#B06A55] font-medium">{formatINR(d.value)} lost</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Response time & RM */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card
              title={<span className="inline-flex items-center gap-2"><Clock size={16} className="text-[#0B6BB0]" />Response time & SLA</span>}
              subtitle="From enquiry to the first logged follow-up"
              actions={<div className="text-right"><div className="text-xl font-bold text-[#0B2A44]">{formatHours(perf.totalRespondedCount ? perf.avgResponseTimeHours : null)}</div><div className="text-[10px] text-[#5E778C]">average</div></div>}
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {perf.slaBuckets.map((b) => (
                  <div key={b.label} className="p-3 rounded-xl border border-[#E6EFF6] bg-[#FFFFFF] shadow-2xs">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: b.color }} />
                      <span className="text-[10px] font-bold text-[#5E778C] truncate" title={b.label}>{b.label}</span>
                    </div>
                    <div className="text-xl font-bold text-[#0B2A44]">{b.count}</div>
                    <div className="text-[10px] text-[#7E93A6] mt-0.5">{b.percent}% of window</div>
                  </div>
                ))}
              </div>
              <InlineNotice className="mt-4 flex items-start gap-2.5">
                <Zap size={15} className="text-[#0B6BB0] flex-shrink-0 mt-0.5" />
                <span><strong className="text-[#0B2A44]">Benchmark:</strong> prospects contacted within 2 hours are far more likely to schedule a site visit than those contacted after a day.</span>
              </InlineNotice>
              {perf.unrespondedLeads.length > 0 && (
                <div className="mt-4 pt-3 border-t border-[#E6EFF6]">
                  <div className="text-xs font-bold text-[#B06A55] inline-flex items-center gap-1.5 mb-2"><AlertTriangle size={14} />{perf.unrespondedLeads.length} prospect{perf.unrespondedLeads.length === 1 ? '' : 's'} awaiting first contact</div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                    {perf.unrespondedLeads.slice(0, 8).map((l) => {
                      const Tag: any = onOpenLead ? 'button' : 'div';
                      return (
                        <Tag key={l[F.ID]} onClick={onOpenLead ? () => onOpenLead(l[F.ID]) : undefined} className={cx('w-full text-left flex items-center justify-between p-2 rounded-lg bg-[#FAF0EC] border border-[#B06A55]/30 text-xs', onOpenLead && 'hover:bg-[#F7E6DF]')}>
                          <div className="truncate"><strong className="text-[#0B2A44]">{l[F.NAME] || '—'}</strong> <span className="text-[#5E778C] font-mono">({l[F.ID]})</span> <span className="text-[#7E93A6]">· {formatDate(enquiryDate(l), '—')}</span></div>
                          <div className="text-[11px] text-[#8A3E28] font-semibold whitespace-nowrap ml-2">RM {l[F.RM] || '—'}</div>
                        </Tag>
                      );
                    })}
                    {perf.unrespondedLeads.length > 8 && <div className="text-[11px] text-[#5E778C] px-1">+ {perf.unrespondedLeads.length - 8} more</div>}
                  </div>
                </div>
              )}
            </Card>

            <Card title={<span className="inline-flex items-center gap-2"><Users size={16} className="text-[#0B6BB0]" />Relationship manager performance</span>} subtitle="Response time, 24h SLA and closed pipeline by RM" padded={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#E6EFF6] border-b border-[#D3E3F0] text-[10px] uppercase font-bold text-[#5E778C] text-left">
                      <th className="p-2.5 pl-5">RM</th><th className="p-2.5 text-right">Leads</th><th className="p-2.5 text-right">Avg Response</th><th className="p-2.5 text-center">SLA 24h</th><th className="p-2.5 text-right">Pipeline</th><th className="p-2.5 pr-5 text-right">Booked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6EFF6]">
                    {perf.rmMetrics.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-[#7E93A6]">No RM activity in this window</td></tr>}
                    {perf.rmMetrics.map((r) => (
                      <tr key={r.rmName} className="hover:bg-[#F7FAFD]">
                        <td className="p-2.5 pl-5 font-bold text-[#0B2A44] whitespace-nowrap">{r.rmName}</td>
                        <td className="p-2.5 text-right">{r.totalLeads} <span className="text-[10px] text-[#7E93A6]">({r.respondedLeads} resp.)</span></td>
                        <td className="p-2.5 text-right font-medium text-[#0B2A44] whitespace-nowrap">{formatHours(r.respondedLeads ? r.avgResponseHours : null)}</td>
                        <td className="p-2.5 text-center">
                          <span className={cx('px-2 py-0.5 rounded text-[10px] font-bold', !r.respondedLeads ? 'bg-[#E6EFF6] text-[#5E778C]' : r.slaWithin24hPercent >= 80 ? 'bg-[#E8F5E9] text-[#2E7D32]' : r.slaWithin24hPercent >= 50 ? 'bg-[#FFF8E1] text-[#92400E]' : 'bg-[#FAF0EC] text-[#8A3E28]')}>
                            {r.respondedLeads ? `${r.slaWithin24hPercent}%` : '—'}
                          </span>
                        </td>
                        <td className="p-2.5 text-right font-medium text-[#0B2A44] whitespace-nowrap">{formatINR(r.totalPipelineValue)}</td>
                        <td className="p-2.5 pr-5 text-right font-bold text-[#2E7D32] whitespace-nowrap">{r.bookedCount > 0 ? `${r.bookedCount} (${formatINR(r.bookedValue)})` : <span className="text-[#7E93A6]">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="p-5 pt-4 border-t border-[#E6EFF6]">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#5E778C] block mb-2">Response velocity by channel</span>
                {perf.sourceMetrics.length === 0 ? (
                  <div className="text-xs text-[#7E93A6]">No sources in this window</div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {perf.sourceMetrics.slice(0, 8).map((s) => (
                      <div key={s.source} className="p-2 rounded-lg bg-[#F2F7FB] text-xs">
                        <div className="text-[10px] font-semibold text-[#5E778C] truncate" title={s.source}>{s.source}</div>
                        <div className="font-bold text-[#0B2A44] mt-0.5">{formatHours(s.avgResponseHours || null)}</div>
                        <div className="text-[10px] text-[#0B6BB0]">{s.totalLeads} leads · {s.conversionRate}% won</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Daily trend, unit mix, top opportunities */}
          <Card
            title={<span className="inline-flex items-center gap-2"><TrendingUp size={17} className="text-[#0B6BB0]" />Pipeline value trend · last {days} days</span>}
            subtitle="Estimated value of new enquiries per day and the running total"
            actions={<div className="text-right"><div className="text-[10px] text-[#5E778C] uppercase tracking-wider">Cumulative</div><div className="text-xl font-bold text-[#0B2A44]">{formatINR(perf.totalPipelineValue)}</div></div>}
          >
            <div className="flex items-center justify-between text-[10px] text-[#5E778C] mb-2 font-medium">
              <span>{perf.dailyTrend.length < days ? `Last ${perf.dailyTrend.length} days charted` : 'Daily value added'}</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-[#0B6BB0]" />New value</span>
            </div>
            <div className="h-44 flex items-end gap-1 pt-4 pb-2 border-b border-[#E6EFF6]">
              {perf.dailyTrend.map((p) => (
                <div key={p.date} className="flex-1 flex flex-col items-center justify-end h-full group relative min-w-0">
                  <div className="absolute -top-14 opacity-0 group-hover:opacity-100 transition pointer-events-none z-20 bg-[#0B2A44] text-white p-2 rounded shadow-lg text-[10px] whitespace-nowrap text-center">
                    <div className="font-bold text-[#C4D8EA]">{formatDate(p.date)}</div>
                    <div>Added {formatINR(p.addedValue)}</div>
                    <div className="text-[#7E93A6]">{p.newLeads} new lead{p.newLeads === 1 ? '' : 's'} · total {formatINR(p.cumulativeValue)}</div>
                  </div>
                  <div className={cx('w-full rounded-t transition-all duration-300', p.addedValue > 0 ? 'bg-[#0B6BB0] group-hover:bg-[#0B5E9C]' : 'bg-[#E6EFF6]')} style={{ height: `${p.addedValue > 0 ? Math.max(8, Math.round((p.addedValue / maxDaily) * 100)) : 3}%` }} />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[10px] text-[#7E93A6] pt-1">
              <span>{perf.dailyTrend[0] ? formatDate(perf.dailyTrend[0].date) : ''}</span>
              <span>{perf.dailyTrend[Math.floor(perf.dailyTrend.length / 2)] ? formatDate(perf.dailyTrend[Math.floor(perf.dailyTrend.length / 2)].date) : ''}</span>
              <span>{perf.dailyTrend.length ? formatDate(perf.dailyTrend[perf.dailyTrend.length - 1].date) : ''}</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-5 mt-5 border-t border-[#E6EFF6]">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#5E778C] block mb-3">Pipeline value by unit type</span>
                {perf.unitBreakdown.length === 0 ? (
                  <div className="text-xs text-[#7E93A6]">No unit preferences recorded</div>
                ) : (
                  <div className="space-y-2.5">
                    {perf.unitBreakdown.map((u) => (
                      <div key={u.unitType}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-bold text-[#0B2A44]">{u.unitType}</span>
                          <span className="text-[#5E778C]">{u.count} lead{u.count === 1 ? '' : 's'} · <strong className="text-[#0B2A44]">{formatINR(u.value)}</strong> · <span className="text-[#0B6BB0] font-bold">{u.sharePercent}%</span></span>
                        </div>
                        <Bar value={u.sharePercent} max={100} />
                      </div>
                    ))}
                  </div>
                )}
                <SectionNote>Values are indicative (unit-type list prices, or a budget mentioned in the notes).</SectionNote>
              </div>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#5E778C]">Top active opportunities</span>
                  <span className="text-[10px] text-[#0B6BB0] font-semibold">in window</span>
                </div>
                {topOpportunities.length === 0 ? (
                  <div className="text-xs text-[#7E93A6]">No open leads in this window</div>
                ) : (
                  <div className="space-y-2">
                    {topOpportunities.map(({ lead: l, value }) => {
                      const Tag: any = onOpenLead ? 'button' : 'div';
                      return (
                        <Tag key={l[F.ID]} onClick={onOpenLead ? () => onOpenLead(l[F.ID]) : undefined} className={cx('w-full text-left flex items-center justify-between p-2.5 rounded-xl border border-[#E6EFF6] bg-[#FFFFFF] text-xs', onOpenLead && 'cursor-pointer hover:border-[#0B6BB0] hover:shadow-2xs transition')}>
                          <div className="min-w-0">
                            <div className="font-bold text-[#0B2A44] truncate">{l[F.NAME] || '—'} <span className="font-mono text-[10px] text-[#0B6BB0] ml-1">{l[F.ID]}</span></div>
                            <div className="text-[10px] text-[#5E778C] mt-0.5 truncate">{l[F.UNIT_TYPE] || 'Unit —'} · RM {l[F.RM] || '—'} · {l[F.SOURCE] || '—'}</div>
                          </div>
                          <div className="text-right flex-shrink-0 ml-3">
                            <div className="font-bold text-[#0B2A44]">{formatINR(value)}</div>
                            <StageBadge stage={l[F.STAGE]} />
                          </div>
                        </Tag>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
};

/* ------------------------------ sub-components --------------------------- */

const MetricCard: React.FC<{ label: string; icon: React.ReactNode; iconCls: string; value: React.ReactNode; footLeft: React.ReactNode; footRight: React.ReactNode; note: React.ReactNode }> = ({ label, icon, iconCls, value, footLeft, footRight, note }) => (
  <div className="bg-white rounded-2xl p-5 border border-[#D3E3F0] shadow-xs hover:border-[#0B6BB0]/50 transition">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-bold uppercase tracking-wider text-[#5E778C] truncate">{label}</span>
      <div className={cx('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', iconCls)}>{icon}</div>
    </div>
    <div className="mt-3">
      <div className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight truncate">{value}</div>
      <div className="flex items-center justify-between gap-2 text-xs mt-2 pt-2 border-t border-[#E6EFF6]">
        <span className="text-[#5E778C] truncate">{footLeft}</span>
        <span className="flex-shrink-0">{footRight}</span>
      </div>
      <div className="text-[11px] text-[#7E93A6] mt-1 truncate">{note}</div>
    </div>
  </div>
);

const LeadMiniCard: React.FC<{ lead: Lead; onOpenLead?: (id: string) => void }> = ({ lead: l, onOpenLead }) => {
  const Tag: any = onOpenLead ? 'button' : 'div';
  return (
    <Tag onClick={onOpenLead ? () => onOpenLead(l[F.ID]) : undefined} className={cx('p-3 rounded-lg bg-white border border-[#D3E3F0] shadow-2xs text-xs text-left flex flex-col justify-between', onOpenLead && 'cursor-pointer hover:border-[#0B6BB0] hover:shadow-xs transition')}>
      <div>
        <div className="flex items-center justify-between font-bold text-[#0B2A44] gap-2">
          <span className="truncate">{l[F.NAME] || '—'}</span>
          <span className="text-[10px] text-[#0B6BB0] font-mono flex-shrink-0">{l[F.ID]}</span>
        </div>
        <div className="text-[11px] text-[#5E778C] mt-1 flex items-center justify-between gap-2">
          <span>{l[F.UNIT_TYPE] || 'Unit —'}</span>
          <span className="font-semibold text-[#0B2A44]">{formatINR(getLeadEstimatedValue(l))}</span>
        </div>
        <div className="text-[10px] text-[#7E93A6] mt-1 truncate">RM {l[F.RM] || '—'} · {l[F.SOURCE] || '—'} · {formatDate(enquiryDate(l), '—')}</div>
      </div>
      {onOpenLead && (
        <div className="mt-2 pt-2 border-t border-[#E6EFF6] text-[10px] font-bold text-[#0B6BB0] flex items-center justify-between">
          <span>Open lead profile</span>
          <ExternalLink size={11} />
        </div>
      )}
    </Tag>
  );
};
