/**
 * Settings › Google (server: modules/googleMarketing.ts). One "Connect with Google" for Google Ads and Business
 * Profile; GA4 keys typed in. Parts shown by plan feature: lead results (googleConversions), ad spend
 * (googleAdsSpend), Business Profile location (socialInbox / socialPosts).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, CheckCircle2, FlaskConical, IndianRupee, MapPin, Plug, RefreshCw, Save, Target, Unplug } from 'lucide-react';
import { api, type GoogleMarketingView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { useFeature } from '../../core/tenant';
import { Badge, Button, Card, Field, InlineNotice, inputCls } from '../../components/ui';
import { Permission } from '../../core/rbac';
import { ConversionRulesCard } from './ConversionRulesCard';
import { SearchConsoleCard } from './SearchConsoleCard';

const monthLabel = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

export const GoogleSection: React.FC<{ can: (p: Permission) => boolean; stageOptions: string[] }> = ({ can, stageOptions }) => {
  const editable = can('integrations.connect');
  const conversionsOn = useFeature('googleConversions');
  const spendOn = useFeature('googleAdsSpend');
  const inboxOn = useFeature('socialInbox');
  const postsOn = useFeature('socialPosts');
  const gbpOn = inboxOn || postsOn;
  const analyticsOn = useFeature('websiteAnalytics');
  const adsControlOn = useFeature('adsControl');
  // with only Search Console on, the "Connect with Google" account below does not apply and is not reachable
  const marketingOn = conversionsOn || spendOn || gbpOn || analyticsOn || adsControlOn;
  const [v, setV] = useState<GoogleMarketingView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [actions, setActions] = useState<Array<{ resourceName: string; name: string; type: string }> | null>(null);
  const [form, setForm] = useState({ adsCustomerId: '', adsEnabled: false, map: {} as Record<string, string>, ga4Enabled: false, measurementId: '', apiSecret: '', gbpLocation: '', ga4PropertyId: '' });

  const apply = (x: GoogleMarketingView) => {
    setV(x);
    setForm({ adsCustomerId: x.adsCustomerId, adsEnabled: x.adsConversions.enabled, map: x.adsConversions.actions, ga4Enabled: x.ga4.enabled, measurementId: x.ga4.measurementId, apiSecret: '', gbpLocation: x.gbpLocation?.name || '', ga4PropertyId: x.ga4PropertyId });
  };
  const load = useCallback(async () => {
    try {
      apply(await api.googleMarketing.get());
      if (conversionsOn) setEvents((await api.conversionRules.get()).rules.map((r) => r.event));
    } catch (e) {
      setError(errText('google.get', e));
    }
  }, [conversionsOn]);
  useEffect(() => { if (marketingOn) void load(); }, [load, marketingOn]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const err = q.get('gmktError'), ok = q.get('gmktConnected');
    if (err) toast('Google not connected', err.slice(0, 300), 'alert');
    else if (ok) toast('Google connected', 'Choose the Google Ads account and Business Profile location below.', 'success');
    if (err || ok) {
      q.delete('gmktError');
      q.delete('gmktConnected');
      const rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : ''));
    }
  }, []);

  const run = async (key: string, scope: string, fn: () => Promise<GoogleMarketingView>, done?: string) => {
    setBusy(key);
    try {
      apply(await fn());
      if (done) toast(done, undefined, 'success');
    } catch (e) {
      toast('Something went wrong', errText(scope, e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const loadActions = async () => {
    setBusy('actions');
    try {
      setActions(await api.googleMarketing.conversionActions());
    } catch (e) {
      toast('Could not read the conversion actions', errText('google.actions', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const save = () => run('save', 'google.save', () => api.googleMarketing.save({
    adsCustomerId: form.adsCustomerId,
    ...(conversionsOn ? {
      adsConversions: { enabled: form.adsEnabled, actions: form.map },
      ga4: { enabled: form.ga4Enabled, measurementId: form.measurementId, ...(form.apiSecret ? { apiSecret: form.apiSecret } : {}) },
    } : {}),
    ...(gbpOn ? { gbpLocation: form.gbpLocation } : {}),
    ...(analyticsOn ? { ga4PropertyId: form.ga4PropertyId } : {}),
  }), 'Google settings saved');
  const testGa4 = async () => {
    setBusy('ga4');
    try {
      const r = await api.googleMarketing.testGa4();
      toast(r.ok ? 'Google Analytics keys work' : 'Google Analytics refused', r.message, r.ok ? 'success' : 'alert');
    } catch (e) {
      toast('Test failed', errText('google.ga4', e), 'alert');
    } finally {
      setBusy('');
    }
  };

  if (!marketingOn) return <SearchConsoleCard editable={editable} />;
  if (error) return <div className="space-y-5"><InlineNotice tone="warning">{error}</InlineNotice><SearchConsoleCard editable={editable} /></div>;
  if (!v) return <p className="text-xs text-[#5E778C]">Loading…</p>;
  const accounts = v.adsCustomers.filter((c) => !c.manager);
  const actionName = (rn: string) => actions?.find((a) => a.resourceName === rn)?.name || rn.split('/').pop();

  return (
    <div className="space-y-5">
      <Card title={<span className="inline-flex items-center gap-2"><Plug size={16} className="text-[#0B6BB0]" /> Google account</span>} subtitle="One Google sign-in for Google Ads and Google Business Profile.">
        <div className="space-y-3 text-xs">
          {!v.available && <InlineNotice tone="warning">“Connect with Google” is not set up on this platform yet (Super Admin › Settings › Google).</InlineNotice>}
          {v.available && !v.developerTokenSet && (conversionsOn || spendOn) && <InlineNotice tone="info">Google Ads needs the platform developer token (Super Admin › Settings › Marketing apps). Business Profile and Analytics work without it.</InlineNotice>}
          {v.connected ? (
            <div className="rounded-xl border border-[#BFE3CF] bg-[#F1FAF5] p-3 flex flex-wrap items-center gap-3">
              <CheckCircle2 size={18} className="text-[#067647]" />
              <span className="min-w-0 flex-1 text-[#0B2A44]">
                <b className="block text-sm">Connected as {v.email}</b>
                <span className="inline-flex gap-1.5 mt-1">{v.adsAccess && <Badge tone="sage">Google Ads</Badge>}{v.businessAccess && <Badge tone="sage">Business Profile</Badge>}</span>
              </span>
              {editable && <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} loading={busy === 'refresh'} onClick={() => void run('refresh', 'google.refresh', () => api.googleMarketing.refresh(), 'Accounts refreshed')}>Refresh accounts</Button>}
              {editable && <a href={v.connectUrl} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#D3E3F0] bg-white font-semibold text-[#0B2A44] hover:bg-[#F2F7FB]"><Plug size={13} />Connect again</a>}
              {editable && <Button variant="secondary" size="sm" icon={<Unplug size={13} />} loading={busy === 'disconnect'} onClick={() => window.confirm('Disconnect Google? Lead results, spend and reviews from Google stop.') && void run('disconnect', 'google.disconnect', () => api.googleMarketing.disconnect(), 'Disconnected')}>Disconnect</Button>}
            </div>
          ) : editable && v.available ? (
            <div className="rounded-xl border border-[#BFD9EE] bg-[#F5FAFE] p-4 flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 text-[#2B4A63]"><b className="block text-sm text-[#0B2A44]">Connect your Google account</b>Use the Google account that manages the ad account and the Business Profile. Tick both permissions on Google’s screen.</span>
              <a href={v.connectUrl} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1A73E8] text-sm font-semibold text-white hover:brightness-110">Connect with Google</a>
            </div>
          ) : null}
          {v.setupError && <InlineNotice tone="warning">{v.setupError}</InlineNotice>}
          {v.connected && v.adsAccess && (conversionsOn || spendOn) && (
            <Field label="Google Ads account">
              <select className={inputCls} value={form.adsCustomerId} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, adsCustomerId: e.target.value }))}>
                <option value="">{accounts.length ? 'Choose…' : 'No ad account found (Refresh accounts)'}</option>
                {accounts.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')}){c.currency ? ` · ${c.currency}` : ''}</option>)}
              </select>
            </Field>
          )}
        </div>
      </Card>

      {conversionsOn && (
        <>
          <Card title={<span className="inline-flex items-center gap-2"><Target size={16} className="text-[#0B6BB0]" /> Lead results to Google Ads</span>}
            subtitle="Each event below is uploaded to the Google Ads conversion action you choose, matched by the Google click (gclid) and the hashed phone / e-mail. Create an “Import › CRM / click conversions” action in Google Ads first.">
            <div className="space-y-3 text-xs">
              <label className={`flex items-start gap-3 ${editable ? 'cursor-pointer' : 'opacity-60'}`}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#0B2A44]" checked={form.adsEnabled} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, adsEnabled: e.target.checked }))} />
                <span className="text-sm font-semibold text-[#0B2A44]">Send lead results to Google Ads</span>
              </label>
              {editable && <Button variant="secondary" size="sm" loading={busy === 'actions'} disabled={!form.adsCustomerId} onClick={() => void loadActions()}>{actions ? 'Reload conversion actions' : 'Load conversion actions'}</Button>}
              {events.map((ev) => (
                <div key={ev} className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)] items-center">
                  <b className="text-[#0B2A44]">{ev}</b>
                  <select className={inputCls} value={form.map[ev] || ''} disabled={!editable || !actions} onChange={(e) => setForm((f) => ({ ...f, map: { ...f.map, [ev]: e.target.value } }))}>
                    <option value="">{form.map[ev] && !actions ? `Chosen: ${actionName(form.map[ev])}` : 'Not sent to Google Ads'}</option>
                    {(actions || []).map((a) => <option key={a.resourceName} value={a.resourceName}>{a.name} · {a.type.toLowerCase().replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </Card>
          <Card title={<span className="inline-flex items-center gap-2"><BarChart3 size={16} className="text-[#0B6BB0]" /> Lead results to Google Analytics (GA4)</span>}
            subtitle="Sent for leads whose website form included the visitor’s _ga cookie (add a hidden _ga field to the form; the integration guide shows how).">
            <div className="space-y-3 text-xs">
              <label className={`flex items-start gap-3 ${editable ? 'cursor-pointer' : 'opacity-60'}`}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#0B2A44]" checked={form.ga4Enabled} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, ga4Enabled: e.target.checked }))} />
                <span className="text-sm font-semibold text-[#0B2A44]">Send lead results to Google Analytics</span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Measurement ID" hint="GA4 › Admin › Data streams › your web stream."><input className={inputCls} value={form.measurementId} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, measurementId: e.target.value.trim().toUpperCase() }))} placeholder="G-ABC123XYZ" /></Field>
                <Field label="Measurement Protocol API secret" hint={v.ga4.secretSet ? 'Saved. Paste a new one only to replace it.' : 'Same stream › Measurement Protocol API secrets › Create.'}><input className={inputCls} type="password" autoComplete="off" value={form.apiSecret} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, apiSecret: e.target.value.trim() }))} placeholder={v.ga4.secretSet ? '•••••• saved' : ''} /></Field>
              </div>
              {editable && <Button variant="secondary" size="sm" icon={<FlaskConical size={13} />} loading={busy === 'ga4'} disabled={!v.ga4.secretSet} onClick={() => void testGa4()}>Check the GA4 keys</Button>}
            </div>
          </Card>
          <ConversionRulesCard editable={editable} stageOptions={stageOptions} onSaved={(rules) => setEvents(rules.map((r) => r.event))} subtitle="The same events go to Meta and Google (whichever is switched on)." />
        </>
      )}

      {gbpOn && v.connected && v.businessAccess && (
        <Card title={<span className="inline-flex items-center gap-2"><MapPin size={16} className="text-[#0B6BB0]" /> Google Business Profile</span>} subtitle="Reviews of this location come into the social inbox; posts can be published to it.">
          <Field label="Location">
            <select className={inputCls} value={form.gbpLocation} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, gbpLocation: e.target.value }))}>
              <option value="">{v.gbpLocations.length ? 'Choose…' : 'No location found (Refresh accounts)'}</option>
              {v.gbpLocations.map((l) => <option key={l.name} value={l.name}>{l.title}</option>)}
            </select>
          </Field>
        </Card>
      )}

      {analyticsOn && v.connected && (
        <Card title={<span className="inline-flex items-center gap-2"><BarChart3 size={16} className="text-[#0B6BB0]" /> Website analytics</span>} subtitle="The GA4 property whose visitors the Website Analytics screen shows.">
          {v.analyticsAccess ? (
            <Field label="Google Analytics property">
              <select className={inputCls} value={form.ga4PropertyId} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, ga4PropertyId: e.target.value }))}>
                <option value="">{v.ga4Properties.length ? 'Choose…' : 'No property found (Refresh accounts)'}</option>
                {v.ga4Properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          ) : <InlineNotice tone="info">Connect with Google again and allow “See your Google Analytics data”.</InlineNotice>}
        </Card>
      )}

      <SearchConsoleCard editable={editable} />

      {editable && v.connected && <div className="flex justify-end"><Button variant="primary" icon={<Save size={13} />} loading={busy === 'save'} onClick={() => void save()}>Save Google settings</Button></div>}

      {spendOn && (
        <Card title={<span className="inline-flex items-center gap-2"><IndianRupee size={16} className="text-[#0B6BB0]" /> Ad spend from Google Ads</span>}
          subtitle="Every morning each campaign’s cost (this month and last month) goes into Sales MIS › Cost per lead, site visit and booking. Google lead form leads also get the campaign’s name."
          actions={editable && v.adsCustomerId ? <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} loading={busy === 'spend'} onClick={() => void run('spend', 'google.spend', () => api.googleMarketing.syncSpend(), 'Google Ads spend updated')}>Sync now</Button> : undefined}>
          <div className="space-y-2 text-xs">
            {!v.adsCustomerId && <p className="text-[#5E778C]">Connect with Google and choose the Google Ads account above.</p>}
            {v.spend.error && <InlineNotice tone="warning">Last sync failed: {v.spend.error}</InlineNotice>}
            {v.spend.currency && v.spend.currency !== 'INR' && <InlineNotice tone="warning">The account is billed in {v.spend.currency}. Sales MIS shows amounts as ₹ without converting them.</InlineNotice>}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[#2B4A63]">
              {v.spend.months.map((m) => <span key={m.month}>{monthLabel(m.month)}: <b className="tabular-nums">₹{Math.round(m.total).toLocaleString('en-IN')}</b></span>)}
              <span className="text-[#7E93A6]">{v.spend.syncedAt ? `Updated ${new Date(v.spend.syncedAt).toLocaleString()}` : 'Not synced yet.'}</span>
            </div>
          </div>
        </Card>
      )}
      {!editable && <InlineNotice tone="info">Only an administrator can change these settings.</InlineNotice>}
    </div>
  );
};
