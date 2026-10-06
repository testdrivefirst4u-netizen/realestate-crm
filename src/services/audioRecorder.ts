/**
 * Microphone recorder (MediaRecorder) → Blob / base64 → optional Gemini transcription
 * through the CRM backend (`api.ai.transcribe`).
 *
 * Browsers cannot capture phone-line audio: this records the device microphone only
 * (voice notes, in-person conversations on speaker). Real call recordings reach the
 * CRM through the telephony webhook or a file upload (see server/modules/calls).
 *
 * Lifecycle guarantees:
 *  - `startRecording()` refuses to start while another recording is active.
 *  - `stopAndGetBlob()` / `stopAndTranscribe()` always release the microphone and
 *    clear the recorder, even when the stop fails.
 *  - `cancelRecording()` discards the audio and releases the microphone.
 *  - Every error is an `AppError` with a user-facing message.
 */
import { api } from '../core/api';
import { AppError, toAppError } from '../core/errors';

export interface RecordingResult {
  blob: Blob;
  /** Raw base64 payload (no `data:` prefix) — what the backend expects. */
  base64: string;
  /** MIME type without codec parameters, e.g. `audio/webm`. */
  mime: string;
  durationMs: number;
}

export type RecorderState = 'inactive' | 'recording' | 'paused';

const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

/** True when this browser can record from the microphone at all. */
export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

/** First MIME type this browser's MediaRecorder supports ('' → let the browser decide). */
export function pickRecordingMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const m of PREFERRED_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* some browsers throw on unknown containers */
    }
  }
  return '';
}

/** Blob → raw base64 (data-URL prefix stripped). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf('base64,');
      resolve(idx >= 0 ? result.slice(idx + 7) : result);
    };
    reader.onerror = () => reject(new AppError('UNKNOWN', 'Could not read the audio data', undefined, 'Could not read the recorded audio. Please try again.'));
    reader.readAsDataURL(blob);
  });
}

function stripCodec(mime: string): string {
  return String(mime || '').split(';')[0].trim() || 'audio/webm';
}

export class AudioRecorderService {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audioChunks: Blob[] = [];
  private startedAt = 0;
  private stopping: Promise<RecordingResult> | null = null;

  get state(): RecorderState {
    return this.mediaRecorder ? (this.mediaRecorder.state as RecorderState) : 'inactive';
  }

  get isRecording(): boolean {
    return this.state === 'recording';
  }

  /** Milliseconds since the current recording started (0 when idle). */
  get elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  public async startRecording(): Promise<void> {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      throw new AppError('VALIDATION', 'A recording is already in progress', undefined, 'A recording is already in progress. Stop it before starting a new one.');
    }
    if (this.stopping) {
      throw new AppError('VALIDATION', 'Previous recording is still finishing', undefined, 'The previous recording is still being saved. Please wait a moment.');
    }
    if (!isRecordingSupported()) {
      throw new AppError('NOT_CONFIGURED', 'MediaRecorder is not supported', undefined, 'Microphone recording is not supported in this browser. Use a recent Chrome, Edge, Firefox or Safari.');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = e && typeof e === 'object' && 'name' in e ? String((e as { name?: string }).name) : '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        throw new AppError('FORBIDDEN', 'Microphone permission denied', e, 'Microphone access was denied. Allow the microphone for this site in your browser settings and try again.');
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        throw new AppError('NOT_FOUND', 'No microphone found', e, 'No microphone was found on this device.');
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        throw new AppError('UNKNOWN', 'Microphone is busy', e, 'The microphone is in use by another application. Close it and try again.');
      }
      throw toAppError(e);
    }

    // Defensive: never hold two streams.
    this.releaseStream();
    this.stream = stream;
    this.audioChunks = [];

    const mimeType = pickRecordingMimeType();
    try {
      this.mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      this.cleanup();
      throw toAppError(e);
    }

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.audioChunks.push(event.data);
    };

    try {
      // Time-sliced so long recordings are delivered in chunks and nothing is lost on stop.
      this.mediaRecorder.start(1000);
      this.startedAt = Date.now();
    } catch (e) {
      this.cleanup();
      throw toAppError(e);
    }
  }

  /** Stop the current recording and return the audio as Blob + base64. Releases the microphone. */
  public stopAndGetBlob(): Promise<RecordingResult> {
    if (this.stopping) return this.stopping;
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') {
      this.cleanup();
      return Promise.reject(new AppError('VALIDATION', 'No active recording', undefined, 'There is no recording in progress.'));
    }

    const mime = recorder.mimeType || pickRecordingMimeType() || 'audio/webm';
    const startedAt = this.startedAt;

    this.stopping = new Promise<RecordingResult>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        this.cleanup();
        reject(toAppError(err));
      };
      const finish = async () => {
        if (settled) return;
        settled = true;
        try {
          const blob = new Blob(this.audioChunks, { type: mime });
          const durationMs = startedAt ? Date.now() - startedAt : 0;
          this.cleanup();
          if (!blob.size) {
            throw new AppError('VALIDATION', 'Empty recording', undefined, 'Nothing was recorded. Check that the microphone is working and try again.');
          }
          const base64 = await blobToBase64(blob);
          resolve({ blob, base64, mime: stripCodec(mime), durationMs });
        } catch (e) {
          this.cleanup();
          reject(toAppError(e));
        }
      };

      recorder.onstop = () => {
        void finish();
      };
      recorder.onerror = (event: Event) => {
        const err = (event as Event & { error?: unknown }).error;
        fail(err instanceof Error ? err : new Error('Recording failed'));
      };

      try {
        recorder.stop();
      } catch (e) {
        fail(e);
      }
    }).finally(() => {
      this.stopping = null;
    });

    return this.stopping;
  }

  /** Stop the recording and transcribe it with Gemini through the backend. */
  public async stopAndTranscribe(): Promise<string> {
    const { base64, mime } = await this.stopAndGetBlob();
    try {
      const res = await api.ai.transcribe(base64, mime);
      return String((res && res.transcription) || '').trim();
    } catch (e) {
      throw toAppError(e);
    }
  }

  /** Discard the current recording (if any) and release the microphone. Safe to call at any time. */
  public cancelRecording(): void {
    const recorder = this.mediaRecorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.releaseStream();
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.startedAt = 0;
  }

  private releaseStream(): void {
    if (!this.stream) return;
    try {
      this.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
    } finally {
      this.stream = null;
    }
  }
}

export const audioRecorder = new AudioRecorderService();
