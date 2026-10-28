/**
 * The phone inside the CRM: the signed-in user's JustConnect phone login, registered from this browser with JsSIP
 * (SIP over JustConnect's secure WebSocket, audio only). Calls ring here, are answered with a headset, held and muted
 * like on any phone, while JustConnect still routes, records and logs them (the call events reach the CRM as before).
 *
 * The login comes from the CRM server for this user only (jcMyPhone) and lives in memory: never saved in the browser.
 * One tab runs the phone (a Web Lock), so two CRM tabs do not take both of the agent's device slots. Whether the phone
 * is on is remembered per browser, so it comes back after a reload.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { last10 } from '../../core/phone';

export type PhoneState = 'off' | 'connecting' | 'ready' | 'elsewhere' | 'error';

export interface SipCall {
  id: string;
  direction: 'Inbound' | 'Outbound';
  phone: string;
  name: string;
  leadId: string;
  /** ringing: an incoming call rings here; connecting: an outgoing call is being put through; live: talking */
  state: 'ringing' | 'connecting' | 'live';
  startedAt: number;
  answeredAt?: number;
  muted: boolean;
  held: boolean;
}

export interface SoftphoneSnapshot {
  state: PhoneState;
  error: string;
  extension: string;
  call: SipCall | null;
  /** the call that just ended here (for the call window, until the CRM's saved call arrives) */
  ended: (Pick<SipCall, 'id' | 'direction' | 'phone' | 'name' | 'leadId'> & { at: number; durationSec: number; answered: boolean }) | null;
}

const PREF_KEY = 'crm.softphone';
/** The guide: no STUN/TURN; do not wait for ICE gathering longer than about half a second. */
const ICE_WAIT_MS = 500;
const MEDIA = { audio: true, video: false };
const PC_CONFIG: RTCConfiguration = { iceServers: [] };

let snap: SoftphoneSnapshot = { state: 'off', error: '', extension: '', call: null, ended: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<SoftphoneSnapshot>) => {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
};
const setCall = (patch: Partial<SipCall>) => {
  if (snap.call) set({ call: { ...snap.call, ...patch } });
};

let ua: any = null;
let session: any = null;
let domain = '';
let releaseLock: (() => void) | null = null;
let starting = false;

/* ------------------------------- audio: the other side, and the ring ------------------------------- */

let remoteAudio: HTMLAudioElement | null = null;
function playRemote(stream: MediaStream) {
  if (!remoteAudio) {
    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute('aria-hidden', 'true');
    document.body.appendChild(remoteAudio);
  }
  remoteAudio.srcObject = stream;
  void remoteAudio.play().catch(() => undefined);
}
function attachPeer(pc: RTCPeerConnection | undefined) {
  if (!pc) return;
  pc.addEventListener('track', (e: RTCTrackEvent) => {
    if (e.streams[0]) playRemote(e.streams[0]);
    else playRemote(new MediaStream([e.track]));
  });
}

let audioCtx: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | null = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    /* no Web Audio: the call window still shows the call */
  }
}
function ringOnce() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.0001;
  gain.connect(audioCtx.destination);
  for (const f of [440, 480]) {
    const o = audioCtx.createOscillator();
    o.frequency.value = f;
    o.connect(gain);
    o.start(t0);
    o.stop(t0 + 1.6);
  }
  gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05);
  gain.gain.setValueAtTime(0.12, t0 + 1.45);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
}
function startRing() {
  stopRing();
  ringOnce();
  ringTimer = setInterval(ringOnce, 3500);
}
function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

/* ------------------------------------------- calls ------------------------------------------- */

const callerPhone = (s: any): string => {
  const user = String(s?.remote_identity?.uri?.user || '');
  const d = user.replace(/\D/g, '');
  return d.length >= 10 ? last10(d) : user;
};

function follow(s: any, call: SipCall) {
  session = s;
  set({ call, ended: null });
  if (s.connection) attachPeer(s.connection);
  s.on('peerconnection', (e: any) => attachPeer(e.peerconnection));
  // the guide: no STUN/TURN, so a short ICE wait is enough
  let iceTimer: ReturnType<typeof setTimeout> | null = null;
  s.on('icecandidate', (e: any) => {
    if (!iceTimer) iceTimer = setTimeout(() => e.ready(), ICE_WAIT_MS);
  });
  s.on('accepted', () => {
    stopRing();
    setCall({ state: 'live', answeredAt: Date.now() });
  });
  s.on('confirmed', () => {
    if (snap.call && snap.call.state !== 'live') setCall({ state: 'live', answeredAt: Date.now() });
  });
  s.on('hold', () => setCall({ held: true }));
  s.on('unhold', () => setCall({ held: false }));
  s.on('muted', () => setCall({ muted: true }));
  s.on('unmuted', () => setCall({ muted: false }));
  const done = () => {
    stopRing();
    if (session !== s) return;
    const c = snap.call;
    session = null;
    set({
      call: null,
      ended: c ? { id: c.id, direction: c.direction, phone: c.phone, name: c.name, leadId: c.leadId, at: Date.now(), answered: !!c.answeredAt, durationSec: c.answeredAt ? Math.round((Date.now() - c.answeredAt) / 1000) : 0 } : null,
    });
  };
  s.on('ended', done);
  s.on('failed', done);
}

function onNewSession(e: any) {
  const s = e.session;
  if (e.originator !== 'remote') return; // our own calls are followed in dial()
  if (session) {
    s.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); // already on a call here
    return;
  }
  follow(s, {
    id: String(s.id || Date.now()),
    direction: 'Inbound',
    phone: callerPhone(s),
    name: String(s.remote_identity?.display_name || ''),
    leadId: '',
    state: 'ringing',
    startedAt: Date.now(),
    muted: false,
    held: false,
  });
  startRing();
}

/* -------------------------------------- switching it on / off -------------------------------------- */

const savePref = (on: boolean) => {
  try {
    if (on) localStorage.setItem(PREF_KEY, 'on');
    else localStorage.removeItem(PREF_KEY);
  } catch {
    /* private window: the phone just does not come back after a reload */
  }
};
export const softphonePref = (): boolean => {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
};

/** Hold the one-tab lock while the phone runs. Resolves false when another CRM tab already has the phone. */
function takeLock(): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : null;
  if (!locks?.request) return Promise.resolve(true);
  return new Promise((resolve) => {
    void locks.request('crm-softphone', { ifAvailable: true }, (lock: unknown) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      return new Promise<void>((release) => {
        releaseLock = release;
      });
    });
  });
}

function shutdown() {
  stopRing();
  try {
    session?.terminate();
  } catch {
    /* already over */
  }
  session = null;
  try {
    ua?.stop();
  } catch {
    /* already stopped */
  }
  ua = null;
  releaseLock?.();
  releaseLock = null;
}

export const softphone = {
  get: () => snap,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },

  /** Switch the phone on (from a click: it also unlocks the ring sound and asks for the microphone). */
  async start(opts: { fromClick?: boolean } = {}) {
    if (starting || ua) return;
    starting = true;
    if (opts.fromClick) unlockAudio();
    set({ state: 'connecting', error: '' });
    try {
      if (!(await takeLock())) {
        set({ state: 'elsewhere', error: 'The CRM phone is on in another tab of this browser.' });
        return;
      }
      // ask for the microphone now, so the first call does not stop on the browser's question
      try {
        const m = await navigator.mediaDevices.getUserMedia({ audio: true });
        m.getTracks().forEach((t) => t.stop());
      } catch {
        throw new Error('The browser did not allow the microphone. Allow it for this site (the lock icon in the address bar) and switch the phone on again.');
      }
      const login = await api.justconnect.myPhone();
      const mod: any = await import('jssip'); // loaded only when the phone is switched on
      const JsSIP = mod.UA ? mod : mod.default;
      domain = login.domain;
      const socket = new JsSIP.WebSocketInterface(login.websocketUrl);
      const agent = new JsSIP.UA({
        sockets: [socket],
        uri: login.uri,
        authorization_user: login.username || undefined,
        password: login.password,
        display_name: login.displayName,
        register: true,
        session_timers: false,
        user_agent: 'CRM phone',
      } as any);
      ua = agent;
      agent.on('registered', () => set({ state: 'ready', error: '', extension: login.extension }));
      agent.on('unregistered', () => {
        if (ua === agent) set({ state: 'connecting' });
      });
      agent.on('disconnected', () => {
        if (ua === agent && snap.state === 'ready') set({ state: 'connecting', error: 'Reconnecting to JustConnect…' });
      });
      agent.on('registrationFailed', (e: any) => {
        if (ua !== agent) return;
        const code = e?.response?.status_code;
        set({ state: 'error', error: code === 401 || code === 403 ? 'JustConnect refused the phone login. Switch the phone off and on again; if it keeps failing, ask the JustConnect owner to check your agent.' : 'Could not connect the phone to JustConnect. It keeps trying — check the internet connection.' });
      });
      agent.on('newRTCSession', onNewSession);
      agent.start();
      savePref(true);
    } catch (e) {
      shutdown();
      set({ state: 'error', error: e instanceof Error && !(e as any).code ? e.message : toAppError(e).userMessage });
    } finally {
      starting = false;
    }
  },

  stop() {
    savePref(false);
    shutdown();
    set({ state: 'off', error: '', call: null });
  },

  /** Ready to take and make calls here. */
  ready: () => snap.state === 'ready' && !!ua,

  answer() {
    unlockAudio();
    stopRing();
    if (!session || snap.call?.state !== 'ringing') return;
    setCall({ state: 'connecting' });
    session.answer({ mediaConstraints: MEDIA, pcConfig: PC_CONFIG });
  },

  /** Decline a ringing call, or end the one in progress. */
  hangup() {
    stopRing();
    try {
      session?.terminate();
    } catch {
      /* already over */
    }
  },

  toggleMute() {
    if (!session || snap.call?.state !== 'live') return;
    if (session.isMuted()?.audio) session.unmute({ audio: true });
    else session.mute({ audio: true });
  },

  toggleHold() {
    if (!session || snap.call?.state !== 'live') return;
    if (session.isOnHold()?.local) session.unhold();
    else session.hold();
  },

  dtmf(tone: string) {
    if (session && snap.call?.state === 'live' && /^[0-9*#]$/.test(tone)) session.sendDTMF(tone);
  },

  /** Call a 10-digit number (or a colleague's extension) from the phone here. */
  dial(number: string, meta: { name?: string; leadId?: string } = {}): boolean {
    unlockAudio();
    if (!ua || snap.state !== 'ready' || session) return false;
    const raw = String(number || '').replace(/[^\d]/g, '');
    const target = raw.length >= 10 ? last10(raw) : raw;
    if (!target) return false;
    const s = ua.call(`sip:${target}@${domain}`, { mediaConstraints: MEDIA, pcConfig: PC_CONFIG, rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false } });
    follow(s, { id: String(s.id || Date.now()), direction: 'Outbound', phone: target, name: meta.name || '', leadId: meta.leadId || '', state: 'connecting', startedAt: Date.now(), muted: false, held: false });
    return true;
  },

  clearEnded() {
    if (snap.ended) set({ ended: null });
  },
};

if (typeof window !== 'undefined') {
  // the first click anywhere lets the ring sound play (browsers block sound before one)
  window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  // closing the tab signs the phone out, so calls stop ringing a browser that is gone
  window.addEventListener('pagehide', () => {
    if (ua) shutdown();
  });
}

export function useSoftphone(): SoftphoneSnapshot {
  return useSyncExternalStore(softphone.subscribe, softphone.get, softphone.get);
}
