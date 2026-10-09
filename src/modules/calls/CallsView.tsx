/**
 * Calls — call history with recordings, AI transcripts and summaries.
 *
 * Sources of call rows: logged here (dialer + timer + outcome), uploaded recordings, or the
 * telephony-provider webhook (server/modules/calls). Module-specific reads/writes call
 * api.calls.*; lead mutations go through the engine callbacks passed as props.
 *
 * Every row shows who the call was with: the linked enquiry (name, stage, RM, unit type) or,
 * for an unlinked call, the enquiry with the same phone number (the backend's matchedLeadId,
 * else a client-side phone match) with a one-click "Link to this enquiry".
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, CalendarClock, Check, ChevronDown, ChevronRight, Clock, ExternalLink, FileAudio, Headphones, Link2, NotebookPen, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Plus, RefreshCw, Search, Sparkles, Upload, X,
} from 'lucide-react';
import { CRMSettings, CallRecord, Lead, UserAccount } from '../../types/crm';
import { F } from '../../core/config';
import { api } from '../../core/api';
import { searchLeads } from '../../core/analytics';
import { formatDateTime, formatRelative, fromDatetimeLocalInput, inRange, toDatetimeLocalInput } from '../../core/dates';
import { formatDuration, pluralize } from '../../core/format';
import { formatPhone, telLink } from '../../core/phone';
import { reportError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { can } from '../../core/rbac';
import { Badge, Button, Card, DateFilterValue, DateRangeFilter, EmptyState, ErrorState, Field, InlineNotice, KpiTile, Select, StageBadge, cx, inputCls, resolveDateFilter } from '../../components/ui';
import { LogCallModal } from './LogCallModal';
import {
  CALL_STATUSES, CallMatch, DIRECTIONS, MAX_RECORDING_BYTES, OUTCOMES, RECORDING_ACCEPT, callTime, fileToBase64, guessMime, hasRecording, hasSummary, hasTranscript, leadsByPhone, linkPatch, matchForCall, outcomeTone, replaceCall, sortCalls, statusTone, summarizeCalls,
} from './callsUtils';
import { PageSkeleton } from '../../components/Skeletons';

export interface CallsViewProps {
  leads: Lead[];
  currentUser: UserAccount | null;
  settings: CRMSettings;
  aiConfigured: boolean;
  onOpenLead: (id: string) => void;
  onAppendRemark: (id: string, remark: string, nextFollowup?: string) => Promise<boolean>;
  onUpdateLead: (id: string, patch: Partial<Lead>) => Promise<Lead | null>;
}

const PAGE_SIZE = 100;
type RowAction = 'upload' | 'transcribe' | 'summarize' | 'remark' | 'followup' | 'link' | 'edit';

export const CallsView: React.FC<CallsViewProps> = ({ leads, currentUser, settings, aiConfigured, onOpenLead, onAppendRemark, onUpdateLead }) => {
  const canLog = can(currentUser, 'calls.log');
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ preset: 'all' });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

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

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const list = await api.calls.list();
      setCalls(sortCalls(Array.isArray(list) ? list.filter((c) => c && c.id) : []));
      setError(null);
    } catch (e) {
      setError(reportError('calls.list', e).userMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const summary = useMemo(() => summarizeCalls(calls || []), [calls]);
  const range = useMemo(() => resolveDateFilter(dateFilter), [dateFilter]);
  const statusOptions = useMemo(() => {
    const present = new Set((calls || []).map((c) => String(c.status || '')));
    return [...CALL_STATUSES.filter((s) => present.has(s)), ...[...present].filter((s) => s && !(CALL_STATUSES as string[]).includes(s))];
  }, [calls]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return (calls || []).filter((c) => {
      if (direction && c.direction !== direction) return false;
      if (status && String(c.status || '') !== status) return false;
      if (range && !inRange(callTime(c), range)) return false;
      if (!q) return true;
      const lead = c.leadId ? leadById.get(c.leadId) : undefined;
      const match = matchById.get(c.id);
      const hay = [c.customerName, c.leadId, c.outcome, c.notes, c.provider, c.id, lead ? lead[F.NAME] : '', match?.name, match?.leadId].map((v) => String(v || '').toLowerCase());
      if (hay.some((h) => h.includes(q))) return true;
      return digits.length >= 4 && String(c.phone || '').replace(/\D/g, '').includes(digits);
    });
  }, [calls, search, direction, status, range, leadById, matchById]);

  useEffect(() => setVisible(PAGE_SIZE), [search, direction, status, dateFilter]);

  const anyFilter = !!(search || direction || status || dateFilter.preset !== 'all');
  const clearFilters = () => {
    setSearch('');
    setDirection('');
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
  const addSummaryRemark = (call: CallRecord) =>
    runRow(call, 'remark', 'calls.remark', () => onAppendRemark(call.leadId, `Call summary (${formatDateTime(callTime(call))}): ${String(call.aiSummary || '').trim()}`));
  const setFollowup = (call: CallRecord, iso: string) =>
    runRow(call, 'followup', 'calls.followup', async () => !!(await onUpdateLead(call.leadId, { [F.NEXT_FOLLOWUP]: iso })), () => toast('Follow-up scheduled', formatRelative(iso), 'success'));
  const linkTo = (call: CallRecord, target: Pick<CallMatch, 'leadId' | 'name' | 'phone'>) =>
    runRow(call, 'link', 'calls.link', () => api.calls.update(call.id, linkPatch(call, target)), (c) => toast('Call linked', `${c.id} → ${target.name || target.leadId}`, 'success'));
  const linkLead = (call: CallRecord, lead: Lead) => linkTo(call, { leadId: String(lead[F.ID] || ''), name: String(lead[F.NAME] || ''), phone: String(lead[F.PHONE] || '') });
  const updateCall = (call: CallRecord, patch: Partial<CallRecord>) => runRow(call, 'edit', 'calls.update', () => api.calls.update(call.id, patch), () => toast('Call updated', undefined, 'success'));

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

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#0B2A44] tracking-tight">Calls</h2>
          <p className="text-xs text-[#5E778C] mt-0.5">Calls logged from the CRM, uploaded recordings and your telephony provider's webhook — with AI transcripts and summaries.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" onClick={() => load()} loading={loading} icon={<RefreshCw size={13} />}>Refresh</Button>
          {canLog && <Button variant="primary" onClick={() => setLogOpen(true)} icon={<Plus size={13} />}>Log a call</Button>}
        </div>
      </div>

      {error && calls && <ErrorState compact title="Could not refresh calls" message={error} onRetry={() => load()} />}

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PhoneCall size={22} />}
            title="No calls logged yet"
            description={
              <>
                Calls appear here when you log one from the CRM (dial, time it, note the outcome), upload a recording, or when your telephony provider posts to the CRM webhook (Settings → Integrations → Telephony).
                {aiConfigured ? ' Recordings can then be transcribed and summarised with AI.' : ' Configure Gemini in Settings to transcribe and summarise recordings.'}
              </>
            }
            action={canLog ? <Button variant="primary" onClick={() => setLogOpen(true)} icon={<Plus size={13} />}>Log a call</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiTile label="Calls today" value={summary.today} tone="navy" icon={<Phone size={12} />} />
            <KpiTile label="Talk time today" value={formatDuration(summary.durationTodaySec)} tone="gold" icon={<Clock size={12} />} />
            <KpiTile label="Completed" value={summary.completed} tone="sage" icon={<Check size={12} />} hint="all time" onClick={() => setStatus('Completed')} />
            <KpiTile label="Missed / unanswered" value={summary.missed} tone="rust" icon={<PhoneMissed size={12} />} hint="all time" />
            <KpiTile label="With recording" value={summary.withRecording} tone="white" icon={<Headphones size={12} />} />
            <KpiTile label="Transcribed" value={summary.transcribed} tone="white" icon={<Sparkles size={12} />} hint={`${summary.summarized} summarised`} />
          </div>

          {/* Filters */}
          <div className="bg-[#E6EFF6] p-3 rounded-xl border border-[#D3E3F0] flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7E93A6]" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer, phone, enquiry ID, outcome…" className={cx(inputCls, 'pl-8')} />
            </div>
            <Select value={direction} onChange={(e) => setDirection(e.target.value)} options={[...DIRECTIONS]} placeholder="All directions" className="!w-auto" />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} options={statusOptions} placeholder="All statuses" className="!w-auto" />
            <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
            <span className="text-xs text-[#5E778C] font-medium ml-auto">{filtered.length === list.length ? pluralize(list.length, 'call') : `${filtered.length} of ${list.length} calls`}</span>
            {anyFilter && <Button size="xs" variant="ghost" onClick={clearFilters} icon={<X size={12} />}>Clear</Button>}
          </div>

          {/* Table */}
          <Card padded={false} className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[#E6EFF6] border-b border-[#D3E3F0] text-[#5E778C] uppercase font-bold tracking-wider text-[10px]">
                    <th className="p-2.5 w-6" />
                    <th className="p-2.5">When</th>
                    <th className="p-2.5">Customer</th>
                    <th className="p-2.5">Phone</th>
                    <th className="p-2.5">Direction</th>
                    <th className="p-2.5 text-right">Duration</th>
                    <th className="p-2.5">Status</th>
                    <th className="p-2.5">Outcome</th>
                    <th className="p-2.5">Provider</th>
                    <th className="p-2.5 text-center" title="Recording">Rec</th>
                    <th className="p-2.5 text-center" title="Transcript">Transcript</th>
                    <th className="p-2.5 text-center" title="AI summary">AI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6EFF6]">
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={12} className="p-6 text-center text-[#7E93A6]">
                        <div className="flex flex-col items-center gap-2">
                          <span>No calls match these filters.</span>
                          {anyFilter && <Button size="xs" variant="secondary" onClick={clearFilters}>Clear filters</Button>}
                        </div>
                      </td>
                    </tr>
                  )}
                  {filtered.slice(0, visible).map((c) => {
                    const lead = c.leadId ? leadById.get(c.leadId) : undefined;
                    const match = matchById.get(c.id) || null;
                    const open = expanded === c.id;
                    return (
                      <React.Fragment key={c.id}>
                        <tr onClick={() => setExpanded(open ? null : c.id)} className={cx('cursor-pointer transition hover:bg-[#F2F7FB]', open && 'bg-[#F7FAFD]')}>
                          <td className="p-2.5 text-[#7E93A6] align-top">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                          <td className="p-2.5 align-top whitespace-nowrap text-[#0F2233]">
                            <div>{formatDateTime(callTime(c), '—')}</div>
                            <div className="text-[10px] font-mono text-[#7E93A6]">{c.id}</div>
                          </td>
                          <td className="p-2.5 align-top min-w-[190px] max-w-[280px]">
                            {c.leadId ? (
                              <>
                                <div className="font-semibold text-[#0B2A44] truncate">{c.customerName || (lead ? lead[F.NAME] : '') || <span className="text-[#7E93A6] font-normal">Unknown caller</span>}</div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenLead(c.leadId);
                                  }}
                                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#0B6BB0] hover:text-[#0B2A44] hover:underline"
                                >
                                  <ExternalLink size={10} /><span className="font-mono">{c.leadId}</span>{lead && <StageBadge stage={lead[F.STAGE]} />}
                                </button>
                                {lead && <ClientFacts rm={lead[F.RM]} unit={lead[F.UNIT_TYPE]} />}
                              </>
                            ) : match ? (
                              <>
                                <div className="font-semibold text-[#0B2A44] truncate">{c.customerName || match.name || formatPhone(c.phone) || 'Unknown caller'}</div>
                                <MatchSuggestion
                                  match={match}
                                  canLink={canLog}
                                  busy={busy[c.id]}
                                  error={!open ? rowError[c.id] : undefined}
                                  onLink={() => linkTo(c, match)}
                                  onOpenLead={onOpenLead}
                                />
                              </>
                            ) : (
                              <>
                                <div className="font-semibold text-[#0B2A44] truncate">{c.customerName || <span className="text-[#7E93A6] font-normal">Unknown caller</span>}</div>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <Badge tone="muted">Unlinked</Badge>
                                  <span className="text-[10px] text-[#7E93A6]">No matching enquiry</span>
                                </div>
                              </>
                            )}
                          </td>
                          <td className="p-2.5 align-top whitespace-nowrap">
                            {c.phone ? (
                              <a href={telLink(c.phone)} onClick={(e) => e.stopPropagation()} className="text-[#0B2A44] hover:text-[#0B6BB0] inline-flex items-center gap-1"><Phone size={10} />{formatPhone(c.phone)}</a>
                            ) : '—'}
                          </td>
                          <td className="p-2.5 align-top whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5 text-[#0F2233]">{c.direction === 'Inbound' ? <PhoneIncoming size={12} className="text-[#0E8A86]" /> : <PhoneOutgoing size={12} className="text-[#0B6BB0]" />}{c.direction}</span>
                          </td>
                          <td className="p-2.5 align-top text-right tabular-nums">{c.durationSec ? formatDuration(c.durationSec) : '—'}</td>
                          <td className="p-2.5 align-top"><Badge tone={statusTone(c.status)}>{c.status || '—'}</Badge></td>
                          <td className="p-2.5 align-top">{c.outcome ? <Badge tone={outcomeTone(c.outcome)}>{c.outcome}</Badge> : <span className="text-[#7E93A6]">—</span>}</td>
                          <td className="p-2.5 align-top text-[#5E778C]">{c.provider || '—'}</td>
                          <td className="p-2.5 align-top text-center">
                            {c.recordingUrl ? (
                              <a href={c.recordingUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex text-[#0B6BB0] hover:text-[#0B2A44]" title="Open recording"><Headphones size={14} /></a>
                            ) : hasRecording(c) ? (
                              <Headphones size={14} className="inline text-[#7E93A6]" />
                            ) : (
                              <span className="text-[#D3E3F0]">—</span>
                            )}
                          </td>
                          <td className="p-2.5 align-top text-center">{hasTranscript(c) ? <Check size={14} className="inline text-[#2E7D32]" /> : <span className="text-[#D3E3F0]">—</span>}</td>
                          <td className="p-2.5 align-top text-center">{hasSummary(c) ? <Sparkles size={14} className="inline text-[#0B6BB0]" /> : <span className="text-[#D3E3F0]">—</span>}</td>
                        </tr>
                        {open && (
                          <tr className="bg-[#F7FAFD]">
                            <td colSpan={12} className="p-0">
                              <CallDetails
                                call={c}
                                lead={lead}
                                match={match}
                                leads={leads}
                                canLog={canLog}
                                aiConfigured={aiConfigured}
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
                                onAddRemark={() => addSummaryRemark(c)}
                                onSetFollowup={(iso) => setFollowup(c, iso)}
                                onLinkLead={(l) => linkLead(c, l)}
                                onLinkMatch={(m) => linkTo(c, m)}
                                onUpdate={(patch) => updateCall(c, patch)}
                                onOpenLead={onOpenLead}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length > visible && (
              <div className="p-3 border-t border-[#E6EFF6] flex items-center justify-center gap-3 text-xs text-[#5E778C]">
                <span>Showing {visible} of {filtered.length}</span>
                <Button size="xs" variant="secondary" onClick={() => setVisible((v) => v + PAGE_SIZE)}>Show more</Button>
              </div>
            )}
          </Card>
        </>
      )}

      {canLog && logOpen && (
        <LogCallModal open={logOpen} leads={leads} settings={settings} currentUser={currentUser} onClose={() => setLogOpen(false)} onLogged={(call) => { setRow(call); setExpanded(call.id); }} onOpenLead={onOpenLead} />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Expanded row                                                              */
/* ------------------------------------------------------------------------ */

/** RM and unit type of the linked enquiry, under the customer name. */
const ClientFacts: React.FC<{ rm?: string; unit?: string }> = ({ rm, unit }) => (
  <div className="text-[10px] text-[#5E778C] mt-0.5 truncate" title={`RM ${rm || '—'}${unit ? ` · ${unit}` : ''}`}>
    RM {String(rm || '').trim() || '—'}
    {String(unit || '').trim() ? ` · ${unit}` : ''}
  </div>
);

/** Unlinked call whose number matches an enquiry: who it is, plus a one-click link. */
const MatchSuggestion: React.FC<{ match: CallMatch; canLink: boolean; busy?: RowAction; error?: string; onLink: () => void; onOpenLead: (id: string) => void }> = ({ match, canLink, busy, error, onLink, onOpenLead }) => (
  <div className="mt-1 rounded-lg border border-dashed border-[#0B6BB0]/60 bg-[#F5F9FC] p-1.5 space-y-1 cursor-default" onClick={(e) => e.stopPropagation()}>
    <div className="text-[10px] uppercase font-bold tracking-wider text-[#0B6BB0]">Matching enquiry</div>
    <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
      <button type="button" onClick={() => onOpenLead(match.leadId)} className="font-semibold text-[#0B2A44] hover:text-[#0B6BB0] hover:underline truncate max-w-[150px]" title="Open the enquiry">
        {match.name || match.leadId}
      </button>
      <span className="font-mono text-[10px] text-[#0B6BB0]">{match.leadId}</span>
      {match.stage && <StageBadge stage={match.stage} />}
    </div>
    <ClientFacts rm={match.rm} unit={match.unitType} />
    {canLink && (
      <Button size="xs" variant="gold" icon={<Link2 size={11} />} loading={busy === 'link'} disabled={!!busy} onClick={onLink} title="Link this call to the enquiry with the same phone number">
        Link to this enquiry
      </Button>
    )}
    {error && <div className="text-[10px] text-[#8A3E28] leading-snug">{error}</div>}
  </div>
);

interface CallDetailsProps {
  call: CallRecord;
  lead?: Lead;
  /** Same-number enquiry for an unlinked call. */
  match?: CallMatch | null;
  leads: Lead[];
  canLog: boolean;
  aiConfigured: boolean;
  busy?: RowAction;
  error?: string;
  onDismissError: () => void;
  onUpload: (file: File) => void;
  onTranscribe: () => void;
  onSummarize: () => void;
  onAddRemark: () => void;
  onSetFollowup: (iso: string) => void;
  onLinkLead: (lead: Lead) => void;
  onLinkMatch: (match: CallMatch) => void;
  onUpdate: (patch: Partial<CallRecord>) => void;
  onOpenLead: (id: string) => void;
}

const CallDetails: React.FC<CallDetailsProps> = ({ call, lead, match, leads, canLog, aiConfigured, busy, error, onDismissError, onUpload, onTranscribe, onSummarize, onAddRemark, onSetFollowup, onLinkLead, onLinkMatch, onUpdate, onOpenLead }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [followup, setFollowupValue] = useState(() => toDatetimeLocalInput(lead ? lead[F.NEXT_FOLLOWUP] : ''));
  const [showTranscript, setShowTranscript] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ status: call.status, outcome: call.outcome || '', notes: call.notes || '' });
  const linkResults = useMemo(() => (linkQuery.trim().length >= 2 ? searchLeads(leads, linkQuery, 6) : []), [leads, linkQuery]);

  useEffect(() => setEdit({ status: call.status, outcome: call.outcome || '', notes: call.notes || '' }), [call.status, call.outcome, call.notes]);

  const recording = hasRecording(call);
  const transcript = hasTranscript(call);
  const summary = hasSummary(call);
  const anyBusy = !!busy;
  const followupIso = followup ? fromDatetimeLocalInput(followup) : '';

  return (
    <div className="p-4 border-t border-[#E6EFF6] space-y-4 text-xs" onClick={(e) => e.stopPropagation()}>
      {error && (
        <InlineNotice tone="warning">
          <div className="flex items-start gap-2"><span className="flex-1">{error}</span><button type="button" onClick={onDismissError} aria-label="Dismiss"><X size={12} /></button></div>
        </InlineNotice>
      )}
      {busy === 'transcribe' && <InlineNotice><span className="inline-flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Transcribing the recording and generating the summary — this can take a minute for long calls.</span></InlineNotice>}
      {busy === 'upload' && <InlineNotice><span className="inline-flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Uploading the recording…</span></InlineNotice>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Facts & notes */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Fact label="Started" value={formatDateTime(call.startTime || call.callDate, '—')} />
            <Fact label="Ended" value={formatDateTime(call.endTime, '—')} />
            <Fact label="Logged by" value={call.loggedBy || '—'} />
            <Fact label="Provider ref" value={call.providerCallId || '—'} mono />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <h5 className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">Notes & outcome</h5>
              {canLog && !editing && <Button size="xs" variant="ghost" onClick={() => setEditing(true)} icon={<NotebookPen size={11} />}>Edit</Button>}
            </div>
            {editing ? (
              <div className="space-y-2 rounded-lg border border-[#D3E3F0] bg-white p-2.5">
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
              <div className="rounded-lg border border-[#E6EFF6] bg-white p-2.5 text-[#0F2233] whitespace-pre-wrap leading-relaxed">{call.notes ? call.notes : <span className="text-[#7E93A6]">No notes.</span>}</div>
            )}
          </div>

          {/* Link to lead */}
          {!call.leadId && canLog && (
            <div className="rounded-lg border border-dashed border-[#D3E3F0] bg-white p-2.5 space-y-1.5">
              <div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C] flex items-center gap-1"><Link2 size={11} /> Link to an enquiry</div>
              {match && (
                <InlineNotice tone="success">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span>
                      Same phone number as <strong>{match.name || match.leadId}</strong> <span className="font-mono">{match.leadId}</span>
                      {match.stage ? ` · ${match.stage}` : ''}
                      {match.rm ? ` · RM ${match.rm}` : ''}
                      {match.unitType ? ` · ${match.unitType}` : ''}
                    </span>
                    <Button size="xs" variant="primary" loading={busy === 'link'} disabled={anyBusy} onClick={() => onLinkMatch(match)} icon={<Link2 size={11} />}>Link to this enquiry</Button>
                  </div>
                </InlineNotice>
              )}
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#7E93A6]" />
                <input value={linkQuery} onChange={(e) => setLinkQuery(e.target.value)} placeholder={match ? 'Or search another enquiry by name, phone or ID…' : 'Search by name, phone or ID…'} className={cx(inputCls, 'pl-7')} disabled={anyBusy} />
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
              <div className="text-[10px] text-[#7E93A6]">Recordings, transcripts and follow-ups need a linked enquiry.</div>
            </div>
          )}
        </div>

        {/* AI */}
        <div className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h5 className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C] inline-flex items-center gap-1"><Brain size={12} /> Recording & AI</h5>
            <div className="flex items-center gap-1.5 flex-wrap">
              {call.recordingUrl && <a href={call.recordingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#0B6BB0] hover:underline font-semibold"><Headphones size={12} /> Open recording</a>}
              {canLog && (
                <>
                  <input ref={fileRef} type="file" accept={RECORDING_ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.currentTarget.value = ''; }} />
                  <Button size="xs" variant="secondary" icon={<Upload size={11} />} loading={busy === 'upload'} disabled={anyBusy || !call.leadId} title={call.leadId ? 'Upload the recording file from your provider or phone' : 'Link the call to an enquiry first'} onClick={() => fileRef.current?.click()}>
                    {recording ? 'Replace recording' : 'Upload recording'}
                  </Button>
                  <Button size="xs" variant={transcript ? 'secondary' : 'gold'} icon={<Sparkles size={11} />} loading={busy === 'transcribe'} disabled={anyBusy || !recording || !aiConfigured} title={!aiConfigured ? 'Configure Gemini in Settings → AI' : !recording ? 'Upload a recording first' : 'Transcribe with Gemini and summarise'} onClick={onTranscribe}>
                    {transcript ? 'Re-transcribe' : 'Transcribe & summarise'}
                  </Button>
                  {transcript && (
                    <Button size="xs" variant="secondary" icon={<RefreshCw size={11} />} loading={busy === 'summarize'} disabled={anyBusy || !aiConfigured} title={!aiConfigured ? 'Configure Gemini in Settings → AI' : 'Generate the summary again from the transcript'} onClick={onSummarize}>
                      Re-summarise
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          {!aiConfigured && recording && <InlineNotice>AI is not configured. Add a Gemini API key in Settings → AI to transcribe and summarise recordings.</InlineNotice>}
          {!recording && !transcript && (
            <div className="rounded-lg border border-[#E6EFF6] bg-white p-3 text-[#5E778C] flex items-start gap-2">
              <FileAudio size={14} className="text-[#0B6BB0] flex-shrink-0 mt-0.5" />
              <span>No recording for this call. Browsers cannot record phone-line audio — recordings arrive from your telephony provider's webhook, or upload the file your provider or phone saved.</span>
            </div>
          )}

          {summary && (
            <div className="rounded-lg border border-[#E6EFF6] bg-white p-3 space-y-2">
              <div className="text-[10px] uppercase font-bold tracking-wider text-[#0B6BB0] inline-flex items-center gap-1"><Sparkles size={11} /> AI summary</div>
              <p className="text-[#0F2233] leading-relaxed whitespace-pre-wrap">{call.aiSummary}</p>
              {(call.keyPoints?.length || 0) > 0 && (
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C] mb-1">Key points</div>
                  <ul className="list-disc pl-4 space-y-0.5 text-[#0F2233]">{call.keyPoints!.map((k, i) => <li key={i}>{k}</li>)}</ul>
                </div>
              )}
              {(call.followupActions?.length || 0) > 0 && (
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C] mb-1">Follow-up actions</div>
                  <ul className="list-disc pl-4 space-y-0.5 text-[#0F2233]">{call.followupActions!.map((k, i) => <li key={i}>{k}</li>)}</ul>
                </div>
              )}
              {call.leadId && (
                <div className="flex items-end gap-2 flex-wrap pt-1 border-t border-[#E6EFF6]">
                  <Button size="xs" variant="secondary" icon={<NotebookPen size={11} />} loading={busy === 'remark'} disabled={anyBusy} onClick={onAddRemark}>Add summary as follow-up remark</Button>
                  <div className="flex items-end gap-1.5">
                    <Field label="Set follow-up from AI" hint={lead && lead[F.NEXT_FOLLOWUP] ? `Current: ${formatRelative(lead[F.NEXT_FOLLOWUP])}` : undefined}>
                      <input type="datetime-local" value={followup} onChange={(e) => setFollowupValue(e.target.value)} className={cx(inputCls, '!w-auto')} disabled={anyBusy} />
                    </Field>
                    <Button size="xs" variant="primary" icon={<CalendarClock size={11} />} loading={busy === 'followup'} disabled={anyBusy || !followupIso} onClick={() => followupIso && onSetFollowup(followupIso)} className="mb-[1px]">Schedule</Button>
                  </div>
                  <Button size="xs" variant="ghost" icon={<ExternalLink size={11} />} onClick={() => onOpenLead(call.leadId)}>Open lead</Button>
                </div>
              )}
            </div>
          )}

          {transcript && (
            <div className="rounded-lg border border-[#E6EFF6] bg-white">
              <button type="button" onClick={() => setShowTranscript((s) => !s)} className="w-full flex items-center justify-between p-2.5 text-left hover:bg-[#F2F7FB] rounded-lg">
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">Transcript · {String(call.transcript || '').length.toLocaleString('en-IN')} characters</span>
                {showTranscript ? <ChevronDown size={14} className="text-[#7E93A6]" /> : <ChevronRight size={14} className="text-[#7E93A6]" />}
              </button>
              {showTranscript && <pre className="p-3 pt-0 text-[11px] text-[#0F2233] whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto">{call.transcript}</pre>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Fact: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="rounded-lg bg-white border border-[#E6EFF6] p-2 min-w-0">
    <div className="text-[10px] uppercase font-bold tracking-wider text-[#5E778C]">{label}</div>
    <div className={cx('text-xs font-semibold text-[#0B2A44] mt-0.5 truncate', mono && 'font-mono font-normal')}>{value}</div>
  </div>
);

export default CallsView;
