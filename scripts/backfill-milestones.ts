/**
 * Reconstruct journey milestones (contacted, qualified, visit scheduled / done, booked) for leads created before they
 * were recorded live, so reports have historical evidence instead of the current stage. Marks are tagged
 * 'backfill' and shown as reconstructed. See scripts/backfill-milestones-lib.ts for the sources used.
 *
 *   npx tsx scripts/backfill-milestones.ts [--company <slug>]            # dry run: counts per step
 *   npx tsx scripts/backfill-milestones.ts --company <slug> --apply
 *   npx tsx scripts/backfill-milestones.ts --company <slug> --rollback   # removes only backfilled marks
 */
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { backfillMilestones } from './backfill-milestones-lib';

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
    console.log(`Milestone backfill · ${mode} · ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`);
    for (const c of companies) {
      const report = await backfillMilestones(client.db(String(c.dbName)), { apply: flag('apply'), rollback: flag('rollback') });
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
