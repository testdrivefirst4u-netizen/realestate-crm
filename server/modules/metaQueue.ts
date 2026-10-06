/**
 * Meta Lead Ads — webhook, lead queue and cron (contract: server/core/metaTypes.ts).
 *
 * Webhook (one URL for the platform, app/api/webhooks/meta/route.ts):
 *   GET  hub.mode=subscribe + hub.verify_token (constant-time) → the hub.challenge as text/plain, else 403.
 *   POST raw body (≤ 1 MB) → X-Hub-Signature-256 checked against the app secret BEFORE parsing (401 on mismatch)
 *        → each entry[].changes[] with field 'leadgen' is upserted into platform `metaLeadQueue`
 *        (_id = leadgen_id, so repeated deliveries are no-ops) → 200 at once; the queued ids are processed
 *        afterwards (`after()` in the route; tests call processQueueItem directly).
 * Processing one item: Page claim (metaPages) → company (Active, plan metaLeads) → source (Active, form filter)
 *   → Page token → Graph lead → ingestLead (idempotency key meta:<leadgen_id>).
 *   Statuses: pending → processing → done | skipped (paused source, form not selected, company without the plan)
 *   | orphan (no company has the Page) | failed (retried after 5/15/60/240 min) → dead after 5 attempts.
 * Cron (GET /api/cron/meta, every 5 min): due queue items (≤ 200 per run) and, once a day per source, a 2-day backfill.
 */
import { ApiError, fail } from '../core/errors';
import { logError } from '../core/events';
import { runWithTenant } from '../core/tenant';
import { safeEqual, truncate } from '../core/utils';
import { getLead, loadMetaConfig, TOKEN_EXPIRED_MSG, verifyHubSignature } from '../integrations/meta';
import { pc } from '../platform/base';
import { getTenantById, listActiveTenants, PCOLL } from '../platform/registry';
import { sourcesCol } from './intake';
import { errMsg, ingestMetaLead, metaPagesCol, pageTokenOf, runBackfill, type MetaSourceDoc } from './meta';

export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead' | 'skipped' | 'orphan';

export interface MetaQueueDoc {
  _id: string; // leadgen_id
  pageId: string;
  formId: string;
  adId: string;
  createdTime: number | string;
  receivedAt: Date;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: Date | null;
  lockedUntil?: Date | null;
  companyId?: string;
  sourceId?: string;
  leadId?: string;
  /** Intake outcome (created / duplicate / rejected / failed). */
  result?: string;
  processedAt?: Date;
}

export const MAX_BODY = 1024 * 1024;
export const BACKOFF_MIN = [5, 15, 60, 240];
export const MAX_ATTEMPTS = 5;
export const CRON_BATCH = 200;
const PROCESS_LOCK_MS = 3 * 60 * 1000;
const DAY_MS = 86400000;

export const queueCol = () => pc<MetaQueueDoc>(PCOLL.META_QUEUE);

const text = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/* --------------------------------- webhook ------------------------------- */

/** GET: Meta's subscription verification. */
export async function handleMetaWebhookGet(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const cfg = await loadMetaConfig();
  const mode = q.get('hub.mode') || '';
  const token = q.get('hub.verify_token') || '';
  const challenge = q.get('hub.challenge') || '';
  if (mode === 'subscribe' && cfg.verifyToken && token && safeEqual(token, cfg.verifyToken)) return text(truncate(challenge, 200), 200);
  return text('Forbidden', 403);
}

/** Queue the leadgen changes of a verified webhook body. Returns the leadgen ids found (new or not). */
export async function enqueueLeadgen(body: any, now = new Date()): Promise<{ ids: string[]; inserted: number }> {
  const ids: string[] = [];
  let inserted = 0;
  if (!body || typeof body !== 'object' || body.object !== 'page' || !Array.isArray(body.entry)) return { ids, inserted };
  const q = await queueCol();
  for (const entry of body.entry.slice(0, 500)) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (ch?.field !== 'leadgen' || !ch.value) continue;
      const v = ch.value;
      const id = String(v.leadgen_id ?? '').trim();
      if (!/^\d{1,40}$/.test(id)) continue;
      const doc: Omit<MetaQueueDoc, '_id'> = {
        pageId: String(v.page_id ?? entry?.id ?? '').slice(0, 40),
        formId: String(v.form_id ?? '').slice(0, 40),
        adId: String(v.ad_id ?? '').slice(0, 40),
        createdTime: typeof v.created_time === 'number' ? v.created_time : String(v.created_time ?? '').slice(0, 40),
        receivedAt: now,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: null,
      };
      try {
        const r = await q.updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
        if (r.upsertedCount) inserted++;
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // concurrent duplicate delivery
      }
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return { ids, inserted };
}

/**
 * POST: verify the signature on the raw bytes, queue, answer 200; `schedule` runs the processing after the
 * response (the route passes next/server `after`).
 */
export async function handleMetaWebhookPost(req: Request, schedule: (fn: () => Promise<unknown>) => void): Promise<Response> {
  const cfg = await loadMetaConfig();
  if (!cfg.appSecret) return json({ status: 'error', code: 'NOT_CONFIGURED', message: 'Meta app is not configured' }, 503);
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json({ status: 'error', code: 'VALIDATION', message: 'Payload too large' }, 413);
  let raw: Buffer;
  try {
    raw = Buffer.from(await req.arrayBuffer());
  } catch {
    return json({ status: 'error', code: 'VALIDATION', message: 'Unreadable body' }, 400);
  }
  if (raw.length > MAX_BODY) return json({ status: 'error', code: 'VALIDATION', message: 'Payload too large' }, 413);
  if (!verifyHubSignature(raw, req.headers.get('x-hub-signature-256'), cfg.appSecret)) {
    return json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Invalid signature' }, 401);
  }
  let body: any;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return json({ status: 'error', code: 'VALIDATION', message: 'Invalid JSON' }, 400);
  }
  try {
    const { ids, inserted } = await enqueueLeadgen(body);
    if (ids.length) schedule(() => processQueueItems(ids));
    return json({ status: 'success', data: { queued: inserted, received: ids.length } }, 200);
  } catch (e: any) {
    console.error('[webhook:meta] queue write failed', e?.message);
    // 500 → Meta re-delivers later
    return json({ status: 'error', code: 'INTERNAL', message: 'Could not queue the lead' }, 500);
  }
}

/* -------------------------------- processing ----------------------------- */

const dueFilter = (now: Date) => ({
  $or: [
    { status: 'pending' as const },
    { status: 'failed' as const, nextAttemptAt: { $lte: now } },
    { status: 'processing' as const, lockedUntil: { $lt: now } },
  ],
});

/**
 * Process one queued leadgen id (no-op when it is not due / already done). `now` is injectable for tests.
 * Returns the item as stored afterwards.
 */
export async function processQueueItem(id: string, opts: { now?: Date } = {}): Promise<MetaQueueDoc | null> {
  const now = opts.now || new Date();
  const q = await queueCol();
  const item = await q.findOneAndUpdate({ _id: String(id), ...dueFilter(now) }, { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + PROCESS_LOCK_MS) } }, { returnDocument: 'after' });
  if (!item) return q.findOne({ _id: String(id) });
  const finish = async (set: Partial<MetaQueueDoc>) => {
    await q.updateOne({ _id: item._id }, { $set: { ...set, lockedUntil: null, processedAt: new Date() } });
    return q.findOne({ _id: item._id });
  };

  const claim = item.pageId ? await (await metaPagesCol()).findOne({ _id: item.pageId }) : null;
  if (!claim) return finish({ status: 'orphan', lastError: 'No workspace has connected this Facebook Page' });
  const tenant = await getTenantById(claim.companyId);
  if (!tenant || tenant.status !== 'Active' || !tenant.features.metaLeads) {
    return finish({ status: 'skipped', companyId: claim.companyId, lastError: !tenant ? 'Workspace deleted' : tenant.status !== 'Active' ? 'Workspace suspended' : 'Plan without Meta Lead Ads' });
  }

  return runWithTenant(tenant, async () => {
    const sources = (await sourcesCol()) as unknown as import('mongodb').Collection<MetaSourceDoc>;
    const src = await sources.findOne({ _id: claim.sourceId, type: 'meta' });
    const base = { companyId: tenant.id, sourceId: claim.sourceId };
    if (!src) return finish({ ...base, status: 'orphan', lastError: 'The lead source of this Page was deleted' });
    if (src.status !== 'Active') return finish({ ...base, status: 'skipped', lastError: 'Lead source paused' });
    const formIds = src.config?.meta?.formIds || [];
    if (formIds.length && item.formId && !formIds.includes(item.formId)) return finish({ ...base, status: 'skipped', lastError: `Form ${item.formId} is not selected for this source` });
    try {
      const token = pageTokenOf(src);
      if (!token) throw fail('VALIDATION', TOKEN_EXPIRED_MSG);
      const lead = await getLead(item._id, token);
      const formId = String(lead.form_id || item.formId || '');
      if (formIds.length && formId && !formIds.includes(formId)) return finish({ ...base, status: 'skipped', lastError: `Form ${formId} is not selected for this source` });
      const r = await ingestMetaLead(src, { ...lead, id: lead.id || item._id, form_id: formId, ad_id: lead.ad_id || item.adId || undefined });
      await sources.updateOne({ _id: src._id }, { $set: { 'config.meta.lastLeadAt': new Date().toISOString(), 'config.meta.lastError': '' } });
      return finish({ ...base, status: 'done', leadId: r.leadId, result: r.status, lastError: r.status === 'failed' || r.status === 'rejected' ? truncate(r.message, 300) : '', attempts: item.attempts + 1, nextAttemptAt: null });
    } catch (e: any) {
      const attempts = (item.attempts || 0) + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const message = truncate(errMsg(e), 300);
      if (!(e instanceof ApiError)) await logError('meta:lead:' + item._id, 'INTERNAL', e?.message, e?.stack, src.name);
      await sources.updateOne({ _id: src._id }, { $set: { 'config.meta.lastError': message, 'stats.lastError': truncate('meta: ' + message, 300) } });
      return finish({
        ...base,
        status: dead ? 'dead' : 'failed',
        attempts,
        lastError: message,
        nextAttemptAt: dead ? null : new Date(now.getTime() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60000),
      });
    }
  });
}

/** Process several ids one after the other; errors are isolated per item. */
export async function processQueueItems(ids: string[], opts: { deadline?: number } = {}) {
  const out: Array<{ id: string; status: string }> = [];
  for (const id of ids) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try {
      const r = await processQueueItem(id);
      out.push({ id, status: r?.status || 'missing' });
    } catch (e: any) {
      console.error('[meta:queue]', id, e?.message);
      out.push({ id, status: 'error' });
    }
  }
  return out;
}

/* ----------------------------------- cron -------------------------------- */

export interface MetaCronResult {
  skipped?: string;
  queue: { processed: number; byStatus: Record<string, number> };
  backfills: Record<string, Array<{ id: string; result?: string; error?: string; skipped?: string }>>;
}

export async function runMetaCron(opts: { deadline?: number; now?: Date } = {}): Promise<MetaCronResult> {
  const out: MetaCronResult = { queue: { processed: 0, byStatus: {} }, backfills: {} };
  const cfg = await loadMetaConfig();
  if (!cfg.appId || !cfg.appSecret) return { ...out, skipped: 'Meta app is not configured' };
  const now = opts.now || new Date();
  const late = () => !!opts.deadline && Date.now() > opts.deadline;

  const due = await (await queueCol()).find(dueFilter(now), { projection: { _id: 1 } }).sort({ receivedAt: 1 }).limit(CRON_BATCH).toArray();
  for (const d of due) {
    if (late()) break;
    try {
      const r = await processQueueItem(d._id, { now });
      const s = r?.status || 'missing';
      out.queue.byStatus[s] = (out.queue.byStatus[s] || 0) + 1;
    } catch (e: any) {
      console.error('[cron:meta] queue item', d._id, e?.message);
      out.queue.byStatus.error = (out.queue.byStatus.error || 0) + 1;
    }
    out.queue.processed++;
  }

  // daily safety net: leads whose webhook never arrived (2 days, idempotent)
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.metaLeads) continue;
    try {
      const rows = await runWithTenant(tenant, async () => {
        const list: MetaCronResult['backfills'][string] = [];
        const sources = (await (await sourcesCol()).find({ type: 'meta', status: 'Active' }).sort({ _id: 1 }).toArray()) as MetaSourceDoc[];
        for (const s of sources) {
          const last = s.config?.meta?.lastBackfillAt ? new Date(s.config.meta.lastBackfillAt).getTime() : 0;
          if (last && now.getTime() - last < DAY_MS) continue;
          if (late()) {
            list.push({ id: s._id, skipped: 'time budget exhausted' });
            continue;
          }
          try {
            list.push({ id: s._id, result: (await runBackfill(s, 2, now.getTime())).message });
          } catch (e: any) {
            list.push({ id: s._id, error: errMsg(e) });
          }
        }
        return list;
      });
      if (rows.length) out.backfills[tenant.slug] = rows;
    } catch (e: any) {
      console.error(`[cron:meta] ${tenant.slug}`, e?.message);
      out.backfills[tenant.slug] = [{ id: '', error: 'failed' }];
    }
  }
  return out;
}

/** Queue counters for the console. */
export async function queueCounts(now = new Date()): Promise<{ pending: number; failed: number; done24h: number }> {
  const q = await queueCol();
  const [pending, failed, done24h] = await Promise.all([
    q.countDocuments({ status: { $in: ['pending', 'processing'] } }),
    q.countDocuments({ status: { $in: ['failed', 'dead'] } }),
    q.countDocuments({ status: 'done', processedAt: { $gte: new Date(now.getTime() - DAY_MS) } }),
  ]);
  return { pending, failed, done24h };
}
