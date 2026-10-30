/**
 * Sign out after an hour without activity. Activity = clicks, typing, scrolling, touches — in any tab of the CRM
 * (shared through localStorage), not background refreshes. A minute before, a warning offers "Stay signed in".
 * The server keeps its own clock (auth.touchSession / validateSession), so a closed laptop is signed out too.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { api } from '../core/api';
import { SIGNED_OUT_REASON_KEY } from '../core/persistence';
import { Button } from './ui';

const IDLE_MS = 60 * 60_000;
const WARN_MS = 60_000;
/** Tell the server at most this often that the person is active (its limit allows for this). */
const TOUCH_EVERY_MS = 2 * 60_000;
const KEY = 'crm.lastActivity';
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

const readShared = () => {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
};

export const IdleLogout: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const last = useRef(Date.now());
  const lastTouch = useRef(Date.now());
  const lastWrite = useRef(0);
  const [left, setLeft] = useState<number | null>(null); // seconds until sign-out while warning

  const active = useCallback((force = false) => {
    const now = Date.now();
    last.current = now;
    if (force || now - lastWrite.current > 10_000) {
      lastWrite.current = now;
      try {
        localStorage.setItem(KEY, String(now));
      } catch {
        /* private mode: this tab still counts */
      }
    }
    if (force || now - lastTouch.current > TOUCH_EVERY_MS) {
      lastTouch.current = now;
      api.auth.touch().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    active(true);
    const onAct = () => active();
    for (const e of EVENTS) window.addEventListener(e, onAct, { passive: true, capture: true });
    const timer = window.setInterval(() => {
      const idle = Date.now() - Math.max(last.current, readShared());
      if (idle >= IDLE_MS) {
        window.clearInterval(timer);
        try {
          sessionStorage.setItem(SIGNED_OUT_REASON_KEY, 'You were signed out after an hour without activity.');
        } catch {
          /* ignore */
        }
        onLogout();
      } else if (idle >= IDLE_MS - WARN_MS) setLeft(Math.ceil((IDLE_MS - idle) / 1000));
      else setLeft(null);
    }, 1000);
    return () => {
      window.clearInterval(timer);
      for (const e of EVENTS) window.removeEventListener(e, onAct, { capture: true } as any);
    };
  }, [active, onLogout]);

  if (left === null) return null;
  return (
    <div className="fixed inset-0 z-[90] bg-[#0B2A44]/50 backdrop-blur-xs flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
      <div className="bg-white rounded-2xl shadow-2xl border border-[#D3E3F0] max-w-sm w-full p-6 text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 text-amber-600 grid place-items-center"><Clock size={24} /></div>
        <h2 id="idle-title" className="mt-3 text-lg font-bold text-[#0B2A44]">Still there?</h2>
        <p className="mt-1 text-sm text-[#5E778C]">
          You have not used the CRM for an hour. For safety you will be signed out in <strong className="text-[#0B2A44] tabular-nums">{left}</strong> second{left === 1 ? '' : 's'}.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="ghost" onClick={onLogout}>Sign out</Button>
          <Button autoFocus onClick={() => { active(true); setLeft(null); }}>Stay signed in</Button>
        </div>
      </div>
    </div>
  );
};
