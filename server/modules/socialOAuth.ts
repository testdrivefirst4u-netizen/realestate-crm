/**
 * Shared sign-in plumbing of LinkedIn and Pinterest ("Connect" in Settings › Social accounts): a signed state +
 * httpOnly nonce cookie (server/core/oauthState.ts) and the redirect back to the settings page.
 */
import { can } from '../core/auth';
import { resolveCrmSession, signState, verifyState } from '../core/oauthState';
import { appUrl } from '../core/settings';
import type { Tenant } from '../core/tenant';
import type { PublicUser } from '../core/auth';
import { randomToken } from '../core/utils';

export const SOCIAL_NONCE_COOKIE = 'social_oauth_nonce';
export const SOCIAL_COOKIE_PATH = '/api/integrations';
const STATE_TTL_S = 600;

export const socialSettingsRedirect = (params: Record<string, string>) => `${appUrl()}/settings?${new URLSearchParams({ section: 'social', ...params }).toString()}`;
/** Post Scheduler returns here when the connect was started from /posts (so an admin never visits Settings). */
export const postsRedirect = (params: Record<string, string>) => `${appUrl()}/posts?${new URLSearchParams(params).toString()}`;
/** Send the browser back to where the connect was started: /posts for the Post Scheduler, else Settings › Social accounts. */
export const socialBack = (returnKey: string | undefined, params: Record<string, string>) => (returnKey === 'posts' ? postsRedirect(params) : socialSettingsRedirect(params));

/** Start: the signed-in administrator of a company with `feature` → state + nonce, or a redirect explaining why not. */
export async function beginSocialOAuth(input: { sessionCookie: string; nowMs?: number; returnKey?: string }, purpose: string, feature: keyof Tenant['features'], label: string, errKey: string):
  Promise<{ ok: true; state: string; nonce: string; returnKey?: string } | { ok: false; redirect: string }> {
  const r = input.returnKey === 'posts' ? 'posts' : undefined;
  const back = (params: Record<string, string>) => socialBack(r, params);
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { ok: false, redirect: `${appUrl()}/` };
  if (!can(sess.user, 'integrations.connect')) return { ok: false, redirect: back({ [errKey]: `Only an administrator can connect ${label}.` }) };
  if (!sess.tenant.features[feature]) return { ok: false, redirect: back({ [errKey]: `${label} is not included in your company's plan.` }) };
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S, ...(r ? { r } : {}) }, purpose);
  return { ok: true, state, nonce, returnKey: r };
}

/** Callback: the same user and company that started, the plan still allowing it. */
export async function endSocialOAuth(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }, purpose: string, feature: keyof Tenant['features'], label: string, errKey: string):
  Promise<{ ok: true; tenant: Tenant; user: PublicUser; code: string; returnKey?: string } | { ok: false; redirect: string }> {
  const p = input.params;
  const fail = (m: string, returnKey?: string) => ({ ok: false as const, redirect: socialBack(returnKey, { [errKey]: m.slice(0, 300) }) });
  if (p.get('error')) return fail(/denied|cancel/i.test(`${p.get('error')} ${p.get('error_description') || ''}`) ? `${label} sign-in was cancelled.` : `${label} sign-in failed: ${p.get('error_description') || p.get('error')}`);
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { ok: false, redirect: `${appUrl()}/` };
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs, purpose);
  if (!v.ok) return fail(`The ${label} sign-in could not be verified (it expired or was started in another session). Please try again.`);
  const r = v.state.r === 'posts' ? 'posts' : undefined;
  if (!can(sess.user, 'integrations.connect') || !sess.tenant.features[feature]) return fail(`You cannot connect ${label} here.`, r);
  const code = p.get('code') || '';
  if (!code) return fail(`${label} did not return an authorisation code. Please try again.`, r);
  return { ok: true, tenant: sess.tenant, user: sess.user, code, returnKey: r };
}
