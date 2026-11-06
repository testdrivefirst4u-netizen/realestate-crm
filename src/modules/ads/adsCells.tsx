/** How Ads Manager writes its figures, shared by the table and the side-by-side view. */
import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cx } from '../../components/ui';
import { changeOf, type Better, type DayRange, type Metric } from './adsCompare';

export const DELIVERY: Record<string, { label: string; dot: string }> = {
  ACTIVE: { label: 'Active', dot: 'bg-[#31A24C]' }, PAUSED: { label: 'Off', dot: 'bg-[#A7B4C0]' }, CAMPAIGN_PAUSED: { label: 'Campaign off', dot: 'bg-[#A7B4C0]' }, ADSET_PAUSED: { label: 'Ad set off', dot: 'bg-[#A7B4C0]' },
  PENDING_REVIEW: { label: 'In review', dot: 'bg-[#F0A92E]' }, PREAPPROVED: { label: 'Pre-approved', dot: 'bg-[#F0A92E]' }, IN_PROCESS: { label: 'Processing', dot: 'bg-[#F0A92E]' },
  DISAPPROVED: { label: 'Rejected', dot: 'bg-[#E0483E]' }, WITH_ISSUES: { label: 'Has issues', dot: 'bg-[#E0483E]' }, PENDING_BILLING_INFO: { label: 'Billing needed', dot: 'bg-[#E0483E]' },
};
export const words = (s: string) => s.replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export const count = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-IN'));
export const dec = (n: number | null, digits = 2) => (n === null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
export const pct = (n: number | null) => (n === null ? '—' : `${dec(n)}%`);
export function cash(n: number | null, currency: string) {
  if (n === null) return '—';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return dec(n);
  }
}

const shortDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};
export const rangeText = (r: DayRange) => (r.since === r.until ? shortDay(r.since) : `${shortDay(r.since)} to ${shortDay(r.until)}`);

export const metricText = (m: Pick<Metric, 'kind'>, n: number | null, currency: string) => {
  if (n === null) return '—';
  if (m.kind === 'money') return currency ? cash(n, currency) : dec(n);
  if (m.kind === 'percent') return pct(n);
  if (m.kind === 'number') return dec(n);
  return count(n);
};

const TONE = { good: 'text-[#067647]', bad: 'text-[#B42318]', flat: 'text-[#5E6C7B]' };

/** How a figure moved: the arrow and words carry it, the colour only says whether that is good. */
export const ChangeText: React.FC<{ now: number | null; before: number | null; better: Better }> = ({ now, before, better }) => {
  const c = changeOf(now, before, better);
  if (!c) return null;
  return (
    <span className={cx('inline-flex items-center gap-0.5 font-semibold', TONE[c.tone])}>
      {c.arrow === 'up' && <ArrowUp size={10} aria-label="Up" />}{c.arrow === 'down' && <ArrowDown size={10} aria-label="Down" />}{c.text}
    </span>
  );
};
