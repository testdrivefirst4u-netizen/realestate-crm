'use client';
/**
 * Platform settings → Marketing apps (server: server/platform/marketingApps.ts): the Google Ads developer token,
 * the LinkedIn and Pinterest apps and the Facebook configuration of the social inbox / post scheduler.
 * Secrets are write-only (an empty box keeps the saved one).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Megaphone, Save } from 'lucide-react';
import { call, errorMessage, useResource } from '../../_lib/api';
import { fmtDateTime } from '../../_lib/format';
import { CopyRow } from '../../_components/SecretPanel';
import { useToast } from '../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, Skeleton, TextField } from '../../_components/ui';
import { Guide } from './SettingsParts';

interface Form {
  googleAdsDeveloperToken: string;
  googleAdsLoginCustomerId: string;
  googleAdsApiVersion: string;
  linkedinClientId: string;
  linkedinClientSecret: string;
  linkedinVersion: string;
  pinterestAppId: string;
  pinterestAppSecret: string;
  metaSocialConfigId: string;
}
const EMPTY: Form = { googleAdsDeveloperToken: '', googleAdsLoginCustomerId: '', googleAdsApiVersion: '', linkedinClientId: '', linkedinClientSecret: '', linkedinVersion: '', pinterestAppId: '', pinterestAppSecret: '', metaSocialConfigId: '' };

export function MarketingAppsCard() {
  const toast = useToast();
  const res = useResource(() => call('getMarketingApps', {}), []);
  const s = res.data;
  const [f, setF] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (s) setF({ ...EMPTY, googleAdsLoginCustomerId: s.googleAds.loginCustomerId, googleAdsApiVersion: s.googleAds.apiVersion, linkedinClientId: s.linkedin.clientId, linkedinVersion: s.linkedin.version, pinterestAppId: s.pinterest.appId, metaSocialConfigId: s.metaSocialConfigId });
  }, [s]);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => { setF((p) => ({ ...p, [k]: e.target.value })); setError(''); };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // secrets: only sent when typed (an empty box keeps the saved one)
      const patch: Record<string, string> = { googleAdsLoginCustomerId: f.googleAdsLoginCustomerId, googleAdsApiVersion: f.googleAdsApiVersion, linkedinClientId: f.linkedinClientId, linkedinVersion: f.linkedinVersion, pinterestAppId: f.pinterestAppId, metaSocialConfigId: f.metaSocialConfigId };
      for (const k of ['googleAdsDeveloperToken', 'linkedinClientSecret', 'pinterestAppSecret'] as const) if (f[k].trim()) patch[k] = f[k].trim();
      res.setData(await call('setMarketingApps', patch));
      setF((p) => ({ ...p, googleAdsDeveloperToken: '', linkedinClientSecret: '', pinterestAppSecret: '' }));
      toast('Marketing apps saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader icon={<Megaphone className="h-5 w-5" aria-hidden />} title="Marketing apps"
        description="Keys of the platform's own developer apps. Each company then connects its own Google Ads, LinkedIn page and Pinterest account in Settings." />
      {!s ? (
        <div className="space-y-3 p-5"><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /></div>
      ) : (
        <form onSubmit={save} className="space-y-6 p-5">
          <section className="space-y-3">
            <h3 className="text-[15px] font-semibold text-[#0A1F33]">Google Ads API</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="Developer token" type="password" autoComplete="off" value={f.googleAdsDeveloperToken} onChange={set('googleAdsDeveloperToken')} placeholder={s.googleAds.tokenSet ? '•••••• saved' : 'From Tools › API Center'} hint="Google Ads manager account › Tools › API Center." />
              <TextField label="Manager account ID" value={f.googleAdsLoginCustomerId} onChange={set('googleAdsLoginCustomerId')} placeholder="123-456-7890" hint="The manager (MCC) account the token belongs to." />
              <TextField label="API version" value={f.googleAdsApiVersion} onChange={set('googleAdsApiVersion')} placeholder="v26" hint="Change only when Google retires this version (developers.google.com/google-ads/api/docs/sunset-dates)." />
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="text-[15px] font-semibold text-[#0A1F33]">LinkedIn app</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="Client ID" value={f.linkedinClientId} onChange={set('linkedinClientId')} autoComplete="off" />
              <TextField label="Client secret" type="password" autoComplete="off" value={f.linkedinClientSecret} onChange={set('linkedinClientSecret')} placeholder={s.linkedin.secretSet ? '•••••• saved' : ''} />
              <TextField label="API version" value={f.linkedinVersion} onChange={set('linkedinVersion')} placeholder="202605" hint="Year and month (LinkedIn retires versions after about a year)." />
            </div>
            <CopyRow label="Authorized redirect URL (LinkedIn app › Auth)" value={s.linkedin.redirectUri} />
          </section>
          <section className="space-y-3">
            <h3 className="text-[15px] font-semibold text-[#0A1F33]">Pinterest app</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="App ID" value={f.pinterestAppId} onChange={set('pinterestAppId')} inputMode="numeric" autoComplete="off" />
              <TextField label="App secret key" type="password" autoComplete="off" value={f.pinterestAppSecret} onChange={set('pinterestAppSecret')} placeholder={s.pinterest.secretSet ? '•••••• saved' : ''} />
            </div>
            <CopyRow label="Redirect URI (Pinterest app › Configure)" value={s.pinterest.redirectUri} />
          </section>
          <section className="space-y-3">
            <h3 className="text-[15px] font-semibold text-[#0A1F33]">Facebook / Instagram: social inbox and posts</h3>
            <TextField label="Facebook Login for Business configuration ID" value={f.metaSocialConfigId} onChange={set('metaSocialConfigId')} inputMode="numeric" placeholder="Optional"
              hint="A configuration with Pages and Instagram accounts and the inbox / publishing permissions. Empty: the permissions are asked for directly." />
          </section>
          <ErrorBox message={error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving} icon={<Save className="h-4 w-4" aria-hidden />}>Save</Button>
            {s.updatedAt && <span className="text-[13px] text-[#5E778C]">Updated {fmtDateTime(s.updatedAt)} by {s.updatedBy}</span>}
          </div>
          <Guide title="Where these come from">
            <ul className="list-disc pl-5 space-y-1">
              <li>Google Ads: ads.google.com › manager account › Tools › API Center › developer token (Basic access is enough).</li>
              <li>LinkedIn: linkedin.com/developers › your app › Auth (Community Management API and Lead Sync products).</li>
              <li>Pinterest: developers.pinterest.com › My apps › your app.</li>
            </ul>
          </Guide>
        </form>
      )}
    </Card>
  );
}
