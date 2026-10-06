/**
 * Zoho Voice in the UI (server render — no DOM, effects do not run):
 * the Log-a-call dialog's call button and calling-app switch, and Settings → Integrations → Telephony
 * (calling-app presets with guidance, the Zoho Voice field-map preset, "Copy for Zoho Voice").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LogCallModal } from '../src/modules/calls/LogCallModal';
import { IntegrationsSection } from '../src/modules/settings/IntegrationsSection';
import { saveDialerPreset } from '../src/modules/calls/callsUtils';
import { DEFAULT_SETTINGS } from '../src/core/config';
import type { CRMSettings } from '../src/types/crm';

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

const settings = (dialerTemplate = 'tel:{phone}'): CRMSettings => ({ ...DEFAULT_SETTINGS, dialerTemplate });

const renderModal = (s: CRMSettings) =>
  renderToStaticMarkup(createElement(LogCallModal, { open: true, leads: [], settings: s, currentUser: null, onClose: () => {}, onLogged: () => {}, onOpenLead: () => {} }));

afterEach(() => vi.unstubAllGlobals());

describe('Log a call — calling app', () => {
  it('says "Call via Zoho Voice" when this device chose Zoho Voice', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    saveDialerPreset('zoho');
    const html = renderModal(settings());
    expect(html).toContain('Call via Zoho Voice');
    expect(html).not.toContain('>Start call<');
    expect(html).toContain('<option value="zoho" selected="">Zoho Voice</option>');
    expect(html).toContain('default app for phone links');
  });

  it('keeps "Start call" for the system phone app (and when nothing was chosen)', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const html = renderModal(settings());
    expect(html).toContain('Start call');
    expect(html).not.toContain('Call via Zoho Voice');
    expect(html).toContain('<option value="system" selected="">System phone (tel:)</option>');
  });

  it('shows a custom dialler link read-only, pointing to Settings', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    saveDialerPreset('zoho'); // a custom template wins over the saved preset
    const html = renderModal(settings('zohovoice://call?phone={phone}'));
    expect(html).toContain('Start call');
    expect(html).toContain('zohovoice://call?phone={phone}');
    expect(html).toContain('Settings → Integrations → Telephony');
    expect(html).not.toContain('aria-label="Calling app"');
  });
});

describe('Settings → Integrations → Telephony', () => {
  const serverSettings = {
    telephonyWebhookSecretSet: true,
    telephonyWebhookUrl: 'https://script.google.com/macros/s/AKfy/exec?source=telephony&secret=abc&provider=<name>',
  };
  const render = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(IntegrationsSection, {
        settings: settings(),
        serverSettings,
        currentUser: null,
        can: () => true,
        onApplyServerSettings: () => {},
        rmOptions: [],
        ...extra,
      })
    );

  it('offers the calling-app presets, with Custom URL once local settings can be saved', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const withoutWriter = render();
    expect(withoutWriter).toContain('Calling app (this device)');
    expect(withoutWriter).toContain('System phone / default calling app (tel:)');
    expect(withoutWriter).toContain('Zoho Voice (desktop app / Chrome extension)');
    expect(withoutWriter).not.toContain('>Custom URL<');

    const withWriter = render({ onUpdateLocalSettings: () => {} });
    expect(withWriter).toContain('>Custom URL<');
  });

  it('shows a custom link set on this device; editable only when local settings can be saved', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const custom = { settings: settings('callto:{phone}') };
    const locked = render(custom);
    expect(locked).toContain('Custom link in use');
    expect(locked).toContain('callto:{phone}');
    expect(locked).toMatch(/<select[^>]*disabled=""[^>]*aria-label="Calling app"/);

    const editable = render({ ...custom, onUpdateLocalSettings: () => {} });
    expect(editable).toContain('Custom link');
    expect(editable).toContain('value="callto:{phone}"');
    expect(editable).not.toMatch(/<select[^>]*disabled=""[^>]*aria-label="Calling app"/);
  });

  it('shows the Zoho Voice set-up steps when Zoho Voice is chosen on this device', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    saveDialerPreset('zoho');
    const html = render();
    expect(html).toContain('<option value="zoho" selected="">');
    expect(html).toContain('Set up Zoho Voice');
    expect(html).toContain('Turn on call recording in Zoho Voice → Settings.');
    expect(html).toContain('Every call from the CRM then dials through Zoho Voice.');
  });

  it('has the Zoho Voice field-map preset and a provider=zoho copy button next to the webhook URL', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const html = render();
    expect(html).toContain('Zoho Voice preset');
    expect(html).toContain('Copy for Zoho Voice');
    expect(html).toContain('Field map (JSON)');
  });

  it('hides the field-map preset from roles that cannot edit settings', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const html = render({ can: (p: string) => p !== 'settings.edit' && p !== 'secrets.manage' });
    expect(html).not.toContain('Zoho Voice preset');
    // The calling app is a device setting — still available
    expect(html).toContain('Calling app (this device)');
  });
});
