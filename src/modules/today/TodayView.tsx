/**
 * Today — the role-aware home (Release B).
 *   Agent:            my queue, in the order to work it
 *   Manager / Admin:  my queue + Team (exceptions, approvals, workload, audited reassignment)
 *   View only:        Business (the founder report: funnel, response SLA, value by kind, data freshness). No controls.
 *
 * States: loading (skeleton rows), empty (says what "done" means), error (retry), offline (keeps the last data and
 * says how old it is), partial (a section that fails does not hide the others).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, MapPin, PhoneMissed, RefreshCw, UserPlus, WifiOff } from 'lucide-react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { formatDateTime, formatRelative } from '../../core/dates';
import { formatINR } from '../../core/format';
import type { Insight, SalesReport, TeamData, TodayData, QueueRow } from '../../core/journeyTypes';
import type { UserAccount } from '../../types/crm';
import { Button, ErrorState, InlineNotice, Select, cx, inputCls } from '../../components/ui';
import { ConstructionPanel } from './ConstructionPanel';
import { MyMonth, TeamScorecard } from './Scorecard';
import { OrgPanel } from './OrgPanel';

type Tab = 'mine' | 'team' | 'business';

export const TodayView: React.FC<{
  currentUser: UserAccount | null;
  can: (p: any) => boolean;
  viewOnly: boolean;
  users: Array<{ id: string; name: string; role: string }>;
  onOpenLead: (id: string) => void;
}> = ({ currentUser, can, viewOnly, users, onOpenLead }) => {
  const manager = can('leads.viewAll') && !viewOnly;
  const tabs: Array<{ id: Tab; label: string }> = viewOnly
    ? [{ id: 'business', label: 'Business' }]
    : [{ id: 'mine', label: 'My work' }, ...(manager ? [{ id: 'team' as Tab, label: 'Team' }] : []), ...(can('reports.view') ? [{ id: 'business' as Tab, label: 'Business' }] : [])];
  const [tab, setTab] = useState<Tab>(tabs[0].id);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-[#5E778C]">{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date())}</p>
          <h1 className="mt-0.5">{viewOnly ? 'How sales are going' : `Good ${greeting()}, ${String(currentUser?.name || '').split(' ')[0]}`}</h1>
        </div>
        {tabs.length > 1 && (
          <div role="tablist" aria-label="Today" className="inline-flex rounded-lg border border-[#D3E3F0] bg-white p-0.5">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={cx('min-h-9 px-3.5 rounded-md text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0B6BB0]', tab === t.id ? 'bg-[#0B2A44] text-white' : 'text-[#0B2A44] hover:bg-[#F2F7FB]')}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </header>
      {!online && (
        <InlineNotice tone="warning"><WifiOff size={13} className="inline -mt-0.5 mr-1" aria-hidden />You are offline. What is shown is from the last refresh; changes cannot be saved until the connection is back.</InlineNotice>
      )}
      {tab === 'mine' && <MyWork onOpenLead={onOpenLead} online={online} />}
      {tab === 'team' && manager && <Team onOpenLead={onOpenLead} users={users} online={online} />}
      {tab === 'team' && can('users.manage') && <OrgPanel />}
      {tab === 'business' && <Business />}
    </div>
  );
};

const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};

/** Load once, refresh every minute while the tab is visible, keep the last good data on failure. */
function useLive<T>(load: () => Promise<T>, online: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setData(await load());
      setError('');
    } catch (e) {
      setError(toAppError(e).userMessage);
    } finally {
      setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && online) void refresh();
    }, 60_000);
    return () => window.clearInterval(t);
  }, [refresh, online]);
  return { data, error, busy, refresh };
}

const RefreshLine: React.FC<{ at?: string; busy: boolean; onRefresh: () => void }> = ({ at, busy, onRefresh }) => (
  <div className="flex items-center gap-2 text-[11px] text-[#5E778C]">
    {at && <span>Updated {formatRelative(at)}</span>}
    <button onClick={onRefresh} disabled={busy} className="inline-flex items-center gap-1 min-h-8 px-2 rounded-md hover:bg-white focus-visible:outline-2 focus-visible:outline-[#0B6BB0]" aria-label="Refresh">
      <RefreshCw size={12} className={busy ? 'animate-spin' : ''} aria-hidden />Refresh
    </button>
  </div>
);

/* --------------------------------- my work --------------------------------- */

const MyWork: React.FC<{ onOpenLead: (id: string) => void; online: boolean }> = ({ onOpenLead, online }) => {
  const { data, error, busy, refresh } = useLive<TodayData>(useCallback(() => api.workspace.today(), []), online);
  if (!data && error) return <ErrorState title="Could not load your work" message={error} onRetry={refresh} />;
  const allClear = data && !data.newEnquiries.length && !data.missedCalls.length && !data.tasks.length && !data.overdueFollowups.length && !data.dueToday.length && !data.noNextAction.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Summary data={data} />
        <RefreshLine at={data?.generatedAt} busy={busy} onRefresh={refresh} />
      </div>
      {error && <InlineNotice tone="warning">Showing the last good list: {error}</InlineNotice>}
      {allClear && (
        <div className="rounded-2xl border border-[#0E8A86]/25 bg-[#EAF4F3] px-5 py-4 text-sm text-[#0B4F4C] flex items-start gap-3">
          <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0" aria-hidden />
          <div><strong>Nothing waiting.</strong> Every enquiry has been contacted and has a next step. New enquiries and missed calls appear here as they arrive.</div>
        </div>
      )}
      <NextSteps onOpen={onOpenLead} version={data?.generatedAt || ''} />
      <MyMonth />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-5">
        <Queue id="new" title="New enquiries" hint={data ? `Call within ${data.slaHours} h` : ''} icon={<UserPlus size={14} />} rows={data?.newEnquiries} onOpen={onOpenLead} empty="No uncontacted enquiries." urgentFirst />
        <Queue id="missed" title="Missed calls to return" icon={<PhoneMissed size={14} />} rows={data?.missedCalls.map((c) => ({ leadId: c.leadId, name: c.name || c.phone, phone: c.phone, stage: '', rm: '', at: c.at, note: c.leadId ? 'Called you' : 'Not a lead yet', late: c.minutesAgo > 30 }))} onOpen={onOpenLead} empty="No missed calls waiting." />
        <TaskQueue tasks={data?.tasks} onOpen={onOpenLead} />
        <Queue id="overdue" title="Follow-ups overdue" icon={<AlertTriangle size={14} />} rows={data?.overdueFollowups} onOpen={onOpenLead} empty="Nothing overdue." />
        <Queue id="today" title="Follow-ups today" icon={<CalendarClock size={14} />} rows={data?.dueToday} onOpen={onOpenLead} empty="No follow-ups due today." />
        <Queue id="visits" title="Visits this week" icon={<MapPin size={14} />} rows={data?.upcomingVisits} onOpen={onOpenLead} empty="No visits scheduled in the next 7 days." showDate />
        <Queue id="nonext" title="Open enquiries with no next step" hint="Each needs one" rows={data?.noNextAction} onOpen={onOpenLead} empty="Every open enquiry has a next step." wide />
        <Queue id="cooling" title="Going quiet" hint="Send something of value, not a check-in" rows={data?.cooling} onOpen={onOpenLead} empty="Every active enquiry has responded recently." />
        <CustomerQueue rows={data?.customers} onOpen={onOpenLead} />
      </div>
    </div>
  );
};

const Summary: React.FC<{ data: TodayData | null }> = ({ data }) => {
  const items: Array<[string, string, number | undefined, boolean]> = [
    ['new', 'new', data?.counts.newEnquiries, (data?.counts.late || 0) > 0],
    ['missed', 'missed calls', data?.counts.missedCalls, (data?.counts.missedCalls || 0) > 0],
    ['tasks', 'callbacks', data?.counts.tasks, false],
    ['overdue', 'overdue', data?.counts.overdueFollowups, (data?.counts.overdueFollowups || 0) > 0],
    ['visits', 'visits', data?.counts.upcomingVisits, false],
    ['customers', 'customers', data?.counts.customers, false],
  ];
  return (
    <nav aria-label="Jump to" className="flex flex-wrap gap-1.5">
      {items.map(([id, label, n, hot]) => (
        <a key={id} href={`#q-${id}`} className={cx('min-h-9 inline-flex items-center gap-1.5 px-3 rounded-full border text-xs focus-visible:outline-2 focus-visible:outline-[#0B6BB0]', hot ? 'border-[#B06A55]/40 bg-[#FAF0EC] text-[#8A3E28]' : 'border-[#D3E3F0] bg-white text-[#0B2A44]')}>
          <strong className="tabular-nums">{n ?? '–'}</strong>{label}
        </a>
      ))}
    </nav>
  );
};

const Queue: React.FC<{ id: string; title: string; hint?: string; icon?: React.ReactNode; rows?: QueueRow[]; onOpen: (id: string) => void; empty: string; showDate?: boolean; showRm?: boolean; urgentFirst?: boolean; wide?: boolean; selectable?: { selected: Set<string>; toggle: (id: string) => void } }> = ({ id, title, hint, icon, rows, onOpen, empty, showDate, showRm, urgentFirst, wide, selectable }) => {
  const list = useMemo(() => (rows && urgentFirst ? [...rows].sort((a, b) => Number(b.late) - Number(a.late)) : rows), [rows, urgentFirst]);
  return (
    <section id={`q-${id}`} aria-labelledby={`h-${id}`} className={cx('scroll-mt-20', wide && 'lg:col-span-2')}>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h2 id={`h-${id}`} className="text-sm font-bold text-[#0B2A44] inline-flex items-center gap-1.5">{icon && <span className="text-[#0B6BB0]" aria-hidden>{icon}</span>}{title}{list && <span className="text-[#5E778C] font-normal tabular-nums">{list.length}</span>}</h2>
        {hint && <span className="text-[11px] text-[#5E778C]">{hint}</span>}
      </div>
      {!list ? (
        <div className="space-y-1.5" aria-label={`Loading ${title}`}>{[0, 1].map((i) => <div key={i} className="h-12 rounded-lg bg-white/70 animate-pulse" />)}</div>
      ) : !list.length ? (
        <p className="text-xs text-[#7E93A6] py-3 px-3 rounded-lg border border-dashed border-[#D3E3F0]">{empty}</p>
      ) : (
        <ul className="rounded-xl border border-[#E3EDF5] bg-white divide-y divide-[#EEF3F8] overflow-hidden">
          {list.slice(0, 25).map((r, i) => (
            <li key={`${r.leadId}-${i}`} className="flex items-stretch">
              {selectable && r.leadId && (
                <label className="flex items-center pl-3"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selectable.selected.has(r.leadId)} onChange={() => selectable.toggle(r.leadId)} className="w-4 h-4 accent-[#0B2A44]" /></label>
              )}
              <button disabled={!r.leadId} onClick={() => r.leadId && onOpen(r.leadId)} className="flex-1 min-w-0 text-left px-3 py-2.5 min-h-12 hover:bg-[#F7FAFD] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0B6BB0] disabled:cursor-default">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-[#0B2A44] truncate">{r.name || 'Unknown'}</span>
                  <span className={cx('text-[11px] tabular-nums flex-shrink-0', r.late ? 'text-[#B06A55] font-semibold' : 'text-[#5E778C]')}>{r.at ? (showDate ? formatDateTime(r.at, '') : formatRelative(r.at)) : ''}</span>
                </div>
                <div className="text-[11px] text-[#5E778C] truncate">{[r.note, r.stage, showRm ? r.rm || 'Unassigned' : '', r.phone].filter(Boolean).join(' · ')}</div>
              </button>
            </li>
          ))}
          {list.length > 25 && <li className="px-3 py-2 text-[11px] text-[#5E778C]">and {list.length - 25} more</li>}
        </ul>
      )}
    </section>
  );
};

/** Booked customers with an SOP step due (welcome call, owner, community preview, monthly update, referral, re-engage). */
/** The best next steps across my enquiries and customers (server/modules/insights.ts), most urgent first. */
const NextSteps: React.FC<{ onOpen: (id: string) => void; version: string }> = ({ onOpen, version }) => {
  const [rows, setRows] = useState<Insight[] | null>(null);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    api.insights.nextSteps().then((r) => { setRows(r); setError(''); }, (e) => setError(toAppError(e).userMessage));
  }, [version]);
  if (error) return <InlineNotice tone="warning">Suggestions unavailable: {error}</InlineNotice>;
  if (rows && !rows.length) return null;
  const shown = rows ? (all ? rows : rows.slice(0, 6)) : [];
  const URG: Record<string, string> = { now: 'bg-[#FAF0EC] text-[#8A3E28]', today: 'bg-[#FDF3E7] text-[#92400E]', 'this week': 'bg-[#F2F7FB] text-[#0B2A44]' };
  return (
    <section aria-labelledby="h-nextsteps">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h2 id="h-nextsteps" className="text-sm font-bold text-[#0B2A44]">Suggested next steps</h2>
        <span className="text-[11px] text-[#5E778C]">From each customer's record · most urgent first</span>
      </div>
      {!rows ? <div className="h-24 rounded-xl bg-white/70 animate-pulse" aria-label="Reading records" /> : (
        <ol className="rounded-xl border border-[#E3EDF5] bg-white divide-y divide-[#EEF3F8] overflow-hidden">
          {shown.map((r) => (
            <li key={r.leadId}>
              <button onClick={() => onOpen(r.leadId)} className="w-full text-left px-3 py-2.5 min-h-12 hover:bg-[#F7FAFD] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0B6BB0] flex items-start gap-3">
                <span className={cx('mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 w-[4.5rem] text-center', URG[r.next!.urgency])}>{r.next!.urgency}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-[#0B2A44] truncate">{r.next!.title} <span className="font-normal text-[#5E778C]">· {r.name}</span></span>
                    <span className="text-[11px] text-[#5E778C] flex-shrink-0 tabular-nums" title="Readiness (estimate)">{r.stageLabel} · {r.score}</span>
                  </span>
                  <span className="block text-[11px] text-[#5E778C] truncate">{r.next!.why}{r.next!.timeNote ? ` · ${r.next!.timeNote}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {rows && rows.length > 6 && <button onClick={() => setAll(!all)} className="mt-1 text-xs text-[#0B6BB0] min-h-8">{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </section>
  );
};

const CustomerQueue: React.FC<{ rows?: TodayData['customers']; onOpen: (id: string) => void }> = ({ rows, onOpen }) => (
  <section id="q-customers" aria-labelledby="h-customers" className="scroll-mt-20">
    <div className="flex items-baseline justify-between gap-2 mb-1.5">
      <h2 id="h-customers" className="text-sm font-bold text-[#0B2A44]">Customers: what is due {rows && <span className="text-[#5E778C] font-normal tabular-nums">{rows.length}</span>}</h2>
      <span className="text-[11px] text-[#5E778C]">After booking</span>
    </div>
    {!rows ? (
      <div className="h-12 rounded-lg bg-white/70 animate-pulse" aria-label="Loading customers" />
    ) : !rows.length ? (
      <p className="text-xs text-[#7E93A6] py-3 px-3 rounded-lg border border-dashed border-[#D3E3F0]">Every customer is up to date.</p>
    ) : (
      <ul className="rounded-xl border border-[#E3EDF5] bg-white divide-y divide-[#EEF3F8] overflow-hidden">
        {rows.slice(0, 25).map((r) => (
          <li key={r.leadId}>
            <button onClick={() => onOpen(r.leadId)} className="w-full text-left px-3 py-2.5 min-h-12 hover:bg-[#F7FAFD] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0B6BB0]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold text-[#0B2A44] truncate">{r.name}</span>
                <span className={cx('text-[11px] flex-shrink-0', r.health === 'cold' ? 'text-[#B06A55] font-semibold' : r.health === 'cooling' ? 'text-[#92400E]' : 'text-[#5E778C]')}>{HEALTH_LABEL[r.health] || r.health}</span>
              </div>
              <div className="text-[11px] text-[#5E778C] truncate">
                {r.due.map((d, i) => <span key={d.key} className={d.late ? 'text-[#B06A55] font-semibold' : ''}>{i ? ' · ' : ''}{d.label}</span>)}
                {r.owner ? ` · Owner ${r.owner}` : r.rm ? ` · Sold by ${r.rm}` : ''}
              </div>
            </button>
          </li>
        ))}
      </ul>
    )}
  </section>
);

const HEALTH_LABEL: Record<string, string> = { engaged: 'Engaged', cooling: 'Cooling', cold: 'Gone quiet', new: 'New' };

const TaskQueue: React.FC<{ tasks?: TodayData['tasks']; onOpen: (id: string) => void }> = ({ tasks, onOpen }) => (
  <Queue id="tasks" title="Callbacks & tasks due" icon={<CalendarClock size={14} />} onOpen={onOpen} empty="No tasks due."
    rows={tasks?.map((t) => ({ leadId: t.leadId, name: t.name, phone: '', stage: '', rm: '', at: t.at, note: t.lead, late: t.late }))} />
);

/* ----------------------------------- team ----------------------------------- */

const Team: React.FC<{ onOpenLead: (id: string) => void; users: Array<{ id: string; name: string; role: string }>; online: boolean }> = ({ onOpenLead, users, online }) => {
  const { data, error, busy, refresh } = useLive<TeamData>(useCallback(() => api.workspace.team(), []), online);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [acting, setActing] = useState('');
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const decide = async (kind: 'booking' | 'quote', id: string, approve: boolean, what: string) => {
    const note = approve ? '' : window.prompt('Reason for rejecting (shown to the agent)') || '';
    if (!approve && !note) return;
    setActing(id);
    try {
      if (kind === 'booking') await api.journey.decideBooking(id, approve, note);
      else await api.journey.decideQuote(id, approve, note);
      setMsg({ tone: 'success', text: `${approve ? 'Approved' : 'Rejected'}: ${what}.${approve && kind === 'booking' ? ' The unit is booked and the enquiry marked Booked.' : approve ? ' The agent can now send it.' : ' The agent sees your reason.'}` });
      await refresh();
    } catch (e) {
      setMsg({ tone: 'warning', text: toAppError(e).userMessage });
    } finally {
      setActing('');
    }
  };
  const reassign = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.workspace.reassign([...selected], to, reason);
      setMsg({ tone: 'success', text: `${r.moved} enquir${r.moved === 1 ? 'y' : 'ies'} moved to ${r.to}. Each has a note with your reason.` });
      setSelected(new Set());
      setReason('');
      await refresh();
    } catch (err) {
      setMsg({ tone: 'warning', text: toAppError(err).userMessage });
    }
  };
  if (!data && error) return <ErrorState title="Could not load the team view" message={error} onRetry={refresh} />;
  const agents = users.filter((u) => u.role === 'RM' || u.role === 'Manager');

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><RefreshLine at={data?.generatedAt} busy={busy} onRefresh={refresh} /></div>
      {msg && <InlineNotice tone={msg.tone}>{msg.text}</InlineNotice>}

      {(data?.approvals.length || data?.discountApprovals.length) ? (
        <section aria-labelledby="h-approvals">
          <h2 id="h-approvals" className="text-sm font-bold text-[#0B2A44] mb-1.5">Waiting for your decision</h2>
          <ul className="rounded-xl border border-[#E3EDF5] bg-white divide-y divide-[#EEF3F8]">
            {data!.approvals.map((a) => (
              <li key={a.id} className="px-3 py-2.5 flex flex-wrap items-center gap-3">
                <button onClick={() => onOpenLead(a.leadId)} className="flex-1 min-w-0 text-left focus-visible:outline-2 focus-visible:outline-[#0B6BB0] rounded">
                  <div className="text-sm font-semibold text-[#0B2A44]">Book {a.unitNumber} for {a.leadName}</div>
                  <div className="text-[11px] text-[#5E778C]">Asked by {a.requestedBy} · {formatRelative(a.at)}{a.note ? ` · “${a.note}”` : ''}</div>
                </button>
                <Button size="xs" variant="ghost" disabled={acting === a.id} onClick={() => decide('booking', a.id, false, `${a.unitNumber} for ${a.leadName}`)}>Reject</Button>
                <Button size="xs" variant="primary" loading={acting === a.id} onClick={() => decide('booking', a.id, true, `${a.unitNumber} for ${a.leadName}`)}>Approve booking</Button>
              </li>
            ))}
            {data!.discountApprovals.map((q) => (
              <li key={q.id} className="px-3 py-2.5 flex flex-wrap items-center gap-3">
                <button onClick={() => onOpenLead(q.leadId)} className="flex-1 min-w-0 text-left focus-visible:outline-2 focus-visible:outline-[#0B6BB0] rounded">
                  <div className="text-sm font-semibold text-[#0B2A44]">{formatINR(q.discount)} discount on {q.unitNumber} for {q.leadName} · {formatINR(q.total)} total</div>
                  <div className="text-[11px] text-[#5E778C]">Quotation v{q.version} by {q.by} · {formatRelative(q.at)}</div>
                </button>
                <Button size="xs" variant="ghost" disabled={acting === q.id} onClick={() => decide('quote', q.id, false, `discount on ${q.unitNumber} for ${q.leadName}`)}>Reject</Button>
                <Button size="xs" variant="primary" loading={acting === q.id} onClick={() => decide('quote', q.id, true, `discount on ${q.unitNumber} for ${q.leadName}`)}>Approve discount</Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-5">
        <div className="space-y-2">
          <Queue id="unassigned" title="No owner" rows={data?.unassigned} onOpen={onOpenLead} empty="Every enquiry has an owner." selectable={{ selected, toggle }} />
          {selected.size > 0 && (
            <form onSubmit={reassign} className="flex flex-wrap gap-2 items-end rounded-xl border border-[#0B6BB0]/30 bg-[#F7FAFD] p-3">
              <label className="text-xs font-semibold text-[#0B2A44]">Give {selected.size} to
                <Select value={to} onChange={(e) => setTo(e.target.value)} options={[{ value: '', label: 'Choose' }, ...agents.map((u) => ({ value: u.id, label: u.name }))]} className="mt-1 min-w-40" />
              </label>
              <label className="text-xs font-semibold text-[#0B2A44] flex-1 min-w-48">Reason (kept in history)
                <input value={reason} onChange={(e) => setReason(e.target.value)} className={cx(inputCls, 'mt-1')} placeholder="Asha on leave this week" required />
              </label>
              <Button type="submit" variant="primary" disabled={!to || !reason.trim()}>Reassign</Button>
            </form>
          )}
        </div>
        <Queue id="untouched" title="Not contacted in time" hint={data ? `Older than ${data.slaHours} h` : ''} rows={data?.untouchedPastSla} onOpen={onOpenLead} empty="Nothing past the response time." showRm selectable={{ selected, toggle }} />
        <Queue id="tmissed" title="Missed calls not returned" rows={data?.missedCalls.map((c) => ({ leadId: c.leadId, name: c.name || c.phone, phone: c.phone, stage: '', rm: '', at: c.at, note: `${c.minutesAgo} min ago`, late: c.minutesAgo > 30 }))} onOpen={onOpenLead} empty="No missed calls waiting." />
        <Queue id="tvisits" title="Visits in the next 48 h" rows={data?.visitsNext48h} onOpen={onOpenLead} empty="No visits in the next 48 hours." showDate showRm />
        <Queue id="stalled" title="Stalled opportunities" hint="Qualified / warm / hot, unchanged for 14 days" rows={data?.stalled} onOpen={onOpenLead} empty="Nothing stalled." showRm wide />
      </div>

      <TeamScorecard />

      <ConstructionPanel />

      <section aria-labelledby="h-workload">
        <h2 id="h-workload" className="text-sm font-bold text-[#0B2A44] mb-1.5">Workload</h2>
        <div className="overflow-x-auto rounded-xl border border-[#E3EDF5] bg-white">
          <table className="w-full text-xs">
            <thead className="text-[#5E778C] text-left">
              <tr className="border-b border-[#EEF3F8]"><th scope="col" className="px-3 py-2 font-semibold">Person</th><th scope="col" className="px-3 py-2 font-semibold text-right">Open</th><th scope="col" className="px-3 py-2 font-semibold text-right">Overdue</th><th scope="col" className="px-3 py-2 font-semibold text-right">Not contacted</th></tr>
            </thead>
            <tbody>
              {(data?.workload || []).map((w) => (
                <tr key={w.userId} className="border-b last:border-0 border-[#EEF3F8]">
                  <th scope="row" className="px-3 py-2 text-left font-semibold text-[#0B2A44]">{w.name}</th>
                  <td className="px-3 py-2 text-right tabular-nums">{w.open}</td>
                  <td className={cx('px-3 py-2 text-right tabular-nums', w.overdue ? 'text-[#B06A55] font-semibold' : '')}>{w.overdue}</td>
                  <td className={cx('px-3 py-2 text-right tabular-nums', w.untouched ? 'text-[#B06A55] font-semibold' : '')}>{w.untouched}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

/* --------------------------------- business --------------------------------- */

const STEP_LABEL: Record<string, string> = { contacted: 'Contacted', qualified: 'Qualified', visitScheduled: 'Visit scheduled', visitDone: 'Visited', reserved: 'Reserved', booked: 'Booked' };

const Business: React.FC = () => {
  const [days, setDays] = useState(30);
  const load = useCallback(() => api.workspace.salesReport(new Date(Date.now() - days * 86400e3).toISOString()), [days]);
  const { data, error, busy, refresh } = useLive<SalesReport>(load, true);
  if (!data && error) return <ErrorState title="Could not load the report" message={error} onRetry={refresh} />;
  const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
  const max = Math.max(1, data?.enquiries || 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Period" className="inline-flex rounded-lg border border-[#D3E3F0] bg-white p-0.5">
          {[30, 90, 365].map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setDays(d)} className={cx('min-h-9 px-3 rounded-md text-xs font-semibold focus-visible:outline-2 focus-visible:outline-[#0B6BB0]', days === d ? 'bg-[#0B2A44] text-white' : 'text-[#0B2A44]')}>{d === 365 ? '12 months' : `${d} days`}</button>
          ))}
        </div>
        <RefreshLine at={data?.freshness.generatedAt} busy={busy} onRefresh={refresh} />
      </div>
      {!data ? (
        <div className="h-64 rounded-2xl bg-white/70 animate-pulse" aria-label="Loading report" />
      ) : (
        <>
          <section aria-labelledby="h-value" className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden border border-[#D3E3F0] bg-[#D3E3F0]">
            <h2 id="h-value" className="sr-only">Value</h2>
            {(['booked', 'collected', 'quoted', 'estimated'] as const).map((k) => (
              <div key={k} className="bg-white px-4 py-3.5">
                <div className="text-[11px] font-semibold text-[#5E778C]">{{ booked: 'Booked', collected: 'Collected', quoted: 'Quoted, on hold', estimated: 'Estimated pipeline' }[k]}</div>
                <div className={cx('mt-1 font-bold tabular-nums', k === 'estimated' ? 'text-lg text-[#5E778C]' : 'text-xl text-[#0B2A44]')}>{formatINR(data.value[k].amount)}</div>
                <div className="text-[10px] text-[#7E93A6] mt-1 leading-snug">{data.value[k].basis}</div>
              </div>
            ))}
          </section>
          {data.value.hiddenUnits > 0 && <p className="text-[11px] text-[#5E778C]">{data.value.hiddenUnits} unit(s) are left out because you may not see their buyers.</p>}

          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6">
            <section aria-labelledby="h-funnel">
              <h2 id="h-funnel" className="text-sm font-bold text-[#0B2A44]">From enquiry to booking <span className="font-normal text-[#5E778C]">· {data.enquiries} enquiries in the period{data.previous ? ` (${data.previous.enquiries} in the one before)` : ''}</span></h2>
              <p className="text-[11px] text-[#5E778C] mt-0.5">Counts only steps recorded when they happened.</p>
              <table className="w-full text-xs mt-2">
                <tbody>
                  {data.funnel.map((f) => (
                    <tr key={f.step} className="border-b border-[#EEF3F8]">
                      <th scope="row" className="py-2 pr-3 text-left font-semibold text-[#0B2A44] w-32">{STEP_LABEL[f.step] || f.step}</th>
                      <td className="py-2 pr-3"><div className="h-2 rounded-full bg-[#E3EDF5]"><div className="h-2 rounded-full bg-[#0B6BB0]" style={{ width: `${Math.round((f.reached / max) * 100)}%` }} /></div></td>
                      <td className="py-2 text-right tabular-nums w-28"><strong>{f.reached}</strong> <span className="text-[#5E778C]">· {f.percentOfEnquiries}%</span></td>
                      <td className="py-2 pl-3 text-right tabular-nums w-24 text-[11px] text-[#7E93A6]" title="Same step, previous period">{data.previous?.enquiries ? `${data.previous.funnel.find((p) => p.step === f.step)?.percentOfEnquiries ?? 0}% before` : data.previous ? '— before' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.funnel.some((f) => f.reconstructed || f.stageOnly) && (
                <p className="text-[11px] text-[#5E778C] mt-2">
                  {data.funnel.reduce((a, f) => a + f.reconstructed, 0) > 0 && <>Some older steps were rebuilt from history. </>}
                  {data.funnel.reduce((a, f) => a + f.stageOnly, 0) > 0 && <>{data.funnel.reduce((a, f) => a + f.stageOnly, 0)} lead(s) have a stage that suggests progress with no recorded step; they are not counted.</>}
                </p>
              )}
            </section>
            <section aria-labelledby="h-sla" className="space-y-2">
              <h2 id="h-sla" className="text-sm font-bold text-[#0B2A44]">First response within {data.sla.hours} h</h2>
              <div className="text-3xl font-bold tabular-nums text-[#0B2A44]">{pct(data.sla.overallPercent)}</div>
              <p className="text-[11px] text-[#5E778C] leading-relaxed">
                {data.sla.withinSla} answered in time out of {data.sla.eligible} due. {data.sla.overdueUnanswered} were never answered and {data.sla.respondedLate} were answered late.
                {data.sla.notYetDue ? ` ${data.sla.notYetDue} new enquiries are still inside their window.` : ''}
              </p>
              <p className="text-[11px] text-[#7E93A6]">Of those answered at all: {pct(data.sla.ofRespondedPercent)} in time.</p>
              {data.previous && (data.previous.sla.eligible ? <p className="text-[11px] text-[#5E778C]">Previous period: <strong className="text-[#0B2A44]">{pct(data.previous.sla.overallPercent)}</strong> ({data.previous.sla.withinSla} of {data.previous.sla.eligible}) · cancellations {data.previous.cancellations}</p> : <p className="text-[11px] text-[#5E778C]">Previous period: no enquiries due yet to compare · cancellations {data.previous.cancellations}</p>)}
              <p className="text-xs text-[#0B2A44] pt-2">Cancellations in the period: <strong className="tabular-nums">{data.cancellations}</strong></p>
            </section>
          </div>

          <TeamScorecard readOnly />

          <footer className="text-[11px] text-[#5E778C] border-t border-[#E3EDF5] pt-3 flex flex-wrap gap-x-4 gap-y-1">
            <span>Report made {formatDateTime(data.freshness.generatedAt, '')}</span>
            <span>Latest lead change {data.freshness.newestLeadChange ? formatRelative(data.freshness.newestLeadChange) : '—'}</span>
            <span>Latest provider event {data.freshness.newestProviderEvent ? formatRelative(data.freshness.newestProviderEvent) : 'none received'}</span>
            <span>Lead snapshot {data.freshness.lastLeadSnapshot ? `${formatRelative(data.freshness.lastLeadSnapshot)}${data.freshness.lastSnapshotVerified === false ? ' (failed its check)' : ''}` : 'none yet'}</span>
          </footer>
        </>
      )}
    </div>
  );
};
