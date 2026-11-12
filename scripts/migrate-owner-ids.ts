/**
 * Backfill immutable owner ids (leads, tasks, calls, report snapshots) from display names, per company.
 *
 *   npx tsx scripts/migrate-owner-ids.ts                       # dry run, every company: counts + unmatched names
 *   npx tsx scripts/migrate-owner-ids.ts --company amaya       # dry run, one company (slug)
 *   npx tsx scripts/migrate-owner-ids.ts --company amaya --apply
 *   npx tsx scripts/migrate-owner-ids.ts --company amaya --rollback   # removes only ids this script stamped
 *
 * Run against a restored copy first (docs/RECOVERY.md), then production during a quiet hour. The app already
 * stamps ids on every new write and still matches names on rows without one, so the migration can run at any
 * time after deploying, and re-running it is harmless. Rows listed as "unmatched" name no current user: they were
 * orphaned before this change (e.g. an agent renamed earlier) — reassign them in the CRM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { migrateOwnerIds } from './migrate-owner-ids-lib';

for (const f of ['.env.local', '.env']) {
  const p = path.resolve(process.cwd(), f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes('--' + n);
const arg = (n: string) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] || '' : '';
};

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (flag('apply') && flag('rollback')) throw new Error('Choose --apply or --rollback, not both');
  const client = await new MongoClient(uri).connect();
  try {
    const platform = client.db(process.env.PLATFORM_DB || 'amaya_platform');
    const slug = arg('company');
    const companies = await platform.collection('companies').find(slug ? { slug } : {}, { projection: { slug: 1, dbName: 1 } }).toArray();
    if (!companies.length) throw new Error(slug ? `No company with slug ${slug}` : 'No companies registered');
    const mode = flag('rollback') ? 'ROLLBACK' : flag('apply') ? 'APPLY' : 'DRY RUN';
    console.log(`Owner-id migration · ${mode} · ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`);
    for (const c of companies) {
      const report = await migrateOwnerIds(client.db(String(c.dbName)), { apply: flag('apply'), rollback: flag('rollback') });
      console.log(`\n${c.slug} (${c.dbName})`);
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
