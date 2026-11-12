/**
 * Recovery drill and independent export for one company (docs/RECOVERY.md).
 *
 *   npx tsx scripts/recovery.ts export  --company <slug> --out /secure/path/amaya-2026-11-10
 *   npx tsx scripts/recovery.ts restore --from /secure/path/amaya-2026-11-10 --into restore_drill_20261110
 *   npx tsx scripts/recovery.ts verify  --from /secure/path/amaya-2026-11-10 --into restore_drill_20261110
 *   npx tsx scripts/recovery.ts drill   --company <slug> --out /secure/path/drill-...   # export → restore → verify → drop
 *
 * `restore` only writes into a database that does not exist yet (isolated). It never touches the live company
 * database, and never registers the restored copy as a company. Set SECRETS_ENCRYPTION_KEY (from the password
 * manager) to also prove the stored secrets can be decrypted. Point MONGODB_URI at a non-production cluster for a
 * drill whenever possible (RESTORE_MONGODB_URI overrides the target cluster for restore / verify / drill).
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { exportDb, restoreInto, verifyRestore } from './recovery-lib';

for (const f of ['.env.local', '.env']) {
  const p = path.resolve(process.cwd(), f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const [cmd, ...argv] = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] || '' : '';
};

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is not set');
  const source = await new MongoClient(uri).connect();
  const target = process.env.RESTORE_MONGODB_URI ? await new MongoClient(process.env.RESTORE_MONGODB_URI).connect() : source;
  try {
    const companyDb = async () => {
      const slug = arg('company');
      const c = await source.db(process.env.PLATFORM_DB || 'amaya_platform').collection('companies').findOne({ slug });
      if (!c) throw new Error(`No company with slug ${slug}`);
      return source.db(String(c.dbName));
    };
    const into = () => {
      const name = arg('into') || `restore_drill_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now().toString(36)}`;
      if (!/^restore_/.test(name)) throw new Error('The restore target must be a new database whose name starts with restore_ (isolation guard).');
      return target.db(name);
    };
    const key = process.env.SECRETS_ENCRYPTION_KEY?.trim();
    if (cmd === 'export') {
      const m = await exportDb(await companyDb(), arg('out'));
      console.log(`Exported ${m.collections.length} collections, ${m.collections.reduce((a, c) => a + c.count, 0)} documents → ${arg('out')}`);
    } else if (cmd === 'restore') {
      const db = into();
      console.log(JSON.stringify({ into: db.databaseName, ...(await restoreInto(db, arg('from'))) }, null, 2));
    } else if (cmd === 'verify') {
      const rep = await verifyRestore(into(), arg('from'), { encryptionKey: key });
      console.log(JSON.stringify(rep, null, 2));
      if (!rep.ok) process.exitCode = 2;
    } else if (cmd === 'drill') {
      const out = arg('out');
      const started = Date.now();
      await exportDb(await companyDb(), out);
      const db = into();
      await restoreInto(db, out);
      const rep = await verifyRestore(db, out, { encryptionKey: key });
      await db.dropDatabase();
      console.log(JSON.stringify({ ok: rep.ok, minutes: Math.round((Date.now() - started) / 600) / 100, restoredInto: db.databaseName, dropped: true, report: rep }, null, 2));
      if (!rep.ok) process.exitCode = 2;
    } else {
      console.log('Usage: npx tsx scripts/recovery.ts <export|restore|verify|drill> …  (see the header of this file)');
      process.exitCode = 1;
    }
  } finally {
    await source.close();
    if (target !== source) await target.close();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
