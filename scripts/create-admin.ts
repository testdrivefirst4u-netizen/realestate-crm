/**
 * Create a company administrator, or reset an existing user's password (lockout recovery).
 * Replaces SETUP_resetAdminPassword from apps-script/99_Setup.gs.
 *
 *   npx tsx scripts/create-admin.ts --company <slug> admin@example.com "Full Name" [password]
 *
 * Runs inside that company's context (its database and the platform user directory). Without a password a
 * random one is generated and printed once. Uses MONGODB_URI from .env.local.
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

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--company');
  const slug = ci >= 0 ? argv[ci + 1] || '' : '';
  const rest = ci >= 0 ? argv.filter((_, i) => i !== ci && i !== ci + 1) : argv;
  const [email, name, password] = rest;
  if (!slug || !email || !name) {
    console.error('Usage: npx tsx scripts/create-admin.ts --company <slug> <email> "<name>" [password]');
    process.exit(1);
  }
  const { getTenantBySlug } = await import('../server/platform/registry');
  const { runWithTenant } = await import('../server/core/tenant');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`No company with slug "${slug}". Create it first: npx tsx scripts/create-company.ts …`);
    process.exit(1);
  }
  const { createUser, findUserByEmail, updateUser, SYSTEM_CTX, revokeUserSessions } = await import('../server/core/auth');
  const { randomPassword } = await import('../server/core/utils');
  const pw = password || randomPassword(14);
  await runWithTenant(tenant, async () => {
    const existing = await findUserByEmail(email);
    if (existing) {
      await updateUser({ id: existing._id, password: pw, status: 'Active', role: 'Admin', mustChangePassword: !password }, SYSTEM_CTX);
      await revokeUserSessions(existing._id);
      console.log(`Updated ${email} in ${tenant.name}: role Admin, account active, password reset.`);
    } else {
      await createUser({ email, name, password: pw, role: 'Admin', mustChangePassword: !password }, null);
      console.log(`Created administrator ${email} in ${tenant.name}.`);
    }
  });
  if (tenant.status !== 'Active') console.warn(`Note: ${tenant.name} is suspended — nobody can sign in until a super admin re-activates it.`);
  if (!password) console.log(`Temporary password (shown once): ${pw}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
