/**
 * Log a call — click-to-dial + in-app timer + outcome form, with an optional microphone
 * voice note (or an attached file) that is uploaded as the call recording once the call
 * row exists. Browsers cannot capture the phone line itself; see the notice in the form.
 *
 * Dialling follows the calling app chosen on this device (callsUtils DIALER_PRESETS): the
 * system phone app or Zoho Voice (both via tel: links — the switch here is a device
 * preference, so RMs can set it without Settings access), or a custom URL from Settings.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, FileAudio, Mic, Phone, PhoneIncoming, PhoneOutgoing, Search, Square, Trash2, X } from 'lucide-react';
import { CRMSettings, CallRecord, Lead, UserAccount } from '../../types/crm';
import { F } from '../../core/config';
import { api } from '../../core/api';
import { searchLeads } from '../../core/analytics';
import { nowIso } from '../../core/dates';
import { formatDuration } from '../../core/format';
import { formatPhone, isLikelyPhone } from '../../core/phone';
import { reportError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Field, InlineNotice, Modal, Select, StageBadge, cx, inputCls, labelCls } from '../../components/ui';
import { audioRecorder, isRecordingSupported, RecordingResult } from '../../services/audioRecorder';
import {
  DIRECTIONS, DialerPresetId, MANUAL_STATUSES, MAX_RECORDING_BYTES, OUTCOMES, RECORDING_ACCEPT, ZOHO_VOICE_SHORT_HINT, currentDialerPreset, dialerCallLabel, dialerHref, dialerSummary, fileToBase64, guessMime, isTelTemplate, saveDialerPreset,
} from './callsUtils';

export interface LogCallModalProps {
  open: boolean;
  leads: Lead[];
  settings: CRMSettings;
  currentUser: UserAccount | null;
  onClose: () => void;
  /** Called with the saved (and, when a recording was attached, updated) call record. */
  onLogged: (call: CallRecord) => void;
  onOpenLead: (id: string) => void;
}

type CallState = 'idle' | 'active' | 'ended';
type RecState = 'idle' | 'recording' | 'stopping';

const extFor = (mime: string) => {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return 'webm';
};

/** Open a dialer link without navigating the SPA away (tel:, zohovoice:, …). */
function openDialer(href: string) {
  if (!href || href === '#') return;
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const LogCallModal: React.FC<LogCallModalProps> = ({ open, leads, settings, currentUser, onClose, onLogged, onOpenLead }) => {
  const [leadQuery, setLeadQuery] = useState('');
  const [lead, setLead] = useState<Lead | null>(null);
  const [phone, setPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [direction, setDirection] = useState<CallRecord['direction']>('Outbound');

  const [callState, setCallState] = useState<CallState>('idle');
  const [startIso, setStartIso] = useState('');
  const [endIso, setEndIso] = useState('');
  const startMsRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [durationSec, setDurationSec] = useState('');

  const [status, setStatus] = useState<CallRecord['status']>('Completed');
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');

  const [recState, setRecState] = useState<RecState>('idle');
  const [recElapsed, setRecElapsed] = useState(0);
  const [recording, setRecording] = useState<RecordingResult | null>(null);
  const [recUrl, setRecUrl] = useState<string>('');
  const [recError, setRecError] = useState<string | null>(null);
  const [attached, setAttached] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Calling app on this device: system phone / Zoho Voice (tel: links) or a custom URL from Settings.
  const dialerTemplate = settings.dialerTemplate;
  const [preset, setPreset] = useState<DialerPresetId>(() => currentDialerPreset({ dialerTemplate }));
  useEffect(() => setPreset(currentDialerPreset({ dialerTemplate })), [dialerTemplate]);
  const telDialer = isTelTemplate(dialerTemplate);
  const choosePreset = (id: DialerPresetId) => {
    setPreset(id);
    saveDialerPreset(id);
  };

  const results = useMemo(() => (leadQuery.trim().length >= 2 ? searchLeads(leads, leadQuery, 8) : []), [leads, leadQuery]);
  const recordingSupported = isRecordingSupported();

  /* timers */
  useEffect(() => {
    if (callState !== 'active') return;
    const t = window.setInterval(() => setElapsed(Math.max(0, Math.round((Date.now() - startMsRef.current) / 1000))), 1000);
    return () => window.clearInterval(t);
  }, [callState]);

  useEffect(() => {
    if (recState !== 'recording') return;
    const t = window.setInterval(() => setRecElapsed(Math.round(audioRecorder.elapsedMs / 1000)), 500);
    return () => window.clearInterval(t);
  }, [recState]);

  // Release the microphone when the modal unmounts (an in-progress note is discarded).
  useEffect(() => () => audioRecorder.cancelRecording(), []);

  // Playback URL for the captured voice note; revoked when it changes or the modal unmounts.
  useEffect(() => {
    if (!recording) {
      setRecUrl('');
      return;
    }
    const url = URL.createObjectURL(recording.blob);
    setRecUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording]);

  /* lead picker */
  const pickLead = (l: Lead) => {
    setLead(l);
    setLeadQuery('');
    if (l[F.PHONE]) setPhone(String(l[F.PHONE]));
    if (l[F.NAME]) setCustomerName(String(l[F.NAME]));
  };
  const clearLead = () => setLead(null);

  /* call timer */
  const startCall = () => {
    if (!lead && !isLikelyPhone(phone)) {
      setError('Pick an enquiry or enter a valid phone number before dialling.');
      return;
    }
    setError(null);
    const target = phone.trim() || (lead ? String(lead[F.PHONE] || '') : '');
    openDialer(dialerHref(settings, target));
    startMsRef.current = Date.now();
    setStartIso(nowIso());
    setEndIso('');
    setElapsed(0);
    setCallState('active');
  };
  const endCall = () => {
    const secs = Math.max(0, Math.round((Date.now() - startMsRef.current) / 1000));
    setElapsed(secs);
    setDurationSec(String(secs));
    setEndIso(nowIso());
    setCallState('ended');
  };

  /* voice note */
  const startRec = async () => {
    setRecError(null);
    try {
      await audioRecorder.startRecording();
      setRecElapsed(0);
      setRecState('recording');
    } catch (e) {
      setRecError(reportError('calls.record.start', e).userMessage);
      setRecState('idle');
    }
  };
  const stopRec = async () => {
    setRecState('stopping');
    try {
      const r = await audioRecorder.stopAndGetBlob();
      if (r.blob.size > MAX_RECORDING_BYTES) {
        setRecError('The voice note is larger than 19 MB and cannot be transcribed. Record a shorter note.');
      } else {
        setRecording(r);
        setAttached(null);
      }
    } catch (e) {
      setRecError(reportError('calls.record.stop', e).userMessage);
    } finally {
      setRecState('idle');
    }
  };
  const discardRec = () => setRecording(null);

  const onAttach = (file: File | undefined) => {
    setRecError(null);
    if (!file) return;
    if (file.size > MAX_RECORDING_BYTES) {
      setRecError('The file is larger than 19 MB. Compress it (MP3/OGG) before attaching so it can be transcribed.');
      return;
    }
    setAttached(file);
    setRecording(null);
  };

  /* save */
  const save = async () => {
    const phoneClean = phone.trim();
    if (!lead && !isLikelyPhone(phoneClean)) {
      setError('Pick an enquiry or enter a valid phone number.');
      return;
    }
    if (recState !== 'idle') {
      setError('Stop the voice note before saving.');
      return;
    }
    let start = startIso;
    let end = endIso;
    let duration = Number(durationSec) || 0;
    if (callState === 'active') {
      duration = Math.max(0, Math.round((Date.now() - startMsRef.current) / 1000));
      end = nowIso();
    }
    if (!start) start = nowIso();

    setSaving(true);
    setError(null);
    try {
      const payload: Partial<CallRecord> = {
        leadId: lead ? String(lead[F.ID] || '') : undefined,
        phone: phoneClean || undefined,
        customerName: customerName.trim() || undefined,
        direction,
        startTime: start,
        endTime: end || undefined,
        durationSec: duration,
        status,
        outcome: outcome || undefined,
        notes: notes.trim() || undefined,
        provider: 'Manual',
        loggedBy: currentUser?.name,
      };
      const call = await api.calls.log(payload);
      let final = call;

      const upload = recording
        ? { name: `${call.id}_voice-note.${extFor(recording.mime)}`, mime: recording.mime, base64: recording.base64 }
        : attached
        ? { name: attached.name, mime: guessMime(attached), base64: await fileToBase64(attached) }
        : null;

      if (upload) {
        if (!call.leadId) {
          toast('Recording not attached', 'The call is not linked to an enquiry, so the recording could not be stored. Link it from the call list and upload again.', 'warning');
        } else {
          try {
            final = await api.calls.uploadRecording(call.id, upload.name, upload.mime, upload.base64);
          } catch (e) {
            const err = reportError('calls.uploadRecording', e);
            toast('Call logged, recording failed', err.userMessage, 'warning');
          }
        }
      }

      toast('Call logged', `${final.customerName || formatPhone(final.phone)} · ${final.status}${final.durationSec ? ` · ${formatDuration(final.durationSec)}` : ''}`, 'success');
      onLogged(final);
      onClose();
    } catch (e) {
      setError(reportError('calls.log', e).userMessage);
    } finally {
      setSaving(false);
    }
  };

  const dialHref = dialerHref(settings, phone.trim() || (lead ? String(lead[F.PHONE] || '') : ''));
  const dialerIsCustom = !telDialer;
  const dialTitle = dialerIsCustom ? `Opens ${settings.dialerTemplate}` : preset === 'zoho' ? 'Dials through Zoho Voice (your default app for phone links)' : 'Opens your phone app';

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title="Log a call"
      subtitle="Dial, time the call, record the outcome — saved to Call History and the lead's timeline"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving} icon={<Phone size={13} />}>Save call</Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <InlineNotice tone="warning">{error}</InlineNotice>}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Who */}
          <section className="space-y-3">
            <h4 className="text-xs font-bold text-[#1D2F3F] uppercase tracking-wider">Who</h4>
            <div className="rounded-xl border border-[#D2C9BF] bg-white p-3">
              {lead ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#1D2F3F] truncate">{lead[F.NAME]} <span className="font-mono text-[10px] text-[#A9825A] ml-1">{lead[F.ID]}</span></div>
                    <div className="text-[11px] text-[#6B5F57] mt-0.5 flex items-center gap-2 flex-wrap">
                      <StageBadge stage={lead[F.STAGE]} />
                      <span>{lead[F.UNIT_TYPE] || '—'}</span>
                      <span>· RM {lead[F.RM] || '—'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="xs" variant="ghost" icon={<ExternalLink size={11} />} onClick={() => onOpenLead(String(lead[F.ID]))}>Open</Button>
                    <Button size="xs" variant="ghost" icon={<X size={11} />} onClick={clearLead} disabled={saving}>Clear</Button>
                  </div>
                </div>
              ) : (
                <div>
                  <label className={labelCls}>Enquiry</label>
                  <div className="relative">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9E948D]" />
                    <input autoFocus value={leadQuery} onChange={(e) => setLeadQuery(e.target.value)} placeholder="Search by name, phone or enquiry ID…" className={cx(inputCls, 'pl-8')} disabled={saving} />
                  </div>
                  {leadQuery.trim().length >= 2 && (
                    <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-[#ECE8E1] divide-y divide-[#ECE8E1]">
                      {results.length === 0 && <div className="p-2.5 text-xs text-[#9E948D]">No matching enquiries — you can still log the call by phone number.</div>}
                      {results.map((l) => (
                        <button key={l[F.ID]} type="button" onClick={() => pickLead(l)} className="w-full text-left p-2.5 hover:bg-[#F4F0EB] flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[#1D2F3F] truncate">{l[F.NAME]} <span className="font-mono text-[10px] text-[#A9825A] ml-1">{l[F.ID]}</span></div>
                            <div className="text-[10px] text-[#6B5F57]">{formatPhone(l[F.PHONE]) || '—'} · {l[F.UNIT_TYPE] || '—'}</div>
                          </div>
                          <StageBadge stage={l[F.STAGE]} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="text-[10px] text-[#9E948D] mt-1">Optional — the backend also matches the phone number to an existing enquiry.</div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Phone" hint={phone ? formatPhone(phone) : undefined}>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} placeholder="+91 …" inputMode="tel" disabled={saving || callState === 'active'} />
              </Field>
              <Field label="Customer name">
                <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className={inputCls} placeholder={lead ? String(lead[F.NAME]) : 'Name'} disabled={saving} />
              </Field>
            </div>
            <Field label="Direction">
              <div className="inline-flex p-1 rounded-xl bg-[#EBE5DC] border border-[#D2C9BF]">
                {DIRECTIONS.map((d) => (
                  <button key={d} type="button" onClick={() => setDirection(d)} className={cx('flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition', direction === d ? 'bg-white text-[#1D2F3F] shadow-sm' : 'text-[#6B5F57] hover:text-[#1D2F3F]')}>
                    {d === 'Outbound' ? <PhoneOutgoing size={12} /> : <PhoneIncoming size={12} />} {d}
                  </button>
                ))}
              </div>
            </Field>

            {/* Timer */}
            <div className="rounded-xl border border-[#D2C9BF] bg-[#F4F0EB] p-3 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Call timer</div>
                <div className={cx('text-2xl font-bold tabular-nums', callState === 'active' ? 'text-[#B06A55]' : 'text-[#1D2F3F]')}>{formatDuration(callState === 'idle' ? Number(durationSec) || 0 : elapsed)}</div>
                {callState === 'active' && <div className="text-[10px] text-[#B06A55] font-semibold">● Call in progress</div>}
              </div>
              <div className="flex items-center gap-2">
                {callState !== 'active' ? (
                  <Button variant="gold" onClick={startCall} icon={<PhoneOutgoing size={13} />} disabled={saving || dialHref === '#'} title={dialTitle}>
                    {dialerCallLabel(preset, callState === 'ended')}
                  </Button>
                ) : (
                  <Button variant="danger" onClick={endCall} icon={<Square size={12} />}>End call</Button>
                )}
              </div>
              <div className="w-full grid grid-cols-2 gap-2">
                <Field label="Duration (seconds)">
                  <input type="number" min={0} value={durationSec} onChange={(e) => setDurationSec(e.target.value)} className={inputCls} placeholder="0" disabled={saving || callState === 'active'} />
                </Field>
                <Field label="Calling app" hint={dialerIsCustom ? 'Custom link — change it in Settings → Integrations → Telephony.' : preset === 'zoho' ? ZOHO_VOICE_SHORT_HINT : 'Saved on this device.'}>
                  {dialerIsCustom ? (
                    <div className="text-xs text-[#3D3530] pt-2 truncate" title={dialHref}>{dialerSummary(preset, settings.dialerTemplate)}</div>
                  ) : (
                    <Select
                      value={preset === 'zoho' ? 'zoho' : 'system'}
                      onChange={(e) => choosePreset(e.target.value === 'zoho' ? 'zoho' : 'system')}
                      options={[{ value: 'system', label: 'System phone (tel:)' }, { value: 'zoho', label: 'Zoho Voice' }]}
                      disabled={saving || callState === 'active'}
                      aria-label="Calling app"
                    />
                  )}
                </Field>
              </div>
            </div>
          </section>

          {/* Outcome */}
          <section className="space-y-3">
            <h4 className="text-xs font-bold text-[#1D2F3F] uppercase tracking-wider">Outcome</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value as CallRecord['status'])} options={MANUAL_STATUSES} disabled={saving} />
              </Field>
              <Field label="Outcome">
                <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} options={OUTCOMES} placeholder="Select…" disabled={saving} />
              </Field>
            </div>
            <Field label="Notes">
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="What was discussed, objections, next step…" disabled={saving} />
            </Field>

            <div className="rounded-xl border border-[#D2C9BF] bg-white p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Recording</div>
                {recState === 'recording' && <span className="text-[10px] font-bold text-[#B06A55]">● Recording {formatDuration(recElapsed)}</span>}
              </div>
              <InlineNotice>
                <div className="flex items-start gap-2"><AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-[#A9825A]" /><span>Browsers cannot record phone-line audio. Recordings come from your telephony provider (webhook) or an uploaded file. The voice note below records your microphone only — useful for a quick spoken summary right after the call.</span></div>
              </InlineNotice>
              {recError && <InlineNotice tone="warning">{recError}</InlineNotice>}

              {recording ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <audio controls src={recUrl} className="h-8 flex-1 min-w-[180px]" />
                  <span className="text-[10px] text-[#6B5F57]">{formatDuration(Math.round(recording.durationMs / 1000))} · {Math.round(recording.blob.size / 1024)} KB</span>
                  <Button size="xs" variant="ghost" icon={<Trash2 size={11} />} onClick={discardRec} disabled={saving}>Discard</Button>
                </div>
              ) : attached ? (
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <FileAudio size={14} className="text-[#A9825A]" />
                  <span className="font-semibold text-[#1D2F3F] truncate max-w-[220px]">{attached.name}</span>
                  <span className="text-[10px] text-[#6B5F57]">{Math.round(attached.size / 1024)} KB</span>
                  <Button size="xs" variant="ghost" icon={<Trash2 size={11} />} onClick={() => setAttached(null)} disabled={saving}>Remove</Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  {recState === 'recording' ? (
                    <Button variant="danger" size="sm" onClick={stopRec} icon={<Square size={12} />}>Stop voice note</Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={startRec} loading={recState === 'stopping'} disabled={!recordingSupported || saving} icon={<Mic size={13} />} title={recordingSupported ? 'Record a voice note with your microphone' : 'Microphone recording is not supported in this browser'}>
                      Record a voice note
                    </Button>
                  )}
                  <input ref={fileRef} type="file" accept={RECORDING_ACCEPT} className="hidden" onChange={(e) => onAttach(e.target.files?.[0])} />
                  <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={saving || recState !== 'idle'} icon={<FileAudio size={13} />}>Attach recording file</Button>
                </div>
              )}
              <div className="text-[10px] text-[#9E948D]">Stored with the lead's files (Call Recordings) after the call is saved; you can then transcribe and summarise it with AI. Requires the call to be linked to an enquiry.</div>
            </div>
          </section>
        </div>
      </div>
    </Modal>
  );
};

export default LogCallModal;
