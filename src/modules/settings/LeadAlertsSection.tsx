/**
 * Settings › Lead alerts — instant e-mail to the assigned RM (and chosen colleagues) when a lead arrives or is
 * reassigned, plus an optional automatic WhatsApp template reply to every new lead (server: modules/leadAlerts.ts).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { BellRing, MessageCircle, Save } from 'lucide-react';
import { UserAccount } from '../../types/crm';
import { api } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { useFeature } from '../../core/tenant';
import { Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';
import { SectionBaseProps, ServerSettingsExt } from './types';

interface LeadAlertConfig {
  emailRm: boolean;
  emailAlso: string;
  whatsappAuto: boolean;
  whatsappTemplate: string;
  whatsappLanguage: string;
  whatsappParams: string;
}

const DEFAULTS: LeadAlertConfig = { emailRm: true, emailAlso: '', whatsappAuto: false, whatsappTemplate: '', whatsappLanguage: 'en', whatsappParams: '{first_name}' };
const list = (s: string) => s.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; hint?: React.ReactNode }> = ({ checked, onChange, disabled, label, hint }) => (
  <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#1D2F3F]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>
      <span className="block text-sm font-semibold text-[#1D2F3F]">{label}</span>
      {hint && <span className="block text-xs text-[#6B5F57] mt-0.5">{hint}</span>}
    </span>
  </label>
);

export const LeadAlertsSection: React.FC<SectionBaseProps & { users: UserAccount[] }> = ({ serverSettings, can, onApplyServerSettings, users }) => {
  const s = (serverSettings || {}) as ServerSettingsExt & { leadAlerts?: Partial<LeadAlertConfig>; mailConfigured?: boolean };
  const editable = can('settings.edit');
  const whatsappFeature = useFeature('chat360');
  const chatReady = whatsappFeature && !!s.chat360Configured;

  const [cfg, setCfg] = useState<LeadAlertConfig>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (s.leadAlerts) setCfg({ ...DEFAULTS, ...s.leadAlerts });
  }, [s.leadAlerts]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(() => users.filter((u) => u.status !== 'Disabled' && u.email), [users]);
  const chosen = new Set(list(cfg.emailAlso));
  const toggleUser = (email: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(email.toLowerCase());
    else next.delete(email.toLowerCase());
    setCfg((c) => ({ ...c, emailAlso: [...next].join(', ') }));
  };
  const set = <K extends keyof LeadAlertConfig>(k: K, v: LeadAlertConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.settings.update({ leadAlerts: cfg } as any);
      onApplyServerSettings(res);
      toast('Lead alerts saved', undefined, 'success');
    } catch (e) {
      toast('Could not save lead alerts', toAppError(reportError('settings.leadAlerts', e)).userMessage, 'alert');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><BellRing size={16} className="text-[#A9825A]" /> E-mail alerts</span>} subtitle="Sent the moment a lead arrives from any source (CRM, website, Google Sheet, Facebook, WhatsApp) or is reassigned. Leads replied to within minutes convert far better.">
        <div className="space-y-4">
          {s.mailConfigured === false && (
            <InlineNotice tone="warning">E-mail is not set up on the server yet (SMTP_URL and MAIL_FROM), so no alert e-mails are sent. Your platform administrator can add them.</InlineNotice>
          )}
          <Toggle checked={cfg.emailRm} disabled={!editable} onChange={(v) => set('emailRm', v)} label="E-mail the assigned RM" hint="The RM is matched by name to an active CRM user. Reassigning a lead alerts the new RM." />
          <Field label="Also notify" hint="Active CRM users only — e.g. the sales manager. They get every new-lead alert.">
            {active.length === 0 ? (
              <p className="text-xs text-[#6B5F57]">No users yet.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {active.map((u) => (
                  <label key={u.id} className={`flex items-center gap-2 rounded-lg border border-[#ECE8E1] px-3 py-2 text-xs ${editable ? 'cursor-pointer hover:bg-[#FAF7F2]' : 'opacity-70'}`}>
                    <input type="checkbox" className="h-4 w-4 accent-[#1D2F3F]" disabled={!editable} checked={chosen.has(u.email.toLowerCase())} onChange={(e) => toggleUser(u.email, e.target.checked)} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-[#1D2F3F] truncate">{u.name}</span>
                      <span className="block text-[#6B5F57] truncate">{u.email} · {u.role}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><MessageCircle size={16} className="text-[#7C8B78]" /> Automatic WhatsApp reply</span>} subtitle="Every new lead with a phone number gets your approved WhatsApp template within seconds — even at night. Sent through Chat360.">
        <div className="space-y-4">
          {!whatsappFeature && <InlineNotice tone="info">WhatsApp (Chat360) is not part of your company’s plan.</InlineNotice>}
          {whatsappFeature && !s.chat360Configured && <InlineNotice tone="warning">Add your Chat360 API key under Settings › Integrations first.</InlineNotice>}
          <Toggle checked={cfg.whatsappAuto} disabled={!editable || !chatReady} onChange={(v) => set('whatsappAuto', v)} label="Send a WhatsApp template to every new lead" hint="WhatsApp only allows approved templates for the first message to a customer. Create and approve one in Chat360, then enter its name here." />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Template name" className="sm:col-span-2">
              <input className={inputCls} value={cfg.whatsappTemplate} disabled={!editable || !chatReady} onChange={(e) => set('whatsappTemplate', e.target.value.trim())} placeholder="e.g. welcome_site_visit" maxLength={100} />
            </Field>
            <Field label="Language">
              <input className={inputCls} value={cfg.whatsappLanguage} disabled={!editable || !chatReady} onChange={(e) => set('whatsappLanguage', e.target.value.trim())} placeholder="en" maxLength={6} />
            </Field>
          </div>
          <Field label="Template parameters" hint={<>In order, comma-separated: <code>{'{first_name}'}</code>, <code>{'{name}'}</code>, <code>{'{company}'}</code>, <code>{'{unit}'}</code>, <code>{'{rm}'}</code>, <code>{'{source}'}</code> or your own text. Example: <code>{'{first_name}, {unit}'}</code></>}>
            <input className={inputCls} value={cfg.whatsappParams} disabled={!editable || !chatReady} onChange={(e) => set('whatsappParams', e.target.value)} placeholder="{first_name}" maxLength={600} />
          </Field>
        </div>
      </Card>

      {editable ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={save} loading={saving} icon={<Save size={13} />}>Save lead alerts</Button>
        </div>
      ) : (
        <InlineNotice tone="info">Only administrators can change lead alerts.</InlineNotice>
      )}
    </div>
  );
};
