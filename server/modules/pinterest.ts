/**
 * Pinterest (plan feature pinterest): "Connect Pinterest" in Settings › Social accounts, a board to pin to, and pins
 * from the post scheduler. Platform app: Super admin › Settings › Marketing apps.
 *
 * Connect = GET /api/integrations/pinterest/connect → pinterest.com/oauth (boards:read, pins:read, pins:write,
 *           user_accounts:read) → GET /api/integrations/pinterest/callback → tokens (encrypted) in
 *           `integrations` { _id: 'pinterest' }; the access token is refreshed with the refresh token when it expires.
 * Pins    = POST api.pinterest.com/v5/pins { board_id, title, description, link, media_source: image_url }.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { loadMarketingApps, PINTEREST_CALLBACK_PATH } from '../platform/marketingApps';
import { beginSocialOAuth, endSocialOAuth, socialSettingsRedirect } from './socialOAuth';

const API = 'https://api.pinterest.com/v5';
const PURPOSE = 'pinterest';
const SCOPES = 'boards:read,pins:read,pins:write,user_accounts:read';

interface PinterestDoc {
  _id: 'pinterest';
  token: string; // encrypted
  refresh: string; // encrypted
  expiresAt: Date | null;
  username: string;
  boards: Array<{ id: string; name: string }>;
  boardId: string;
  updatedAt?: Date;
  updatedBy?: string;
}
const docCol = () => col<PinterestDoc>(CFG.COLL.INTEGRATIONS);
const redirectUri = () => `${appUrl()}${PINTEREST_CALLBACK_PATH}`;

async function tokenCall(body: Record<string, string>): Promise<any> {
  const apps = await loadMarketingApps();
  if (!apps.pinterestAppId || !apps.pinterestAppSecret) throw fail('NOT_CONFIGURED', 'Pinterest is not set up on this platform yet (Super admin › Settings › Marketing apps).');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${apps.pinterestAppId}:${apps.pinterestAppSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.access_token) throw fail('VALIDATION', truncate(`Pinterest: ${j?.message || j?.error_description || `answered ${res.status}`}`, 300));
  return j;
}

async function accessToken(): Promise<string> {
  const d = await (await docCol()).findOne({ _id: 'pinterest' });
  if (!d?.token) throw fail('VALIDATION', 'Connect Pinterest first (Settings › Social accounts).');
  if (!d.expiresAt || d.expiresAt.getTime() - 5 * 60000 > Date.now()) return decryptSecret(d.token);
  const j = await tokenCall({ grant_type: 'refresh_token', refresh_token: decryptSecret(d.refresh) });
  await (await docCol()).updateOne({ _id: 'pinterest' }, { $set: { token: encryptSecret(j.access_token), ...(j.refresh_token ? { refresh: encryptSecret(j.refresh_token) } : {}), expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null } });
  return j.access_token;
}

async function pin<T = any>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token || (await accessToken());
  const res = await fetch(`${API}/${path}`, {
    method: init.method || (init.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'VALIDATION' : 'SERVER', truncate(`Pinterest: ${j?.message || `answered ${res.status}`}`, 300));
  return j as T;
}

/* -------------------------------- connect -------------------------------- */

export async function startPinterestConnect(input: { sessionCookie: string; nowMs?: number }): Promise<{ redirect: string; nonce?: string }> {
  const b = await beginSocialOAuth(input, PURPOSE, 'pinterest', 'Pinterest', 'pinterestError');
  if ('redirect' in b) return { redirect: b.redirect };
  const apps = await loadMarketingApps();
  if (!apps.pinterestAppId || !apps.pinterestAppSecret) return { redirect: socialSettingsRedirect({ pinterestError: 'Pinterest is not set up on this platform yet. Ask your platform administrator.' }) };
  const q = new URLSearchParams({ client_id: apps.pinterestAppId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES, state: b.state });
  return { redirect: `https://www.pinterest.com/oauth/?${q.toString()}`, nonce: b.nonce };
}

export async function finishPinterestConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const e = await endSocialOAuth(input, PURPOSE, 'pinterest', 'Pinterest', 'pinterestError');
  if ('redirect' in e) return { redirect: e.redirect };
  try {
    const name = await runWithTenant(e.tenant, async () => {
      const j = await tokenCall({ grant_type: 'authorization_code', code: e.code, redirect_uri: redirectUri() });
      const me = await pin<{ username?: string }>('user_account', { token: j.access_token }).catch(() => ({ username: '' }));
      const boards = await pin<{ items?: Array<{ id: string; name: string }> }>('boards?page_size=100', { token: j.access_token });
      const list = (boards.items || []).map((b) => ({ id: String(b.id), name: truncate(String(b.name || b.id), 120) }));
      const cur = await (await docCol()).findOne({ _id: 'pinterest' });
      await (await docCol()).updateOne({ _id: 'pinterest' }, { $set: {
        token: encryptSecret(j.access_token), refresh: encryptSecret(j.refresh_token || ''), expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null,
        username: String(me.username || ''), boards: list, boardId: list.some((b) => b.id === cur?.boardId) ? cur!.boardId : list.length === 1 ? list[0].id : '',
        updatedAt: new Date(), updatedBy: e.user.name,
      } }, { upsert: true });
      await auditLog({ user: e.user } as Ctx, 'Pinterest Connected', 'Settings', 'pinterest', String(me.username || ''));
      return String(me.username || 'Pinterest');
    });
    return { redirect: socialSettingsRedirect({ pinterestConnected: name }) };
  } catch (err: any) {
    if (!(err instanceof ApiError)) console.error('[pinterest:callback]', err?.message);
    return { redirect: socialSettingsRedirect({ pinterestError: truncate(err?.message || 'Could not connect Pinterest.', 300) }) };
  }
}

/* ---------------------------------- pins ---------------------------------- */

/** Pin an image (public URL) to the chosen board. */
export async function pinToPinterest(p: { text: string; imageUrl: string; link?: string; title?: string }): Promise<{ id: string; url: string }> {
  const d = await (await docCol()).findOne({ _id: 'pinterest' });
  if (!d?.boardId) throw fail('VALIDATION', 'Choose a Pinterest board first (Settings › Social accounts).');
  if (!p.imageUrl) throw fail('VALIDATION', 'Pinterest needs an image.');
  const j = await pin<{ id?: string }>('pins', { body: {
    board_id: d.boardId, description: truncate(p.text, 500), ...(p.title ? { title: truncate(p.title, 100) } : {}), ...(p.link ? { link: p.link } : {}),
    media_source: { source_type: 'image_url', url: p.imageUrl },
  } });
  return { id: String(j.id || ''), url: j.id ? `https://www.pinterest.com/pin/${j.id}/` : '' };
}

export interface PinterestView { available: boolean; connected: boolean; username: string; boards: Array<{ id: string; name: string }>; boardId: string; connectUrl: string }

export async function getPinterest(): Promise<PinterestView> {
  const [d, apps] = await Promise.all([(await docCol()).findOne({ _id: 'pinterest' }), loadMarketingApps()]);
  return { available: !!(apps.pinterestAppId && apps.pinterestAppSecret), connected: !!d?.token, username: d?.username || '', boards: d?.boards || [], boardId: d?.boardId || '', connectUrl: '/api/integrations/pinterest/connect' };
}

export async function savePinterest(d: any, ctx: Ctx): Promise<PinterestView> {
  const cur = await (await docCol()).findOne({ _id: 'pinterest' });
  const boardId = String(d?.boardId || '');
  if (boardId && !(cur?.boards || []).some((b) => b.id === boardId)) throw fail('VALIDATION', 'Choose one of your Pinterest boards.');
  await (await docCol()).updateOne({ _id: 'pinterest' }, { $set: { boardId, updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' } });
  return getPinterest();
}

export async function disconnectPinterest(ctx: Ctx): Promise<PinterestView> {
  await (await docCol()).deleteOne({ _id: 'pinterest' });
  await auditLog(ctx, 'Pinterest Disconnected', 'Settings', 'pinterest', '');
  return getPinterest();
}

export const actions: ActionMap = {
  getPinterest: { fn: () => getPinterest(), perm: 'integrations.connect' },
  savePinterest: { fn: (d, ctx) => savePinterest(d, ctx), perm: 'integrations.connect' },
  disconnectPinterest: { fn: (_d, ctx) => disconnectPinterest(ctx), perm: 'integrations.connect' },
};
