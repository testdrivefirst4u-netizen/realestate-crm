/**
 * Where someone is signed in: My profile › "Where you're signed in" (own devices; sign one or all others out) and
 * Settings › Team (an admin opens a person's devices and signs them out). At most 2 devices per person — signing in on
 * a third signs the oldest out — and a device is signed out after an hour without activity.
 */
import React, { useEffect, useState } from 'react';
import { Laptop, LogOut, Smartphone, Tablet } from 'lucide-react';
import { api, type DeviceSession } from '../../core/api';
import { formatDateTime, formatRelative } from '../../core/dates';
import { toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card } from '../../components/ui';

const DeviceIcon: React.FC<{ device: string }> = ({ device }) => {
  const Icon = /iPhone|Android/.test(device) ? Smartphone : /iPad/.test(device) ? Tablet : Laptop;
  return <Icon size={18} className="text-[#0B6BB0] shrink-0" />;
};

/** The list of devices with a sign-out button each (`onEnd` absent = read only). */
export const DeviceRows: React.FC<{ rows: DeviceSession[] | null; onEnd?: (s: DeviceSession) => void; busyId?: string }> = ({ rows, onEnd, busyId }) => {
  if (rows === null) return <p className="text-xs text-[#7E93A6]">Loading…</p>;
  if (!rows.length) return <p className="text-xs text-[#7E93A6]">Not signed in anywhere.</p>;
  return (
    <ul className="rounded-xl border border-[#D3E3F0] divide-y divide-[#EAF1F7]">
      {rows.map((s) => (
        <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
          <DeviceIcon device={s.device} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[#0B2A44] flex items-center gap-2 flex-wrap">
              {s.device}
              {s.current && <Badge tone="sage">This device</Badge>}
            </div>
            <div className="text-[11px] text-[#7E93A6] truncate" title={`Signed in ${formatDateTime(s.signedInAt)}`}>
              Signed in {formatDateTime(s.signedInAt)} · active {formatRelative(s.lastActiveAt)}{s.ip ? ` · ${s.ip}` : ''}
            </div>
          </div>
          {onEnd && !s.current && (
            <Button size="xs" variant="secondary" loading={busyId === s.id} onClick={() => onEnd(s)} icon={<LogOut size={12} />}>Sign out</Button>
          )}
        </li>
      ))}
    </ul>
  );
};

export const DevicesCard: React.FC<{ limit?: number }> = ({ limit = 2 }) => {
  const [rows, setRows] = useState<DeviceSession[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => api.auth.sessions().then(setRows).catch((e) => { setRows([]); toast('Could not load your devices', toAppError(e).userMessage, 'alert'); });
  useEffect(() => {
    void load();
  }, []);
  const run = async (id: string, fn: () => Promise<DeviceSession[]>, done: string) => {
    setBusy(id);
    try {
      setRows(await fn());
      toast(done, '', 'success');
    } catch (e) {
      toast('Not signed out', toAppError(e).userMessage, 'alert');
    }
    setBusy('');
  };
  const others = (rows || []).filter((s) => !s.current).length;
  return (
    <Card
      title={<span className="inline-flex items-center gap-2">Where you&rsquo;re signed in {rows && <Badge>{rows.length} of {limit}</Badge>}</span>}
      subtitle={`You can be signed in on ${limit} devices at a time — signing in on one more signs the oldest out. You are signed out after an hour without activity. Don't recognise a device? Sign it out and change your password.`}
      actions={others > 0 ? <Button size="sm" variant="secondary" loading={busy === 'all'} onClick={() => void run('all', api.auth.endOtherSessions, 'Signed out of your other devices')} icon={<LogOut size={13} />}>Sign out other devices</Button> : undefined}
    >
      <DeviceRows rows={rows} busyId={busy} onEnd={(s) => void run(s.id, () => api.auth.endSession(s.id), `Signed out: ${s.device}`)} />
    </Card>
  );
};
