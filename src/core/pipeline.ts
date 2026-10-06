/**
 * Pipeline-value & response-time analytics (the "Performance" report).
 * Ported from the old services/performanceAnalytics.ts with these fixes:
 *  - leads with blank/invalid Enquiry Date are excluded from time-window reports
 *    (they were previously included, inflating counts)
 *  - the previous period is never fabricated (old code used 85% of current when zero)
 *  - all dates go through core/dates (CRM time zone), no UTC string slicing
 *  - "Last Follow-up Date & Time" is no longer treated as a first response
 */
import { Lead } from '../types/crm';
import { DEFAULT_UNIT_PRICE, F, FUNNEL_STAGES, STAGE_CLASS, STAGE_WEIGHTS, STAGES, UNIT_TYPE_PRICES } from './config';
import { DateRange, addDays, dateKey, endOfDay, inRange, startOfDay, getParts } from './dates';
import { countedLeads, enquiryDate, isBooked, responseTimeHours, stageOf } from './analytics';

export function getLeadEstimatedValue(lead: Lead): number {
  const dv = lead['Deal Value'];
  if (typeof dv === 'number' && dv > 0) return dv;
  if (typeof dv === 'string' && /^\d+(\.\d+)?$/.test(dv.trim()) && Number(dv) > 0) return Number(dv);

  const notes = `${lead[F.NOTES] || ''} ${lead['Budget'] || ''}`;
  const cr = notes.match(/(\d+(?:\.\d+)?)\s*(?:Cr|Crore)s?\b/i);
  if (cr) {
    const n = parseFloat(cr[1]);
    if (n > 0 && n < 100) return n * 1e7;
  }
  const lk = notes.match(/(\d+(?:\.\d+)?)\s*(?:L|Lakh|Lac)s?\b/i);
  if (lk) {
    const n = parseFloat(lk[1]);
    if (n > 0 && n < 10000) return n * 1e5;
  }
  const unit = String(lead[F.UNIT_TYPE] || '').trim();
  return UNIT_TYPE_PRICES[unit] || DEFAULT_UNIT_PRICE;
}

export interface StagePerformanceMetric {
  stage: string;
  count: number;
  totalValue: number;
  weightedValue: number;
  percentageOfPipeline: number;
  conversionRateToNext: number;
  cumulativeWinRate: number;
}

export interface RMResponseMetric {
  rmName: string;
  totalLeads: number;
  respondedLeads: number;
  avgResponseHours: number;
  medianResponseHours: number;
  slaWithin24hPercent: number;
  totalPipelineValue: number;
  bookedCount: number;
  bookedValue: number;
}

export interface SourceResponseMetric {
  source: string;
  totalLeads: number;
  avgResponseHours: number;
  conversionRate: number;
  totalValue: number;
}

export interface DailyTrendPoint {
  date: string;
  displayDate: string;
  newLeads: number;
  addedValue: number;
  cumulativeValue: number;
}

export interface PerformanceReportData {
  timeWindowDays: number;
  range: DateRange;
  totalActiveLeads: number;
  leadsInWindow: number;
  leadsWithoutDate: number;
  totalPipelineValue: number;
  weightedPipelineValue: number;
  avgLeadValue: number;
  bookedCount: number;
  bookedValue: number;
  previousPeriodPipelineValue: number | null;
  pipelineGrowthPercent: number | null;
  overallConversionRate: number;
  qualificationRate: number;
  funnelMetrics: StagePerformanceMetric[];
  disqualifiedBreakdown: Array<{ reason: string; count: number; value: number }>;
  avgResponseTimeHours: number;
  medianResponseTimeHours: number;
  slaCompliancePercent: number;
  slaLightningFastPercent: number;
  totalRespondedCount: number;
  unrespondedCount: number;
  unrespondedLeads: Lead[];
  slaBuckets: Array<{ label: string; count: number; percent: number; color: string }>;
  rmMetrics: RMResponseMetric[];
  sourceMetrics: SourceResponseMetric[];
  dailyTrend: DailyTrendPoint[];
  unitBreakdown: Array<{ unitType: string; count: number; value: number; sharePercent: number }>;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function calculatePerformanceMetrics(
  leads: Lead[],
  daysWindow = 30,
  rmFilter = '',
  referenceDate?: Date
): PerformanceReportData {
  const now = referenceDate || new Date();
  const end = endOfDay(now);
  const start = startOfDay(addDays(now, -(daysWindow - 1)));
  const range: DateRange = { start, end, label: `Last ${daysWindow} days` };
  const prevRange: DateRange = {
    start: startOfDay(addDays(start, -daysWindow)),
    end: new Date(start.getTime() - 1),
    label: 'Previous period',
  };

  const allActive = countedLeads(leads);
  const filtered = rmFilter ? allActive.filter((l) => String(l[F.RM] || '') === rmFilter) : allActive;

  const withDate = filtered.filter((l) => !!enquiryDate(l));
  const leadsWithoutDate = filtered.length - withDate.length;
  const target = withDate.filter((l) => inRange(enquiryDate(l), range));
  const prev = withDate.filter((l) => inRange(enquiryDate(l), prevRange));

  let totalPipelineValue = 0;
  let weightedPipelineValue = 0;
  let bookedCount = 0;
  let bookedValue = 0;
  const unitMap: Record<string, { count: number; value: number }> = {};
  const stageCounts: Record<string, number> = {};
  const stageValues: Record<string, number> = {};

  for (const lead of target) {
    const val = getLeadEstimatedValue(lead);
    const stage = stageOf(lead) || STAGES.NEW;
    totalPipelineValue += val;
    weightedPipelineValue += val * (STAGE_WEIGHTS[stage] ?? 0);
    if (isBooked(lead)) {
      bookedCount++;
      bookedValue += val;
    }
    const unit = String(lead[F.UNIT_TYPE] || 'Other').trim() || 'Other';
    unitMap[unit] = unitMap[unit] || { count: 0, value: 0 };
    unitMap[unit].count++;
    unitMap[unit].value += val;
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;
    stageValues[stage] = (stageValues[stage] || 0) + val;
  }

  const prevPipelineValue = prev.length ? prev.reduce((a, l) => a + getLeadEstimatedValue(l), 0) : null;
  const pipelineGrowthPercent =
    prevPipelineValue && prevPipelineValue > 0 ? ((totalPipelineValue - prevPipelineValue) / prevPipelineValue) * 100 : null;

  const avgLeadValue = target.length ? totalPipelineValue / target.length : 0;
  const overallConversionRate = target.length ? (bookedCount / target.length) * 100 : 0;
  const qualifiedOrBooked = target.filter((l) => ([STAGES.QUALIFIED, STAGES.BOOKED] as string[]).includes(stageOf(l))).length;
  const qualificationRate = target.length ? (qualifiedOrBooked / target.length) * 100 : 0;

  const rank: Record<string, number> = {};
  FUNNEL_STAGES.forEach((s, i) => (rank[s] = i + 1));
  const ranked = target.map((l) => rank[stageOf(l)] || 1);
  const funnelMetrics: StagePerformanceMetric[] = FUNNEL_STAGES.map((stage, idx) => {
    const r = rank[stage];
    const reached = ranked.filter((x) => x >= r).length;
    const reachedNext = ranked.filter((x) => x >= r + 1).length;
    const stageVal = stageValues[stage] || 0;
    return {
      stage,
      count: stageCounts[stage] || 0,
      totalValue: stageVal,
      weightedValue: stageVal * (STAGE_WEIGHTS[stage] || 0),
      percentageOfPipeline: totalPipelineValue ? (stageVal / totalPipelineValue) * 100 : 0,
      conversionRateToNext: reached ? Math.min(100, Math.round((reachedNext / reached) * 100)) : idx === FUNNEL_STAGES.length - 1 ? 100 : 0,
      cumulativeWinRate: reached ? Math.min(100, Math.round((bookedCount / reached) * 100)) : 0,
    };
  });

  const disqualifiedBreakdown = STAGE_CLASS.lost
    .map((reason) => ({ reason, count: stageCounts[reason] || 0, value: stageValues[reason] || 0 }))
    .filter((d) => d.count > 0);

  // Response time
  const times: number[] = [];
  const unresponded: Lead[] = [];
  let b1 = 0, b4 = 0, b24 = 0, b48 = 0, bOver = 0;
  for (const lead of target) {
    const h = responseTimeHours(lead);
    if (h === null) {
      if (!isBooked(lead)) unresponded.push(lead);
      continue;
    }
    times.push(h);
    if (h < 1) b1++;
    else if (h <= 4) b4++;
    else if (h <= 24) b24++;
    else if (h <= 48) b48++;
    else bOver++;
  }
  const avgResponseTimeHours = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const slaCompliancePercent = times.length ? ((b1 + b4 + b24) / times.length) * 100 : 0;
  const slaLightningFastPercent = times.length ? ((b1 + b4) / times.length) * 100 : 0;
  const evaluated = target.length || 1;
  const slaBuckets = [
    { label: '< 1 hr (Lightning)', count: b1, percent: Math.round((b1 / evaluated) * 100), color: '#2E7D32' },
    { label: '1 - 4 hrs (Fast)', count: b4, percent: Math.round((b4 / evaluated) * 100), color: '#7C8B78' },
    { label: '4 - 24 hrs (Same Day)', count: b24, percent: Math.round((b24 / evaluated) * 100), color: '#A9825A' },
    { label: '24 - 48 hrs (Delayed)', count: b48, percent: Math.round((b48 / evaluated) * 100), color: '#D97706' },
    { label: '> 48 hrs (Critical)', count: bOver, percent: Math.round((bOver / evaluated) * 100), color: '#B06A55' },
    { label: 'Pending Response', count: unresponded.length, percent: Math.round((unresponded.length / evaluated) * 100), color: '#9E948D' },
  ];

  // RM metrics
  const rmMap: Record<string, { leads: Lead[]; times: number[]; booked: number; bookedValue: number; value: number }> = {};
  for (const lead of target) {
    const rm = String(lead[F.RM] || '').trim() || 'Unassigned';
    rmMap[rm] = rmMap[rm] || { leads: [], times: [], booked: 0, bookedValue: 0, value: 0 };
    const v = getLeadEstimatedValue(lead);
    rmMap[rm].leads.push(lead);
    rmMap[rm].value += v;
    if (isBooked(lead)) {
      rmMap[rm].booked++;
      rmMap[rm].bookedValue += v;
    }
    const h = responseTimeHours(lead);
    if (h !== null) rmMap[rm].times.push(h);
  }
  const rmMetrics: RMResponseMetric[] = Object.keys(rmMap)
    .map((rmName) => {
      const d = rmMap[rmName];
      return {
        rmName,
        totalLeads: d.leads.length,
        respondedLeads: d.times.length,
        avgResponseHours: d.times.length ? d.times.reduce((a, b) => a + b, 0) / d.times.length : 0,
        medianResponseHours: median(d.times),
        slaWithin24hPercent: d.times.length ? Math.round((d.times.filter((t) => t <= 24).length / d.times.length) * 100) : 0,
        totalPipelineValue: d.value,
        bookedCount: d.booked,
        bookedValue: d.bookedValue,
      };
    })
    .sort((a, b) => b.totalLeads - a.totalLeads);

  // Source metrics
  const srcMap: Record<string, { leads: Lead[]; times: number[]; booked: number; value: number }> = {};
  for (const lead of target) {
    const src = String(lead[F.SOURCE] || '').trim() || 'Other';
    srcMap[src] = srcMap[src] || { leads: [], times: [], booked: 0, value: 0 };
    srcMap[src].leads.push(lead);
    srcMap[src].value += getLeadEstimatedValue(lead);
    if (isBooked(lead)) srcMap[src].booked++;
    const h = responseTimeHours(lead);
    if (h !== null) srcMap[src].times.push(h);
  }
  const sourceMetrics: SourceResponseMetric[] = Object.keys(srcMap)
    .map((source) => {
      const s = srcMap[source];
      return {
        source,
        totalLeads: s.leads.length,
        avgResponseHours: s.times.length ? s.times.reduce((a, b) => a + b, 0) / s.times.length : 0,
        conversionRate: s.leads.length ? Math.round((s.booked / s.leads.length) * 100) : 0,
        totalValue: s.value,
      };
    })
    .sort((a, b) => b.totalLeads - a.totalLeads);

  // Daily trend (max 31 points)
  const trendDays = Math.min(31, Math.max(7, daysWindow));
  const byDay: Record<string, Lead[]> = {};
  for (const l of target) {
    const k = dateKey(enquiryDate(l));
    (byDay[k] = byDay[k] || []).push(l);
  }
  const dailyTrend: DailyTrendPoint[] = [];
  let running = 0;
  for (let i = trendDays - 1; i >= 0; i--) {
    const day = addDays(startOfDay(now), -i);
    const k = dateKey(day);
    const list = byDay[k] || [];
    const added = list.reduce((a, l) => a + getLeadEstimatedValue(l), 0);
    running += added;
    const p = getParts(day);
    dailyTrend.push({
      date: k,
      displayDate: `${p.d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.m - 1]}`,
      newLeads: list.length,
      addedValue: added,
      cumulativeValue: running,
    });
  }

  const unitBreakdown = Object.keys(unitMap)
    .map((unitType) => ({
      unitType,
      count: unitMap[unitType].count,
      value: unitMap[unitType].value,
      sharePercent: totalPipelineValue ? Math.round((unitMap[unitType].value / totalPipelineValue) * 100) : 0,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    timeWindowDays: daysWindow,
    range,
    totalActiveLeads: allActive.length,
    leadsInWindow: target.length,
    leadsWithoutDate,
    totalPipelineValue,
    weightedPipelineValue,
    avgLeadValue,
    bookedCount,
    bookedValue,
    previousPeriodPipelineValue: prevPipelineValue,
    pipelineGrowthPercent,
    overallConversionRate,
    qualificationRate,
    funnelMetrics,
    disqualifiedBreakdown,
    avgResponseTimeHours,
    medianResponseTimeHours: median(times),
    slaCompliancePercent,
    slaLightningFastPercent,
    totalRespondedCount: times.length,
    unrespondedCount: unresponded.length,
    unrespondedLeads: unresponded,
    slaBuckets,
    rmMetrics,
    sourceMetrics,
    dailyTrend,
    unitBreakdown,
  };
}
