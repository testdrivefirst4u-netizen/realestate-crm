/**
 * A Call control for a lead: through JustConnect when the company has connected it (the RM's JustConnect phone rings
 * first, then the customer — who sees the business number), otherwise a plain tel: link to the phone's dialer.
 */
import React, { createContext, useContext, useState } from 'react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { telLink } from '../../core/phone';
import { useTenantSettings } from '../../core/tenant';
import { outgoingCall } from './callWindowStore';
import { softphone } from './softphone';

/** The signed-in user's choice (My profile › How Call works), provided once by the app shell. */
const CallViaContext = createContext<'justconnect' | 'direct'>('justconnect');
export const CallViaProvider: React.FC<{ value?: 'justconnect' | 'direct'; children?: React.ReactNode }> = ({ value, children }) => (
  <CallViaContext.Provider value={value === 'direct' ? 'direct' : 'justconnect'}>{children}</CallViaContext.Provider>
);

/** A phone (touch screen, narrow) — where a tel: link really dials. */
const isPhoneDevice = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches && Math.min(window.screen.width, window.screen.height) < 820;

const POLL_MS = 3000;
/** How long your phone may ring before JustConnect gives up on you. */
const POLL_FOR_MS = 60000;
/** After you picked up: follow the call (slower) until it is over, at most this long. */
const FOLLOW_MS = 5000;
const FOLLOW_FOR_MS = 60 * 60000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Follow a call you picked up until it is over, for the call window (talking time, connected, ended). */
async function followCall(key: number, requestId: string, mode: 'app' | 'mobile') {
  const until = Date.now() + FOLLOW_FOR_MS;
  let errors = 0;
  while (Date.now() < until) {
    await wait(FOLLOW_MS);
    const cur = outgoingCall.get();
    if (!cur || cur.key !== key || cur.stage === 'ended' || cur.stage === 'failed') return; // closed, over, or another call started
    let s: { status: string; callStatus: string; talkSeconds: number; connected?: boolean; ended?: boolean };
    try {
      s = await api.justconnect.callStatus(requestId, mode);
      errors = 0;
    } catch {
      if (++errors >= 3) return;
      continue;
    }
    if (s.connected && cur.stage === 'calling') outgoingCall.update(key, { stage: 'connected', connectedAt: Date.now() });
    if (s.ended) {
      outgoingCall.update(key, { stage: 'ended', endedAt: Date.now(), talkSeconds: s.talkSeconds || undefined });
      return;
    }
  }
}

/** Start a JustConnect call and report how it goes (agent ringing → answered / not answered) in the call window. */
export async function startJustConnectCall(d: { leadId?: string; phone?: string; name?: string }): Promise<boolean> {
  // the phone inside the CRM is on: dial from here (JustConnect still shows the business number, records and logs it)
  if (softphone.ready() && d.phone) {
    if (softphone.get().call) {
      toast('Call not started', 'Finish the call in progress first.', 'alert');
      return false;
    }
    return softphone.dial(d.phone, { name: d.name, leadId: d.leadId });
  }
  const who = d.name || d.phone || 'the customer';
  let req: { mode: 'app' | 'mobile'; requestId: string; status: string };
  try {
    req = await api.justconnect.call({ leadId: d.leadId, phone: d.leadId ? undefined : d.phone });
  } catch (e) {
    const err = toAppError(e);
    // JustConnect cannot ring this person (app signed out, no mobile saved): on a phone, dial the customer directly
    if (err.details?.fallback === 'dial' && d.phone && isPhoneDevice()) {
      toast('Calling from your phone', 'JustConnect could not ring you, so your phone dials the customer directly (they see your number). Save your mobile number in My profile to call through JustConnect next time.', 'info');
      window.location.href = telLink(d.phone);
      return true;
    }
    toast('Call not started', err.userMessage, 'alert');
    return false;
  }
  const key = outgoingCall.start({ leadId: d.leadId, phone: d.phone || '', name: d.name || '', mode: req.mode });
  const until = Date.now() + POLL_FOR_MS;
  while (Date.now() < until) {
    await wait(POLL_MS);
    if (outgoingCall.get()?.key !== key) return true; // window closed or another call started
    let s: { status: string; callStatus: string; connected?: boolean };
    try {
      s = await api.justconnect.callStatus(req.requestId, req.mode);
    } catch {
      return true; // the call may well be fine; stop asking
    }
    if (s.status === 'agent-answered') {
      outgoingCall.update(key, s.connected ? { stage: 'connected', pickedUpAt: Date.now(), connectedAt: Date.now() } : { stage: 'calling', pickedUpAt: Date.now() });
      void followCall(key, req.requestId, req.mode);
      return true;
    }
    if (s.status === 'agent-did-not-answer') {
      outgoingCall.update(key, { stage: 'failed', endedAt: Date.now(), message: `You did not answer your ${req.mode === 'app' ? 'JustConnect app' : 'mobile'} in time, so ${who} was not called.` });
      return false;
    }
    if (s.status === 'failed') {
      outgoingCall.update(key, { stage: 'failed', endedAt: Date.now(), message: req.mode === 'app' ? 'JustConnect could not ring your app. Check that it is signed in.' : 'JustConnect could not ring your mobile. Check the number in My profile.' });
      return false;
    }
  }
  return true;
}

export const CallButton: React.FC<{
  phone: string;
  leadId?: string;
  name?: string;
  className?: string;
  title?: string;
  'aria-label'?: string;
  children: React.ReactNode;
}> = ({ phone, leadId, name, className, title, children, ...rest }) => {
  const settings = useTenantSettings() as { justconnectConfigured?: boolean } | null;
  const via = useContext(CallViaContext);
  const [busy, setBusy] = useState(false);
  // direct: the phone's own dialer calls the customer straight away (they see this phone's number)
  if (!settings?.justconnectConfigured || via === 'direct') {
    return <a href={telLink(phone)} className={className} title={title} aria-label={rest['aria-label']} onClick={(e) => e.stopPropagation()}>{children}</a>;
  }
  return (
    <button
      type="button"
      className={className}
      title={title ? `${title} · via JustConnect` : 'Call via JustConnect'}
      aria-label={rest['aria-label']}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        await startJustConnectCall({ leadId, phone, name });
        setBusy(false);
      }}
    >
      {children}
    </button>
  );
};
