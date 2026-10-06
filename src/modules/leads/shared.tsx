/**
 * Leads module — local helpers shared by LeadsView, LeadDetailModal,
 * AddLeadModal and KanbanView. Nothing here is imported by other modules
 * (cross-module sharing goes through core/ and components/ui).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Mic, Sparkles, Star, X } from 'lucide-react';
import { Lead } from '../../types/crm';
import { api } from '../../core/api';
import { leadScore } from '../../core/analytics';
import { reportError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { audioRecorder } from '../../services/audioRecorder';
import { sound } from '../../services/sound';
import { Button, cx, inputCls } from '../../components/ui';

/* ------------------------------------------------------------------------ */
/* Score stars                                                               */
/* ------------------------------------------------------------------------ */

export const Stars: React.FC<{ score: number; size?: number; className?: string; title?: string }> = ({ score, size = 12, className, title }) => (
  <span className={cx('inline-flex text-[#A9825A]', className)} title={title ?? `Engagement score ${score}/5`} aria-label={`${score} of 5`}>
    {[0, 1, 2, 3, 4].map((i) => (
      <Star key={i} size={size} className={i < score ? 'fill-[#A9825A]' : 'stroke-[#D2C9BF]'} />
    ))}
  </span>
);

/** 1–5 engagement stars for a lead (score comes from core/analytics — one implementation). */
export const LeadStars: React.FC<{ lead: Lead; size?: number; className?: string }> = ({ lead, size, className }) => (
  <Stars score={leadScore(lead)} size={size} className={className} />
);

/* ------------------------------------------------------------------------ */
/* Select options                                                            */
/* ------------------------------------------------------------------------ */

/** Config dropdown options plus the record's current value (legacy values must stay selectable). */
export function optionsWithCurrent(options: string[] | undefined, current: string | undefined | null): string[] {
  const list = [...(options || [])];
  const cur = String(current || '').trim();
  if (cur && !list.includes(cur)) list.push(cur);
  return list;
}

/* ------------------------------------------------------------------------ */
/* Calls                                                                     */
/* ------------------------------------------------------------------------ */

export const CALL_OUTCOMES = ['Interested', 'Site Visit Planned', 'Needs Follow-up', 'Not Interested', 'No Answer', 'Busy', 'Booked', 'Other'] as const;

export function callStatusForOutcome(outcome: string): 'Completed' | 'No Answer' | 'Busy' {
  if (outcome === 'No Answer') return 'No Answer';
  if (outcome === 'Busy') return 'Busy';
  return 'Completed';
}

/* ------------------------------------------------------------------------ */
/* Files                                                                     */
/* ------------------------------------------------------------------------ */

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // backend rejects > 45 MB; keep headroom for base64 overhead

/** File → base64 payload (without the data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------------ */
/* Lazy module data (timeline, calls, chats, files)                          */
/* ------------------------------------------------------------------------ */

export interface LazyResource<T> {
  data: T | null;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads `loader()` the first time `active` becomes true; exposes reload/setData.
 * Safe under StrictMode double-effects and never sets state after unmount.
 */
export function useLazyResource<T>(active: boolean, loader: () => Promise<T>, scope: string): LazyResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      if (aliveRef.current) setData(result);
    } catch (e) {
      const err = reportError(scope, e);
      if (aliveRef.current) setError(err.userMessage);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (active && data === null && !loading && error === null) void reload();
  }, [active, data, loading, error, reload]);

  return { data, setData, loading, error, reload };
}

/* ------------------------------------------------------------------------ */
/* Dictation (microphone → transcription)                                    */
/* ------------------------------------------------------------------------ */

export interface Dictation {
  recording: boolean;
  transcribing: boolean;
  supported: boolean;
  toggle: () => Promise<void>;
  cancel: () => void;
}

/**
 * Start/stop microphone dictation through services/audioRecorder.
 * The recording is cancelled automatically when the owning component unmounts
 * so the mic is never left on after a modal closes.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recordingRef = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  const cancel = useCallback(() => {
    if (!recordingRef.current) return;
    try {
      audioRecorder.cancelRecording();
    } catch {
      /* mic already released */
    }
    recordingRef.current = false;
    setRecording(false);
  }, []);

  const toggle = useCallback(async () => {
    if (recordingRef.current) {
      recordingRef.current = false;
      setRecording(false);
      setTranscribing(true);
      try {
        const text = String((await audioRecorder.stopAndTranscribe()) || '').trim();
        if (text) {
          onTextRef.current(text);
          sound.playChime();
        } else {
          toast('Nothing transcribed', 'No speech was detected in the recording.', 'warning');
        }
      } catch (e) {
        const err = reportError('leads.dictate', e);
        toast('Transcription failed', err.userMessage, 'warning');
      } finally {
        setTranscribing(false);
      }
      return;
    }
    try {
      await audioRecorder.startRecording();
      recordingRef.current = true;
      setRecording(true);
    } catch (e) {
      const err = reportError('leads.microphone', e);
      toast('Microphone unavailable', err.userMessage, 'warning');
    }
  }, []);

  // Release the microphone when the owner unmounts (modal closed, lead changed).
  useEffect(() => cancel, [cancel]);

  return { recording, transcribing, supported, toggle, cancel };
}

export const DictateButton: React.FC<{ dictation: Dictation; size?: 'xs' | 'sm'; disabled?: boolean }> = ({ dictation, size = 'xs', disabled }) => {
  if (!dictation.supported) return null;
  const { recording, transcribing, toggle } = dictation;
  return (
    <Button
      type="button"
      size={size}
      variant={recording ? 'danger' : 'secondary'}
      onClick={() => void toggle()}
      disabled={disabled || transcribing}
      loading={transcribing}
      icon={<Mic size={12} className={recording ? 'animate-pulse' : ''} />}
      className={recording ? 'bg-[#FAF0EC] border-[#B06A55] text-[#8A3E28] animate-pulse' : ''}
      title={recording ? 'Stop recording and transcribe' : 'Dictate with the microphone'}
    >
      {recording ? 'Stop & transcribe' : transcribing ? 'Transcribing…' : 'Dictate'}
    </Button>
  );
};

/* ------------------------------------------------------------------------ */
/* SmartTextarea — textarea + Dictate + "✨ Reframe (AI)"                    */
/* ------------------------------------------------------------------------ */

/** A second click on "Reframe" this soon after the first is a double click — ignored. */
export const REFRAME_DEBOUNCE_MS = 700;

/**
 * What to do with a polished text when it arrives:
 *  - 'replace'   the box still holds the text that was sent → swap it in
 *  - 'offer'     the user typed meanwhile → keep their text, offer "Use polished version"
 *  - 'unchanged' the AI had nothing to improve
 *  - 'failed'    no usable result (request failed or came back empty)
 *  - 'stale'     the box was cleared meanwhile (e.g. the remark was saved) → do nothing
 * Pure — unit-tested in tests/copilot-reframe.test.ts.
 */
export type ReframeOutcome = 'replace' | 'offer' | 'unchanged' | 'failed' | 'stale';

export function reframeOutcome(sent: string, current: string, polished: unknown): ReframeOutcome {
  const before = String(sent ?? '').trim();
  const now = String(current ?? '').trim();
  const out = String(polished ?? '').trim();
  if (!now) return 'stale';
  if (!out) return 'failed';
  if (out === before) return 'unchanged';
  return now === before ? 'replace' : 'offer';
}

/** Inline feedback after a reframe; `at` / `after` is the text it belongs to (it disappears once the user edits). */
type ReframeNote = { kind: 'polished'; before: string; after: string } | { kind: 'unchanged' | 'failed'; at: string };

export const SmartTextarea: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** Show the AI reframe button (hide when the Gemini key is not configured). */
  aiEnabled?: boolean;
  /** reportError scope, e.g. 'leads.reframe' */
  scope?: string;
  className?: string;
  /** Extra controls rendered on the right side of the toolbar (e.g. Save). */
  actions?: React.ReactNode;
  autoFocus?: boolean;
}> = ({ value, onChange, placeholder, rows = 3, disabled, aiEnabled = true, scope = 'leads.reframe', className, actions, autoFocus }) => {
  const valueRef = useRef(value);
  valueRef.current = value;
  const dictation = useDictation((text) => onChange(valueRef.current.trim() ? `${valueRef.current.trim()} ${text}` : text));
  const [polishing, setPolishing] = useState(false);
  /** Polished text held back because the user kept typing while it was prepared. */
  const [offer, setOffer] = useState<string | null>(null);
  const [note, setNote] = useState<ReframeNote | null>(null);
  const inFlightRef = useRef(false);
  const lastClickRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // A cleared box (remark saved, form reset) drops any pending offer or note.
  useEffect(() => {
    if (!value.trim()) {
      setOffer(null);
      setNote(null);
    }
  }, [value]);

  const reframe = async () => {
    const clickedAt = Date.now();
    if (inFlightRef.current || clickedAt - lastClickRef.current < REFRAME_DEBOUNCE_MS) return;
    const sent = valueRef.current;
    const text = sent.trim();
    if (!text) return;
    lastClickRef.current = clickedAt;
    inFlightRef.current = true;
    setPolishing(true);
    setOffer(null);
    setNote(null);
    let polished: unknown = '';
    try {
      polished = (await api.ai.reframe(text))?.result;
    } catch (e) {
      reportError(scope, e); // detail goes to the error log; the user only sees the quiet note below
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setPolishing(false);
    }
    if (!aliveRef.current) return;
    const current = valueRef.current;
    const out = String(polished ?? '').trim();
    switch (reframeOutcome(sent, current, out)) {
      case 'replace':
        onChange(out);
        setNote({ kind: 'polished', before: current, after: out });
        break;
      case 'offer':
        setOffer(out);
        break;
      case 'unchanged':
        setNote({ kind: 'unchanged', at: current });
        break;
      case 'failed':
        setNote({ kind: 'failed', at: current });
        break;
      default:
        break; // stale — nothing to show
    }
  };

  const acceptOffer = () => {
    if (offer === null) return;
    const before = valueRef.current;
    onChange(offer);
    setNote({ kind: 'polished', before, after: offer });
    setOffer(null);
  };

  const undo = () => {
    if (note?.kind !== 'polished') return;
    onChange(note.before);
    setNote(null);
  };

  // Notes belong to the text they were written for; any further edit hides them.
  const shownNote = note && (note.kind === 'polished' ? note.after === value : note.at === value) ? note : null;

  return (
    <div className={cx('space-y-2', className)}>
      {/* Stays editable while the AI polishes — the result never overwrites newer typing. */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-busy={polishing || undefined}
        className={cx(inputCls, 'resize-y leading-relaxed')}
      />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <DictateButton dictation={dictation} disabled={disabled} />
          {aiEnabled && (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => void reframe()}
              disabled={disabled || !value.trim()}
              aria-disabled={polishing || undefined}
              icon={<Sparkles size={12} className={cx('text-[#A9825A]', polishing && 'animate-pulse')} />}
              className={polishing ? 'cursor-progress' : undefined}
              title={polishing ? 'Polishing — you can keep typing' : 'Polish grammar, punctuation and tone with AI'}
            >
              {polishing ? 'Polishing…' : '✨ Reframe (AI)'}
            </Button>
          )}
          {aiEnabled && offer !== null && (
            <span className="inline-flex items-center gap-0.5">
              <button
                type="button"
                onClick={acceptOffer}
                title={offer}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[#A9825A]/50 bg-[#FBF7F1] text-[11px] font-semibold text-[#86633E] hover:border-[#A9825A] hover:bg-[#F4F0EB] transition"
              >
                <Sparkles size={11} /> Use polished version
              </button>
              <button type="button" onClick={() => setOffer(null)} className="p-1 rounded text-[#9E948D] hover:text-[#1D2F3F]" title="Keep my text" aria-label="Dismiss the polished version">
                <X size={11} />
              </button>
            </span>
          )}
          {aiEnabled && shownNote?.kind === 'polished' && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[#3C573A]">
              <Check size={11} /> Polished
              <span className="text-[#C9BFB4]">·</span>
              <button type="button" onClick={undo} className="font-semibold text-[#6B5F57] hover:text-[#1D2F3F] hover:underline underline-offset-2">
                Undo
              </button>
            </span>
          )}
          {aiEnabled && shownNote?.kind === 'unchanged' && <span className="text-[11px] text-[#9E948D]">Already reads well — no changes needed.</span>}
          {aiEnabled && shownNote?.kind === 'failed' && <span className="text-[11px] text-[#9E948D]">Couldn't polish just now — your text is unchanged.</span>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
};
