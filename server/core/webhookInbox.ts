/**
 * Durable webhook inbox (finding 4) — every provider event is written down before it is acknowledged.
 *
 *   receive(provider, payload, { dedupeKey })   persists the event (per company). Throws when the database cannot
 *                                               store it: the route then answers 503 so the provider re-delivers.
 *   process(id)                                 runs the provider's handler; success → done, failure → failed with
 *                                               back-off, after MAX_ATTEMPTS → dead (dead letter, kept for replay).
 *   runInboxDue(now)                            retries what is due (the 10-minute watch).
 *   replay(id, ctx)                             an admin re-runs a failed or dead event (Settings › Integrations).
 *
 * Idempotency: `_id` is provider + dedupe key (the provider's event id, else a SHA-256 of the body), so the same
 * delivery twice is stored once and processed once. A handler may still see one logical event more than once
 * (a retry after a crash mid-handler), so handlers stay idempotent themselves (e.g. calls upsert by provider call id).
 *
 * Acknowledgement contract per provider (routes):
 *   persisted + processed      → 200
 *   persisted, handler failed  → 200 {accepted, retrying}: the CRM owns the retry from here, so the provider is not
 *                                asked to re-send something already stored
 *   not persisted              → 503 (never a false success)
 */
import crypto from 'node:crypto';
import { col } from './db';
import { tenantKey } from './tenant';
import { auditLog, type Ctx } from './auth';
import { logError } from './events';
import { str, truncate } from './utils';

export const COLL_INBOX = 'webhookInbox';
export const MAX_ATTEMPTS = 6;
/** Back-off after attempt n (1-based): 1 min, 5 min, 30 min, 2 h, 6 h → dead after the 6th. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const LOCK_MS = 2 * 60_000;
const KEEP_DAYS = 30;

export type InboxStatus = 'received' | 'processing' | 'done' | 'failed' | 'dead';

export interface InboxDoc {
  _id: string;
  provider: string;
  dedupeKey: string;
  /** Correlates logs, the stored event and what it created. */
  correlationId: string;
  receivedAt: Date;
  /** When the provider says the event happened, if it says. */
  eventAt: Date | null;
  status: InboxStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lockedUntil: Date | null;
  lastError: string;
  payload: unknown;
  meta: Record<string, string>;
  result: unknown;
  processedAt: Date | null;
}

export type InboxHandler = (payload: any, meta: Record<string, string>) => Promise<unknown>;

/** Handlers by provider, loaded lazily (no import cycles; a company without a provider never loads it). */
const HANDLERS: Record<string, () => Promise<InboxHandler>> = {
  telephony: async () => {
    const { handleWebhook } = await import('../modules/calls');
    return (p, m) => handleWebhook(p, m.provider || '');
  },
  chat360: async () => {
    const { handleWebhook } = await import('../modules/chat360');
    return (p) => handleWebhook(p);
  },
  'meta-social': async () => {
    const { ingestSocialWebhook } = await import('../modules/socialInbox');
    return (p) => ingestSocialWebhook(p) as Promise<unknown>;
  },
};

/** For tests: replace a provider's handler. */
export function __setInboxHandler(provider: string, h: InboxHandler | null) {
  if (h) HANDLERS[provider] = async () => h;
  else delete HANDLERS[provider];
}

const inbox = () => col<InboxDoc>(COLL_INBOX);
const ready = new Map<string, Promise<unknown>>();
async function ensureIndexes() {
  const k = tenantKey();
  if (!ready.has(k)) {
    ready.set(
      k,
      inbox()
        .then((c) => Promise.all([
          c.createIndex({ status: 1, nextAttemptAt: 1 }),
          c.createIndex({ receivedAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 86400, partialFilterExpression: { status: 'done' } }),
        ]))
        .catch((e) => {
          ready.delete(k);
          console.error('[webhookInbox] index', e?.message);
        })
    );
  }
  await ready.get(k);
}

export const bodyHash = (raw: string | Buffer) => crypto.createHash('sha256').update(raw).digest('hex');

export interface Received {
  id: string;
  duplicate: boolean;
  status: InboxStatus;
  correlationId: string;
}

/** Persist an event. Throws if it cannot be stored — the caller must then NOT answer success. */
export async function receive(provider: string, payload: unknown, opts: { dedupeKey?: string; raw?: string; meta?: Record<string, string>; eventAt?: Date | null; now?: Date } = {}): Promise<Received> {
  await ensureIndexes();
  const now = opts.now || new Date();
  const key = truncate(str(opts.dedupeKey) || bodyHash(opts.raw ?? JSON.stringify(payload ?? null)), 200);
  const id = `${provider}:${key}`;
  const correlationId = crypto.randomUUID();
  const doc: InboxDoc = {
    _id: id, provider, dedupeKey: key, correlationId, receivedAt: now, eventAt: opts.eventAt ?? null, status: 'received', attempts: 0,
    nextAttemptAt: now, lockedUntil: null, lastError: '', payload, meta: opts.meta || {}, result: null, processedAt: null,
  };
  try {
    await (await inbox()).insertOne(doc);
    return { id, duplicate: false, status: 'received', correlationId };
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const seen = await (await inbox()).findOne({ _id: id }, { projection: { status: 1, correlationId: 1 } });
    return { id, duplicate: true, status: (seen?.status || 'received') as InboxStatus, correlationId: seen?.correlationId || correlationId };
  }
}

/** Run one stored event (no-op when it is done, dead, or being processed elsewhere). */
export async function process(id: string, now = new Date()): Promise<InboxDoc | null> {
  const c = await inbox();
  const item = await c.findOneAndUpdate(
    { _id: id, $or: [{ status: { $in: ['received', 'failed'] }, nextAttemptAt: { $lte: now } }, { status: 'processing', lockedUntil: { $lt: now } }] } as any,
    { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  );
  if (!item) return c.findOne({ _id: id });
  const loader = HANDLERS[item.provider];
  try {
    if (!loader) throw new Error(`No handler for provider ${item.provider}`);
    const result = await (await loader())(item.payload, item.meta || {});
    await c.updateOne({ _id: id }, { $set: { status: 'done', result: result ?? null, lastError: '', lockedUntil: null, nextAttemptAt: null, processedAt: new Date() } });
  } catch (e: any) {
    const dead = item.attempts >= MAX_ATTEMPTS;
    const wait = BACKOFF_MS[Math.min(item.attempts - 1, BACKOFF_MS.length - 1)];
    await c.updateOne({ _id: id }, { $set: { status: dead ? 'dead' : 'failed', lastError: truncate(str(e?.message || e), 500), lockedUntil: null, nextAttemptAt: dead ? null : new Date(now.getTime() + wait) } });
    await logError('webhook:' + item.provider, dead ? 'DEAD_LETTER' : 'RETRY', e?.message, e?.stack, 'webhook', { inboxId: id, correlationId: item.correlationId, attempts: item.attempts });
  }
  return c.findOne({ _id: id });
}

/** Retry what is due, oldest first (bounded per run). */
export async function runInboxDue(now = new Date(), limit = 100): Promise<{ done: number; failed: number; dead: number }> {
  const out = { done: 0, failed: 0, dead: 0 };
  const c = await inbox();
  const due = await c
    .find({ $or: [{ status: { $in: ['received', 'failed'] }, nextAttemptAt: { $lte: now } }, { status: 'processing', lockedUntil: { $lt: now } }] } as any, { projection: { _id: 1 } })
    .sort({ receivedAt: 1 })
    .limit(limit)
    .toArray();
  for (const d of due) {
    const r = await process(d._id, now);
    if (r?.status === 'done') out.done++;
    else if (r?.status === 'dead') out.dead++;
    else out.failed++;
  }
  return out;
}

/** An admin re-runs a failed or dead event now. */
export async function replay(id: string, ctx: Ctx): Promise<InboxDoc | null> {
  const c = await inbox();
  const r = await c.updateOne({ _id: str(id), status: { $in: ['failed', 'dead'] } }, { $set: { status: 'failed', nextAttemptAt: new Date(0), attempts: 0 } });
  if (!r.matchedCount) return c.findOne({ _id: str(id) });
  await auditLog(ctx, 'Webhook Replayed', 'Integrations', str(id), str(id).split(':')[0]);
  return process(str(id));
}

/** What the operator sees: counts and the latest problems (no payload bodies: they can hold customer data). */
export async function inboxHealth(provider?: string) {
  const c = await inbox();
  const match = provider ? { provider } : {};
  const counts = await c.aggregate<{ _id: { p: string; s: string }; n: number; last: Date }>([{ $match: match }, { $group: { _id: { p: '$provider', s: '$status' }, n: { $sum: 1 }, last: { $max: '$receivedAt' } } }]).toArray();
  const problems = await c.find({ ...match, status: { $in: ['failed', 'dead'] } }, { projection: { payload: 0, result: 0 } }).sort({ receivedAt: -1 }).limit(50).toArray();
  return {
    counts: counts.map((x) => ({ provider: x._id.p, status: x._id.s, count: x.n, lastReceivedAt: x.last?.toISOString?.() || '' })),
    problems: problems.map((p) => ({ id: p._id, provider: p.provider, status: p.status, attempts: p.attempts, lastError: p.lastError, receivedAt: p.receivedAt.toISOString(), nextAttemptAt: p.nextAttemptAt?.toISOString() || '', correlationId: p.correlationId })),
  };
}


/**
 * The acknowledgement a route sends for one delivery: persist, then process once inline. Never answers success for an
 * event that was not stored. Returns [httpStatus, body].
 */
export async function acceptDelivery(provider: string, payload: unknown, opts: { dedupeKey?: string; raw?: string; meta?: Record<string, string> } = {}): Promise<[number, Record<string, unknown>]> {
  let rec: Received;
  try {
    rec = await receive(provider, payload, opts);
  } catch (e: any) {
    console.error(`[webhook:${provider}] could not persist`, e?.message);
    return [503, { status: 'error', code: 'UNAVAILABLE', message: 'The event could not be stored. Please deliver it again.' }];
  }
  if (rec.duplicate && (rec.status === 'done' || rec.status === 'processing')) {
    return [200, { status: 'success', duplicate: true, correlationId: rec.correlationId }];
  }
  const after = await process(rec.id).catch(() => null);
  if (after?.status === 'done') return [200, { status: 'success', data: after.result, correlationId: rec.correlationId }];
  // stored: the CRM retries it (runInboxDue), so the provider need not
  return [200, { status: 'accepted', retrying: true, correlationId: rec.correlationId }];
}
