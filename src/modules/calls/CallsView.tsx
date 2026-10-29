/**
 * Call history — every call with its recording (play / download), AI transcript and summary.
 *
 * Sources of call rows: logged here (dialer + timer + outcome), uploaded recordings, or the
 * telephony provider (JustConnect events and sync, or the generic webhook: server/modules/calls).
 * Module-specific reads/writes call api.calls.*; lead mutations go through the engine callbacks passed as props.
 *
 * The list is grouped by day. Every row shows who the call was with: the linked enquiry (name, stage, RM) or,
 * for an unlinked call, the enquiry with the same phone number (the backend's matchedLeadId, else a client-side
 * phone match) with a one-click "Link". Opening a row shows the recording player, the AI summary, the transcript,
 * notes and follow-up tools.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock, Check, ChevronDown, ChevronRight, Clock, Download, ExternalLink, FileAudio, Headphones, Link2, NotebookPen, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Play, Plus, RefreshCw, Search, Sparkles, Upload, UserPlus, X,
} from 'lucide-react';
import { CRMSettings, CallRecord, Lead, UserAccount } from '../../types/crm';
import { F, REFRESH_EVENT } from '../../core/config';
import { api } from '../../core/api';
import { searchLeads } from '../../core/analytics';
import { formatDateTime, formatRelative, fromDatetimeLocalInput, inRange, toDatetimeLocalInput } from '../../core/dates';
import { formatDuration, pluralize } from '../../core/format';
import { formatPhone } from '../../core/phone';
import { reportError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { can } from '../../core/rbac';
import { useTenantSettings } from '../../core/tenant';
import { Badge, Button, Card, DateFilterValue, DateRangeFilter, EmptyState, ErrorState, Field, InlineNotice, KpiTile, Select, StageBadge, cx, inputCls, resolveDateFilter } from '../../components/ui';
import { LogCallModal } from './LogCallModal';
import {
  CALL_BACK_DAYS, CALL_STATUSES, CallMatch, MAX_RECORDING_BYTES, MISSED_STATUSES, OUTCOMES, RECORDING_ACCEPT, callBackIds, callStats, callTime, dayHeading, fileToBase64, guessMime, hasRecording, hasSummary, hasTranscript, leadsByPhone, linkPatch, matchForCall, outcomeTone, recordingDownloadUrl, recordingSrc, replaceCall, sortCalls, statusTone, summarizeCalls,
} from './callsUtils';
import { PageSkeleton } from '../../components/Skeletons';
import { CallButton } from './CallButton';
import { TranscriptView } from './TranscriptView';

export interface CallsViewProps {
  leads: Lead[];
  currentUser: UserAccount | null;
  settings: CRMSettings;
  aiConfigured: boolean;
  onOpenLead: (id: string) => void;
  /** New Enquiry with the caller's number filled in (an unknown caller); absent without leads.create. */
  onCreateLead?: (phone: string) => void;
  onAppendRemark: (id: string, remark: string, nextFollowup?: string) => Promise<boolean>;
  onUpdateLead: (id: string, patch: Partial<Lead>) => Promise<Lead | null>;
}

const PAGE_SIZE = 100;
type RowAction = 'upload' | 'transcribe' | 'summarize' | 'split' | 'remark' | 'followup' | 'link' | 'edit';
type Kind = '' | 'Inbound' | 'Outbound' | 'missed' | 'callback';

const isMissed = (c: CallRecord) => MISSED_STATUSES.includes(String(c.status || ''));
const SPEEDS = [1, 1.5, 2];
const SPEED_KEY = 'crm.recordingSpeed';
/** A recording stored in the CRM (plays in the page and downloads with a readable name). */
const isLocal = (src: string) => src.startsWith('/api/files/');
/** Recordings in one bulk download (the server's limit too: app/api/calls/recordings). */
const MAX_ZIP = 100;
const canZip = (c: CallRecord) => !!c.recordingFileId;
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
};

export const CallsView: React.FC<CallsViewProps> = ({ leads, currentUser, settings, aiConfigured, onOpenLead, onCreateLead, onAppendRemark, onUpdateLead }) => {
  const canLog = can(currentUser, 'calls.log');
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<Kind>('');
  const [status, setStatus] = useState('');
  /** Calls handled by this person (the agent / RM who took or made them). */
  const [person, setPerson] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ preset: 'all' });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The row whose recording should start playing when it opens (its Play button). */
  const [autoPlay, setAutoPlay] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  /** Calls ticked for a bulk download of their recordings. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [zipping, setZipping] = useState(false);

  const [busy, setBusy] = useState<Record<string, RowAction>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const leadById = useMemo(() => {
    const m = new Map<string, Lead>();
    for (const l of leads) m.set(String(l[F.ID] || ''), l);
    return m;
  }, [leads]);
  const leadByPhone = useMemo(() => leadsByPhone(leads), [leads]);

  // Unlinked calls → the enquiry with the same number (server suggestion first, then a client-side phone match).
  const matchById = useMemo(() => {
    const m = new Map<string, CallMatch>();
    for (const c of calls || []) {
      const match = matchForCall(c, leadById, leadByPhone);
      if (match) m.set(c.id, match);
    }
    return m;
  }, [calls, leadById, leadByPhone]);

  const jcOn = !!(useTenantSettings() as { justconnectConfigured?: boolean } | null)?.justconnectConfigured;
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // JustConnect: pull new calls first (the server throttles repeats)
      if (jcOn) await api.justconnect.syncCalls().catch(() => undefined);
      const list = await api.calls.list();
      setCalls(sortCalls(Array.isArray(list) ? list.filter((c) => c && c.id) : []));
      setError(null);
    } catch (e) {
      setError(reportError('calls.list', e).userMessage);
    } finally {
      setLoading(false);
    }
  }, [jcOn]);

  useEffect(() => {
    load();
  }, [load]);

  // the top bar's Refresh reloads the calls too
  useEffect(() => {
    const onRefresh = () => void load(true);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, [load]);

  const summary = useMemo(() => summarizeCalls(calls || []), [calls]);
  const range = useMemo(() => resolveDateFilter(dateFilter), [dateFilter]);
  const statusOptions = useMemo(() => {
    const present = new Set((calls || []).map((c) => String(c.status || '')));
    return [...CALL_STATUSES.filter((s) => present.has(s)), ...[...present].filter((s) => s && !(CALL_STATUSES as string[]).includes(s))];
  }, [calls]);

  /** Missed incoming calls nobody has called back yet. */
  const toCallBack = useMemo(() => callBackIds(calls || []), [calls]);
  const personOptions = useMemo(() => [...new Set((calls || []).map((c) => String(c.loggedBy || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [calls]);

  const kindCounts = useMemo(() => {
    const all = calls || [];
    return { '': all.length, Inbound: all.filter((c) => c.direction === 'Inbound').length, Outbound: all.filter((c) => c.direction === 'Outbound').length, missed: all.filter(isMissed).length, callback: toCallBack.size };
  }, [calls, toCallBack]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return (calls || []).filter((c) => {
      if (kind === 'callback' ? !toCallBack.has(c.id) : kind === 'missed' ? !isMissed(c) : kind && c.direction !== kind) return false;
      if (person && String(c.loggedBy || '').trim() !== person) return false;
      if (status && String(c.status || '') !== status) return false;
      if (range && !inRange(callTime(c), range)) return false;
      if (!q) return true;
      const lead = c.leadId ? leadById.get(c.leadId) : undefined;
      const match = matchById.get(c.id);
      const hay = [c.customerName, c.leadId, c.outcome, c.notes, c.provider, c.id, lead ? lead[F.NAME] : '', match?.name, match?.leadId, c.aiSummary, c.transcript].map((v) => String(v || '').toLowerCase());
      if (hay.some((h) => h.includes(q))) return true;
      return digits.length >= 4 && String(c.phone || '').replace(/\D/g, '').includes(digits);
    });
  }, [calls, search, kind, person, status, range, leadById, matchById, toCallBack]);
  const stats = useMemo(() => callStats(filtered), [filtered]);
  /** Shown calls whose recording is stored in the CRM (the ones a ZIP can hold). */
  const withRecording = useMemo(() => filtered.filter(canZip), [filtered]);
  const allPicked = withRecording.length > 0 && withRecording.slice(0, MAX_ZIP).every((c) => selected.has(c.id));
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(withRecording.slice(0, MAX_ZIP).map((c) => c.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size >= MAX_ZIP) toast('Selection is full', `Download up to ${MAX_ZIP} recordings at a time.`, 'warning');
      else next.add(id);
      return next;
    });

  /** The ticked calls' recordings as one ZIP file. */
  const downloadSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setZipping(true);
    try {
      const res = await fetch('/api/calls/recordings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }), credentials: 'same-origin' });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error?.message || err?.message || `The download failed (HTTP ${res.status}).`);
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'Call recordings.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast('Recordings downloaded', `${pluralize(ids.length, 'call')} in ${name}`, 'success');
      setSelected(new Set());
    } catch (e) {
      toast('Download failed', e instanceof Error ? e.message : 'Try again in a moment.', 'alert');
    } finally {
      setZipping(false);
    }
  };

  useEffect(() => setVisible(PAGE_SIZE), [search, kind, person, status, dateFilter]);

  /** The shown calls, grouped by day (newest first, as the list is sorted). */
  const groups = useMemo(() => {
    const out: Array<{ day: string; calls: CallRecord[]; talkSec: number }> = [];
    for (const c of filtered.slice(0, visible)) {
      const day = dayHeading(callTime(c));
      const last = out[out.length - 1];
      if (last && last.day === day) {
        last.calls.push(c);
        last.talkSec += Number(c.durationSec) || 0;
      } else out.push({ day, calls: [c], talkSec: Number(c.durationSec) || 0 });
    }
    return out;
  }, [filtered, visible]);

  const anyFilter = !!(search || kind || person || status || dateFilter.preset !== 'all');
  const clearFilters = () => {
    setSearch('');
    setKind('');
    setPerson('');
    setStatus('');
    setDateFilter({ preset: 'all' });
  };

  /* ------------------------------ row actions ---------------------------- */

  const setRow = (updated: CallRecord) => setCalls((prev) => (prev ? sortCalls(replaceCall(prev, updated)) : [updated]));

  const runRow = async (call: CallRecord, action: RowAction, scope: string, fn: () => Promise<CallRecord | null | undefined | boolean>, success?: (c: CallRecord) => void) => {
    setBusy((b) => ({ ...b, [call.id]: action }));
    setRowError((r) => {
      const n = { ...r };
      delete n[call.id];
      return n;
    });
    try {
      const res = await fn();
      if (res && typeof res === 'object') {
        setRow(res);
        if (success) success(res);
      } else if (res === true && success) {
        success(call);
      }
    } catch (e) {
      const err = reportError(scope, e);
      setRowError((r) => ({ ...r, [call.id]: err.userMessage }));
    } finally {
      setBusy((b) => {
        const n = { ...b };
        delete n[call.id];
        return n;
      });
    }
  };

  const uploadRecording = (call: CallRecord, file: File) => {
    if (file.size > MAX_RECORDING_BYTES) {
      setRowError((r) => ({ ...r, [call.id]: 'The file is larger than 19 MB. Compress it (MP3/OGG) before uploading so it can be transcribed.' }));
      return;
    }
    runRow(call, 'upload', 'calls.uploadRecording', async () => api.calls.uploadRecording(call.id, file.name, guessMime(file), await fileToBase64(file)), () => toast('Recording uploaded', file.name, 'success'));
  };
  const transcribe = (call: CallRecord) => runRow(call, 'transcribe', 'calls.transcribe', () => api.calls.transcribe(call.id), (c) => toast('Transcript ready', hasSummary(c) ? 'Summary and key points generated' : 'Transcript saved', 'success'));
  const summarize = (call: CallRecord) => runRow(call, 'summarize', 'calls.summarize', () => api.calls.summarize(call.id), () => toast('Summary updated', undefined, 'success'));
  const splitTranscript = (call: CallRecord) => runRow(call, 'split', 'calls.splitTranscript', () => api.calls.splitTranscript(call.id), () => toast('Transcript split', 'Now shown as Sales Executive and Customer', 'success'));
  const addSummaryRemark = (call: CallRecord) =>
    runRow(call, 'remark', 'calls.remark', () => onAppendRemark(call.leadId, `Call summary (${formatDateTime(callTime(call))}): ${String(call.aiSummary || '').trim()}`));
  const setFollowup = (call: CallRecord, iso: string) =>
    runRow(call, 'followup', 'calls.followup', async () => !!(await onUpdateLead(call.leadId, { [F.NEXT_FOLLOWUP]: iso })), () => toast('Follow-up scheduled', formatRelative(iso), 'success'));
  const linkTo = (call: CallRecord, target: Pick<CallMatch, 'leadId' | 'name' | 'phone'>) =>
    runRow(call, 'link', 'calls.link', () => api.calls.update(call.id, linkPatch(call, target)), (c) => toast('Call linked', `${c.id} → ${target.name || target.leadId}`, 'success'));
  const linkLead = (call: CallRecord, lead: Lead) => linkTo(call, { leadId: String(lead[F.ID] || ''), name: String(lead[F.NAME] || ''), phone: String(lead[F.PHONE] || '') });
  const updateCall = (call: CallRecord, patch: Partial<CallRecord>) => runRow(call, 'edit', 'calls.update', () => api.calls.update(call.id, patch), () => toast('Call updated', undefined, 'success'));

  const toggle = (id: string) => {
    setAutoPlay(null);
    setExpanded((cur) => (cur === id ? null : id));
  };
  const play = (id: string) => {
    setAutoPlay(id);
    setExpanded(id);
  };

  /* -------------------------------- states ------------------------------ */

  if (loading && calls === null) return <PageSkeleton variant="table" label="Loading call history…" />;
  if (error && calls === null) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <ErrorState title="Call history could not load" message={error} onRetry={() => load()} />
      </div>
    );
  }

  const list = calls || [];
  const KINDS: Array<{ id: Kind; label: string; icon: React.ReactNode }> = [
    { id: '', label: 'All', icon: <PhoneCall size={13} /> },
    { id: 'Inbound', label: 'Incoming', icon: <PhoneIncoming size={13} /> },
    { id: 'Outbound', label: 'Outgoing', icon: <PhoneOutgoing size={13} /> },
    { id: 'missed', label: 'Missed', icon: <PhoneMissed size={13} /> },
    { id: 'callback', label: 'To call back', icon: <PhoneCall size={13} /> },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight">Call history</h2>
          <p className="text-xs text-[#5E778C] mt-0.5">Every call with your leads: listen to or download the recording, and read the AI summary and transcript.</p>
        </div>
        {canLog && <Button variant="primary" onClick={() => setLogOpen(true)} icon={<Plus size={13} />} className="flex-none">Log a call</Button>}
      </div>

      {error && calls && <ErrorState compact title="Could not refresh calls" message={error} onRetry={() => load()} />}

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PhoneCall size={22} />}
            title="No calls yet"
            description={
              <>
                Calls appear here when you call a lead from the CRM, when your telephony provider sends them, or when you log one by hand.
                {aiConfigured ? ' Recordings are then transcribed and summarised by AI.' : ' Configure Gemini in Settings to transcribe and summarise recordings.'}
              </>
            }
            action={canLog ? <Button variant="primary" onClick={() => setLogOpen(true)} icon={<Plus size={13} />}>Log a call</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiTile compact label="Calls today" value={summary.today} tone="navy" icon={<Phone size={12} />} />
            <KpiTile compact label="Talk time today" value={formatDuration(summary.durationTodaySec)} tone="gold" icon={<Clock size={12} />} />
            <KpiTile compact label="Answered" value={summary.completed} tone="sage" icon={<Check size={12} />} hint="all time" onClick={() => setStatus('Completed')} />
            <KpiTile compact label="Missed" value={summary.missed} tone="rust" icon={<PhoneMissed size={12} />} hint="all time" onClick={() => setKind('missed')} />
            <KpiTile compact label="Recordings" value={summary.withRecording} tone="white" icon={<Headphones size={12} />} />
            <KpiTile compact label="AI summaries" value={summary.summarized} tone="white" icon={<Sparkles size={12} />} hint={`${summary.transcribed} transcribed`} />
          </div>

          {/* Filters */}
          <div className="bg-white rounded-2xl border border-[#D3E3F0] p-2.5 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div role="tablist" aria-label="Which calls" className="flex items-center gap-1 rounded-xl bg-[#F2F7FB] p-1">
                {KINDS.map((k) => (
                  <button
                    key={k.id || 'all'}
                    type="button"
                    role="tab"
                    aria-selected={kind === k.id}
                    onClick={() => setKind(k.id)}
                    className={cx('inline-flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition', kind === k.id ? 'bg-white text-[#0B2A44] shadow-xs' : 'text-[#5E778C] hover:text-[#0B2A44]')}
                  >
                    {k.icon}
                    <span>{k.label}</span>
                    {k.id === 'callback' && kindCounts.callback > 0 ? (
                      <span className="min-w-4.5 h-4.5 px-1 rounded-full bg-[#E5484D] text-white text-[10.5px] font-bold tabular-nums leading-4.5 text-center">{kindCounts.callback}</span>
                    ) : (
                      <span className={cx('tabular-nums text-[10.5px]', kind === k.id ? 'text-[#0B6BB0]' : 'text-[#8EA3B5]')}>{kindCounts[k.id]}</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="relative flex-1 min-w-48">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7E93A6]" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, enquiry ID, outcome…" className={cx(inputCls, 'pl-8')} aria-label="Search calls" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {personOptions.length > 1 && <Select value={person} onChange={(e) => setPerson(e.target.value)} options={personOptions} placeholder="Everyone" className="w-auto!" aria-label="Handled by" />}
              <Select value={status} onChange={(e) => setStatus(e.target.value)} options={statusOptions} placeholder="Any status" className="w-auto!" aria-label="Status" />
              <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
              <span className="text-xs text-[#5E778C] font-medium ml-auto">{filtered.length === list.length ? pluralize(list.length, 'call') : `${filtered.length} of ${list.length} calls`}</span>
              {anyFilter && <Button size="xs" variant="ghost" onClick={clearFilters} icon={<X size={12} />}>Clear</Button>}
            </div>
          </div>

          {/* Figures for what is shown */}
          {filtered.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[12px] text-[#5E778C]">
              {withRecording.length > 0 && (
                <label className="inline-flex items-center gap-2 cursor-pointer select-none font-semibold text-[#0B2A44]" title={`Tick every shown call that has a recording (up to ${MAX_ZIP})`}>
                  <input type="checkbox" checked={allPicked} onChange={toggleAll} className="w-4 h-4 accent-[#0B6BB0]" />
                  Select all recordings ({Math.min(withRecording.length, MAX_ZIP)})
                </label>
              )}
              {person && <span className="font-semibold text-[#0B2A44]">{person}</span>}
              <span><b className="text-[#0B2A44] tabular-nums">{stats.calls}</b> {stats.calls === 1 ? 'call' : 'calls'}</span>
              <span><b className="text-[#0B2A44] tabular-nums">{stats.answered}</b> answered{stats.answerRate !== null ? ` (${stats.answerRate}%)` : ''}</span>
              <span><b className="text-[#0B2A44] tabular-nums">{formatDuration(stats.talkSec)}</b> talk time</span>
              {kind === 'callback' && <span className="text-[#B42318]">Missed in the last {CALL_BACK_DAYS} days and not called back yet; a call to the number clears it.</span>}
            </div>
          )}

          {/* The calls, by day */}
          {filtered.length === 0 ? (
            <Card>
              <div className="flex flex-col items-center gap-2 py-6 text-sm text-[#7E93A6]">
                <span>No calls match these filters.</span>
                {anyFilter && <Button size="xs" variant="secondary" onClick={clearFilters}>Clear filters</Button>}
              </div>
            </Card>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <section key={g.day} aria-label={g.day}>
                  <div className="flex items-baseline justify-between px-1 pb-1.5">
                    <h3 className="text-[13px] font-bold text-[#0B2A44]">{g.day}</h3>
                    <span className="text-[11px] text-[#7E93A6]">{pluralize(g.calls.length, 'call')}{g.talkSec ? ` · ${formatDuration(g.talkSec)} talk` : ''}</span>
                  </div>
                  <Card padded={false} className="overflow-hidden divide-y divide-[#E6EFF6]">
                    {g.calls.map((c) => {
                      const lead = c.leadId ? leadById.get(c.leadId) : undefined;
                      const match = matchById.get(c.id) || null;
                      const open = expanded === c.id;
                      return (
                        <div key={c.id} className={cx(open && 'bg-[#F7FAFD]')}>
                          <CallRow
                            call={c}
                            lead={lead}
                            match={match}
                            open={open}
                            canLog={canLog}
                            busy={busy[c.id]}
                            onToggle={() => toggle(c.id)}
                            onPlay={() => play(c.id)}
                            onLinkMatch={() => match && linkTo(c, match)}
                            callBack={toCallBack.has(c.id)}
                            selectable={canZip(c)}
                            selected={selected.has(c.id)}
                            onSelect={() => toggleOne(c.id)}
                            onCreateLead={onCreateLead}
                            onOpenLead={onOpenLead}
                          />
                          {open && (
                            <CallDetails
                              call={c}
                              lead={lead}
                              match={match}
                              leads={leads}
                              canLog={canLog}
                              aiConfigured={aiConfigured}
                              autoPlay={autoPlay === c.id}
                              busy={busy[c.id]}
                              error={rowError[c.id]}
                              onDismissError={() =>
                                setRowError((r) => {
                                  const n = { ...r };
                                  delete n[c.id];
                                  return n;
                                })
                              }
                              onUpload={(file) => uploadRecording(c, file)}
                              onTranscribe={() => transcribe(c)}
                              onSummarize={() => summarize(c)}
                              onSplitTranscript={() => splitTranscript(c)}
                              onAddRemark={() => addSummaryRemark(c)}
                              onSetFollowup={(iso) => setFollowup(c, iso)}
                              onLinkLead={(l) => linkLead(c, l)}
                              onLinkMatch={(m) => linkTo(c, m)}
                              onUpdate={(patch) => updateCall(c, patch)}
                              onOpenLead={onOpenLead}
                            />
                          )}
                        </div>
                      );
                    })}
                  </Card>
                </section>
              ))}
              {filtered.length > visible && (
                <div className="flex items-center justify-center gap-3 text-xs text-[#5E778C]">
                  <span>Showing {visible} of {filtered.length}</span>
                  <Button size="xs" variant="secondary" onClick={() => setVisible((v) => v + PAGE_SIZE)}>Show more</Button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Bulk download bar: shown while calls are ticked */}
      {selected.size > 0 && (
        <div className="sticky bottom-24 lg:bottom-4 z-20 mx-auto max-w-xl">
          <div className="flex items-center gap-3 rounded-2xl bg-[#0B2A44] text-white px-4 py-2.5 shadow-[0_10px_30px_rgba(10,31,51,0.35)]">
            <span className="text-[13px] font-semibold flex-1 min-w-0 truncate">{pluralize(selected.size, 'recording')} selected</span>
            <button type="button" onClick={() => setSelected(new Set())} disabled={zipping} className="text-[12px] font-semibold text-[#B9D4EA] hover:text-white disabled:opacity-50">Clear</button>
            <button type="button" onClick={() => void downloadSelected()} disabled={zipping} className="inline-flex items-center gap-1.5 rounded-xl bg-[#36B3F2] text-[#04263D] px-3.5 h-9 text-[12.5px] font-extrabold hover:brightness-105 disabled:opacity-70">
              {zipping ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
              {zipping ? 'Preparing ZIP…' : 'Download (.zip)'}
            </button>
          </div>
        </div>
      )}

      {canLog && logOpen && (
        <LogCallModal open={logOpen} leads={leads} settings={settings} currentUser={currentUser} onClose={() => setLogOpen(false)} onLogged={(call) => { setRow(call); setExpanded(call.id); }} onOpenLead={onOpenLead} />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* One row                                                                   */
/* ------------------------------------------------------------------------ */

/** Incoming / outgoing / missed, in a coloured circle. */
const DirectionIcon: React.FC<{ call: CallRecord }> = ({ call }) => {
  const missed = isMissed(call);
  const inbound = call.direction === 'Inbound';
  const Icon = missed ? PhoneMissed : inbound ? PhoneIncoming : PhoneOutgoing;
  const label = missed ? `${inbound ? 'Missed incoming' : 'Unanswered outgoing'} call` : inbound ? 'Incoming call' : 'Outgoing call';
  return (
    <span title={label} aria-label={label} className={cx('flex-none w-10 h-10 rounded-full flex items-center justify-center', missed ? 'bg-[#FDECEC] text-[#B42318]' : inbound ? 'bg-[#E3F4F1] text-[#0E7A6F]' : 'bg-[#E4F0FA] text-[#0B6BB0]')}>
      <Icon size={17} />
    </span>
  );
};

const TEMP_CLS: Record<string, string> = { Hot: 'bg-[#FDECEC] text-[#9A2A1A]', Warm: 'bg-[#FDF3E1] text-[#7A4A06]', Cold: 'bg-[#E8F0F6] text-[#29465E]' };

const CallRow: React.FC<{
  call: CallRecord;
  lead?: Lead;
  match: CallMatch | null;
  open: boolean;
  canLog: boolean;
  busy?: RowAction;
  onToggle: () => void;
  onPlay: () => void;
  onLinkMatch: () => void;
  /** A missed call nobody has called back yet. */
  callBack: boolean;
  /** Has a recording stored in the CRM: can be ticked for a bulk download. */
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  onCreateLead?: (phone: string) => void;
  onOpenLead: (id: string) => void;
}> = ({ call: c, lead, match, open, canLog, busy, onToggle, onPlay, onLinkMatch, callBack, selectable, selected, onSelect, onCreateLead, onOpenLead }) => {
  const name = c.customerName || (lead ? String(lead[F.NAME] || '') : '') || match?.name || '';
  const recording = hasRecording(c) && !!recordingSrc(c);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      className="flex items-center gap-3 px-3 sm:px-4 py-3 cursor-pointer hover:bg-[#F7FAFD] focus-visible:outline-2 focus-visible:outline-[#0B6BB0]"
    >
      <span className="flex-none w-5 flex justify-center" onClick={(e) => e.stopPropagation()}>
        {selectable ? (
          <input type="checkbox" checked={selected} onChange={onSelect} className="w-4 h-4 accent-[#0B6BB0] cursor-pointer" aria-label="Select this recording for download" title="Select for bulk download" />
        ) : (
          <input type="checkbox" disabled className="w-4 h-4 opacity-30" aria-label="No recording to download" title="No recording to download" />
        )}
      </span>
      <DirectionIcon call={c} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cx('truncate text-[14px] font-semibold', name ? 'text-[#0B2A44]' : 'text-[#7E93A6]')}>{name || formatPhone(c.phone) || 'Unknown caller'}</span>
          {lead && <StageBadge stage={lead[F.STAGE]} />}
          {callBack && <span className="flex-none rounded-full bg-[#FDECEC] text-[#B42318] px-2 py-px text-[10.5px] font-bold" title="Missed, and nobody has called back yet">Call back</span>}
        </div>
        <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11.5px] text-[#5E778C] mt-0.5">
          {name && c.phone && <span className="tabular-nums">{formatPhone(c.phone)}</span>}
          {c.leadId ? (
            <button type="button" onClick={(e) => { stop(e); onOpenLead(c.leadId); }} className="inline-flex items-center gap-1 font-mono text-[11px] text-[#0B6BB0] hover:underline">
              {c.leadId}
            </button>
          ) : match ? (
            <span className="inline-flex items-center gap-1.5" onClick={stop}>
              <span>Same number as <button type="button" onClick={() => onOpenLead(match.leadId)} className="font-semibold text-[#0B6BB0] hover:underline">{match.name || match.leadId}</button></span>
              {canLog && (
                <button type="button" onClick={onLinkMatch} disabled={!!busy} className="inline-flex items-center gap-1 rounded-md border border-[#0B6BB0]/40 px-1.5 py-px text-[10.5px] font-semibold text-[#0B6BB0] hover:bg-[#E4F0FA] disabled:opacity-50">
                  <Link2 size={10} />{busy === 'link' ? 'Linking…' : 'Link'}
                </button>
              )}
            </span>
          ) : (
            onCreateLead && c.phone ? (
              <button type="button" onClick={(e) => { stop(e); onCreateLead(c.phone); }} className="inline-flex items-center gap-1 rounded-md border border-[#0B2A44]/30 px-1.5 py-px text-[10.5px] font-semibold text-[#0B2A44] hover:bg-[#F2F7FB]">
                <UserPlus size={10} /> New caller: create lead
              </button>
            ) : (
              <span className="text-[#8EA3B5]">Not linked to an enquiry</span>
            )
          )}
          {lead && String(lead[F.RM] || '').trim() && <span>RM {lead[F.RM]}</span>}
        </div>
        {(c.outcome || c.aiTemperature || hasSummary(c)) && (
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            {c.outcome && <Badge tone={outcomeTone(c.outcome)}>{c.outcome}</Badge>}
            {c.aiTemperature && <span className={cx('rounded-full px-2 py-px text-[10.5px] font-bold', TEMP_CLS[c.aiTemperature] || TEMP_CLS.Cold)}>AI: {c.aiTemperature}</span>}
            {hasSummary(c) && <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[#0B6BB0]"><Sparkles size={10} /> AI summary</span>}
          </div>
        )}
      </div>

      <div className="flex-none text-right">
        <div className="text-[13px] font-semibold text-[#0B2A44] tabular-nums">{timeOf(callTime(c))}</div>
        <div className="text-[11px] text-[#5E778C] tabular-nums mt-0.5">
          {c.status === 'Completed' ? (c.durationSec ? formatDuration(c.durationSec) : 'Answered') : <Badge tone={statusTone(c.status)}>{c.status || '—'}</Badge>}
        </div>
      </div>

      <div className="flex-none flex items-center gap-0.5" onClick={stop}>
        {recording && isLocal(recordingSrc(c)) ? (
          <>
            <button type="button" onClick={onPlay} className="w-9 h-9 rounded-full flex items-center justify-center text-[#0B6BB0] hover:bg-[#E4F0FA]" title="Play the recording" aria-label="Play the recording"><Play size={16} /></button>
            <a href={recordingDownloadUrl(c, name)} download className="hidden sm:flex w-9 h-9 rounded-full items-center justify-center text-[#5E778C] hover:bg-[#E4F0FA] hover:text-[#0B2A44]" title="Download the recording" aria-label="Download the recording"><Download size={16} /></a>
          </>
        ) : recording ? (
          <>
            <a href={recordingSrc(c)} target="_blank" rel="noopener noreferrer" className="w-9 h-9 rounded-full flex items-center justify-center text-[#0B6BB0] hover:bg-[#E4F0FA]" title="Open the recording" aria-label="Open the recording"><Headphones size={16} /></a>
            <span className="w-9 h-9 hidden sm:block" aria-hidden="true" />
          </>
        ) : (
          <span className="w-9 h-9 hidden sm:block" aria-hidden="true" />
        )}
        {c.phone && (
          <CallButton phone={c.phone} leadId={c.leadId || undefined} name={name || undefined} className="hidden sm:flex w-9 h-9 rounded-full items-center justify-center text-[#0E7A6F] hover:bg-[#E3F4F1]" title={`Call ${formatPhone(c.phone)}`} aria-label={`Call ${formatPhone(c.phone)}`}>
            <Phone size={15} />
          </CallButton>
        )}
        <span className="w-6 flex justify-center text-[#7E93A6]">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Opened row                                                                */
/* ------------------------------------------------------------------------ */

interface CallDetailsProps {
  call: CallRecord;
  lead?: Lead;
  /** Same-number enquiry for an unlinked call. */
  match?: CallMatch | null;
  leads: Lead[];
  canLog: boolean;
  aiConfigured: boolean;
  /** Start the recording as soon as it opens (the row's Play button). */
  autoPlay: boolean;
  busy?: RowAction;
  error?: string;
  onDismissError: () => void;
  onUpload: (file: File) => void;
  onTranscribe: () => void;
  onSummarize: () => void;
  onSplitTranscript: () => void;
  onAddRemark: () => void;
  onSetFollowup: (iso: string) => void;
  onLinkLead: (lead: Lead) => void;
  onLinkMatch: (match: CallMatch) => void;
  onUpdate: (patch: Partial<CallRecord>) => void;
  onOpenLead: (id: string) => void;
}

const SectionTitle: React.FC<{ icon?: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }> = ({ icon, children, right }) => (
  <div className="flex items-center justify-between gap-2 mb-1.5">
    <h5 className="text-[10.5px] uppercase font-bold tracking-wider text-[#5E778C] inline-flex items-center gap-1.5">{icon}{children}</h5>
    {right}
  </div>
);

const CallDetails: React.FC<CallDetailsProps> = ({ call, lead, match, leads, canLog, aiConfigured, autoPlay, busy, error, onDismissError, onUpload, onTranscribe, onSummarize, onSplitTranscript, onAddRemark, onSetFollowup, onLinkLead, onLinkMatch, onUpdate, onOpenLead }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [followup, setFollowupValue] = useState(() => toDatetimeLocalInput(lead ? lead[F.NEXT_FOLLOWUP] : ''));
  const [linkQuery, setLinkQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ status: call.status, outcome: call.outcome || '', notes: call.notes || '' });
  const linkResults = useMemo(() => (linkQuery.trim().length >= 2 ? searchLeads(leads, linkQuery, 6) : []), [leads, linkQuery]);

  useEffect(() => setEdit({ status: call.status, outcome: call.outcome || '', notes: call.notes || '' }), [call.status, call.outcome, call.notes]);
  useEffect(() => {
    if (autoPlay) audioRef.current?.play().catch(() => undefined); // the browser may block it; the player is there to press
  }, [autoPlay]);

  // playback speed, remembered on this device
  const [speed, setSpeed] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(SPEED_KEY));
      return SPEEDS.includes(v) ? v : 1;
    } catch {
      return 1;
    }
  });
  const setPlaybackSpeed = (s: number) => {
    setSpeed(s);
    if (audioRef.current) audioRef.current.playbackRate = s;
    try {
      localStorage.setItem(SPEED_KEY, String(s));
    } catch {
      /* storage blocked: the speed still applies now */
    }
  };

  const src = recordingSrc(call);
  const recording = hasRecording(call) && !!src;
  const transcript = hasTranscript(call);
  const summary = hasSummary(call);
  const anyBusy = !!busy;
  const followupIso = followup ? fromDatetimeLocalInput(followup) : '';
  const who = call.customerName || (lead ? String(lead[F.NAME] || '') : '') || match?.name || '';

  return (
    <div className="px-3 sm:px-4 pb-4 pt-1 space-y-4 text-xs" onClick={(e) => e.stopPropagation()}>
      {error && (
        <InlineNotice tone="warning">
          <div className="flex items-start gap-2"><span className="flex-1">{error}</span><button type="button" onClick={onDismissError} aria-label="Dismiss"><X size={12} /></button></div>
        </InlineNotice>
      )}
      {busy === 'transcribe' && <InlineNotice><span className="inline-flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Transcribing the recording and writing the summary — this can take a minute for long calls.</span></InlineNotice>}
      {busy === 'upload' && <InlineNotice><span className="inline-flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Uploading the recording…</span></InlineNotice>}

      {/* Recording */}
      <div className="rounded-xl border border-[#D3E3F0] bg-white p-3">
        <SectionTitle
          icon={<Headphones size={12} />}
          right={canLog && (
            <>
              <input ref={fileRef} type="file" accept={RECORDING_ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.currentTarget.value = ''; }} />
              <Button size="xs" variant="ghost" icon={<Upload size={11} />} loading={busy === 'upload'} disabled={anyBusy || !call.leadId} title={call.leadId ? 'Upload the recording file from your provider or phone' : 'Link the call to an enquiry first'} onClick={() => fileRef.current?.click()}>
                {recording ? 'Replace' : 'Upload recording'}
              </Button>
            </>
          )}
        >
          Recording
        </SectionTitle>
        {recording && isLocal(src) ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <audio ref={audioRef} controls preload="metadata" src={src} className="w-full sm:flex-1 h-10" aria-label={`Recording of the call${who ? ` with ${who}` : ''}`} onLoadedMetadata={(e) => { e.currentTarget.playbackRate = speed; }} />
            <div role="group" aria-label="Playback speed" className="flex items-center gap-0.5 rounded-lg bg-[#F2F7FB] p-0.5 flex-none self-start sm:self-auto">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  onClick={() => setPlaybackSpeed(s)}
                  className={cx('rounded-md px-2 h-8 text-[11.5px] font-semibold tabular-nums', speed === s ? 'bg-white text-[#0B2A44] shadow-xs' : 'text-[#5E778C] hover:text-[#0B2A44]')}
                >
                  {s}×
                </button>
              ))}
            </div>
            <a href={recordingDownloadUrl(call, who)} download className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 h-9 text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110 flex-none">
              <Download size={13} /> Download
            </a>
          </div>
        ) : recording ? (
          // still at the provider's address: the page may only play the CRM's own files
          <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg px-3.5 h-9 text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110">
            <ExternalLink size={13} /> Open recording
          </a>
        ) : (
          <p className="text-[#5E778C] flex items-start gap-2">
            <FileAudio size={14} className="text-[#0B6BB0] flex-none mt-0.5" />
            <span>No recording for this call. Recordings come from your telephony provider; you can also upload the file your provider or phone saved.</span>
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* AI summary and transcript */}
        <div className="lg:col-span-3 space-y-3">
          <div className="rounded-xl border border-[#D3E3F0] bg-white p-3">
            <SectionTitle
              icon={<Sparkles size={12} className="text-[#0B6BB0]" />}
              right={canLog && (
                <div className="flex items-center gap-1">
                  <Button size="xs" variant={transcript ? 'ghost' : 'gold'} icon={<Sparkles size={11} />} loading={busy === 'transcribe'} disabled={anyBusy || !recording || !aiConfigured} title={!aiConfigured ? 'Configure Gemini in Settings → AI' : !recording ? 'Upload a recording first' : transcript ? 'Transcribe the recording again with AI' : 'Transcribe and summarise'} onClick={onTranscribe}>
                    {transcript ? 'Re-transcribe' : 'Transcribe & summarise'}
                  </Button>
                  {transcript && (
                    <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} loading={busy === 'summarize'} disabled={anyBusy || !aiConfigured} title={!aiConfigured ? 'Configure Gemini in Settings → AI' : 'Write the summary again from the transcript'} onClick={onSummarize}>
                      Re-summarise
                    </Button>
                  )}
                </div>
              )}
            >
              AI summary
            </SectionTitle>
            {!aiConfigured && recording && !summary && <InlineNotice>AI is not configured. Add a Gemini API key in Settings → AI to transcribe and summarise recordings.</InlineNotice>}
            {summary ? (
              <div className="space-y-2.5">
                <p className="text-[12.5px] text-[#0F2233] leading-relaxed whitespace-pre-wrap">{call.aiSummary}</p>
                {call.aiTemperature && (
                  <p className="text-[12px]">
                    <span className={cx('rounded-full px-2 py-px text-[10.5px] font-bold mr-1.5', TEMP_CLS[call.aiTemperature] || TEMP_CLS.Cold)}>{call.aiTemperature}</span>
                    <span className="text-[#5E778C]">{call.aiTemperatureReason}</span>
                  </p>
                )}
                {(call.keyPoints?.length || 0) > 0 && (
                  <div>
                    <div className="text-[10.5px] uppercase font-bold tracking-wider text-[#5E778C] mb-1">Key points</div>
                    <ul className="list-disc pl-4 space-y-0.5 text-[#0F2233]">{call.keyPoints!.map((k, i) => <li key={i}>{k}</li>)}</ul>
                  </div>
                )}
                {(call.followupActions?.length || 0) > 0 && (
                  <div>
                    <div className="text-[10.5px] uppercase font-bold tracking-wider text-[#5E778C] mb-1">Next steps</div>
                    <ul className="list-disc pl-4 space-y-0.5 text-[#0F2233]">{call.followupActions!.map((k, i) => <li key={i}>{k}</li>)}</ul>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[#7E93A6]">{recording ? 'No summary yet.' : 'A summary is written once the call has a recording.'}</p>
            )}
          </div>

          {transcript && (
            <TranscriptView
              transcript={String(call.transcript || '')}
              execName={call.loggedBy && call.loggedBy !== call.provider ? call.loggedBy : ''}
              customerName={who}
              durationSec={call.durationSec}
              when={callTime(call)}
              source={call.transcriptSource}
              onSplit={canLog && aiConfigured ? onSplitTranscript : undefined}
              splitting={busy === 'split'}
            />
          )}
        </div>

        {/* Details, notes, lead tools */}
        <div className="lg:col-span-2 space-y-3">
          <div className="rounded-xl border border-[#D3E3F0] bg-white p-3">
            <SectionTitle>Details</SectionTitle>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
              <dt className="text-[#7E93A6]">Started</dt><dd className="text-[#0B2A44] font-medium">{formatDateTime(call.startTime || call.callDate, '—')}</dd>
              <dt className="text-[#7E93A6]">Duration</dt><dd className="text-[#0B2A44] font-medium">{call.durationSec ? formatDuration(call.durationSec) : '—'}</dd>
              <dt className="text-[#7E93A6]">Status</dt><dd><Badge tone={statusTone(call.status)}>{call.status || '—'}</Badge></dd>
              <dt className="text-[#7E93A6]">Handled by</dt><dd className="text-[#0B2A44] font-medium truncate">{call.loggedBy || '—'}</dd>
              <dt className="text-[#7E93A6]">Source</dt><dd className="text-[#0B2A44] truncate">{call.provider || 'CRM'}<span className="font-mono text-[10.5px] text-[#8EA3B5]"> · {call.id}</span></dd>
            </dl>
          </div>

          <div className="rounded-xl border border-[#D3E3F0] bg-white p-3">
            <SectionTitle icon={<NotebookPen size={12} />} right={canLog && !editing && <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}>
              Outcome & notes
            </SectionTitle>
            {editing ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit((s) => ({ ...s, status: e.target.value as CallRecord['status'] }))} options={[...CALL_STATUSES]} /></Field>
                  <Field label="Outcome"><Select value={edit.outcome} onChange={(e) => setEdit((s) => ({ ...s, outcome: e.target.value }))} options={OUTCOMES} placeholder="—" /></Field>
                </div>
                <Field label="Notes"><textarea rows={3} value={edit.notes} onChange={(e) => setEdit((s) => ({ ...s, notes: e.target.value }))} className={inputCls} /></Field>
                <div className="flex items-center justify-end gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={anyBusy}>Cancel</Button>
                  <Button
                    size="xs"
                    variant="primary"
                    loading={busy === 'edit'}
                    onClick={() => {
                      onUpdate({ status: edit.status, outcome: edit.outcome, notes: edit.notes.trim() });
                      setEditing(false);
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                {call.outcome && <Badge tone={outcomeTone(call.outcome)}>{call.outcome}</Badge>}
                <p className="text-[#0F2233] whitespace-pre-wrap leading-relaxed">{call.notes ? call.notes : <span className="text-[#7E93A6]">No notes.</span>}</p>
              </div>
            )}
          </div>

          {call.leadId ? (
            <div className="rounded-xl border border-[#D3E3F0] bg-white p-3 space-y-2">
              <SectionTitle icon={<CalendarClock size={12} />} right={<Button size="xs" variant="ghost" icon={<ExternalLink size={11} />} onClick={() => onOpenLead(call.leadId)}>Open lead</Button>}>
                Follow-up
              </SectionTitle>
              <div className="flex items-end gap-1.5">
                <Field label="Next follow-up" hint={lead && lead[F.NEXT_FOLLOWUP] ? `Now: ${formatRelative(lead[F.NEXT_FOLLOWUP])}` : undefined} className="flex-1">
                  <input type="datetime-local" value={followup} onChange={(e) => setFollowupValue(e.target.value)} className={inputCls} disabled={anyBusy || !canLog} />
                </Field>
                {canLog && <Button size="xs" variant="primary" loading={busy === 'followup'} disabled={anyBusy || !followupIso} onClick={() => followupIso && onSetFollowup(followupIso)} className="mb-px">Set</Button>}
              </div>
              {summary && canLog && (
                <Button size="xs" variant="secondary" icon={<NotebookPen size={11} />} loading={busy === 'remark'} disabled={anyBusy} onClick={onAddRemark} className="w-full">Add the AI summary as a follow-up remark</Button>
              )}
            </div>
          ) : (
            canLog && (
              <div className="rounded-xl border border-dashed border-[#B9CCDB] bg-white p-3 space-y-2">
                <SectionTitle icon={<Link2 size={12} />}>Link to an enquiry</SectionTitle>
                {match && (
                  <div className="rounded-lg bg-[#F2F7FB] p-2 flex items-center justify-between gap-2 flex-wrap">
                    <span className="min-w-0">
                      Same number as <strong>{match.name || match.leadId}</strong> <span className="font-mono text-[10.5px] text-[#0B6BB0]">{match.leadId}</span>
                      {match.stage ? <> · <StageBadge stage={match.stage} /></> : null}
                    </span>
                    <Button size="xs" variant="primary" loading={busy === 'link'} disabled={anyBusy} onClick={() => onLinkMatch(match)} icon={<Link2 size={11} />}>Link</Button>
                  </div>
                )}
                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#7E93A6]" />
                  <input value={linkQuery} onChange={(e) => setLinkQuery(e.target.value)} placeholder={match ? 'Or find another enquiry…' : 'Find an enquiry by name, phone or ID…'} className={cx(inputCls, 'pl-7')} disabled={anyBusy} />
                </div>
                {linkQuery.trim().length >= 2 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-[#E6EFF6] divide-y divide-[#E6EFF6]">
                    {linkResults.length === 0 && <div className="p-2 text-[#7E93A6]">No matching enquiries</div>}
                    {linkResults.map((l) => (
                      <button key={l[F.ID]} type="button" disabled={anyBusy} onClick={() => onLinkLead(l)} className="w-full text-left p-2 hover:bg-[#F2F7FB] flex items-center justify-between gap-2">
                        <span className="truncate"><strong className="text-[#0B2A44]">{l[F.NAME]}</strong> <span className="font-mono text-[10px] text-[#0B6BB0]">{l[F.ID]}</span> <span className="text-[#5E778C]">· {formatPhone(l[F.PHONE]) || '—'}</span></span>
                        <StageBadge stage={l[F.STAGE]} />
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[10.5px] text-[#7E93A6]">Linking moves the recording, transcript and follow-ups onto the enquiry.</p>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
};

export default CallsView;
