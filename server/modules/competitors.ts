/**
 * Competitor ads (plan feature competitorAds, screen /competitors): the company's list of competitors, one-click links
 * to their ads in Meta's Ad Library and Google's Ads Transparency Center, what the team saw there and when.
 *
 * The CRM does not read those sites: neither offers a usable feed of commercial ads for India, so "running or not"
 * is what a person recorded on the date shown. A competitor is due when a platform was not checked for 7 days.
 * Every signed-in role may read; adding and recording needs marketing.manage (Admins, Managers).
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { str, truncate, uuid } from '../core/utils';
import { decodeBase64, deleteFile, saveFile } from './storage';

export const COMPETITOR_IMAGE_CATEGORY = 'Competitor ads';
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_COMPETITORS = 100;
const MAX_CHECKS = 100;
export const CHECK_EVERY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AdPlatform = 'meta' | 'google';
export type AdStatus = 'running' | 'not_running';
export type AdFormat = 'image' | 'video' | 'carousel' | 'text' | 'other';
const PLATFORMS: AdPlatform[] = ['meta', 'google'];
const STATUSES: AdStatus[] = ['running', 'not_running'];
const FORMATS: AdFormat[] = ['image', 'video', 'carousel', 'text', 'other'];

interface Check { platform: AdPlatform; status: AdStatus; at: Date; by: string }
interface CompetitorDoc {
  _id: string;
  name: string;
  nameKey: string;
  pageName: string;
  website: string;
  area: string;
  assignedToId: string;
  /** Latest check of each platform. */
  meta: Check | null;
  google: Check | null;
  /** Past checks (newest last), kept for "when did they start or stop". */
  checks: Check[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
interface CompetitorAdDoc {
  _id: string;
  competitorId: string;
  platform: AdPlatform;
  link: string;
  imageFileId: string;
  offer: string;
  project: string;
  price: string;
  format: AdFormat;
  note: string;
  seenOn: string;
  createdBy: string;
  createdAt: Date;
}

const competitorsCol = () => col<CompetitorDoc>(CFG.COLL.COMPETITORS);
const adsCol = () => col<CompetitorAdDoc>(CFG.COLL.COMPETITOR_ADS);

/* ---------------------------------- links --------------------------------- */

/** "https://www.Example.com/plots?x=1" → "example.com"; '' stays ''; anything else is refused. */
export function normalizeWebsite(input: unknown): string {
  const raw = str(input);
  if (!raw) return '';
  let host = '';
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch { /* refused below */ }
  host = host.replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw fail('VALIDATION', 'Enter the website like example.com.');
  return host;
}

/** Active ads shown in India, searched by the Page name (or the competitor's name). */
export function metaAdLibraryUrl(c: { name: string; pageName?: string }): string {
  const q = new URLSearchParams({ active_status: 'active', ad_type: 'all', country: 'IN', media_type: 'all', search_type: 'keyword_unordered', q: c.pageName || c.name });
  return `https://www.facebook.com/ads/library/?${q.toString()}`;
}

/** Ads of the website in India; without a website, the search page (type the name there). */
export function googleAdsUrl(c: { website?: string }): string {
  const q = new URLSearchParams({ region: 'IN' });
  if (c.website) q.set('domain', c.website);
  return `https://adstransparency.google.com/?${q.toString()}`;
}

/* ---------------------------------- views --------------------------------- */

export interface CompetitorCheckView { status: AdStatus; at: string; by: string }
export interface CompetitorAdView { id: string; platform: AdPlatform; link: string; imageUrl: string; offer: string; project: string; price: string; format: AdFormat; note: string; seenOn: string; createdBy: string }
export interface CompetitorView {
  id: string; name: string; pageName: string; website: string; area: string; assignedToId: string; assignedToName: string;
  metaUrl: string; googleUrl: string;
  meta: CompetitorCheckView | null; google: CompetitorCheckView | null;
  /** A platform was not checked in the last 7 days. */
  due: boolean;
  ads: CompetitorAdView[];
}

const checkView = (c: Check | null): CompetitorCheckView | null => (c ? { status: c.status, at: c.at.toISOString(), by: c.by } : null);
const stale = (c: Check | null, now: number) => !c || now - c.at.getTime() >= CHECK_EVERY_DAYS * DAY_MS;

function adView(a: CompetitorAdDoc): CompetitorAdView {
  return {
    id: a._id, platform: a.platform, link: a.link, imageUrl: a.imageFileId ? `/api/files/${a.imageFileId}` : '',
    offer: a.offer, project: a.project, price: a.price, format: a.format, note: a.note, seenOn: a.seenOn, createdBy: a.createdBy,
  };
}

/** People who may record a check (and so can be asked to). */
async function checkers(): Promise<Array<{ id: string; name: string }>> {
  return (await listUsers()).filter((u) => u.status === 'Active' && can(u as any, 'marketing.manage')).map((u) => ({ id: u.id, name: u.name }));
}

export async function listCompetitors(opts: { now?: number } = {}): Promise<{ competitors: CompetitorView[]; checkers: Array<{ id: string; name: string }>; checkEveryDays: number }> {
  const now = opts.now ?? Date.now();
  const [docs, ads, people] = await Promise.all([
    (await competitorsCol()).find({}).toArray(),
    (await adsCol()).find({}).sort({ seenOn: -1, createdAt: -1 }).toArray(),
    checkers(),
  ]);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const views = docs.map((c): CompetitorView => ({
    id: c._id, name: c.name, pageName: c.pageName, website: c.website, area: c.area,
    assignedToId: c.assignedToId, assignedToName: names.get(c.assignedToId) || '',
    metaUrl: metaAdLibraryUrl(c), googleUrl: googleAdsUrl(c),
    meta: checkView(c.meta), google: checkView(c.google),
    due: stale(c.meta, now) || stale(c.google, now),
    ads: ads.filter((a) => a.competitorId === c._id).map(adView),
  }));
  views.sort((a, b) => Number(b.due) - Number(a.due) || a.name.localeCompare(b.name));
  return { competitors: views, checkers: people, checkEveryDays: CHECK_EVERY_DAYS };
}

/* -------------------------------- competitors ------------------------------ */

const nameKeyOf = (name: string) => name.toLowerCase().replace(/\s+/g, ' ');

export async function saveCompetitor(d: any, ctx: Ctx): Promise<{ id: string }> {
  const name = truncate(str(d?.name), 120);
  if (!name) throw fail('VALIDATION', 'Enter the competitor\'s name.');
  const website = normalizeWebsite(d?.website);
  const assignedToId = str(d?.assignedToId);
  if (assignedToId && !(await checkers()).some((p) => p.id === assignedToId)) throw fail('VALIDATION', 'Choose an Admin or Manager to check this competitor.');
  const fields = { name, nameKey: nameKeyOf(name), pageName: truncate(str(d?.pageName), 120), website, area: truncate(str(d?.area), 120), assignedToId, updatedAt: new Date() };
  const c = await competitorsCol();
  const id = str(d?.id);
  const same = await c.findOne({ nameKey: fields.nameKey });
  if (same && same._id !== id) throw fail('VALIDATION', `${same.name} is already on the list.`);
  if (id) {
    const r = await c.updateOne({ _id: id }, { $set: fields });
    if (!r.matchedCount) throw fail('NOT_FOUND', 'This competitor is no longer on the list.');
    await auditLog(ctx, 'Competitor Updated', 'Competitors', id, name);
    return { id };
  }
  if ((await c.countDocuments({})) >= MAX_COMPETITORS) throw fail('VALIDATION', `The list is limited to ${MAX_COMPETITORS} competitors. Remove one first.`);
  const newId = uuid();
  await c.insertOne({ _id: newId, ...fields, meta: null, google: null, checks: [], createdBy: ctx.user?.name || 'System', createdAt: new Date() });
  await auditLog(ctx, 'Competitor Added', 'Competitors', newId, name);
  return { id: newId };
}

export async function deleteCompetitor(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const id = str(d?.id);
  const c = await (await competitorsCol()).findOne({ _id: id });
  if (!c) throw fail('NOT_FOUND', 'This competitor is no longer on the list.');
  const ads = await adsCol();
  const saved = await ads.find({ competitorId: id }).toArray();
  await Promise.all(saved.filter((a) => a.imageFileId).map((a) => deleteFile(a.imageFileId)));
  await ads.deleteMany({ competitorId: id });
  await (await competitorsCol()).deleteOne({ _id: id });
  await auditLog(ctx, 'Competitor Removed', 'Competitors', id, `${c.name} · ${saved.length} saved ad${saved.length === 1 ? '' : 's'}`);
  return { ok: true };
}

export async function recordCompetitorCheck(d: any, ctx: Ctx, opts: { now?: Date } = {}): Promise<{ ok: true }> {
  const platform = d?.platform as AdPlatform;
  const status = d?.status as AdStatus;
  if (!PLATFORMS.includes(platform) || !STATUSES.includes(status)) throw fail('VALIDATION', 'Choose Running or Not running.');
  const check: Check = { platform, status, at: opts.now ?? new Date(), by: ctx.user?.name || 'System' };
  const r = await (await competitorsCol()).updateOne(
    { _id: str(d?.id) },
    { $set: { [platform]: check, updatedAt: check.at }, $push: { checks: { $each: [check], $slice: -MAX_CHECKS } } } as any
  );
  if (!r.matchedCount) throw fail('NOT_FOUND', 'This competitor is no longer on the list.');
  await auditLog(ctx, 'Competitor Checked', 'Competitors', str(d?.id), `${platform === 'meta' ? 'Meta' : 'Google'}: ${status === 'running' ? 'running' : 'not running'}`);
  return { ok: true };
}

/* -------------------------------- saved ads -------------------------------- */

/** Only web links are kept (they are opened from the screen). */
function adLink(input: unknown): string {
  const raw = str(input);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') return truncate(u.toString(), 1000);
  } catch { /* refused below */ }
  throw fail('VALIDATION', 'The link must start with https://');
}

export async function saveCompetitorAd(d: any, ctx: Ctx): Promise<{ id: string }> {
  const competitorId = str(d?.competitorId);
  const competitor = await (await competitorsCol()).findOne({ _id: competitorId });
  if (!competitor) throw fail('NOT_FOUND', 'This competitor is no longer on the list.');
  const platform = d?.platform as AdPlatform;
  if (!PLATFORMS.includes(platform)) throw fail('VALIDATION', 'Choose Meta or Google.');
  const format = (FORMATS.includes(d?.format) ? d.format : 'other') as AdFormat;
  const seenOn = str(d?.seenOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seenOn) || Number.isNaN(Date.parse(seenOn))) throw fail('VALIDATION', 'Choose the date you saw this ad.');
  const link = adLink(d?.link);
  const offer = truncate(str(d?.offer), 300);
  const note = truncate(str(d?.note), 1000);
  const hasImage = !!d?.image?.base64;
  if (!link && !hasImage && !offer && !note) throw fail('VALIDATION', 'Add a link, a screenshot, the offer or a note.');
  let imageFileId = '';
  if (hasImage) {
    const mime = str(d.image.mime).toLowerCase();
    if (!/^image\/(jpeg|png)$/.test(mime)) throw fail('VALIDATION', 'Use a JPG or PNG screenshot.');
    const data = decodeBase64(d.image.base64);
    if (data.length > MAX_IMAGE) throw fail('VALIDATION', 'The screenshot is larger than 3 MB. Make it smaller first.');
    imageFileId = (await saveFile({ category: COMPETITOR_IMAGE_CATEGORY, name: str(d.image.name) || 'ad.jpg', mime, data, uploadedBy: ctx.user?.name || 'System' })).fileId;
  }
  const id = uuid();
  await (await adsCol()).insertOne({
    _id: id, competitorId, platform, link, imageFileId, offer, format, note, seenOn,
    project: truncate(str(d?.project), 120), price: truncate(str(d?.price), 120),
    createdBy: ctx.user?.name || 'System', createdAt: new Date(),
  });
  await auditLog(ctx, 'Competitor Ad Saved', 'Competitors', competitorId, `${competitor.name}${offer ? ' · ' + truncate(offer, 80) : ''}`);
  return { id };
}

export async function deleteCompetitorAd(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const ad = await (await adsCol()).findOneAndDelete({ _id: str(d?.id) });
  if (!ad) throw fail('NOT_FOUND', 'This saved ad is no longer here.');
  if (ad.imageFileId) await deleteFile(ad.imageFileId);
  await auditLog(ctx, 'Competitor Ad Removed', 'Competitors', ad.competitorId, truncate(ad.offer || ad.link || ad.note, 80));
  return { ok: true };
}

export const actions: ActionMap = {
  listCompetitors: { fn: () => listCompetitors(), perm: 'leads.view' },
  saveCompetitor: { fn: (d, ctx) => saveCompetitor(d, ctx), perm: 'marketing.manage' },
  deleteCompetitor: { fn: (d, ctx) => deleteCompetitor(d, ctx), perm: 'marketing.manage' },
  recordCompetitorCheck: { fn: (d, ctx) => recordCompetitorCheck(d, ctx), perm: 'marketing.manage' },
  saveCompetitorAd: { fn: (d, ctx) => saveCompetitorAd(d, ctx), perm: 'marketing.manage' },
  deleteCompetitorAd: { fn: (d, ctx) => deleteCompetitorAd(d, ctx), perm: 'marketing.manage' },
};
