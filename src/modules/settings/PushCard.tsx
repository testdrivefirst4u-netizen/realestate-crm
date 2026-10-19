/**
 * My profile › Phone notifications: turn on free push notifications for this device (new leads, reassignments,
 * site-visit reminders, the evening summary), send a test, and see / remove the devices that get them.
 * On iPhone the CRM must be opened from the Home Screen first (Share › Add to Home Screen).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, BellOff, Send, Share, Smartphone, Trash2 } from 'lucide-react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { currentSubscription, isIOS, isStandalone, pushSupported, subscribeDevice, unsubscribeDevice } from '../../core/pushClient';
import { Badge, Button, Card, InlineNotice } from '../../components/ui';

type Status = Awaited<ReturnType<typeof api.push.status>>;

export const PushCard: React.FC = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [thisDevice, setThisDevice] = useState<string>(''); // endpoint of this device's subscription
  const [busy, setBusy] = useState<'on' | 'off' | 'test' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [env, setEnv] = useState({ supported: true, ios: false, standalone: false });

  const load = useCallback(async () => {
    try {
      setStatus(await api.push.status());
      setThisDevice((await currentSubscription())?.endpoint || '');
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
  }, []);
  useEffect(() => {
    setEnv({ supported: pushSupported(), ios: isIOS(), standalone: isStandalone() });
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error && !(e as any).code ? e.message : toAppError(e).userMessage);
    }
    setBusy(null);
  };

  const turnOn = () => run('on', async () => {
    const sub = await subscribeDevice(status!.publicKey);
    setStatus(await api.push.subscribe(sub));
    setThisDevice(sub.endpoint || '');
    toast('Notifications are on', 'New leads will show up on this device.', 'success');
  });
  const turnOff = () => run('off', async () => {
    const endpoint = await unsubscribeDevice();
    setStatus(await api.push.unsubscribe({ endpoint }));
    setThisDevice('');
    toast('Notifications are off for this device', undefined, 'info');
  });
  const test = () => run('test', async () => {
    await api.push.test();
    toast('Test sent', 'It should arrive in a few seconds.', 'success');
  });
  const remove = (id: string) => run(id, async () => setStatus(await api.push.unsubscribe({ id })));

  const on = !!thisDevice && !!status?.devices.length;
  const needsInstall = env.ios && !env.standalone;

  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><BellRing size={15} className="text-[#0B6BB0]" /> Phone notifications {on ? <Badge tone="sage">On</Badge> : <Badge>Off</Badge>}</span>}
      subtitle="Free alerts on this phone or computer: a new lead or a lead assigned to you, site visits coming up, and the evening summary if your company turns it on."
    >
      <div className="space-y-3">
        {error && <InlineNotice tone="warning">{error}</InlineNotice>}
        {status && !status.configured && (
          <InlineNotice tone="info">Phone notifications are not set up on the server yet. Ask your platform administrator to add the notification keys.</InlineNotice>
        )}

        {needsInstall ? (
          <div className="rounded-xl border border-[#D3E3F0] bg-[#F7FAFD] p-3.5 text-sm text-[#0F2233]">
            <div className="font-semibold mb-1.5 flex items-center gap-2"><Smartphone size={15} className="text-[#0B6BB0]" />On iPhone, add the CRM to your Home Screen first</div>
            <ol className="list-decimal pl-5 space-y-1 text-[13px] text-[#29465E]">
              <li>In Safari tap <Share size={13} className="inline -mt-0.5" aria-label="Share" /> <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</li>
              <li>Open the CRM from the new icon and sign in.</li>
              <li>Come back here and tap <strong>Turn on notifications</strong>.</li>
            </ol>
          </div>
        ) : !env.supported ? (
          <InlineNotice tone="info">This browser cannot show notifications. Use Chrome, Edge, Safari or Firefox — on iPhone, from the Home Screen.</InlineNotice>
        ) : (
          <div className="flex flex-wrap gap-2">
            {!on ? (
              <Button variant="primary" onClick={() => void turnOn()} loading={busy === 'on'} disabled={!status?.configured || !!busy} icon={<BellRing size={13} />}>Turn on notifications</Button>
            ) : (
              <>
                <Button variant="primary" onClick={() => void test()} loading={busy === 'test'} disabled={!!busy} icon={<Send size={13} />}>Send a test</Button>
                <Button variant="secondary" onClick={() => void turnOff()} loading={busy === 'off'} disabled={!!busy} icon={<BellOff size={13} />}>Turn off on this device</Button>
              </>
            )}
          </div>
        )}

        {!!status?.devices.length && (
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#5E778C] mb-1.5">Devices getting notifications</div>
            <ul className="divide-y divide-[#EEF4F9] rounded-xl border border-[#E6EFF6]">
              {status.devices.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <Smartphone size={14} className="text-[#7E93A6] flex-none" />
                  <span className="flex-1 min-w-0 truncate text-[#0F2233]">{d.device}</span>
                  <button type="button" onClick={() => void remove(d.id)} disabled={!!busy} className="w-9 h-9 flex items-center justify-center rounded-lg text-[#5E778C] hover:text-[#8A3E28] hover:bg-[#FAF0EC]" aria-label={`Remove ${d.device}`} title="Stop notifications on this device">
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
};
