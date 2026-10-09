/**
 * Settings › Visit booking — the public page /book/<company slug> where customers pick a free slot and book a
 * site visit (server: modules/visits.ts). Bookings become leads with the visit scheduled.
 */
import React, { useEffect, useState } from 'react';
import { CalendarDays, Check, Copy, ExternalLink, Save } from 'lucide-react';
import { api } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { companyOf } from '../../core/tenant';
import { Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';
import { SectionBaseProps } from './types';

interface VisitBooking {
  enabled: boolean;
  days: number[];
  start: string;
  end: string;
  slotMinutes: number;
  capacity: number;
  horizonDays: number;
  minNoticeHours: number;
  location: string;
  instructions: string;
}

const DEFAULTS: VisitBooking = { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '18:00', slotMinutes: 60, capacity: 2, horizonDays: 14, minNoticeHours: 2, location: '', instructions: '' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const VisitBookingSection: React.FC<SectionBaseProps> = ({ serverSettings, can, onApplyServerSettings }) => {
  const s = (serverSettings || {}) as { visitBooking?: Partial<VisitBooking> };
  const editable = can('settings.edit');
  const slug = companyOf(serverSettings as any)?.slug || '';
  const [cfg, setCfg] = useState<VisitBooking>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (s.visitBooking) setCfg({ ...DEFAULTS, ...s.visitBooking });
  }, [s.visitBooking]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = slug && origin ? `${origin}/book/${slug}` : '';
  const set = <K extends keyof VisitBooking>(k: K, v: VisitBooking[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const toggleDay = (d: number) => set('days', cfg.days.includes(d) ? cfg.days.filter((x) => x !== d) : [...cfg.days, d].sort());

  const save = async () => {
    setSaving(true);
    try {
      onApplyServerSettings(await api.settings.update({ visitBooking: cfg } as any));
      toast('Visit booking saved', cfg.enabled ? 'Your booking page is live.' : undefined, 'success');
    } catch (e) {
      toast('Could not save visit booking', toAppError(reportError('settings.visitBooking', e)).userMessage, 'alert');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const num = (k: 'slotMinutes' | 'capacity' | 'horizonDays' | 'minNoticeHours') => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) || 0);

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><CalendarDays size={16} className="text-[#0B6BB0]" /> Online site-visit booking</span>} subtitle="Customers pick a free slot and book a visit themselves — from a link you share on WhatsApp, in ads or on your website. Each booking becomes a lead with the visit scheduled, and the RM is alerted.">
        <div className="space-y-4">
          <label className={`flex items-start gap-3 ${editable ? 'cursor-pointer' : 'opacity-60'}`}>
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#0B2A44]" checked={cfg.enabled} disabled={!editable} onChange={(e) => set('enabled', e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold text-[#0B2A44]">Accept online bookings</span>
              <span className="block text-xs text-[#5E778C] mt-0.5">Switched off, the booking page shows “not available”.</span>
            </span>
          </label>

          {link && (
            <Field label="Your booking link" hint={cfg.enabled ? 'Share it in WhatsApp replies, ads and on your website.' : 'Save with bookings switched on to open it.'}>
              <div className="flex flex-wrap items-center gap-2">
                <code className="flex-1 min-w-0 break-all rounded-lg border border-[#D3E3F0] bg-white px-3 py-2 text-xs text-[#0B2A44]">{link}</code>
                <Button variant="secondary" size="sm" onClick={copy} icon={copied ? <Check size={13} /> : <Copy size={13} />}>{copied ? 'Copied' : 'Copy'}</Button>
                <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-[#0B5E9C] hover:underline">Open <ExternalLink size={12} /></a>
              </div>
            </Field>
          )}

          <Field label="Open on">
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((w, i) => (
                <button key={w} type="button" disabled={!editable} onClick={() => toggleDay(i)} aria-pressed={cfg.days.includes(i)}
                  className={`h-9 min-w-[52px] rounded-lg border px-3 text-xs font-semibold ${cfg.days.includes(i) ? 'border-[#0B2A44] bg-[#0B2A44] text-white' : 'border-[#D3E3F0] bg-white text-[#5E778C]'}`}>
                  {w}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Opens at"><input className={inputCls} type="time" value={cfg.start} disabled={!editable} onChange={(e) => set('start', e.target.value)} /></Field>
            <Field label="Closes at"><input className={inputCls} type="time" value={cfg.end} disabled={!editable} onChange={(e) => set('end', e.target.value)} /></Field>
            <Field label="Visit length (min)"><input className={inputCls} type="number" min={15} max={240} step={15} value={cfg.slotMinutes} disabled={!editable} onChange={num('slotMinutes')} /></Field>
            <Field label="Visits at once"><input className={inputCls} type="number" min={1} max={50} value={cfg.capacity} disabled={!editable} onChange={num('capacity')} /></Field>
            <Field label="Book up to (days ahead)"><input className={inputCls} type="number" min={1} max={60} value={cfg.horizonDays} disabled={!editable} onChange={num('horizonDays')} /></Field>
            <Field label="Minimum notice (hours)"><input className={inputCls} type="number" min={0} max={72} value={cfg.minNoticeHours} disabled={!editable} onChange={num('minNoticeHours')} /></Field>
          </div>

          <Field label="Where to come" hint="Shown on the booking page and the confirmation.">
            <input className={inputCls} value={cfg.location} maxLength={300} disabled={!editable} onChange={(e) => set('location', e.target.value)} placeholder="e.g. Amaya Experience Centre, Road No. 12, Banjara Hills, Hyderabad" />
          </Field>
          <Field label="Instructions (optional)">
            <textarea className={inputCls + ' h-20'} value={cfg.instructions} maxLength={600} disabled={!editable} onChange={(e) => set('instructions', e.target.value)} placeholder="e.g. Free parking at the entrance. Please bring a photo ID." />
          </Field>
        </div>
      </Card>

      {editable ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={save} loading={saving} icon={<Save size={13} />}>Save visit booking</Button>
        </div>
      ) : (
        <InlineNotice tone="info">Only administrators can change visit booking.</InlineNotice>
      )}
    </div>
  );
};
