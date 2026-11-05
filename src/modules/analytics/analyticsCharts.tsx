/** The chart and number formats shared by the Website analytics and Search Console reports. */
import React, { useState } from 'react';
import { type AnalyticsDay, type AnalyticsMetric } from '../../core/api';

const BLUE = '#1A73E8';
const GREY = '#80868B';
export const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function show(v: number, m: AnalyticsMetric, currency: string): string {
  if (m.format === 'percent') return `${(v * 100).toFixed(1)}%`;
  if (m.format === 'decimal') return v.toFixed(2);
  if (m.format === 'duration') {
    const s = Math.round(v);
    const h = Math.floor(s / 3600);
    return h ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }
  if (m.format === 'money') {
    try {
      return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(v);
    } catch {
      return v.toFixed(2);
    }
  }
  return Math.round(v).toLocaleString('en-IN');
}

/** One metric through time. The earlier days are dashed and named in the legend, never told apart by colour alone. */
export const LineChart: React.FC<{ days: AnalyticsDay[]; metric: AnalyticsMetric; currency: string; compare: boolean }> = ({ days, metric, currency, compare }) => {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800, H = 240, L = 58, R = 12, T = 12, B = 26;
  const now = days.map((d) => d.values[metric.id] || 0);
  const before = compare && days[0]?.prev ? days.map((d) => d.prev?.[metric.id] || 0) : null;
  const top = Math.max(1, ...now, ...(before || []));
  const x = (i: number) => L + (days.length > 1 ? (i / (days.length - 1)) * (W - L - R) : (W - L - R) / 2);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const every = Math.max(1, Math.ceil(days.length / 7));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.min(days.length - 1, Math.max(0, Math.round(((at - L) / (W - L - R)) * (days.length - 1)))));
  };
  if (!days.length) return null;
  const h = hover !== null ? days[hover] : null;
  return (
    <figure className="relative m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`${metric.label} per day, ${shortDay(days[0].day)} to ${shortDay(days[days.length - 1].day)}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} stroke="#E8EAED" />
            <text x={L - 8} y={y(top * f) + 4} textAnchor="end" fontSize="11" fill="#5F6368">{show(top * f, metric, currency)}</text>
          </g>
        ))}
        {days.map((d, i) => (i % every === 0 ? <text key={d.day} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="#5F6368">{shortDay(d.day)}</text> : null))}
        {before && <path d={path(before)} fill="none" stroke={GREY} strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />}
        <path d={path(now)} fill="none" stroke={BLUE} strokeWidth="2" strokeLinejoin="round" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#BDC1C6" />}
        {hover !== null && <circle cx={x(hover)} cy={y(now[hover])} r="4" fill={BLUE} stroke="#fff" strokeWidth="2" />}
      </svg>
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-[#202124] px-2.5 py-1.5 text-[11px] text-white shadow" style={{ left: `${Math.min(82, Math.max(18, (x(hover) / W) * 100))}%` }}>
          <div>{shortDay(h.day)}: <b>{show(now[hover], metric, currency)}</b></div>
          {before && <div className="opacity-80">{shortDay(h.prevDay)}: <b>{show(before[hover], metric, currency)}</b></div>}
        </div>
      )}
      {before && (
        <figcaption className="mt-1 flex flex-wrap gap-4 text-[11px] text-[#5F6368]">
          <span className="inline-flex items-center gap-1.5"><svg width="20" height="4" aria-hidden="true"><line x1="0" x2="20" y1="2" y2="2" stroke={BLUE} strokeWidth="2" /></svg>This period</span>
          <span className="inline-flex items-center gap-1.5"><svg width="20" height="4" aria-hidden="true"><line x1="0" x2="20" y1="2" y2="2" stroke={GREY} strokeWidth="2" strokeDasharray="5 4" /></svg>Period before</span>
        </figcaption>
      )}
    </figure>
  );
};

