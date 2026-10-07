/**
 * Company (tenant) provisioning and management for the super admin console.
 *
 * - createCompany: registry entry ('CMP-0001', unique slug) + a new database `crm_<slug>` with indexes,
 *   the company name as appName and a first Admin. Any failure after the registry insert rolls back
 *   (database dropped, registry entry and directory entries removed).
 * - Usage statistics are read inside each company's own context (runWithTenant) — never cross-database queries.
 * - Suspending a company revokes every session in its database; deleting drops the database, frees its
 *   users' e-mails and the slug, and keeps a tombstone registry entry for the audit trail.
 * Every mutation calls invalidateTenant() and writes a platform audit entry.
 */
import { CFG } from '../core/config';
import { col, dbByName, ensureIndexes, getClient, getDb } from '../core/db';
import { fail } from '../core/errors';
import { runWithTenant } from '../core/tenant';
import { createUser, listUsers, openSupportSession, updateUser, SYSTEM_CTX, type Ctx, type PublicUser } from '../core/auth';
import { settingSet } from '../core/settings';
import { escapeRegex, randomPassword, str, truncate } from '../core/utils';
import { claimEmail, invalidateTenant, normalizeFeatures, PCOLL, toTenant, type CompanyDoc } from './registry';
import { actorLabel, listPlatformAudit, mapLimit, nextPlatformId, pc, platformAudit, type SaCtx } from './base';
import { getPlan, validMaxUsers } from './plans';
import type { CompanyDetail, CompanySummary, CompanyUser } from './contract';
import { unsubscribeAllPages } from '../modules/meta';
import { revokeAllGoogleConnections } from '../modules/googleConnect';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const RESERVED_SLUGS = new Set(['superadmin', 'api', 'admin', 'www', 'platform', 'app', 'login']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const ROLES = ['Admin', 'Manager', 'RM', 'Developer'] as const;
const STATS_PARALLEL = 5;

const companies = () => pc<CompanyDoc>(PCOLL.COMPANIES);
const notDeleted = { deletedAt: { $in: [null, undefined] } } as any;
const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : '');

export const dbNameForSlug = (slug: string) => `crm_${slug.replace(/-/g, '_')}`;

/** Ctx used for audit entries written into a company's own audit log by a platform operator. */
export function companyActor(ctx: SaCtx | null): Ctx {
  return {
    ...SYSTEM_CTX,
    user: { ...SYSTEM_CTX.user!, id: ctx?.sa?.id || 'PLATFORM', name: `Platform: ${ctx?.sa?.name || 'System'}`, email: ctx?.sa?.email || '', role: 'Developer' },
    ip: ctx?.ip || '',
    action: 'platform',
  };
}

export function validateSlug(v: unknown): string {
  const slug = String(v || '').trim().toLowerCase();
  if (slug.length < 2 || !SLUG_RE.test(slug)) throw fail('VALIDATION', 'Slug must be 2–40 characters: a-z, 0-9 and - (not at the start or end)');
  if (RESERVED_SLUGS.has(slug)) throw fail('VALIDATION', `"${slug}" is reserved — choose another slug`);
  return slug;
}

function validateLogo(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  if (!LOGO_RE.test(s)) throw fail('VALIDATION', 'Logo must be a PNG, JPEG or WebP image');
  if (s.length > 48000) throw fail('VALIDATION', 'Logo is too large (max ~35 KB) — please use a smaller image');
  return s;
}

function optionalEmail(v: unknown, label: string): string {
  const e = String(v || '').trim().toLowerCase();
  if (e && !EMAIL_RE.test(e)) throw fail('VALIDATION', `${label} must be a valid email address`);
  return truncate(e, 200);
}

function toCompanyUser(u: PublicUser): CompanyUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role as CompanyUser['role'], status: u.status, lastLoginAt: u.lastLoginAt };
}

/**
 * "Open company settings": a 2-hour session as the company's hidden Platform support account, which alone has
 * the company's settings, integrations and keys. The route handler puts the token into the CRM session cookie.
 */
export async function openCompanySupport(d: { companyId: string }, ctx: SaCtx): Promise<{ companyId: string; token: string; expiresAt: string; redirect: string }> {
  const c = await findCompany(d?.companyId);
  if (c.status !== 'Active') throw fail('VALIDATION', 'Reactivate the company first — a suspended company cannot be opened.');
  const sa = { name: ctx.sa?.name || '', email: ctx.sa?.email || '' };
  const r = await runWithTenant(toTenant(c), () => openSupportSession(sa, { ip: ctx.ip, userAgent: ctx.userAgent }));
  await platformAudit(ctx, 'Company Settings Opened', c._id, `${c.name} (2-hour support session)`);
  return { companyId: c._id, token: r.token, expiresAt: r.expiresAt, redirect: '/settings' };
}

export async function findCompany(id: string): Promise<CompanyDoc> {
  const c = await (await companies()).findOne({ _id: String(id || ''), ...notDeleted });
  if (!c) throw fail('NOT_FOUND', 'Company not found');
  return c;
}

/* --------------------------------- usage --------------------------------- */

interface Usage {
  activeUsers: number;
  leads: number;
  tasks: number;
  units: number;
  calls: number;
  messages: number;
  storageMB: number;
  lastActivityAt: string;
}
const EMPTY_USAGE: Usage = { activeUsers: 0, leads: 0, tasks: 0, units: 0, calls: 0, messages: 0, storageMB: 0, lastActivityAt: '' };

/** Usage counters of one company, read inside that company's context. Never throws (zeros on error). */
async function companyUsage(c: CompanyDoc, full: boolean): Promise<Usage> {
  try {
    return await runWithTenant(toTenant(c), async () => {
      const db = await getDb();
      const count = (name: string, q: Record<string, unknown> = {}) => db.collection(name).countDocuments(q);
      const [activeUsers, leads, stats] = await Promise.all([
        count(CFG.COLL.USERS, { status: { $ne: 'Disabled' }, support: { $ne: true } } as any),
        count(CFG.COLL.LEADS),
        db.stats().catch(() => ({ dataSize: 0, indexSize: 0 }) as any),
      ]);
      const storageMB = Math.round((((Number(stats.dataSize) || 0) + (Number(stats.indexSize) || 0)) / 1048576) * 100) / 100;
      if (!full) return { ...EMPTY_USAGE, activeUsers, leads, storageMB };
      const [tasks, units, calls, messages, lastAudit, lastEvent] = await Promise.all([
        count(CFG.COLL.TASKS),
        count(CFG.COLL.INVENTORY),
        count(CFG.COLL.CALLS),
        count(CFG.COLL.CHAT_MESSAGES),
        db.collection(CFG.COLL.AUDIT_LOG).find({}, { projection: { timestamp: 1 } }).sort({ timestamp: -1 }).limit(1).next(),
        db.collection(CFG.COLL.EVENTS).find({}, { projection: { createdAt: 1 } }).sort({ seq: -1 }).limit(1).next(),
      ]);
      const times = [lastAudit?.timestamp, lastEvent?.createdAt].filter(Boolean).map((d: any) => new Date(d).getTime());
      return { activeUsers, leads, tasks, units, calls, messages, storageMB, lastActivityAt: times.length ? new Date(Math.max(...times)).toISOString() : '' };
    });
  } catch (e) {
    console.error('[platform] usage failed for', c._id, e);
    return { ...EMPTY_USAGE };
  }
}

function summary(c: CompanyDoc, u: Usage): CompanySummary {
  return {
    id: c._id,
    slug: c.slug,
    name: c.name,
    status: c.status === 'Suspended' ? 'Suspended' : 'Active',
    plan: c.plan || '',
    maxUsers: Number(c.maxUsers) || 0,
    activeUsers: u.activeUsers,
    leads: u.leads,
    storageMB: u.storageMB,
    features: normalizeFeatures(c.features),
    contactEmail: str(c.contactEmail),
    createdAt: iso(c.createdAt),
  };
}

async function detail(c: CompanyDoc): Promise<CompanyDetail> {
  const [u, users] = await Promise.all([
    companyUsage(c, true),
    runWithTenant(toTenant(c), () => listUsers()).catch((e) => {
      console.error('[platform] listUsers failed for', c._id, e);
      return [] as PublicUser[];
    }),
  ]);
  return {
    ...summary(c, u),
    dbName: c.dbName,
    logo: str(c.logo),
    tagline: str(c.tagline),
    contactName: str(c.contactName),
    contactPhone: str(c.contactPhone),
    notes: str(c.notes),
    updatedAt: iso(c.updatedAt),
    users: users.map(toCompanyUser),
    usage: { leads: u.leads, tasks: u.tasks, units: u.units, calls: u.calls, messages: u.messages, storageMB: u.storageMB, lastActivityAt: u.lastActivityAt },
  };
}

/* ------------------------------ list & read ------------------------------ */

export async function listCompanies(d: any = {}): Promise<CompanySummary[]> {
  const q: Record<string, unknown> = { ...notDeleted };
  if (d?.status === 'Active' || d?.status === 'Suspended') q.status = d.status;
  const text = String(d?.q || '').trim();
  if (text) {
    const re = { $regex: escapeRegex(truncate(text, 100)), $options: 'i' };
    q.$or = [{ name: re }, { slug: re }, { contactEmail: re }, { _id: re }];
  }
  const rows = await (await companies()).find(q).sort({ createdAt: -1 }).toArray();
  return mapLimit(rows, STATS_PARALLEL, async (c) => summary(c, await companyUsage(c, false)));
}

export async function getCompany(d: any): Promise<CompanyDetail> {
  return detail(await findCompany(d?.id));
}

export async function dashboard() {
  const list = await listCompanies({});
  return {
    companies: { total: list.length, active: list.filter((c) => c.status === 'Active').length, suspended: list.filter((c) => c.status === 'Suspended').length },
    users: list.reduce((s, c) => s + c.activeUsers, 0),
    leads: list.reduce((s, c) => s + c.leads, 0),
    storageMB: Math.round(list.reduce((s, c) => s + c.storageMB, 0) * 100) / 100,
    recentCompanies: list.slice(0, 5),
    recentAudit: await listPlatformAudit({ limit: 10 }),
  };
}

/* ------------------------------- provision ------------------------------- */

async function dropDatabase(dbName: string) {
  const client = await getClient();
  if (client) await client.db(dbName).dropDatabase();
}

async function databaseHasData(dbName: string) {
  const client = await getClient();
  if (!client) return false;
  const cols = await client.db(dbName).listCollections({}, { nameOnly: true }).toArray();
  return cols.length > 0;
}

export async function createCompany(d: any, ctx: SaCtx): Promise<{ company: CompanyDetail; adminTemporaryPassword?: string }> {
  const name = truncate(String(d?.name || '').trim(), 120);
  if (!name) throw fail('VALIDATION', 'Company name is required');
  const slug = validateSlug(d?.slug);
  const plan = await getPlan(String(d?.plan || ''));
  if (!plan) throw fail('VALIDATION', 'Choose an existing plan');
  const maxUsers = d?.maxUsers === undefined || d?.maxUsers === null || d?.maxUsers === '' ? plan.maxUsers : validMaxUsers(d.maxUsers);
  const features = normalizeFeatures({ ...plan.features, ...(d?.features && typeof d.features === 'object' ? d.features : {}) });
  const admin = d?.admin || {};
  const adminName = String(admin.name || '').trim();
  const adminEmail = String(admin.email || '').trim().toLowerCase();
  const adminPassword = String(admin.password || '');
  if (!adminName) throw fail('VALIDATION', 'Admin name is required');
  if (!EMAIL_RE.test(adminEmail)) throw fail('VALIDATION', 'A valid admin email address is required');
  if (adminPassword && adminPassword.length < 10) throw fail('VALIDATION', 'Admin password must be at least 10 characters');
  const contactEmail = optionalEmail(d?.contactEmail, 'Contact email');

  const reg = await companies();
  if (await reg.findOne({ slug })) throw fail('CONFLICT', `The slug "${slug}" is already taken`);
  const dbName = dbNameForSlug(slug);
  if (await reg.findOne({ dbName, ...notDeleted })) throw fail('CONFLICT', `Database ${dbName} already belongs to a company`);
  if (await databaseHasData(dbName)) throw fail('CONFLICT', `Database ${dbName} already exists. Use scripts/create-company.ts --adopt-db to register an existing database.`);
  if (await (await pc(PCOLL.DIRECTORY)).findOne({ _id: adminEmail as any })) {
    throw fail('CONFLICT', 'This e-mail address is already used by another account on the platform');
  }

  const now = new Date();
  const doc: CompanyDoc = {
    _id: await nextPlatformId('CMP'),
    slug,
    name,
    dbName,
    status: 'Active',
    plan: plan.id,
    maxUsers,
    features,
    logo: '',
    tagline: '',
    contactName: truncate(String(d?.contactName || '').trim(), 120),
    contactEmail: contactEmail || adminEmail,
    contactPhone: truncate(String(d?.contactPhone || '').trim(), 40),
    notes: truncate(String(d?.notes || '').trim(), 2000),
    createdAt: now,
    createdBy: actorLabel(ctx),
    updatedAt: now,
    deletedAt: null,
  };
  try {
    await reg.insertOne(doc);
  } catch (e: any) {
    if (e?.code === 11000) throw fail('CONFLICT', `The slug "${slug}" is already taken`);
    throw e;
  }

  let temporaryPassword: string | undefined;
  try {
    const db = await dbByName(dbName);
    await ensureIndexes(db); // idempotent; also covers a database name reused after a deletion
    const res = await runWithTenant(toTenant(doc), async () => {
      await settingSet('appName', name, actorLabel(ctx));
      return createUser({ name: adminName, email: adminEmail, password: adminPassword || undefined, role: 'Admin', mustChangePassword: !adminPassword }, companyActor(ctx));
    });
    temporaryPassword = res.temporaryPassword;
  } catch (e) {
    await rollbackCompany(doc).catch((re) => console.error('[platform] rollback failed', doc._id, re));
    throw e;
  }
  invalidateTenant(doc._id);
  await platformAudit(ctx, 'Company Created', doc._id, `${name} (${slug}) plan ${plan.id}, db ${dbName}, admin ${adminEmail}`);
  return { company: await detail(doc), ...(temporaryPassword ? { adminTemporaryPassword: temporaryPassword } : {}) };
}

async function rollbackCompany(doc: CompanyDoc) {
  await dropDatabase(doc.dbName);
  await (await pc(PCOLL.DIRECTORY)).deleteMany({ companyId: doc._id });
  await (await companies()).deleteOne({ _id: doc._id });
  invalidateTenant(doc._id);
}

/**
 * Register an EXISTING database as a company (scripts/create-company.ts --adopt-db). No new database;
 * every existing user's e-mail is claimed in the directory; a first admin is created only when the
 * database has no users. Returns the company and any directory conflicts.
 */
export async function adoptCompanyDb(d: {
  name: string;
  slug: string;
  plan: string;
  dbName: string;
  features?: Partial<CompanyDoc['features']>;
  admin?: { name: string; email: string; password?: string };
}): Promise<{ company: CompanyDoc; conflicts: string[]; claimed: number; adminTemporaryPassword?: string; adminCreated: boolean }> {
  const name = String(d.name || '').trim();
  if (!name) throw fail('VALIDATION', 'Company name is required');
  const slug = validateSlug(d.slug);
  const dbName = String(d.dbName || '').trim();
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) throw fail('VALIDATION', 'Invalid database name');
  const plan = await getPlan(d.plan);
  if (!plan) throw fail('VALIDATION', `Unknown plan "${d.plan}"`);
  const reg = await companies();
  if (await reg.findOne({ slug })) throw fail('CONFLICT', `The slug "${slug}" is already taken`);
  if (await reg.findOne({ dbName, ...notDeleted })) throw fail('CONFLICT', `Database ${dbName} is already registered as a company`);
  const now = new Date();
  const doc: CompanyDoc = {
    _id: await nextPlatformId('CMP'),
    slug,
    name,
    dbName,
    status: 'Active',
    plan: plan.id,
    maxUsers: plan.maxUsers,
    features: normalizeFeatures({ ...plan.features, ...(d.features || {}) }),
    logo: '',
    tagline: '',
    contactName: d.admin?.name || '',
    contactEmail: (d.admin?.email || '').toLowerCase(),
    contactPhone: '',
    notes: `Adopted existing database ${dbName}`,
    createdAt: now,
    createdBy: 'CLI',
    updatedAt: now,
    deletedAt: null,
  };
  await reg.insertOne(doc);
  invalidateTenant(doc._id);
  const conflicts: string[] = [];
  let claimed = 0;
  let adminTemporaryPassword: string | undefined;
  let adminCreated = false;
  await dbByName(dbName);
  await runWithTenant(toTenant(doc), async () => {
    const users = await (await col(CFG.COLL.USERS)).find({}, { projection: { emailLower: 1, email: 1 } }).toArray();
    for (const u of users) {
      const e = String(u.emailLower || u.email || '').trim().toLowerCase();
      if (!e) continue;
      try {
        await claimEmail(e);
        claimed++;
      } catch (err: any) {
        conflicts.push(`${e}: ${err?.message || err}`);
      }
    }
    if (!users.length && d.admin?.email) {
      const r = await createUser({ name: d.admin.name || d.admin.email, email: d.admin.email, password: d.admin.password || undefined, role: 'Admin', mustChangePassword: !d.admin.password }, null);
      adminTemporaryPassword = r.temporaryPassword;
      adminCreated = true;
    }
  });
  await platformAudit(null, 'Company Adopted', doc._id, `${name} (${slug}) on existing db ${dbName}; ${claimed} e-mails claimed, ${conflicts.length} conflicts`, 'CLI');
  return { company: doc, conflicts, claimed, adminTemporaryPassword, adminCreated };
}

/* -------------------------------- update --------------------------------- */

export async function updateCompany(d: any, ctx: SaCtx): Promise<CompanyDetail> {
  const c = await findCompany(d?.id);
  const p = d?.patch && typeof d.patch === 'object' ? d.patch : {};
  const set: Partial<CompanyDoc> = {};
  if (p.name !== undefined) {
    const n = truncate(String(p.name || '').trim(), 120);
    if (!n) throw fail('VALIDATION', 'Company name is required');
    set.name = n;
  }
  if (p.plan !== undefined) {
    const plan = await getPlan(String(p.plan || ''));
    if (!plan) throw fail('VALIDATION', 'Choose an existing plan');
    set.plan = plan.id;
  }
  if (p.maxUsers !== undefined) set.maxUsers = validMaxUsers(p.maxUsers);
  if (p.features !== undefined) {
    if (!p.features || typeof p.features !== 'object') throw fail('VALIDATION', 'Features must be an object');
    set.features = normalizeFeatures({ ...normalizeFeatures(c.features), ...p.features });
  }
  if (p.logo !== undefined) set.logo = validateLogo(p.logo);
  if (p.tagline !== undefined) set.tagline = truncate(String(p.tagline || '').trim(), 200);
  if (p.contactName !== undefined) set.contactName = truncate(String(p.contactName || '').trim(), 120);
  if (p.contactEmail !== undefined) set.contactEmail = optionalEmail(p.contactEmail, 'Contact email');
  if (p.contactPhone !== undefined) set.contactPhone = truncate(String(p.contactPhone || '').trim(), 40);
  if (p.notes !== undefined) set.notes = truncate(String(p.notes || '').trim(), 2000);
  const changed = Object.keys(set).filter((k) => JSON.stringify((set as any)[k]) !== JSON.stringify((c as any)[k]));
  set.updatedAt = new Date();
  await (await companies()).updateOne({ _id: c._id }, { $set: set });
  invalidateTenant(c._id);
  const shown = changed.map((k) => (k === 'logo' ? 'logo' : k === 'features' ? `features → ${JSON.stringify(set.features)}` : `${k}: ${JSON.stringify((c as any)[k] ?? '')} → ${JSON.stringify((set as any)[k])}`));
  await platformAudit(ctx, 'Company Updated', c._id, shown.join('; ') || 'no changes');
  return detail(await findCompany(c._id));
}

export async function setCompanyStatus(d: any, ctx: SaCtx): Promise<CompanyDetail> {
  const c = await findCompany(d?.id);
  if (d?.status !== 'Active' && d?.status !== 'Suspended') throw fail('VALIDATION', 'Status must be Active or Suspended');
  const reason = truncate(String(d?.reason || '').trim(), 500);
  await (await companies()).updateOne({ _id: c._id }, { $set: { status: d.status, statusReason: reason, updatedAt: new Date() } as any });
  invalidateTenant(c._id);
  if (d.status === 'Suspended') {
    await runWithTenant(toTenant(c), async () => {
      await (await col(CFG.COLL.SESSIONS)).deleteMany({});
    });
  }
  await platformAudit(ctx, d.status === 'Suspended' ? 'Company Suspended' : 'Company Activated', c._id, `${c.name} (${c.slug})${reason ? ' — ' + reason : ''}`);
  return detail(await findCompany(c._id));
}

/* ------------------------------ company users ---------------------------- */

export async function createCompanyUser(d: any, ctx: SaCtx): Promise<{ user: CompanyUser; temporaryPassword: string }> {
  const c = await findCompany(d?.companyId);
  const role = String(d?.role || '');
  if (!(ROLES as readonly string[]).includes(role)) throw fail('VALIDATION', 'Role must be Admin, Manager, RM or Developer');
  const pw = randomPassword(14);
  const res = await runWithTenant(toTenant(c), () =>
    createUser({ name: d?.name, email: d?.email, password: pw, role, mustChangePassword: true }, companyActor(ctx))
  );
  await platformAudit(ctx, 'Company User Created', c._id, `${res.user.id} ${res.user.email} (${res.user.role})`);
  return { user: toCompanyUser(res.user), temporaryPassword: pw };
}

export async function resetCompanyUserPassword(d: any, ctx: SaCtx): Promise<{ temporaryPassword: string }> {
  const c = await findCompany(d?.companyId);
  const pw = randomPassword(14);
  // updateUser with a password sets mustChangePassword and revokes the user's sessions
  const u = await runWithTenant(toTenant(c), () => updateUser({ id: String(d?.userId || ''), password: pw, mustChangePassword: true }, companyActor(ctx)));
  await platformAudit(ctx, 'Company User Password Reset', c._id, `${u.id} ${u.email}`);
  return { temporaryPassword: pw };
}

export async function setCompanyUserStatus(d: any, ctx: SaCtx): Promise<CompanyUser> {
  const c = await findCompany(d?.companyId);
  if (d?.status !== 'Active' && d?.status !== 'Disabled') throw fail('VALIDATION', 'Status must be Active or Disabled');
  const u = await runWithTenant(toTenant(c), () => updateUser({ id: String(d?.userId || ''), status: d.status }, companyActor(ctx)));
  await platformAudit(ctx, d.status === 'Disabled' ? 'Company User Disabled' : 'Company User Enabled', c._id, `${u.id} ${u.email}`);
  return toCompanyUser(u);
}

/* -------------------------------- delete --------------------------------- */

export async function deleteCompany(d: any, ctx: SaCtx) {
  const c = await findCompany(d?.id);
  if (String(d?.confirmSlug || '') !== c.slug) throw fail('VALIDATION', `Type the company slug "${c.slug}" to confirm deletion`);
  const now = Date.now();
  // Block the company first (any request in flight resolves it as deleted), then remove its data.
  await (await companies()).updateOne(
    { _id: c._id },
    { $set: { status: 'Suspended', deletedAt: new Date(now), slug: `${c.slug}--deleted-${now}`, originalSlug: c.slug, updatedAt: new Date(now) } as any }
  );
  invalidateTenant(c._id);
  // its Facebook Pages: unsubscribe the app (best effort, needs the Page tokens in the company database)
  let metaPages = 0;
  try {
    metaPages = await runWithTenant(toTenant(c), () => unsubscribeAllPages());
  } catch (e: any) {
    console.error('[deleteCompany] Meta unsubscribe failed', e?.message);
  }
  // its Google connections: revoke the refresh tokens at Google (best effort)
  let googleRevoked = 0;
  try {
    googleRevoked = await runWithTenant(toTenant(c), () => revokeAllGoogleConnections());
  } catch (e: any) {
    console.error('[deleteCompany] Google revoke failed', e?.message);
  }
  await dropDatabase(c.dbName);
  const dir = await (await pc(PCOLL.DIRECTORY)).deleteMany({ companyId: c._id });
  // lead-source API keys of this company stop resolving
  await (await pc(PCOLL.API_KEYS)).deleteMany({ companyId: c._id });
  // its Google spreadsheets can be linked by another company again
  await (await pc(PCOLL.SHEET_CLAIMS)).deleteMany({ companyId: c._id });
  // its Facebook Pages can be connected by another company again
  const pages = await (await pc(PCOLL.META_PAGES)).deleteMany({ companyId: c._id });
  invalidateTenant(c._id);
  const envDb = process.env.MONGODB_DB && c.dbName === process.env.MONGODB_DB ? ' [WARNING: this was the MONGODB_DB database]' : '';
  await platformAudit(ctx, 'Company Deleted', c._id, `${c.name} (${c.slug}); dropped database ${c.dbName}; released ${dir.deletedCount} e-mail(s), ${pages.deletedCount} Facebook Page(s) (${metaPages} unsubscribed), ${googleRevoked} Google connection(s) revoked${envDb}`);
  return { ok: true as const };
}
