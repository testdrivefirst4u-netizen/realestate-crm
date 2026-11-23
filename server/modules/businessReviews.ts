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
import { claudeText, generateText, hasClaude } from './ai';
import { place } from './businessPhotos';
import { connection, pick, safeLink, selectedGbp, short } from './businessProfile';
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

/** Write a review reply with Claude (Anthropic) when its key is set — more accurate for short, on-brand replies —
 *  otherwise with Gemini. Both take the same owner-style system prompt. */
async function reviewReplyText(system: string, prompt: string): Promise<string> {
  if (await hasClaude()) return (await claudeText(system, prompt, { maxTokens: 220 })).trim();
  return (await generateText(prompt, SYSTEM_CTX, { fast: true, system, maxOutputTokens: 160, temperature: 0.5 })).trim();
}

/** Owner-style system prompt + user prompt for one review, shared by the daily auto-reply and the manual "Draft with AI". */
function reviewPrompts(r: { stars: number; comment?: string; author?: string; locationTitle?: string }): { system: string; prompt: string } {
  const company = String(currentTenant()?.name || 'our company');
  const author = String(r.author || '').trim();
  const good = (r.stars || 0) >= 4;
  const system = `You write the owner's public reply to a Google review for ${company}, a business in India. Reply in 1–3 short, warm, specific sentences: thank the reviewer${author ? ` (${author})` : ''}, acknowledge what they said if there is a comment, and ${good ? 'invite them back' : 'apologise sincerely and invite them to contact you so you can make it right'}. Plain text only — no emojis, hashtags, links or star mentions. Never invent facts, offers, discounts or promises. Do not exceed 70 words. Output only the reply text.`;
  const prompt = `Review: ${r.stars} stars${r.comment ? ` — "${truncate(String(r.comment), 600)}"` : ' (no written comment)'} by ${author || 'a customer'}${r.locationTitle ? ` at ${r.locationTitle}` : ''}. Write the public reply.`;
  return { system, prompt };
}

/** Manual "Draft with AI" on one review: returns a suggested reply for a person to edit and post (no auto-posting). */
export async function aiDraftReviewReply(d: any): Promise<{ reply: string }> {
  feature();
  const stars = clampStars(d?.stars);
  const { system, prompt } = reviewPrompts({ stars, comment: String(d?.comment || ''), author: String(d?.author || '') });
  const reply = await reviewReplyText(system, prompt);
  if (!reply || reply === 'HANDOFF') throw fail('SERVER', 'The AI could not draft a reply. Please write one.');
  return { reply: truncate(reply, 1500) };
}

/** Daily: reply to new Google reviews (no reply yet) at/above the star floor with a short AI-written, owner-style reply. */
export async function autoReplyReviews(): Promise<{ replied: number }> {
  try {
    const t = currentTenant();
    if (!(t?.features as any)?.businessProfile || !(t?.features as any)?.aiCopilot) return { replied: 0 };
    const cfg = await getReviewAutoReply();
    if (!cfg.enabled) return { replied: 0 };
    // every location, not just the default one — unanswered reviews from all branches
    const data = await allLocationReviews({ unansweredOnly: true, limit: 300 });
    if (data.error || !data.reviews.length) return { replied: 0 };
    let replied = 0;
    for (const r of data.reviews) {
      if (replied >= PER_RUN) break;
      if (r.reply || r.stars < cfg.minStars) continue; // already answered, or below the floor (left for the team)
      try {
        const { system, prompt } = reviewPrompts(r);
        const text = await reviewReplyText(system, prompt);
        if (!text || text === 'HANDOFF') continue;
        await replyBusinessReview({ reviewId: r.id, location: r.location, comment: text.slice(0, 1500) }, SYSTEM_CTX);
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

/* ------------------- reviews across every location ---------------------- */

export interface AllLocationReview extends BusinessReview { location: string; locationTitle: string; storeCode: string }
export interface AllLocationReviews { error: string; reviews: AllLocationReview[]; scanned: number; locations: number; unansweredTotal: number }

/**
 * Newest reviews across every connected location, each tagged with its location + store code, so the whole account
 * can be worked from one feed (like Google's manager). Fetches per location with a small concurrency pool; best-effort
 * per location (a failing one is skipped). Caps the number of locations scanned to protect the daily API quota.
 */
export async function allLocationReviews(d: any = {}): Promise<AllLocationReviews> {
  const unansweredOnly = !!d?.unansweredOnly;
  const limit = Math.min(300, Math.max(20, Math.floor(Number(d?.limit) || 150)));
  const { error, d: doc } = await connection();
  const empty: AllLocationReviews = { error, reviews: [], scanned: 0, locations: 0, unansweredTotal: 0 };
  if (error) return empty;
  const locs = selectedGbp<{ name: string; title: string; account?: string; storeCode?: string }>(doc).filter((l) => l.account && l.name);
  const slice = locs.slice(0, 60); // quota guard for very large accounts
  const all: AllLocationReview[] = [];
  let scanned = 0, i = 0;
  const worker = async () => {
    while (i < slice.length) {
      const loc = slice[i++];
      try {
        const j = await gbpFetch<any>(`${V4}/${loc.account}/${loc.name}/reviews?pageSize=20&orderBy=updateTime desc`);
        scanned++;
        for (const raw of j?.reviews || []) {
          const r = readReview(raw);
          if (r.id) all.push({ ...r, location: loc.name, locationTitle: loc.title, storeCode: loc.storeCode || '' });
        }
      } catch { /* skip this location */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, slice.length) }, worker));
  const unansweredTotal = all.filter((r) => !r.reply).length;
  const rows = (unansweredOnly ? all.filter((r) => !r.reply) : all).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { error: '', reviews: rows.slice(0, limit), scanned, locations: locs.length, unansweredTotal };
}

export const actions: ActionMap = {
  getBusinessReviews: { fn: (d) => { feature(); return getBusinessReviews(d); }, perm: 'reports.view' },
  allLocationReviews: { fn: (d) => { feature(); return allLocationReviews(d); }, perm: 'reports.view' },
  replyBusinessReview: { fn: (d, ctx) => { feature(); return replyBusinessReview(d, ctx); }, perm: 'marketing.manage' },
  deleteBusinessReply: { fn: (d, ctx) => { feature(); return deleteBusinessReply(d, ctx); }, perm: 'marketing.manage' },
  getReviewAutoReply: { fn: () => { feature(); return getReviewAutoReply(); }, perm: 'reports.view' },
  setReviewAutoReply: { fn: (d, ctx) => setReviewAutoReply(d, ctx), perm: 'marketing.manage' },
  aiDraftReviewReply: { fn: (d) => aiDraftReviewReply(d), perm: 'marketing.manage' },
};
