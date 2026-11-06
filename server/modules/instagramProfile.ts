/**
 * Post scheduler › Instagram view: the connected Instagram account's public profile, read from Meta. Kept 15 minutes.
 * If Meta refuses the counts, the name still shows and the screen says why.
 */
import type { ActionMap } from '../core/actions';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { socialPages } from './socialAccounts';

const FIELDS = 'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count';
const CACHE_MS = 15 * 60000;
const cache = new Map<string, { at: number; data: InstagramProfile }>();

export interface InstagramProfile { account: string; username: string; name: string; bio: string; website: string; picture: string; followers: number | null; following: number | null; posts: number | null; error: string }

const link = (v: unknown, schemes: string[]) => {
  try {
    const u = new URL(String(v || ''));
    return schemes.includes(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
};
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function getInstagramProfile(d: any): Promise<InstagramProfile> {
  const account = String(d?.account || '');
  const igId = account.startsWith('instagram:') ? account.slice('instagram:'.length) : '';
  const page = igId ? (await socialPages()).find((p) => p.igId === igId) : null;
  if (!page) throw fail('VALIDATION', 'This Instagram account is no longer connected. Reload the page.');
  const key = `${currentTenant()?.id || ''}:${igId}`;
  const hit = cache.get(key);
  if (!d?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const base: InstagramProfile = { account, username: String(page.igUsername || igId), name: '', bio: '', website: '', picture: '', followers: null, following: null, posts: null, error: '' };
  let data = base;
  try {
    const j = await graph<any>(igId, { token: page.token, params: { fields: FIELDS } });
    data = {
      ...base, username: String(j?.username || base.username), name: String(j?.name || ''), bio: String(j?.biography || ''), website: link(j?.website, ['https:', 'http:']), picture: link(j?.profile_picture_url, ['https:']),
      followers: count(j?.followers_count), following: count(j?.follows_count), posts: count(j?.media_count),
    };
  } catch (e: any) {
    data = { ...base, error: truncate(String(e?.message || e), 240) };
  }
  if (cache.size >= 100) cache.clear();
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function clearInstagramProfileCache() {
  cache.clear();
}

export const actions: ActionMap = {
  getInstagramProfile: { fn: (d) => getInstagramProfile(d), perm: 'marketing.posts' },
};
