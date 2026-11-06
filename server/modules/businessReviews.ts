/**
 * Business Profile › Reviews (feature businessProfile): the location's reviews read fresh from Google (v4), with replies
 * added, changed and deleted here. Customers write and own the reviews: Google has no way to add or delete one.
 * The same reviews reach Social Inbox through its own check, so a changed or deleted reply is changed there too.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { fail } from '../core/errors';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { place } from './businessPhotos';
import { connection, pick, safeLink, short } from './businessProfile';
import { gbpFetch } from './googleMarketing';
import { inboxCol } from './socialInbox';

const V4 = 'https://mybusiness.googleapis.com/v4';
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const ORDERS = ['updateTime desc', 'rating desc', 'rating'];
const MAX_REPLY_BYTES = 4096;

export interface BusinessReview { id: string; author: string; anonymous: boolean; photo: string; stars: number; comment: string; createdAt: string; updatedAt: string; reply: string; repliedAt: string }
export interface BusinessReviews { error: string; location: string; reviews: BusinessReview[]; average: number; total: number; nextPage: string }

const bad = (m: string) => fail('VALIDATION', m);

function readReview(r: any): BusinessReview {
  const anonymous = !!r?.reviewer?.isAnonymous;
  return {
    id: String(r?.reviewId || ''), anonymous, author: anonymous ? 'Anonymous' : String(r?.reviewer?.displayName || 'Google user'), photo: anonymous ? '' : safeLink(r?.reviewer?.profilePhotoUrl, ['https:']),
    stars: STARS[String(r?.starRating)] || 0, comment: String(r?.comment || ''), createdAt: String(r?.createTime || ''), updatedAt: String(r?.updateTime || ''),
    reply: String(r?.reviewReply?.comment || ''), repliedAt: String(r?.reviewReply?.updateTime || ''),
  };
}

export async function getBusinessReviews(d: any = {}): Promise<BusinessReviews> {
  const order = ORDERS.includes(String(d?.order)) ? String(d.order) : ORDERS[0];
  const { error, d: doc } = await connection();
  const empty: BusinessReviews = { error, location: '', reviews: [], average: 0, total: 0, nextPage: '' };
  if (error) return empty;
  const loc = pick(doc, d?.location);
  if (!loc) return { ...empty, error: 'No Business Profile location found. Click Refresh accounts in Settings › Google.' };
  if (!loc.account) return { ...empty, error: 'Click Refresh accounts in Settings › Google, then choose the location again.' };
  const q = new URLSearchParams({ pageSize: '50', orderBy: order });
  if (d?.page) q.set('pageToken', String(d.page));
  try {
    const j = await gbpFetch<any>(`${V4}/${loc.account}/${loc.name}/reviews?${q.toString()}`);
    return { ...empty, location: loc.name, reviews: (j?.reviews || []).map(readReview).filter((r: BusinessReview) => r.id), average: Number(j?.averageRating) || 0, total: Number(j?.totalReviewCount) || 0, nextPage: String(j?.nextPageToken || '') };
  } catch (e) {
    return { ...empty, location: loc.name, error: short(e) };
  }
}

const reviewIdOf = (d: any) => {
  const id = String(d?.reviewId || '').trim();
  if (!id || id.length > 400) throw bad('Choose a review.');
  return id;
};

/** Add a reply or change the one there: the same call at Google. It is public under the customer's review. */
export async function replyBusinessReview(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const id = reviewIdOf(d);
  const comment = String(d?.comment || '').trim();
  if (!comment) throw bad('Write a reply first.');
  if (Buffer.byteLength(comment, 'utf8') > MAX_REPLY_BYTES) throw bad('That reply is too long for Google. Make it shorter.');
  const { parent, name, title } = await place(d?.location);
  try {
    await gbpFetch(`${V4}/${parent}/reviews/${encodeURIComponent(id)}/reply`, { method: 'PUT', body: { comment } });
  } catch (e) {
    throw bad(short(e));
  }
  await (await inboxCol()).updateOne({ _id: `google:${id}:reply` }, { $set: { text: comment } });
  await auditLog(ctx, 'Google Review Replied', 'Settings', name, `${title}: ${truncate(comment, 120)}`);
  return { ok: true };
}

export async function deleteBusinessReply(d: any, ctx: Ctx): Promise<{ ok: true }> {
  if (d?.confirm !== true) throw bad('Confirm the delete first.');
  const id = reviewIdOf(d);
  const { parent, name, title } = await place(d?.location);
  try {
    await gbpFetch(`${V4}/${parent}/reviews/${encodeURIComponent(id)}/reply`, { method: 'DELETE' });
  } catch (e) {
    throw bad(short(e));
  }
  await (await inboxCol()).deleteOne({ _id: `google:${id}:reply` });
  await auditLog(ctx, 'Google Review Reply Deleted', 'Settings', name, title);
  return { ok: true };
}

const feature = () => {
  if (!(currentTenant()?.features as any)?.businessProfile) throw fail('FORBIDDEN', "The Business Profile screen is not included in your company's plan.");
};

export const actions: ActionMap = {
  getBusinessReviews: { fn: (d) => { feature(); return getBusinessReviews(d); }, perm: 'reports.view' },
  replyBusinessReview: { fn: (d, ctx) => { feature(); return replyBusinessReview(d, ctx); }, perm: 'marketing.manage' },
  deleteBusinessReply: { fn: (d, ctx) => { feature(); return deleteBusinessReply(d, ctx); }, perm: 'marketing.manage' },
};
