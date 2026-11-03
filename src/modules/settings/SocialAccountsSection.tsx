/**
 * Settings › Social accounts: the Facebook Pages (with Instagram) for the social inbox and post scheduler, and the
 * LinkedIn page and Pinterest board (server: modules/socialAccounts.ts, linkedin.ts, pinterest.ts).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Plug, Unplug } from 'lucide-react';
import { api, type SocialAccountsView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { useFeature } from '../../core/tenant';
import { Button, Card, InlineNotice } from '../../components/ui';
import { Permission } from '../../core/rbac';
import { LinkedInCard, PinterestCard } from './SocialAppsCards';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

/** Show the result of a return from Facebook / LinkedIn / Pinterest once, then clean the address bar. */
export function useReturnToast(keys: Array<[ok: string, err: string, label: string]>) {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    let touched = false;
    for (const [ok, err, label] of keys) {
      if (q.get(err)) toast(`${label} not connected`, String(q.get(err)).slice(0, 300), 'alert');
      else if (q.get(ok)) toast(`${label} connected`, String(q.get(ok)).slice(0, 200), 'success');
      if (q.has(ok) || q.has(err)) { q.delete(ok); q.delete(err); touched = true; }
    }
    if (q.get('socialNote')) { toast('Note', String(q.get('socialNote')).slice(0, 300), 'warning'); q.delete('socialNote'); touched = true; }
    if (touched) {
      const rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : ''));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export const SocialAccountsSection: React.FC<{ can: (p: Permission) => boolean }> = ({ can }) => {
  const editable = can('settings.edit');
  const linkedinOn = useFeature('linkedin');
  const pinterestOn = useFeature('pinterest');
  const inboxOn = useFeature('socialInbox');
  const postsOn = useFeature('socialPosts');
  const [v, setV] = useState<SocialAccountsView | null>(null);
  const [busy, setBusy] = useState('');
  useReturnToast([['socialConnected', 'socialError', 'Facebook']]);

  const load = useCallback(async () => {
    try {
      setV(await api.socialAccounts.get());
    } catch (e) {
      toast('Could not load the accounts', errText('social.get', e), 'alert');
    }
  }, []);
  useEffect(() => { if (inboxOn || postsOn) void load(); }, [load, inboxOn, postsOn]);

  const disconnect = async (id: string, name: string) => {
    if (!window.confirm(`Disconnect ${name}? Its comments and messages stop coming in and posts can no longer go to it.`)) return;
    setBusy(id);
    try {
      setV(await api.socialAccounts.disconnectPage(id));
    } catch (e) {
      toast('Could not disconnect', errText('social.disconnect', e), 'alert');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-5">
      {(inboxOn || postsOn) && (
        <Card title={<span className="inline-flex items-center gap-2"><Plug size={16} className="text-[#0B6BB0]" /> Facebook Pages and Instagram</span>}
          subtitle={`${inboxOn ? 'Comments and messages come into the Social Inbox. ' : ''}${postsOn ? 'Posts can be published to them.' : ''} Link each Instagram business account to its Facebook Page first.`}
          actions={editable && v?.available ? <a href={v.connectUrl} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#1877F2] text-xs font-semibold text-white hover:brightness-110">{v.pages.length ? 'Add or reconnect Pages' : 'Connect with Facebook'}</a> : undefined}>
          {!v ? <p className="text-xs text-[#5E778C]">Loading…</p> : (
            <div className="space-y-2 text-xs">
              {!v.available && <InlineNotice tone="warning">Facebook is not set up on this platform yet (Super Admin › Settings › Meta).</InlineNotice>}
              {v.note && <InlineNotice tone="warning">{v.note}</InlineNotice>}
              {v.pages.length ? (
                <ul className="divide-y divide-[#EEF4F9]">
                  {v.pages.map((p) => (
                    <li key={p.id} className="py-2 flex flex-wrap items-center gap-2">
                      <CheckCircle2 size={15} className="text-[#067647]" />
                      <span className="min-w-0 flex-1 text-[#0B2A44]"><b>{p.name}</b>{p.igUsername ? <span className="text-[#5E778C]"> · Instagram @{p.igUsername}</span> : <span className="text-[#9A3412]"> · no Instagram account linked</span>}</span>
                      {editable && <Button variant="secondary" size="xs" icon={<Unplug size={12} />} loading={busy === p.id} onClick={() => void disconnect(p.id, p.name)}>Disconnect</Button>}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[#5E778C]">No Page connected yet.</p>}
            </div>
          )}
        </Card>
      )}
      {linkedinOn && <LinkedInCard editable={editable} />}
      {pinterestOn && <PinterestCard editable={editable} />}
      {!editable && <InlineNotice tone="info">Only Platform support can connect accounts.</InlineNotice>}
    </div>
  );
};
