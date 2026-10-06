/**
 * MongoDB access — successor of apps-script/02_Database.gs.
 *
 * - One cached MongoClient per server process (survives Next.js dev hot reloads via globalThis).
 * - Multi-tenant: each company has its own database; `getDb()`/`col()` resolve the database of the company
 *   in the current request context (server/core/tenant.ts) and throw when there is none. The platform
 *   registry (companies, super admins, user directory) lives in `platformDb()`.
 * - Development without MONGODB_URI starts a local MongoDB (mongodb-memory-server) persisted to ./.data,
 *   so `npm run dev` works with zero setup. Production requires MONGODB_URI.
 * - Business ids ('ENQ-0042', 'USR-0001', …) are the documents' `_id`, issued by an atomic counter
 *   that never goes backwards, so a deleted id is never handed out again.
 * - `bumpVersion()` replaces DATA_VERSION: clients poll getBootstrap({since}) and get `unchanged`
 *   until something is written.
 */
import { MongoClient, Db, Collection, Document, GridFSBucket } from 'mongodb';
import path from 'node:path';
import fs from 'node:fs';
import { CFG } from './config';
import { currentTenant, requireTenant } from './tenant';

type Cache = { client?: MongoClient; connecting?: Promise<MongoClient>; indexes: Map<string, Promise<void>>; memory?: any; testDb?: Db };
const g = globalThis as unknown as { __amayaMongo?: Cache };
const cache: Cache = (g.__amayaMongo ||= { indexes: new Map() });
cache.indexes ||= new Map();

export const PLATFORM_DB = () => process.env.PLATFORM_DB || 'amaya_platform';

async function resolveUri(): Promise<string> {
  const uri = process.env.MONGODB_URI?.trim();
  if (uri) return uri;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MONGODB_URI is not set. Add your MongoDB Atlas connection string to the environment.');
  }
  // Development fallback: a real mongod binary, persisted between restarts.
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const dbPath = path.resolve(process.cwd(), '.data', 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  if (!cache.memory) {
    cache.memory = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger', port: 27027, launchTimeout: 90000 } });
    console.log(`[db] MONGODB_URI not set — using local development MongoDB at ${cache.memory.getUri()} (data in ./.data)`);
  }
  return cache.memory.getUri();
}

/**
 * `mongodb+srv://` needs a DNS SRV lookup. On some Windows machines Node's resolver points at a local
 * DNS proxy (127.0.0.1 — VPN / endpoint-security clients) that refuses SRV queries even though the OS
 * resolves them fine. When that happens, retry once through MONGODB_DNS_SERVERS (default: public DNS).
 */
async function connectWithDnsFallback(uri: string): Promise<MongoClient> {
  const open = async () => {
    const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 });
    await client.connect();
    return client;
  };
  try {
    return await open();
  } catch (e: any) {
    const srvRefused = uri.startsWith('mongodb+srv://') && /querySrv (ECONNREFUSED|ETIMEOUT|ESERVFAIL)/.test(String(e?.message));
    if (!srvRefused) throw e;
    const dns = await import('node:dns');
    const servers = (process.env.MONGODB_DNS_SERVERS || '8.8.8.8,1.1.1.1').split(',').map((s) => s.trim()).filter(Boolean);
    console.warn(`[db] DNS SRV lookup refused by ${dns.getServers().join(', ')} — retrying via ${servers.join(', ')}`);
    dns.setServers(servers);
    return open();
  }
}

async function getClientInternal(): Promise<MongoClient> {
  if (cache.client) return cache.client;
  if (!cache.connecting) {
    cache.connecting = (async () => {
      const client = await connectWithDnsFallback(await resolveUri());
      cache.client = client;
      return client;
    })().catch((e) => {
      cache.connecting = undefined;
      throw e;
    });
  }
  return cache.connecting;
}

/** A company database by name, with its indexes ensured once per process. */
export async function dbByName(dbName: string): Promise<Db> {
  const db = (await getClientInternal()).db(dbName);
  if (!cache.indexes.has(dbName)) cache.indexes.set(dbName, ensureIndexes(db).catch((e) => console.error('[db] index creation failed', dbName, e)));
  await cache.indexes.get(dbName);
  return db;
}

/** The current company's database. Throws outside a company context (tenant isolation guard). */
export async function getDb(): Promise<Db> {
  const t = currentTenant();
  if (!t && cache.testDb) return dbByName(cache.testDb.databaseName); // unit tests only (set by __setTestDb)
  return dbByName(requireTenant().dbName);
}

/** The platform registry database (companies, super admins, user directory). */
export async function platformDb(): Promise<Db> {
  return (await getClientInternal()).db(PLATFORM_DB());
}

/** True only inside unit tests (a fallback database was registered with __setTestDb). */
export const isTestMode = () => !!cache.testDb;

/** Test hook: use this database when no company context is set, and this client for everything else. */
export function __setTestDb(db: Db, client?: MongoClient) {
  cache.testDb = db;
  if (client) {
    cache.client = client;
    cache.connecting = Promise.resolve(client);
  }
  cache.indexes.set(db.databaseName, ensureIndexes(db));
}

export async function col<T extends Document = Document>(name: string): Promise<Collection<T>> {
  return (await getDb()).collection<T>(name);
}

export async function pcol<T extends Document = Document>(name: string): Promise<Collection<T>> {
  return (await platformDb()).collection<T>(name);
}

export async function filesBucket() {
  return new GridFSBucket(await getDb(), { bucketName: CFG.COLL.FILES_BUCKET });
}

export async function getClient(): Promise<MongoClient | undefined> {
  return getClientInternal();
}

/* ------------------------------ indexes --------------------------------- */

export async function ensureIndexes(db: Db) {
  const C = CFG.COLL;
  const specs: Array<[string, Record<string, 1 | -1 | 'text'>, Record<string, unknown>?]> = [
    [C.LEADS, { phoneLast10: 1 }],
    [C.LEADS, { stage: 1 }],
    [C.LEADS, { assignedRm: 1, stage: 1 }],
    [C.LEADS, { nextFollowupAt: 1 }],
    [C.LEADS, { updatedAt: -1 }],
    [C.ARCHIVE, { archivedAt: -1 }],
    [C.TASKS, { assignedTo: 1, completed: 1, dateTime: 1 }],
    [C.TASKS, { leadId: 1 }],
    [C.INVENTORY, { tower: 1, floor: 1, unitNumber: 1 }],
    [C.INVENTORY, { leadId: 1 }],
    [C.USERS, { emailLower: 1 }, { unique: true }],
    [C.SESSIONS, { tokenHash: 1 }, { unique: true }],
    [C.SESSIONS, { userId: 1 }],
    [C.SESSIONS, { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    [C.EVENTS, { seq: -1 }],
    [C.TIMELINE, { leadId: 1, timestamp: -1 }],
    [C.CHAT_MESSAGES, { dedupeKey: 1 }, { unique: true, sparse: true }],
    [C.CHAT_MESSAGES, { phoneLast10: 1, timestamp: -1 }],
    [C.CHAT_CONTACTS, { phoneLast10: 1 }, { unique: true }],
    [C.CALLS, { leadId: 1, callDate: -1 }],
    [C.CALLS, { provider: 1, providerCallId: 1 }],
    [C.DOCUMENTS, { leadId: 1 }],
    [C.NOTES, { userId: 1, updated: -1 }],
    [C.CHECKLIST, { userId: 1 }],
    [C.AUDIT_LOG, { timestamp: -1 }],
    [C.AUDIT_LOG, { entityType: 1, entityId: 1 }],
    [C.ERROR_LOG, { timestamp: -1 }],
    [C.REPORTS, { generatedAt: -1 }],
    [C.LOGIN_ATTEMPTS, { key: 1 }, { unique: true }],
    [C.LOGIN_ATTEMPTS, { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    // lead sources (server/modules/intake.ts): submission log kept 180 days, idempotency per source
    ['inboundLeads', { receivedAt: 1 }, { expireAfterSeconds: 180 * 86400 }],
    ['inboundLeads', { sourceId: 1, receivedAt: -1 }],
    ['inboundLeads', { status: 1, receivedAt: -1 }],
    ['inboundLeads', { sourceId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }],
    ['rateLimits', { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    // Meta Lead Ads: pending Facebook logins (server/modules/meta.ts) expire after 30 minutes
    ['metaConnections', { expiresAt: 1 }, { expireAfterSeconds: 0 }],
  ];
  for (const [name, keys, opts] of specs) {
    await db.collection(name).createIndex(keys as any, (opts || {}) as any);
  }
}

/* ------------------------- counters & data version ----------------------- */

/** Next value of a named counter (atomic). */
export async function nextCounter(name: string): Promise<number> {
  const c = await col<{ _id: string; seq: number }>(CFG.COLL.COUNTERS);
  const res = await c.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return res!.seq;
}

/** Next sequential business id, e.g. nextSeq('ENQ', 4) → 'ENQ-0042'. Never reuses a number. */
export async function nextSeq(prefix: string, width = 4): Promise<string> {
  const n = await nextCounter('seq:' + prefix);
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

/** Make sure a counter is at least `min` (used by the Sheets migration so new ids continue after old ones). */
export async function ensureCounterAtLeast(name: string, min: number) {
  const c = await col<{ _id: string; seq: number }>(CFG.COLL.COUNTERS);
  await c.updateOne({ _id: name }, { $max: { seq: min } }, { upsert: true });
}

export async function getVersion(): Promise<string> {
  const m = await col<{ _id: string; value: string }>(CFG.COLL.META);
  const doc = await m.findOne({ _id: 'dataVersion' });
  return doc?.value || '0';
}

/** Call after every write. Clients see a new version on their next poll. */
export async function bumpVersion(): Promise<string> {
  const v = String(Date.now());
  const m = await col<{ _id: string; value: string }>(CFG.COLL.META);
  await m.updateOne({ _id: 'dataVersion' }, { $set: { value: v } }, { upsert: true });
  return v;
}

/** Strip Mongo's `_id` (and any other internal keys) from a document before returning it. */
export function clean<T extends Record<string, any>>(doc: T | null | undefined, ...omit: string[]): Omit<T, '_id'> | null {
  if (!doc) return null;
  const { _id, ...rest } = doc as any;
  for (const k of omit) delete rest[k];
  return rest;
}
