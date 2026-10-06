/**
 * Platform plumbing shared by the super-admin modules: platform indexes, platform id counters,
 * the request context of a super-admin call and the platform audit log (PCOLL.AUDIT).
 */
import type { Collection, Document, MongoClient } from 'mongodb';
import { getClient, pcol, platformDb } from '../core/db';
import { shortId, str, truncate } from '../core/utils';
import { PCOLL } from './registry';
import type { PlatformAuditEntry, SuperAdmin } from './contract';

/** Context of one platform request (sa is null until the session is validated). */
export interface SaCtx {
  sa: SuperAdmin | null;
  /** Raw session token from the cookie (never returned in JSON). */
  token: string;
  expiresAt: string;
  userAgent: string;
  ip: string;
}

/* -------------------------------- indexes -------------------------------- */

let indexState: { client?: MongoClient; db?: string; p?: Promise<void> } = {};

async function ensurePlatformIndexes() {
  const db = await platformDb();
  const specs: Array<[string, Record<string, 1 | -1>, Record<string, unknown>?]> = [
    [PCOLL.COMPANIES, { slug: 1 }, { unique: true }],
    [PCOLL.COMPANIES, { dbName: 1 }],
    [PCOLL.COMPANIES, { createdAt: -1 }],
    [PCOLL.DIRECTORY, { companyId: 1 }],
    [PCOLL.SUPER_ADMINS, { emailLower: 1 }, { unique: true }],
    [PCOLL.SA_SESSIONS, { tokenHash: 1 }, { unique: true }],
    [PCOLL.SA_SESSIONS, { saId: 1 }],
    [PCOLL.SA_SESSIONS, { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    [PCOLL.LOGIN_ATTEMPTS, { key: 1 }, { unique: true }],
    [PCOLL.LOGIN_ATTEMPTS, { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    [PCOLL.AUDIT, { timestamp: -1 }],
    [PCOLL.AUDIT, { companyId: 1, timestamp: -1 }],
    [PCOLL.API_KEYS, { companyId: 1, sourceId: 1 }],
    [PCOLL.SHEET_CLAIMS, { companyId: 1 }],
    [PCOLL.META_PAGES, { companyId: 1 }],
    [PCOLL.META_QUEUE, { status: 1, nextAttemptAt: 1 }],
    [PCOLL.META_QUEUE, { companyId: 1, status: 1 }],
    // queue entries (done, dead, orphan …) are kept 30 days for the console, then removed
    [PCOLL.META_QUEUE, { receivedAt: 1 }, { expireAfterSeconds: 30 * 86400 }],
  ];
  for (const [name, keys, opts] of specs) await db.collection(name).createIndex(keys as any, (opts || {}) as any);
}

/** A platform collection with the platform indexes ensured once per client/database. */
export async function pc<T extends Document = Document>(name: string): Promise<Collection<T>> {
  const client = await getClient();
  const db = (await platformDb()).databaseName;
  if (!indexState.p || indexState.client !== client || indexState.db !== db) {
    const p = ensurePlatformIndexes().catch((e) => {
      indexState = {};
      throw e;
    });
    indexState = { client, db, p };
  }
  await indexState.p;
  return pcol<T>(name);
}

/** Next platform id, e.g. nextPlatformId('CMP') → 'CMP-0001' (never reused). */
export async function nextPlatformId(prefix: string, width = 4): Promise<string> {
  const c = await pc<{ _id: string; seq: number }>(PCOLL.COUNTERS);
  const res = await c.findOneAndUpdate({ _id: 'seq:' + prefix }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `${prefix}-${String(res!.seq).padStart(width, '0')}`;
}

export async function ensurePlatformCounterAtLeast(prefix: string, min: number) {
  await (await pc<{ _id: string; seq: number }>(PCOLL.COUNTERS)).updateOne({ _id: 'seq:' + prefix }, { $max: { seq: min } }, { upsert: true });
}

/* --------------------------------- audit --------------------------------- */

export function actorLabel(ctx: Pick<SaCtx, 'sa'> | null | undefined) {
  const sa = ctx?.sa;
  return sa ? `${sa.name} <${sa.email}>` : 'System';
}

/** Append a platform audit entry. Never throws (a failed audit write is logged). */
export async function platformAudit(ctx: Pick<SaCtx, 'sa' | 'ip'> | null, action: string, companyId: string, details: string, actor?: string) {
  try {
    await (await pc(PCOLL.AUDIT)).insertOne({
      _id: shortId('PA') as any,
      timestamp: new Date(),
      actor: actor || actorLabel(ctx),
      action,
      companyId: companyId || '',
      details: truncate(details || '', 1000),
      ip: ctx?.ip || '',
    });
  } catch (e) {
    console.error('[platform-audit] failed', e);
  }
}

export async function listPlatformAudit(opts: { limit?: number; companyId?: string } = {}): Promise<PlatformAuditEntry[]> {
  const limit = Math.max(1, Math.min(Math.floor(Number(opts.limit) || 200), 1000));
  const q: Record<string, unknown> = {};
  if (opts.companyId) q.companyId = String(opts.companyId);
  const rows = await (await pc(PCOLL.AUDIT)).find(q).sort({ timestamp: -1 }).limit(limit).toArray();
  return rows.map((r: any) => ({
    id: str(r._id),
    timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : '',
    actor: str(r.actor),
    action: str(r.action),
    companyId: str(r.companyId),
    details: str(r.details),
  }));
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
