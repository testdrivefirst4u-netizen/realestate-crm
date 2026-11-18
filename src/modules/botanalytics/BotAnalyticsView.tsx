/**
 * Bot Analytics (/botanalytics): a cross-channel dashboard for every bot conversation — website chats,
 * Instagram/Facebook DMs and WhatsApp bot chats. KPI tiles, a sessions-by-channel trend, a channel mix
 * donut, per-channel figures and a per-bot performance table. All figures come from api.botAnalytics (real
 * aggregates over the chosen range) and api.bots (per-bot stats). Read-only.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, Facebook, Globe, Instagram, MessagesSquare, RefreshCw, Search, X } from 'lucide-react';
import { api, type BotAnalyticsData, type BotChannelKey, type BotView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { Badge, Button, Card, EmptyState, InlineNotice, KpiTile, LoadingState, cx, inputCls } from '../../components/ui';
import { WhatsAppIcon } from '../../components/WhatsAppIcon';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const DAY = 86400000;
type Preset = '7' | '30' | '90' | 'custom';
const RANGES: Array<{ id: Preset; label: string }> = [{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }, { id: 'custom', label: 'Custom' }];
const toInput = (d: Date) => d.toISOString().slice(0, 10);
const CH: Record<BotChannelKey, { label: string; color: string; icon: React.ElementType }> = {
  website: { label: 'Website', color: '#E86B2A', icon: Globe },
  whatsapp: { label: 'WhatsApp', color: '#25D366', icon: WhatsAppIcon },
  instagram: { label: 'Instagram', color: '#C1398B', icon: Instagram },
  facebook: { label: 'Facebook', color: '#2E6FBA', icon: Facebook },
};
const ORDER: BotChannelKey[] = ['website', 'whatsapp', 'instagram', 'facebook'];
const nf = (n: number) => n.toLocaleString('en-IN');
const pct = (cur: number, prev: number): number | null => (prev ? Math.round(((cur - prev) / prev) * 100) : (cur ? null : 0));
const fmtDur = (s: number) => {
  if (!s) return '0s';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.round(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${ss}s` : `${ss}s`;
};
const dayLabel = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };

/* ------------------------------ sessions-by-channel area chart ----------------------------- */
const SessionsChart: React.FC<{ daily: BotAnalyticsData['daily'] }> = ({ daily }) => {
  const W = 760, H = 230, padL = 30, padR = 12, padT = 12, padB = 24;
  const series = ORDER.filter((ch) => daily.some((d) => d[ch] > 0));
  const maxY = Math.max(1, ...daily.flatMap((d) => series.map((ch) => d[ch])));
  const n = daily.length;
  const x = (i: number) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / maxY) * (H - padT - padB);
  if (!series.length) return <div className="flex h-56 items-center justify-center text-sm text-[#7E93A6]">No sessions in this period.</div>;
  const gridVals = [0, Math.round(maxY / 2), maxY].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[560px] w-full" role="img" aria-label="Sessions by channel over time">
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#EBF1F6" strokeWidth={1} />
            <text x={0} y={y(v) + 3} fontSize={9} fill="#9CB0C0">{nf(v)}</text>
          </g>
        ))}
        {series.map((ch) => {
          const pts = daily.map((d, i) => `${x(i)},${y(d[ch])}`);
          const area = `M ${padL},${y(0)} L ${pts.join(' L ')} L ${x(n - 1)},${y(0)} Z`;
          const line = `M ${pts.join(' L ')}`;
          return (
            <g key={ch}>
              <path d={area} fill={CH[ch].color} opacity={0.12} />
              <path d={line} fill="none" stroke={CH[ch].color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {n > 0 && <>
          <text x={padL} y={H - 8} fontSize={9} fill="#9CB0C0">{dayLabel(daily[0].date)}</text>
          <text x={W - padR} y={H - 8} fontSize={9} fill="#9CB0C0" textAnchor="end">{dayLabel(daily[n - 1].date)}</text>
        </>}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 px-1">
        {series.map((ch) => <span key={ch} className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#44505C]"><span className="h-2.5 w-2.5 rounded-full" style={{ background: CH[ch].color }} />{CH[ch].label}</span>)}
      </div>
    </div>
  );
};

/* ---------------------------------- channel mix donut --------------------------------- */
const ChannelDonut: React.FC<{ channels: BotAnalyticsData['channels']; total: number }> = ({ channels, total }) => {
  const parts = ORDER.map((ch) => ({ ch, value: channels.find((c) => c.channel === ch)?.sessions || 0 })).filter((p) => p.value > 0);
  if (!total || !parts.length) return <div className="flex h-56 items-center justify-center text-sm text-[#7E93A6]">No sessions yet.</div>;
  let acc = 0;
  const stops = parts.map((p) => { const a = (acc / total) * 360; acc += p.value; const b = (acc / total) * 360; return `${CH[p.ch].color} ${a}deg ${b}deg`; }).join(', ');
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-40 w-40 flex-none rounded-full" style={{ background: `conic-gradient(${stops})` }}>
        <div className="absolute inset-[22%] flex flex-col items-center justify-center rounded-full bg-white text-center shadow-inner">
          <span className="text-xl font-bold text-[#0B2A44]">{nf(total)}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#7E93A6]">sessions</span>
        </div>
      </div>
      <ul className="min-w-[160px] flex-1 space-y-1.5">
        {parts.map((p) => (
          <li key={p.ch} className="flex items-center gap-2 text-sm">
            <span className="h-3 w-3 flex-none rounded-full" style={{ background: CH[p.ch].color }} />
            <span className="flex-1 text-[#44505C]">{CH[p.ch].label}</span>
            <span className="font-semibold text-[#0B2A44]">{nf(p.value)}</span>
            <span className="w-10 text-right text-xs text-[#7E93A6]">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/* ------------------------------------- the screen ------------------------------------- */
export const BotAnalyticsView: React.FC = () => {
  const [preset, setPreset] = useState<Preset>('30');
  const [cFrom, setCFrom] = useState(() => toInput(new Date(Date.now() - 30 * DAY)));
  const [cTo, setCTo] = useState(() => toInput(new Date()));
  const [botId, setBotId] = useState('');
  const [data, setData] = useState<BotAnalyticsData | null>(null);
  const [bots, setBots] = useState<BotView[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [botSearch, setBotSearch] = useState('');

  const range = useMemo(() => {
    const now = new Date();
    let from: Date, to: Date;
    if (preset === 'custom' && cFrom && cTo) {
      from = new Date(`${cFrom}T00:00:00`); to = new Date(`${cTo}T23:59:59`);
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || from.getTime() >= to.getTime()) { to = now; from = new Date(now.getTime() - 30 * DAY); }
    } else {
      to = now; from = new Date(now.getTime() - (preset === 'custom' ? 30 : Number(preset)) * DAY);
    }
    return { from: from.toISOString(), to: to.toISOString(), botId: botId || undefined };
  }, [preset, cFrom, cTo, botId]);
  const selBot = useMemo(() => bots?.find((b) => b.id === botId) || null, [bots, botId]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [a, b] = await Promise.all([api.botAnalytics.get(range), api.bots.list().catch(() => null)]);
      setData(a);
      if (b) setBots(b.bots);
      setErr('');
    } catch (e) {
      setErr(errText('botAnalytics.load', e));
    } finally {
      setBusy(false);
    }
  }, [range]);
  useEffect(() => { void load(); }, [load]);

  const kpis = useMemo(() => {
    if (!data) return [];
    const k = data.kpis, p = data.prev;
    return [
      { label: 'Total sessions', value: nf(k.totalSessions), tone: 'gold' as const, trend: { value: pct(k.totalSessions, p.totalSessions) } },
      { label: 'Active now', value: nf(k.activeNow), tone: 'sage' as const },
      { label: 'Unique users', value: nf(k.uniqueUsers), trend: { value: pct(k.uniqueUsers, p.uniqueUsers) } },
      { label: 'Repeat users', value: nf(k.repeatUsers) },
      { label: 'Handoffs', value: nf(k.handoffs), trend: { value: pct(k.handoffs, p.handoffs) } },
      { label: 'Handoff rate', value: `${k.handoffRate}%` },
      { label: 'Avg session', value: fmtDur(k.avgSessionSec), trend: { value: pct(k.avgSessionSec, p.avgSessionSec) } },
      { label: 'Bot messages', value: nf(k.botMessages) },
      { label: 'User messages', value: nf(k.userMessages) },
      { label: 'Agent messages', value: nf(k.agentMessages) },
    ];
  }, [data]);

  const shownChannels = useMemo(() => (data ? data.channels.filter((c) => c.sessions > 0 || c.prevSessions > 0) : []), [data]);
  const shownBots = useMemo(() => {
    const q = botSearch.trim().toLowerCase();
    return (bots || []).filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [bots, botSearch]);

  const downloadCsv = () => {
    const rows = [['Bot', 'Channels', 'Status', 'Chats started', 'Handed off', 'Created'], ...(bots || []).map((b) => [b.name, b.channels.join(' '), b.status, String(b.stats.started), String(b.stats.handedOff), new Date(b.createdAt).toLocaleDateString('en-IN')])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'bot-performance.csv'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-bold text-[#0B2A44]">Bot Analytics</h2>
          <p className="text-xs text-[#5E778C]">Website, Instagram, Facebook and WhatsApp bot conversations.</p>
        </div>
        <Link href="/webchat" className="inline-flex items-center gap-1.5 rounded-lg border border-[#D3E3F0] bg-white px-3 py-2 text-xs font-semibold text-[#0B2A44] hover:bg-[#F2F7FB]"><MessagesSquare size={13} /> View live conversations</Link>
        <div role="tablist" aria-label="Date range" className="inline-flex rounded-lg bg-[#E6EFF6] p-0.5">
          {RANGES.map((r) => <button key={r.id} type="button" role="tab" aria-selected={preset === r.id} onClick={() => setPreset(r.id)} className={cx('rounded-md px-3 py-1.5 text-xs font-semibold', preset === r.id ? 'bg-white text-[#0B6BB0] shadow-sm' : 'text-[#5E778C]')}>{r.label}</button>)}
        </div>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={busy ? 'animate-spin' : ''} />} disabled={busy} onClick={() => void load()}>Refresh</Button>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#5E778C]">
          <label className="flex items-center gap-1.5">From <input type="date" className={cx(inputCls, 'w-auto py-1.5')} value={cFrom} max={cTo || undefined} onChange={(e) => setCFrom(e.target.value)} /></label>
          <label className="flex items-center gap-1.5">To <input type="date" className={cx(inputCls, 'w-auto py-1.5')} value={cTo} min={cFrom || undefined} max={toInput(new Date())} onChange={(e) => setCTo(e.target.value)} /></label>
        </div>
      )}
      {botId && (
        <div className="flex items-center gap-2 rounded-lg bg-[#EAF4FB] px-3 py-2 text-sm text-[#0B2A44]">
          <span>Showing <b>{selBot?.name || 'selected bot'}</b> only.</span>
          <button type="button" onClick={() => setBotId('')} className="ml-auto inline-flex items-center gap-1 font-semibold text-[#0B6BB0] hover:underline"><X size={13} /> Clear filter</button>
        </div>
      )}

      {err && <InlineNotice tone="warning">{err}</InlineNotice>}
      {!data ? <LoadingState /> : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            {kpis.map((c) => <KpiTile key={c.label} label={c.label} value={c.value} tone={(c as { tone?: 'gold' | 'sage' }).tone} trend={(c as { trend?: { value: number | null } }).trend} compact />)}
            {!botId && <KpiTile label="WhatsApp live msgs" value={nf(data.waLive.inbound + data.waLive.outbound)} hint={`${nf(data.waLive.inbound)} in · ${nf(data.waLive.outbound)} out · live chat`} compact />}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card title="Sessions by channel" subtitle={`${data.range.days} days`}>
              <SessionsChart daily={data.daily} />
            </Card>
            <Card title="Channel mix">
              <ChannelDonut channels={data.channels} total={data.kpis.totalSessions} />
            </Card>
          </div>

          <Card title="Channel performance" padded={false}>
            {!shownChannels.length ? <EmptyState className="py-8" title="No bot sessions yet" description="Once your bots start chatting, each channel's figures appear here." />
              : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead><tr className="border-b border-[#EEF3F7] text-left text-[11px] font-bold uppercase tracking-wide text-[#8296A6]">
                      <th className="px-5 py-2.5">Channel</th><th className="px-3 py-2.5 text-right">Sessions</th><th className="px-3 py-2.5 text-right">Unique</th><th className="px-3 py-2.5 text-right">Handoffs</th><th className="px-3 py-2.5 text-right">Handoff %</th><th className="px-3 py-2.5 text-right">Avg time</th><th className="px-5 py-2.5 text-right">Trend</th>
                    </tr></thead>
                    <tbody>
                      {shownChannels.map((c) => {
                        const t = pct(c.sessions, c.prevSessions);
                        const Icon = CH[c.channel].icon;
                        return (
                          <tr key={c.channel} className="border-b border-[#F3F7FA] last:border-0">
                            <td className="px-5 py-3"><span className="flex items-center gap-2 font-semibold text-[#0B2A44]"><span className="flex h-6 w-6 items-center justify-center rounded-full text-white" style={{ background: CH[c.channel].color }}><Icon size={13} /></span>{CH[c.channel].label}</span></td>
                            <td className="px-3 py-3 text-right font-semibold text-[#0B2A44]">{nf(c.sessions)}</td>
                            <td className="px-3 py-3 text-right text-[#44505C]">{nf(c.uniqueUsers)}</td>
                            <td className="px-3 py-3 text-right text-[#44505C]">{nf(c.handoffs)}</td>
                            <td className="px-3 py-3 text-right text-[#44505C]">{c.sessions ? Math.round((c.handoffs / c.sessions) * 100) : 0}%</td>
                            <td className="px-3 py-3 text-right text-[#44505C]">{fmtDur(c.avgSessionSec)}</td>
                            <td className="px-5 py-3 text-right font-semibold">{t === null ? <span className="text-[#0B6BB0]">new</span> : <span className={cx(t > 0 ? 'text-emerald-600' : t < 0 ? 'text-[#B06A55]' : 'text-[#8296A6]')}>{t > 0 ? '▲' : t < 0 ? '▼' : '•'} {Math.abs(t)}%</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>

          <Card title="Bot performance" subtitle="Tap a bot to filter the whole dashboard to it" padded={false}
            actions={<Button variant="secondary" size="sm" icon={<Download size={13} />} disabled={!bots?.length} onClick={downloadCsv}>Download</Button>}>
            <div className="px-5 pb-3 pt-1">
              <label className="relative block max-w-xs">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9CB0C0]" />
                <input className={cx(inputCls, 'pl-9')} value={botSearch} onChange={(e) => setBotSearch(e.target.value)} placeholder="Search bots" aria-label="Search bots" />
              </label>
            </div>
            {bots === null ? <p className="px-5 pb-5 text-xs text-[#7E93A6]">Loading bots…</p>
              : !shownBots.length ? <EmptyState className="py-8" title={botSearch ? 'No bots match' : 'No bots yet'} description={botSearch ? 'Try a different name.' : 'Build a chatbot to see it here.'} />
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[680px] text-sm">
                      <thead><tr className="border-b border-[#EEF3F7] text-left text-[11px] font-bold uppercase tracking-wide text-[#8296A6]">
                        <th className="px-5 py-2.5">Bot name</th><th className="px-3 py-2.5">Channels</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5 text-right">Chats</th><th className="px-3 py-2.5 text-right">Handed off</th><th className="px-5 py-2.5">Created</th>
                      </tr></thead>
                      <tbody>
                        {shownBots.map((b) => (
                          <tr key={b.id} onClick={() => setBotId((id) => (id === b.id ? '' : b.id))} title="Filter the dashboard to this bot" className={cx('cursor-pointer border-b border-[#F3F7FA] last:border-0 hover:bg-[#F7FAFB]', botId === b.id && 'bg-[#EAF4FB] hover:bg-[#EAF4FB]')}>
                            <td className="px-5 py-3 font-semibold text-[#0B2A44]">{b.name || 'Untitled bot'}</td>
                            <td className="px-3 py-3"><span className="flex flex-wrap gap-1">{b.channels.map((ch) => { const meta = CH[ch as BotChannelKey]; return <span key={ch} title={meta?.label || ch} className="inline-flex h-5 w-5 items-center justify-center rounded-full text-white" style={{ background: meta?.color || '#8296A6' }}>{meta ? <meta.icon size={11} /> : null}</span>; })}</span></td>
                            <td className="px-3 py-3"><Badge tone={b.status === 'active' ? 'sage' : b.status === 'paused' ? 'amber' : 'muted'}>{b.status === 'active' ? 'Active' : b.status === 'paused' ? 'Paused' : 'Draft'}</Badge></td>
                            <td className="px-3 py-3 text-right font-semibold text-[#0B2A44]">{nf(b.stats.started)}</td>
                            <td className="px-3 py-3 text-right text-[#44505C]">{nf(b.stats.handedOff)}</td>
                            <td className="px-5 py-3 text-[#44505C]">{new Date(b.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
          </Card>

          <p className="text-[11px] text-[#8296A6]">Figures cover bot conversations started in the selected range. WhatsApp live-chat (Chat360) messages are counted separately in Reports.</p>
        </>
      )}
    </div>
  );
};
