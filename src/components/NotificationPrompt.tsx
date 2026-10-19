/**
 * Asks once, right in the app, whether this device should get phone notifications (new leads, site visits):
 * "Allow" requests the browser permission and subscribes; "Not now" hides it for a week. On iPhone in a normal
 * Safari tab it first explains Add to Home Screen. A device that already allowed notifications but is not
 * subscribed (new sign-in, cleared data) is subscribed again silently.
 */
import React, { useEffect, useState } from 'react';
import { BellRing, Share, X } from 'lucide-react';
import { api } from '../core/api';
import { toast } from '../core/notifications';
import { isIOS, isStandalone, pushSupported, subscribeDevice } from '../core/pushClient';

const SNOOZE_KEY = 'crm_push_prompt_snoozed_until';
const SNOOZE_DAYS = 7;

const snoozed = () => {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now();
  } catch {
    return false;
  }
};
const snooze = () => {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86400000));
  } catch {
    /* private mode: the prompt simply comes back next time */
  }
};

type Mode = null | 'ask' | 'install';

export const NotificationPrompt: React.FC = () => {
  const [mode, setMode] = useState<Mode>(null);
  const [publicKey, setPublicKey] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (isIOS() && !isStandalone()) {
        // iPhone notifications need the Home Screen app; Safari tabs cannot ask
        if (!snoozed() && 'serviceWorker' in navigator) setMode('install');
        return;
      }
      if (!pushSupported()) return;
      let status;
      try {
        status = await api.push.status();
      } catch {
        return;
      }
      if (!live || !status.configured || !status.publicKey) return;
      setPublicKey(status.publicKey);
      const permission = Notification.permission;
      if (permission === 'granted') {
        // allowed before: (re)register this device for whoever is signed in now — no question asked
        try {
          await api.push.subscribe(await subscribeDevice(status.publicKey));
        } catch {
          /* stays as it is; My profile › Phone notifications shows the details */
        }
        return;
      }
      if (permission === 'default' && !snoozed() && live) setMode('ask');
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!mode) return null;

  const later = () => {
    snooze();
    setMode(null);
  };
  const allow = async () => {
    setBusy(true);
    try {
      await api.push.subscribe(await subscribeDevice(publicKey));
      toast('Notifications are on', 'New leads and site visits will show up on this device.', 'success');
      setMode(null);
    } catch (e) {
      toast('Notifications are off', e instanceof Error ? e.message : 'You can turn them on later in My profile.', 'warning');
      later();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="false" aria-labelledby="push-prompt-title"
      className="fixed z-40 inset-x-3 bottom-[96px] lg:bottom-6 lg:left-auto lg:right-6 lg:w-[380px] animate-in slide-in-from-bottom-2 duration-200">
      <div className="relative rounded-2xl bg-white border border-[#DCE8F2] shadow-[0_18px_40px_-12px_rgba(10,31,51,0.35)] p-4">
        <button type="button" onClick={later} aria-label="Close" className="absolute top-2 right-2 w-9 h-9 rounded-lg flex items-center justify-center text-[#7E93A6] hover:bg-[#F2F7FB] hover:text-[#0A1F33]">
          <X size={16} />
        </button>
        <div className="flex gap-3 pr-6">
          <span className="w-11 h-11 flex-none rounded-xl bg-[#0A1F33] text-[#36B3F2] flex items-center justify-center"><BellRing size={20} /></span>
          <div className="min-w-0">
            <h2 id="push-prompt-title" className="text-[15px] font-bold text-[#0A1F33]">Get new leads on this phone</h2>
            {mode === 'ask' ? (
              <p className="text-[13px] text-[#4E6779] mt-0.5">A notification the moment a lead is assigned to you, and a reminder before site visits. Free, and you can turn it off any time.</p>
            ) : (
              <p className="text-[13px] text-[#4E6779] mt-0.5">
                On iPhone, tap <Share size={13} className="inline -mt-0.5" aria-label="Share" /> <strong>Share</strong> › <strong>Add to Home Screen</strong>, then open the CRM from the new icon to turn notifications on.
              </p>
            )}
          </div>
        </div>
        {mode === 'ask' ? (
          <div className="mt-3.5 grid grid-cols-2 gap-2">
            <button type="button" onClick={later} disabled={busy} className="h-11 rounded-xl border border-[#D3E3F0] bg-white text-[14px] font-semibold text-[#0A1F33] hover:bg-[#F2F7FB] disabled:opacity-60">Not now</button>
            <button type="button" onClick={() => void allow()} disabled={busy} className="h-11 rounded-xl bg-[#0A1F33] text-[14px] font-semibold text-white hover:bg-[#16466E] disabled:opacity-60">{busy ? 'Turning on…' : 'Allow'}</button>
          </div>
        ) : (
          <div className="mt-3.5 flex justify-end">
            <button type="button" onClick={later} className="h-11 px-5 rounded-xl border border-[#D3E3F0] bg-white text-[14px] font-semibold text-[#0A1F33] hover:bg-[#F2F7FB]">Got it</button>
          </div>
        )}
      </div>
    </div>
  );
};
