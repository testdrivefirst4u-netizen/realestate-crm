/**
 * The buttons on a call in progress, in the call window's header.
 *  - On the phone inside the CRM: Answer / Decline while it rings; then Mute, Hold, Keypad, Transfer and End — mute
 *    and hold are the phone's own, End hangs up here.
 *  - On the JustConnect app or a mobile: End, Mute and Transfer through JustConnect's live call control
 *    (calls:control), on the CRM's saved call. Answering stays on that phone.
 * Transfer hands the customer to a colleague (who must be online) or an outside number.
 */
import React, { useEffect, useState } from 'react';
import { ArrowRightLeft, Grid3x3, Loader2, Mic, MicOff, Pause, Phone, PhoneOff, Play } from 'lucide-react';
import { api, type MyCall } from '../../core/api';
import { toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { cx } from '../../components/ui';
import { softphone, type SipCall } from './softphone';

const RoundButton: React.FC<{ label: string; onClick: () => void; tone?: 'plain' | 'on' | 'red' | 'green'; big?: boolean; disabled?: boolean; busy?: boolean; children: React.ReactNode }> = ({ label, onClick, tone = 'plain', big, disabled, busy, children }) => (
  <button type="button" onClick={onClick} disabled={disabled || busy} aria-label={label} title={label} className="flex flex-col items-center gap-1 disabled:opacity-45">
    <span
      className={cx(
        'grid place-items-center rounded-full transition',
        big ? 'h-14 w-14' : 'h-11 w-11',
        tone === 'red' ? 'bg-[#E5484D] text-white hover:bg-[#D13B40]'
          : tone === 'green' ? 'bg-[#22A06B] text-white hover:bg-[#1B8A5B]'
          : tone === 'on' ? 'bg-white text-[#0B2A44]'
          : 'bg-white/12 text-white hover:bg-white/20',
      )}
    >
      {busy ? <Loader2 size={big ? 22 : 18} className="animate-spin" /> : children}
    </span>
    <span className="text-[10.5px] font-semibold text-[#B9D4EA]">{label}</span>
  </button>
);

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export const CallControls: React.FC<{
  /** the call on the phone inside the CRM, when it is there */
  sip: SipCall | null;
  /** the CRM's saved call (from JustConnect's events): needed for transfer, and for the buttons on other phones */
  call?: MyCall;
  /** the call is answered (talking) */
  live: boolean;
}> = ({ sip, call, live }) => {
  const [busy, setBusy] = useState('');
  const [muted, setMuted] = useState(!!call?.muted);
  const [panel, setPanel] = useState<'' | 'transfer' | 'keypad'>('');
  useEffect(() => setMuted(!!call?.muted), [call?.id, call?.muted]);

  const control = async (action: 'end' | 'mute' | 'unmute') => {
    if (!call) return;
    setBusy(action);
    try {
      const r = await api.justconnect.control(call.id, action);
      if (r.muted !== undefined) setMuted(r.muted);
    } catch (e) {
      toast(action === 'end' ? 'Call not ended' : 'Mute not changed', toAppError(e).userMessage, 'alert');
    }
    setBusy('');
  };

  // ringing on the phone here
  if (sip?.state === 'ringing') {
    return (
      <div className="mt-4 flex items-start justify-center gap-10">
        <RoundButton label="Decline" tone="red" big onClick={() => softphone.hangup()}><PhoneOff size={22} /></RoundButton>
        <RoundButton label="Answer" tone="green" big onClick={() => softphone.answer()}><Phone size={22} /></RoundButton>
      </div>
    );
  }

  const canTransfer = !!call && (live || call.direction === 'Inbound');
  return (
    <>
      <div className="mt-4 flex items-start justify-center gap-3.5">
        {sip ? (
          <>
            <RoundButton label={sip.muted ? 'Unmute' : 'Mute'} tone={sip.muted ? 'on' : 'plain'} disabled={sip.state !== 'live'} onClick={() => softphone.toggleMute()}>{sip.muted ? <MicOff size={18} /> : <Mic size={18} />}</RoundButton>
            <RoundButton label={sip.held ? 'Resume' : 'Hold'} tone={sip.held ? 'on' : 'plain'} disabled={sip.state !== 'live'} onClick={() => softphone.toggleHold()}>{sip.held ? <Play size={18} /> : <Pause size={18} />}</RoundButton>
            <RoundButton label="Keypad" tone={panel === 'keypad' ? 'on' : 'plain'} disabled={sip.state !== 'live'} onClick={() => setPanel((p) => (p === 'keypad' ? '' : 'keypad'))}><Grid3x3 size={18} /></RoundButton>
          </>
        ) : (
          call && live && (
            <RoundButton label={muted ? 'Unmute' : 'Mute'} tone={muted ? 'on' : 'plain'} busy={busy === 'mute' || busy === 'unmute'} onClick={() => void control(muted ? 'unmute' : 'mute')}>{muted ? <MicOff size={18} /> : <Mic size={18} />}</RoundButton>
          )
        )}
        {call && (
          <RoundButton label="Transfer" tone={panel === 'transfer' ? 'on' : 'plain'} disabled={!canTransfer} onClick={() => setPanel((p) => (p === 'transfer' ? '' : 'transfer'))}><ArrowRightLeft size={18} /></RoundButton>
        )}
        {(sip || call) && (
          <RoundButton label="End" tone="red" busy={busy === 'end'} onClick={() => (sip ? softphone.hangup() : void control('end'))}><PhoneOff size={18} /></RoundButton>
        )}
      </div>
      {panel === 'keypad' && sip && (
        <div className="mt-3 grid grid-cols-3 gap-1.5 max-w-[210px] mx-auto">
          {KEYS.map((k) => (
            <button key={k} type="button" onClick={() => softphone.dtmf(k)} className="h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[15px] font-semibold tabular-nums">{k}</button>
          ))}
        </div>
      )}
      {panel === 'transfer' && call && <TransferPanel callId={call.id} onDone={() => setPanel('')} />}
    </>
  );
};

const TransferPanel: React.FC<{ callId: string; onDone: () => void }> = ({ callId, onDone }) => {
  const [targets, setTargets] = useState<Array<{ id: string; name: string; extension: string; status: string }> | null>(null);
  const [error, setError] = useState('');
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let stop = false;
    api.justconnect.transferTargets().then((t) => !stop && setTargets(t)).catch((e) => !stop && setError(toAppError(e).userMessage));
    return () => {
      stop = true;
    };
  }, []);

  const send = async (target: string) => {
    if (!target.trim()) return;
    setSending(true);
    try {
      const r = await api.justconnect.control(callId, 'transfer', target.trim());
      toast('Call transferred', `The customer is going to ${r.to || target}.`, 'success');
      onDone();
    } catch (e) {
      toast('Call not transferred', toAppError(e).userMessage, 'alert');
    }
    setSending(false);
  };

  return (
    <div className="mt-3 rounded-2xl bg-white text-[#0B2A44] p-3 space-y-2 text-left">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#7E93A6]">Transfer to</div>
      {error ? <p className="text-[12px] text-[#B42318]">{error}</p> : !targets ? (
        <p className="text-[12px] text-[#7E93A6] inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />Loading colleagues…</p>
      ) : targets.length === 0 ? (
        <p className="text-[12px] text-[#7E93A6]">No colleagues on JustConnect.</p>
      ) : (
        <ul className="max-h-36 overflow-y-auto -mx-1">
          {targets.map((t) => {
            const free = t.status === 'online';
            return (
              <li key={t.id}>
                <button type="button" disabled={!free || sending} onClick={() => void send(t.extension || t.id)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-[#F2F7FB] disabled:opacity-50 disabled:hover:bg-transparent">
                  <span className={cx('h-2 w-2 rounded-full flex-none', free ? 'bg-[#22A06B]' : t.status === 'on-call' ? 'bg-[#E5484D]' : t.status === 'offline' ? 'bg-[#A9BDCD]' : 'bg-[#F5B544]')} />
                  <span className="text-[12.5px] font-semibold truncate flex-1">{t.name}</span>
                  <span className="text-[11px] text-[#7E93A6]">{free ? `ext ${t.extension}` : t.status === 'on-call' ? 'On a call' : t.status === 'offline' ? 'Offline' : 'On a break'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void send(to); }}>
        <input value={to} onChange={(e) => setTo(e.target.value)} inputMode="tel" placeholder="Or a 10-digit number" aria-label="Number to transfer to" className="flex-1 min-w-0 h-8 px-2.5 rounded-lg border border-[#A9BDCD] text-[12px] tabular-nums" />
        <button type="submit" disabled={sending || !to.trim()} className="h-8 px-3 rounded-lg bg-[#0B6BB0] text-white text-[12px] font-bold disabled:opacity-50">{sending ? <Loader2 size={13} className="animate-spin" /> : 'Send'}</button>
      </form>
    </div>
  );
};
