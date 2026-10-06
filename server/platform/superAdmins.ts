/**
 * Super admins (platform operators): accounts, sessions, login throttling and first-run setup.
 *
 * - Accounts in PCOLL.SUPER_ADMINS ({_id: 'SA-0001', name, email, emailLower (unique), passwordHash (bcrypt 12),
 *   status, mustChangePassword, createdAt, lastLoginAt}).
 * - Sessions in PCOLL.SA_SESSIONS: random 256-bit token stored only as a SHA-256 hash, 8 h sliding expiry
 *   (TTL index), sent to the browser only in the httpOnly `platform_session` cookie.
 * - Throttling: 8 failures per email+IP in 15 minutes lock that pair for 15 minutes (PCOLL.LOGIN_ATTEMPTS).
 * - Same error for unknown, disabled and wrong-password accounts.
 * - First run (saSetup) works only while there are no super admins; a PLATFORM_SETUP_TOKEN is required
 *   in production (otherwise `npm run create-superadmin` is the way in).
 */
import bcrypt from 'bcryptjs';
import { fail } from '../core/errors';
import { randomPassword, randomToken, safeEqual, sha256Hex, truncate } from '../core/utils';
import { PCOLL } from './registry';
import { ensurePlatformCounterAtLeast, nextPlatformId, pc, platformAudit, type SaCtx } from './base';
import type { SuperAdmin } from './contract';

export interface SuperAdminDoc {
  _id: string; // SA-0001
  name: string;
  email: string;
  emailLower: string;
  passwordHash: string;
  status: 'Active' | 'Disabled';
  mustChangePassword: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

interface SaSessionDoc {
  _id?: any;
  tokenHash: string;
  saId: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeen: Date;
  userAgent: string;
  ip: string;
}

export const SA_SESSION_HOURS = 8;
const MIN_PASSWORD = 12;
const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const BAD_LOGIN = 'Invalid email or password';

export const PLATFORM_NAME = () => process.env.PLATFORM_NAME || 'Amaya CRM Platform';

const admins = () => pc<SuperAdminDoc>(PCOLL.SUPER_ADMINS);
const sessions = () => pc<SaSessionDoc>(PCOLL.SA_SESSIONS);
const attempts = () => pc<{ _id?: any; key: string; count: number; expiresAt: Date; lockedUntil?: Date }>(PCOLL.LOGIN_ATTEMPTS);

export function publicSuperAdmin(d: SuperAdminDoc): SuperAdmin {
  return {
    id: d._id,
    name: d.name,
    email: d.emailLower,
    status: d.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
    lastLoginAt: d.lastLoginAt ? new Date(d.lastLoginAt).toISOString() : '',
    mustChangePassword: !!d.mustChangePassword,
  };
}

function checkPassword(pw: unknown) {
  if (String(pw || '').length < MIN_PASSWORD) throw fail('VALIDATION', `Password must be at least ${MIN_PASSWORD} characters`);
  if (String(pw).length > 200) throw fail('VALIDATION', 'Password is too long');
}

function cleanEmail(v: unknown) {
  const e = String(v || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 200) throw fail('VALIDATION', 'A valid email address is required');
  return e;
}

function cleanName(v: unknown) {
  const n = String(v || '').trim();
  if (!n) throw fail('VALIDATION', 'Name is required');
  return truncate(n, 120);
}

export const hashSaPassword = (pw: string) => bcrypt.hash(String(pw), 12);

export async function countSuperAdmins() {
  return (await admins()).countDocuments({});
}

/* ------------------------------ first run ------------------------------- */

export function setupTokenRequired() {
  return !!process.env.PLATFORM_SETUP_TOKEN || process.env.NODE_ENV === 'production';
}

export async function saStatus() {
  return { setupRequired: (await countSuperAdmins()) === 0, setupTokenRequired: setupTokenRequired(), platformName: PLATFORM_NAME() };
}

/** Create the first super admin and sign in. Allowed only while there are none. */
export async function saSetup(d: any, ctx: SaCtx) {
  const expected = process.env.PLATFORM_SETUP_TOKEN || '';
  if (!expected && process.env.NODE_ENV === 'production') {
    throw fail('FORBIDDEN', 'Web setup is disabled in production without PLATFORM_SETUP_TOKEN. Run `npm run create-superadmin` on the server instead.');
  }
  if (expected && !safeEqual(String(d?.setupToken || ''), expected)) throw fail('FORBIDDEN', 'Setup token is missing or wrong');
  if ((await countSuperAdmins()) > 0) throw fail('FORBIDDEN', 'The platform is already set up. Please sign in.');
  const name = cleanName(d?.name);
  const email = cleanEmail(d?.email);
  checkPassword(d?.password);
  const doc: SuperAdminDoc = {
    _id: 'SA-0001', // fixed id: a concurrent second setup fails on the duplicate key
    name,
    email,
    emailLower: email,
    passwordHash: await hashSaPassword(String(d.password)),
    status: 'Active',
    mustChangePassword: false,
    createdAt: new Date(),
    lastLoginAt: null,
  };
  try {
    await (await admins()).insertOne(doc);
  } catch (e: any) {
    if (e?.code === 11000) throw fail('FORBIDDEN', 'The platform is already set up. Please sign in.');
    throw e;
  }
  if ((await countSuperAdmins()) > 1) {
    await (await admins()).deleteOne({ _id: doc._id, emailLower: email });
    throw fail('FORBIDDEN', 'The platform is already set up. Please sign in.');
  }
  await ensurePlatformCounterAtLeast('SA', 1);
  await platformAudit({ sa: publicSuperAdmin(doc), ip: ctx.ip }, 'Platform Setup', '', `First super admin ${email}`);
  return saLogin({ email, password: d.password }, ctx);
}

/* -------------------------------- login --------------------------------- */

async function assertNotLocked(key: string) {
  const a = await (await attempts()).findOne({ key });
  if (a?.lockedUntil && a.lockedUntil.getTime() > Date.now()) {
    const mins = Math.ceil((a.lockedUntil.getTime() - Date.now()) / 60000);
    throw fail('RATE_LIMIT', `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
}

async function recordFailure(key: string) {
  const c = await attempts();
  const res = await c.findOneAndUpdate(
    { key },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + LOCK_MINUTES * 60000) } },
    { upsert: true, returnDocument: 'after' }
  );
  if (res && res.count >= MAX_FAILURES) {
    const until = new Date(Date.now() + LOCK_MINUTES * 60000);
    await c.updateOne({ key }, { $set: { lockedUntil: until, expiresAt: until } });
  }
}

/** Is this e-mail a super admin account? (The unified sign-in tries the console first for these.) */
export async function isSuperAdminEmail(email: string): Promise<boolean> {
  const e = String(email || '').trim().toLowerCase();
  return !!e && !!(await (await admins()).findOne({ emailLower: e }, { projection: { _id: 1 } }));
}

/** Sign in. Returns the raw token for the route handler (it goes into the cookie, never into JSON). */
export async function saLogin(d: any, ctx: Pick<SaCtx, 'ip' | 'userAgent'>): Promise<{ user: SuperAdmin; expiresAt: string; token: string }> {
  const email = String(d?.email || '').trim().toLowerCase();
  const key = `sa|${email}|${ctx.ip || ''}`;
  await assertNotLocked(key);
  const u = email ? await (await admins()).findOne({ emailLower: email }) : null;
  const okPw = u ? await bcrypt.compare(String(d?.password || ''), u.passwordHash || '') : false;
  if (!u || !okPw || u.status === 'Disabled') {
    await recordFailure(key);
    await platformAudit({ sa: null, ip: ctx.ip || '' }, 'Super Admin Login Failed', '', truncate(email, 200));
    throw fail('AUTH_FAILED', BAD_LOGIN);
  }
  await (await attempts()).deleteOne({ key });
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SA_SESSION_HOURS * 3600000);
  await (await sessions()).insertOne({
    tokenHash: sha256Hex(token),
    saId: u._id,
    createdAt: now,
    expiresAt: expires,
    lastSeen: now,
    userAgent: truncate(ctx.userAgent || '', 160),
    ip: truncate(ctx.ip || '', 64),
  });
  await (await admins()).updateOne({ _id: u._id }, { $set: { lastLoginAt: now } });
  const user = publicSuperAdmin({ ...u, lastLoginAt: now });
  await platformAudit({ sa: user, ip: ctx.ip || '' }, 'Super Admin Logged In', '', '');
  return { user, expiresAt: expires.toISOString(), token };
}

/**
 * Resolve a raw token to the signed-in super admin. Sliding expiry: the session is pushed out to a full
 * 8 h once at least 5 minutes have passed since the last extension (so not every request writes).
 */
export async function validateSaSession(token: string): Promise<{ user: SuperAdmin; expiresAt: string; refreshed: boolean } | null> {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const s = await (await sessions()).findOne({ tokenHash: sha256Hex(token) });
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    await (await sessions()).deleteOne({ _id: s._id });
    return null;
  }
  const u = await (await admins()).findOne({ _id: s.saId });
  if (!u || u.status === 'Disabled') {
    await (await sessions()).deleteOne({ _id: s._id });
    return null;
  }
  let expiresAt = s.expiresAt;
  let refreshed = false;
  const full = SA_SESSION_HOURS * 3600000;
  if (s.expiresAt.getTime() - Date.now() < full - 5 * 60000) {
    expiresAt = new Date(Date.now() + full);
    refreshed = true;
    await (await sessions()).updateOne({ _id: s._id }, { $set: { expiresAt, lastSeen: new Date() } });
  }
  return { user: publicSuperAdmin(u), expiresAt: expiresAt.toISOString(), refreshed };
}

export async function saLogout(ctx: SaCtx) {
  if (ctx.token) await (await sessions()).deleteOne({ tokenHash: sha256Hex(ctx.token) });
  await platformAudit(ctx, 'Super Admin Logged Out', '', '');
  return null;
}

export async function revokeSaSessions(saId: string, exceptToken?: string) {
  const q: Record<string, unknown> = { saId };
  if (exceptToken) q.tokenHash = { $ne: sha256Hex(exceptToken) };
  await (await sessions()).deleteMany(q);
}

export async function saChangePassword(d: any, ctx: SaCtx) {
  const me = await (await admins()).findOne({ _id: ctx.sa!.id });
  if (!me) throw fail('AUTH_REQUIRED', 'Please sign in');
  if (!(await bcrypt.compare(String(d?.currentPassword || ''), me.passwordHash || ''))) throw fail('VALIDATION', 'Current password is incorrect');
  checkPassword(d?.newPassword);
  if (String(d.newPassword) === String(d.currentPassword)) throw fail('VALIDATION', 'The new password must be different');
  await (await admins()).updateOne({ _id: me._id }, { $set: { passwordHash: await hashSaPassword(String(d.newPassword)), mustChangePassword: false } });
  await revokeSaSessions(me._id, ctx.token);
  await platformAudit(ctx, 'Super Admin Password Changed', '', me.emailLower);
  return null;
}

/* ------------------------------ management ------------------------------ */

export async function listSuperAdmins(): Promise<SuperAdmin[]> {
  const rows = await (await admins()).find({}).sort({ createdAt: 1 }).toArray();
  return rows.map(publicSuperAdmin);
}

async function activeCount() {
  return (await admins()).countDocuments({ status: { $ne: 'Disabled' } });
}

/** Create (no id → temporary password returned once) or update a super admin. */
export async function saveSuperAdmin(d: any, ctx: SaCtx): Promise<{ user: SuperAdmin; temporaryPassword?: string }> {
  const name = cleanName(d?.name);
  const email = cleanEmail(d?.email);
  const status: 'Active' | 'Disabled' | undefined = d?.status === undefined ? undefined : d.status === 'Disabled' ? 'Disabled' : 'Active';
  const c = await admins();
  const other = await c.findOne({ emailLower: email });

  if (!d?.id) {
    if (other) throw fail('CONFLICT', 'A super admin with this email already exists');
    const pw = randomPassword(16);
    const doc: SuperAdminDoc = {
      _id: await nextPlatformId('SA'),
      name,
      email,
      emailLower: email,
      passwordHash: await hashSaPassword(pw),
      status: status || 'Active',
      mustChangePassword: true,
      createdAt: new Date(),
      lastLoginAt: null,
    };
    try {
      await c.insertOne(doc);
    } catch (e: any) {
      if (e?.code === 11000) throw fail('CONFLICT', 'A super admin with this email already exists');
      throw e;
    }
    await platformAudit(ctx, 'Super Admin Created', '', `${doc._id} ${email}`);
    return { user: publicSuperAdmin(doc), temporaryPassword: pw };
  }

  const u = await c.findOne({ _id: String(d.id) });
  if (!u) throw fail('NOT_FOUND', 'Super admin not found');
  if (other && other._id !== u._id) throw fail('CONFLICT', 'Another super admin already uses this email');
  if (status === 'Disabled' && u.status !== 'Disabled') {
    if (ctx.sa?.id === u._id) throw fail('VALIDATION', 'You cannot disable your own account');
    if ((await activeCount()) <= 1) throw fail('VALIDATION', 'Cannot disable the last active super admin');
  }
  const set: Partial<SuperAdminDoc> = { name, email, emailLower: email };
  if (status) set.status = status;
  try {
    await c.updateOne({ _id: u._id }, { $set: set });
  } catch (e: any) {
    if (e?.code === 11000) throw fail('CONFLICT', 'Another super admin already uses this email');
    throw e;
  }
  if (set.status === 'Disabled') await revokeSaSessions(u._id);
  const changed = (['name', 'email', 'status'] as const).filter((k) => set[k] !== undefined && set[k] !== (k === 'email' ? u.emailLower : u[k]));
  await platformAudit(ctx, 'Super Admin Updated', '', `${u._id}: ${changed.join(', ') || 'no changes'}`);
  return { user: publicSuperAdmin((await c.findOne({ _id: u._id }))!) };
}

export async function resetSuperAdminPassword(d: any, ctx: SaCtx) {
  const c = await admins();
  const u = await c.findOne({ _id: String(d?.id || '') });
  if (!u) throw fail('NOT_FOUND', 'Super admin not found');
  if (ctx.sa?.id === u._id) throw fail('VALIDATION', 'Use "Change password" for your own account');
  const pw = randomPassword(16);
  await c.updateOne({ _id: u._id }, { $set: { passwordHash: await hashSaPassword(pw), mustChangePassword: true } });
  await revokeSaSessions(u._id);
  await platformAudit(ctx, 'Super Admin Password Reset', '', `${u._id} ${u.emailLower}`);
  return { temporaryPassword: pw };
}

export async function deleteSuperAdmin(d: any, ctx: SaCtx) {
  const c = await admins();
  const u = await c.findOne({ _id: String(d?.id || '') });
  if (!u) throw fail('NOT_FOUND', 'Super admin not found');
  if (ctx.sa?.id === u._id) throw fail('VALIDATION', 'You cannot delete your own account');
  if (u.status !== 'Disabled' && (await activeCount()) <= 1) throw fail('VALIDATION', 'Cannot delete the last active super admin');
  await c.deleteOne({ _id: u._id });
  await revokeSaSessions(u._id);
  await platformAudit(ctx, 'Super Admin Deleted', '', `${u._id} ${u.emailLower}`);
  return { ok: true as const };
}

/** CLI: create a super admin or reset an existing one's password (scripts/create-superadmin.ts). */
export async function upsertSuperAdminCli(email: string, name: string, password: string, mustChangePassword = false) {
  const e = cleanEmail(email);
  checkPassword(password);
  const c = await admins();
  const existing = await c.findOne({ emailLower: e });
  if (existing) {
    await c.updateOne({ _id: existing._id }, { $set: { passwordHash: await hashSaPassword(password), status: 'Active', name: cleanName(name || existing.name), mustChangePassword } });
    await (await attempts()).deleteMany({ key: { $regex: `^sa\\|${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|` } });
    await revokeSaSessions(existing._id);
    await platformAudit(null, 'Super Admin Reset (CLI)', '', e, 'CLI');
    return { created: false, id: existing._id };
  }
  const id = (await countSuperAdmins()) === 0 && !(await c.findOne({ _id: 'SA-0001' })) ? 'SA-0001' : await nextPlatformId('SA');
  if (id === 'SA-0001') await ensurePlatformCounterAtLeast('SA', 1);
  await c.insertOne({
    _id: id,
    name: cleanName(name),
    email: e,
    emailLower: e,
    passwordHash: await hashSaPassword(password),
    status: 'Active',
    mustChangePassword,
    createdAt: new Date(),
    lastLoginAt: null,
  });
  await platformAudit(null, 'Super Admin Created (CLI)', '', `${id} ${e}`, 'CLI');
  return { created: true, id };
}
