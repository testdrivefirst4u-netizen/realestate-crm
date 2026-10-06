/**
 * Register a company (tenant) from the command line.
 *
 *   npx tsx scripts/create-company.ts --name "Amaya by Vera Vita" --slug amaya --plan enterprise \
 *     --admin-email rahul@example.com --admin-name "Rahul" [--admin-password <pw>] \
 *     [--adopt-db amaya_crm] [--features unitLocator,projectLibrary]
 *
 * Without --adopt-db a new database crm_<slug> is provisioned with a first Admin (temporary password
 * printed once unless --admin-password is given). With --adopt-db the company is registered on an EXISTING
 * database: nothing is created or copied; every existing user's e-mail is claimed in the platform
 * directory, and an Admin is created only when the database has no users. Refuses a database that is
 * already registered. --features switches the listed features ON on top of the plan's.
 */
import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

function arg(name: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}

const USAGE =
  'Usage: npx tsx scripts/create-company.ts --name "<Company>" --slug <slug> --plan <starter|growth|enterprise> ' +
  '--admin-email <email> --admin-name "<Name>" [--admin-password <pw>] [--adopt-db <existingDb>] [--features a,b]';

async function main() {
  loadEnv();
  const name = arg('name');
  const slug = arg('slug');
  const plan = arg('plan') || 'starter';
  const adminEmail = arg('admin-email');
  const adminName = arg('admin-name');
  const adminPassword = arg('admin-password');
  const adoptDb = arg('adopt-db');
  const featureList = arg('features').split(',').map((s) => s.trim()).filter(Boolean);
  if (!name || !slug || (!adoptDb && (!adminEmail || !adminName))) {
    console.error(USAGE);
    process.exit(1);
  }

  const { DEFAULT_FEATURES } = await import('../server/platform/registry');
  const unknown = featureList.filter((f) => !(f in DEFAULT_FEATURES));
  if (unknown.length) {
    console.error(`Unknown feature(s): ${unknown.join(', ')}. Known: ${Object.keys(DEFAULT_FEATURES).join(', ')}`);
    process.exit(1);
  }
  const { getPlan } = await import('../server/platform/plans');
  const p = await getPlan(plan);
  if (!p) {
    console.error(`Unknown plan "${plan}".`);
    process.exit(1);
  }
  const features = { ...p.features, ...Object.fromEntries(featureList.map((f) => [f, true])) };

  if (adoptDb) {
    const { adoptCompanyDb } = await import('../server/platform/companies');
    const r = await adoptCompanyDb({
      name,
      slug,
      plan,
      dbName: adoptDb,
      features,
      admin: adminEmail ? { name: adminName || adminEmail, email: adminEmail, password: adminPassword || undefined } : undefined,
    });
    console.log(`Registered ${r.company.name} as ${r.company._id} (slug "${r.company.slug}") on existing database "${adoptDb}".`);
    console.log(`Plan ${plan}; features on: ${Object.entries(r.company.features).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
    console.log(`Claimed ${r.claimed} user e-mail(s) in the platform directory.`);
    if (r.conflicts.length) {
      console.warn(`WARNING — ${r.conflicts.length} e-mail(s) already belong to another company (those users cannot sign in until resolved):`);
      r.conflicts.forEach((c) => console.warn('  • ' + c));
    }
    if (r.adminCreated) {
      console.log(`The database had no users — created administrator ${adminEmail.toLowerCase()}.`);
      if (r.adminTemporaryPassword) console.log(`Temporary password (shown once): ${r.adminTemporaryPassword}`);
    } else if (adminEmail) {
      console.log('Existing users were kept; no administrator was created (use scripts/create-admin.ts --company to add one).');
    }
    process.exit(0);
  }

  const { createCompany } = await import('../server/platform/companies');
  const r = await createCompany(
    { name, slug, plan, features, admin: { name: adminName, email: adminEmail, password: adminPassword || undefined } },
    { sa: null, token: '', expiresAt: '', userAgent: 'cli', ip: '' }
  );
  console.log(`Created ${r.company.name} as ${r.company.id} (slug "${r.company.slug}") with database "${r.company.dbName}".`);
  console.log(`Administrator: ${adminEmail.toLowerCase()}`);
  if (r.adminTemporaryPassword) console.log(`Temporary password (shown once): ${r.adminTemporaryPassword}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
