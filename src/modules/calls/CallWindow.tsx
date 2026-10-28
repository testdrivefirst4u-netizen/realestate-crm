/**
 * The call window: a phone-style card over the CRM that follows the signed-in user's JustConnect calls.
 *  - incoming: pops up while their phone rings, with who it is (lead, stage, unit, last remark, next follow-up) or
 *    "New caller" with Create lead;
 *  - outgoing: "Ringing your phone…" → "Calling Meera…" → "On call · 02:14" → "Call ended";
 *  - after the call: the outcome (also filed in JustConnect) and, once the recording is in, the AI summary and
 *    Hot / Warm / Cold.
 * The talking happens on the phone inside the CRM (softphone.ts, with a headset) when it is on, else on the JustConnect
 * app or mobile; either way the window has the live buttons (CallControls: answer, end, transfer, mute, hold).
 *
 * Two sources, merged: jcMyCall (JustConnect's call events saved by the webhook — the only way to see incoming calls)
 * asked every few seconds while the CRM is on screen, and the CRM's own click-to-call progress (callWindowStore),
 * which works even before the webhook is set up.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Loader2, Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, Sparkles, UserPlus, X } from 'lucide-react';
import { api, type MyCall } from '../../core/api';
import { F } from '../../core/config';
import { followupEntries, nextFollowupDate } from '../../core/analytics';
import { formatDateTime } from '../../core/dates';
import { formatPhone, last10, samePhone, telLink } from '../../core/phone';
import { Button, cx } from '../../components/ui';
import { JcOutcomeForm } from '../leads/detail/CallsTab';
import type { Lead } from '../../types/crm';
import { outgoingCall, useOutgoingCall, type OutgoingCall } from './callWindowStore';
import { startJustConnectCall } from './CallButton';
import { CallControls } from './CallControls';
import { useSoftphone, type SipCall, type SoftphoneSnapshot } from './softphone';

/** How often the CRM asks "is my phone ringing?" while it is on screen — and while a call is going on. */
const IDLE_POLL_MS = 5000;
const ACTIVE_POLL_MS = 3000;
/** After a call: wait this long for the AI summary. */
const AI_POLL_MS = 6000;
const AI_WAIT_MS = 4 * 60000;

type Stage = 'incoming' | 'ringing-you' | 'calling' | 'live' | 'ended' | 'missed' | 'failed';

interface View {
  key: string;
  stage: Stage;
  direction: 'Inbound' | 'Outbound';
  phone: string;
  name: string;
  leadId: string;
  startedAt: number;
  /** the timer counts from here (calling / live) */
  since?: number;
  durationSec?: number;
  message?: string;
  mode?: 'app' | 'mobile';
  /** the CRM's saved call, once there is one (outcome, AI) */
  call?: MyCall;
  /** the call on the phone inside the CRM */
  sip?: SipCall;
}

const ms = (iso: string) => (iso ? new Date(iso).getTime() : 0);

/** JustConnect's saved call for the CRM's own outgoing call: the same number, started with it or after. */
const sameCall = (c: MyCall | null | undefined, o: OutgoingCall | null) => !!c && !!o && samePhone(c.phone, o.phone) && ms(c.startTime) >= o.startedAt - 60_000;

/** How long a call that ended on the phone here stays on screen when the CRM has not received it (no call events). */
const SIP_ENDED_SHOW_MS = 2 * 60_000;

function fromSip(s: SipCall, server: MyCall | null): View {
  // JustConnect's saved call for the same conversation: transfer works on it, and it carries the lead
  const match = server && server.phase !== 'ended' && samePhone(server.phone, s.phone) ? server : undefined;
  return {
    key: `sip-${s.id}`,
    stage: s.state === 'ringing' ? 'incoming' : s.state === 'live' ? 'live' : 'calling',
    direction: s.direction,
    phone: s.phone,
    name: s.name || match?.customerName || '',
    leadId: s.leadId || match?.leadId || '',
    startedAt: s.startedAt,
    since: s.answeredAt,
    call: match,
    sip: s,
  };
}

function fromSipEnded(e: NonNullable<SoftphoneSnapshot['ended']>): View {
  return {
    key: `sip-${e.id}`,
    stage: e.answered ? 'ended' : 'missed',
    direction: e.direction,
    phone: e.phone,
    name: e.name,
    leadId: e.leadId,
    startedAt: e.at,
    durationSec: e.durationSec,
    message: e.answered ? undefined : e.direction === 'Inbound' ? 'Missed call' : 'Not answered',
  };
}

function fromServer(c: MyCall, out: OutgoingCall | null): View {
  const base = { key: c.id, direction: c.direction, phone: c.phone, name: c.customerName, leadId: c.leadId, startedAt: ms(c.startTime) || Date.now(), call: c };
  if (c.phase === 'ended') {
    const done = c.status === 'Completed';
    return { ...base, stage: done ? 'ended' : 'missed', durationSec: c.durationSec, message: done ? undefined : c.direction === 'Inbound' ? 'Missed call' : c.status === 'Busy' ? 'Busy' : 'Not answered' };
  }
  if (c.phase === 'live') return { ...base, stage: 'live', since: ms(c.answeredAt) || Date.now() };
  if (c.direction === 'Inbound') return { ...base, stage: 'incoming' };
  const same = out && samePhone(out.phone, c.phone);
  if (same && out!.stage === 'ringing-you') return { ...base, stage: 'ringing-you', mode: out!.mode };
  return { ...base, stage: 'calling', since: same ? out!.pickedUpAt : undefined };
}

function fromOutgoing(o: OutgoingCall): View {
  const base = { key: `out-${o.key}`, direction: 'Outbound' as const, phone: o.phone, name: o.name, leadId: o.leadId || '', startedAt: o.startedAt, mode: o.mode, message: o.message };
  switch (o.stage) {
    case 'ringing-you': return { ...base, stage: 'ringing-you' };
    case 'calling': return { ...base, stage: 'calling', since: o.pickedUpAt };
    case 'connected': return { ...base, stage: 'live', since: o.connectedAt };
    case 'ended': return { ...base, stage: 'ended', durationSec: o.talkSeconds };
    default: return { ...base, stage: 'failed' };
  }
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const minutes = (sec?: number) => (!sec ? '' : sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '#';

const TEMP_CLS: Record<string, string> = {
  Hot: 'bg-[#FDECEC] text-[#B42318] border-[#F6C9C5]',
  Warm: 'bg-[#FFF4E5] text-[#B54708] border-[#F8DDB4]',
  Cold: 'bg-[#EAF3FB] text-[#0B5E9C] border-[#C9DFF1]',
};

export const CallWindow: React.FC<{
  /** JustConnect connected, and this user takes calls (not view-only). */
  enabled: boolean;
  leads: Lead[];
  onOpenLead: (id: string) => void;
  onCreateLead: (phone: string) => void;
  onRemark: (leadId: string, text: string) => Promise<unknown>;
}> = ({ enabled, leads, onOpenLead, onCreateLead, onRemark }) => {
  const out = useOutgoingCall();
  const sp = useSoftphone();
  const [server, setServer] = useState<MyCall | null>(null);
  /** An ended call stays on screen (outcome, AI summary) until it is closed. */
  const [kept, setKept] = useState<MyCall | null>(null);
  const [closed, setClosed] = useState<{ keys: Set<string>; phone: string; at: number }>({ keys: new Set(), phone: '', at: 0 });
  const [minimised, setMinimised] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /* --------------------------- "is my phone ringing?" --------------------------- */

  /** Calls this user ended (or handed on) from the window: not shown as in progress while JustConnect catches up. */
  const endedHere = useRef(new Set<string>());
  const stillOpen = (r: MyCall | null) => (r && r.phase !== 'ended' && endedHere.current.has(r.id) ? null : r);
  const serverRef = useRef(server);
  serverRef.current = server;
  /** The call is over for this user now; JustConnect's own "ended" (with the real figures) replaces this when it arrives. */
  const endLocally = useCallback((cur: MyCall) => {
    if (cur.phase === 'ended') return;
    endedHere.current.add(cur.id);
    const answered = cur.phase === 'live';
    setKept({ ...cur, phase: 'ended', status: answered ? 'Completed' : 'Missed', durationSec: answered && cur.answeredAt ? Math.round((Date.now() - ms(cur.answeredAt)) / 1000) : 0, aiPending: answered });
    setServer(null);
  }, []);

  // hung up on the phone here: the saved call for it is over too (do not show it as "On call" until JustConnect says so)
  const sipEndedAt = sp.ended?.at;
  useEffect(() => {
    const cur = serverRef.current;
    if (sipEndedAt && sp.ended && cur && samePhone(cur.phone, sp.ended.phone)) endLocally(cur);
  }, [sipEndedAt, endLocally]);

  const outActive = !!out && !['ended', 'failed'].includes(out.stage);
  const serverActive = (!!server && server.phase !== 'ended') || !!sp.call;
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === 'visible') {
        try {
          const r = await api.justconnect.myCall();
          if (stop) return;
          setServer(stillOpen(r));
          if (r?.phase === 'ended') setKept((k) => (k?.id === r.id ? { ...k, ...r } : r));
        } catch {
          /* offline / signed out: try again next time */
        }
      }
      timer = setTimeout(tick, outActive || serverActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, outActive, serverActive]);

  // an ended call: keep asking for it until the AI summary is in
  const keptId = kept?.id;
  const keptWaiting = !!kept?.aiPending && !kept.aiSummary;
  useEffect(() => {
    if (!enabled || !keptId || !keptWaiting) return;
    const until = Date.now() + AI_WAIT_MS;
    const t = setInterval(async () => {
      if (Date.now() > until) return clearInterval(t);
      try {
        const r = await api.justconnect.myCall(keptId);
        if (r) setKept((k) => (k?.id === r.id ? r : k));
      } catch {
        /* next time */
      }
    }, AI_POLL_MS);
    return () => clearInterval(t);
  }, [enabled, keptId, keptWaiting]);

  // JustConnect says the call is over (seconds after it ends): the CRM's own call follower stops right away
  useEffect(() => {
    if (out && outActive && kept && sameCall(kept, out)) outgoingCall.update(out.key, { stage: 'ended', endedAt: Date.now(), talkSeconds: kept.durationSec || undefined });
  }, [out, outActive, kept]);

  /** Ask again now (after End / Transfer), instead of waiting for the next check. */
  const refreshNow = useCallback(async () => {
    try {
      const r = await api.justconnect.myCall();
      setServer(stillOpen(r));
      if (r?.phase === 'ended') setKept((k) => (k?.id === r.id ? { ...k, ...r } : r));
    } catch {
      /* the next check picks it up */
    }
  }, []);

  /** After End / Transfer through JustConnect: the call is over for this user — show it now, then fetch the saved call. */
  const afterControl = useCallback((action: 'end' | 'transfer' | 'mute' | 'unmute', callId?: string) => {
    if (action !== 'end' && action !== 'transfer') return;
    const o = outgoingCall.get();
    if (o && !['ended', 'failed'].includes(o.stage)) outgoingCall.update(o.key, { stage: 'ended', endedAt: Date.now() });
    const cur = serverRef.current;
    if (callId && cur?.id === callId) endLocally(cur);
    void refreshNow();
    setTimeout(() => void refreshNow(), 1500); // JustConnect's "ended" event follows a moment later
  }, [refreshNow]);

  // an outgoing call ended before JustConnect's events arrived (no webhook yet): fetch it from JustConnect
  const linkTried = useRef(0);
  useEffect(() => {
    if (!enabled || !out || out.stage !== 'ended' || linkTried.current === out.key) return;
    linkTried.current = out.key;
    const phone = out.phone;
    void (async () => {
      await new Promise((r) => setTimeout(r, 4000)); // JustConnect files the call a moment after it ends
      try {
        await api.justconnect.syncCalls();
        const r = await api.justconnect.myCall();
        if (r && r.phase === 'ended' && samePhone(r.phone, phone)) setKept(r);
      } catch {
        /* the window still offers a remark */
      }
    })();
  }, [enabled, out]);

  /* --------------------------------- which call --------------------------------- */

  const view: View | null = useMemo(() => {
    const isClosed = (v: View) => closed.keys.has(v.key) || (!!closed.phone && last10(v.phone) === closed.phone && v.startedAt <= closed.at);
    const candidates: View[] = [];
    // the phone inside the CRM first: it has the Answer button
    if (sp.call) candidates.push(fromSip(sp.call, server));
    if (server && server.phase !== 'ended') candidates.push(fromServer(server, out));
    // the CRM's own progress until the saved call says more (and while it is still ringing you)
    // (JustConnect's saved call wins once it has ended: the CRM's own progress check can lag behind it)
    if (out && !sameCall(kept, out)) candidates.push(fromOutgoing(out));
    if (kept) candidates.push(fromServer(kept, null));
    // ended on the phone here, and the CRM has not received the call (yet)
    if (sp.ended && !(kept && samePhone(kept.phone, sp.ended.phone)) && Date.now() - sp.ended.at < SIP_ENDED_SHOW_MS) candidates.push(fromSipEnded(sp.ended));
    return candidates.find((v) => !isClosed(v)) || null;
  }, [server, out, kept, closed, sp.call, sp.ended]);

  const ticking = !!view && (view.stage === 'live' || view.stage === 'calling') && !!view.since;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // a new call (or a new ring) opens the window again
  const lastKey = useRef('');
  useEffect(() => {
    const k = view ? `${view.key}:${view.stage === 'incoming' ? 'ring' : ''}` : '';
    if (k && k !== lastKey.current) {
      if (view!.stage === 'incoming' || !lastKey.current.startsWith(view!.key)) setMinimised(false);
      lastKey.current = k;
    }
  }, [view]);

  const close = useCallback(() => {
    if (!view) return;
    setClosed((c) => ({ keys: new Set([...c.keys, view.key, ...(view.call ? [view.call.id] : [])]), phone: last10(view.phone), at: Date.now() }));
    if (out && (view.key === `out-${out.key}` || samePhone(out.phone, view.phone))) outgoingCall.clear(out.key);
    if (kept && kept.id === view.key) setKept(null);
  }, [view, out, kept]);

  const lead = useMemo(() => {
    if (!view) return null;
    return (view.leadId && leads.find((l) => l[F.ID] === view.leadId)) || leads.find((l) => samePhone(String(l[F.PHONE] || ''), view.phone)) || null;
  }, [view, leads]);

  if (!enabled && !out) return null;
  if (!view) return null;

  const name = (lead && String(lead[F.NAME] || '')) || view.name || (view.phone ? formatPhone(view.phone) : 'Customer');
  const timer = view.since ? clock((now - view.since) / 1000) : '';
  const ringing = view.stage === 'incoming' || view.stage === 'ringing-you' || (view.stage === 'calling' && !view.since);
  const over = view.stage === 'ended' || view.stage === 'missed' || view.stage === 'failed';

  const label = view.stage === 'incoming' ? 'Incoming call'
    : over ? (view.stage === 'missed' ? (view.direction === 'Inbound' ? 'Missed call' : 'Call not answered') : view.stage === 'failed' ? 'Call not made' : 'Call ended')
    : view.direction === 'Inbound' ? 'Incoming call' : 'Outgoing call';
  const status = view.stage === 'incoming' ? (view.sip ? 'Ringing here — answer with your headset' : 'Ringing on your JustConnect phone')
    : view.sip?.held ? `On hold · ${timer || '00:00'}`
    : view.sip && view.stage === 'calling' ? `Calling ${name.split(' ')[0]}…`
    : view.stage === 'ringing-you' ? `Answer your ${view.mode === 'mobile' ? 'mobile' : 'JustConnect app'} — then ${lead || view.name ? name.split(' ')[0] : 'the customer'} is called`
    : view.stage === 'calling' ? `Calling ${name.split(' ')[0]}…${timer ? ` · ${timer}` : ''}`
    : view.stage === 'live' ? `On call · ${timer || '00:00'}`
    : view.stage === 'ended' ? (view.durationSec ? `Talked ${minutes(view.durationSec)}` : 'Call over')
    : view.message || '';
  const LabelIcon = view.stage === 'missed' ? PhoneMissed : view.stage === 'failed' ? PhoneOff : view.direction === 'Inbound' ? PhoneIncoming : PhoneOutgoing;

  if (minimised) {
    return (
      <button
        type="button"
        onClick={() => setMinimised(false)}
        className="fixed z-60 right-4 bottom-24 lg:bottom-5 h-12 pl-3 pr-4 rounded-full bg-[#0A1F33] text-white shadow-[0_12px_32px_-8px_rgba(10,31,51,0.6)] flex items-center gap-2.5 max-w-[calc(100vw-2rem)]"
        aria-label={`${label}: ${name}. Show the call window`}
      >
        <span className={cx('h-2.5 w-2.5 rounded-full flex-none', over ? 'bg-[#8FA9BF]' : ringing ? 'bg-[#F5B544] animate-pulse' : 'bg-[#3BD17F]')} />
        <span className="text-[13px] font-semibold truncate">{name}</span>
        {(timer || over) && <span className="text-[12px] tabular-nums text-[#B9D4EA]">{over ? label : timer}</span>}
      </button>
    );
  }

  const nextFu = lead ? nextFollowupDate(lead) : null;
  const lastRemark = lead ? followupEntries(lead).slice(-1)[0] : undefined;
  const chips = lead ? [String(lead[F.STAGE] || ''), String(lead[F.UNIT_TYPE] || ''), String(lead[F.SOURCE] || '')].filter(Boolean) : [];
  const c = view.call;

  return (
    <section
      role="dialog"
      aria-label={`${label}: ${name}`}
      aria-live={view.stage === 'incoming' ? 'assertive' : 'polite'}
      className="fixed z-60 right-4 left-4 sm:left-auto bottom-24 lg:bottom-5 sm:w-90 rounded-3xl overflow-hidden bg-white shadow-[0_24px_60px_-12px_rgba(10,31,51,0.55)] border border-[#0A1F33]/10"
    >
      {/* phone-style header */}
      <div className="relative bg-linear-to-br from-[#0A1F33] via-[#0B2A44] to-[#0B4A7A] text-white px-5 pt-3.5 pb-5">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#B9D4EA]">
            <LabelIcon size={12} />{label}
          </span>
          <div className="flex items-center gap-0.5 -mr-1.5">
            <button type="button" onClick={() => setMinimised(true)} className="h-8 w-8 grid place-items-center rounded-full text-[#B9D4EA] hover:bg-white/10" aria-label="Make small"><ChevronDown size={16} /></button>
            {/* a call on the phone here cannot be closed away: only made small (End hangs up) */}
            {!(view.sip && !over) && <button type="button" onClick={close} className="h-8 w-8 grid place-items-center rounded-full text-[#B9D4EA] hover:bg-white/10" aria-label="Close"><X size={15} /></button>}
          </div>
        </div>
        <div className="flex flex-col items-center text-center mt-2">
          <div className="relative h-17 w-17">
            {ringing && <span className="absolute inset-0 rounded-full bg-[#3BA0E6]/40 animate-ping" />}
            <span className={cx('relative h-full w-full rounded-full grid place-items-center text-xl font-bold ring-4', over ? 'bg-[#1E3A52] ring-white/10 text-[#B9D4EA]' : 'bg-[#0B6BB0] ring-white/15')}>
              {lead || view.name ? initials(name) : <Phone size={24} />}
            </span>
          </div>
          <div className="mt-2.5 text-lg font-bold leading-tight max-w-full truncate">{name}</div>
          {view.phone && (lead || view.name) && <div className="text-[12px] text-[#B9D4EA] tabular-nums">{formatPhone(view.phone)}</div>}
          <div className={cx('mt-1.5 text-[13px] font-medium tabular-nums inline-flex items-center gap-1.5', view.stage === 'live' ? 'text-[#7DE3AC]' : 'text-white/90')}>
            {view.stage === 'live' && <span className="h-2 w-2 rounded-full bg-[#3BD17F] animate-pulse" />}
            {status}
          </div>
        </div>
        {!over && (view.sip || (c && c.phase !== 'ended')) && <CallControls sip={view.sip || null} call={c && c.phase !== 'ended' ? c : undefined} live={view.stage === 'live'} onChanged={afterControl} />}
      </div>

      {/* who it is, and what to do */}
      <div className="px-4 py-3.5 space-y-3 max-h-[min(60vh,440px)] overflow-y-auto">
        {lead ? (
          <div className="space-y-1.5">
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {chips.map((t, i) => (
                  <span key={i} className={cx('text-[11px] font-semibold px-2 py-0.5 rounded-full border', i === 0 && TEMP_CLS[t] ? TEMP_CLS[t] : 'bg-[#F2F7FB] text-[#2B4A63] border-[#DCE8F2]')}>{t}</span>
                ))}
                {lead[F.RM] && <span className="text-[11px] text-[#5E778C] px-1 py-0.5">RM {String(lead[F.RM])}</span>}
              </div>
            )}
            {lastRemark && <p className="text-[12px] text-[#2B4A63] leading-snug line-clamp-2"><span className="font-semibold text-[#0B2A44]">Last remark:</span> {lastRemark.text}</p>}
            {nextFu && <p className="text-[12px] text-[#5E778C]"><span className="font-semibold text-[#0B2A44]">Next follow-up:</span> {formatDateTime(nextFu)}</p>}
          </div>
        ) : view.phone ? (
          <p className="text-[12.5px] text-[#5E778C]">{view.direction === 'Inbound' ? 'New caller' : 'This number'} — not in the CRM yet.</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {lead ? (
            <Button variant="primary" size="sm" icon={<ExternalLink size={13} />} onClick={() => { onOpenLead(String(lead[F.ID])); setMinimised(true); }}>Open lead</Button>
          ) : view.phone ? (
            <Button variant="primary" size="sm" icon={<UserPlus size={13} />} onClick={() => { onCreateLead(view.phone); setMinimised(true); }}>Create lead</Button>
          ) : null}
          {view.stage === 'failed' && view.phone && (
            <>
              <Button variant="secondary" size="sm" icon={<Phone size={13} />} onClick={() => void startJustConnectCall({ leadId: view.leadId || undefined, phone: view.phone, name })}>Try again</Button>
              <a href={telLink(view.phone)} className="inline-flex items-center h-8 px-3 rounded-lg text-[12px] font-semibold text-[#0B5E9C] hover:bg-[#F2F7FB]">Call from this phone</a>
            </>
          )}
          {view.stage === 'missed' && view.direction === 'Inbound' && view.phone && (
            <Button variant="secondary" size="sm" icon={<PhoneOutgoing size={13} />} onClick={() => void startJustConnectCall({ leadId: lead ? String(lead[F.ID]) : undefined, phone: view.phone, name })}>Call back</Button>
          )}
        </div>

        {!over && (
          <p className="text-[11px] text-[#7E93A6] leading-relaxed">
            {view.sip ? 'You talk here, on your headset.' : view.stage === 'incoming' ? 'Pick up on your JustConnect app or mobile.' : 'You talk on your phone.'} The CRM saves the call, the recording and the AI notes by itself.
          </p>
        )}

        {/* after the call */}
        {over && c && c.status !== 'In Progress' && (view.stage === 'ended' || view.stage === 'missed') && (
          <div className="space-y-2.5 pt-1 border-t border-[#EEF4F9]">
            <div className="pt-2.5">
              {c.outcome ? (
                <p className="text-[12px] text-[#2B4A63] mb-1.5"><span className="font-semibold text-[#0B2A44]">Outcome:</span> {c.outcome}{c.notes ? ` — ${c.notes}` : ''}</p>
              ) : (
                <p className="text-[12px] font-semibold text-[#0B2A44] mb-1.5">How did it go?</p>
              )}
              <JcOutcomeForm key={c.id} call={{ id: c.id, outcome: c.outcome }} startOpen={!c.outcome} onSaved={() => void api.justconnect.myCall(c.id).then((r) => r && setKept(r)).catch(() => undefined)} />
            </div>
            {c.aiSummary ? (
              <div className="rounded-xl bg-[#F5F9FC] border border-[#E6EFF6] p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="text-[#0B6BB0]" />
                  <span className="text-[12px] font-bold text-[#0B2A44]">AI summary</span>
                  {c.aiTemperature && <span className={cx('text-[11px] font-semibold px-2 py-0.5 rounded-full border', TEMP_CLS[c.aiTemperature] || TEMP_CLS.Cold)}>{c.aiTemperature}</span>}
                </div>
                <p className="text-[12px] text-[#2B4A63] leading-relaxed line-clamp-6">{c.aiSummary}</p>
                {c.aiTemperatureReason && <p className="text-[11px] text-[#5E778C]">{c.aiTemperatureReason}</p>}
              </div>
            ) : c.aiPending ? (
              <p className="text-[12px] text-[#5E778C] inline-flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" />AI summary on its way — it appears here and on the lead.</p>
            ) : null}
          </div>
        )}
        {view.stage === 'ended' && !c && lead && <QuickRemark onSave={(t) => onRemark(String(lead[F.ID]), t)} />}
      </div>
    </section>
  );
};

/** After a call the CRM has not received yet (no call events): a remark on the lead straight away. */
const QuickRemark: React.FC<{ onSave: (text: string) => Promise<unknown> }> = ({ onSave }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <p className="text-[12px] text-[#067647] font-semibold">Remark saved on the lead.</p>;
  return (
    <form
      className="flex gap-2 pt-2.5 border-t border-[#EEF4F9]"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setSaving(true);
        try {
          await onSave(`Call · ${text.trim()}`);
          setDone(true);
        } catch {
          /* the engine shows the error */
        }
        setSaving(false);
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="How did it go? (saved as a remark)" maxLength={2000} aria-label="Remark" className="flex-1 min-w-0 text-[12px] px-2.5 py-1.5 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44]" />
      <Button type="submit" variant="primary" size="xs" loading={saving} disabled={!text.trim()}>Save</Button>
    </form>
  );
};
