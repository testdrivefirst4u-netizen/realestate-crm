/**
 * Super-admin side of the Google Sheets integration (PlatformSheetActions, server/core/sheetTypes.ts):
 * the platform service account (stored AES-GCM encrypted in PCOLL.PLATFORM_SETTINGS {_id:'google'}; the key
 * itself is never returned), the "Connect with Google" OAuth client (Client ID + encrypted Client Secret in the
 * same doc; the secret is never returned) and a read-only view of one company's sheet links and connections.
 */
import { fail } from '../core/errors';
import { appUrl, encryptSecret } from '../core/settings';
import { runWithTenant } from '../core/tenant';
import type { PlatformSheetActions } from '../core/sheetTypes';
import {
  getAccessToken, googleSettingsCol, googleStatus, loadOAuthClient, loadServiceAccount, OAUTH_CALLBACK_PATH, OAUTH_CLIENT_ID_RE, parseServiceAccount,
  resetGoogleTokenCache,
} from '../integrations/google';
import { sourcesCol } from '../modules/intake';
import { resetGoogleOAuthTokenCache } from '../modules/googleConnect';
import { defaultSheetImportConfig, listGoogleConnections, listSheetExports, normAuth } from '../modules/sheets';
import { actorLabel, platformAudit, type SaCtx } from './base';
import { findCompany } from './companies';
import { toTenant } from './registry';

type Req<K extends keyof PlatformSheetActions> = PlatformSheetActions[K]['req'];
type Res<K extends keyof PlatformSheetActions> = PlatformSheetActions[K]['res'];

const SA_FIELDS = { serviceAccount: '', projectId: '', clientEmail: '', updatedAt: '', updatedBy: '' } as const;

export async function getGoogleSettings(): Promise<Res<'getGoogleSettings'>> {
  const [status, doc, cred, oauth] = await Promise.all([googleStatus(), (await googleSettingsCol()).findOne({ _id: 'google' }), loadServiceAccount(), loadOAuthClient()]);
  const fromPlatform = status.source === 'platform';
  return {
    ...status,
    projectId: cred?.sa.project_id || '',
    updatedAt: fromPlatform && doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : '',
    updatedBy: fromPlatform ? doc?.updatedBy || '' : '',
    oauthClientId: oauth?.clientId || doc?.oauthClientId || '',
    oauthSecretSet: !!(oauth || doc?.oauthClientSecret),
    oauthSource: oauth?.source || 'none',
    oauthRedirectUri: `${appUrl()}${OAUTH_CALLBACK_PATH}`,
  };
}

export async function setGoogleServiceAccount(d: Req<'setGoogleServiceAccount'>, ctx: SaCtx): Promise<Res<'setGoogleServiceAccount'>> {
  if (typeof d?.json !== 'string') throw fail('VALIDATION', 'json must be the service-account key as text ("" removes it)');
  if (d.json.length > 20000) throw fail('VALIDATION', 'This is too large to be a service-account key');
  const c = await googleSettingsCol();
  if (!d.json.trim()) {
    // only the service-account fields: the OAuth client in the same doc stays
    await c.updateOne({ _id: 'google' }, { $unset: SA_FIELDS });
    resetGoogleTokenCache();
    await platformAudit(ctx, 'Google Service Account Removed', '', '');
    return getGoogleSettings();
  }
  const sa = parseServiceAccount(d.json);
  const blob = encryptSecret(JSON.stringify(sa));
  await c.updateOne(
    { _id: 'google' },
    { $set: { serviceAccount: blob, projectId: sa.project_id, clientEmail: sa.client_email, updatedAt: new Date(), updatedBy: actorLabel(ctx) } },
    { upsert: true }
  );
  resetGoogleTokenCache();
  await platformAudit(ctx, 'Google Service Account Set', '', `${sa.client_email}${sa.project_id ? ` (project ${sa.project_id})` : ''}`);
  return getGoogleSettings();
}

/** "Connect with Google" OAuth client. clientId '' removes it; clientSecret '' (or omitted) keeps the stored one. */
export async function setGoogleOAuthClient(d: Req<'setGoogleOAuthClient'>, ctx: SaCtx): Promise<Res<'setGoogleOAuthClient'>> {
  if (typeof d?.clientId !== 'string') throw fail('VALIDATION', 'clientId must be text ("" removes the OAuth client)');
  if (d.clientSecret !== undefined && d.clientSecret !== null && typeof d.clientSecret !== 'string') throw fail('VALIDATION', 'clientSecret must be text');
  const clientId = d.clientId.trim();
  const secret = String(d.clientSecret ?? '').trim();
  const c = await googleSettingsCol();
  if (!clientId) {
    await c.updateOne({ _id: 'google' }, { $unset: { oauthClientId: '', oauthClientSecret: '', oauthUpdatedAt: '', oauthUpdatedBy: '' } });
    resetGoogleOAuthTokenCache();
    await platformAudit(ctx, 'Google OAuth Client Removed', '', '');
    return getGoogleSettings();
  }
  if (clientId.length > 200 || !OAUTH_CLIENT_ID_RE.test(clientId)) {
    throw fail('VALIDATION', 'This is not a Google OAuth Client ID (it looks like 1234567890-abc123.apps.googleusercontent.com)');
  }
  if (secret.length > 200 || /\s/.test(secret)) throw fail('VALIDATION', 'This is not a Google OAuth Client Secret');
  const doc = await c.findOne({ _id: 'google' });
  if (!secret && !doc?.oauthClientSecret) throw fail('VALIDATION', 'Paste the Client Secret too');
  const set: Record<string, unknown> = { oauthClientId: clientId, oauthUpdatedAt: new Date(), oauthUpdatedBy: actorLabel(ctx) };
  if (secret) set.oauthClientSecret = encryptSecret(secret);
  await c.updateOne({ _id: 'google' }, { $set: set }, { upsert: true });
  resetGoogleOAuthTokenCache();
  await platformAudit(ctx, 'Google OAuth Client Set', '', `${clientId}${secret ? ' (new secret)' : ''}`);
  return getGoogleSettings();
}

export async function testGoogleServiceAccount(): Promise<Res<'testGoogleServiceAccount'>> {
  try {
    const { email } = await getAccessToken({ force: true });
    return { ok: true, message: `Google accepted the key — signed in as ${email}. Companies share their sheets with this address.` };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'The key could not be used' };
  }
}

export async function companySheets(d: Req<'companySheets'>): Promise<Res<'companySheets'>> {
  const c = await findCompany(String(d?.companyId || ''));
  return runWithTenant(toTenant(c), async () => {
    const sources = await (await sourcesCol()).find({ type: 'google_sheet' }).sort({ _id: 1 }).toArray();
    return {
      connections: await listGoogleConnections(),
      imports: sources.map((s) => {
        const sh = { ...defaultSheetImportConfig(), ...(s.config?.sheet || {}) };
        return {
          sourceId: s._id, name: s.name, spreadsheetUrl: sh.spreadsheetUrl, tab: sh.tab, status: s.status === 'Paused' ? 'Paused' : 'Active',
          lastSyncAt: sh.lastSyncAt, lastSyncResult: sh.lastSyncResult, auth: normAuth(sh.auth),
        };
      }),
      exports: await listSheetExports(),
    };
  });
}
