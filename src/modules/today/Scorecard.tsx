/**
 * Scorecards (server/modules/scorecard.ts).
 *   MyMonth        on My work: the person's own month against their targets
 *   TeamScorecard  on Team / Business: the organisation tree with each person's own and team totals; managers set
 *                  targets for people below them
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Target } from 'lucide-react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { formatINR } from '../../core/format';
import { MEASURE_LABEL, TARGETABLE, type Counts, type Measure, type ScoreRow, type Scorecard } from '../../core/journeyTypes';
import { Button, ErrorState, InlineNotice, cx, inputCls } from '../../components/ui';

const MONEY: Measure[] = ['bookedValue', 'collections'];
const fmt = (m: Measure, v: number) => (MONEY.includes(m) ? formatINR(v) : m === 'respondedInTime' ? `${v}%` : String(v));
/** Change against the previous month, as a small labelled delta (the in-time % in points). */
export const Delta: React.FC<{ m: Measure; now: number; before: number; prevKey: string; hideIfNone?: boolean }> = ({ m, now, before, prevKey, hideIfNone }) => {
  const d = Math.round((now - before) * 10) / 10;
  if (hideIfNone && !d && !before) return null;
  const word = prevKey ? new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(prevKey.slice(0, 4)), Number(prevKey.slice(5, 7)) - 1, 1))) : 'last month';
  const text = d === 0 ? 'same as' : `${d > 0 ? '▲' : '▼'} ${MONEY.includes(m) ? formatINR(Math.abs(d)) : m === 'respondedInTime' ? `${Math.abs(d)} pts` : Math.abs(d)}`;
  return <span className={cx('text-[10px] whitespace-nowrap', d > 0 ? 'text-[#0E8A86]' : d < 0 ? 'text-[#B06A55]' : 'text-[#7E93A6]')} title={`${fmt(m, before)} in ${word}`}>{text} {d === 0 ? word : `vs ${word}`}</span>;
};

const monthName = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
};
const shift = (key: string, by: number) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

function useScorecard() {
  const [month, setMonth] = useState('');
  const [data, setData] = useState<Scorecard | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async (m = month) => {
    try {
      const r = await api.org.scorecard(m || undefined);
      setData(r);
      setMonth(r.month);
      setError('');
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
  }, [month]);
  useEffect(() => {
    void load('');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { month, data, error, load };
}

const MonthPicker: React.FC<{ month: string; onChange: (m: string) => void }> = ({ month, onChange }) => (
  <div className="inline-flex items-center gap-1 text-xs text-[#0B2A44]">
    <button onClick={() => onChange(shift(month, -1))} className="p-2 rounded-md hover:bg-white" aria-label="Previous month"><ChevronLeft size={14} /></button>
    <span className="font-semibold min-w-28 text-center">{month ? monthName(month) : ''}</span>
    <button onClick={() => onChange(shift(month, 1))} className="p-2 rounded-md hover:bg-white" aria-label="Next month"><ChevronRight size={14} /></button>
  </div>
);

/** The person's month: each measure with its target and progress. */
export const MyMonth: React.FC = () => {
  const { month, data, error, load } = useScorecard();
  if (error) return <ErrorState title="Could not load your month" message={error} onRetry={() => load()} compact />;
  if (!data?.mine) return null;
  const c = data.mine.own;
  const t = data.mine.targets;
  const shown: Measure[] = ['contacted', 'respondedInTime', 'visits', 'quotations', 'bookings', 'collections', 'touches'];
  return (
    <section aria-labelledby="h-mymonth">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h2 id="h-mymonth" className="text-sm font-bold text-[#0B2A44]">Your month</h2>
        <MonthPicker month={month} onChange={(m) => load(m)} />
      </div>
      <ul className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-px rounded-xl overflow-hidden border border-[#E3EDF5] bg-[#E3EDF5]">
        {shown.map((m) => {
          const v = c[m];
          const target = t[m];
          const pct = target ? Math.min(100, Math.round((v / target) * 100)) : null;
          return (
            <li key={m} className="bg-white px-3 py-2.5">
              <div className="text-[11px] text-[#5E778C]">{MEASURE_LABEL[m]}</div>
              <div className="mt-0.5 text-base font-bold tabular-nums text-[#0B2A44]">{m === 'respondedInTime' && !c.slaEligible ? '—' : fmt(m, v)}</div>
              <Delta m={m} now={v} before={data.mine!.prevOwn[m]} prevKey={data.prevMonth} />
              {target !== undefined ? (
                <>
                  <div className="mt-1 h-1.5 rounded-full bg-[#E3EDF5]" aria-hidden><div className={cx('h-1.5 rounded-full', pct! >= 100 ? 'bg-[#0E8A86]' : 'bg-[#0B6BB0]')} style={{ width: `${pct}%` }} /></div>
                  <div className="text-[10px] text-[#7E93A6] mt-0.5">target {fmt(m, target)}</div>
                </>
              ) : <div className="text-[10px] text-[#7E93A6] mt-1">no target</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** The organisation tree with own and team figures; targets for people below the viewer. */
export const TeamScorecard: React.FC<{ readOnly?: boolean }> = ({ readOnly }) => {
  const { month, data, error, load } = useScorecard();
  const [editing, setEditing] = useState<ScoreRow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [view, setView] = useState<'team' | 'own'>('team');
  if (error) return <ErrorState title="Could not load the scorecard" message={error} onRetry={() => load()} compact />;
  if (!data) return <div className="h-32 rounded-xl bg-white/70 animate-pulse" aria-label="Loading scorecard" />;
  const cols: Measure[] = ['enquiries', 'respondedInTime', 'contacted', 'visits', 'quotations', 'bookings', 'bookedValue', 'collections'];
  const startEdit = (r: ScoreRow) => {
    setEditing(r);
    setValues(Object.fromEntries(TARGETABLE.map((m) => [m, r.targets[m] !== undefined ? String(r.targets[m]) : ''])));
  };
  const cell = (r: ScoreRow, m: Measure) => {
    const c: Counts = view === 'team' ? r.team : r.own;
    const v = c[m];
    const target = r.targets[m];
    const hit = target !== undefined && v >= target;
    return (
      <td key={m} className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
        <span className={cx(target !== undefined ? (hit ? 'text-[#0E8A86] font-semibold' : 'text-[#0B2A44]') : 'text-[#0B2A44]')}>{m === 'respondedInTime' && !c.slaEligible ? '—' : fmt(m, v)}</span>
        {view === 'own' && target !== undefined && <div className="text-[10px] text-[#7E93A6]">/ {fmt(m, target)}</div>}
        <div><Delta m={m} now={v} before={(view === 'team' ? r.prevTeam : r.prevOwn)[m]} prevKey={data.prevMonth} hideIfNone /></div>
      </td>
    );
  };

  return (
    <section aria-labelledby="h-scorecard" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="h-scorecard" className="text-sm font-bold text-[#0B2A44]">Scorecard</h2>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Figures" className="inline-flex rounded-lg border border-[#D3E3F0] bg-white p-0.5">
            {(['team', 'own'] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={cx('min-h-8 px-3 rounded-md text-xs font-semibold', view === v ? 'bg-[#0B2A44] text-white' : 'text-[#0B2A44]')}>{v === 'team' ? 'With their team' : 'Own only'}</button>
            ))}
          </div>
          <MonthPicker month={month} onChange={(m) => load(m)} />
        </div>
      </div>
      {msg && <InlineNotice tone={msg.tone}>{msg.text}</InlineNotice>}
      <div className="overflow-x-auto rounded-xl border border-[#E3EDF5] bg-white">
        <table className="w-full text-xs">
          <thead className="text-[#5E778C] text-left">
            <tr className="border-b border-[#EEF3F8]">
              <th scope="col" className="px-3 py-2 font-semibold min-w-48">Person</th>
              {cols.map((m) => <th key={m} scope="col" className="px-2 py-2 font-semibold text-right whitespace-nowrap">{MEASURE_LABEL[m]}</th>)}
              {!readOnly && <th scope="col" className="px-2 py-2"><span className="sr-only">Targets</span></th>}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className="border-b border-[#EEF3F8] last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <div style={{ paddingLeft: r.depth * 16 }} className="flex items-baseline gap-2">
                    <span className="font-semibold text-[#0B2A44]">{r.name}</span>
                    <span className="text-[10px] text-[#7E93A6]">{r.levelName || 'not placed'}{view === 'team' && r.hasTeam ? ' · with team' : ''}</span>
                  </div>
                </th>
                {cols.map((m) => cell(r, m))}
                {!readOnly && (
                  <td className="px-2 py-2 text-right">
                    {data.canSetTargetsFor.includes(r.id) && <Button size="xs" variant="ghost" icon={<Target size={12} />} onClick={() => startEdit(r)}>Targets</Button>}
                  </td>
                )}
              </tr>
            ))}
            <tr className="bg-[#F7FAFD]">
              <th scope="row" className="px-3 py-2 text-left font-semibold text-[#0B2A44]">Total</th>
              {cols.map((m) => <td key={m} className="px-2 py-2 text-right tabular-nums font-semibold whitespace-nowrap">{m === 'respondedInTime' && !data.total.slaEligible ? '—' : fmt(m, data.total[m])}<div className="font-normal"><Delta m={m} now={data.total[m]} before={data.prevTotal[m]} prevKey={data.prevMonth} /></div></td>)}
              {!readOnly && <td />}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-[#5E778C]">From recorded events only. "With their team" adds up everyone below a person; answered-in-time is recomputed from the counts, not averaged.</p>

      {editing && (
        <form className="rounded-xl border border-[#0B6BB0]/30 bg-[#F7FAFD] p-3 space-y-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.org.setTargets(editing.id, month, values);
            setMsg({ tone: 'success', text: `Targets for ${editing.name}, ${monthName(month)} saved.` });
            setEditing(null);
            await load();
          } catch (err) {
            setMsg({ tone: 'warning', text: toAppError(err).userMessage });
          }
        }}>
          <div className="text-xs font-semibold text-[#0B2A44]">Targets for {editing.name} · {monthName(month)}</div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {TARGETABLE.map((m) => (
              <label key={m} className="text-[11px] text-[#5E778C]">{MEASURE_LABEL[m]}{m === 'respondedInTime' ? ' (%)' : MONEY.includes(m) ? ' (₹)' : ''}
                <input type="number" min={0} max={m === 'respondedInTime' ? 100 : undefined} value={values[m] || ''} onChange={(e) => setValues({ ...values, [m]: e.target.value })} className={cx(inputCls, 'mt-1')} />
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" variant="primary">Save targets</Button>
          </div>
        </form>
      )}
    </section>
  );
};
