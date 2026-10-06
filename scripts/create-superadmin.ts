/**
 * Create a platform super admin, or reset an existing one (lockout recovery).
 *
 *   npm run create-superadmin -- <email> "<Full Name>" [password]
 *   npx tsx scripts/create-superadmin.ts ops@example.com "Ops Team"
 *
 * Without a password a random one is generated and printed once (min. 12 characters when supplied).
 * Resetting re-activates the account, clears its login lockout and signs out its sessions.
 * Uses MONGODB_URI / PLATFORM_DB from .env.local.
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
  const [email, name, password] = process.argv.slice(2);
  if (!email || !name) {
    console.error('Usage: npx tsx scripts/create-superadmin.ts <email> "<name>" [password]');
    process.exit(1);
  }
  const { upsertSuperAdminCli } = await import('../server/platform/superAdmins');
  const { randomPassword } = await import('../server/core/utils');
  const { PLATFORM_DB } = await import('../server/core/db');
  const pw = password || randomPassword(16);
  const r = await upsertSuperAdminCli(email, name, pw, !password);
  console.log(`${r.created ? 'Created' : 'Reset'} super admin ${email.toLowerCase()} (${r.id}) in platform database "${PLATFORM_DB()}".`);
  if (!password) console.log(`Temporary password (shown once): ${pw}`);
  console.log('Sign in at /superadmin');
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
