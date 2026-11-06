/**
 * Business Profile › Photos (feature businessProfile): the location's photos, added and deleted from the CRM.
 * Google My Business API v4: media (the company's own) and media/customers (read only; Google asks that their attribution is
 * shown, and removal goes through Google's request link). Google's links can change, so they are read fresh and not stored.
 * Adding = the image is kept in the file store (category 'Social posts', served by the signed public image route) and Google
 * is given that link. `businessPhotos` { _id: media name, fileId } lets the copy go when the photo is deleted.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { connection, pick, safeLink, short } from './businessProfile';
import { gbpFetch } from './googleMarketing';
import { POST_IMAGE_CATEGORY, publicMediaUrl } from './socialPosts';
import { decodeBase64, deleteFile, saveFile } from './storage';

const V4 = 'https://mybusiness.googleapis.com/v4';
const MAX_BYTES = 3 * 1024 * 1024;
const MIN_BYTES = 10240;
const MAX_PAGES = 3;
export const PHOTO_CATEGORIES = ['COVER', 'PROFILE', 'EXTERIOR', 'INTERIOR', 'PRODUCT', 'AT_WORK', 'COMMON_AREA', 'ROOMS', 'TEAMS', 'ADDITIONAL'];
const NO_SIZE_RULE = ['COVER', 'PROFILE'];

export interface BusinessPhoto { name: string; format: string; category: string; url: string; thumbnail: string; createdAt: string; author: string; authorUrl: string; removalUrl: string }
export interface BusinessPhotos { error: string; location: string; photos: BusinessPhoto[]; total: number; customerPhotos: BusinessPhoto[]; customerTotal: number; customersError: string }

const filesCol = () => col<{ _id: string; fileId: string; location: string; at: Date }>('businessPhotos');
const bad = (m: string) => fail('VALIDATION', m);

function readItem(m: any): BusinessPhoto {
  const at = String(m?.createTime || '');
  return {
    name: String(m?.name || ''), format: String(m?.mediaFormat || 'PHOTO'), category: String(m?.locationAssociation?.category || ''),
    url: safeLink(m?.googleUrl, ['https:']), thumbnail: safeLink(m?.thumbnailUrl, ['https:']),
    createdAt: at.startsWith('1970') ? '' : at, // Google gives the profile photo no real date
    author: String(m?.attribution?.profileName || ''), authorUrl: safeLink(m?.attribution?.profileUrl, ['https:']), removalUrl: safeLink(m?.attribution?.takedownUrl, ['https:']),
  };
}

async function place(wanted: unknown): Promise<{ parent: string; name: string; title: string }> {
  const { error, d } = await connection();
  if (error) throw bad(error);
  const loc = pick(d, wanted);
  if (!loc) throw bad('No Business Profile location found. Click Refresh accounts in Settings › Google.');
  if (!loc.account) throw bad('Click Refresh accounts in Settings › Google, then choose the location again.');
  return { parent: `${loc.account}/${loc.name}`, name: loc.name, title: loc.title };
}

export async function getBusinessPhotos(d: any = {}): Promise<BusinessPhotos> {
  const { error, d: doc } = await connection();
  const empty: BusinessPhotos = { error, location: '', photos: [], total: 0, customerPhotos: [], customerTotal: 0, customersError: '' };
  if (error) return empty;
  const loc = pick(doc, d?.location);
  if (!loc) return { ...empty, error: 'No Business Profile location found. Click Refresh accounts in Settings › Google.' };
  if (!loc.account) return { ...empty, error: 'Click Refresh accounts in Settings › Google, then choose the location again.' };
  const parent = `${loc.account}/${loc.name}`;
  try {
    const rows: any[] = [];
    let total = 0;
    let token = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const j = await gbpFetch<any>(`${V4}/${parent}/media?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      rows.push(...(j?.mediaItems || []));
      total = Number(j?.totalMediaItemCount) || rows.length;
      token = String(j?.nextPageToken || '');
      if (!token) break;
    }
    const out: BusinessPhotos = { ...empty, location: loc.name, total };
    const all = rows.map(readItem);
    out.photos = all.filter((p) => !p.author);
    try {
      const c = await gbpFetch<any>(`${V4}/${parent}/media/customers?pageSize=100`);
      out.customerPhotos = (c?.mediaItems || []).map(readItem);
      out.customerTotal = Number(c?.totalMediaItemCount) || out.customerPhotos.length;
    } catch (e) {
      out.customersError = short(e);
    }
    return out;
  } catch (e) {
    return { ...empty, location: loc.name, error: short(e) };
  }
}

export async function addBusinessPhoto(d: any, ctx: Ctx): Promise<BusinessPhoto> {
  const mime = String(d?.mime || '').toLowerCase();
  if (!/^image\/(jpeg|png)$/.test(mime)) throw bad('Use a JPG or PNG photo.');
  const category = String(d?.category || '');
  if (!PHOTO_CATEGORIES.includes(category)) throw bad('Choose what the photo shows.');
  const data = decodeBase64(d?.base64);
  if (data.length > MAX_BYTES) throw bad('The photo is larger than 3 MB. Make it smaller first.');
  if (data.length < MIN_BYTES && !NO_SIZE_RULE.includes(category)) throw bad('The photo is smaller than 10 KB, which Google does not accept.');
  const { parent, name, title } = await place(d?.location);
  const saved = await saveFile({ category: POST_IMAGE_CATEGORY, name: String(d?.name || 'photo.jpg'), mime, data, uploadedBy: ctx.user?.name || 'System' });
  try {
    const r = await gbpFetch<any>(`${V4}/${parent}/media`, { body: { mediaFormat: 'PHOTO', locationAssociation: { category }, sourceUrl: publicMediaUrl(saved.fileId) } });
    await (await filesCol()).updateOne({ _id: String(r?.name || saved.fileId) }, { $set: { fileId: saved.fileId, location: name, at: new Date() } }, { upsert: true });
    await auditLog(ctx, 'Business Profile Photo Added', 'Settings', name, `${title}: ${category}`);
    return readItem(r);
  } catch (e) {
    await deleteFile(saved.fileId).catch(() => undefined);
    throw bad(short(e)); // Google's reason is what the person needs
  }
}

export async function deleteBusinessPhoto(d: any, ctx: Ctx): Promise<{ ok: true }> {
  if (d?.confirm !== true) throw bad('Confirm the delete first.');
  const { parent, name, title } = await place(d?.location);
  const photo = String(d?.name || '');
  if (!photo.startsWith(`${parent}/media/`) || photo.startsWith(`${parent}/media/customers`)) throw bad('Only your own photos of this location can be deleted here.');
  const item = await gbpFetch<any>(`${V4}/${photo}`);
  if (item?.attribution?.profileName) throw bad("A customer's photo cannot be deleted here. Use its Request removal link.");
  try {
    await gbpFetch(`${V4}/${photo}`, { method: 'DELETE' });
  } catch (e) {
    throw bad(short(e));
  }
  const files = await filesCol();
  const kept = await files.findOneAndDelete({ _id: photo });
  if (kept?.fileId) await deleteFile(kept.fileId).catch(() => undefined);
  await auditLog(ctx, 'Business Profile Photo Deleted', 'Settings', name, `${title}: ${String(item?.locationAssociation?.category || '')}`);
  return { ok: true };
}

const feature = () => {
  if (!(currentTenant()?.features as any)?.businessProfile) throw fail('FORBIDDEN', "The Business Profile screen is not included in your company's plan.");
};

export const actions: ActionMap = {
  getBusinessPhotos: { fn: (d) => { feature(); return getBusinessPhotos(d); }, perm: 'reports.view' },
  addBusinessPhoto: { fn: (d, ctx) => { feature(); return addBusinessPhoto(d, ctx); }, perm: 'integrations.connect' },
  deleteBusinessPhoto: { fn: (d, ctx) => { feature(); return deleteBusinessPhoto(d, ctx); }, perm: 'integrations.connect' },
};
