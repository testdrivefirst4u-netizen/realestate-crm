/**
 * Settings › Google › Search Console (server: modules/searchConsole.ts): its own connect, asking Google only for Search
 * Console, and the website the Search Console report shows. Shown only when the feature is on for the company.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, Search, Unplug } from 'lucide-react';
import { api, type SearchConsoleView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { useFeature } from '../../core/tenant';
import { Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const SearchConsoleCard: React.FC<{ editable: boolean }> = ({ editable }) => {
  const on = useFeature('searchConsole');
  const [v, setV] = useState<SearchConsoleView | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setV(await api.searchConsole.get());
    } catch (e) {
      toast('Could not load Search Console', errText('gsc.get', e), 'alert');
    }
  }, []);
  useEffect(() => { if (on) void load(); }, [on, load]);

  // the result of coming back from Google, once
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const err = q.get('gscError'), ok = q.get('gscConnected');
    if (!err && !ok) return;
    if (err) toast('Search Console not connected', err.slice(0, 300), 'alert');
    else toast('Search Console connected', undefined, 'success');
    q.delete('gscError');
    q.delete('gscConnected');
    const rest = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
  }, []);

  const act = async (name: string, run: () => Promise<SearchConsoleView>, done?: string) => {
    setBusy(name);
    try {
      setV(await run());
      if (done) toast(done, undefined, 'success');
    } catch (e) {
      toast('Not changed', errText(`gsc.${name}`, e), 'alert');
    } finally {
      setBusy('');
    }
  };

  if (!on) return null;
  const connect = v && <a href={v.connectUrl} className="inline-flex items-center gap-2 rounded-lg bg-[#1A73E8] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110">{v.connected ? 'Connect again' : 'Connect Search Console'}</a>;

  return (
    <Card title={<span className="inline-flex items-center gap-2"><Search size={16} className="text-[#0B6BB0]" /> Search Console</span>}
      subtitle="Your website's Google search clicks, top searches and indexed pages, on the Search Console screen. Read only."
      actions={editable ? connect || undefined : undefined}>
      {!v ? <p className="text-xs text-[#5E778C]">Loading…</p> : (
        <div className="space-y-3 text-xs text-[#0B2A44]">
          {v.setupError && <InlineNotice tone="warning">{v.setupError}</InlineNotice>}
          {!v.connected ? (
            <p className="text-[#5E778C]">Use a Google account that is an owner or user of your website in Search Console.</p>
          ) : (
            <>
              <p className="inline-flex items-center gap-1.5"><CheckCircle2 size={15} className="text-[#067647]" /> Connected as <b>{v.email}</b></p>
              <Field label="Website">
                <select className={inputCls} value={v.siteUrl} disabled={!editable || busy === 'save'} onChange={(e) => void act('save', () => api.searchConsole.save(e.target.value), 'Website saved')}>
                  <option value="">{v.sites.length ? 'Choose…' : 'No website found'}</option>
                  {v.sites.map((s) => <option key={s} value={s}>{s.replace(/^sc-domain:/, '')}</option>)}
                </select>
              </Field>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="xs" icon={<RefreshCw size={12} />} loading={busy === 'refresh'} onClick={() => void act('refresh', () => api.searchConsole.refresh())}>Refresh websites</Button>
                  <Button variant="secondary" size="xs" icon={<Unplug size={12} />} loading={busy === 'disconnect'} onClick={() => { if (window.confirm('Disconnect Search Console? The saved page checks are removed.')) void act('disconnect', () => api.searchConsole.disconnect(), 'Disconnected'); }}>Disconnect</Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
};
