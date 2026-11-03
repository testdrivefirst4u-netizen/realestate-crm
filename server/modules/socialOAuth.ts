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

/** Start: the signed-in administrator of a company with `feature` → state + nonce, or a redirect explaining why not. */
export async function beginSocialOAuth(input: { sessionCookie: string; nowMs?: number }, purpose: string, feature: keyof Tenant['features'], label: string, errKey: string):
  Promise<{ ok: true; state: string; nonce: string } | { ok: false; redirect: string }> {
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { ok: false, redirect: `${appUrl()}/` };
  if (!can(sess.user, 'integrations.connect')) return { ok: false, redirect: socialSettingsRedirect({ [errKey]: `Only an administrator can connect ${label}.` }) };
  if (!sess.tenant.features[feature]) return { ok: false, redirect: socialSettingsRedirect({ [errKey]: `${label} is not included in your company's plan.` }) };
  const nonce = randomToken(16);
  const state = signState({ c: sess.tenant.id, u: sess.user.id, n: nonce, exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + STATE_TTL_S }, purpose);
  return { ok: true, state, nonce };
}

/** Callback: the same user and company that started, the plan still allowing it. */
export async function endSocialOAuth(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }, purpose: string, feature: keyof Tenant['features'], label: string, errKey: string):
  Promise<{ ok: true; tenant: Tenant; user: PublicUser; code: string } | { ok: false; redirect: string }> {
  const p = input.params;
  const fail = (m: string) => ({ ok: false as const, redirect: socialSettingsRedirect({ [errKey]: m.slice(0, 300) }) });
  if (p.get('error')) return fail(/denied|cancel/i.test(`${p.get('error')} ${p.get('error_description') || ''}`) ? `${label} sign-in was cancelled.` : `${label} sign-in failed: ${p.get('error_description') || p.get('error')}`);
  const sess = await resolveCrmSession(input.sessionCookie);
  if (!sess) return { ok: false, redirect: `${appUrl()}/` };
  const v = verifyState(p.get('state') || '', { nonce: input.nonceCookie, companyId: sess.tenant.id, userId: sess.user.id }, input.nowMs, purpose);
  if (!v.ok) return fail(`The ${label} sign-in could not be verified (it expired or was started in another session). Please try again.`);
  if (!can(sess.user, 'integrations.connect') || !sess.tenant.features[feature]) return fail(`You cannot connect ${label} here.`);
  const code = p.get('code') || '';
  if (!code) return fail(`${label} did not return an authorisation code. Please try again.`);
  return { ok: true, tenant: sess.tenant, user: sess.user, code };
}
