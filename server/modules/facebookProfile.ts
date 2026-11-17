/**
 * Post scheduler › Facebook view: the connected Facebook Page's public profile, read from Meta. Kept 15 minutes.
 * If Meta refuses the counts, the name still shows and the screen says why. Mirrors instagramProfile.ts.
 */
import type { ActionMap } from '../core/actions';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { graph } from '../integrations/meta';
import { socialPages } from './socialAccounts';

const FIELDS = 'name,about,category,fan_count,followers_count,link,website,picture.type(large){url}';
const CACHE_MS = 15 * 60000;
const cache = new Map<string, { at: number; data: FacebookProfile }>();

export interface FacebookProfile { account: string; name: string; about: string; category: string; website: string; link: string; picture: string; followers: number | null; likes: number | null; error: string }

const link = (v: unknown, schemes: string[]) => {
  try {
    const u = new URL(String(v || ''));
    return schemes.includes(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
};
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function getFacebookProfile(d: any): Promise<FacebookProfile> {
  const account = String(d?.account || '');
  const pageId = account.startsWith('facebook:') ? account.slice('facebook:'.length) : account;
  const page = pageId ? (await socialPages()).find((p) => p.id === pageId) : null;
  if (!page) throw fail('VALIDATION', 'This Facebook Page is no longer connected. Reload the page.');
  const key = `${currentTenant()?.id || ''}:${pageId}`;
  const hit = cache.get(key);
  if (!d?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const base: FacebookProfile = { account, name: String(page.name || ''), about: '', category: '', website: '', link: '', picture: '', followers: null, likes: null, error: '' };
  let data = base;
  try {
    const j = await graph<any>(pageId, { token: page.token, params: { fields: FIELDS } });
    data = {
      ...base, name: String(j?.name || base.name), about: truncate(String(j?.about || ''), 500), category: String(j?.category || ''),
      website: link(j?.website, ['https:', 'http:']), link: link(j?.link, ['https:', 'http:']), picture: link(j?.picture?.data?.url, ['https:']),
      followers: count(j?.followers_count), likes: count(j?.fan_count),
    };
  } catch (e: any) {
    data = { ...base, error: truncate(String(e?.message || e), 240) };
  }
  if (cache.size >= 100) cache.clear();
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function clearFacebookProfileCache() {
  cache.clear();
}

export const actions: ActionMap = {
  getFacebookProfile: { fn: (d) => getFacebookProfile(d), perm: 'marketing.posts' },
};
