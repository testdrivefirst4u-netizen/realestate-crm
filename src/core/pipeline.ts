/**
 * Pipeline-value & response-time analytics (the "Performance" report).
 * Ported from the old services/performanceAnalytics.ts with these fixes:
 *  - leads with blank/invalid Enquiry Date are excluded from time-window reports
 *    (they were previously included, inflating counts)
 *  - the previous period is never fabricated (old code used 85% of current when zero)
 *  - all dates go through core/dates (CRM time zone), no UTC string slicing
 *  - "Last Follow-up Date & Time" is no longer treated as a first response
 *  - SLA compliance is OVERALL: responded within 24 h ÷ (responded + enquiries older than 24 h with no response).
 *    The old figure divided by responded leads only, so 1 quick reply + 9 ignored enquiries showed 100 %.
 *    The responded-only figure is kept as slaOfRespondedPercent and labelled that way.
 *  - funnel conversion counts a lead at a step only when the step is RECORDED (lead._milestones, written by the
 *    server when it happens), never from the lead's current stage. Leads with no recorded steps count as enquiries only.
 *  - "pipeline value" from notes / unit-type prices is an ESTIMATE and is named so on screen.
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
  /** Enquiries in the window with no recorded journey step yet (older data before milestones, or untouched). */
  leadsWithoutEvidence: number;
  disqualifiedBreakdown: Array<{ reason: string; count: number; value: number }>;
  avgResponseTimeHours: number;
  medianResponseTimeHours: number;
  /** Overall: within 24 h ÷ (responded + overdue unanswered). */
  slaCompliancePercent: number;
  slaLightningFastPercent: number;
  /** Secondary: within 24 h ÷ responded only. */
  slaOfRespondedPercent: number;
  slaEligibleCount: number;
  overdueUnansweredCount: number;
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

  // evidence-based "reached": a step counts only when it was recorded
  const evidenceOf = (l: Lead): Record<string, string> => {
    try {
      return JSON.parse(String(l._milestones || '{}')) || {};
    } catch {
      return {};
    }
  };
  const stepOf: Record<string, string> = { [STAGES.OPEN]: 'contacted', [STAGES.WARM]: 'qualified', [STAGES.HOT]: 'qualified', [STAGES.QUALIFIED]: 'qualified', [STAGES.BOOKED]: 'booked' };
  const evidence = target.map(evidenceOf);
  const reachedAt = (stage: string) => (stage === STAGES.NEW ? target.length : evidence.filter((e) => !!e[stepOf[stage]]).length);
  const leadsWithoutEvidence = evidence.filter((e) => !Object.keys(e).length).length;
  const funnelMetrics: StagePerformanceMetric[] = FUNNEL_STAGES.map((stage, idx) => {
    const reached = reachedAt(stage);
    const reachedNext = idx < FUNNEL_STAGES.length - 1 ? reachedAt(FUNNEL_STAGES[idx + 1]) : reached;
    const bookedReached = reachedAt(STAGES.BOOKED);
    const stageVal = stageValues[stage] || 0;
    return {
      stage,
      count: stageCounts[stage] || 0,
      totalValue: stageVal,
      weightedValue: stageVal * (STAGE_WEIGHTS[stage] || 0),
      percentageOfPipeline: totalPipelineValue ? (stageVal / totalPipelineValue) * 100 : 0,
      conversionRateToNext: reached ? Math.min(100, Math.round((reachedNext / reached) * 100)) : idx === FUNNEL_STAGES.length - 1 ? 100 : 0,
      cumulativeWinRate: reached ? Math.min(100, Math.round((bookedReached / reached) * 100)) : 0,
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
  // overall SLA: an enquiry older than 24 h with no response counts against it (not left out)
  const enquiredAt = (l: Lead) => enquiryDate(l)?.getTime() ?? now.getTime();
  const overdueUnanswered = unresponded.filter((l) => now.getTime() - enquiredAt(l) > 24 * 3_600_000).length;
  const slaEligible = times.length + overdueUnanswered;
  const slaCompliancePercent = slaEligible ? ((b1 + b4 + b24) / slaEligible) * 100 : 0;
  const slaLightningFastPercent = slaEligible ? ((b1 + b4) / slaEligible) * 100 : 0;
  const slaOfRespondedPercent = times.length ? ((b1 + b4 + b24) / times.length) * 100 : 0;
  const evaluated = target.length || 1;
  const slaBuckets = [
    { label: '< 1 hr (Lightning)', count: b1, percent: Math.round((b1 / evaluated) * 100), color: '#2E7D32' },
    { label: '1 - 4 hrs (Fast)', count: b4, percent: Math.round((b4 / evaluated) * 100), color: '#0E8A86' },
    { label: '4 - 24 hrs (Same Day)', count: b24, percent: Math.round((b24 / evaluated) * 100), color: '#0B6BB0' },
    { label: '24 - 48 hrs (Delayed)', count: b48, percent: Math.round((b48 / evaluated) * 100), color: '#D97706' },
    { label: '> 48 hrs (Critical)', count: bOver, percent: Math.round((bOver / evaluated) * 100), color: '#B06A55' },
    { label: 'Pending Response', count: unresponded.length, percent: Math.round((unresponded.length / evaluated) * 100), color: '#7E93A6' },
  ];

  // RM metrics
  const rmMap: Record<string, { leads: Lead[]; times: number[]; booked: number; bookedValue: number; value: number; overdue: number }> = {};
  for (const lead of target) {
    const rm = String(lead[F.RM] || '').trim() || 'Unassigned';
    rmMap[rm] = rmMap[rm] || { leads: [], times: [], booked: 0, bookedValue: 0, value: 0, overdue: 0 };
    const v = getLeadEstimatedValue(lead);
    rmMap[rm].leads.push(lead);
    rmMap[rm].value += v;
    if (isBooked(lead)) {
      rmMap[rm].booked++;
      rmMap[rm].bookedValue += v;
    }
    const h = responseTimeHours(lead);
    if (h !== null) rmMap[rm].times.push(h);
    else if (!isBooked(lead) && now.getTime() - enquiredAt(lead) > 24 * 3_600_000) rmMap[rm].overdue++;
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
        // overall, like the headline: overdue unanswered enquiries count against the RM
        slaWithin24hPercent: d.times.length + d.overdue ? Math.round((d.times.filter((t) => t <= 24).length / (d.times.length + d.overdue)) * 100) : 0,
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
    leadsWithoutEvidence,
    disqualifiedBreakdown,
    avgResponseTimeHours,
    medianResponseTimeHours: median(times),
    slaCompliancePercent,
    slaLightningFastPercent,
    slaOfRespondedPercent,
    slaEligibleCount: slaEligible,
    overdueUnansweredCount: overdueUnanswered,
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
