'use client';
/**
 * Platform growth over time: a single-series area chart from the daily platformTrends snapshots, with a metric
 * toggle (Leads / Users / Companies / Revenue). Snapshots accumulate from the nightly cron, so until a couple of
 * days exist it shows a short "charts begin soon" note rather than a misleading flat line.
 */
import { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import type { PlatformTrendPoint, PlatformTrends } from '@/server/platform/contract';
import { call, useResource } from '../_lib/api';
import { fmtNum, fmtPrice } from '../_lib/format';
import { Card, CardHeader, Skeleton, cx, focusRing } from './ui';

type MetricKey = 'leads' | 'users' | 'activeCompanies' | 'mrr';
const METRICS: Array<{ key: MetricKey; label: string; color: string }> = [
  { key: 'leads', label: 'Leads', color: '#0B6BB0' },
  { key: 'users', label: 'Users', color: '#5B4BC4' },
  { key: 'activeCompanies', label: 'Companies', color: '#0E8A7D' },
  { key: 'mrr', label: 'Revenue', color: '#067647' },
];

const niceDate = (d: string) => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };

/** Area chart for one metric over the snapshot window. Pure SVG; viewBox 0..W × 0..H, scaled to the data. */
function AreaChart({ points, metric, currency }: { points: PlatformTrendPoint[]; metric: (typeof METRICS)[number]; currency: string }) {
  const W = 640, H = 180, padB = 22, padT = 10;
  const vals = points.map((p) => p[metric.key]);
  const max = Math.max(1, ...vals);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v: number) => padT + (1 - (v - min) / span) * (H - padT - padB);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[metric.key]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(H - padB).toFixed(1)} L${x(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;
  const id = `grad-${metric.key}`;
  const fmtV = (v: number) => (metric.key === 'mrr' ? fmtPrice(v, currency) : fmtNum(v));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" role="img" aria-label={`${metric.label} over time`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={metric.color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={metric.color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={padT + f * (H - padT - padB)} y2={padT + f * (H - padT - padB)} stroke="#EAF1F7" strokeWidth="1" />)}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={metric.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(vals[vals.length - 1])} r="4" fill={metric.color} stroke="#fff" strokeWidth="2" />
      <text x="2" y={padT + 4} className="fill-[#8296A6] text-[10px]">{fmtV(max)}</text>
      <text x="2" y={H - padB - 2} className="fill-[#8296A6] text-[10px]">{fmtV(min)}</text>
    </svg>
  );
}

export function TrendsCard() {
  const trends = useResource<PlatformTrends>(() => call('platformTrends', { days: 90 }), []);
  const [metric, setMetric] = useState<MetricKey>('leads');
  const m = METRICS.find((x) => x.key === metric)!;
  const points = trends.data?.points || [];
  const currency = trends.data?.currency || 'INR';

  const { current, delta } = useMemo(() => {
    if (!points.length) return { current: 0, delta: null as number | null };
    const cur = points[points.length - 1][metric];
    const first = points[0][metric];
    return { current: cur, delta: points.length > 1 ? cur - first : null };
  }, [points, metric]);

  const fmtV = (v: number) => (metric === 'mrr' ? fmtPrice(v, currency) : fmtNum(v));

  return (
    <Card>
      <CardHeader
        id="dash-trends"
        title="Growth"
        actions={
          <div className="flex flex-wrap gap-1 rounded-xl bg-[#F0F5FA] p-1" role="tablist" aria-label="Metric">
            {METRICS.map((x) => (
              <button
                key={x.key}
                role="tab"
                aria-selected={metric === x.key}
                onClick={() => setMetric(x.key)}
                className={cx('rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors', focusRing, metric === x.key ? 'bg-white text-[#0A1F33] shadow-[0_1px_2px_rgba(10,31,51,0.12)]' : 'text-[#5E778C] hover:text-[#0A1F33]')}
              >
                {x.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="px-5 pb-5">
        {trends.loading && !trends.data ? (
          <Skeleton className="h-44 w-full" />
        ) : points.length < 2 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#EAF4FB] text-[#0B6BB0]"><TrendingUp className="h-5 w-5" aria-hidden /></span>
            <p className="text-[14px] font-semibold text-[#0A1F33]">Growth charts begin soon</p>
            <p className="max-w-sm text-[12.5px] text-[#5E778C]">A platform snapshot is recorded once a day. Charts appear after a couple of days of history{points.length === 1 ? ` · today: ${fmtV(current)} ${m.label.toLowerCase()}` : ''}.</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-end gap-3">
              <span className="text-[26px] font-bold leading-none tabular-nums text-[#0A1F33]">{fmtV(current)}</span>
              {delta != null && (
                <span className={cx('mb-0.5 text-[13px] font-semibold', delta > 0 ? 'text-[#067647]' : delta < 0 ? 'text-[#B42318]' : 'text-[#5E778C]')}>
                  {delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} {delta > 0 ? '+' : ''}{fmtV(delta)}
                  <span className="ml-1 font-medium text-[#8296A6]">over {points.length} days</span>
                </span>
              )}
            </div>
            <AreaChart points={points} metric={m} currency={currency} />
            <div className="mt-1 flex justify-between text-[11px] text-[#8296A6]">
              <span>{niceDate(points[0].date)}</span>
              <span>{niceDate(points[points.length - 1].date)}</span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
