/**
 * Calling app (dialer) presets and the telephony field-map presets — callsUtils.
 * System phone and Zoho Voice both dial a tel: link (Zoho Voice answers it as the default app for phone links);
 * the choice between them is a device preference, a non-tel template is always a custom URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DIALER_TEMPLATE,
  DEFAULT_TELEPHONY_FIELD_MAP,
  DIALER_PRESETS,
  DIALER_PRESET_PREF,
  TELEPHONY_FIELD_KEYS,
  ZOHO_VOICE_FIELD_MAP,
  ZOHO_VOICE_GUIDANCE,
  currentDialerPreset,
  dialerCallLabel,
  dialerHref,
  dialerPreset,
  dialerSummary,
  fieldMapJson,
  isTelTemplate,
  loadDialerPreset,
  resolveDialerPreset,
  saveDialerPreset,
  telephonyUrlForProvider,
  validateDialerTemplate,
} from '../src/modules/calls/callsUtils';
import { STORAGE_KEYS } from '../src/core/config';

/** Minimal in-memory localStorage for the device-preference helpers. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('DIALER_PRESETS', () => {
  it('offers System phone, Zoho Voice and Custom URL — in that order, with the agreed labels', () => {
    expect(DIALER_PRESETS.map((p) => p.id)).toEqual(['system', 'zoho', 'custom']);
    expect(dialerPreset('system').label).toBe('System phone / default calling app (tel:)');
    expect(dialerPreset('zoho').label).toBe('Zoho Voice (desktop app / Chrome extension)');
    expect(dialerPreset('custom').label).toBe('Custom URL');
  });

  it('System phone and Zoho Voice both store tel:{phone}; Custom is typed by the user', () => {
    expect(DEFAULT_DIALER_TEMPLATE).toBe('tel:{phone}');
    expect(dialerPreset('system').template).toBe('tel:{phone}');
    expect(dialerPreset('zoho').template).toBe('tel:{phone}');
    expect(dialerPreset('custom').template).toBe('');
  });

  it('Zoho Voice carries the set-up guidance (default app for TEL links, recording, webhook with provider=zoho)', () => {
    const g = dialerPreset('zoho').guidance || '';
    expect(g).toBe(ZOHO_VOICE_GUIDANCE);
    expect(g).toContain('Install the Zoho Voice desktop app or Chrome extension');
    expect(g).toContain("enable 'Click to call'");
    expect(g).toContain('Windows: Settings → Apps → Default apps → choose the app for TEL links');
    expect(g).toContain('Turn on call recording in Zoho Voice → Settings');
    expect(g).toContain('provider=zoho');
    expect(g).toContain('field map preset below');
  });

  it('falls back to System phone for an unknown id', () => {
    expect(dialerPreset('nope' as never).id).toBe('system');
  });
});

describe('resolveDialerPreset / isTelTemplate', () => {
  it('treats blank and tel: templates as tel', () => {
    expect(isTelTemplate('')).toBe(true);
    expect(isTelTemplate(undefined)).toBe(true);
    expect(isTelTemplate('tel:{phone}')).toBe(true);
    expect(isTelTemplate('TEL:+{digits}')).toBe(true);
    expect(isTelTemplate('zohovoice://call?phone={phone}')).toBe(false);
  });

  it('a tel: template is Zoho Voice only when this device chose it', () => {
    expect(resolveDialerPreset('tel:{phone}', 'zoho')).toBe('zoho');
    expect(resolveDialerPreset('tel:{phone}', 'system')).toBe('system');
    expect(resolveDialerPreset('tel:{phone}', null)).toBe('system');
    expect(resolveDialerPreset('', 'zoho')).toBe('zoho');
    // "custom" saved but the template went back to tel: → nothing custom is in effect
    expect(resolveDialerPreset('tel:{phone}', 'custom')).toBe('system');
  });

  it('a non-tel template is always the custom URL, whatever was saved', () => {
    expect(resolveDialerPreset('zohovoice://call?phone={phone}', 'zoho')).toBe('custom');
    expect(resolveDialerPreset('callto:{phone}', null)).toBe('custom');
  });
});

describe('device preference (UI prefs in localStorage)', () => {
  it('round-trips the chosen preset and drives currentDialerPreset', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(loadDialerPreset()).toBeNull();
    expect(currentDialerPreset({ dialerTemplate: 'tel:{phone}' })).toBe('system');
    saveDialerPreset('zoho');
    expect(loadDialerPreset()).toBe('zoho');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.UI_PREFS) || '{}')[DIALER_PRESET_PREF]).toBe('zoho');
    expect(currentDialerPreset({ dialerTemplate: 'tel:{phone}' })).toBe('zoho');
    expect(currentDialerPreset({ dialerTemplate: 'zohovoice://call?phone={phone}' })).toBe('custom');
  });

  it('ignores junk values and works without storage (private mode / node)', () => {
    const store = memoryStorage();
    store.setItem(STORAGE_KEYS.UI_PREFS, JSON.stringify({ [DIALER_PRESET_PREF]: 'skype' }));
    vi.stubGlobal('localStorage', store);
    expect(loadDialerPreset()).toBeNull();
    vi.unstubAllGlobals();
    expect(loadDialerPreset()).toBeNull();
    expect(() => saveDialerPreset('zoho')).not.toThrow();
  });
});

describe('labels', () => {
  it('the call button says "Call via Zoho Voice" for the Zoho Voice preset', () => {
    expect(dialerCallLabel('zoho')).toBe('Call via Zoho Voice');
    expect(dialerCallLabel('zoho', true)).toBe('Call again via Zoho Voice');
    expect(dialerCallLabel('system')).toBe('Start call');
    expect(dialerCallLabel('system', true)).toBe('Call again');
    expect(dialerCallLabel('custom')).toBe('Start call');
  });

  it('summarises where the call goes', () => {
    expect(dialerSummary('system', 'tel:{phone}')).toBe('System phone (tel:)');
    expect(dialerSummary('zoho', 'tel:{phone}')).toBe('Zoho Voice (via phone links)');
    expect(dialerSummary('custom', 'zohovoice://call?phone={phone}')).toBe('zohovoice://call?phone={phone}');
    expect(dialerSummary('custom', 'tel:{phone}')).toBe('System phone (tel:)');
  });
});

describe('validateDialerTemplate', () => {
  it('accepts app links and web dialler addresses with a number placeholder', () => {
    expect(validateDialerTemplate('zohovoice://call?phone={phone}')).toBeNull();
    expect(validateDialerTemplate('callto:{phone}')).toBeNull();
    expect(validateDialerTemplate('https://voice.example.com/dial?n={digits}')).toBeNull();
  });

  it('explains what is missing', () => {
    expect(validateDialerTemplate('')).toMatch(/\{phone\}/);
    expect(validateDialerTemplate('zohovoice://call')).toMatch(/\{phone\}.*\{digits\}/);
    expect(validateDialerTemplate('call me on {phone}')).toMatch(/link scheme/);
  });

  it('refuses script and data links', () => {
    expect(validateDialerTemplate('javascript:alert({phone})')).toMatch(/cannot be used/);
    expect(validateDialerTemplate(' data:text/html,{phone}')).toMatch(/cannot be used/);
    expect(validateDialerTemplate('vbscript:{phone}')).toMatch(/cannot be used/);
  });
});

describe('dialerHref', () => {
  it('tel: templates (System phone and Zoho Voice) give a tel:+91 link', () => {
    expect(dialerHref({ dialerTemplate: 'tel:{phone}' }, '98490 12345')).toBe('tel:+919849012345');
    expect(dialerHref({ dialerTemplate: '' }, '+91 98490 12345')).toBe('tel:+919849012345');
    expect(dialerHref(undefined, '09849012345')).toBe('tel:+919849012345');
  });

  it('fills a custom template with {phone} (+E.164) or {digits}', () => {
    expect(dialerHref({ dialerTemplate: 'zohovoice://call?phone={phone}' }, '9849012345')).toBe('zohovoice://call?phone=+919849012345');
    expect(dialerHref({ dialerTemplate: 'https://dial.example/?n={digits}' }, '9849012345')).toBe('https://dial.example/?n=919849012345');
  });

  it('never opens an unsafe scheme, and returns # without a number', () => {
    expect(dialerHref({ dialerTemplate: 'javascript:alert("{phone}")' }, '9849012345')).toBe('tel:+919849012345');
    expect(dialerHref({ dialerTemplate: 'tel:{phone}' }, '')).toBe('#');
  });
});

describe('telephony field maps', () => {
  it('the Zoho Voice preset maps every key the webhook reads to Zoho call-log names', () => {
    expect(Object.keys(ZOHO_VOICE_FIELD_MAP).sort()).toEqual([...TELEPHONY_FIELD_KEYS].sort());
    expect(ZOHO_VOICE_FIELD_MAP).toEqual({
      callId: 'call_id',
      from: 'caller_number',
      to: 'callee_number',
      direction: 'call_type',
      startTime: 'start_time',
      endTime: 'end_time',
      duration: 'duration',
      recordingUrl: 'recording_url',
      status: 'call_status',
    });
  });

  it('the default map covers the same keys and pretty-prints as JSON the settings editor accepts', () => {
    expect(Object.keys(DEFAULT_TELEPHONY_FIELD_MAP).sort()).toEqual([...TELEPHONY_FIELD_KEYS].sort());
    const json = fieldMapJson(ZOHO_VOICE_FIELD_MAP);
    expect(json).toContain('\n  "from": "caller_number"');
    expect(JSON.parse(json)).toEqual(ZOHO_VOICE_FIELD_MAP);
  });
});

describe('telephonyUrlForProvider', () => {
  const base = 'https://script.google.com/macros/s/AKfy/exec?source=telephony&secret=abc123';

  it('replaces the provider=<name> placeholder the backend shows', () => {
    expect(telephonyUrlForProvider(`${base}&provider=<name>`, 'zoho')).toBe(`${base}&provider=zoho`);
    expect(telephonyUrlForProvider(`${base}&provider=exotel`, 'zoho')).toBe(`${base}&provider=zoho`);
  });

  it('adds provider= when it is missing, and leaves an empty URL empty', () => {
    expect(telephonyUrlForProvider(base, 'zoho')).toBe(`${base}&provider=zoho`);
    expect(telephonyUrlForProvider('https://x.example/exec', 'zoho')).toBe('https://x.example/exec?provider=zoho');
    expect(telephonyUrlForProvider('', 'zoho')).toBe('');
    expect(telephonyUrlForProvider(undefined, 'zoho')).toBe('');
  });
});
