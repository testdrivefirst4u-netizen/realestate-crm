/**
 * Settings › WhatsApp, AI & calls › JustConnect: the API key, a connection test, and which JustConnect agent (phone)
 * each CRM user calls through — by default the agent with the same e-mail.
 */
import React, { useState } from 'react';
import { CheckCircle2, Contact, Copy, Download, PhoneCall, RefreshCw, Upload, Wand2 } from 'lucide-react';
import { api, type JcAgentsRes } from '../../core/api';
import { toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, InlineNotice } from '../../components/ui';

const STATUS_TONE: Record<string, string> = { online: 'text-[#067647]', 'on-call': 'text-[#0B6BB0]', offline: 'text-[#7E93A6]' };

export const JustConnectCard: React.FC<{
  configured: boolean;
  canEdit: boolean;
  /** The integrations section's secret field for the key (write-only). */
  keyField: React.ReactNode;
  /** Call events: the address to paste into JustConnect, the signing-secret field, and the last sync. */
  webhookUrl?: string;
  webhookSecretSet?: boolean;
  webhookSecretField?: React.ReactNode;
  lastSync?: string;
  /** Leads kept as JustConnect contacts (caller names). */
  contactSync?: boolean;
  onContactSync?: (on: boolean) => Promise<boolean>;
}> = ({ configured, canEdit, keyField, webhookUrl, webhookSecretSet, webhookSecretField, lastSync, contactSync = true, onContactSync }) => {
  const [contacts, setContacts] = useState<{ on: boolean; synced: number; waiting: number; failed: number } | null>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactMsg, setContactMsg] = useState<string | null>(null);
  const loadContacts = async () => {
    try {
      setContacts(await api.justconnect.contactStatus());
    } catch {
      /* the status line just stays empty */
    }
  };
  const sendContacts = async () => {
    setContactBusy(true);
    try {
      const r = await api.justconnect.syncContacts();
      setContactMsg(r.skipped ? 'Sending leads is switched off.' : `${r.sent} sent${r.failed ? `, ${r.failed} refused` : ''}. ${r.left ? `${r.left} still to send — the rest go automatically every few minutes (or click again).` : 'All leads are in JustConnect.'}`);
      await loadContacts();
    } catch (e) {
      setContactMsg(toAppError(e).userMessage);
    }
    setContactBusy(false);
  };
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.justconnect.syncCalls();
      setSyncMsg(r.skipped === 'just synced' ? 'Synced a moment ago — try again in 20 seconds.' : `${r.saved} call${r.saved === 1 ? '' : 's'} checked, ${r.created} new, ${r.finished} recording / AI step${r.finished === 1 ? '' : 's'} done.`);
    } catch (e) {
      setSyncMsg(toAppError(e).userMessage);
    }
    setSyncing(false);
  };
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [data, setData] = useState<JcAgentsRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.justconnect.test());
    } catch (e) {
      setTest({ ok: false, message: toAppError(e).userMessage });
    }
    setTesting(false);
  };
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.justconnect.agents());
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
    setLoading(false);
  };
  const link = async (userId: string, agent: string) => {
    setSaving(userId);
    setError(null);
    try {
      setData(await api.justconnect.setAgent(userId, agent));
      toast('Saved', undefined, 'success');
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
    setSaving(null);
  };

  const unlinked = data ? data.users.filter((u) => !u.agent).length : 0;

  return (
    <Card
      title="JustConnect calling"
      subtitle="Calls start from the CRM: the RM's JustConnect phone rings first, then the customer is called from your business number."
      actions={<Badge tone={configured ? 'sage' : 'amber'}><PhoneCall size={10} className="mr-1" />{configured ? 'Connected' : 'Not connected'}</Badge>}
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-4">
          {keyField}
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" onClick={() => void runTest()} loading={testing} disabled={!configured} icon={<Wand2 size={13} />}>Test connection</Button>
            {!configured && <span className="text-[11px] text-[#7E93A6]">Save the key first.</span>}
          </div>
          {test && <InlineNotice tone={test.ok ? 'success' : 'warning'}>{test.message}</InlineNotice>}
          <InlineNotice>
            Key scopes to tick in JustConnect (Developer Panel › API Keys): <strong>calls:read, calls:write, contacts:read, contacts:write, reports:read</strong>. Each RM needs a JustConnect phone that is allowed to call out.
          </InlineNotice>

          <div className="rounded-xl border border-[#D3E3F0] bg-[#F7FAFD] p-3.5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[12px] font-bold text-[#0B2A44] inline-flex items-center gap-1.5"><Contact size={12} className="text-[#0B6BB0]" />Caller names in JustConnect</div>
                <p className="text-[11px] text-[#5E778C] mt-0.5 leading-relaxed">Every lead with a phone number is kept as a JustConnect contact (name, stage, unit, source, RM), so the agent sees who is calling before picking up. New leads go at once; changes follow every few minutes.</p>
              </div>
              <label className="flex items-center gap-2 text-[12px] font-semibold text-[#0B2A44] flex-none cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-[#0B2A44]" checked={contactSync} disabled={!canEdit || !configured || !onContactSync} onChange={(e) => void onContactSync?.(e.target.checked)} />
                On
              </label>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="secondary" size="xs" onClick={() => void sendContacts()} loading={contactBusy} disabled={!configured || !contactSync} icon={<Upload size={11} />}>Send leads now</Button>
              <Button variant="ghost" size="xs" onClick={() => void loadContacts()} disabled={!configured} icon={<RefreshCw size={11} />}>{contacts ? 'Refresh' : 'Show status'}</Button>
              {contacts && <span className="text-[11px] text-[#5E778C]">{contacts.synced} in JustConnect · {contacts.waiting} waiting{contacts.failed ? ` · ${contacts.failed} refused (not an Indian number?)` : ''}</span>}
            </div>
            {contactMsg && <InlineNotice>{contactMsg}</InlineNotice>}
          </div>

          <div className="rounded-xl border border-[#D3E3F0] bg-[#F7FAFD] p-3.5 space-y-3">
            <div>
              <div className="text-[12px] font-bold text-[#0B2A44]">Save every call in the CRM (call events)</div>
              <p className="text-[11px] text-[#5E778C] mt-0.5 leading-relaxed">In JustConnect › API Keys, choose <strong>Add webhook</strong> on this key, paste the address below, tick <strong>Every call on our numbers</strong>, save, and paste the <strong>signing secret</strong> it shows here. Calls then appear in the CRM seconds after they end, with the recording and the AI summary.</p>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-[#233B50] mb-1">Webhook address</div>
              <div className="flex gap-2 items-start">
                <code className="flex-1 text-[11px] font-mono p-2 rounded-lg bg-white border border-[#D3E3F0] text-[#0B2A44] break-all">{webhookUrl || '—'}</code>
                <Button variant="secondary" size="xs" disabled={!webhookUrl} onClick={() => { void navigator.clipboard?.writeText(webhookUrl || ''); toast('Copied', undefined, 'success'); }} icon={<Copy size={11} />}>Copy</Button>
              </div>
              {webhookUrl && /localhost|127\.0\.0\.1|192\.168\./.test(webhookUrl) && <div className="text-[10.5px] text-[#B54708] mt-1">This is a local address — JustConnect can only reach the live site. Until then, “Sync calls now” (and the 5-minute background check) brings calls in.</div>}
            </div>
            {webhookSecretField}
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="secondary" size="xs" onClick={() => void syncNow()} loading={syncing} disabled={!configured} icon={<Download size={11} />}>Sync calls now</Button>
              <span className="text-[11px] text-[#5E778C]">{webhookSecretSet ? 'Webhook secret saved.' : 'No webhook secret yet — calls come in through the 5-minute check.'}{lastSync ? ` Last call synced: ${new Date(lastSync).toLocaleString('en-IN')}.` : ''}</span>
            </div>
            {syncMsg && <InlineNotice>{syncMsg}</InlineNotice>}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-bold text-[#0B2A44]">Who calls through which phone</div>
              <div className="text-[11px] text-[#5E778C]">Matched by e-mail unless you pick an agent. When someone's JustConnect app is signed out (or they have no agent), the call rings their own mobile first instead.</div>
            </div>
            <Button variant="secondary" size="xs" onClick={() => void load()} loading={loading} disabled={!configured} icon={<RefreshCw size={11} />}>{data ? 'Reload' : 'Load agents'}</Button>
          </div>
          {error && <InlineNotice tone="warning">{error}</InlineNotice>}
          {data && (
            <>
              {unlinked > 0 && <InlineNotice>{unlinked} user{unlinked === 1 ? ' has' : 's have'} no JustConnect agent — their calls ring the mobile number saved in the CRM instead.</InlineNotice>}
              <ul className="divide-y divide-[#EEF4F9] rounded-xl border border-[#E6EFF6]">
                {data.users.map((u) => (
                  <li key={u.id} className="px-3 py-2.5 flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-[#0B2A44] truncate">{u.name}</div>
                      <div className="text-[11px] text-[#5E778C] truncate">
                        {u.agent ? (
                          <span className="inline-flex items-center gap-1"><CheckCircle2 size={11} className="text-[#067647]" />{u.agent.name} · ext {u.agent.extension}{u.auto ? ' · by e-mail' : ''} · <span className={STATUS_TONE[u.agent.status] || 'text-[#B54708]'}>{u.agent.status}</span>{!u.agent.canCallOut && <span className="text-[#B42318]"> · cannot call out</span>}</span>
                        ) : u.email}
                      </div>
                      <div className={`text-[11px] truncate ${u.mobile ? 'text-[#5E778C]' : 'text-[#B54708]'}`}>{u.mobile ? `App signed out → rings mobile +${u.mobile}` : 'No mobile number — add it in Team so calls can ring their phone'}</div>
                    </div>
                    <select
                      className="text-xs px-2 py-1.5 rounded-lg border border-[#A9BDCD] bg-white text-[#0B2A44] max-w-[220px]"
                      value={u.link}
                      disabled={!canEdit || saving === u.id}
                      onChange={(e) => void link(u.id, e.target.value)}
                      aria-label={`JustConnect agent for ${u.name}`}
                    >
                      <option value="">Match by e-mail</option>
                      {data.agents.map((a) => <option key={a.id} value={a.id}>{a.name} · ext {a.extension}</option>)}
                      <option value="none">Do not use JustConnect</option>
                    </select>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Card>
  );
};
