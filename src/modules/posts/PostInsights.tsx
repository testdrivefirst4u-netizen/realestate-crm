/**
 * Post scheduler › Insights (server: modules/socialInsights.ts): reach, views and engagement of each connected account,
 * one daily chart per account, and the posts with the most reactions, comments and shares. A figure Meta would not give
 * shows a dash, never a zero, and the reason is on the screen.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type InsightValue, type InsightsAccount, type InsightsOverview } from '../../core/api';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';
import { KIND, errText } from './postShared';

const BAR = '#0866FF';
const count = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-IN'));
export const insightText = (m: InsightValue) => {
  if (m.value === null) return '—';
  if (m.format === 'duration') {
    const s = m.value / 1000; // Meta gives the average watch time in milliseconds
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }
  return count(m.value);
};
const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const DailyBars: React.FC<{ label: string; points: Array<{ day: string; value: number }> }> = ({ label, points }) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.value));
  if (!points.length) return <p className="text-xs text-[#65676B]">No daily figures from Meta.</p>;
  const h = hover !== null ? points[hover] : null;
  return (
    <figure className="m-0">
      <figcaption className="flex justify-between text-[11px] text-[#65676B]"><span>{label}</span>{h ? <span className="font-semibold text-[#1C2B33]">{shortDay(h.day)}: {count(h.value)}</span> : <span>Highest {count(max)}</span>}</figcaption>
      <div className="mt-1 flex h-28 items-end gap-[2px] border-b border-[#DADDE1]" role="img" aria-label={`${label}, ${shortDay(points[0].day)} to ${shortDay(points[points.length - 1].day)}, highest ${count(max)}`} onMouseLeave={() => setHover(null)}>
        {points.map((p, i) => (
          <div key={p.day} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div className="w-full rounded-t-[3px]" style={{ height: `${p.value ? Math.max(2, (p.value / max) * 100) : 0}%`, background: BAR, opacity: hover === null || hover === i ? 1 : 0.45 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-[#65676B]"><span>{shortDay(points[0].day)}</span><span>{shortDay(points[points.length - 1].day)}</span></div>
    </figure>
  );
};

const AccountCard: React.FC<{ a: InsightsAccount }> = ({ a }) => (
  <section className="rounded-xl border border-[#DADDE1] bg-white p-4">
    <h3 className="flex flex-wrap items-center gap-2 text-[14px] font-bold text-[#1C2B33]">
      <span className={cx('h-2.5 w-2.5 rounded-full', KIND[a.kind].cls)} aria-hidden="true" />{KIND[a.kind].label} · {a.name}
      {a.followers !== null && <span className="ml-auto text-xs font-medium text-[#65676B]">{count(a.followers)} followers</span>}
    </h3>
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      {a.metrics.map((m) => (
        <div key={m.id}>
          <dt className="text-[11px] text-[#65676B]">{m.label}</dt>
          <dd className="text-[19px] font-semibold text-[#1C2B33]">{insightText(m)}</dd>
        </div>
      ))}
    </dl>
    <div className="mt-4"><DailyBars label={a.chartLabel} points={a.daily} /></div>
    {a.refused.length > 0 && (
      <details className="mt-3 text-xs text-[#9A3412]">
        <summary className="cursor-pointer font-semibold">Meta did not give {a.refused.length} figure{a.refused.length === 1 ? '' : 's'}</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4 break-words">{a.refused.map((r) => <li key={r}>{r}</li>)}</ul>
      </details>
    )}
  </section>
);

export const PostInsights: React.FC<{ account: string; onOpenPost: (id: string) => void }> = ({ account, onOpenPost }) => {
  const [days, setDays] = useState(28);
  const [data, setData] = useState<InsightsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const latest = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.posts.insights({ days, account: account || undefined, refresh });
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('posts.insights', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [days, account]);
  useEffect(() => void load(), [load]);

  const noAccess = !!data?.accounts.length && data.accounts.every((a) => a.metrics.every((m) => m.value === null));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={cx(inputCls, 'w-auto')} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={28}>Last 28 days</option>
        </select>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load(true)}>Refresh</Button>
        <p className="min-w-0 flex-1 text-[11px] text-[#65676B]">From Meta. Recent days can take up to 48 hours to settle.</p>
      </div>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {noAccess && <InlineNotice tone="warning">Meta gave no figures. An Admin may need to reconnect in Settings › Social accounts and allow the insights permissions. Each account below shows what Meta said.</InlineNotice>}
      {!data && !failed && <p className="text-xs text-[#65676B]">Loading…</p>}
      {data && !data.accounts.length && <InlineNotice tone="info">Connect a Facebook Page in Settings › Social accounts to see insights.</InlineNotice>}
      {data && <div className="grid items-start gap-3 lg:grid-cols-2">{data.accounts.map((a) => <AccountCard key={a.key} a={a} />)}</div>}
      {data && (
        <section className="rounded-xl border border-[#DADDE1] bg-white">
          <h3 className="border-b border-[#DADDE1] p-3 text-[14px] font-bold text-[#1C2B33]">Top posts <span className="text-xs font-medium text-[#65676B]">by reactions, comments and shares, as of the last sync</span></h3>
          {!data.topPosts.length ? <p className="p-4 text-xs text-[#65676B]">No figures yet. Click Sync old posts to bring them in.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse">
                <thead><tr className="border-b border-[#EBEDF0] text-left text-[11px] font-semibold text-[#44505C]"><th className="p-2 pl-3">Post</th><th className="p-2">Date</th><th className="p-2 text-right">Reactions</th><th className="p-2 text-right">Comments</th><th className="p-2 pr-3 text-right">Shares</th></tr></thead>
                <tbody className="divide-y divide-[#EBEDF0]">
                  {data.topPosts.map((p) => (
                    <tr key={p.id} className="text-xs text-[#1C2B33] hover:bg-[#F5F9FF]">
                      <td className="p-2 pl-3">
                        <button type="button" className="flex max-w-[340px] items-center gap-2 text-left" onClick={() => onOpenPost(p.id)}>
                          {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" className="h-9 w-9 flex-none rounded object-cover" /> : <span className="h-9 w-9 flex-none rounded bg-[#F0F2F5]" />}
                          <span className="min-w-0"><span className="block truncate font-semibold text-[#0866FF] hover:underline">{p.text || 'No text'}</span><span className="block truncate text-[10.5px] text-[#65676B]">{p.account}{p.postType !== 'post' ? ` · ${p.postType}` : ''}</span></span>
                        </button>
                      </td>
                      <td className="whitespace-nowrap p-2">{new Date(p.at).toLocaleDateString()}</td>
                      <td className="p-2 text-right tabular-nums">{count(p.likes)}</td>
                      <td className="p-2 text-right tabular-nums">{count(p.comments)}</td>
                      <td className="p-2 pr-3 text-right tabular-nums">{count(p.shares)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
