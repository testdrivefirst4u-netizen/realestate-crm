import React, { useEffect, useState } from 'react';
import { Check, Copy, Database, KeyRound, Mail, MessageCircle, PhoneCall, RefreshCw, Server, Sparkles, Wand2 } from 'lucide-react';
import { CRMSettings, ServerSettings } from '../../types/crm';
import { api } from '../../core/api';
import { AI_MODELS, AI_TRANSCRIBE_MODEL } from '../../core/config';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, Field, InlineNotice, Select, inputCls, labelCls } from '../../components/ui';
import {
  DEFAULT_DIALER_TEMPLATE, DEFAULT_TELEPHONY_FIELD_MAP, DIALER_PRESETS, DialerPresetId, TELEPHONY_FIELD_KEYS, ZOHO_VOICE_FIELD_MAP, dialerHref, dialerPreset, fieldMapJson, isTelTemplate, loadDialerPreset, resolveDialerPreset, saveDialerPreset,
  telephonyUrlForProvider, validateDialerTemplate,
} from '../calls/callsUtils';
import { SecretKey, SectionBaseProps, ServerSettingsExt } from './types';

export interface IntegrationsSectionProps extends SectionBaseProps {
  rmOptions: string[];
  /**
   * Device-local settings writer (engine.updateLocalSettings, as SyncSection receives it). Needed to save a
   * custom calling-app URL (CRMSettings.dialerTemplate); without it only the System phone / Zoho Voice presets show.
   */
  onUpdateLocalSettings?: (patch: Partial<CRMSettings>) => void;
}

/** Mirrors the server's setting defaults — the backend falls back to these when a field is blank. */
const CHAT360_DEFAULTS = {
  chat360BaseUrl: 'https://api.chat360.io',
  chat360SendPath: '/api/v1/messages/send',
  chat360TemplatePath: '/api/v1/messages/template',
  chat360AuthHeader: 'Authorization',
  chat360AuthPrefix: 'Bearer ',
} as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Telephony field-map keys, the default map and the Zoho Voice preset live in calls/callsUtils (shared with the Calls module).

/** Feature flags stored in the server settings (`features`). */
const FEATURE_TOGGLES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'aiCopilot', label: 'AI Copilot', hint: 'Copilot panel, lead summaries and remark reframing (needs a Gemini key).' },
  { key: 'chat360', label: 'WhatsApp (Chat360)', hint: 'Chat360 inbox in the sidebar and WhatsApp actions on leads.' },
  { key: 'calls', label: 'Call history', hint: 'Calls view, call logging and telephony webhooks.' },
  { key: 'inventorySync', label: 'Inventory sync', hint: 'Live inventory: unit status changes reach every signed-in user on their next sync.' },
];

/* ------------------------------------------------------------------------ */
/* Small building blocks                                                     */
/* ------------------------------------------------------------------------ */

const CopyButton: React.FC<{ value: string; label?: string }> = ({ value, label = 'Copy' }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Copy failed', 'Your browser blocked clipboard access.', 'warning');
    }
  };
  return (
    <Button variant="secondary" size="xs" onClick={copy} icon={copied ? <Check size={11} /> : <Copy size={11} />} disabled={!value}>{copied ? 'Copied' : label}</Button>
  );
};

/**
 * Write-only secret field: the full key is never displayed, only the masked suffix.
 * Keys saved here are stored encrypted on the server, per company. (Each company manages its own keys, so there is
 * no longer an environment-variable lock; `envVar` only names the key.)
 */
const SecretField: React.FC<{
  label: string;
  masked?: string;
  canEdit: boolean;
  envVar: SecretKey;
  placeholder?: string;
  hint?: React.ReactNode;
  onSave: (value: string) => Promise<boolean>;
}> = ({ label, masked, canEdit, envVar, placeholder, hint, onSave }) => {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    const ok = await onSave(value.trim());
    setBusy(false);
    if (ok) setValue('');
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className={`${labelCls} !mb-0`} data-secret={envVar}>{label}</span>
        <span className="text-[11px] font-mono text-[#6B5F57]">{masked ? `Saved: ${masked}` : 'Not set'}</span>
      </div>
      {canEdit ? (
        <div className="flex gap-2">
          <input type="password" className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder || (masked ? 'Paste a new key to replace the saved one' : 'Paste the key')} autoComplete="off" />
          <Button variant="primary" onClick={save} loading={busy} disabled={!value.trim()} icon={<KeyRound size={12} />} className="flex-shrink-0">Save</Button>
        </div>
      ) : (
        <div className="text-[11px] text-[#9E948D]">Only an administrator can change this key.</div>
      )}
      {hint && <div className="text-[10px] text-[#9E948D] mt-1">{hint}</div>}
    </div>
  );
};

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; hint?: string }> = ({ checked, onChange, disabled, label, hint }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className="w-full text-left flex items-start gap-3 p-3 rounded-xl border border-[#D2C9BF] bg-[#F4F0EB] disabled:opacity-70 disabled:cursor-not-allowed hover:border-[#A9825A] transition"
  >
    <span className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition mt-0.5 ${checked ? 'bg-[#7C8B78]' : 'bg-[#D2C9BF]'}`} aria-hidden="true">
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </span>
    <span className="text-xs">
      <span className="font-bold text-[#1D2F3F] block">{label}</span>
      {hint && <span className="text-[11px] text-[#6B5F57]">{hint}</span>}
    </span>
  </button>
);

/** Sentences of a guidance paragraph, as list items. */
const guidanceSteps = (text: string): string[] => text.split(/(?<=\.)\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);

/**
 * Calling app for this device: System phone or Zoho Voice (both dial tel: links — remembered as a device preference)
 * or a custom URL template (CRMSettings.dialerTemplate, saved through `onUpdateLocalSettings`). Not gated on
 * settings.edit: it changes nothing on the server, only what opens on this computer.
 */
export const CallingAppSettings: React.FC<{ settings: CRMSettings; onUpdateLocalSettings?: (patch: Partial<CRMSettings>) => void }> = ({ settings, onUpdateLocalSettings }) => {
  const template = String(settings?.dialerTemplate || '').trim();
  const savedCustom = isTelTemplate(template) ? '' : template;
  const canCustom = !!onUpdateLocalSettings;
  // A custom link this screen cannot change (no settings writer wired) — shown, not editable.
  const locked = !!savedCustom && !canCustom;
  const [savedChoice, setSavedChoice] = useState<DialerPresetId | null>(() => loadDialerPreset());
  const effective = resolveDialerPreset(template, savedChoice);
  const [preset, setPreset] = useState<DialerPresetId>(effective);
  const [customUrl, setCustomUrl] = useState(savedCustom);
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadDialerPreset();
    setSavedChoice(saved);
    setPreset(resolveDialerPreset(template, saved));
    setCustomUrl(isTelTemplate(template) ? '' : template);
    setCustomError(null);
  }, [template]);

  const remember = (id: DialerPresetId) => {
    saveDialerPreset(id);
    setSavedChoice(id);
  };

  const choose = (id: DialerPresetId) => {
    setPreset(id);
    setCustomError(null);
    if (id === 'custom') return; // saved together with the link
    remember(id);
    if (savedCustom && onUpdateLocalSettings) onUpdateLocalSettings({ dialerTemplate: DEFAULT_DIALER_TEMPLATE });
    toast('Calling app saved', id === 'zoho' ? 'Calls from the CRM now go through Zoho Voice on this device.' : 'Calls from the CRM now open this device’s phone app.', 'success');
  };

  const saveCustom = () => {
    const value = customUrl.trim();
    const problem = validateDialerTemplate(value);
    if (problem) {
      setCustomError(problem);
      return;
    }
    if (!onUpdateLocalSettings) return;
    remember('custom');
    onUpdateLocalSettings({ dialerTemplate: value });
    toast('Calling app saved', 'Calls from the CRM now open your custom link on this device.', 'success');
  };

  const options = DIALER_PRESETS.filter((p) => p.id !== 'custom' || canCustom || !!savedCustom).map((p) => ({ value: p.id, label: p.label }));
  const info = dialerPreset(preset);
  const example = preset === 'custom' ? (customUrl.trim() && !validateDialerTemplate(customUrl) ? dialerHref({ dialerTemplate: customUrl.trim() }, '9849012345') : '') : dialerHref({ dialerTemplate: DEFAULT_DIALER_TEMPLATE }, '9849012345');

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs font-bold text-[#1D2F3F]">Calling app</div>
          <div className="text-[11px] text-[#6B5F57]">What opens when you press Start call in the CRM. Saved on this device — each person chooses it on their own computer.</div>
        </div>
        <Badge tone={effective === 'zoho' ? 'gold' : effective === 'custom' ? 'navy' : 'muted'} title="Calling app in use on this device"><PhoneCall size={10} className="mr-1" />{dialerPreset(effective).short}</Badge>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-2">
          <Field label="Calling app (this device)">
            <Select value={preset} onChange={(e) => choose(e.target.value as DialerPresetId)} options={options} disabled={locked} aria-label="Calling app" />
          </Field>
          {preset === 'custom' &&
            (canCustom ? (
              <Field
                label="Custom link"
                hint={<>Use <code className="font-mono">{'{phone}'}</code> for +91… or <code className="font-mono">{'{digits}'}</code> for 91…. Prefer <code className="font-mono">{'{digits}'}</code> in web addresses, where a “+” can turn into a space.</>}
              >
                <div className="flex gap-2">
                  <input
                    className={`${inputCls} font-mono`}
                    value={customUrl}
                    onChange={(e) => {
                      setCustomUrl(e.target.value);
                      setCustomError(null);
                    }}
                    placeholder="zohovoice://call?phone={phone}"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <Button variant="primary" onClick={saveCustom} disabled={!customUrl.trim() || customUrl.trim() === savedCustom} className="flex-shrink-0">Save</Button>
                </div>
              </Field>
            ) : (
              <div className="text-[11px] text-[#3D3530]">Custom link in use: <code className="font-mono break-all">{template}</code></div>
            ))}
          {customError && <InlineNotice tone="warning">{customError}</InlineNotice>}
          {example && <div className="text-[10px] text-[#9E948D]">Example link for +91 98490 12345: <code className="font-mono break-all">{example}</code></div>}
        </div>
        <InlineNotice>
          {preset === 'zoho' ? (
            <>
              <div className="font-bold text-[#1D2F3F] mb-1">Set up Zoho Voice</div>
              <ol className="list-decimal list-inside space-y-1">
                {guidanceSteps(info.guidance || '').map((step) => <li key={step}>{step}</li>)}
              </ol>
            </>
          ) : preset === 'custom' ? (
            'Enter the link your calling app opens for a number — for example zohovoice://call?phone={phone}, callto:{phone} or a web dialler address. Recordings and call logs still reach the CRM only through the telephony webhook below.'
          ) : (
            info.guidance
          )}
        </InlineNotice>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------ */

export const IntegrationsSection: React.FC<IntegrationsSectionProps> = ({ settings, serverSettings, rmOptions, can, onApplyServerSettings, onUpdateLocalSettings }) => {
  const s: ServerSettingsExt = serverSettings || {};
  const canSecrets = can('secrets.manage');
  const canEdit = can('settings.edit');

  const apply = (res: ServerSettings) => onApplyServerSettings(res);

  const setSecret = async (key: SecretKey, value: string, successMsg: string): Promise<boolean> => {
    try {
      const res = await api.settings.setSecret(key, value);
      apply(res);
      toast(successMsg, undefined, 'success');
      return true;
    } catch (e) {
      const err = reportError(`settings.secret.${key}`, e);
      toast('Could not save the key', toAppError(err).userMessage, 'alert');
      return false;
    }
  };

  const update = async (patch: Partial<ServerSettingsExt>, scope: string, successMsg: string): Promise<boolean> => {
    try {
      const res = await api.settings.update(patch);
      apply(res);
      toast(successMsg, undefined, 'success');
      return true;
    } catch (e) {
      const err = reportError(`settings.${scope}`, e);
      toast('Could not save settings', toAppError(err).userMessage, 'alert');
      return false;
    }
  };

  /* -------------------------------- AI ---------------------------------- */

  const [aiModel, setAiModel] = useState(s.aiModel || AI_MODELS[0].id);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiTest, setAiTest] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setAiModel(s.aiModel || AI_MODELS[0].id), [s.aiModel]);

  // Transcription model: the known model, or "__custom" + a free-text id.
  const savedTranscribe = s.aiTranscribeModel || AI_TRANSCRIBE_MODEL;
  const [transcribeChoice, setTranscribeChoice] = useState(savedTranscribe === AI_TRANSCRIBE_MODEL ? AI_TRANSCRIBE_MODEL : '__custom');
  const [transcribeCustom, setTranscribeCustom] = useState(savedTranscribe === AI_TRANSCRIBE_MODEL ? '' : savedTranscribe);
  useEffect(() => {
    setTranscribeChoice(savedTranscribe === AI_TRANSCRIBE_MODEL ? AI_TRANSCRIBE_MODEL : '__custom');
    setTranscribeCustom(savedTranscribe === AI_TRANSCRIBE_MODEL ? '' : savedTranscribe);
  }, [savedTranscribe]);
  const transcribeModel = (transcribeChoice === '__custom' ? transcribeCustom : transcribeChoice).trim();

  const testAi = async () => {
    setAiBusy(true);
    setAiTest(null);
    try {
      const r = await api.ai.test();
      setAiTest({ ok: r.ok, message: `${r.message}${r.model ? ` · ${r.model}` : ''}` });
    } catch (e) {
      const err = reportError('settings.aiTest', e);
      setAiTest({ ok: false, message: toAppError(err).userMessage });
    } finally {
      setAiBusy(false);
    }
  };

  /* ------------------------------ Chat360 ------------------------------- */

  const [c360, setC360] = useState({
    chat360BaseUrl: s.chat360BaseUrl || '',
    chat360SendPath: s.chat360SendPath || '',
    chat360TemplatePath: s.chat360TemplatePath || '',
    chat360AuthHeader: s.chat360AuthHeader || '',
    chat360AuthPrefix: s.chat360AuthPrefix || '',
    chat360DefaultRM: s.chat360DefaultRM || '',
    chat360DefaultSource: s.chat360DefaultSource || '',
  });
  const [c360Auto, setC360Auto] = useState(!!s.chat360AutoCreateLeads);
  const [c360Busy, setC360Busy] = useState(false);
  const [c360Test, setC360Test] = useState<{ ok: boolean; message: string } | null>(null);
  const [whBusy, setWhBusy] = useState(false);

  useEffect(() => {
    setC360({
      chat360BaseUrl: s.chat360BaseUrl || '',
      chat360SendPath: s.chat360SendPath || '',
      chat360TemplatePath: s.chat360TemplatePath || '',
      chat360AuthHeader: s.chat360AuthHeader || '',
      chat360AuthPrefix: s.chat360AuthPrefix || '',
      chat360DefaultRM: s.chat360DefaultRM || '',
      chat360DefaultSource: s.chat360DefaultSource || '',
    });
    setC360Auto(!!s.chat360AutoCreateLeads);
  }, [s.chat360BaseUrl, s.chat360SendPath, s.chat360TemplatePath, s.chat360AuthHeader, s.chat360AuthPrefix, s.chat360DefaultRM, s.chat360DefaultSource, s.chat360AutoCreateLeads]);

  const c360Dirty =
    c360.chat360BaseUrl !== (s.chat360BaseUrl || '') ||
    c360.chat360SendPath !== (s.chat360SendPath || '') ||
    c360.chat360TemplatePath !== (s.chat360TemplatePath || '') ||
    c360.chat360AuthHeader !== (s.chat360AuthHeader || '') ||
    c360.chat360AuthPrefix !== (s.chat360AuthPrefix || '') ||
    c360.chat360DefaultRM !== (s.chat360DefaultRM || '') ||
    c360.chat360DefaultSource !== (s.chat360DefaultSource || '') ||
    c360Auto !== !!s.chat360AutoCreateLeads;

  const saveC360 = async () => {
    setC360Busy(true);
    await update({ ...c360, chat360AutoCreateLeads: c360Auto }, 'chat360', 'Chat360 settings saved');
    setC360Busy(false);
  };

  const testC360 = async () => {
    setC360Busy(true);
    setC360Test(null);
    try {
      const r = await api.chat360.test();
      setC360Test(r);
    } catch (e) {
      const err = reportError('settings.chat360Test', e);
      setC360Test({ ok: false, message: toAppError(err).userMessage });
    } finally {
      setC360Busy(false);
    }
  };

  const generateSecret = async (key: SecretKey, label: string) => {
    setWhBusy(true);
    await setSecret(key, '__generate__', `${label} webhook secret generated`);
    setWhBusy(false);
  };

  /* ----------------------------- Telephony ------------------------------ */

  const [fieldMap, setFieldMap] = useState(s.telephonyFieldMap || '');
  const [fieldMapError, setFieldMapError] = useState<string | null>(null);
  const [telBusy, setTelBusy] = useState(false);
  const [zohoMapFilled, setZohoMapFilled] = useState(false);
  useEffect(() => setFieldMap(s.telephonyFieldMap || ''), [s.telephonyFieldMap]);

  const saveFieldMap = async () => {
    const text = fieldMap.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The field map must be a JSON object.');
      } catch (e) {
        setFieldMapError(`Not valid JSON: ${(e as Error).message}`);
        return;
      }
    }
    setFieldMapError(null);
    setTelBusy(true);
    const ok = await update({ telephonyFieldMap: text }, 'telephony', 'Telephony field map saved');
    setTelBusy(false);
    if (ok) setZohoMapFilled(false);
  };

  /** Fill the editor with Zoho Voice's usual call-log field names (not saved until "Save field map"). */
  const applyZohoFieldMap = () => {
    setFieldMap(fieldMapJson(ZOHO_VOICE_FIELD_MAP));
    setFieldMapError(null);
    setZohoMapFilled(true);
  };

  const prettifyFieldMap = () => {
    try {
      setFieldMap(JSON.stringify(JSON.parse(fieldMap), null, 2));
      setFieldMapError(null);
    } catch (e) {
      setFieldMapError(`Not valid JSON: ${(e as Error).message}`);
    }
  };

  /* ------------------------ Modules & notifications --------------------- */

  // Same fallback as App.tsx: a key missing from the server object is treated as enabled.
  const serverFeatures: Record<string, boolean> = { ...Object.fromEntries(FEATURE_TOGGLES.map((f) => [f.key, true])), ...(s.features || {}) };
  const [features, setFeatures] = useState<Record<string, boolean>>(serverFeatures);
  const [featuresBusy, setFeaturesBusy] = useState(false);
  useEffect(() => setFeatures({ ...Object.fromEntries(FEATURE_TOGGLES.map((f) => [f.key, true])), ...(s.features || {}) }), [s.features]);
  const featuresDirty = FEATURE_TOGGLES.some((f) => !!features[f.key] !== !!serverFeatures[f.key]);

  const saveFeatures = async () => {
    setFeaturesBusy(true);
    // Send the whole object so keys this card does not expose are preserved.
    await update({ features: { ...(s.features || {}), ...features } }, 'features', 'Module settings saved');
    setFeaturesBusy(false);
  };

  const [digestEmail, setDigestEmail] = useState(s.dailyDigestEmail || '');
  const [digestError, setDigestError] = useState<string | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  useEffect(() => setDigestEmail(s.dailyDigestEmail || ''), [s.dailyDigestEmail]);

  const saveDigest = async () => {
    const value = digestEmail.trim();
    const bad = value.split(',').map((p) => p.trim()).filter(Boolean).find((p) => !EMAIL_RE.test(p));
    if (bad) {
      setDigestError(`“${bad}” is not a valid email address.`);
      return;
    }
    setDigestError(null);
    setDigestBusy(true);
    await update({ dailyDigestEmail: value }, 'dailyDigestEmail', value ? 'Daily digest email saved' : 'Daily digest turned off');
    setDigestBusy(false);
  };

  /* ------------------------------- render ------------------------------- */

  return (
    <div className="space-y-5">
      {!canSecrets && <InlineNotice>You can review the integration status here. Only an administrator can change keys or settings.</InlineNotice>}

      {/* AI */}
      <Card
        title="AI assistant (Gemini)"
        subtitle="Powers the Copilot, lead summaries, remark reframing and call transcription"
        actions={<Badge tone={s.aiConfigured ? 'sage' : 'amber'}><Sparkles size={10} className="mr-1" />{s.aiConfigured ? 'Configured' : 'Not configured'}</Badge>}
      >
        {s.aiPlatformKey && (
          <InlineNotice className="mb-4">
            <span className="inline-flex items-start gap-1.5"><Server size={12} className="text-[#A9825A] flex-shrink-0 mt-0.5" /><span>AI is provided by the platform; you can optionally use your own Gemini key.</span></span>
          </InlineNotice>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-4">
            <SecretField
              label={s.aiPlatformKey ? 'Your own Gemini API key (optional)' : 'Gemini API key'}
              masked={s.geminiKeyMasked}
              canEdit={canSecrets}
              envVar="GEMINI_API_KEY"
              hint={<>Create a key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline hover:text-[#A9825A]">Google AI Studio</a>. The key is stored encrypted on the server and never shown again.</>}
              onSave={(v) => setSecret('GEMINI_API_KEY', v, 'Gemini key saved')}
            />
          </div>
          <div className="space-y-3">
            <Field label="Chat model" hint="Used by the Copilot, summaries and remark reframing.">
              <div className="flex gap-2">
                <Select value={aiModel} onChange={(e) => setAiModel(e.target.value)} options={AI_MODELS.map((m) => ({ value: m.id, label: m.label }))} disabled={!canEdit} />
                {canEdit && <Button variant="primary" onClick={() => update({ aiModel }, 'aiModel', 'AI model saved')} disabled={aiModel === (s.aiModel || AI_MODELS[0].id)} className="flex-shrink-0">Save</Button>}
              </div>
            </Field>
            <Field label="Transcription model" hint="Used for call recordings and voice notes. Pick “Custom” to enter another Gemini model id.">
              <div className="flex gap-2">
                <Select value={transcribeChoice} onChange={(e) => setTranscribeChoice(e.target.value)} options={[{ value: AI_TRANSCRIBE_MODEL, label: `${AI_TRANSCRIBE_MODEL} (default)` }, { value: '__custom', label: 'Custom model id…' }]} disabled={!canEdit} />
                {transcribeChoice === '__custom' && <input className={inputCls} value={transcribeCustom} onChange={(e) => setTranscribeCustom(e.target.value)} disabled={!canEdit} placeholder="Gemini model id" />}
                {canEdit && <Button variant="primary" onClick={() => update({ aiTranscribeModel: transcribeModel }, 'aiTranscribeModel', 'Transcription model saved')} disabled={!transcribeModel || transcribeModel === savedTranscribe} className="flex-shrink-0">Save</Button>}
              </div>
            </Field>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="secondary" onClick={testAi} loading={aiBusy} icon={<Wand2 size={13} />} disabled={!s.aiConfigured}>Test Gemini</Button>
              {!s.aiConfigured && <span className="text-[11px] text-[#9E948D]">Save a key first.</span>}
            </div>
            {aiTest && <InlineNotice tone={aiTest.ok ? 'success' : 'warning'}>{aiTest.message}</InlineNotice>}
          </div>
        </div>
      </Card>

      {/* Chat360 */}
      <Card
        title="Chat360 (WhatsApp)"
        subtitle="Two-way WhatsApp: inbound messages create or update enquiries; RMs reply from the Chat360 view"
        actions={<Badge tone={s.chat360Configured ? 'sage' : 'amber'}><MessageCircle size={10} className="mr-1" />{s.chat360Configured ? 'API key saved' : 'Not connected'}</Badge>}
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-4">
            <SecretField label="Chat360 API key" masked={s.chat360KeyMasked} canEdit={canSecrets} envVar="CHAT360_API_KEY" hint="Chat360 dashboard → Settings → API Key." onSave={(v) => setSecret('CHAT360_API_KEY', v, 'Chat360 key saved')} />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Base URL" className="sm:col-span-2" hint={`Leave blank for the default (${CHAT360_DEFAULTS.chat360BaseUrl}).`}><input className={inputCls} value={c360.chat360BaseUrl} onChange={(e) => setC360({ ...c360, chat360BaseUrl: e.target.value })} disabled={!canEdit} placeholder={CHAT360_DEFAULTS.chat360BaseUrl} /></Field>
              <Field label="Send message path"><input className={inputCls} value={c360.chat360SendPath} onChange={(e) => setC360({ ...c360, chat360SendPath: e.target.value })} disabled={!canEdit} placeholder={CHAT360_DEFAULTS.chat360SendPath} /></Field>
              <Field label="Template message path"><input className={inputCls} value={c360.chat360TemplatePath} onChange={(e) => setC360({ ...c360, chat360TemplatePath: e.target.value })} disabled={!canEdit} placeholder={CHAT360_DEFAULTS.chat360TemplatePath} /></Field>
              <Field label="Auth header"><input className={inputCls} value={c360.chat360AuthHeader} onChange={(e) => setC360({ ...c360, chat360AuthHeader: e.target.value })} disabled={!canEdit} placeholder={CHAT360_DEFAULTS.chat360AuthHeader} /></Field>
              <Field label="Auth prefix" hint="Sent before the key, e.g. “Bearer ” (with the trailing space)."><input className={inputCls} value={c360.chat360AuthPrefix} onChange={(e) => setC360({ ...c360, chat360AuthPrefix: e.target.value })} disabled={!canEdit} placeholder={CHAT360_DEFAULTS.chat360AuthPrefix} /></Field>
              <Field label="Default RM for new WhatsApp leads"><Select value={c360.chat360DefaultRM} onChange={(e) => setC360({ ...c360, chat360DefaultRM: e.target.value })} options={rmOptions} placeholder="Unassigned" disabled={!canEdit} /></Field>
              <Field label="Default enquiry source"><input className={inputCls} value={c360.chat360DefaultSource} onChange={(e) => setC360({ ...c360, chat360DefaultSource: e.target.value })} disabled={!canEdit} placeholder="Chat360" /></Field>
            </div>
            <Toggle checked={c360Auto} onChange={setC360Auto} disabled={!canEdit} label="Create enquiries automatically" hint="A first message from an unknown number creates a New enquiry with the default RM and source." />
            {canEdit && (
              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={saveC360} loading={c360Busy} disabled={!c360Dirty}>Save Chat360 settings</Button>
                {c360Dirty && <span className="text-[11px] text-[#A9825A] font-medium">Unsaved changes</span>}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className={`${labelCls} !mb-0 inline-flex items-center gap-2`}>Inbound webhook URL <Badge tone={s.chat360WebhookSecretSet ? 'sage' : 'amber'}>{s.chat360WebhookSecretSet ? 'Secret generated' : 'No secret yet'}</Badge></span>
                {canSecrets && <Button variant="secondary" size="xs" onClick={() => generateSecret('CHAT360_WEBHOOK_SECRET', 'Chat360')} loading={whBusy} icon={<RefreshCw size={11} />}>{s.chat360WebhookSecretSet ? 'Regenerate secret' : 'Generate webhook secret'}</Button>}
              </div>
              <div className="flex gap-2 items-start">
                <code className="flex-1 text-[11px] font-mono p-2.5 rounded-lg bg-[#F4F0EB] border border-[#D2C9BF] text-[#1D2F3F] break-all min-h-[38px]">{s.chat360WebhookUrl || 'Generate a webhook secret to get the URL.'}</code>
                <CopyButton value={canSecrets && s.chat360WebhookSecretSet ? s.chat360WebhookUrl || '' : ''} />
              </div>
              {s.chat360WebhookUrl && !s.chat360WebhookSecretSet && <div className="text-[10px] text-[#A9825A] mt-1">Generate a webhook secret first — the URL contains it.</div>}
              {!canSecrets && <div className="text-[10px] text-[#9E948D] mt-1">Full URL with secret is visible to Admins only.</div>}
            </div>
            <InlineNotice>
              <strong>Connect in Chat360:</strong> dashboard → Settings → Webhooks → Add → paste the URL above → select the events <code className="font-mono">message_received</code>, <code className="font-mono">session_message_sent</code>, <code className="font-mono">template_message_sent</code>, <code className="font-mono">delivered</code> and <code className="font-mono">read</code> → Save.
            </InlineNotice>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="secondary" onClick={testC360} loading={c360Busy} icon={<Wand2 size={13} />}>Test connection</Button>
            </div>
            {c360Test && <InlineNotice tone={c360Test.ok ? 'success' : 'warning'}>{c360Test.message}</InlineNotice>}
          </div>
        </div>
      </Card>

      {/* Telephony */}
      <Card
        title="Telephony & call recordings"
        subtitle="Receive completed-call events with recording links; recordings are copied to the CRM’s file storage and can be transcribed"
        actions={<Badge tone={s.telephonyWebhookSecretSet ? 'sage' : 'amber'}><PhoneCall size={10} className="mr-1" />{s.telephonyWebhookSecretSet ? 'Webhook ready' : 'No secret yet'}</Badge>}
      >
        <CallingAppSettings settings={settings} onUpdateLocalSettings={onUpdateLocalSettings} />
        <div className="border-t border-[#ECE8E1] my-5" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className={`${labelCls} !mb-0`}>Webhook URL</span>
                {canSecrets && <Button variant="secondary" size="xs" onClick={() => generateSecret('TELEPHONY_WEBHOOK_SECRET', 'Telephony')} loading={whBusy} icon={<RefreshCw size={11} />}>{s.telephonyWebhookSecretSet ? 'Regenerate secret' : 'Generate webhook secret'}</Button>}
              </div>
              <div className="flex gap-2 items-start">
                <code className="flex-1 text-[11px] font-mono p-2.5 rounded-lg bg-[#F4F0EB] border border-[#D2C9BF] text-[#1D2F3F] break-all min-h-[38px]">{s.telephonyWebhookUrl || 'Generate a secret to create the webhook URL.'}</code>
                <div className="flex flex-col items-stretch gap-1.5 flex-shrink-0">
                  <CopyButton value={canSecrets && s.telephonyWebhookSecretSet ? s.telephonyWebhookUrl || '' : ''} />
                  <CopyButton value={canSecrets && s.telephonyWebhookSecretSet ? telephonyUrlForProvider(s.telephonyWebhookUrl, 'zoho') : ''} label="Copy for Zoho Voice" />
                </div>
              </div>
              <div className="text-[10px] text-[#9E948D] mt-1">Replace <code className="font-mono">&lt;name&gt;</code> in the URL with the provider: <code className="font-mono">zoho</code>, <code className="font-mono">exotel</code> or <code className="font-mono">knowlarity</code> (“Copy for Zoho Voice” does this for you).</div>
              {!canSecrets && <div className="text-[10px] text-[#9E948D] mt-1">Full URL with secret is visible to Admins only.</div>}
            </div>
            <InlineNotice>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Zoho Voice</strong>: Settings → Webhooks/Integrations → “Call completed / recording ready” → paste the URL with <code className="font-mono">provider=zoho</code>, then use the Zoho Voice field-map preset.</li>
                <li><strong>Exotel</strong>: App Bazaar → Passthru applet after the call → URL above (GET or POST).</li>
                <li><strong>Knowlarity</strong>: SuperReceptionist → Settings → Webhook (call end) → URL above.</li>
              </ul>
              <div className="mt-2">The recording URL in the payload must be downloadable by the CRM server (public or signed link) for it to be copied into the CRM.</div>
            </InlineNotice>
          </div>
          <div className="space-y-3">
            <Field label="Field map (JSON)" hint={<>CRM key → your provider’s payload field. The CRM reads exactly these keys: {TELEPHONY_FIELD_KEYS.map((k, i) => <React.Fragment key={k}>{i > 0 && ', '}<code className="font-mono">{k}</code></React.Fragment>)}. A missing key falls back to a payload field of the same name; leave blank for the default map.</>}>
              <textarea rows={11} className={`${inputCls} font-mono !text-[11px]`} value={fieldMap} onChange={(e) => { setFieldMap(e.target.value); setFieldMapError(null); }} disabled={!canEdit} placeholder={fieldMapJson(DEFAULT_TELEPHONY_FIELD_MAP)} spellCheck={false} />
            </Field>
            {fieldMapError && <InlineNotice tone="warning">{fieldMapError}</InlineNotice>}
            {zohoMapFilled && (
              <InlineNotice>
                Zoho Voice preset filled in — a <strong>starting point</strong>, not yet saved. Check each name against the webhook payload Zoho Voice actually sends (make one test call, then look at the new entry in Call History), adjust, and press <strong>Save field map</strong>.
              </InlineNotice>
            )}
            {canEdit && (
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="primary" onClick={saveFieldMap} loading={telBusy} disabled={fieldMap === (s.telephonyFieldMap || '')}>Save field map</Button>
                <Button variant="ghost" size="xs" onClick={prettifyFieldMap} disabled={!fieldMap.trim()}>Format JSON</Button>
                <Button variant="secondary" size="xs" onClick={applyZohoFieldMap} icon={<PhoneCall size={11} />} title="Fill in Zoho Voice's usual call-log field names — a starting point to verify against its webhook payload">Zoho Voice preset</Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* File storage */}
      <Card title="File storage" subtitle="Lead documents, call recordings and report snapshots are stored by the CRM server and served only to signed-in users">
        <div className="text-xs text-[#3D3530] inline-flex items-start gap-2 min-w-0">
          <Database size={16} className="text-[#A9825A] flex-shrink-0 mt-0.5" />
          <span>Files are kept in <strong>{s.storage || 'the CRM database'}</strong> alongside the CRM data — nothing to set up here.</span>
        </div>
      </Card>

      {/* Modules & notifications */}
      {canEdit && (
        <Card title="Modules & notifications" subtitle="Switch optional modules on or off for everyone, and choose who receives the daily digest">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-3">
              <div className="space-y-2">
                {FEATURE_TOGGLES.map((f) => (
                  <Toggle key={f.key} checked={!!features[f.key]} onChange={(v) => setFeatures((prev) => ({ ...prev, [f.key]: v }))} disabled={featuresBusy} label={f.label} hint={f.hint} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={saveFeatures} loading={featuresBusy} disabled={!featuresDirty}>Save modules</Button>
                {featuresDirty && <span className="text-[11px] text-[#A9825A] font-medium">Unsaved changes</span>}
              </div>
              <div className="text-[10px] text-[#9E948D]">A module that is switched off disappears from the sidebar for every user after their next refresh. Role permissions still apply. Modules your company’s plan does not include stay off whatever is set here.</div>
            </div>
            <div className="space-y-3">
              <Field label="Daily digest email" hint={<>Sent at about 06:00 IST by the daily scheduled job: new enquiries yesterday, follow-ups due today and overdue follow-ups. Separate several addresses with commas; leave blank to turn the digest off.</>}>
                <div className="flex gap-2">
                  <input type="email" multiple className={inputCls} value={digestEmail} onChange={(e) => { setDigestEmail(e.target.value); setDigestError(null); }} placeholder="sales@amaya.example" autoComplete="off" />
                  <Button variant="primary" onClick={saveDigest} loading={digestBusy} disabled={digestEmail.trim() === (s.dailyDigestEmail || '')} icon={<Mail size={12} />} className="flex-shrink-0">Save</Button>
                </div>
              </Field>
              {digestError && <InlineNotice tone="warning">{digestError}</InlineNotice>}
              {!digestError && <InlineNotice tone={s.dailyDigestEmail ? 'success' : 'info'}>{s.dailyDigestEmail ? <>Digest goes to <strong>{s.dailyDigestEmail}</strong>.</> : 'No digest is being sent.'}</InlineNotice>}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};
