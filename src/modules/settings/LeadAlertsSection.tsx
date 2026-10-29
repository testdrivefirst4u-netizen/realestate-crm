/**
 * Settings › Alerts & follow-ups — free alerts only (phone notifications and e-mail; no WhatsApp/SMS):
 * new and reassigned leads, moving untouched leads on, site-visit reminders to the RM, the evening summary, and the
 * follow-up sequence (server: modules/leadAlerts.ts, modules/salesOps.ts, modules/push.ts).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { BellRing, CalendarCheck, CalendarClock, MessageCircle, Moon, Repeat, Save, UserCheck, Zap } from 'lucide-react';
import { UserAccount } from '../../types/crm';
import { api } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';
import { SectionBaseProps, ServerSettingsExt } from './types';

interface LeadAlertConfig {
  pushRm: boolean;
  emailRm: boolean;
  emailAlso: string;
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
  summaryPush: boolean;
  summaryHour: number;
  summaryTo: string;
  welcomeTemplate: string;
  welcomeValues: string;
  visitTemplate: string;
  visitValues: string;
  hotFromAi: boolean;
  missedAlertMin: number;
  missedAlertTo: string;
}
const OPS_DEFAULTS: SalesOps = {
  reassignAfterMin: 0, reassignMax: 1, workStartHour: 9, workEndHour: 20, visitReminders: true, summaryPush: false, summaryHour: 19, summaryTo: '',
  welcomeTemplate: '', welcomeValues: '', visitTemplate: '', visitValues: '', hotFromAi: false, missedAlertMin: 0, missedAlertTo: '',
};
/** What a WhatsApp template's values may name (server: salesOps.TEMPLATE_FIELDS). */
const TEMPLATE_FIELDS = '{salutation}, {first_name}, {name}, {rm}, {unit}, {visit_date}, {visit_time}, {company}';

const SEQ_DEFAULTS: SequenceConfig = { enabled: true, days: [1, 3, 7], hour: 10, autoNotRespondingDays: 0 };

const DEFAULTS: LeadAlertConfig = { pushRm: true, emailRm: true, emailAlso: '' };
const list = (s: string) => s.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; hint?: React.ReactNode }> = ({ checked, onChange, disabled, label, hint }) => (
  <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#0B2A44]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>
      <span className="block text-sm font-semibold text-[#0B2A44]">{label}</span>
      {hint && <span className="block text-xs text-[#5E778C] mt-0.5">{hint}</span>}
    </span>
  </label>
);

/** Tick-boxes for picking active CRM users by e-mail. */
const UserPicker: React.FC<{ users: UserAccount[]; chosen: Set<string>; disabled: boolean; onToggle: (email: string, on: boolean) => void }> = ({ users, chosen, disabled, onToggle }) =>
  users.length === 0 ? (
    <p className="text-xs text-[#5E778C]">No users yet.</p>
  ) : (
    <div className="grid gap-2 sm:grid-cols-2">
      {users.map((u) => (
        <label key={u.id} className={`flex items-center gap-2 rounded-lg border border-[#E6EFF6] px-3 py-2 text-xs ${disabled ? 'opacity-70' : 'cursor-pointer hover:bg-[#F7FAFD]'}`}>
          <input type="checkbox" className="h-4 w-4 accent-[#0B2A44]" disabled={disabled} checked={chosen.has(u.email.toLowerCase())} onChange={(e) => onToggle(u.email, e.target.checked)} />
          <span className="min-w-0">
            <span className="block font-semibold text-[#0B2A44] truncate">{u.name}</span>
            <span className="block text-[#5E778C] truncate">{u.email} · {u.role}</span>
          </span>
        </label>
      ))}
    </div>
  );

export const LeadAlertsSection: React.FC<SectionBaseProps & { users: UserAccount[] }> = ({ serverSettings, can, onApplyServerSettings, users }) => {
  const s = (serverSettings || {}) as ServerSettingsExt & { leadAlerts?: Partial<LeadAlertConfig>; followupSequence?: Partial<SequenceConfig>; salesOps?: Partial<SalesOps>; mailConfigured?: boolean };
  const editable = can('settings.edit');

  const [cfg, setCfg] = useState<LeadAlertConfig>(DEFAULTS);
  const [seq, setSeq] = useState<SequenceConfig>(SEQ_DEFAULTS);
  const [daysText, setDaysText] = useState(SEQ_DEFAULTS.days.join(', '));
  const [saving, setSaving] = useState(false);
  const [ops, setOps] = useState<SalesOps>(OPS_DEFAULTS);
  const [defaultRm, setDefaultRm] = useState('');
  useEffect(() => {
    setDefaultRm(String((s as { defaultRm?: string }).defaultRm || ''));
  }, [(s as { defaultRm?: string }).defaultRm]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const active = useMemo(() => users.filter((u) => u.status !== 'Disabled' && u.email), [users]);
  const toggleIn = (current: string, email: string, on: boolean) => {
    const next = new Set(list(current));
    if (on) next.add(email.toLowerCase());
    else next.delete(email.toLowerCase());
    return [...next].join(', ');
  };
  const set = <K extends keyof LeadAlertConfig>(k: K, v: LeadAlertConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.settings.update({ leadAlerts: cfg, followupSequence: { ...seq, days: daysText }, salesOps: ops, defaultRm } as any);
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
      <InlineNotice tone="info">
        All alerts here are free: phone notifications and e-mail. Each person turns phone notifications on once under <strong>My profile › Phone notifications</strong> (on iPhone, after adding the CRM to the Home Screen).
      </InlineNotice>

      <Card title={<span className="inline-flex items-center gap-2"><UserCheck size={16} className="text-[#0B6BB0]" /> Default RM</span>} subtitle="Every new lead that arrives without an RM — from the New Enquiry form, website, Facebook, WhatsApp or a Google Sheet — is given to this person, who is notified as usual.">
        <Field label="Give unassigned new leads to">
          <select className={inputCls + ' sm:!w-80'} value={defaultRm} disabled={!editable} onChange={(e) => setDefaultRm(e.target.value)}>
            <option value="">Nobody — leave them unassigned</option>
            {active.map((u) => <option key={u.id} value={u.name}>{u.name} · {u.role}</option>)}
          </select>
        </Field>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><BellRing size={16} className="text-[#0B6BB0]" /> New-lead alerts</span>} subtitle="The moment a lead arrives from any source (CRM, website, Google Sheet, Facebook, WhatsApp) or is reassigned. Leads called within minutes convert far better.">
        <div className="space-y-4">
          <Toggle checked={cfg.pushRm} disabled={!editable} onChange={(v) => set('pushRm', v)} label="Phone notification to the assigned RM" hint="Free. Shows on their phone's lock screen; tapping it opens the lead. Reassigning a lead notifies the new RM." />
          <Toggle checked={cfg.emailRm} disabled={!editable} onChange={(v) => set('emailRm', v)} label="E-mail the assigned RM" hint="The RM is matched by name to an active CRM user." />
          {s.mailConfigured === false && (
            <InlineNotice tone="warning">E-mail is not set up on the server yet (SMTP_URL and MAIL_FROM), so no alert e-mails are sent — phone notifications still work.</InlineNotice>
          )}
          <Field label="Also notify about every new lead" hint="E.g. the sales manager. They get the phone notification and the e-mail.">
            <UserPicker users={active} chosen={new Set(list(cfg.emailAlso))} disabled={!editable} onToggle={(e, on) => set('emailAlso', toggleIn(cfg.emailAlso, e, on))} />
          </Field>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><Repeat size={16} className="text-[#0B6BB0]" /> Move untouched leads on</span>} subtitle="If the assigned RM has not called, logged a follow-up or sent a WhatsApp to a new lead in time, it goes to the next RM (the one with the fewest new leads today), who is notified as usual. Managers get an alert too.">
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
              <select className={inputCls} value={ops.workStartHour} disabled={!editable || !ops.reassignAfterMin} onChange={(e) => setOp('workStartHour', Number(e.target.value))}>{HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
            </Field>
            <Field label="to">
              <select className={inputCls} value={ops.workEndHour} disabled={!editable || !ops.reassignAfterMin} onChange={(e) => setOp('workEndHour', Number(e.target.value))}>{HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
            </Field>
          </div>
          <p className="text-xs text-[#5E778C]">The clock only runs in working hours: a lead that arrives at night gets the full time from the moment the office opens. Only leads still at stage <strong>New</strong> from the last 24 hours are moved, and only to users with the RM role.</p>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><Zap size={16} className="text-[#0B6BB0]" /> Automations</span>} subtitle="Things the CRM does by itself, each switched on here. They run within a few minutes and appear on the lead's timeline as “Automation”.">
        <div className="space-y-5">
          <Toggle
            checked={ops.hotFromAi}
            disabled={!editable}
            onChange={(v) => setOp('hotFromAi', v)}
            label="AI says Hot → move the lead to Hot and tell the RM and managers"
            hint="After a call, when the AI reads it as Hot, a lead at New, Open, Warm or Not Responding moves to Hot. Qualified, Booked and closed leads are left as they are."
          />

          <div className="space-y-2">
            <Field label="Missed call not called back → tell the managers after" hint="An incoming call that was missed, where nobody has called the number since. One alert per number per day; the RM is told too. 0 = off.">
              <div className="flex items-center gap-2">
                <input className={inputCls + ' !w-24'} type="number" min={0} max={1440} value={ops.missedAlertMin} disabled={!editable} onChange={(e) => setOp('missedAlertMin', Number(e.target.value) || 0)} />
                <span className="text-xs text-[#5E778C]">minutes</span>
              </div>
            </Field>
            {ops.missedAlertMin > 0 && (
              <Field label="Tell" hint="Nobody ticked = every Admin and Manager.">
                <UserPicker users={active} chosen={new Set(list(ops.missedAlertTo))} disabled={!editable} onToggle={(e, on) => setOp('missedAlertTo', toggleIn(ops.missedAlertTo, e, on))} />
              </Field>
            )}
          </div>

          <div className="rounded-xl border border-[#E6EFF6] p-3 space-y-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[#0B2A44]"><MessageCircle size={15} className="text-[#22A06B]" /> WhatsApp messages to customers</div>
            {!s.chat360Configured && <InlineNotice tone="warning">Chat360 is not connected, so no WhatsApp messages are sent. Connect it under Settings › WhatsApp, AI &amp; calls.</InlineNotice>}
            <p className="text-xs text-[#5E778C]">
              Only <strong>approved WhatsApp templates</strong> from Chat360 can be sent (WhatsApp's rule for first messages). Type the template's exact name, and its values in order, separated by commas.
              A value can be fixed text or one of {TEMPLATE_FIELDS}. Chat360 charges for each template message.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Welcome every new lead: template" hint="Leave empty for off. Not sent to leads that came in on WhatsApp (they are already chatting).">
                <input className={inputCls} value={ops.welcomeTemplate} disabled={!editable} onChange={(e) => setOp('welcomeTemplate', e.target.value)} placeholder="e.g. amaya_welcome" />
              </Field>
              <Field label="Its values" hint="e.g. {first_name}, {rm}">
                <input className={inputCls} value={ops.welcomeValues} disabled={!editable || !ops.welcomeTemplate.trim()} onChange={(e) => setOp('welcomeValues', e.target.value)} placeholder="{first_name}, {rm}" />
              </Field>
              <Field label="Site visit reminder (day before): template" hint="Sent to the customer from 10 AM the day before a scheduled visit. Leave empty for off.">
                <input className={inputCls} value={ops.visitTemplate} disabled={!editable} onChange={(e) => setOp('visitTemplate', e.target.value)} placeholder="e.g. site_visit_reminder" />
              </Field>
              <Field label="Its values" hint="e.g. {first_name}, {visit_date}, {visit_time}">
                <input className={inputCls} value={ops.visitValues} disabled={!editable || !ops.visitTemplate.trim()} onChange={(e) => setOp('visitValues', e.target.value)} placeholder="{first_name}, {visit_date}, {visit_time}" />
              </Field>
            </div>
          </div>

          <p className="text-xs text-[#5E778C]">
            Moving untouched new leads to another RM is under <strong>Move untouched leads on</strong> above; marking quiet leads Not Responding is in the <strong>Follow-up sequence</strong> below.
          </p>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><CalendarCheck size={16} className="text-[#0E8A86]" /> Site-visit reminders</span>} subtitle="A phone notification to the assigned RM the day before a scheduled visit (from 10 AM) and again 2 hours before, with the customer's number to call and confirm.">
        <Toggle checked={ops.visitReminders} disabled={!editable} onChange={(v) => setOp('visitReminders', v)} label="Remind the RM about site visits" hint="Free. Only for leads whose Site Visit Status is Scheduled with a date and time." />
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><Moon size={16} className="text-[#0B6BB0]" /> Evening summary</span>} subtitle="Once a day, a phone notification with the day's numbers: new leads, follow-ups, calls, site visits, bookings and overdue follow-ups.">
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <Toggle checked={ops.summaryPush} disabled={!editable} onChange={(v) => setOp('summaryPush', v)} label="Send the evening summary" hint="Free." />
            <Field label="Send at">
              <select className={inputCls + ' !w-28'} value={ops.summaryHour} disabled={!editable || !ops.summaryPush} onChange={(e) => setOp('summaryHour', Number(e.target.value))}>{HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
            </Field>
          </div>
          <Field label="Send to">
            <UserPicker users={active} chosen={new Set(list(ops.summaryTo))} disabled={!editable || !ops.summaryPush} onToggle={(e, on) => setOp('summaryTo', toggleIn(ops.summaryTo, e, on))} />
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
