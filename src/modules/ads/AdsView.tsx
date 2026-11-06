/**
 * Ads manager (/ads, plan feature adsControl; server: modules/adsControl.ts): the Meta table (MetaAdsTable.tsx), and an overview of Meta and Google Ads campaigns with
 * 7 days' spend and CRM leads, pause / resume, daily budget, and the "spending without leads" alert.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, Pause, Pencil, Play, RefreshCw } from 'lucide-react';
import { api, type AdCampaign } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, EmptyState, InlineNotice, Tabs, cx, inputCls } from '../../components/ui';
import { MetaAdsTable } from './MetaAdsTable';

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const th = 'px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide text-[#7E93A6] whitespace-nowrap';
const td = 'px-3 py-2.5 text-xs text-[#0B2A44] align-middle';

export const AdsView: React.FC<{ canChange: boolean; canExport?: boolean }> = ({ canChange, canExport }) => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.ads.list>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [alerts, setAlerts] = useState({ enabled: true, minSpend: '3000' });
  const [tab, setTab] = useState<'meta' | 'overview'>('meta');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.ads.list();
      setData(r);
      setAlerts({ enabled: r.alerts.enabled, minSpend: String(r.alerts.minSpend) });
    } catch (e) {
      toast('Could not load the campaigns', errText('ads.list', e), 'alert');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (tab === 'overview') void load(); }, [load, tab]);

  const key = (c: AdCampaign) => `${c.platform}:${c.id}`;
  const status = async (c: AdCampaign) => {
    const next = c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    if (!window.confirm(`${next === 'PAUSED' ? 'Pause' : 'Resume'} “${c.name}”?`)) return;
    setBusy(key(c));
    try {
      await api.ads.setStatus(c, next);
      toast(next === 'PAUSED' ? 'Campaign paused' : 'Campaign resumed', c.name, 'success');
      await load();
    } catch (e) {
      toast('Not changed', errText('ads.status', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const budget = async (c: AdCampaign) => {
    const v = Number(editing?.value);
    if (!Number.isFinite(v) || v < 100) return toast('Enter a daily budget of at least ₹100', undefined, 'alert');
    if (c.dailyBudget && (v > c.dailyBudget * 2 || v < c.dailyBudget / 2) && !window.confirm(`Change the daily budget from ${inr(c.dailyBudget)} to ${inr(v)}?`)) return;
    setBusy(key(c));
    try {
      await api.ads.setBudget(c, v);
      setEditing(null);
      toast('Budget changed', `${c.name}: ${inr(v)} a day`, 'success');
      await load();
    } catch (e) {
      toast('Budget not changed', errText('ads.budget', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const saveAlerts = async () => {
    setBusy('alerts');
    try {
      const r = await api.ads.saveAlerts({ enabled: alerts.enabled, minSpend: Number(alerts.minSpend) });
      setAlerts({ enabled: r.enabled, minSpend: String(r.minSpend) });
      toast('Alert saved', undefined, 'success');
    } catch (e) {
      toast('Could not save', errText('ads.alerts', e), 'alert');
    } finally {
      setBusy('');
    }
  };

  const camps = data?.campaigns || [];
  const total = camps.reduce((t, c) => ({ spend: t.spend + c.spend7, leads: t.leads + c.leads7 }), { spend: 0, leads: 0 });

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      <Tabs tabs={[{ id: 'meta', label: 'Meta ads' }, { id: 'overview', label: 'Overview (Meta + Google)' }]} value={tab} onChange={(v) => setTab(v as 'meta' | 'overview')} />
      {tab === 'meta' ? <MetaAdsTable canChange={canChange} canExport={canExport} /> : (<>
      <Card title="Campaigns · last 7 days" subtitle="Spend from Meta and Google Ads; leads are the CRM leads that came from each campaign."
        actions={<Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load()}>Refresh</Button>}>
        {data?.errors.meta && <InlineNotice tone="warning" className="mb-2">Meta: {data.errors.meta}</InlineNotice>}
        {data?.errors.google && <InlineNotice tone="warning" className="mb-2">Google Ads: {data.errors.google}</InlineNotice>}
        {!data ? <p className="text-xs text-[#5E778C]">Loading…</p> : !camps.length ? (
          <EmptyState title="No campaigns" description="Connect Facebook (Settings › Meta ads) and Google (Settings › Google) to see the campaigns here." />
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full border-collapse min-w-[760px]">
              <thead><tr className="border-b border-[#EEF4F9]"><th className={th}>Campaign</th><th className={th}>Status</th><th className={cx(th, 'text-right')}>Daily budget</th><th className={cx(th, 'text-right')}>Spend (7 days)</th><th className={cx(th, 'text-right')}>Leads</th><th className={cx(th, 'text-right')}>Cost per lead</th><th className={th} /></tr></thead>
              <tbody className="divide-y divide-[#EEF4F9]">
                {camps.map((c) => (
                  <tr key={key(c)} className={cx(c.status === 'ACTIVE' && c.spend7 > 0 && !c.leads7 && 'bg-[#FFF8F1]')}>
                    <td className={td}><b className="block max-w-[280px] truncate" title={c.name}>{c.name}</b><span className="text-[11px] text-[#7E93A6]">{c.platform === 'meta' ? 'Meta' : 'Google Ads'} · {c.account}</span></td>
                    <td className={td}><Badge tone={c.status === 'ACTIVE' ? 'sage' : 'muted'}>{c.status === 'ACTIVE' ? 'Running' : c.status === 'PAUSED' ? 'Paused' : 'Other'}</Badge></td>
                    <td className={cx(td, 'text-right tabular-nums')}>
                      {editing?.key === key(c) ? (
                        <span className="inline-flex items-center gap-1">
                          <input className={cx(inputCls, 'w-24 text-right')} type="number" min={100} step={100} value={editing.value} onChange={(e) => setEditing({ key: key(c), value: e.target.value })} aria-label="Daily budget" autoFocus />
                          <Button variant="primary" size="xs" loading={busy === key(c)} onClick={() => void budget(c)}>Save</Button>
                          <Button variant="secondary" size="xs" onClick={() => setEditing(null)}>Cancel</Button>
                        </span>
                      ) : c.dailyBudget !== null ? (
                        <span className="inline-flex items-center gap-1">{inr(c.dailyBudget)}{canChange && <button type="button" aria-label="Change budget" className="text-[#0B5E9C]" onClick={() => setEditing({ key: key(c), value: String(c.dailyBudget) })}><Pencil size={12} /></button>}</span>
                      ) : <span className="text-[#7E93A6]" title={c.platform === 'meta' ? 'Budget set on the ad sets' : 'Shared budget'}>{c.platform === 'meta' ? 'On ad sets' : 'Shared'}</span>}
                    </td>
                    <td className={cx(td, 'text-right tabular-nums')}>{inr(c.spend7)}</td>
                    <td className={cx(td, 'text-right tabular-nums', !c.leads7 && c.spend7 > 0 && 'text-[#B42318] font-semibold')}>{c.leads7}</td>
                    <td className={cx(td, 'text-right tabular-nums font-semibold')}>{c.leads7 ? inr(c.spend7 / c.leads7) : '—'}</td>
                    <td className={cx(td, 'text-right')}>
                      {canChange && c.status !== 'OTHER' && (
                        <Button variant="secondary" size="xs" icon={c.status === 'ACTIVE' ? <Pause size={12} /> : <Play size={12} />} loading={busy === key(c) && !editing} onClick={() => void status(c)}>{c.status === 'ACTIVE' ? 'Pause' : 'Resume'}</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-[#D3E3F0]"><td className={cx(td, 'font-semibold')} colSpan={3}>All campaigns</td><td className={cx(td, 'text-right font-semibold tabular-nums')}>{inr(total.spend)}</td><td className={cx(td, 'text-right font-semibold tabular-nums')}>{total.leads}</td><td className={cx(td, 'text-right font-semibold tabular-nums')}>{total.leads ? inr(total.spend / total.leads) : '—'}</td><td /></tr></tfoot>
            </table>
          </div>
        )}
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><BellRing size={16} className="text-[#0B6BB0]" /> Spending without leads</span>}
        subtitle="Every morning: a running campaign that spent at least this much in 7 days with no lead in the CRM sends a phone notification to Admins and Managers (once a week per campaign).">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className={cx('inline-flex items-center gap-2', !canChange && 'opacity-60')}><input type="checkbox" className="h-4 w-4 accent-[#0B2A44]" checked={alerts.enabled} disabled={!canChange} onChange={(e) => setAlerts((a) => ({ ...a, enabled: e.target.checked }))} /> Alert me</label>
          <span>when spend reaches ₹</span>
          <input className={cx(inputCls, 'w-28')} type="number" min={500} step={500} value={alerts.minSpend} disabled={!canChange} onChange={(e) => setAlerts((a) => ({ ...a, minSpend: e.target.value }))} aria-label="Spend" />
          {canChange && <Button variant="primary" size="sm" loading={busy === 'alerts'} onClick={() => void saveAlerts()}>Save</Button>}
        </div>
      </Card>
      </>)}
    </div>
  );
};
