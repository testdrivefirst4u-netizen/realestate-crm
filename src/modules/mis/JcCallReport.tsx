/**
 * Sales MIS › Calls (JustConnect): how calls on the business number went — totals, answer rate, wait and talk time,
 * and per RM — counted exactly as JustConnect's own reports count them (GET /reports/calls via jcCallReport).
 */
import React, { useEffect, useState } from 'react';
import { PhoneCall, RefreshCw } from 'lucide-react';
import { api, type JcReport } from '../../core/api';
import { toAppError } from '../../core/errors';
import { Button, cx } from '../../components/ui';
import { periodRange, type PeriodId } from './misData';

const fmtSecs = (s: number | null | undefined) => {
  if (s == null) return '—';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m} min${r ? ` ${r} s` : ''}` : `${r} s`;
};
const fmtHours = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : fmtSecs(s));
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

/** 'yyyy-MM-dd' (IST day) → the instant that day starts, in UTC. */
const istStart = (key: string) => new Date(`${key}T00:00:00+05:30`);

export const JcCallReport: React.FC<{ today: string }> = ({ today }) => {
  const [period, setPeriod] = useState<PeriodId>('week');
  const [data, setData] = useState<JcReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (p: PeriodId) => {
    const [from, to] = periodRange(p, ['', ''], today);
    const since = istStart(from || today);
    const until = new Date(istStart(to || today).getTime() + 86400000);
    setLoading(true);
    setError(null);
    try {
      setData(await api.justconnect.report(since.toISOString(), until.toISOString()));
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
    setLoading(false);
  };
  useEffect(() => {
    void load(period);
  }, [period]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = data?.totals;
  const tiles: Array<[string, string, string?]> = t
    ? [
        ['Calls', String(t.calls), `${t.inbound} in · ${t.outbound} out`],
        ['Answered', String(t.answered), `answer rate ${pct(t.answerRate)}`],
        ['Missed (incoming)', String(t.missed), t.abandonRate != null ? `${t.abandonRate}% hung up waiting` : undefined],
        ['Not answered (outgoing)', String(t.notAnswered)],
        ['Average call', fmtSecs(t.avgTalkSeconds), `total ${fmtHours(t.talkSeconds)}`],
        ['Average wait', fmtSecs(t.avgSpeedOfAnswerSeconds), t.serviceLevel != null ? `${t.serviceLevel}% answered in 20 s` : undefined],
      ]
    : [];

  return (
    <section className="bg-white rounded-2xl border border-[#D3E3F0] shadow-xs p-4 sm:p-5 space-y-4" aria-label="Calls from JustConnect">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-[#0B2A44] inline-flex items-center gap-2"><PhoneCall size={16} className="text-[#0B6BB0]" />Calls on the business number</h3>
          <p className="text-xs text-[#5E778C] mt-0.5">From JustConnect, counted as JustConnect’s own reports count them.</p>
        </div>
        <div className="flex items-center gap-1.5">
          {(['today', 'week', 'month'] as PeriodId[]).map((p) => (
            <button key={p} type="button" onClick={() => setPeriod(p)} aria-pressed={period === p}
              className={cx('h-8 px-3 rounded-lg text-xs font-semibold border', period === p ? 'bg-[#0A1F33] border-[#0A1F33] text-white' : 'bg-white border-[#D3E3F0] text-[#0B2A44] hover:bg-[#F2F7FB]')}>
              {p === 'today' ? 'Today' : p === 'week' ? 'This week' : 'This month'}
            </button>
          ))}
          <Button variant="ghost" size="xs" onClick={() => void load(period)} loading={loading} icon={<RefreshCw size={11} />} aria-label="Refresh" />
        </div>
      </div>

      {error && <p className="text-sm text-[#B42318]">{error}</p>}
      {!data && !error && <p className="text-sm text-[#7E93A6]">Loading…</p>}

      {t && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-2.5">
            {tiles.map(([label, value, note]) => (
              <div key={label} className="rounded-xl bg-[#F5F9FC] border border-[#E6EFF6] p-3">
                <div className="text-[11px] font-semibold text-[#5E778C]">{label}</div>
                <div className="text-xl font-bold tabular-nums text-[#0A1F33] mt-0.5">{value}</div>
                {note && <div className="text-[11px] text-[#7E93A6] mt-0.5">{note}</div>}
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide font-bold text-[#5E778C]">
                  <th className="text-left px-2.5 py-2 border-b border-[#D3E3F0]">RM / agent</th>
                  <th className="text-right px-2.5 py-2 border-b border-[#D3E3F0]">Calls</th>
                  <th className="text-right px-2.5 py-2 border-b border-[#D3E3F0]">Answered</th>
                  <th className="text-right px-2.5 py-2 border-b border-[#D3E3F0]">Missed</th>
                  <th className="text-right px-2.5 py-2 border-b border-[#D3E3F0]">Not answered</th>
                  <th className="text-right px-2.5 py-2 border-b border-[#D3E3F0]">Talk time</th>
                  <th className="text-right px-2.5 py-2 border-b border-[#D3E3F0]">Average call</th>
                </tr>
              </thead>
              <tbody>
                {data!.byAgent.length === 0 && <tr><td colSpan={7} className="px-2.5 py-5 text-center text-[#7E93A6]">No calls in this period.</td></tr>}
                {data!.byAgent.map((a) => (
                  <tr key={a.name} className="hover:bg-[#F7FAFD]">
                    <td className="px-2.5 py-2 border-b border-[#EEF4F9] font-semibold text-[#0B2A44]">{a.name}</td>
                    <td className="px-2.5 py-2 border-b border-[#EEF4F9] text-right tabular-nums">{a.calls}</td>
                    <td className="px-2.5 py-2 border-b border-[#EEF4F9] text-right tabular-nums">{a.answered}</td>
                    <td className={cx('px-2.5 py-2 border-b border-[#EEF4F9] text-right tabular-nums', a.missed && 'text-[#B42318] font-semibold')}>{a.missed}</td>
                    <td className="px-2.5 py-2 border-b border-[#EEF4F9] text-right tabular-nums">{a.notAnswered}</td>
                    <td className="px-2.5 py-2 border-b border-[#EEF4F9] text-right tabular-nums">{fmtHours(a.talkSeconds)}</td>
                    <td className="px-2.5 py-2 border-b border-[#EEF4F9] text-right tabular-nums">{fmtSecs(a.avgTalkSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
};
