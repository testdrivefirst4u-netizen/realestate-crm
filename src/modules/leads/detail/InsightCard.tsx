/**
 * Lead › Journey: what the CRM reads from this customer's record and the step it suggests next
 * (server/modules/insights.ts). Rule-based: every point and suggestion names its reason.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Lightbulb } from 'lucide-react';
import { api } from '../../../core/api';
import { toAppError } from '../../../core/errors';
import { formatDateTime } from '../../../core/dates';
import type { Insight, Suggestion } from '../../../core/journeyTypes';
import { Button, cx } from '../../../components/ui';

const URGENCY_CLS: Record<string, string> = { now: 'bg-[#FAF0EC] text-[#8A3E28]', today: 'bg-[#FDF3E7] text-[#92400E]', 'this week': 'bg-[#F2F7FB] text-[#0B2A44]' };
const LABEL_CLS: Record<string, string> = { 'Ready to decide': 'text-[#0E8A86]', Progressing: 'text-[#0B6BB0]', Early: 'text-[#5E778C]', Cold: 'text-[#B06A55]', Customer: 'text-[#0E8A86]' };

export const InsightCard: React.FC<{ leadId: string; active: boolean; version: string; canEdit: boolean; onUse: (s: Suggestion) => void }> = ({ leadId, active, version, canEdit, onUse }) => {
  const [data, setData] = useState<Insight | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api.insights.lead(leadId));
      setError('');
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
  }, [leadId]);
  useEffect(() => {
    if (active) void load();
  }, [active, version, load]);
  if (error) return <p className="text-xs text-[#B06A55]">Suggestion unavailable: {error}</p>;
  if (!data) return <div className="h-20 rounded-xl bg-[#F2F7FB] animate-pulse" aria-label="Reading the record" />;
  const n = data.next;

  return (
    <section aria-labelledby="ins-h" className="rounded-xl border border-[#D3E3F0] bg-white">
      <div className="px-3 pt-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 id="ins-h" className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#5E778C] inline-flex items-center gap-1"><Lightbulb size={12} aria-hidden />Suggested next step</h4>
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="text-xs inline-flex items-center gap-1 min-h-8 px-1 rounded focus-visible:outline-2 focus-visible:outline-[#0B6BB0]">
          <span className="text-[#5E778C]">Readiness</span> <strong className={cx('tabular-nums', LABEL_CLS[data.scoreLabel])}>{data.score}</strong> <span className={LABEL_CLS[data.scoreLabel]}>{data.scoreLabel}</span>
          <ChevronDown size={12} className={cx('transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </div>
      {n ? (
        <div className="px-3 pb-3 pt-1.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#0B2A44]">{n.title}{n.personName && !n.title.includes(n.personName) ? <span className="font-normal text-[#5E778C]"> · {n.personName}</span> : null}</div>
              <p className="text-xs text-[#5E778C] mt-0.5">{n.why}</p>
              {n.timeNote && <p className="text-[11px] text-[#0B6BB0] mt-0.5">{n.timeNote}{new Date(n.at).getTime() > Date.now() + 60_000 ? ` · ${formatDateTime(n.at, '')}` : ''}</p>}
            </div>
            <div className="flex items-center gap-2">
              <span className={cx('text-[10px] font-semibold px-2 py-0.5 rounded-full', URGENCY_CLS[n.urgency])}>{n.urgency}</span>
              {canEdit && <Button size="xs" variant="secondary" onClick={() => onUse(n)}>Use this</Button>}
            </div>
          </div>
          {data.also.length > 0 && (
            <ul className="mt-2 space-y-1">
              {data.also.map((a) => <li key={a.key} className="text-xs text-[#0B2A44]">Then: <span className="font-medium">{a.title}</span> <span className="text-[#7E93A6]">— {a.why}</span></li>)}
            </ul>
          )}
        </div>
      ) : <p className="px-3 pb-3 pt-1 text-xs text-[#5E778C]">Nothing suggested: the record is up to date.</p>}
      {data.risks.length > 0 && (
        <ul className="border-t border-[#EEF3F8] px-3 py-2 space-y-0.5">
          {data.risks.map((r) => <li key={r} className="text-[11px] text-[#92400E]">⚠ {r}</li>)}
        </ul>
      )}
      {open && (
        <div className="border-t border-[#EEF3F8] px-3 py-2">
          <div className="text-[11px] text-[#5E778C] mb-1">How the readiness score is made (an estimate from recorded facts, not a prediction):</div>
          <ul className="text-xs space-y-0.5">
            {data.signals.length ? data.signals.map((s) => (
              <li key={s.label} className="flex justify-between gap-3"><span className="text-[#0B2A44]">{s.label}</span><span className={cx('tabular-nums', s.points >= 0 ? 'text-[#0E8A86]' : 'text-[#B06A55]')}>{s.points > 0 ? '+' : ''}{s.points}</span></li>
            )) : <li className="text-[#7E93A6]">Nothing recorded yet.</li>}
          </ul>
        </div>
      )}
    </section>
  );
};
