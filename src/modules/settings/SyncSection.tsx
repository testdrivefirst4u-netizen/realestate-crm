/**
 * Settings → Sync & preferences: sync status and interval, message defaults, CRM time zone and
 * desktop notifications. (The backend is always the same origin — there is no URL to configure.)
 */
import React, { useEffect, useState } from 'react';
import { Bell, CheckCircle2, Globe, MessageSquare, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { CRMSettings, SyncState } from '../../types/crm';
import { api } from '../../core/api';
import { SYNC } from '../../core/config';
import { formatRelative, isValidTimeZone } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { notifications, toast } from '../../core/notifications';
import { fillTemplate } from '../../core/phone';
import { Badge, Button, Card, Field, InlineNotice, Select, inputCls } from '../../components/ui';
import { SectionBaseProps } from './types';

export interface SyncSectionProps extends SectionBaseProps {
  sync: SyncState;
  onUpdateLocalSettings: (patch: Partial<CRMSettings>) => void;
  onSyncNow: () => void;
}

const INTERVALS = [
  { value: '10', label: 'Every 10 seconds' },
  { value: '15', label: 'Every 15 seconds' },
  { value: '30', label: 'Every 30 seconds (recommended)' },
  { value: '60', label: 'Every minute' },
  { value: '0', label: 'Manual sync only' },
];

const SAMPLE = { name: 'Rahul', rm: 'Priya', unit: '2 BHK' };

export const SyncSection: React.FC<SyncSectionProps> = ({ settings, serverSettings, sync, can, onUpdateLocalSettings, onSyncNow, onApplyServerSettings }) => {
  const [wa, setWa] = useState(settings.waTemplate || '');
  const [emailSubject, setEmailSubject] = useState(settings.emailSubject || '');
  const [emailBody, setEmailBody] = useState(settings.emailBody || '');

  const [tz, setTz] = useState(serverSettings?.timeZone || settings.timeZone || '');
  const [tzSaving, setTzSaving] = useState(false);
  const [tzMsg, setTzMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const [perm, setPerm] = useState<NotificationPermission>(notifications.getBrowserPermission());

  useEffect(() => setTz(serverSettings?.timeZone || settings.timeZone || ''), [serverSettings?.timeZone, settings.timeZone]);

  const templatesDirty = wa !== (settings.waTemplate || '') || emailSubject !== (settings.emailSubject || '') || emailBody !== (settings.emailBody || '');

  const saveTemplates = () => {
    onUpdateLocalSettings({ waTemplate: wa, emailSubject, emailBody });
    toast('Templates saved', 'WhatsApp and email defaults updated on this device.', 'success');
  };

  const saveTimeZone = async () => {
    const value = tz.trim();
    if (!value || !isValidTimeZone(value)) return setTzMsg({ ok: false, message: 'Enter a valid IANA time zone such as Asia/Kolkata.' });
    setTzSaving(true);
    setTzMsg(null);
    try {
      const res = await api.settings.update({ timeZone: value });
      onApplyServerSettings(res);
      setTzMsg({ ok: true, message: `Time zone set to ${value}. All dates now display in this zone.` });
    } catch (e) {
      const err = reportError('settings.timeZone', e);
      setTzMsg({ ok: false, message: toAppError(err).userMessage });
    } finally {
      setTzSaving(false);
    }
  };

  const requestPermission = async () => setPerm(await notifications.requestBrowserPermission());

  const testNotification = () => {
    toast('Test notification', 'In-app alerts and sounds are working.', 'success');
    if (perm === 'granted') {
      try {
        new Notification('CRM — test notification', { body: 'Desktop alerts are enabled for this browser.' });
      } catch {
        /* ignore */
      }
    }
  };

  const online = sync.status !== 'offline';
  const statusTone = sync.status === 'error' ? 'rust' : sync.status === 'offline' ? 'amber' : sync.status === 'syncing' || sync.status === 'loading' ? 'gold' : 'sage';
  const statusLabel = { idle: 'Connected', loading: 'Loading…', syncing: 'Syncing…', error: 'Error', offline: 'Offline', auth: 'Sign-in required' }[sync.status];

  return (
    <div className="space-y-5">
      <Card
        title="Sync"
        subtitle="This device stays in step with the CRM server (MongoDB) by polling for changes"
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone}>{online ? <Wifi size={10} className="mr-1" /> : <WifiOff size={10} className="mr-1" />}{statusLabel}</Badge>
            <Button variant="gold" size="xs" onClick={onSyncNow} loading={sync.status === 'syncing'} icon={<RefreshCw size={12} />}>Sync now</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-[#F4F0EB] border border-[#D2C9BF]">
              <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Last sync</div>
              <div className="font-semibold text-[#1D2F3F] mt-1">{sync.lastSyncAt ? formatRelative(sync.lastSyncAt) : 'Not synced yet'}</div>
            </div>
            <div className="p-3 rounded-xl bg-[#F4F0EB] border border-[#D2C9BF]">
              <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Data version</div>
              <div className="font-mono text-[11px] text-[#1D2F3F] mt-1 truncate" title={sync.version}>{sync.version || '—'}</div>
            </div>
            <div className="p-3 rounded-xl bg-[#F4F0EB] border border-[#D2C9BF]">
              <div className="text-[10px] uppercase font-bold tracking-wider text-[#6B5F57]">Backend</div>
              <div className="font-semibold text-[#1D2F3F] mt-1 truncate">{serverSettings?.company?.name || serverSettings?.appName || 'CRM'}{serverSettings?.version ? ` · v${serverSettings.version}` : ''}</div>
            </div>
          </div>
          {sync.lastError && sync.status === 'error' && <InlineNotice tone="warning">Last sync error: {sync.lastError}</InlineNotice>}

          <div className="p-3 sm:p-4 rounded-xl bg-[#F4F0EB] border border-[#D2C9BF] flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-[#1D2F3F]">Auto-sync interval</div>
              <div className="text-[11px] text-[#6B5F57]">Background polling picks up colleagues’ changes. Minimum {SYNC.minIntervalSec}s.</div>
            </div>
            <Select value={String(settings.autoSyncIntervalSec ?? SYNC.defaultIntervalSec)} onChange={(e) => onUpdateLocalSettings({ autoSyncIntervalSec: Number(e.target.value) })} options={INTERVALS} className="!w-auto font-semibold" />
          </div>
        </div>
      </Card>

      <Card title="Message defaults" subtitle="Used by the WhatsApp and email buttons across the CRM. Placeholders: {name}, {rm}, {unit}" actions={templatesDirty ? <Button variant="primary" size="xs" onClick={saveTemplates}>Save</Button> : <Badge tone="sage"><CheckCircle2 size={10} className="mr-1" />Saved</Badge>}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            <Field label="WhatsApp opening message">
              <textarea rows={3} className={inputCls} value={wa} onChange={(e) => setWa(e.target.value)} />
            </Field>
            <div className="text-[11px] text-[#6B5F57] p-2.5 rounded-lg bg-[#F4F0EB] border border-[#D2C9BF] inline-flex items-start gap-2"><MessageSquare size={12} className="mt-0.5 text-[#3C573A] flex-shrink-0" /><span>Preview: {fillTemplate(wa, SAMPLE) || '—'}</span></div>
          </div>
          <div className="space-y-3">
            <Field label="Email subject">
              <input className={inputCls} value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
            </Field>
            <Field label="Email body">
              <textarea rows={4} className={inputCls} value={emailBody} onChange={(e) => setEmailBody(e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title="Time zone" subtitle="All dates and “today” calculations use the CRM time zone, not the browser’s">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs"><Globe size={14} className="text-[#A9825A]" /><span className="text-[#6B5F57]">Current:</span><strong className="text-[#1D2F3F]">{serverSettings?.timeZone || settings.timeZone}</strong></div>
            {can('settings.edit') ? (
              <>
                <div className="flex gap-2">
                  <input className={inputCls} value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Asia/Kolkata" list="tz-suggestions" />
                  <datalist id="tz-suggestions">{['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'].map((z) => <option key={z} value={z} />)}</datalist>
                  <Button variant="primary" onClick={saveTimeZone} loading={tzSaving} disabled={!tz.trim() || tz.trim() === (serverSettings?.timeZone || settings.timeZone)} className="flex-shrink-0">Save</Button>
                </div>
                {tzMsg && <InlineNotice tone={tzMsg.ok ? 'success' : 'warning'}>{tzMsg.message}</InlineNotice>}
              </>
            ) : (
              <div className="text-[11px] text-[#9E948D]">Only an administrator can change the time zone.</div>
            )}
          </div>
        </Card>

        <Card title="Desktop notifications" subtitle="Alerts for new enquiries, due follow-ups and chats, even when the tab is in the background">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs"><Bell size={14} className="text-[#A9825A]" /><span className="text-[#6B5F57]">Browser permission:</span><Badge tone={perm === 'granted' ? 'sage' : perm === 'denied' ? 'rust' : 'amber'}>{perm}</Badge></div>
            {perm === 'denied' && <InlineNotice tone="warning">Notifications are blocked for this site. Allow them from the browser’s site settings (the lock icon in the address bar) and reload.</InlineNotice>}
            <div className="flex items-center gap-2 flex-wrap">
              {perm !== 'granted' && perm !== 'denied' && <Button variant="primary" onClick={requestPermission}>Enable desktop alerts</Button>}
              <Button variant="secondary" onClick={testNotification}>Test notification</Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};
