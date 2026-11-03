/**
 * Settings › Connected accounts (server: modules/connectedAccounts.ts): every outside account the company has
 * connected, who connected it, when and what it is used for, with Manage and Disconnect.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck, TriangleAlert, Unplug } from 'lucide-react';
import { api, type ConnectedAccount } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Card, EmptyState } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const ConnectedAccountsSection: React.FC<{ onOpen: (section: string) => void }> = ({ onOpen }) => {
  const [rows, setRows] = useState<ConnectedAccount[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { setRows(await api.connectedAccounts.list()); } catch (e) { setRows([]); toast('Could not load the connected accounts', errText('connected.list', e), 'alert'); }
  }, []);
  useEffect(() => void load(), [load]);

  const disconnect = async (a: ConnectedAccount) => {
    if (!window.confirm(`Disconnect ${a.platform}? The CRM stops using it at once. You can connect again any time.`)) return;
    setBusy(a.key);
    try {
      if (a.key === 'meta') await api.adConversions.disconnect();
      else if (a.key === 'google') await api.googleMarketing.disconnect();
      else if (a.key === 'linkedin') await api.linkedin.disconnect();
      else if (a.key === 'pinterest') await api.pinterest.disconnect();
      else for (const p of (await api.socialAccounts.get()).pages) await api.socialAccounts.disconnectPage(p.id);
      toast(`${a.platform} disconnected`, undefined, 'success');
      await load();
    } catch (e) {
      toast('Could not disconnect', errText('connected.disconnect', e), 'alert');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><ShieldCheck size={16} className="text-[#0B6BB0]" /> Connected accounts</span>}
        subtitle="The outside accounts your company has connected to this CRM. You stay the owner: the CRM uses each one only for what is listed, and you can disconnect it here or on the platform itself at any time.">
        {rows === null ? <p className="text-xs text-[#5E778C]">Loading…</p> : !rows.length ? (
          <EmptyState title="Nothing connected" description="Connect Google, your Meta ad account, Facebook / Instagram, LinkedIn or Pinterest from their settings pages." />
        ) : (
          <ul className="divide-y divide-[#EEF4F9]">
            {rows.map((a) => (
              <li key={a.key} className="py-3 flex flex-wrap gap-3">
                {a.status === 'connected' ? <CheckCircle2 size={18} className="text-[#067647] mt-0.5" /> : <TriangleAlert size={18} className="text-[#B54708] mt-0.5" />}
                <div className="min-w-0 flex-1 text-xs text-[#2B4A63] space-y-1">
                  <p className="text-sm text-[#0B2A44]"><b>{a.platform}</b>{a.account && <span className="text-[#5E778C]"> · {a.account}</span>}</p>
                  <p className="text-[#7E93A6]">{a.connectedBy ? `Connected by ${a.connectedBy}` : 'Connected'}{a.at ? ` · ${new Date(a.at).toLocaleString()}` : ''}</p>
                  {a.usedFor.length > 0 ? (
                    <ul className="list-disc pl-4">{a.usedFor.map((u) => <li key={u}>{u}</li>)}</ul>
                  ) : <p>Not used by any switched-on feature.</p>}
                  {a.note && <p className={a.status === 'error' ? 'text-[#B54708]' : 'text-[#7E93A6]'}>{a.note}</p>}
                  <p className="text-[#7E93A6]">Also removable at: {a.revokeAt}</p>
                </div>
                <div className="flex items-start gap-2">
                  <Button variant="secondary" size="sm" onClick={() => onOpen(a.section)}>Manage</Button>
                  <Button variant="secondary" size="sm" icon={<Unplug size={13} />} loading={busy === a.key} onClick={() => void disconnect(a)}>Disconnect</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-[11px] text-[#7E93A6] px-1">Tokens are stored encrypted and are never shown. Phone numbers and e-mails sent to ad platforms are hashed first. Every connect, disconnect and change is recorded in the Audit Log.</p>
    </div>
  );
};
