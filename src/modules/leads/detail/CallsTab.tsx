/**
 * Lead detail → Calls tab: call history for the lead (api.calls.list), a quick
 * "log call" form with a start/end timer, recording upload and AI transcription.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, FileAudio, Phone, PhoneCall, PhoneIncoming, PhoneOutgoing, Play, RefreshCw, Sparkles, Square, Upload } from 'lucide-react';
import { CallRecord, Lead } from '../../../types/crm';
import { F } from '../../../core/config';
import { api } from '../../../core/api';
import { formatDateTime } from '../../../core/dates';
import { formatDuration } from '../../../core/format';
import { reportError } from '../../../core/errors';
import { toast } from '../../../core/notifications';
import { telLink } from '../../../core/phone';
import { Badge, Button, EmptyState, ErrorState, Field, InlineNotice, Select, cx, inputCls } from '../../../components/ui';
import { CALL_OUTCOMES, MAX_UPLOAD_BYTES, callStatusForOutcome, fileToBase64, formatBytes, useLazyResource } from '../shared';
import { ListSkeleton } from '../../../components/Skeletons';

interface Props {
  lead: Lead;
  active: boolean;
  aiConfigured: boolean;
  /** Called after a call is logged / updated so the timeline can refresh. */
  onChanged?: () => void;
}

type Direction = 'Outbound' | 'Inbound';

export const CallsTab: React.FC<Props> = ({ lead, active, aiConfigured, onChanged }) => {
  const id = String(lead[F.ID]);
  const phone = String(lead[F.PHONE] || '');
  const calls = useLazyResource<CallRecord[]>(active, () => api.calls.list(id), 'leads.calls');

  /* ------------------------------ log form ------------------------------ */
  const [direction, setDirection] = useState<Direction>('Outbound');
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [endedAt, setEndedAt] = useState<Date | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!startedAt || endedAt) return;
    const tick = () => setElapsed(Math.round((Date.now() - startedAt.getTime()) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAt, endedAt]);

  const durationSec = startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : startedAt ? elapsed : 0;

  const startTimer = () => {
    setStartedAt(new Date());
    setEndedAt(null);
    setElapsed(0);
  };
  const endTimer = () => setEndedAt(new Date());
  const resetForm = () => {
    setStartedAt(null);
    setEndedAt(null);
    setElapsed(0);
    setOutcome('');
    setNotes('');
    setFormError(null);
  };

  const logCall = async () => {
    if (!outcome) return setFormError('Choose an outcome for the call.');
    setFormError(null);
    setSaving(true);
    const start = startedAt || new Date();
    const end = endedAt || (startedAt ? new Date() : start);
    const dur = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
    try {
      const saved = await api.calls.log({
        leadId: id,
        phone,
        direction,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        durationSec: dur,
        status: callStatusForOutcome(outcome),
        outcome,
        notes: notes.trim(),
      });
      calls.setData((prev) => [saved, ...(prev || []).filter((c) => c.id !== saved.id)]);
      toast('Call logged', `${outcome} · ${formatDuration(dur)}`, 'success');
      resetForm();
      onChanged?.();
    } catch (e) {
      setFormError(reportError('leads.callLog', e).userMessage);
    } finally {
      setSaving(false);
    }
  };

  /* ----------------------------- per-call actions ----------------------------- */
  const [busy, setBusy] = useState<Record<string, 'upload' | 'transcribe' | undefined>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const replaceCall = (c: CallRecord) => calls.setData((prev) => (prev || []).map((x) => (x.id === c.id ? c : x)));

  const uploadRecording = async (call: CallRecord, file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setActionError(`Recording is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Compress it (MP3/OGG) first.`);
      return;
    }
    setActionError(null);
    setBusy((b) => ({ ...b, [call.id]: 'upload' }));
    try {
      const base64 = await fileToBase64(file);
      const updated = await api.calls.uploadRecording(call.id, file.name, file.type || 'audio/webm', base64);
      replaceCall(updated);
      toast('Recording uploaded', file.name, 'success');
      onChanged?.();
    } catch (e) {
      setActionError(reportError('leads.callRecording', e).userMessage);
    } finally {
      setBusy((b) => ({ ...b, [call.id]: undefined }));
    }
  };

  const transcribe = async (call: CallRecord) => {
    setActionError(null);
    setBusy((b) => ({ ...b, [call.id]: 'transcribe' }));
    try {
      const updated = await api.calls.transcribe(call.id);
      replaceCall(updated);
      toast('Transcript ready', 'The call was transcribed and summarised.', 'success');
      onChanged?.();
    } catch (e) {
      setActionError(reportError('leads.callTranscribe', e).userMessage);
    } finally {
      setBusy((b) => ({ ...b, [call.id]: undefined }));
    }
  };

  const list = useMemo(() => calls.data || [], [calls.data]);

  return (
    <div className="space-y-4">
      {/* Quick log */}
      <div className="bg-[#F4F0EB] p-4 rounded-xl border border-[#D2C9BF] space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs font-bold text-[#1D2F3F]">
            <PhoneCall size={14} className="text-[#A9825A]" />
            Log a call
          </div>
          <div className="inline-flex rounded-lg border border-[#D2C9BF] bg-white p-0.5 text-[11px] font-semibold">
            {(['Outbound', 'Inbound'] as Direction[]).map((d) => (
              <button key={d} type="button" onClick={() => setDirection(d)} className={cx('px-2.5 py-1 rounded-md flex items-center gap-1', direction === d ? 'bg-[#1D2F3F] text-white' : 'text-[#6B5F57] hover:text-[#1D2F3F]')}>
                {d === 'Outbound' ? <PhoneOutgoing size={11} /> : <PhoneIncoming size={11} />} {d}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {!startedAt ? (
            <Button type="button" variant="sage" size="xs" onClick={startTimer} icon={<Play size={11} />}>
              Start now
            </Button>
          ) : !endedAt ? (
            <Button type="button" variant="danger" size="xs" onClick={endTimer} icon={<Square size={11} />} className="animate-pulse">
              End now
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="xs" onClick={startTimer} icon={<Play size={11} />}>
              Restart timer
            </Button>
          )}
          <span className={cx('font-mono text-sm font-bold tabular-nums', startedAt && !endedAt ? 'text-[#8A3E28]' : 'text-[#1D2F3F]')}>{formatDuration(durationSec)}</span>
          <span className="text-[11px] text-[#6B5F57]">
            {startedAt ? `Started ${formatDateTime(startedAt)}${endedAt ? ` · ended ${formatDateTime(endedAt)}` : ' · in progress'}` : 'Optional — or log a call that already happened.'}
          </span>
          {phone && (
            <a href={telLink(phone)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-[#1976D2] hover:underline">
              <Phone size={11} /> Dial
            </a>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Outcome">
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} options={[...CALL_OUTCOMES]} placeholder="Select outcome…" />
          </Field>
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Key points, objections, promises made…" className={cx(inputCls, 'resize-y')} />
          </Field>
        </div>
        {formError && <InlineNotice tone="warning">{formError}</InlineNotice>}
        <div className="flex items-center justify-end gap-2">
          {(startedAt || notes || outcome) && (
            <Button type="button" variant="ghost" size="xs" onClick={resetForm}>
              Reset
            </Button>
          )}
          <Button type="button" variant="gold" onClick={() => void logCall()} loading={saving} disabled={!outcome} icon={<PhoneCall size={12} />}>
            Save call
          </Button>
        </div>
      </div>

      {actionError && <InlineNotice tone="warning">{actionError}</InlineNotice>}

      {/* History */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase font-bold tracking-wider text-[#6B5F57]">Call history{calls.data ? ` · ${list.length}` : ''}</div>
        <Button variant="ghost" size="xs" onClick={() => void calls.reload()} loading={calls.loading} icon={<RefreshCw size={11} />}>
          Refresh
        </Button>
      </div>
      {calls.loading && !calls.data && <ListSkeleton rows={4} label="Loading calls…" />}
      {calls.error && !calls.data && <ErrorState compact title="Calls could not load" message={calls.error} onRetry={() => void calls.reload()} />}
      {calls.data && list.length === 0 && <EmptyState icon={<Phone size={20} />} title="No calls logged" description="Log the first call above. Calls from a connected telephony provider also appear here automatically." className="py-6" />}

      <div className="space-y-2">
        {list.map((c) => (
          <CallRow
            key={c.id}
            call={c}
            aiConfigured={aiConfigured}
            busy={busy[c.id]}
            onPickRecording={() => fileInputs.current[c.id]?.click()}
            onTranscribe={() => void transcribe(c)}
            fileInput={
              <input
                ref={(el) => {
                  fileInputs.current[c.id] = el;
                }}
                type="file"
                accept="audio/*,video/mp4,.m4a,.mp3,.ogg,.wav,.webm"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void uploadRecording(c, f);
                }}
              />
            }
          />
        ))}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const statusTone = (s: CallRecord['status']): 'sage' | 'rust' | 'amber' | 'muted' | 'navy' => {
  switch (s) {
    case 'Completed':
      return 'sage';
    case 'Missed':
    case 'Failed':
      return 'rust';
    case 'No Answer':
    case 'Busy':
    case 'Voicemail':
      return 'amber';
    case 'In Progress':
      return 'navy';
    default:
      return 'muted';
  }
};

const CallRow: React.FC<{
  call: CallRecord;
  aiConfigured: boolean;
  busy?: 'upload' | 'transcribe';
  onPickRecording: () => void;
  onTranscribe: () => void;
  fileInput: React.ReactNode;
}> = ({ call, aiConfigured, busy, onPickRecording, onTranscribe, fileInput }) => {
  const [showSummary, setShowSummary] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const hasRecording = !!(call.recordingUrl || call.recordingFileId);
  const when = call.startTime || call.callDate || call.createdAt;

  return (
    <div className="bg-white rounded-xl border border-[#D2C9BF] p-3 shadow-2xs space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className={cx('mt-0.5 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0', call.direction === 'Inbound' ? 'bg-[#7C8B78]/20 text-[#3C573A]' : 'bg-[#1D2F3F]/10 text-[#1D2F3F]')}>
            {call.direction === 'Inbound' ? <PhoneIncoming size={13} /> : <PhoneOutgoing size={13} />}
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[#1D2F3F] flex items-center gap-2 flex-wrap">
              <span>{call.direction === 'Inbound' ? 'Incoming call' : 'Outgoing call'}</span>
              <Badge tone={statusTone(call.status)}>{call.status}</Badge>
              {call.outcome && <Badge tone="gold">{call.outcome}</Badge>}
            </div>
            <div className="text-[11px] text-[#6B5F57] mt-0.5">
              {formatDateTime(when, '—')} · {formatDuration(call.durationSec)}
              {call.loggedBy && ` · ${call.loggedBy}`}
              {call.provider && call.provider !== 'Manual' && ` · ${call.provider}`}
            </div>
          </div>
        </div>
        <span className="font-mono text-[10px] text-[#9E948D] whitespace-nowrap">{call.id}</span>
      </div>

      {call.notes && <div className="text-xs text-[#3D3530] leading-relaxed whitespace-pre-wrap bg-[#F4F0EB] rounded-lg p-2">{call.notes}</div>}

      <div className="flex items-center gap-2 flex-wrap">
        {call.recordingUrl && (
          <a href={call.recordingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1D2F3F] hover:text-[#A9825A]">
            <FileAudio size={12} /> Recording <ExternalLink size={10} />
          </a>
        )}
        {fileInput}
        <Button type="button" variant="secondary" size="xs" onClick={onPickRecording} loading={busy === 'upload'} disabled={!!busy} icon={<Upload size={11} />}>
          {hasRecording ? 'Replace recording' : 'Upload recording'}
        </Button>
        {aiConfigured && hasRecording && (
          <Button type="button" variant="secondary" size="xs" onClick={onTranscribe} loading={busy === 'transcribe'} disabled={!!busy} icon={<Sparkles size={11} className="text-[#A9825A]" />}>
            {call.transcript ? 'Re-transcribe & summarise' : 'Transcribe & summarise'}
          </Button>
        )}
        {call.aiSummary && (
          <button type="button" onClick={() => setShowSummary((v) => !v)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#86633E] hover:text-[#A9825A]">
            <Sparkles size={11} /> AI summary {showSummary ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
        {call.transcript && (
          <button type="button" onClick={() => setShowTranscript((v) => !v)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6B5F57] hover:text-[#1D2F3F]">
            Transcript {showTranscript ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </div>

      {showSummary && call.aiSummary && (
        <div className="rounded-lg border border-[#A9825A]/50 bg-[#FBF7F1] p-3 space-y-2 text-xs text-[#1D2F3F]">
          <div className="leading-relaxed whitespace-pre-wrap">{call.aiSummary}</div>
          {!!call.keyPoints?.length && (
            <div>
              <div className="text-[10px] uppercase font-bold tracking-wider text-[#86633E] mb-1">Key points</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {call.keyPoints.map((k, i) => (
                  <li key={i}>{k}</li>
                ))}
              </ul>
            </div>
          )}
          {!!call.followupActions?.length && (
            <div>
              <div className="text-[10px] uppercase font-bold tracking-wider text-[#86633E] mb-1">Follow-up actions</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {call.followupActions.map((k, i) => (
                  <li key={i}>{k}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {showTranscript && call.transcript && <div className="rounded-lg border border-[#D2C9BF] bg-[#FDFCFA] p-3 text-xs text-[#3D3530] leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">{call.transcript}</div>}
    </div>
  );
};
