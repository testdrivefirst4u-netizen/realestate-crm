/** WhatsApp campaigns (plan feature whatsappCampaigns; server: modules/whatsappCampaigns.ts): campaigns with their results, and templates. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Eye, Pause, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2 } from 'lucide-react';
import { api, type WaCampaignDetail, type WaCampaignView, type WaCampaignsOverview, type WaDirectTemplate } from '../../core/api';
import { dateKey, formatDateTime } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import type { ClientSegment, Lead } from '../../types/crm';
import { Badge, Button, ConfirmDialog, EmptyState, InlineNotice, LoadingState, Modal, cx, inputCls } from '../../components/ui';
import { STATUS as TEMPLATE_STATUS, TemplateModal } from '../settings/WhatsappDirectSection';
import { CampaignWizard } from './CampaignWizard';
import { TemplatePreview } from './TemplatePreview';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const STATUS: Record<WaCampaignView['status'], { label: string; tone: 'sage' | 'amber' | 'muted' | 'navy' | 'rust' }> = {
  draft: { label: 'Draft', tone: 'muted' }, scheduled: { label: 'Scheduled', tone: 'navy' }, running: { label: 'Running', tone: 'sage' }, paused: { label: 'Paused', tone: 'amber' }, completed: { label: 'Completed', tone: 'sage' }, stopped: { label: 'Stopped', tone: 'rust' },
};
const TILES: Array<{ id: '' | WaCampaignView['status']; label: string }> = [{ id: '', label: 'Total' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'running', label: 'Running' }, { id: 'completed', label: 'Completed' }, { id: 'paused', label: 'Paused' }, { id: 'stopped', label: 'Stopped' }, { id: 'draft', label: 'Draft' }];
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
const th = 'px-3 py-2 text-right text-[11px] font-semibold text-[#5E778C] whitespace-nowrap border-b border-[#D3E3F0]';
const td = 'px-3 py-2.5 text-right text-xs tabular-nums whitespace-nowrap border-b border-[#EEF4F9] text-[#0B2A44]';
const left = '!text-left';
// per-status accent for the summary cards (left bar + label + number colour)
const TILE_COLOR: Record<string, { bar: string; label: string; num: string }> = {
  '': { bar: '#0B6BB0', label: '#0B6BB0', num: '#0B2A44' },
  scheduled: { bar: '#0EA5A3', label: '#0E8A7D', num: '#0B6B63' },
  running: { bar: '#2563EB', label: '#2563EB', num: '#1D4ED8' },
  completed: { bar: '#16A34A', label: '#15803D', num: '#166534' },
  paused: { bar: '#F59E0B', label: '#B45309', num: '#92400E' },
  stopped: { bar: '#E11D48', label: '#BE123C', num: '#9F1239' },
  draft: { bar: '#94A3B8', label: '#64748B', num: '#475569' },
};
const thHdr = 'px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white whitespace-nowrap';
const iconBtn = 'grid h-8 w-8 place-items-center rounded-lg border border-[#D3E3F0] bg-white text-[#3E5A70] transition-colors hover:border-[#0B6BB0] hover:bg-[#F2F8FD] hover:text-[#0B6BB0] disabled:opacity-40';
const PER_PAGE_OPTS = [10, 25, 50];

const Report: React.FC<{ c: WaCampaignView; creditsOn: boolean; onClose: () => void }> = ({ c, creditsOn, onClose }) => {
  const [d, setD] = useState<WaCampaignDetail | null>(null);
  useEffect(() => {
    let live = true;
    api.campaigns.detail(c.id).then((r) => { if (live) setD(r); }, (e) => reportError('campaign.detail', e));
    return () => { live = false; };
  }, [c.id]);
  const s = c.stats;
  const facts: Array<[string, string]> = [['People', s.total.toLocaleString('en-IN')], ['Sent', s.sent.toLocaleString('en-IN')], ['Delivered', `${s.delivered.toLocaleString('en-IN')} (${pct(s.delivered, s.sent)})`], ['Read', `${s.read.toLocaleString('en-IN')} (${pct(s.read, s.delivered)})`], ['Replied', `${s.replied.toLocaleString('en-IN')} (${pct(s.replied, s.delivered)})`], ['Failed', s.failed.toLocaleString('en-IN')], ['Site visits', d ? d.visits.toLocaleString('en-IN') : '…'], ['Bookings', d ? d.bookings.toLocaleString('en-IN') : '…']];
  if (creditsOn) facts.push(['Credits used', `₹${s.credits.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`]);
  return (
    <Modal open onClose={onClose} title={c.name} subtitle={`${c.template} · ${c.audience || 'Chosen people'}`}>
      {c.pauseReason && c.status === 'paused' && <InlineNotice tone="warning" className="mb-3">{c.pauseReason}</InlineNotice>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{facts.map(([k, v]) => <div key={k}><dt className="text-[11px] text-[#5E778C]">{k}</dt><dd className="text-sm font-bold tabular-nums text-[#0B2A44]">{v}</dd></div>)}</dl>
      <p className="mt-3 text-[11px] text-[#5E778C]">Site visits and bookings are what these leads have done so far, including after a call from an RM. They do not prove the campaign caused them. Read counts miss people who turned read receipts off.</p>
      {Object.keys(c.skippedAtStart).length > 0 && <p className="mt-2 text-[11px] text-[#5E778C]">Left out at the start: {Object.entries(c.skippedAtStart).map(([k, n]) => `${k} (${n})`).join(', ')}</p>}
      {!!d?.failures.length && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-[#0B2A44]">Not delivered{s.failed > d.failures.length ? ` (first ${d.failures.length})` : ''}</p>
          <ul className="mt-1 max-h-48 divide-y divide-[#EEF4F9] overflow-y-auto text-xs">{d.failures.map((f, i) => <li key={i} className="py-1.5"><span className="font-medium text-[#0B2A44]">{f.name || f.phone}</span><span className="block text-[11px] text-[#B42318]">{f.error}</span></li>)}</ul>
        </div>
      )}
    </Modal>
  );
};

export const CampaignsView: React.FC<{ leads: Lead[]; segments: ClientSegment[]; stages: string[]; sources: string[]; rms: string[] }> = ({ leads, segments, stages, sources, rms }) => {
  const [data, setData] = useState<WaCampaignsOverview | null>(null);
  const [templates, setTemplates] = useState<WaDirectTemplate[]>([]);
  const [failed, setFailed] = useState('');
  const [tab, setTab] = useState<'campaigns' | 'templates'>('campaigns');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | WaCampaignView['status']>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [making, setMaking] = useState<{ existing?: WaCampaignView } | null>(null);
  const [report, setReport] = useState<string>('');
  const [addingTemplate, setAddingTemplate] = useState(false);
  const [removingTemplate, setRemovingTemplate] = useState<WaDirectTemplate | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<WaDirectTemplate | null>(null);
  const [stopping, setStopping] = useState<{ c: WaCampaignView; action: 'stop' | 'delete' } | null>(null);
  const [busy, setBusy] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([api.campaigns.list(), api.campaigns.templates()]);
      setData(c);
      setTemplates(t);
      setFailed('');
    } catch (e) {
      setFailed(errText('campaigns.list', e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const running = !!data?.campaigns.some((c) => c.status === 'running');
  // while one is sending, this screen also pushes it along, and shows the numbers moving
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api.campaigns.tick().catch(() => undefined).finally(() => void load());
    }, 15000);
    return () => clearInterval(t);
  }, [running, load]);

  const change = async (c: WaCampaignView, action: 'pause' | 'resume' | 'stop' | 'delete') => {
    setBusy(c.id);
    try {
      await api.campaigns.change(c.id, action);
      setStopping(null);
      await load();
    } catch (e) {
      toast('Not changed', errText('campaigns.change', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const refreshTemplates = async () => {
    setBusy('sync');
    try {
      await api.whatsappDirect.syncTemplates();
      await load();
    } catch (e) {
      toast('Not refreshed', errText('campaigns.sync', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.campaigns || []).filter((c) => (!statusFilter || c.status === statusFilter) && (!term || `${c.name} ${c.template}`.toLowerCase().includes(term)) && (!from || dateKey(c.createdAt) >= from) && (!to || dateKey(c.createdAt) <= to));
  }, [data, q, statusFilter, from, to]);
  useEffect(() => { setPage(1); }, [q, statusFilter, from, to, perPage]);
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const curPage = Math.min(page, totalPages);
  const paged = useMemo(() => list.slice((curPage - 1) * perPage, curPage * perPage), [list, curPage, perPage]);

  if (!data) return failed ? <div className="p-6"><InlineNotice tone="warning">{failed}</InlineNotice></div> : <LoadingState label="Loading campaigns…" />;
  const opened = data.campaigns.find((c) => c.id === report);
  const countOf = (id: '' | WaCampaignView['status']) => (id ? data.campaigns.filter((c) => c.status === id).length : data.campaigns.length);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">WhatsApp Campaigns</h2>
          <p className="mt-0.5 text-xs text-[#5E778C]">Send an approved template to people who agreed to hear from you, now or at a set time.</p>
        </div>
        <Button variant="primary" icon={<Plus size={14} />} disabled={!data.connected} onClick={() => setMaking({})}>Create campaign</Button>
      </div>
      {!data.connected && <InlineNotice tone="warning">Connect a WhatsApp number in Settings › WhatsApp direct to create a campaign.</InlineNotice>}

      <div role="tablist" aria-label="View" className="flex gap-1.5">
        {([['campaigns', 'Campaigns'], ['templates', 'Templates']] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('rounded-full px-4 py-1.5 text-[13px] font-semibold', tab === id ? 'bg-[#0B6BB0] text-white' : 'bg-white text-[#3E5A70] border border-[#D3E3F0] hover:bg-[#F2F7FB]')}>{label}</button>)}
      </div>

      {tab === 'campaigns' && (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
            {TILES.map((t) => {
              const col = TILE_COLOR[t.id] || TILE_COLOR[''];
              const on = statusFilter === t.id;
              return (
                <button key={t.label} type="button" aria-pressed={on} onClick={() => setStatusFilter(t.id)}
                  className={cx('relative overflow-hidden rounded-xl border bg-white py-2.5 pl-4 pr-3 text-left shadow-[0_1px_2px_rgba(11,42,68,.05)] transition-all hover:-translate-y-px hover:shadow-[0_6px_16px_-8px_rgba(11,42,68,.25)]', on ? 'border-[#0B6BB0] ring-1 ring-[#0B6BB0]' : 'border-[#E3EDF5]')}>
                  <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] rounded-r" style={{ background: col.bar }} />
                  <span className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: col.label }}>{t.label}</span>
                  <span className="mt-0.5 block text-2xl font-bold leading-none tabular-nums" style={{ color: col.num }}>{countOf(t.id)}</span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-1"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5E778C]" aria-hidden="true" /><input className={cx(inputCls, 'pl-8')} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search campaigns" aria-label="Search campaigns" /></label>
            <input type="date" className={cx(inputCls, '!w-auto')} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Created from" />
            <input type="date" className={cx(inputCls, '!w-auto')} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Created to" />
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => void load()}>Refresh</Button>
          </div>
          {!list.length ? <EmptyState title={data.campaigns.length ? 'No campaigns match' : 'No campaigns yet'} description={data.campaigns.length ? 'Try another search or date.' : 'Create one to send a template to many people at once.'} /> : (
            <div className="overflow-hidden rounded-xl border border-[#D3E3F0] bg-white shadow-[0_1px_2px_rgba(11,42,68,.05)]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] border-collapse">
                  <thead><tr className="bg-gradient-to-r from-[#0B4E85] to-[#0B6BB0]"><th className={cx(thHdr, '!text-left')}>Campaign</th><th className={cx(thHdr, '!text-left')}>Status</th><th className={thHdr}>People</th><th className={thHdr}>Sent</th><th className={thHdr}>Delivered</th><th className={thHdr}>Read</th><th className={thHdr}>Replied</th><th className={thHdr}>Failed</th><th className={cx(thHdr, '!text-left')}>When</th><th className={cx(thHdr, '!text-center')}>Actions</th></tr></thead>
                  <tbody>
                    {paged.map((c, i) => {
                      const st = STATUS[c.status];
                      const s = c.stats;
                      return (
                        <tr key={c.id} className={cx('transition-colors hover:bg-[#F2F8FD]', i % 2 ? 'bg-[#FAFCFE]' : 'bg-white')}>
                          <td className={cx(td, left, '!whitespace-normal min-w-[200px]')}><button type="button" className="text-left font-semibold text-[#0B5E9C] hover:underline" onClick={() => setReport(c.id)}>{c.name}</button><span className="block break-all text-[11px] text-[#5E778C]">{c.template}</span></td>
                          <td className={cx(td, left)}><Badge tone={st.tone}>{st.label}</Badge>{c.status === 'running' && s.waiting > 0 && <span className="block text-[10.5px] text-[#5E778C]">{s.waiting.toLocaleString('en-IN')} to go</span>}</td>
                          <td className={td}>{s.total.toLocaleString('en-IN')}</td>
                          <td className={td}>{s.sent.toLocaleString('en-IN')}</td>
                          <td className={td}>{s.delivered.toLocaleString('en-IN')}</td>
                          <td className={td}>{s.read.toLocaleString('en-IN')}</td>
                          <td className={td}>{s.replied.toLocaleString('en-IN')}</td>
                          <td className={cx(td, s.failed > 0 && '!text-[#B42318] font-semibold')}>{s.failed.toLocaleString('en-IN')}</td>
                          <td className={cx(td, left, 'text-[11px]')}>{formatDateTime(c.status === 'scheduled' ? c.scheduledAt : c.startedAt || c.createdAt)}</td>
                          <td className={cx(td, '!text-center')}>
                            <span className="inline-flex items-center gap-1.5">
                              <button type="button" className={iconBtn} aria-label={`View report for ${c.name}`} title="Report" onClick={() => setReport(c.id)}><BarChart3 size={15} /></button>
                              {c.status === 'draft' && <button type="button" className={iconBtn} aria-label={`Edit ${c.name}`} title="Edit" onClick={() => setMaking({ existing: c })}><Pencil size={15} /></button>}
                              {(c.status === 'running' || c.status === 'scheduled') && <button type="button" className={iconBtn} aria-label={`Pause ${c.name}`} title="Pause" disabled={busy === c.id} onClick={() => void change(c, 'pause')}><Pause size={15} /></button>}
                              {c.status === 'paused' && <button type="button" className={iconBtn} aria-label={`Resume ${c.name}`} title="Resume" disabled={busy === c.id} onClick={() => void change(c, 'resume')}><Play size={15} /></button>}
                              {['running', 'scheduled', 'paused'].includes(c.status) && <button type="button" className={iconBtn} aria-label={`Stop ${c.name}`} title="Stop" onClick={() => setStopping({ c, action: 'stop' })}><Square size={15} /></button>}
                              {c.status === 'draft' && <button type="button" className={cx(iconBtn, 'hover:!border-[#E11D48] hover:!text-[#E11D48] hover:!bg-[#FEF2F3]')} aria-label={`Delete ${c.name}`} title="Delete" onClick={() => setStopping({ c, action: 'delete' })}><Trash2 size={15} /></button>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#EEF4F9] px-4 py-2.5">
                <span className="flex items-center gap-2 text-[12px] text-[#5E778C]">
                  Showing <b className="text-[#0B2A44]">{(curPage - 1) * perPage + 1}–{Math.min(curPage * perPage, list.length)}</b> of <b className="text-[#0B2A44]">{list.length}</b>
                  <select value={perPage} onChange={(e) => setPerPage(Number(e.target.value))} className="ml-1 rounded-lg border border-[#D3E3F0] bg-white px-2 py-1 text-[12px] text-[#0B2A44] focus:border-[#0B6BB0] focus:outline-none" aria-label="Rows per page">
                    {PER_PAGE_OPTS.map((n) => <option key={n} value={n}>{n} / page</option>)}
                  </select>
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" className={cx(iconBtn, 'w-auto px-2 gap-1 text-[12px] font-semibold')} disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}><ChevronLeft size={14} /> Prev</button>
                  <span className="px-2 text-[12px] font-semibold text-[#3E5A70]">Page {curPage} of {totalPages}</span>
                  <button type="button" className={cx(iconBtn, 'w-auto px-2 gap-1 text-[12px] font-semibold')} disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>Next <ChevronRight size={14} /></button>
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'templates' && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[#5E778C]">Meta must approve a template before it can be sent, usually quickly, but it can take longer.</p>
            <span className="flex gap-1.5"><Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={busy === 'sync' ? 'animate-spin' : ''} />} disabled={!data.connected} onClick={() => void refreshTemplates()}>Refresh</Button><Button variant="primary" size="sm" icon={<Plus size={13} />} disabled={!data.connected} onClick={() => setAddingTemplate(true)}>New template</Button></span>
          </div>
          {!templates.length ? <EmptyState title="No templates yet" description="Add a template and get it approved by Meta before you can send a campaign." /> : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((t) => {
                const s = TEMPLATE_STATUS[t.status] || { label: t.status.toLowerCase(), tone: 'muted' as const };
                return (
                  <div key={`${t.name}:${t.language}`} className="flex flex-col rounded-xl border border-[#E3EDF5] bg-white p-4 shadow-[0_1px_2px_rgba(11,42,68,.05)] transition-shadow hover:shadow-[0_8px_20px_-12px_rgba(11,42,68,.3)]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-all text-[13.5px] font-bold text-[#0B2A44]">{t.name}</span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-[#8296A6]">{t.language} · {t.category.toLowerCase()}{t.headerMedia ? ` · ${t.headerMedia}` : ''}</p>
                    <p className="mt-2 line-clamp-4 flex-1 whitespace-pre-wrap break-words text-xs text-[#3E5A70]">{t.body}</p>
                    {t.reason && <p className="mt-2 rounded-md bg-[#FEF2F3] px-2 py-1 text-[11px] text-[#B42318]">Meta's reason: {t.reason.toLowerCase().replace(/_/g, ' ')}</p>}
                    {!t.sendable && !t.headerMedia && <p className="mt-2 rounded-md bg-[#FFF7E6] px-2 py-1 text-[11px] text-[#8A5A00]">{t.notSendable}</p>}
                    <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-[#EEF4F9] pt-3">
                      <button type="button" className={cx(iconBtn, 'w-auto gap-1 px-2.5 text-[12px] font-semibold')} onClick={() => setViewingTemplate(t)}><Eye size={14} /> Preview</button>
                      <button type="button" className={cx(iconBtn, 'hover:!border-[#E11D48] hover:!bg-[#FEF2F3] hover:!text-[#E11D48]')} aria-label={`Delete ${t.name}`} title="Delete" onClick={() => setRemovingTemplate(t)}><Trash2 size={15} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {making && <CampaignWizard leads={leads} segments={segments} stages={stages} sources={sources} rms={rms} templates={templates} creditsOn={data.creditsOn} prices={data.prices} existing={making.existing} onClose={() => { setMaking(null); void load(); }} onDone={() => { setMaking(null); toast('Campaign started', 'You can leave this screen. It keeps sending.', 'success'); void load(); }} />}
      {opened && <Report c={opened} creditsOn={data.creditsOn} onClose={() => setReport('')} />}
      {viewingTemplate && <Modal open onClose={() => setViewingTemplate(null)} title={viewingTemplate.name} subtitle="Highlighted parts are filled in for each person."><TemplatePreview template={viewingTemplate} className="mx-auto max-w-[300px]" /></Modal>}
      {addingTemplate && <TemplateModal onClose={() => setAddingTemplate(false)} onSaved={() => { setAddingTemplate(false); void load(); }} />}
      <ConfirmDialog open={!!stopping} danger title={stopping?.action === 'stop' ? 'Stop this campaign?' : 'Delete this draft?'} message={stopping?.action === 'stop' ? `“${stopping.c.name}” stops for good. People not yet messaged will not get it, and it cannot be restarted. To carry on later, pause it instead.` : `“${stopping?.c.name}” will be deleted.`} confirmLabel={stopping?.action === 'stop' ? 'Stop campaign' : 'Delete'} loading={!!stopping && busy === stopping.c.id} onConfirm={() => stopping && void change(stopping.c, stopping.action)} onCancel={() => setStopping(null)} />
      <ConfirmDialog open={!!removingTemplate} danger title="Delete this template?" message={`Meta deletes “${removingTemplate?.name}” in every language, and any campaign still using it will pause.`} confirmLabel="Delete" loading={busy === 'tpl'} onConfirm={async () => { if (!removingTemplate) return; setBusy('tpl'); try { await api.whatsappDirect.deleteTemplate(removingTemplate.name); setRemovingTemplate(null); await load(); } catch (e) { toast('Not deleted', errText('campaigns.deleteTemplate', e), 'alert'); } finally { setBusy(''); } }} onCancel={() => setRemovingTemplate(null)} />
    </div>
  );
};
