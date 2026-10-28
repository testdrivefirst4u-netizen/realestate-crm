/**
 * The phone button in the top bar: switch the phone inside the CRM on or off, say whether you are taking calls
 * (Online / Break / Offline — JustConnect rings only agents who are online), and dial a number. Calls themselves show
 * in the call window.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Coffee, Headset, Loader2, Phone, PhoneOff, Power } from 'lucide-react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { cx } from '../../components/ui';
import { startJustConnectCall } from './CallButton';
import { softphone, softphonePref, useSoftphone } from './softphone';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '0', '⌫'];

const STATUS_OPTIONS: Array<{ id: string; label: string; icon: React.ReactNode }> = [
  { id: 'online', label: 'Online', icon: <Phone size={13} /> },
  { id: 'break', label: 'Break', icon: <Coffee size={13} /> },
  { id: 'offline', label: 'Offline', icon: <PhoneOff size={13} /> },
];
const statusLabel = (s: string) => (s === 'on-call' ? 'On a call' : s === 'lunch' ? 'Lunch' : s === 'bio-break' ? 'Short break' : STATUS_OPTIONS.find((o) => o.id === s)?.label || 'Unknown');

export const PhoneDock: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const phone = useSoftphone();
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<{ name: string; extension: string; status: string; canCallOut: boolean } | null | undefined>(undefined);
  const [statusBusy, setStatusBusy] = useState('');
  const [number, setNumber] = useState('');
  const box = useRef<HTMLDivElement>(null);

  // the phone comes back after a reload when it was on
  useEffect(() => {
    if (enabled && softphonePref()) void softphone.start();
  }, [enabled]);

  useEffect(() => {
    if (!open) return;
    let stop = false;
    api.justconnect.myStatus().then((r) => !stop && setAgent(r.agent)).catch(() => !stop && setAgent(null));
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      stop = true;
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!enabled) return null;

  const setStatus = async (status: string) => {
    setStatusBusy(status);
    try {
      const r = await api.justconnect.setMyStatus(status);
      setAgent((a) => (a ? { ...a, status: r.status } : a));
    } catch (e) {
      toast('Status not changed', toAppError(e).userMessage, 'alert');
    }
    setStatusBusy('');
  };

  const switchOn = async () => {
    await softphone.start({ fromClick: true });
    // working in the CRM: take calls (best effort — needs calls:control on the key)
    if (softphone.ready() || softphone.get().state === 'connecting') {
      api.justconnect.setMyStatus('online').then((r) => setAgent((a) => (a ? { ...a, status: r.status } : a))).catch(() => undefined);
    }
  };

  /** Phone here on: dial from it (a number or an extension). Off: click-to-call — your app / mobile rings, then the number. */
  const dial = async () => {
    const d = number.replace(/\D/g, '');
    if (phone.call) return toast('Call not started', 'Finish the call in progress first.', 'alert');
    if (softphone.ready() ? !d : d.length < 10) return toast('Call not started', softphone.ready() ? 'Type a number or a colleague’s extension.' : 'Type a 10-digit number.', 'alert');
    setOpen(false);
    setNumber('');
    if (softphone.ready()) softphone.dial(d);
    else await startJustConnectCall({ phone: d });
  };

  const on = phone.state !== 'off';
  const dot = phone.state === 'ready' ? (agent?.status && agent.status !== 'online' && agent.status !== 'on-call' ? 'bg-[#F5B544]' : 'bg-[#22A06B]')
    : phone.state === 'connecting' ? 'bg-[#F5B544] animate-pulse'
    : phone.state === 'error' ? 'bg-[#D92D3A]'
    : 'bg-[#A9BDCD]';
  const stateText = phone.state === 'ready' ? `Ready${phone.extension ? ` · ext ${phone.extension}` : ''} — calls ring here`
    : phone.state === 'connecting' ? phone.error || 'Connecting to JustConnect…'
    : phone.state === 'elsewhere' ? phone.error
    : phone.state === 'error' ? phone.error
    : 'Off — calls ring on your JustConnect app or mobile';

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative w-11 h-11 rounded-xl border border-[#D3E3F0] bg-white text-[#0F2233] hover:bg-[#F2F7FB] flex items-center justify-center"
        title="Phone in the CRM"
        aria-label={`Phone in the CRM: ${phone.state === 'ready' ? 'on' : phone.state}`}
        aria-expanded={open}
      >
        <Headset size={18} />
        <span className={cx('absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white', dot)} />
      </button>

      {open && (
        <div role="dialog" aria-label="Phone in the CRM" className="fixed sm:absolute left-4 right-4 sm:left-auto sm:right-0 top-[72px] sm:top-[52px] z-60 sm:w-80 max-h-[calc(100dvh-90px)] overflow-y-auto rounded-2xl bg-white border border-[#DCE8F2] shadow-[0_20px_50px_-12px_rgba(10,31,51,0.4)] p-4 space-y-4">
          {/* on / off */}
          <div className="flex items-start gap-3">
            <span className={cx('mt-0.5 h-9 w-9 flex-none rounded-xl grid place-items-center', on ? 'bg-[#E6F6EE] text-[#067647]' : 'bg-[#F2F7FB] text-[#5E778C]')}><Headset size={17} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-bold text-[#0B2A44]">Phone in the CRM</div>
              <p className={cx('text-[12px] leading-snug', phone.state === 'error' ? 'text-[#B42318]' : 'text-[#5E778C]')}>{stateText}</p>
            </div>
            <button
              type="button"
              onClick={() => (on ? softphone.stop() : void switchOn())}
              disabled={!!phone.call}
              className={cx('flex-none inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-bold border disabled:opacity-50', on ? 'border-[#F6C9C5] text-[#B42318] hover:bg-[#FDECEC]' : 'border-[#0B6BB0] bg-[#0B6BB0] text-white hover:brightness-110')}
            >
              {phone.state === 'connecting' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}{on ? 'Turn off' : 'Turn on'}
            </button>
          </div>

          {/* taking calls */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#7E93A6] mb-1.5">
              Taking calls{agent ? ` · now ${statusLabel(agent.status)}` : ''}
            </div>
            {agent === undefined ? (
              <p className="text-[12px] text-[#7E93A6] inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />Checking…</p>
            ) : agent === null ? (
              <p className="text-[12px] text-[#7E93A6]">You are not linked to a JustConnect agent. Ask your administrator (Settings › WhatsApp, AI &amp; calls › JustConnect).</p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {STATUS_OPTIONS.map((o) => {
                  const cur = agent.status === o.id || (o.id === 'online' && agent.status === 'on-call') || (o.id === 'break' && ['lunch', 'bio-break'].includes(agent.status));
                  return (
                    <button
                      key={o.id}
                      type="button"
                      disabled={!!statusBusy || agent.status === 'on-call'}
                      onClick={() => void setStatus(o.id)}
                      aria-pressed={cur}
                      className={cx('h-9 rounded-lg text-[12px] font-bold inline-flex items-center justify-center gap-1.5 border disabled:opacity-60', cur ? 'bg-[#0B2A44] text-white border-[#0B2A44]' : 'bg-white text-[#2B4A63] border-[#DCE8F2] hover:bg-[#F2F7FB]')}
                    >
                      {statusBusy === o.id ? <Loader2 size={13} className="animate-spin" /> : o.icon}{o.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* dial */}
          {/* dial pad: any number, not only leads */}
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void dial(); }}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#7E93A6]">Dial a number</div>
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/[^\d+\s-]/g, ''))}
              inputMode="tel"
              autoComplete="off"
              placeholder={phone.state === 'ready' ? 'Number or extension' : '10-digit number'}
              aria-label="Number to call"
              className="w-full h-11 px-3 rounded-xl border border-[#A9BDCD] text-[18px] font-semibold text-center text-[#0B2A44] tabular-nums tracking-wider"
            />
            <div className="grid grid-cols-3 gap-1.5">
              {KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setNumber((n) => (k === '⌫' ? n.slice(0, -1) : (n + k).slice(0, 16)))}
                  aria-label={k === '⌫' ? 'Delete' : k}
                  className="h-10 rounded-xl bg-[#F2F7FB] hover:bg-[#E3EEF7] text-[#0B2A44] text-[16px] font-semibold tabular-nums"
                >
                  {k}
                </button>
              ))}
            </div>
            <button type="submit" disabled={!number.trim() || !!phone.call} className="w-full h-11 rounded-xl bg-[#22A06B] hover:bg-[#1B8A5B] text-white text-[14px] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50">
              <Phone size={16} />Call
            </button>
            <p className="text-[11px] text-[#7E93A6] leading-snug">
              {phone.state === 'ready' ? 'Rings from here, on your headset.' : 'Your JustConnect app (or mobile) rings first, then this number.'} The customer sees the business number.
            </p>
          </form>

          <p className="text-[11px] text-[#7E93A6] leading-relaxed">
            Use a headset. While the phone is on, Call buttons in the CRM dial from here, and incoming calls ring here. Use one phone at a time: close the JustConnect app while this is on.
          </p>
        </div>
      )}
    </div>
  );
};
