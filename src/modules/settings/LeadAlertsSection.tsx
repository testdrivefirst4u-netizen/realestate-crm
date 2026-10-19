/**
 * Settings › Alerts & follow-ups — instant e-mail to the assigned RM (and chosen colleagues) when a lead arrives or is
 * reassigned, an optional automatic WhatsApp template reply to every new lead, and a WhatsApp alert to the assigned RM
 * (server: modules/leadAlerts.ts).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { BellRing, CalendarCheck, CalendarClock, MessageCircle, Moon, Repeat, Save, UserCheck } from 'lucide-react';
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
  whatsappRm: boolean;
  whatsappRmTemplate: string;
  whatsappRmLanguage: string;
  whatsappRmParams: string;
}

interface SequenceConfig {
  enabled: boolean;
  days: number[];
  hour: number;
  autoNotRespondingDays: number;
}
interface SalesOps {
  reassignAfterMin: number;
  reassignMax: number;
  workStartHour: number;
  workEndHour: number;
  visitReminders: boolean;
  visitTemplate: string;
  visitLanguage: string;
  visitParams: string;
  summaryWhatsapp: boolean;
  summaryTemplate: string;
  summaryLanguage: string;
  summaryParams: string;
  summaryHour: number;
  summaryTo: string;
}
const OPS_DEFAULTS: SalesOps = {
  reassignAfterMin: 0, reassignMax: 1, workStartHour: 9, workEndHour: 20,
  visitReminders: false, visitTemplate: '', visitLanguage: 'en', visitParams: '{first_name}, {visit_date}, {visit_time}',
  summaryWhatsapp: false, summaryTemplate: '', summaryLanguage: 'en', summaryParams: '{date}, {new}, {followups}, {calls}, {visits_today}, {overdue}', summaryHour: 19, summaryTo: '',
};

const SEQ_DEFAULTS: SequenceConfig = { enabled: true, days: [1, 3, 7], hour: 10, autoNotRespondingDays: 0 };

const DEFAULTS: LeadAlertConfig = { emailRm: true, emailAlso: '', whatsappAuto: false, whatsappTemplate: '', whatsappLanguage: 'en', whatsappParams: '{first_name}', whatsappRm: false, whatsappRmTemplate: '', whatsappRmLanguage: 'en', whatsappRmParams: '{rm}, {name}, {phone}, {source}' };
const list = (s: string) => s.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; hint?: React.ReactNode }> = ({ checked, onChange, disabled, label, hint }) => (
  <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#0B2A44]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>
      <span className="block text-sm font-semibold text-[#0B2A44]">{label}</span>
      {hint && <span className="block text-xs text-[#5E778C] mt-0.5">{hint}</span>}
    </span>
  </label>
);

export const LeadAlertsSection: React.FC<SectionBaseProps & { users: UserAccount[] }> = ({ serverSettings, can, onApplyServerSettings, users }) => {
  const s = (serverSettings || {}) as ServerSettingsExt & { leadAlerts?: Partial<LeadAlertConfig>; followupSequence?: Partial<SequenceConfig>; salesOps?: Partial<SalesOps>; mailConfigured?: boolean };
  const editable = can('settings.edit');
  const whatsappFeature = useFeature('chat360');
  const chatReady = whatsappFeature && !!s.chat360Configured;

  const [cfg, setCfg] = useState<LeadAlertConfig>(DEFAULTS);
  const [seq, setSeq] = useState<SequenceConfig>(SEQ_DEFAULTS);
  const [daysText, setDaysText] = useState(SEQ_DEFAULTS.days.join(', '));
  const [saving, setSaving] = useState(false);
  const [ops, setOps] = useState<SalesOps>(OPS_DEFAULTS);
  const setOp = <K extends keyof SalesOps>(k: K, v: SalesOps[K]) => setOps((o) => ({ ...o, [k]: v }));
  useEffect(() => {
    if (s.salesOps) setOps({ ...OPS_DEFAULTS, ...s.salesOps });
  }, [s.salesOps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (s.leadAlerts) setCfg({ ...DEFAULTS, ...s.leadAlerts });
  }, [s.leadAlerts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!s.followupSequence) return;
    const next = { ...SEQ_DEFAULTS, ...s.followupSequence };
    setSeq(next);
    setDaysText(next.days.join(', '));
  }, [s.followupSequence]); // eslint-disable-line react-hooks/exhaustive-deps

  const [fullUsers, setFullUsers] = useState<UserAccount[] | null>(null);
  useEffect(() => {
    if (!editable) return;
    let live = true;
    api.settings.users.list().then((l) => { if (live && Array.isArray(l)) setFullUsers(l); }, () => {});
    return () => { live = false; };
  }, [editable]);
  const active = useMemo(() => (fullUsers || users).filter((u) => u.status !== 'Disabled' && u.email), [fullUsers, users]);
  const summaryChosen = new Set(list(ops.summaryTo));
  const toggleSummary = (email: string, on: boolean) => {
    const next = new Set(summaryChosen);
    if (on) next.add(email.toLowerCase());
    else next.delete(email.toLowerCase());
    setOp('summaryTo', [...next].join(', '));
  };
  const withoutNumber = useMemo(() => active.filter((u) => !u.phone && (u.role === 'RM' || u.role === 'Manager')), [active]);
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
      const res = await api.settings.update({ leadAlerts: cfg, followupSequence: { ...seq, days: daysText }, salesOps: ops } as any);
      onApplyServerSettings(res);
      toast('Alerts & follow-ups saved', undefined, 'success');
    } catch (e) {
      toast('Could not save alerts & follow-ups', toAppError(reportError('settings.leadAlerts', e)).userMessage, 'alert');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><BellRing size={16} className="text-[#0B6BB0]" /> E-mail alerts</span>} subtitle="Sent the moment a lead arrives from any source (CRM, website, Google Sheet, Facebook, WhatsApp) or is reassigned. Leads replied to within minutes convert far better.">
        <div className="space-y-4">
          {s.mailConfigured === false && (
            <InlineNotice tone="warning">E-mail is not set up on the server yet (SMTP_URL and MAIL_FROM), so no alert e-mails are sent. Your platform administrator can add them.</InlineNotice>
          )}
          <Toggle checked={cfg.emailRm} disabled={!editable} onChange={(v) => set('emailRm', v)} label="E-mail the assigned RM" hint="The RM is matched by name to an active CRM user. Reassigning a lead alerts the new RM." />
          <Field label="Also notify" hint="Active CRM users only — e.g. the sales manager. They get every new-lead alert.">
            {active.length === 0 ? (
              <p className="text-xs text-[#5E778C]">No users yet.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {active.map((u) => (
                  <label key={u.id} className={`flex items-center gap-2 rounded-lg border border-[#E6EFF6] px-3 py-2 text-xs ${editable ? 'cursor-pointer hover:bg-[#F7FAFD]' : 'opacity-70'}`}>
                    <input type="checkbox" className="h-4 w-4 accent-[#0B2A44]" disabled={!editable} checked={chosen.has(u.email.toLowerCase())} onChange={(e) => toggleUser(u.email, e.target.checked)} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-[#0B2A44] truncate">{u.name}</span>
                      <span className="block text-[#5E778C] truncate">{u.email} · {u.role}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><MessageCircle size={16} className="text-[#0E8A86]" /> Automatic WhatsApp reply</span>} subtitle="Every new lead with a phone number gets your approved WhatsApp template within seconds — even at night. Sent through Chat360.">
        <div className="space-y-4">
          {!whatsappFeature && <InlineNotice tone="info">WhatsApp (Chat360) is not part of your company’s plan.</InlineNotice>}
          {whatsappFeature && !s.chat360Configured && <InlineNotice tone="warning">Add your Chat360 API key under Settings › Integrations first.</InlineNotice>}
          <Toggle checked={cfg.whatsappAuto} disabled={!editable || !chatReady} onChange={(v) => set('whatsappAuto', v)} label="Send a WhatsApp template to every new lead" hint="WhatsApp only allows approved templates for the first message to a customer. Create and approve one in Chat360, then enter its name here." />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Template name or ID" className="sm:col-span-2" hint="As shown in Chat360 → Campaigns → Templates.">
              <input className={inputCls} value={cfg.whatsappTemplate} disabled={!editable || !chatReady} onChange={(e) => set('whatsappTemplate', e.target.value.trim())} placeholder="e.g. welcome_site_visit" maxLength={100} />
            </Field>
            <Field label="Language">
              <input className={inputCls} value={cfg.whatsappLanguage} disabled={!editable || !chatReady} onChange={(e) => set('whatsappLanguage', e.target.value.trim())} placeholder="en" maxLength={6} />
            </Field>
          </div>
          <Field label="Template parameters" hint={<>Comma-separated, named as in your Chat360 template: <code>{'customer_name={first_name}, unit={unit}'}</code>. Values can use <code>{'{first_name}'}</code>, <code>{'{name}'}</code>, <code>{'{company}'}</code>, <code>{'{unit}'}</code>, <code>{'{rm}'}</code>, <code>{'{source}'}</code> or your own text. Without names they are sent as 1, 2, 3…</>}>
            <input className={inputCls} value={cfg.whatsappParams} disabled={!editable || !chatReady} onChange={(e) => set('whatsappParams', e.target.value)} placeholder="{first_name}" maxLength={600} />
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><UserCheck size={16} className="text-[#0E8A86]" /> WhatsApp the assigned RM</span>} subtitle="The RM gets a WhatsApp message the moment a lead is assigned to them (new or reassigned) — faster than e-mail. Sent through Chat360 to the number in their user profile.">
        <div className="space-y-4">
          {!whatsappFeature && <InlineNotice tone="info">WhatsApp (Chat360) is not part of your company’s plan.</InlineNotice>}
          {whatsappFeature && !s.chat360Configured && <InlineNotice tone="warning">Add your Chat360 API key under Settings › Integrations first.</InlineNotice>}
          <Toggle checked={cfg.whatsappRm} disabled={!editable || !chatReady} onChange={(v) => set('whatsappRm', v)} label="WhatsApp the RM when a lead is assigned" hint="Business-initiated WhatsApp messages need an approved template, e.g. “Hi {{1}}, new lead {{2}} ({{3}}) from {{4}}. Call now.” Create it in Chat360 (Utility category)." />
          {cfg.whatsappRm && fullUsers && withoutNumber.length > 0 && (
            <InlineNotice tone="warning">No WhatsApp number yet for {withoutNumber.map((u) => u.name).join(', ')}. Add it under Settings › Users (or they can add it in My profile).</InlineNotice>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Template name or ID" className="sm:col-span-2" hint="As shown in Chat360 → Campaigns → Templates.">
              <input className={inputCls} value={cfg.whatsappRmTemplate} disabled={!editable || !chatReady} onChange={(e) => set('whatsappRmTemplate', e.target.value.trim())} placeholder="e.g. new_lead_rm_alert" maxLength={100} />
            </Field>
            <Field label="Language">
              <input className={inputCls} value={cfg.whatsappRmLanguage} disabled={!editable || !chatReady} onChange={(e) => set('whatsappRmLanguage', e.target.value.trim())} placeholder="en" maxLength={6} />
            </Field>
          </div>
          <Field label="Template parameters" hint={<>Comma-separated, in template order (or <code>name=value</code>). Values can use <code>{'{rm}'}</code>, <code>{'{name}'}</code>, <code>{'{phone}'}</code>, <code>{'{source}'}</code>, <code>{'{unit}'}</code>, <code>{'{company}'}</code>, <code>{'{link}'}</code> (opens the lead) or your own text.</>}>
            <input className={inputCls} value={cfg.whatsappRmParams} disabled={!editable || !chatReady} onChange={(e) => set('whatsappRmParams', e.target.value)} placeholder="{rm}, {name}, {phone}, {source}" maxLength={600} />
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><Repeat size={16} className="text-[#0B6BB0]" /> Move untouched leads on</span>} subtitle="If the assigned RM has not called, logged a follow-up or sent a WhatsApp to a new lead in time, it goes to the next RM (the one with the fewest new leads today), who is alerted as usual. Managers get an alert too.">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Move after" hint="Working minutes. 0 = off.">
              <div className="flex items-center gap-2">
                <input className={inputCls + ' !w-24'} type="number" min={0} max={1440} value={ops.reassignAfterMin} disabled={!editable} onChange={(e) => setOp('reassignAfterMin', Number(e.target.value) || 0)} />
                <span className="text-xs text-[#5E778C]">min</span>
              </div>
            </Field>
            <Field label="At most" hint="Times per lead">
              <input className={inputCls + ' !w-24'} type="number" min={1} max={5} value={ops.reassignMax} disabled={!editable || !ops.reassignAfterMin} onChange={(e) => setOp('reassignMax', Number(e.target.value) || 1)} />
            </Field>
            <Field label="Working hours from">
              <select className={inputCls} value={ops.workStartHour} disabled={!editable || !ops.reassignAfterMin} onChange={(e) => setOp('workStartHour', Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
            </Field>
            <Field label="to">
              <select className={inputCls} value={ops.workEndHour} disabled={!editable || !ops.reassignAfterMin} onChange={(e) => setOp('workEndHour', Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
            </Field>
          </div>
          <p className="text-xs text-[#5E778C]">The clock only runs in working hours: a lead that arrives at night gets the full time from the moment the office opens. Only leads still at stage <strong>New</strong> from the last 24 hours are moved, and only to users with the RM role.</p>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><CalendarCheck size={16} className="text-[#0E8A86]" /> Site-visit reminders</span>} subtitle="WhatsApp reminder to the customer the day before a scheduled visit (from 10 AM) and again 2 hours before. Fewer no-shows.">
        <div className="space-y-4">
          {!chatReady && <InlineNotice tone="info">Needs WhatsApp (Chat360) with your API key under Settings › Integrations.</InlineNotice>}
          <Toggle checked={ops.visitReminders} disabled={!editable || !chatReady} onChange={(v) => setOp('visitReminders', v)} label="Send site-visit reminders" hint="Uses an approved Utility template, e.g. “Hi {{1}}, a reminder of your visit to Amaya on {{2}} at {{3}}. Reply here if you need to change it.”" />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Template name or ID" className="sm:col-span-2">
              <input className={inputCls} value={ops.visitTemplate} disabled={!editable || !chatReady} onChange={(e) => setOp('visitTemplate', e.target.value.trim())} placeholder="e.g. site_visit_reminder" maxLength={100} />
            </Field>
            <Field label="Language">
              <input className={inputCls} value={ops.visitLanguage} disabled={!editable || !chatReady} onChange={(e) => setOp('visitLanguage', e.target.value.trim())} placeholder="en" maxLength={6} />
            </Field>
          </div>
          <Field label="Template parameters" hint={<>In template order. Values: <code>{'{first_name}'}</code>, <code>{'{name}'}</code>, <code>{'{visit_date}'}</code>, <code>{'{visit_time}'}</code>, <code>{'{rm}'}</code>, <code>{'{company}'}</code> or your own text.</>}>
            <input className={inputCls} value={ops.visitParams} disabled={!editable || !chatReady} onChange={(e) => setOp('visitParams', e.target.value)} maxLength={600} />
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><Moon size={16} className="text-[#0B6BB0]" /> Evening WhatsApp summary</span>} subtitle="Once a day, the day's numbers on WhatsApp: new leads, follow-ups, calls, visits and overdue follow-ups.">
        <div className="space-y-4">
          {!chatReady && <InlineNotice tone="info">Needs WhatsApp (Chat360) with your API key under Settings › Integrations.</InlineNotice>}
          <Toggle checked={ops.summaryWhatsapp} disabled={!editable || !chatReady} onChange={(v) => setOp('summaryWhatsapp', v)} label="Send the evening summary" hint="Uses an approved Utility template, e.g. “Amaya CRM {{1}}: {{2}} new leads, {{3}} follow-ups, {{4}} calls, {{5}} site visits, {{6}} follow-ups overdue.”" />
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Template name or ID" className="sm:col-span-2">
              <input className={inputCls} value={ops.summaryTemplate} disabled={!editable || !chatReady} onChange={(e) => setOp('summaryTemplate', e.target.value.trim())} placeholder="e.g. daily_crm_summary" maxLength={100} />
            </Field>
            <Field label="Language">
              <input className={inputCls} value={ops.summaryLanguage} disabled={!editable || !chatReady} onChange={(e) => setOp('summaryLanguage', e.target.value.trim())} placeholder="en" maxLength={6} />
            </Field>
            <Field label="Send at">
              <select className={inputCls} value={ops.summaryHour} disabled={!editable || !chatReady} onChange={(e) => setOp('summaryHour', Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
            </Field>
          </div>
          <Field label="Template parameters" hint={<>In template order. Values: <code>{'{date}'}</code>, <code>{'{new}'}</code>, <code>{'{followups}'}</code>, <code>{'{calls}'}</code>, <code>{'{visits_today}'}</code>, <code>{'{visits_tomorrow}'}</code>, <code>{'{overdue}'}</code>, <code>{'{booked}'}</code>.</>}>
            <input className={inputCls} value={ops.summaryParams} disabled={!editable || !chatReady} onChange={(e) => setOp('summaryParams', e.target.value)} maxLength={600} />
          </Field>
          <Field label="Send to" hint="Their WhatsApp number comes from Settings › Team or My profile.">
            <div className="grid gap-2 sm:grid-cols-2">
              {active.map((u) => (
                <label key={u.id} className={`flex items-center gap-2 rounded-lg border border-[#E6EFF6] px-3 py-2 text-xs ${editable && chatReady ? 'cursor-pointer hover:bg-[#F7FAFD]' : 'opacity-70'}`}>
                  <input type="checkbox" className="h-4 w-4 accent-[#0B2A44]" disabled={!editable || !chatReady} checked={summaryChosen.has(u.email.toLowerCase())} onChange={(e) => toggleSummary(u.email, e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block font-semibold text-[#0B2A44] truncate">{u.name}</span>
                    <span className={`block truncate ${u.phone || !fullUsers ? 'text-[#5E778C]' : 'text-[#B54708]'}`}>{u.phone ? '+' + u.phone : fullUsers ? 'No WhatsApp number' : u.email} · {u.role}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><CalendarClock size={16} className="text-[#0B6BB0]" /> Follow-up sequence</span>} subtitle="Fills in each lead’s next follow-up automatically, so no enquiry is forgotten. RMs get the usual reminder when it is due. A date the RM picks always wins.">
        <div className="space-y-4">
          <Toggle checked={seq.enabled} disabled={!editable} onChange={(v) => setSeq((x) => ({ ...x, enabled: v }))} label="Schedule follow-ups automatically" hint="New, Open, Warm, Hot and Qualified leads only. When a follow-up is logged without a next date, the next step is scheduled." />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Follow up on days" hint="Days after the enquiry, e.g. 1, 3, 7" className="sm:col-span-2">
              <input className={inputCls} value={daysText} disabled={!editable || !seq.enabled} onChange={(e) => setDaysText(e.target.value)} placeholder="1, 3, 7" />
            </Field>
            <Field label="At (hour)" hint="Local time, 0–23">
              <input className={inputCls} type="number" min={0} max={23} value={seq.hour} disabled={!editable || !seq.enabled} onChange={(e) => setSeq((x) => ({ ...x, hour: Number(e.target.value) }))} />
            </Field>
          </div>
          <Field label="Mark as “Not Responding” after" hint="New, Open or Warm leads with no activity for this many days move to Not Responding (checked daily). 0 = never.">
            <div className="flex items-center gap-2">
              <input className={inputCls + ' !w-24'} type="number" min={0} max={365} value={seq.autoNotRespondingDays} disabled={!editable} onChange={(e) => setSeq((x) => ({ ...x, autoNotRespondingDays: Number(e.target.value) || 0 }))} />
              <span className="text-xs text-[#5E778C]">days without activity</span>
            </div>
          </Field>
        </div>
      </Card>

      {editable ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={save} loading={saving} icon={<Save size={13} />}>Save alerts &amp; follow-ups</Button>
        </div>
      ) : (
        <InlineNotice tone="info">Only administrators can change alerts and follow-ups.</InlineNotice>
      )}
    </div>
  );
};
