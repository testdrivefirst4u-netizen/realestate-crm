/**
 * Test helper: an isolated in-memory MongoDB per test file.
 *
 *   const t = await startTestDb();            // in beforeAll
 *   const admin = await t.ctx('Admin');        // signed-in context for a fresh user of that role
 *   await t.reset();                           // in beforeEach (drops every collection)
 *   await t.stop();                            // in afterAll
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { __setTestDb, PLATFORM_DB } from '../../server/core/db';
import { clearSettingsCache, setSecret } from '../../server/core/settings';
import { invalidateTenant, DEFAULT_FEATURES } from '../../server/platform/registry';
import { SYSTEM_CTX } from '../../server/core/auth';
import { createUser, findUserByEmail, publicUser, type Ctx } from '../../server/core/auth';
import type { Role } from '../../server/core/config';

export async function startTestDb() {
  // Generous start timeout: on Windows the first mongod launch is often slowed by antivirus scanning.
  const server = await MongoMemoryServer.create({ instance: { launchTimeout: 90000 } });
  const client = new MongoClient(server.getUri());
  await client.connect();
  const db = client.db('amaya_test');
  __setTestDb(db, client);
  let n = 0;

  return {
    db,
    async reset() {
      const cols = [...(await db.collections()), ...(await client.db(PLATFORM_DB()).collections())];
      await Promise.all(cols.map((c) => c.deleteMany({})));
      invalidateTenant();
      clearSettingsCache();
    },
    /** Register this test database as an active company (slug 'test') so routes that resolve a company work. */
    async company(slug = 'test', features: Partial<typeof DEFAULT_FEATURES> = {}) {
      await client.db(PLATFORM_DB()).collection('companies').updateOne(
        { _id: ('CMP-' + slug) as any },
        { $set: { slug, name: 'Test Co', dbName: db.databaseName, status: 'Active', plan: 'Test', maxUsers: 0, features: { ...DEFAULT_FEATURES, ...features }, logo: '', tagline: '', createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
      invalidateTenant();
      return slug;
    },
    /** Set (or clear with '') a company secret, as an admin would in Settings → Integrations. */
    async secret(key: string, value: string) {
      await setSecret(key, value, SYSTEM_CTX);
    },
    async stop() {
      await client.close();
      await server.stop();
    },
    /** A signed-in context for a new user with the given role. */
    async ctx(role: Role = 'Admin', name?: string): Promise<Ctx> {
      n += 1;
      const email = `${role.toLowerCase()}${n}@test.local`;
      await createUser({ name: name || `${role} ${n}`, email, password: 'correct-horse-1', role, mustChangePassword: false }, null);
      const u = (await findUserByEmail(email))!;
      return { user: publicUser(u), session: { expiresAt: new Date(Date.now() + 3600e3).toISOString() }, token: 'test', userAgent: 'vitest', ip: '127.0.0.1', action: 'test' };
    },
  };
}
