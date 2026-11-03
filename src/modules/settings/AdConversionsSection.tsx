/**
 * Settings › Meta ads (server: modules/adConversions.ts). One Facebook connection serves:
 *  - Lead results to Meta (plan feature `adConversions`): when a lead reaches a chosen step the CRM tells the
 *    company's Meta dataset (Conversions API), so Facebook / Instagram ads learn which enquiries become buyers;
 *  - Ad spend from Meta (plan feature `adSpend`): each campaign's spend, daily, into the campaign spend of Sales MIS.
 * The access token is write-only here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, FlaskConical, IndianRupee, Plug, Plus, RefreshCw, Save, Target, Trash2, Unplug } from 'lucide-react';
import { api, type AdConversionRule, type AdConversionsView } from '../../core/api';
import { SITE_VISIT } from '../../core/config';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { useFeature } from '../../core/tenant';
import { Badge, Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';
import { Permission } from '../../core/rbac';

const STATUS_TONE = { sent: 'sage', pending: 'amber', failed: 'rust', skipped: 'muted', expired: 'muted' } as const;
const STATUS_LABEL = { sent: 'Sent', pending: 'Waiting', failed: 'Will retry', skipped: 'Not sent', expired: 'Too old' } as const;
const monthLabel = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export const AdConversionsSection: React.FC<{ can: (p: Permission) => boolean; stageOptions: string[]; onOpenLead?: (id: string) => void }> = ({ can, stageOptions, onOpenLead }) => {
  const editable = can('integrations.connect');
  const conversionsOn = useFeature('adConversions');
  const spendOn = useFeature('adSpend');
  const [view, setView] = useState<AdConversionsView | null>(null);
  const [error, setError] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [datasetId, setDatasetId] = useState('');
  const [token, setToken] = useState('');
  const [testCode, setTestCode] = useState('');
  const [rules, setRules] = useState<AdConversionRule[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [manual, setManual] = useState(false);

  const apply = (v: AdConversionsView) => {
    setView(v);
    setEnabled(v.enabled);
    setDatasetId(v.datasetId);
    setTestCode(v.testCode);
    setRules(v.rules);
    setAccounts(v.spend.accounts.filter((a) => a.included).map((a) => a.id));
    setToken('');
  };
  const load = useCallback(async () => {
    try {
      apply(await api.adConversions.get());
      setError('');
    } catch (e) {
      setError(toAppError(reportError('adConversions.get', e)).userMessage);
    }
  }, []);
  useEffect(() => void load(), [load]);

  // back from Facebook: say how it went, then drop the parameters from the address bar
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const err = q.get('capiError'), ok = q.get('capiConnected'), choose = q.get('capiChoose');
    if (err) toast('Facebook not connected', err.slice(0, 300), 'alert');
    else if (ok) toast('Facebook connected', `Dataset “${ok.slice(0, 120)}”.`, 'success');
    else if (choose) toast('Choose a dataset', 'Facebook gave access to more than one dataset. Pick the one for this project below.', 'info');
    if (err || ok || choose) {
      ['capiError', 'capiConnected', 'capiChoose'].forEach((k) => q.delete(k));
      const rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : ''));
    }
  }, []);

  const run = async (scope: string, fail: string, fn: () => Promise<AdConversionsView>, done?: string, setFlag: (b: boolean) => void = setBusy) => {
    setFlag(true);
    try {
      apply(await fn());
      if (done) toast(done, undefined, 'success');
      return true;
    } catch (e) {
      toast(fail, toAppError(reportError(scope, e)).userMessage, 'alert');
      return false;
    } finally {
      setFlag(false);
    }
  };
  const choose = (id: string) => run('adConversions.choose', 'Could not choose the dataset', () => api.adConversions.chooseDataset(id), 'Facebook connected');
  const disconnect = () => {
    if (!window.confirm('Disconnect Facebook? Lead results and ad spend stop coming until you connect again.')) return;
    void run('adConversions.disconnect', 'Could not disconnect', () => api.adConversions.disconnect(), 'Disconnected');
  };
  const syncSpend = () => run('adSpend.sync', 'Could not read ad spend', () => api.adConversions.syncSpend(), 'Ad spend updated', setSyncing);
  const saveAccounts = () => run('adSpend.accounts', 'Could not save', () => api.adConversions.saveSpendAccounts(accounts), 'Ad accounts saved');

  const save = async () => {
    setSaving(true);
    try {
      const v = await api.adConversions.save({ enabled, datasetId, testCode, rules, ...(token ? { token } : {}) });
      apply(v);
      toast('Ad conversions saved', v.enabled ? (v.testCode ? 'Test mode: events show in Events Manager › Test events only.' : 'Lead results now go to Meta.') : 'Switched off.', 'success');
    } catch (e) {
      toast('Could not save', toAppError(reportError('adConversions.save', e)).userMessage, 'alert');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.adConversions.test(testCode);
      toast(r.ok ? 'Test event sent' : 'Test failed', r.message, r.ok ? 'success' : 'alert');
    } catch (e) {
      toast('Test failed', toAppError(reportError('adConversions.test', e)).userMessage, 'alert');
    } finally {
      setTesting(false);
    }
  };

  const setRule = (i: number, patch: Partial<AdConversionRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const choices = (when: AdConversionRule['when']): Array<[string, string]> =>
    when === 'stage'
      ? stageOptions.filter((s) => s !== 'Trash' && s !== 'Permanently Deleted').map((s) => [s, s])
      : [['done', 'Done (Completed or Walk-In)'], ...Object.values(SITE_VISIT).map((s): [string, string] => [s, s])];

  if (error) return <InlineNotice tone="warning">{error}</InlineNotice>;
  if (!view) return <p className="text-xs text-[#5E778C]">Loading…</p>;

  const viaFacebook = view.tokenSet && view.connectedVia === 'facebook';
  const nonInr = view.spend.currencies.filter((c) => c && c !== 'INR');
  const accountsDirty = accounts.slice().sort().join() !== view.spend.accounts.filter((a) => a.included).map((a) => a.id).sort().join();

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><Plug size={16} className="text-[#0B6BB0]" /> Meta ad account</span>}
        subtitle="One Facebook connection for everything on this page.">
        <div className="space-y-4">
          {view.tokenSet ? (
            <div className="rounded-xl border border-[#BFE3CF] bg-[#F1FAF5] p-3 flex flex-wrap items-center gap-3">
              <CheckCircle2 size={18} className="text-[#067647] flex-shrink-0" />
              <span className="min-w-0 flex-1 text-xs text-[#0B2A44]">
                <b className="block text-sm">{viaFacebook ? 'Connected with Facebook' : 'Connected (entered by hand)'}</b>
                Dataset {view.datasetName ? <b>{view.datasetName}</b> : null} <span className="font-mono">{view.datasetId}</span>
                {viaFacebook && (view.tokenExpiresAt
                  ? <span className={new Date(view.tokenExpiresAt).getTime() - Date.now() < 7 * 864e5 ? ' text-[#9A3412] font-semibold' : ' text-[#5E778C]'}> · access ends {new Date(view.tokenExpiresAt).toLocaleDateString()}, connect again before then</span>
                  : <span className="text-[#5E778C]"> · access does not expire</span>)}
              </span>
              {editable && view.connectAvailable && <a href={view.connectUrl} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#D3E3F0] bg-white text-xs font-semibold text-[#0B2A44] hover:bg-[#F2F7FB]"><Plug size={13} />Connect again</a>}
              {editable && <Button variant="secondary" size="sm" icon={<Unplug size={13} />} loading={busy} onClick={disconnect}>Disconnect</Button>}
            </div>
          ) : editable && view.connectAvailable ? (
            <div className="rounded-xl border border-[#BFD9EE] bg-[#F5FAFE] p-4 flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 text-xs text-[#2B4A63]">
                <b className="block text-sm text-[#0B2A44]">Connect your Meta ad account</b>
                Sign in with Facebook and allow the ad account and its dataset (Pixel). Nothing to copy or paste.
              </span>
              <a href={view.connectUrl} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1877F2] text-sm font-semibold text-white hover:brightness-110">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="currentColor"><path d="M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.62 23.1 24 18.1 24 12.07z" /></svg>
                Connect with Facebook
              </a>
            </div>
          ) : !view.connectAvailable ? (
            <InlineNotice tone="info">Facebook is not set up on this platform yet (Super Admin › Settings › Meta).{conversionsOn ? ' You can still enter a dataset ID and token by hand.' : ''}</InlineNotice>
          ) : null}

          {view.pending && view.pending.length > 0 && editable && (
            <div className="rounded-xl border border-[#F5D9A8] bg-[#FFF9EE] p-3">
              <p className="text-xs font-semibold text-[#0B2A44] mb-2">Facebook gave access to {view.pending.length} datasets. Which one is this project’s?</p>
              <ul className="divide-y divide-[#F3E6CC]">
                {view.pending.map((ds) => (
                  <li key={ds.id} className="py-2 flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-xs"><b className="text-[#0B2A44]">{ds.name}</b> <span className="font-mono text-[#5E778C]">{ds.id}</span>{ds.account && <span className="text-[#7E93A6]"> · {ds.account}</span>}</span>
                    <Button variant="primary" size="sm" loading={busy} onClick={() => void choose(ds.id)}>Use this one</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {conversionsOn && editable && view.connectAvailable && (
            <button type="button" onClick={() => setManual((m) => !m)} aria-expanded={manual} className="inline-flex items-center gap-1 text-xs font-semibold text-[#0B5E9C] hover:underline">
              <ChevronDown size={13} className={manual ? 'rotate-180 transition-transform' : 'transition-transform'} />
              Or enter the dataset ID and token by hand (lead results only)
            </button>
          )}
          {conversionsOn && (manual || !view.connectAvailable || !editable) && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Dataset (Pixel) ID" hint="Events Manager › your dataset › Settings.">
                <input className={inputCls} inputMode="numeric" value={datasetId} disabled={!editable} onChange={(e) => setDatasetId(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 1234567890123456" />
              </Field>
              <Field label="Conversions API access token" hint={view.tokenSet ? 'A token is saved. Paste a new one only to replace it, then Save below.' : 'Events Manager › Settings › Conversions API › Generate access token. Then Save below.'}>
                <input className={inputCls} type="password" autoComplete="off" value={token} disabled={!editable} onChange={(e) => setToken(e.target.value.trim())} placeholder={view.tokenSet ? '•••••••• saved' : 'Paste the token'} />
              </Field>
            </div>
          )}
        </div>
      </Card>

      {conversionsOn && (
        <>
          <Card
            title={<span className="inline-flex items-center gap-2"><Target size={16} className="text-[#0B6BB0]" /> Lead results to Meta (Conversions API)</span>}
            subtitle="When a lead becomes Qualified, has a site visit or books, the CRM tells your Meta ad account. Facebook and Instagram ads then learn which enquiries turn into buyers, instead of finding more people who just fill forms."
          >
            <div className="space-y-4">
              <label className={`flex items-start gap-3 ${editable ? 'cursor-pointer' : 'opacity-60'}`}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#0B2A44]" checked={enabled} disabled={!editable} onChange={(e) => setEnabled(e.target.checked)} />
                <span>
                  <span className="block text-sm font-semibold text-[#0B2A44]">Send lead results to Meta</span>
                  <span className="block text-xs text-[#5E778C] mt-0.5">Each result is sent once per lead. Phone numbers and e-mails are hashed first; Meta never receives them in plain text.</span>
                </span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Test event code (optional)" hint="While this is filled in, events show only under Events Manager › Test events. Empty it to send real events.">
                  <input className={inputCls} value={testCode} disabled={!editable} onChange={(e) => setTestCode(e.target.value.trim().toUpperCase())} placeholder="TEST12345" />
                </Field>
              </div>
            </div>
          </Card>

          <Card title="What is sent, and when" subtitle="Meta shows these names in Events Manager. In Ads Manager, choose one of them as the goal of a lead campaign (conversion leads).">
            <div className="space-y-2">
              {rules.map((r, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_minmax(0,1.3fr)_36px] items-center">
                  <input className={inputCls} aria-label="Event name" value={r.event} maxLength={40} disabled={!editable} onChange={(e) => setRule(i, { event: e.target.value })} />
                  <select className={inputCls} aria-label="When" value={r.when} disabled={!editable} onChange={(e) => setRule(i, { when: e.target.value as AdConversionRule['when'], value: '' })}>
                    <option value="stage">Lead stage is</option>
                    <option value="siteVisit">Site visit is</option>
                  </select>
                  <select className={inputCls} aria-label="Value" value={r.value} disabled={!editable} onChange={(e) => setRule(i, { value: e.target.value })}>
                    <option value="">Choose…</option>
                    {choices(r.when).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                  {editable && <button type="button" aria-label={`Remove ${r.event}`} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-[#9A3412] hover:bg-[#FDF2EC]"><Trash2 size={14} /></button>}
                </div>
              ))}
              {editable && rules.length < 10 && (
                <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setRules((rs) => [...rs, { event: '', when: 'stage', value: '' }])}>Add an event</Button>
              )}
            </div>
          </Card>

          {editable ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={test} loading={testing} icon={<FlaskConical size={13} />} disabled={!view.tokenSet || !view.datasetId}>Send a test event</Button>
              <Button variant="primary" onClick={() => void save()} loading={saving} icon={<Save size={13} />}>Save</Button>
            </div>
          ) : (
            <InlineNotice tone="info">Only an administrator can change these settings.</InlineNotice>
          )}

          <Card title="Recently sent" subtitle={`Last 30 days: ${view.last30.sent} sent · ${view.last30.failed} retrying · ${view.last30.skipped + view.last30.expired} not sent`}>
            {view.recent.length ? (
              <ul className="divide-y divide-[#EEF4F9] text-xs">
                {view.recent.map((r) => (
                  <li key={r.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    <b className="text-[#0B2A44]">{r.event}</b>
                    <button type="button" className="text-[#0B5E9C] hover:underline" onClick={() => onOpenLead?.(r.leadId)}>{r.leadName || r.leadId}</button>
                    {r.matchedBy && <span className="text-[#5E778C]">matched by {r.matchedBy}</span>}
                    <span className="text-[#7E93A6] ml-auto">{new Date(r.at).toLocaleString()}</span>
                    {r.error && <span className="basis-full text-[#9A3412]">{r.error}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[#5E778C]">Nothing sent yet. Results appear here when a lead reaches one of the steps above.</p>
            )}
          </Card>
        </>
      )}

      {spendOn && (
        <Card
          title={<span className="inline-flex items-center gap-2"><IndianRupee size={16} className="text-[#0B6BB0]" /> Ad spend from Meta</span>}
          subtitle="Every morning the CRM reads what each Facebook / Instagram campaign spent this month and last month. Sales MIS › Cost per lead, site visit and booking then fills itself; no typing from Ads Manager."
          actions={editable && viaFacebook ? <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} loading={syncing} onClick={() => void syncSpend()}>Sync now</Button> : undefined}
        >
          {!viaFacebook ? (
            <p className="text-xs text-[#5E778C]">Connect with Facebook above to read ad spend. A dataset token typed in by hand cannot read it.</p>
          ) : (
            <div className="space-y-4 text-xs">
              {view.spend.error && <InlineNotice tone="warning">Last sync failed: {view.spend.error}</InlineNotice>}
              {nonInr.length > 0 && <InlineNotice tone="warning">An ad account is billed in {nonInr.join(', ')}. Sales MIS shows amounts as ₹ without converting them.</InlineNotice>}
              <Field label="Ad accounts to include">
                <div className="space-y-1.5">
                  {view.spend.accounts.length ? view.spend.accounts.map((a) => (
                    <label key={a.id} className={`flex items-center gap-2 ${editable ? 'cursor-pointer' : 'opacity-60'}`}>
                      <input type="checkbox" className="h-4 w-4 accent-[#0B2A44]" disabled={!editable} checked={accounts.includes(a.id)} onChange={(e) => setAccounts((xs) => (e.target.checked ? [...xs, a.id] : xs.filter((x) => x !== a.id)))} />
                      <span className="text-[#0B2A44]"><b>{a.name}</b> <span className="font-mono text-[#7E93A6]">{a.id.replace(/^act_/, '')}</span>{a.currency && <span className="text-[#7E93A6]"> · {a.currency}</span>}</span>
                    </label>
                  )) : <span className="text-[#5E778C]">Facebook did not give access to any ad account. Connect again and allow the ad account.</span>}
                </div>
              </Field>
              {editable && accountsDirty && <Button variant="primary" size="sm" icon={<Save size={13} />} loading={busy} disabled={!accounts.length} onClick={() => void saveAccounts()}>Save ad accounts</Button>}
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[#2B4A63]">
                {view.spend.months.map((m) => <span key={m.month}>{monthLabel(m.month)}: <b className="tabular-nums">₹{Math.round(m.total).toLocaleString('en-IN')}</b></span>)}
                <span className="text-[#7E93A6]">{view.spend.syncedAt ? `Updated ${new Date(view.spend.syncedAt).toLocaleString()}` : 'Not synced yet. Click Sync now.'}</span>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};
