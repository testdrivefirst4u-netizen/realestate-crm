/**
 * Independent, verifiable recovery for one company database (finding 7).
 *
 * The in-app "lead backups" are gzip snapshots of the leads collection stored INSIDE the same database: useful for
 * undoing a bad import, useless if the database itself is lost. This exports EVERY collection of a company,
 * including GridFS media (lead documents, call recordings: the `files.files` / `files.chunks` collections), to a
 * directory OUTSIDE the database, with a manifest of counts and SHA-256 checksums; restores it into an isolated,
 * newly named database; and verifies the restore against the manifest.
 *
 * Encrypted secrets (`secrets` collection) are exported as stored — still encrypted. They are only usable with the
 * same SECRETS_ENCRYPTION_KEY, which must be kept separately (password manager / Vercel env). The verify step
 * reports whether a supplied key can decrypt them, without printing any value.
 *
 * Export format: <dir>/manifest.json + <dir>/<collection>.ejson (one canonical EJSON document per line).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BSON, type Db } from 'mongodb';

const { EJSON } = BSON;

export interface Manifest {
  format: 'amaya-crm-export/1';
  exportedAt: string;
  sourceDb: string;
  collections: Array<{ name: string; count: number; sha256: string; indexes: unknown[] }>;
}

const SKIP = new Set(['sessions', 'loginAttempts', 'rateLimits']); // short-lived; not needed to recover

export async function exportDb(db: Db, dir: string): Promise<Manifest> {
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Manifest = { format: 'amaya-crm-export/1', exportedAt: new Date().toISOString(), sourceDb: db.databaseName, collections: [] };
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.') && !SKIP.has(n)).sort();
  for (const name of names) {
    const file = path.join(dir, `${name}.ejson`);
    const out = fs.createWriteStream(file);
    const h = crypto.createHash('sha256');
    let count = 0;
    for await (const doc of db.collection(name).find({}).sort({ _id: 1 })) {
      const line = EJSON.stringify(doc, { relaxed: false }) + '\n';
      h.update(line);
      if (!out.write(line)) await new Promise<void>((r) => out.once('drain', () => r()));
      count++;
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    const indexes = (await db.collection(name).indexes()).filter((i) => i.name !== '_id_');
    manifest.collections.push({ name, count, sha256: h.digest('hex'), indexes });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Restore an export into `target`, which must be empty (an isolated, new database). */
export async function restoreInto(target: Db, dir: string): Promise<{ collections: number; documents: number }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.format !== 'amaya-crm-export/1') throw new Error('Not an Amaya CRM export');
  const existing = await target.listCollections({}, { nameOnly: true }).toArray();
  if (existing.length) throw new Error(`Refusing to restore into ${target.databaseName}: it is not empty. Restore into a new database name.`);
  let documents = 0;
  for (const c of manifest.collections) {
    const lines = fs.readFileSync(path.join(dir, `${c.name}.ejson`), 'utf8').split('\n').filter(Boolean);
    const docs = lines.map((l) => EJSON.parse(l, { relaxed: false }) as any);
    await target.createCollection(c.name);
    for (let i = 0; i < docs.length; i += 1000) await target.collection(c.name).insertMany(docs.slice(i, i + 1000), { ordered: true });
    for (const ix of c.indexes as any[]) {
      const { key, name, v: _v, ns: _ns, ...opts } = ix;
      await target.collection(c.name).createIndex(key, { name, ...opts }).catch(() => undefined);
    }
    documents += docs.length;
  }
  return { collections: manifest.collections.length, documents };
}

export interface VerifyReport {
  ok: boolean;
  collections: Array<{ name: string; expected: number; actual: number; checksumOk: boolean }>;
  media: { files: number; chunksOk: boolean; checked: number; problems: string[] };
  secrets: { count: number; decryptable: boolean | null };
}

/** Compare a restored database with the export manifest; check GridFS files are complete; try the key. */
export async function verifyRestore(target: Db, dir: string, opts: { encryptionKey?: string } = {}): Promise<VerifyReport> {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const rep: VerifyReport = { ok: true, collections: [], media: { files: 0, chunksOk: true, checked: 0, problems: [] }, secrets: { count: 0, decryptable: null } };
  for (const c of manifest.collections) {
    const h = crypto.createHash('sha256');
    let actual = 0;
    for await (const doc of target.collection(c.name).find({}).sort({ _id: 1 })) {
      h.update(EJSON.stringify(doc, { relaxed: false }) + '\n');
      actual++;
    }
    const checksumOk = h.digest('hex') === c.sha256;
    rep.collections.push({ name: c.name, expected: c.count, actual, checksumOk });
    if (actual !== c.count || !checksumOk) rep.ok = false;
  }
  // media: every GridFS file has all its chunks
  const files = target.collection('files.files');
  const chunks = target.collection('files.chunks');
  for await (const f of files.find({}, { projection: { _id: 1, length: 1, chunkSize: 1, filename: 1 } })) {
    rep.media.files++;
    const expected = f.length ? Math.ceil(Number(f.length) / Number(f.chunkSize || 261120)) : 0;
    const n = await chunks.countDocuments({ files_id: f._id });
    rep.media.checked++;
    if (n !== expected) {
      rep.media.chunksOk = false;
      rep.media.problems.push(`${String(f._id)}: ${n}/${expected} chunks`);
      rep.ok = false;
    }
  }
  // secrets: decryptable with the supplied key? (values are never printed)
  const secrets = await target.collection('secrets').find({}).toArray().catch(() => [] as any[]);
  rep.secrets.count = secrets.length;
  if (secrets.length && opts.encryptionKey) {
    rep.secrets.decryptable = secrets.every((s: any) => canDecrypt(String(s.value ?? ''), opts.encryptionKey!));
    if (!rep.secrets.decryptable) rep.ok = false;
  }
  return rep;
}

/** Same scheme as server/core/settings.ts (AES-256-GCM, key = SHA-256 of SECRETS_ENCRYPTION_KEY). */
function canDecrypt(stored: string, rawKey: string): boolean {
  try {
    const [iv, tag, data] = stored.split('.').map((p) => Buffer.from(p, 'base64'));
    if (!iv?.length || !tag?.length || !data) return false;
    const d = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(rawKey).digest(), iv);
    d.setAuthTag(tag);
    Buffer.concat([d.update(data), d.final()]);
    return true;
  } catch {
    return false;
  }
}

