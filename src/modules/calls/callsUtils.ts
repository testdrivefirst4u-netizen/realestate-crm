/**
 * Calls module helpers — status/outcome vocab, tones, summary counts, file helpers, phone → enquiry
 * matching, calling-app (dialer) presets and the telephony field-map presets.
 * UI-free; nothing here talks to the backend (the calling-app choice is a device preference in localStorage).
 */
import { CRMSettings, CallRecord, Lead } from '../../types/crm';
import { F, STAGES } from '../../core/config';
import { dateKey, todayKey } from '../../core/dates';
import { fillTemplate, last10, telLink, toE164Digits } from '../../core/phone';
import { loadUiPref, saveUiPref } from '../../core/persistence';
import { blobToBase64 } from '../../services/audioRecorder';

export type BadgeTone = 'navy' | 'gold' | 'sage' | 'rust' | 'muted' | 'amber';

export const CALL_STATUSES: CallRecord['status'][] = ['Completed', 'Missed', 'No Answer', 'Busy', 'Voicemail', 'Failed', 'In Progress'];
/** Statuses a user can pick when logging a call by hand ("In Progress" is set by the dialer flow only). */
export const MANUAL_STATUSES: CallRecord['status'][] = ['Completed', 'No Answer', 'Busy', 'Voicemail', 'Missed', 'Failed'];
export const DIRECTIONS: CallRecord['direction'][] = ['Outbound', 'Inbound'];
export const OUTCOMES = ['Interested', 'Site Visit Planned', 'Needs Follow-up', 'Not Interested', 'No Answer', 'Busy', 'Voicemail', 'Booked', 'Other'];
export const MISSED_STATUSES: string[] = ['Missed', 'No Answer', 'Busy', 'Voicemail', 'Failed'];

export function statusTone(status: string | undefined | null): BadgeTone {
  switch (String(status || '')) {
    case 'Completed':
      return 'sage';
    case 'In Progress':
      return 'gold';
    case 'Missed':
    case 'Failed':
      return 'rust';
    case 'No Answer':
    case 'Busy':
      return 'amber';
    case 'Voicemail':
      return 'muted';
    default:
      return 'muted';
  }
}

export function outcomeTone(outcome: string | undefined | null): BadgeTone {
  switch (String(outcome || '')) {
    case 'Booked':
      return 'sage';
    case 'Interested':
    case 'Site Visit Planned':
      return 'navy';
    case 'Needs Follow-up':
      return 'gold';
    case 'Not Interested':
      return 'rust';
    default:
      return 'muted';
  }
}

/** The instant a call is attributed to: start time, else the call date. */
export const callTime = (c: CallRecord): string => c.startTime || c.callDate || c.createdAt || '';

export const hasRecording = (c: CallRecord): boolean => !!(c.recordingUrl || c.recordingFileId);
export const hasTranscript = (c: CallRecord): boolean => !!String(c.transcript || '').trim();
export const hasSummary = (c: CallRecord): boolean => !!String(c.aiSummary || '').trim();

export interface CallsSummary {
  today: number;
  durationTodaySec: number;
  completed: number;
  missed: number;
  withRecording: number;
  transcribed: number;
  summarized: number;
  total: number;
}

export function summarizeCalls(calls: CallRecord[]): CallsSummary {
  const today = todayKey();
  const s: CallsSummary = { today: 0, durationTodaySec: 0, completed: 0, missed: 0, withRecording: 0, transcribed: 0, summarized: 0, total: calls.length };
  for (const c of calls) {
    if (dateKey(callTime(c)) === today) {
      s.today++;
      s.durationTodaySec += Number(c.durationSec) || 0;
    }
    if (c.status === 'Completed') s.completed++;
    else if (MISSED_STATUSES.includes(String(c.status))) s.missed++;
    if (hasRecording(c)) s.withRecording++;
    if (hasTranscript(c)) s.transcribed++;
    if (hasSummary(c)) s.summarized++;
  }
  return s;
}

/** Newest first by start time / call date. */
export function sortCalls(calls: CallRecord[]): CallRecord[] {
  return [...calls].sort((a, b) => {
    const ta = Date.parse(callTime(a)) || 0;
    const tb = Date.parse(callTime(b)) || 0;
    return tb - ta;
  });
}

/** Replace a call in a list (by id) — used after transcribe / summarise / upload return the updated record. */
export function replaceCall(list: CallRecord[], updated: CallRecord): CallRecord[] {
  return list.some((c) => c.id === updated.id) ? list.map((c) => (c.id === updated.id ? updated : c)) : [updated, ...list];
}

/** File → raw base64 (data-URL prefix stripped), as the backend expects. */
export const fileToBase64 = (file: Blob): Promise<string> => blobToBase64(file);

/** Max size we send inline to the backend (it rejects > 45 MB; Gemini transcription needs ≤ 19 MB). */
export const MAX_RECORDING_BYTES = 19 * 1024 * 1024;

/* ------------------------------------------------------------------------ */
/* Calling app (dialer)                                                      */
/* ------------------------------------------------------------------------ */

/** The default dialer template: the app this computer opens for phone (tel:) links. */
export const DEFAULT_DIALER_TEMPLATE = 'tel:{phone}';

/** Link schemes that must never be opened from a dialer template. */
const UNSAFE_DIALER_SCHEME = /^\s*(javascript|data|vbscript|file):/i;

export type DialerPresetId = 'system' | 'zoho' | 'custom';

export interface DialerPreset {
  id: DialerPresetId;
  /** Option label in the "Calling app" select. */
  label: string;
  /** Short name for summaries ("Zoho Voice"). */
  short: string;
  /** The `dialerTemplate` this preset stores ('' = the user types a URL). */
  template: string;
  /** Set-up guidance shown under the select. */
  guidance?: string;
}

export const ZOHO_VOICE_GUIDANCE =
  "Install the Zoho Voice desktop app or Chrome extension, enable 'Click to call' and set Zoho Voice as the default app for phone links (Windows: Settings → Apps → Default apps → choose the app for TEL links). Every call from the CRM then dials through Zoho Voice. Turn on call recording in Zoho Voice → Settings. To get call logs, recordings and durations into the CRM automatically, add the CRM's telephony webhook URL (below) in Zoho Voice → Settings → Webhooks/Integrations with provider=zoho, and keep the field map preset below.";

/** One-line reminder for places without room for the full guidance (the Log-a-call dialog). */
export const ZOHO_VOICE_SHORT_HINT = 'Zoho Voice must be the default app for phone links on this computer (Windows: Settings → Apps → Default apps → TEL).';

/**
 * Calling-app presets. System phone and Zoho Voice both dial a `tel:` link — Zoho Voice answers it once it is
 * the default app for phone links — so they store the same template and differ in guidance and labels only.
 */
export const DIALER_PRESETS: ReadonlyArray<DialerPreset> = [
  {
    id: 'system',
    label: 'System phone / default calling app (tel:)',
    short: 'System phone',
    template: DEFAULT_DIALER_TEMPLATE,
    guidance: 'Calls open whichever app this computer uses for phone (tel:) links — for example Phone Link on Windows or iPhone calling on a Mac.',
  },
  { id: 'zoho', label: 'Zoho Voice (desktop app / Chrome extension)', short: 'Zoho Voice', template: DEFAULT_DIALER_TEMPLATE, guidance: ZOHO_VOICE_GUIDANCE },
  { id: 'custom', label: 'Custom URL', short: 'Custom URL', template: '' },
];

export const dialerPreset = (id: DialerPresetId): DialerPreset => DIALER_PRESETS.find((p) => p.id === id) || DIALER_PRESETS[0];

/** UI-preference key (per device) that remembers System phone vs Zoho Voice — both use a tel: template. */
export const DIALER_PRESET_PREF = 'dialerPreset';

/** True for templates that open the tel: handler (blank counts as the default). */
export function isTelTemplate(template: string | undefined | null): boolean {
  const t = String(template || '').trim();
  return !t || /^tel:/i.test(t);
}

/**
 * The calling app in effect: a non-tel template is always a custom URL; a tel: template is Zoho Voice when this
 * device chose it, otherwise the system phone app.
 */
export function resolveDialerPreset(template: string | undefined | null, saved?: string | null): DialerPresetId {
  if (!isTelTemplate(template)) return 'custom';
  return saved === 'zoho' ? 'zoho' : 'system';
}

/** The calling app saved on this device (null when never chosen or storage is unavailable). */
export function loadDialerPreset(): DialerPresetId | null {
  const v = loadUiPref<unknown>(DIALER_PRESET_PREF, null);
  return v === 'system' || v === 'zoho' || v === 'custom' ? v : null;
}

export function saveDialerPreset(id: DialerPresetId): void {
  saveUiPref(DIALER_PRESET_PREF, id);
}

/** Calling app in effect on this device for these settings. */
export function currentDialerPreset(settings: Pick<CRMSettings, 'dialerTemplate'> | undefined): DialerPresetId {
  return resolveDialerPreset(settings?.dialerTemplate, loadDialerPreset());
}

/** Text of the button that starts a call. */
export function dialerCallLabel(preset: DialerPresetId, again = false): string {
  if (preset === 'zoho') return again ? 'Call again via Zoho Voice' : 'Call via Zoho Voice';
  return again ? 'Call again' : 'Start call';
}

/** Where a call goes, in a few words (the Log-a-call dialog). */
export function dialerSummary(preset: DialerPresetId, template?: string | null): string {
  if (preset === 'custom' && !isTelTemplate(template)) return String(template).trim();
  if (preset === 'zoho') return 'Zoho Voice (via phone links)';
  return 'System phone (tel:)';
}

/** A custom dialer URL template: a message explaining what is wrong, or null when it can be used. */
export function validateDialerTemplate(template: string | undefined | null): string | null {
  const t = String(template || '').trim();
  if (!t) return 'Enter the link your calling app opens, with {phone} where the number goes.';
  if (UNSAFE_DIALER_SCHEME.test(t)) return 'That type of link cannot be used to place calls.';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) return 'Start with the app’s link scheme, for example zohovoice://, callto: or https://.';
  if (!/\{(phone|digits)\}/.test(t)) return 'Add {phone} (+91…) or {digits} (91…) where the number goes.';
  return null;
}

/**
 * Dialer link for a phone number. A tel: template (the default, also used by the Zoho Voice preset) uses `telLink`;
 * a custom template (e.g. `zohovoice://call?phone={phone}`) is filled with the E.164 number (`{phone}` = +91…,
 * `{digits}` = 91…). Unsafe schemes fall back to the tel: link.
 */
export function dialerHref(settings: Pick<CRMSettings, 'dialerTemplate'> | undefined, phone: string): string {
  const tpl = String(settings?.dialerTemplate || '').trim();
  const e164 = toE164Digits(phone);
  if (!e164) return '#';
  if (isTelTemplate(tpl) || UNSAFE_DIALER_SCHEME.test(tpl)) return telLink(phone);
  return fillTemplate(tpl, { phone: `+${e164}`, digits: e164 });
}

/* ------------------------------------------------------------------------ */
/* Telephony webhook field map                                               */
/* ------------------------------------------------------------------------ */

/** The keys the telephony webhook reads from a provider payload. */
export const TELEPHONY_FIELD_KEYS = ['callId', 'from', 'to', 'direction', 'startTime', 'endTime', 'duration', 'recordingUrl', 'status'] as const;
export type TelephonyFieldKey = (typeof TELEPHONY_FIELD_KEYS)[number];
export type TelephonyFieldMap = Readonly<Record<TelephonyFieldKey, string>>;

/** The backend's default map (used when the setting is blank). */
export const DEFAULT_TELEPHONY_FIELD_MAP: TelephonyFieldMap = {
  callId: 'call_id', from: 'from', to: 'to', direction: 'direction', startTime: 'start_time', endTime: 'end_time', duration: 'duration', recordingUrl: 'recording_url', status: 'status',
};

/** Zoho Voice call-log field names — a starting point to check against the payload Zoho Voice actually sends. */
export const ZOHO_VOICE_FIELD_MAP: TelephonyFieldMap = {
  callId: 'call_id', from: 'caller_number', to: 'callee_number', direction: 'call_type', startTime: 'start_time', endTime: 'end_time', duration: 'duration', recordingUrl: 'recording_url', status: 'call_status',
};

/** A field map as the pretty JSON the settings editor shows. */
export const fieldMapJson = (map: TelephonyFieldMap): string => JSON.stringify(map, null, 2);

/** The telephony webhook URL with `provider=` set (the backend shows it as `provider=<name>`). */
export function telephonyUrlForProvider(url: string | undefined | null, provider: string): string {
  const u = String(url || '').trim();
  if (!u) return '';
  const p = encodeURIComponent(provider);
  const re = /([?&])provider=[^&#]*/i;
  if (re.test(u)) return u.replace(re, `$1provider=${p}`);
  return `${u}${u.includes('?') ? '&' : '?'}provider=${p}`;
}

/* ------------------------------------------------------------------------ */
/* Phone → enquiry matching (unlinked calls)                                 */
/* ------------------------------------------------------------------------ */

/** The enquiry an unlinked call most likely belongs to. */
export interface CallMatch {
  leadId: string;
  name: string;
  stage: string;
  rm: string;
  unitType: string;
  phone: string;
  /** 'server' = suggested by getCalls (matchedLeadId); 'phone' = same number as an enquiry loaded in the app. */
  via: 'server' | 'phone';
}

/** Enquiries by the last 10 digits of their phone number (first one wins; trashed and deleted enquiries are skipped). */
export function leadsByPhone(leads: Lead[]): Map<string, Lead> {
  const m = new Map<string, Lead>();
  for (const l of leads) {
    const stage = String(l[F.STAGE] || '');
    if (stage === STAGES.TRASH || stage === STAGES.DELETED) continue;
    const key = last10(l[F.PHONE]);
    if (key.length === 10 && !m.has(key)) m.set(key, l);
  }
  return m;
}

const matchFromLead = (l: Lead, via: CallMatch['via']): CallMatch => ({
  leadId: String(l[F.ID] || ''),
  name: String(l[F.NAME] || ''),
  stage: String(l[F.STAGE] || ''),
  rm: String(l[F.RM] || ''),
  unitType: String(l[F.UNIT_TYPE] || ''),
  phone: String(l[F.PHONE] || ''),
  via,
});

/**
 * For a call without an enquiry: the backend's suggestion (matchedLeadId — enriched from the loaded lead when there
 * is one), else an enquiry in `byPhone` with the same number. Linked calls and unmatched numbers return null.
 */
export function matchForCall(call: CallRecord, leadById: Map<string, Lead>, byPhone: Map<string, Lead>): CallMatch | null {
  if (!call || String(call.leadId || '').trim()) return null;
  const suggested = String(call.matchedLeadId || '').trim();
  if (suggested) {
    const l = leadById.get(suggested);
    if (l) return matchFromLead(l, 'server');
    return {
      leadId: suggested,
      name: String(call.matchedName || ''),
      stage: String(call.matchedStage || ''),
      rm: String(call.matchedRM || ''),
      unitType: '',
      phone: String(call.phone || ''),
      via: 'server',
    };
  }
  const key = last10(call.phone);
  if (key.length !== 10) return null;
  const l = byPhone.get(key);
  return l ? matchFromLead(l, 'phone') : null;
}

/** The `updateCall` patch that links a call to an enquiry (keeps the call's own name and number when it has them). */
export function linkPatch(call: Pick<CallRecord, 'customerName' | 'phone'>, target: Pick<CallMatch, 'leadId' | 'name' | 'phone'>): Pick<CallRecord, 'leadId' | 'customerName' | 'phone'> {
  return {
    leadId: target.leadId,
    customerName: String(call.customerName || '').trim() || target.name,
    phone: String(call.phone || '').trim() || target.phone,
  };
}

/** Accept common audio containers + a few video ones that carry call recordings. */
export const RECORDING_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.webm,.amr,.3gp,.mp4';

export function guessMime(file: File): string {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', amr: 'audio/amr', '3gp': 'audio/3gpp', mp4: 'audio/mp4' };
  return map[ext] || 'application/octet-stream';
}
