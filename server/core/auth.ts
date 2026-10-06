/**
 * Users, sessions, permissions and the audit log — successor of apps-script/03_Auth.gs.
 *
 * Changes from the Apps Script version (security audit, Oct 2026):
 * - Passwords: bcrypt (cost 12). Legacy salted SHA-256 hashes (hex or base64) are still accepted
 *   and transparently upgraded to bcrypt on the next successful sign-in.
 * - Sessions: random 256-bit token, stored only as a SHA-256 hash; sent to the browser in an
 *   httpOnly, SameSite=Lax cookie (never in localStorage or URLs). Sliding 12 h expiry.
 * - Login throttling: 8 failures per email+IP in 15 minutes locks that pair for 15 minutes.
 * - Same error for unknown, disabled and wrong-password accounts (no account enumeration).
 * - Audit entries record before/after values for changed fields when the caller provides them.
 */
import bcrypt from 'bcryptjs';
import { CFG, Role } from './config';
import { bumpVersion, col, nextSeq } from './db';
import { fail } from './errors';
import { currentTenant } from './tenant';
import { claimEmail, releaseEmail } from '../platform/registry';
import { randomPassword, randomToken, sha256Base64, sha256Hex, str, truncate, shortId } from './utils';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'Active' | 'Disabled';
  createdAt: string;
  lastLoginAt: string;
  mustChangePassword: boolean;
  avatar: string;
}

export interface UserDoc {
  _id: string; // USR-0001
  name: string;
  email: string;
  emailLower: string;
  passwordHash: string; // bcrypt, or legacy sha256 (hex/base64) when legacySalt is set
  legacySalt?: string;
  role: Role;
  status: 'Active' | 'Disabled';
  createdAt: Date;
  lastLoginAt?: Date | null;
  mustChangePassword: boolean;
  avatar?: string;
}

interface SessionDoc {
  _id?: any;
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeen: Date;
  userAgent: string;
  ip: string;
}

export interface Ctx {
  user: PublicUser | null;
  session: { expiresAt: string } | null;
  /** Raw session token of this request (cookie). Never returned to the browser after login. */
  token: string;
  userAgent: string;
  ip: string;
  action: string;
}

export const SYSTEM_CTX: Ctx = {
  user: { id: 'SYSTEM', name: 'System', email: '', role: 'Developer', status: 'Active', createdAt: '', lastLoginAt: '', mustChangePassword: false, avatar: '' },
  session: null,
  token: '',
  userAgent: '',
  ip: '',
  action: 'system',
};

const MIN_PASSWORD = 10;
const LEGACY_MIN_PASSWORD = 6;

export function normalizeRole(role: unknown): Role {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'admin' || r === 'administrator') return 'Admin';
  if (r === 'developer' || r === 'dev') return 'Developer';
  if (r === 'manager' || r === 'sales manager') return 'Manager';
  return 'RM';
}

export function photoValue(v: unknown) {
  const s = String(v || '').trim();
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= 48000 ? s : '';
}

function validatePhoto(v: unknown) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) throw fail('VALIDATION', 'Photo must be a JPEG, PNG or WebP image');
  if (s.length > 48000) throw fail('VALIDATION', 'Photo is too large — the app resizes it to 128 px before upload; please try again');
  return s;
}

export function publicUser(u: UserDoc): PublicUser {
  return {
    id: u._id,
    name: u.name,
    email: u.emailLower,
    role: normalizeRole(u.role),
    status: u.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : '',
    lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : '',
    mustChangePassword: !!u.mustChangePassword,
    avatar: photoValue(u.avatar),
  };
}

const users = () => col<UserDoc>(CFG.COLL.USERS);
const sessions = () => col<SessionDoc>(CFG.COLL.SESSIONS);

export async function listUsers(): Promise<PublicUser[]> {
  const all = await (await users()).find({}).sort({ createdAt: 1 }).toArray();
  return all.map(publicUser);
}

export async function findUserByEmail(email: string) {
  return (await users()).findOne({ emailLower: String(email || '').trim().toLowerCase() });
}
export async function findUserById(id: string) {
  return (await users()).findOne({ _id: String(id) });
}
export async function hasUsers() {
  return (await (await users()).countDocuments({}, { limit: 1 })) > 0;
}

/* ------------------------------ passwords -------------------------------- */

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

async function verifyPassword(u: UserDoc, pw: string): Promise<boolean> {
  const stored = String(u.passwordHash || '');
  if (!stored) return false;
  if (u.legacySalt !== undefined && u.legacySalt !== null && !stored.startsWith('$2')) {
    const text = String(u.legacySalt) + '::' + String(pw);
    return stored === sha256Hex(text) || stored === sha256Base64(text);
  }
  return bcrypt.compare(String(pw), stored);
}

function checkNewPassword(pw: string) {
  if (String(pw || '').length < MIN_PASSWORD) throw fail('VALIDATION', `Password must be at least ${MIN_PASSWORD} characters`);
}

/* -------------------------------- users ---------------------------------- */

export async function createUser(data: any, actor: Ctx | null) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail('VALIDATION', 'A valid email address is required');
  if (!String(data.name || '').trim()) throw fail('VALIDATION', 'Name is required');
  if (await findUserByEmail(email)) throw fail('CONFLICT', 'A user with this email already exists');
  const supplied = String(data.password || '').trim();
  const password = supplied || randomPassword(12);
  if (supplied) checkNewPassword(supplied);
  const tenant = currentTenant();
  if (tenant && tenant.maxUsers > 0 && data.status !== 'Disabled') {
    const active = await (await users()).countDocuments({ status: { $ne: 'Disabled' } });
    if (active >= tenant.maxUsers) throw fail('VALIDATION', `Your plan allows ${tenant.maxUsers} active users. Disable a user or ask the platform administrator to raise the limit.`);
  }
  await claimEmail(email);
  const id = await nextSeq('USR', 4);
  const doc: UserDoc = {
    _id: id,
    name: String(data.name).trim(),
    email,
    emailLower: email,
    passwordHash: await hashPassword(password),
    role: normalizeRole(data.role),
    status: data.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: new Date(),
    lastLoginAt: null,
    mustChangePassword: data.mustChangePassword === false ? false : true,
  };
  try {
    await (await users()).insertOne(doc);
  } catch (e: any) {
    await releaseEmail(email);
    if (e?.code === 11000) throw fail('CONFLICT', 'A user with this email already exists');
    throw e;
  }
  await auditLog(actor, 'User Created', 'Settings', id, `${email} (${doc.role})`);
  await bumpVersion();
  return { user: publicUser(doc), temporaryPassword: supplied ? undefined : password };
}

export async function updateUser(data: any, ctx: Ctx) {
  const u = await findUserById(data.id);
  if (!u) throw fail('NOT_FOUND', 'User not found');
  const set: Partial<UserDoc> = {};
  const unset: Record<string, ''> = {};
  if (data.name !== undefined) {
    const n = String(data.name).trim();
    if (!n) throw fail('VALIDATION', 'Name is required');
    set.name = n;
  }
  if (data.email !== undefined) {
    const email = String(data.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail('VALIDATION', 'A valid email address is required');
    const other = await findUserByEmail(email);
    if (other && other._id !== u._id) throw fail('CONFLICT', 'Another user already uses this email');
    if (email !== u.emailLower) await claimEmail(email);
    set.email = email;
    set.emailLower = email;
  }
  if (data.role !== undefined) set.role = normalizeRole(data.role);
  if (data.status !== undefined) set.status = data.status === 'Disabled' ? 'Disabled' : 'Active';
  const tenant = currentTenant();
  if (set.status === 'Active' && u.status === 'Disabled' && tenant && tenant.maxUsers > 0) {
    const active = await (await users()).countDocuments({ status: { $ne: 'Disabled' } });
    if (active >= tenant.maxUsers) throw fail('VALIDATION', `Your plan allows ${tenant.maxUsers} active users.`);
  }
  if (data.password) {
    checkNewPassword(data.password);
    set.passwordHash = await hashPassword(String(data.password));
    unset.legacySalt = '';
    set.mustChangePassword = true;
  }
  if (data.mustChangePassword !== undefined) set.mustChangePassword = !!data.mustChangePassword;
  if (data.avatar !== undefined) set.avatar = validatePhoto(data.avatar);

  // never demote/disable the last active administrator
  const becomesNonAdmin = (set.role && !['Admin', 'Developer'].includes(set.role)) || set.status === 'Disabled';
  if (becomesNonAdmin && ['Admin', 'Developer'].includes(normalizeRole(u.role))) {
    const admins = await (await users()).countDocuments({ role: { $in: ['Admin', 'Developer'] }, status: { $ne: 'Disabled' } });
    if (admins <= 1) throw fail('VALIDATION', 'Cannot remove the last active administrator');
  }

  const update: any = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;
  await (await users()).updateOne({ _id: u._id }, update);
  if (set.emailLower && set.emailLower !== u.emailLower) await releaseEmail(u.emailLower);
  const changed = Object.keys(set).filter((k) => k !== 'passwordHash' && k !== 'emailLower');
  await auditLog(ctx, 'User Updated', 'Settings', u._id, changed.join(', '), {
    before: Object.fromEntries(changed.filter((k) => k !== 'avatar').map((k) => [k, (u as any)[k]])),
    after: Object.fromEntries(changed.filter((k) => k !== 'avatar').map((k) => [k, (set as any)[k]])),
  });
  const roleChanged = set.role !== undefined && set.role !== normalizeRole(u.role);
  if (set.status === 'Disabled' || data.password || roleChanged) await revokeUserSessions(u._id);
  await bumpVersion();
  return publicUser((await findUserById(u._id))!);
}

/** Any signed-in user may change their own display name and profile photo. */
export async function updateProfile(ctx: Ctx, data: any) {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const patch: any = { id: ctx.user.id };
  if (data && data.name !== undefined) {
    const n = String(data.name || '').trim();
    if (!n) throw fail('VALIDATION', 'Name is required');
    patch.name = n;
  }
  if (data && data.avatar !== undefined) patch.avatar = data.avatar === null ? '' : data.avatar;
  if (Object.keys(patch).length === 1) throw fail('VALIDATION', 'Nothing to update');
  return updateUser(patch, ctx);
}

export async function deleteUser(id: string, ctx: Ctx) {
  const u = await findUserById(id);
  if (!u) throw fail('NOT_FOUND', 'User not found');
  if (ctx.user && ctx.user.id === String(id)) throw fail('VALIDATION', 'You cannot delete your own account');
  if (['Admin', 'Developer'].includes(normalizeRole(u.role))) {
    const admins = await (await users()).countDocuments({ role: { $in: ['Admin', 'Developer'] }, status: { $ne: 'Disabled' } });
    if (admins <= 1) throw fail('VALIDATION', 'Cannot delete the last administrator');
  }
  await (await users()).deleteOne({ _id: u._id });
  await releaseEmail(u.emailLower);
  await revokeUserSessions(u._id);
  await auditLog(ctx, 'User Deleted', 'Settings', u._id, u.emailLower);
  await bumpVersion();
}

/* ---------------------------- login throttling --------------------------- */

const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;

async function attempts() {
  return col<{ _id?: any; key: string; count: number; expiresAt: Date; lockedUntil?: Date }>(CFG.COLL.LOGIN_ATTEMPTS);
}

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

/* -------------------------------- sessions ------------------------------- */

export interface LoginResult {
  token: string; // raw token — the route handler moves it into the cookie and strips it from the JSON
  user: PublicUser;
  expiresAt: string;
}

export async function login(email: string, password: string, ctx: Pick<Ctx, 'userAgent' | 'ip'>): Promise<LoginResult> {
  const key = `${String(email || '').trim().toLowerCase()}|${ctx.ip || ''}`;
  await assertNotLocked(key);
  const u = await findUserByEmail(email);
  const okPw = u ? await verifyPassword(u, password) : false;
  if (!u || !okPw || u.status === 'Disabled') {
    await recordFailure(key);
    throw fail('AUTH_FAILED', 'Invalid email or password');
  }
  await (await attempts()).deleteOne({ key });

  // upgrade legacy SHA-256 hashes to bcrypt now that we know the password
  if (u.legacySalt !== undefined) {
    const pwOk = String(password).length >= LEGACY_MIN_PASSWORD;
    if (pwOk) {
      await (await users()).updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(String(password)) }, $unset: { legacySalt: '' } });
    }
  }

  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + CFG.SESSION_HOURS * 3600000);
  await (await sessions()).insertOne({
    tokenHash: sha256Hex(token),
    userId: u._id,
    createdAt: now,
    expiresAt: expires,
    lastSeen: now,
    userAgent: truncate(ctx.userAgent || '', 160),
    ip: truncate(ctx.ip || '', 64),
  });
  await (await users()).updateOne({ _id: u._id }, { $set: { lastLoginAt: now } });
  const user = publicUser({ ...u, lastLoginAt: now });
  await auditLog({ ...SYSTEM_CTX, user }, 'User Logged In', 'Auth', user.id, user.email);
  return { token, user, expiresAt: expires.toISOString() };
}

/** Resolve a raw token to {user, expiresAt} or null. Sliding expiry once half the window has elapsed. */
export async function validateSession(token: string): Promise<{ user: PublicUser; expiresAt: string } | null> {
  if (!token) return null;
  const s = await (await sessions()).findOne({ tokenHash: sha256Hex(token) });
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    await (await sessions()).deleteOne({ _id: s._id });
    return null;
  }
  const u = await findUserById(s.userId);
  if (!u || u.status === 'Disabled') {
    await (await sessions()).deleteOne({ _id: s._id });
    return null;
  }
  let expiresAt = s.expiresAt;
  if (s.expiresAt.getTime() - Date.now() < CFG.SESSION_HOURS * 1800000) {
    expiresAt = new Date(Date.now() + CFG.SESSION_HOURS * 3600000);
    await (await sessions()).updateOne({ _id: s._id }, { $set: { expiresAt, lastSeen: new Date() } });
  }
  return { user: publicUser(u), expiresAt: expiresAt.toISOString() };
}

export async function logout(token: string) {
  if (!token) return;
  await (await sessions()).deleteOne({ tokenHash: sha256Hex(token) });
}

export async function revokeUserSessions(userId: string) {
  await (await sessions()).deleteMany({ userId: String(userId) });
}

/** Expired sessions are removed by the TTL index; this is a belt-and-braces sweep for the daily job. */
export async function cleanupSessions() {
  await (await sessions()).deleteMany({ expiresAt: { $lt: new Date() } });
}

export async function changePassword(ctx: Ctx, currentPassword: string, newPassword: string) {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const u = await findUserById(ctx.user.id);
  if (!u) throw fail('NOT_FOUND', 'User not found');
  if (!(await verifyPassword(u, currentPassword))) throw fail('VALIDATION', 'Current password is incorrect');
  checkNewPassword(newPassword);
  await (await users()).updateOne(
    { _id: u._id },
    { $set: { passwordHash: await hashPassword(String(newPassword)), mustChangePassword: false }, $unset: { legacySalt: '' } }
  );
  // sign out every other session of this user
  await (await sessions()).deleteMany({ userId: u._id, tokenHash: { $ne: sha256Hex(ctx.token) } });
  await auditLog(ctx, 'Password Changed', 'Auth', u._id, '');
}

/* ------------------------------ permissions ------------------------------ */

export function can(user: Pick<PublicUser, 'role'> | null | undefined, permission: string) {
  if (!user) return false;
  const perms = CFG.PERMISSIONS[normalizeRole(user.role)] || [];
  for (const p of perms) {
    if (p === '*' || p === permission) return true;
    if (p.endsWith('.*') && permission.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

export function requirePerm(ctx: Ctx, permission?: string) {
  if (!ctx || !ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  if (permission && !can(ctx.user, permission)) throw fail('FORBIDDEN', `Your role (${ctx.user.role}) cannot perform: ${permission}`);
}

/* ------------------------------- audit log ------------------------------- */

export async function auditLog(ctx: Ctx | null, action: string, entityType: string, entityId: string, details: string, diff?: { before?: unknown; after?: unknown }) {
  try {
    const user = (ctx && ctx.user) || { name: 'System', role: 'System', email: '' };
    await (await col(CFG.COLL.AUDIT_LOG)).insertOne({
      _id: shortId('LOG') as any,
      timestamp: new Date(),
      user: user.name + ((user as any).email ? ` <${(user as any).email}>` : ''),
      role: (user as any).role || '',
      action,
      entityType: entityType || '',
      entityId: entityId || '',
      details: truncate(details || '', 500),
      ...(diff ? { before: diff.before ?? null, after: diff.after ?? null } : {}),
      ip: ctx?.ip || '',
    });
  } catch (e) {
    console.error('[audit] failed', e);
  }
}

export async function auditList(limit = 200) {
  const rows = await (await col(CFG.COLL.AUDIT_LOG)).find({}).sort({ timestamp: -1 }).limit(Math.min(Number(limit) || 200, 2000)).toArray();
  return rows.map((r: any) => ({
    id: str(r._id),
    timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : '',
    user: str(r.user),
    role: str(r.role),
    action: str(r.action),
    entityType: str(r.entityType),
    entityId: str(r.entityId),
    details: str(r.details) + (r.before || r.after ? ` | before: ${JSON.stringify(r.before)} → after: ${JSON.stringify(r.after)}` : ''),
  }));
}
