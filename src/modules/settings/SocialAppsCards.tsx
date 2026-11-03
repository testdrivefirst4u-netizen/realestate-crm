/**
 * Settings › Social accounts: LinkedIn (company page for posts, ad account for Lead Gen Form leads) and Pinterest
 * (board for pins). Server: modules/linkedin.ts, modules/pinterest.ts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, Unplug } from 'lucide-react';
import { api, type LinkedInView, type PinterestView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';
import { useReturnToast } from './SocialAccountsSection';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const linkCls = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold text-white hover:brightness-110';

export const LinkedInCard: React.FC<{ editable: boolean }> = ({ editable }) => {
  const [v, setV] = useState<LinkedInView | null>(null);
  const [busy, setBusy] = useState('');
  useReturnToast([['linkedinConnected', 'linkedinError', 'LinkedIn']]);
  const load = useCallback(async () => {
    try { setV(await api.linkedin.get()); } catch (e) { toast('Could not load LinkedIn', errText('linkedin.get', e), 'alert'); }
  }, []);
  useEffect(() => void load(), [load]);
  const run = async (key: string, fn: () => Promise<LinkedInView>, done?: string) => {
    setBusy(key);
    try { setV(await fn()); if (done) toast(done, undefined, 'success'); } catch (e) { toast('Something went wrong', errText('linkedin.' + key, e), 'alert'); } finally { setBusy(''); }
  };
  const sync = async () => {
    setBusy('sync');
    try {
      const r = await api.linkedin.syncLeads();
      toast('LinkedIn leads checked', `${r.received} received · ${r.created} new`, 'success');
      setV(await api.linkedin.get());
    } catch (e) { toast('Could not read LinkedIn leads', errText('linkedin.sync', e), 'alert'); } finally { setBusy(''); }
  };

  return (
    <Card title="LinkedIn" subtitle="Posts go to your company page; Lead Gen Form leads come in every 10 minutes (needs LinkedIn’s Lead Sync approval)."
      actions={editable && v?.available ? <a href={v.connectUrl} className={`${linkCls} bg-[#0A66C2]`}>{v.connected ? 'Connect again' : 'Connect LinkedIn'}</a> : undefined}>
      {!v ? <p className="text-xs text-[#5E778C]">Loading…</p> : (
        <div className="space-y-3 text-xs">
          {!v.available && <InlineNotice tone="warning">LinkedIn is not set up on this platform yet (Super Admin › Settings › Marketing apps).</InlineNotice>}
          {v.connected && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[#0B2A44]"><CheckCircle2 size={15} className="text-[#067647]" /> Connected{v.expiresAt && <span className="text-[#9A3412]"> · connect again before {new Date(v.expiresAt).toLocaleDateString()}</span>}
                {editable && <Button variant="secondary" size="xs" className="ml-auto" icon={<Unplug size={12} />} loading={busy === 'disconnect'} onClick={() => window.confirm('Disconnect LinkedIn?') && void run('disconnect', () => api.linkedin.disconnect(), 'Disconnected')}>Disconnect</Button>}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Company page for posts">
                  <select className={inputCls} value={v.orgUrn} disabled={!editable} onChange={(e) => void run('org', () => api.linkedin.save({ orgUrn: e.target.value }), 'Saved')}>
                    <option value="">Choose…</option>
                    {v.orgs.map((o) => <option key={o.urn} value={o.urn}>{o.name}</option>)}
                  </select>
                </Field>
                <Field label="Ad account for Lead Gen Form leads" hint={v.leadAccess ? (v.leadsSince ? `Checked ${new Date(v.leadsSince).toLocaleString()}` : 'Not checked yet') : 'Use “Connect for lead forms” to allow reading leads.'}>
                  <select className={inputCls} value={v.leadAccount} disabled={!editable || !v.leadAccess} onChange={(e) => void run('leads', () => api.linkedin.save({ leadAccount: e.target.value }), 'Saved')}>
                    <option value="">Not reading leads</option>
                    {v.adAccounts.map((a) => <option key={a.urn} value={a.urn}>{a.name}</option>)}
                  </select>
                </Field>
              </div>
              {v.leadsError && <InlineNotice tone="warning">Last lead check failed: {v.leadsError}</InlineNotice>}
              <div className="flex flex-wrap gap-2">
                {editable && !v.leadAccess && <a href={`${v.connectUrl}?leads=1`} className={`${linkCls} bg-[#0A66C2]`}>Connect for lead forms</a>}
                {editable && v.leadAccount && <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} loading={busy === 'sync'} onClick={() => void sync()}>Check for leads now</Button>}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
};

export const PinterestCard: React.FC<{ editable: boolean }> = ({ editable }) => {
  const [v, setV] = useState<PinterestView | null>(null);
  const [busy, setBusy] = useState(false);
  useReturnToast([['pinterestConnected', 'pinterestError', 'Pinterest']]);
  useEffect(() => { api.pinterest.get().then(setV, (e) => toast('Could not load Pinterest', errText('pinterest.get', e), 'alert')); }, []);
  const save = async (boardId: string) => {
    setBusy(true);
    try { setV(await api.pinterest.save({ boardId })); toast('Board saved', undefined, 'success'); } catch (e) { toast('Could not save', errText('pinterest.save', e), 'alert'); } finally { setBusy(false); }
  };
  return (
    <Card title="Pinterest" subtitle="Posts with an image can be pinned to a board."
      actions={editable && v?.available ? <a href={v.connectUrl} className={`${linkCls} bg-[#E60023]`}>{v.connected ? 'Connect again' : 'Connect Pinterest'}</a> : undefined}>
      {!v ? <p className="text-xs text-[#5E778C]">Loading…</p> : (
        <div className="space-y-3 text-xs">
          {!v.available && <InlineNotice tone="warning">Pinterest is not set up on this platform yet (Super Admin › Settings › Marketing apps).</InlineNotice>}
          {v.connected && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[#0B2A44]"><CheckCircle2 size={15} className="text-[#067647]" /> Connected{v.username && <> as <b>{v.username}</b></>}
                {editable && <Button variant="secondary" size="xs" className="ml-auto" icon={<Unplug size={12} />} onClick={() => window.confirm('Disconnect Pinterest?') && void api.pinterest.disconnect().then(setV)}>Disconnect</Button>}
              </div>
              <Field label="Board">
                <select className={inputCls} value={v.boardId} disabled={!editable || busy} onChange={(e) => void save(e.target.value)}>
                  <option value="">Choose…</option>
                  {v.boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
            </>
          )}
        </div>
      )}
    </Card>
  );
};
