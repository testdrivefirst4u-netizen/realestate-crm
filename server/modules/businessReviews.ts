/**
 * Business Profile › Reviews (feature businessProfile): the location's reviews read fresh from Google (v4), with replies
 * added, changed and deleted here. Customers write and own the reviews: Google has no way to add or delete one.
 * The same reviews reach Social Inbox through its own check, so a changed or deleted reply is changed there too.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { fail } from '../core/errors';
import { logError } from '../core/events';
import { settingSet, settingsAll } from '../core/settings';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { generateText } from './ai';
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

/* ----------------------- AI auto-reply to reviews ------------------------ */

export interface ReviewAutoReply { enabled: boolean; minStars: number }
const clampStars = (v: unknown) => Math.min(5, Math.max(1, Math.round(Number(v) || 4)));

export async function getReviewAutoReply(): Promise<ReviewAutoReply> {
  const s = await settingsAll();
  return { enabled: s.reviewAutoReplyEnabled === 'true', minStars: clampStars(s.reviewAutoReplyMinStars) };
}

export async function setReviewAutoReply(d: any, ctx: Ctx): Promise<ReviewAutoReply> {
  feature();
  const enabled = d?.enabled === true || d?.enabled === 'true';
  const minStars = clampStars(d?.minStars);
  await settingSet('reviewAutoReplyEnabled', enabled ? 'true' : 'false', ctx.user?.name || 'System');
  await settingSet('reviewAutoReplyMinStars', String(minStars), ctx.user?.name || 'System');
  await auditLog(ctx, 'Review Auto-reply ' + (enabled ? 'On' : 'Off'), 'Settings', 'reviews', `from ${minStars}★ and up`);
  return { enabled, minStars };
}

const PER_RUN = 10; // keep AI cost and Google writes bounded per daily run

/** Daily: reply to new Google reviews (no reply yet) at/above the star floor with a short AI-written, owner-style reply. */
export async function autoReplyReviews(): Promise<{ replied: number }> {
  try {
    const t = currentTenant();
    if (!(t?.features as any)?.businessProfile || !(t?.features as any)?.aiCopilot) return { replied: 0 };
    const cfg = await getReviewAutoReply();
    if (!cfg.enabled) return { replied: 0 };
    const data = await getBusinessReviews({});
    if (data.error || !data.location || !data.reviews.length) return { replied: 0 };
    const company = String(t?.name || 'our company');
    const system = `You write the owner's public reply to a Google review for ${company}, a real-estate business in India. Reply in 1–2 short, warm, specific sentences: thank the reviewer, acknowledge what they said if there is a comment, and invite them back. Plain text only — no emojis, no hashtags, no links, no star mentions. Never promise anything specific. Do not exceed 60 words.`;
    let replied = 0;
    for (const r of data.reviews) {
      if (replied >= PER_RUN) break;
      if (r.reply || r.stars < cfg.minStars) continue; // already answered, or below the floor (left for the team)
      try {
        const prompt = `Review: ${r.stars} stars${r.comment ? ` — "${truncate(r.comment, 600)}"` : ' (no written comment)'} by ${r.author}. Write the public reply.`;
        const text = (await generateText(prompt, SYSTEM_CTX, { fast: true, system, maxOutputTokens: 160, temperature: 0.5 })).trim();
        if (!text || text === 'HANDOFF') continue;
        await replyBusinessReview({ reviewId: r.id, location: data.location, comment: text.slice(0, 1500) }, SYSTEM_CTX);
        replied++;
      } catch (e: any) {
        await logError('reviews.autoReply', 'INTERNAL', e?.message, e?.stack, 'System', { reviewId: r.id });
      }
    }
    return { replied };
  } catch (e: any) {
    await logError('reviews.autoReply', 'INTERNAL', e?.message, e?.stack, 'System', {});
    return { replied: 0 };
  }
}

export const actions: ActionMap = {
  getBusinessReviews: { fn: (d) => { feature(); return getBusinessReviews(d); }, perm: 'reports.view' },
  replyBusinessReview: { fn: (d, ctx) => { feature(); return replyBusinessReview(d, ctx); }, perm: 'marketing.manage' },
  deleteBusinessReply: { fn: (d, ctx) => { feature(); return deleteBusinessReply(d, ctx); }, perm: 'marketing.manage' },
  getReviewAutoReply: { fn: () => { feature(); return getReviewAutoReply(); }, perm: 'reports.view' },
  setReviewAutoReply: { fn: (d, ctx) => setReviewAutoReply(d, ctx), perm: 'marketing.manage' },
};
