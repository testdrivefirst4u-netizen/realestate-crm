/**
 * The call window's outgoing call, as the CRM itself follows it (click-to-call progress) — so the window works even
 * before JustConnect's call events reach the CRM. The window (CallWindow) reads it; startJustConnectCall writes it.
 */
import { useSyncExternalStore } from 'react';

export type OutgoingStage =
  /** your JustConnect app / mobile is ringing */
  | 'ringing-you'
  /** you picked up: the customer is being rung (or you are already talking — the click-to-call status cannot tell) */
  | 'calling'
  /** the customer picked up (known for a call bridged to your mobile) */
  | 'connected'
  | 'ended'
  /** never got going: you did not answer, JustConnect could not ring you */
  | 'failed';

export interface OutgoingCall {
  /** new for every call, so a closed window does not hide the next one */
  key: number;
  leadId?: string;
  phone: string;
  name: string;
  mode: 'app' | 'mobile';
  stage: OutgoingStage;
  message?: string;
  startedAt: number;
  /** when you picked up (stage calling) / when the customer did (connected) */
  pickedUpAt?: number;
  connectedAt?: number;
  talkSeconds?: number;
  endedAt?: number;
}

let current: OutgoingCall | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const outgoingCall = {
  get: () => current,
  start(c: Omit<OutgoingCall, 'key' | 'startedAt' | 'stage'>): number {
    current = { ...c, key: Date.now(), startedAt: Date.now(), stage: 'ringing-you' };
    emit();
    return current.key;
  },
  /** Ignored when another call has started since (`key` no longer current). */
  update(key: number, patch: Partial<OutgoingCall>) {
    if (!current || current.key !== key) return;
    current = { ...current, ...patch };
    emit();
  },
  clear(key?: number) {
    if (!current || (key !== undefined && current.key !== key)) return;
    current = null;
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useOutgoingCall(): OutgoingCall | null {
  return useSyncExternalStore(outgoingCall.subscribe, outgoingCall.get, () => null);
}
