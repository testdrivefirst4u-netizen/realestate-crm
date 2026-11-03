/**
 * Platform keys of the marketing integrations (Super admin › Settings › Marketing apps), one per platform:
 *   Google Ads developer token (+ manager account id, API version), LinkedIn app, Pinterest app and the Facebook
 *   Login for Business configuration of the social inbox / post scheduler. Secrets are stored encrypted; each value
 *   falls back to an environment variable. Companies connect their own accounts with these apps.
 */
import { fail } from '../core/errors';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { actorLabel, platformAudit, type SaCtx } from './base';
import { pc } from './base';
import { PCOLL } from './registry';

export const LINKEDIN_CALLBACK_PATH = '/api/integrations/linkedin/callback';
export const PINTEREST_CALLBACK_PATH = '/api/integrations/pinterest/callback';
export const DEFAULT_GOOGLE_ADS_VERSION = 'v26';
export const DEFAULT_LINKEDIN_VERSION = '202605';

interface MarketingAppsDoc {
  _id: 'marketingApps';
  googleAdsDeveloperToken?: string; // encrypted
  googleAdsLoginCustomerId?: string;
  googleAdsApiVersion?: string;
  linkedinClientId?: string;
  linkedinClientSecret?: string; // encrypted
  linkedinVersion?: string;
  pinterestAppId?: string;
  pinterestAppSecret?: string; // encrypted
  metaSocialConfigId?: string;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface MarketingApps {
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

export interface MarketingAppsView {
  googleAds: { tokenSet: boolean; loginCustomerId: string; apiVersion: string };
  linkedin: { clientId: string; secretSet: boolean; version: string; redirectUri: string };
  pinterest: { appId: string; secretSet: boolean; redirectUri: string };
  metaSocialConfigId: string;
  updatedAt: string;
  updatedBy: string;
}

const col = () => pc<MarketingAppsDoc>(PCOLL.PLATFORM_SETTINGS);
const env = (k: string) => process.env[k]?.trim() || '';
const dec = (v?: string) => (v ? decryptSecret(v) : '');

/** The keys in force (stored value, else environment). */
export async function loadMarketingApps(): Promise<MarketingApps> {
  const d = await (await col()).findOne({ _id: 'marketingApps' });
  return {
    googleAdsDeveloperToken: dec(d?.googleAdsDeveloperToken) || env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    googleAdsLoginCustomerId: d?.googleAdsLoginCustomerId || env('GOOGLE_ADS_LOGIN_CUSTOMER_ID'),
    googleAdsApiVersion: d?.googleAdsApiVersion || env('GOOGLE_ADS_API_VERSION') || DEFAULT_GOOGLE_ADS_VERSION,
    linkedinClientId: d?.linkedinClientId || env('LINKEDIN_CLIENT_ID'),
    linkedinClientSecret: dec(d?.linkedinClientSecret) || env('LINKEDIN_CLIENT_SECRET'),
    linkedinVersion: d?.linkedinVersion || env('LINKEDIN_VERSION') || DEFAULT_LINKEDIN_VERSION,
    pinterestAppId: d?.pinterestAppId || env('PINTEREST_APP_ID'),
    pinterestAppSecret: dec(d?.pinterestAppSecret) || env('PINTEREST_APP_SECRET'),
    metaSocialConfigId: d?.metaSocialConfigId || env('META_SOCIAL_CONFIG_ID'),
  };
}

export async function getMarketingApps(): Promise<MarketingAppsView> {
  const [a, d] = await Promise.all([loadMarketingApps(), (await col()).findOne({ _id: 'marketingApps' })]);
  return {
    googleAds: { tokenSet: !!a.googleAdsDeveloperToken, loginCustomerId: a.googleAdsLoginCustomerId, apiVersion: a.googleAdsApiVersion },
    linkedin: { clientId: a.linkedinClientId, secretSet: !!a.linkedinClientSecret, version: a.linkedinVersion, redirectUri: `${appUrl()}${LINKEDIN_CALLBACK_PATH}` },
    pinterest: { appId: a.pinterestAppId, secretSet: !!a.pinterestAppSecret, redirectUri: `${appUrl()}${PINTEREST_CALLBACK_PATH}` },
    metaSocialConfigId: a.metaSocialConfigId,
    updatedAt: d?.updatedAt ? d.updatedAt.toISOString() : '',
    updatedBy: d?.updatedBy || '',
  };
}

const digits = (v: unknown) => String(v ?? '').replace(/[\s-]/g, '');

/** Partial update: a field left out keeps its value; '' clears it. Secrets are never returned. */
export async function setMarketingApps(d: any, ctx: SaCtx): Promise<MarketingAppsView> {
  const c = await col();
  const set: Partial<MarketingAppsDoc> = {};
  const changed: string[] = [];
  const secret = (k: 'googleAdsDeveloperToken' | 'linkedinClientSecret' | 'pinterestAppSecret', re: RegExp, msg: string) => {
    if (d?.[k] === undefined) return;
    const v = String(d[k] ?? '').trim();
    if (v && !re.test(v)) throw fail('VALIDATION', msg);
    set[k] = v ? encryptSecret(v) : '';
    changed.push(k);
  };
  const plain = (k: keyof MarketingAppsDoc, v: string | undefined, re: RegExp, msg: string) => {
    if (v === undefined) return;
    if (v && !re.test(v)) throw fail('VALIDATION', msg);
    (set as any)[k] = v;
    changed.push(String(k));
  };
  secret('googleAdsDeveloperToken', /^[A-Za-z0-9_-]{10,64}$/, 'A Google Ads developer token is 22 letters and digits (Google Ads › Tools › API Center).');
  plain('googleAdsLoginCustomerId', d?.googleAdsLoginCustomerId === undefined ? undefined : digits(d.googleAdsLoginCustomerId), /^\d{10}$/, 'The manager account ID is 10 digits, e.g. 123-456-7890.');
  plain('googleAdsApiVersion', d?.googleAdsApiVersion === undefined ? undefined : String(d.googleAdsApiVersion).trim(), /^v\d{2}$/, 'Google Ads API version looks like v26.');
  plain('linkedinClientId', d?.linkedinClientId === undefined ? undefined : String(d.linkedinClientId).trim(), /^[A-Za-z0-9]{8,40}$/, 'The LinkedIn Client ID is letters and digits (LinkedIn Developers › your app › Auth).');
  secret('linkedinClientSecret', /^[A-Za-z0-9_.=-]{8,120}$/, 'That does not look like a LinkedIn Client Secret.');
  plain('linkedinVersion', d?.linkedinVersion === undefined ? undefined : String(d.linkedinVersion).trim(), /^20\d{4}$/, 'LinkedIn API version looks like 202605 (year and month).');
  plain('pinterestAppId', d?.pinterestAppId === undefined ? undefined : String(d.pinterestAppId).trim(), /^\d{5,20}$/, 'The Pinterest App ID is a number (developers.pinterest.com › My apps).');
  secret('pinterestAppSecret', /^[A-Za-z0-9_-]{10,120}$/, 'That does not look like a Pinterest App secret key.');
  plain('metaSocialConfigId', d?.metaSocialConfigId === undefined ? undefined : String(d.metaSocialConfigId).trim(), /^\d{1,30}$/, 'The Facebook Login for Business configuration ID is a number.');
  if (!changed.length) return getMarketingApps();
  await c.updateOne({ _id: 'marketingApps' }, { $set: { ...set, updatedAt: new Date(), updatedBy: actorLabel(ctx) } }, { upsert: true });
  await platformAudit(ctx, 'Marketing Apps Set', '', `Changed: ${changed.join(', ')}`);
  return getMarketingApps();
}
