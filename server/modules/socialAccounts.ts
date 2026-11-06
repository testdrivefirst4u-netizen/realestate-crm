/**
 * Social accounts (Settings › Social accounts): Facebook Pages with their Instagram business accounts, connected
 * with "Connect with Facebook" for the social inbox and the post scheduler (plan features socialInbox / socialPosts).
 *
 * Connect = GET /api/integrations/meta/social/connect → Facebook Login (the platform's social configuration,
 *           Super admin › Settings › Marketing apps, or the permissions below) → the shared Meta callback (told apart
 *           by the state's signing purpose 'metaSocial') → every Page chosen in the Facebook window is stored with its
 *           Page token (encrypted) and Instagram account in `integrations` { _id: 'metaSocial' }, claimed for this
 *           company in the platform collection `socialAccounts` ('fb:<pageId>' / 'ig:<igId>' → company) so webhooks
 *           find it, and subscribed to the Page fields feed + messages (keeping leadgen when lead ads use it).
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { resolveCrmSession, signState, stateSignedFor, verifyState } from '../core/oauthState';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { requireTenant, runWithTenant } from '../core/tenant';
import { randomToken, truncate } from '../core/utils';
import { exchangeCodeForToken, graph, loadMetaConfig, longLivedUserToken, type MetaConfig } from '../integrations/meta';
import { pc } from '../platform/base';
import { loadMarketingApps } from '../platform/marketingApps';
import { oauthRedirectUri } from './meta';

export const SOCIAL_CONNECT_PATH = '/api/integrations/meta/social/connect';
export const SOCIAL_PURPOSE = 'metaSocial';
const STATE_TTL_S = 600;
export const SOCIAL_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_read_user_content', 'pages_manage_engagement',
  'pages_manage_posts', 'pages_messaging', 'instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages',
  'instagram_content_publish', 'instagram_manage_contents', 'business_management', 'read_insights', 'instagram_manage_insights',
].join(',');
/** Page webhook fields the inbox needs (leadgen is kept for lead ads). */
const SOCIAL_FIELDS = ['feed', 'messages'];

export interface SocialPage { id: string; name: string; token: string; igId: string; igUsername: string }
interface SocialDoc { _id: 'metaSocial'; pages: SocialPage[]; connectedBy?: string; updatedAt?: Date; lastError?: string }
interface ClaimDoc { _id: string; companyId: string; at: Date }

const docCol = () => col<SocialDoc>(CFG.COLL.INTEGRATIONS);
export const socialClaimsCol = () => pc<ClaimDoc>('socialAccounts');

export const socialRedirect = (params: Record<string, string>) => `${appUrl()}/settings?${new URLSearchParams({ section: 'social', ...params }).toString()}`;
const usesSocial = (f: Record<string, boolean>) => !!(f.socialInbox || f.socialPosts);

/** The company's connected Pages with their tokens decrypted (company context). */
export async function socialPages(): Promise<SocialPage[]> {
  const d = await (await docCol()).findOne({ _id: 'metaSocial' });
  return (d?.pages || []).map((p) => ({ ...p, token: decryptSecret(p.token) })).filter((p) => p.token);
}
export async function pageFor(id: string): Promise<SocialPage | null> {
  return (await socialPages()).find((p) => p.id === id || (p.igId && p.igId === id)) || null;
}

/** Which company owns a Page / Instagram account (webhooks). */
export async function companyOfSocial(kind: 'fb' | 'ig', id: string): Promise<string | null> {
  return (await (await socialClaimsCol()).findOne({ _id: `${kind}:${id}` }))?.companyId || null;
}

/** Subscribe the app to the Page fields the inbox needs, keeping the fields already subscribed (e.g. leadgen). */
export async function ensureSocialSubscription(pageId: string, token: string, cfg?: MetaConfig): Promise<void> {
  const conf = cfg || (await loadMetaConfig());
  const cur = await graph<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(`${pageId}/subscribed_apps`, { token, config: conf }).catch(() => ({ data: [] }));
  const mine = (cur.data || []).find((a) => String(a.id) === conf.appId);
  const fields = [...new Set([...(mine?.subscribed_fields || []), ...SOCIAL_FIELDS])];
  if (mine && SOCIAL_FIELDS.every((f) => mine.subscribed_fields?.includes(f))) return;
  await graph(`${pageId}/subscribed_apps`, { token, config: conf, method: 'POST', params: { subscribed_fields: fields.join(',') } });
}

/* -------------------------------- connect -------------------------------- */

export async function startSocialConnect(input: { sessionCookie: string; nowMs?: number }): Promise<{ redirect: string; nonce?: string }> {
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  if (!can(sess.user, 'integrations.connect')) return { redirect: socialRedirect({ socialError: 'Only an administrator can connect Facebook.' }) };
  if (!usesSocial(sess.tenant.features as any)) return { redirect: socialRedirect({ socialError: "The social inbox and post scheduler are not included in your company's plan." }) };
  const cfg = await loadMetaConfig();
  if (!cfg.appId || !cfg.appSecret) return { redirect: socialRedirect({ socialError: 'Facebook is not set up on this platform yet. Ask your platform administrator.' }) };
  const apps = await loadMarketingApps();
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S }, SOCIAL_PURPOSE);
  const q = new URLSearchParams({ client_id: cfg.appId, redirect_uri: oauthRedirectUri(), state, response_type: 'code' });
  if (apps.metaSocialConfigId) q.set('config_id', apps.metaSocialConfigId);
  else q.set('scope', SOCIAL_SCOPES);
  return { redirect: `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?${q.toString()}`, nonce };
}

export const isSocialCallback = (params: URLSearchParams) => stateSignedFor(params.get('state') || '', SOCIAL_PURPOSE);

export async function finishSocialConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const p = input.params;
  const err = (m: string) => ({ redirect: socialRedirect({ socialError: truncate(m, 300) }) });
  if (p.get('error')) return err(p.get('error_reason') === 'user_denied' || p.get('error') === 'access_denied' ? 'Facebook login was cancelled.' : `Facebook login failed: ${p.get('error_description') || p.get('error')}`);
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { redirect: `${appUrl()}/` };
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs, SOCIAL_PURPOSE);
  if (!v.ok) return err('The Facebook login could not be verified (it expired or was started in another session). Please try again.');
  if (!can(sess.user, 'integrations.connect') || !usesSocial(sess.tenant.features as any)) return err('You cannot connect Facebook here.');
  const code = p.get('code') || '';
  if (!code) return err('Facebook did not return an authorisation code. Please try again.');
  const ctx = { user: sess.user } as Ctx;
  try {
    const result = await runWithTenant(sess.tenant, async () => {
      const cfg = await loadMetaConfig();
      const user = await longLivedUserToken(await exchangeCodeForToken(code, oauthRedirectUri(), cfg), cfg);
      const j = await graph<{ data?: any[] }>('me/accounts', { token: user, config: cfg, params: { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100 } });
      const pages: SocialPage[] = (j.data || []).filter((x) => x?.id && x?.access_token).map((x) => ({
        id: String(x.id), name: truncate(String(x.name || x.id), 120), token: String(x.access_token),
        igId: String(x.instagram_business_account?.id || ''), igUsername: String(x.instagram_business_account?.username || ''),
      }));
      if (!pages.length) throw fail('VALIDATION', 'Facebook returned no Pages. Choose the Page (and its Instagram account) in the Facebook window; you must be an admin of it.');
      return savePages(pages, ctx, cfg);
    });
    return { redirect: socialRedirect(result) };
  } catch (e: any) {
    if (!(e instanceof ApiError)) console.error('[meta:social-callback]', e?.message);
    return err(e?.message || 'Could not connect Facebook.');
  }
}

/** Claim, subscribe and store the Pages (a Page another company holds is left out with a note). */
export async function savePages(pages: SocialPage[], ctx: Ctx, cfg?: MetaConfig): Promise<{ socialConnected: string; socialNote?: string }> {
  const tenant = requireTenant();
  const claims = await socialClaimsCol();
  const kept: SocialPage[] = [];
  const notes: string[] = [];
  for (const pg of pages.slice(0, 20)) {
    const keys = [`fb:${pg.id}`, ...(pg.igId ? [`ig:${pg.igId}`] : [])];
    const taken = await claims.findOne({ _id: { $in: keys }, companyId: { $ne: tenant.id } });
    if (taken) {
      notes.push(`${pg.name} is connected to another workspace`);
      continue;
    }
    for (const k of keys) await claims.updateOne({ _id: k }, { $set: { companyId: tenant.id, at: new Date() } }, { upsert: true });
    try {
      await ensureSocialSubscription(pg.id, pg.token, cfg);
    } catch (e: any) {
      notes.push(`${pg.name}: messages and comments could not be switched on (${truncate(e?.message || '', 120)})`);
    }
    kept.push(pg);
  }
  if (!kept.length) throw fail('CONFLICT', notes.join('; ') || 'No Page could be connected.');
  // pages connected before and not chosen this time stay connected
  const cur = await (await docCol()).findOne({ _id: 'metaSocial' });
  const others = (cur?.pages || []).filter((p) => !kept.some((k) => k.id === p.id));
  await (await docCol()).updateOne(
    { _id: 'metaSocial' },
    { $set: { pages: [...others, ...kept.map((p) => ({ ...p, token: encryptSecret(p.token) }))], connectedBy: ctx.user?.name || 'System', updatedAt: new Date(), lastError: notes.join('; ').slice(0, 400) } },
    { upsert: true }
  );
  await auditLog(ctx, 'Social Accounts Connected', 'Settings', 'metaSocial', kept.map((p) => p.name + (p.igUsername ? ` (+@${p.igUsername})` : '')).join(', '));
  return { socialConnected: kept.map((p) => p.name).join(', ').slice(0, 200), ...(notes.length ? { socialNote: notes.join('; ').slice(0, 300) } : {}) };
}

export interface SocialAccountsView {
  connectUrl: string;
  available: boolean;
  pages: Array<{ id: string; name: string; igId: string; igUsername: string }>;
  note: string;
}

export async function getSocialAccounts(): Promise<SocialAccountsView> {
  const [d, cfg] = await Promise.all([(await docCol()).findOne({ _id: 'metaSocial' }), loadMetaConfig().catch(() => null)]);
  return {
    connectUrl: SOCIAL_CONNECT_PATH,
    available: !!(cfg?.appId && cfg.appSecret),
    pages: (d?.pages || []).map(({ id, name, igId, igUsername }) => ({ id, name, igId, igUsername })),
    note: d?.lastError || '',
  };
}

export async function disconnectSocialPage(d: any, ctx: Ctx): Promise<SocialAccountsView> {
  const id = String(d?.pageId || '');
  const c = await docCol();
  const cur = await c.findOne({ _id: 'metaSocial' });
  const pg = (cur?.pages || []).find((p) => p.id === id);
  if (!pg) throw fail('NOT_FOUND', 'That Page is not connected.');
  const tenant = requireTenant();
  await (await socialClaimsCol()).deleteMany({ _id: { $in: [`fb:${pg.id}`, `ig:${pg.igId}`] }, companyId: tenant.id });
  await c.updateOne({ _id: 'metaSocial' }, { $set: { pages: (cur?.pages || []).filter((p) => p.id !== id), updatedAt: new Date() } });
  await auditLog(ctx, 'Social Account Disconnected', 'Settings', 'metaSocial', pg.name);
  (await import('./socialInsights')).clearInsightsCache();
  return getSocialAccounts();
}

/** Daily: re-add the inbox fields to each Page's subscription (lead ads disconnect / reconnect can drop them). */
export async function refreshSocialSubscriptions(): Promise<number> {
  let n = 0;
  for (const p of await socialPages()) {
    try {
      await ensureSocialSubscription(p.id, p.token);
      n++;
    } catch { /* reported on the settings page at the next connect */ }
  }
  return n;
}

export const actions: ActionMap = {
  getSocialAccounts: { fn: () => getSocialAccounts(), perm: 'integrations.connect' },
  disconnectSocialPage: { fn: (d, ctx) => disconnectSocialPage(d, ctx), perm: 'integrations.connect' },
};
