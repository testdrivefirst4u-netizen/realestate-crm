/**
 * Read-only Data API (v1) — exposes CRM data to external dashboards without a login. A separate, revocable API key
 * (platform `apiKeys`, scope 'read') identifies the company; it can ONLY read — no create / edit / delete — and it
 * can be switched off on its own. Customer phone numbers and e-mails are never included in any response.
 *
 * Endpoints (GET, under /api/v1): leads, site-visits, bookings, tasks, users.
 * Every list supports `?updatedSince=<ISO>` (incremental pulls), `&limit=` and `&cursor=` (keyset pagination).
 */
import type { ActionMap } from '../core/actions';
import { auditLog, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { requireTenant, runWithTenant } from '../core/tenant';
import { sha256Hex, truncate } from '../core/utils';
import { pc } from '../platform/base';
import { getTenantById, PCOLL } from '../platform/registry';
import { KEY_RE, newApiKey } from './leadSources';

interface KeyDoc { _id: string; companyId: string; sourceId?: string; scope?: string; label?: string; prefix?: string; disabled?: boolean; createdAt: Date; lastUsedAt?: Date; createdBy?: string }
const keys = () => pc<KeyDoc>(PCOLL.API_KEYS);
const prefixOf = (k: string) => k.slice(0, 17); // "crm_live_" + 8 hex — enough to recognise, never the secret

/* -------------------------------- keys ---------------------------------- */

/** Raw read-only key → companyId (platform DB). null when unknown, malformed, disabled or not a read key. */
export async function resolveReadKey(key: string): Promise<string | null> {
  if (!KEY_RE.test(key)) return null;
  const doc = await (await keys()).findOne({ _id: sha256Hex(key), scope: 'read' });
  if (!doc || doc.disabled) return null;
  void (await keys()).updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
  return doc.companyId;
}

export interface ReadKeyRow { id: string; label: string; prefix: string; createdAt: string; lastUsedAt: string; disabled: boolean }
const row = (d: KeyDoc): ReadKeyRow => ({ id: d._id, label: d.label || '', prefix: d.prefix || '', createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '', lastUsedAt: d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : '', disabled: !!d.disabled });

export async function listReadKeys(): Promise<ReadKeyRow[]> {
  const rows = await (await keys()).find({ companyId: requireTenant().id, scope: 'read' }).sort({ createdAt: -1 }).toArray();
  return rows.map(row);
}

/** Issue a read-only key. The plaintext key is returned once (only its SHA-256 is stored). */
export async function createReadKey(d: any, ctx: Ctx): Promise<{ key: string; row: ReadKeyRow }> {
  const label = truncate(String(d?.label || 'Dashboard').trim(), 60) || 'Dashboard';
  if ((await (await keys()).countDocuments({ companyId: requireTenant().id, scope: 'read' })) >= 10) throw fail('VALIDATION', 'At most 10 read-only keys. Revoke one first.');
  const key = newApiKey();
  const doc: KeyDoc = { _id: sha256Hex(key), companyId: requireTenant().id, scope: 'read', sourceId: '', label, prefix: prefixOf(key), disabled: false, createdAt: new Date(), createdBy: ctx.user?.name || 'System' };
  await (await keys()).insertOne(doc);
  await auditLog(ctx, 'Read API Key Created', 'Settings', doc.prefix || '', label);
  return { key, row: row(doc) };
}

export async function revokeReadKey(d: any, ctx: Ctx): Promise<ReadKeyRow[]> {
  const r = await (await keys()).deleteOne({ _id: String(d?.id || ''), companyId: requireTenant().id, scope: 'read' });
  if (r.deletedCount) await auditLog(ctx, 'Read API Key Revoked', 'Settings', String(d?.id || '').slice(0, 12), '');
  return listReadKeys();
}

/* ------------------------------- reads ---------------------------------- */

const MAX_LIMIT = 500, DEF_LIMIT = 200;
const clampLimit = (v: unknown) => Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(v) || DEF_LIMIT)));
const iso = (d: any): string => (d instanceof Date ? d.toISOString() : d ? (isNaN(new Date(d).getTime()) ? '' : new Date(d).toISOString()) : '');
const dateOnly = (d: any): string => { const s = iso(d); return s ? s.slice(0, 10) : ''; };

export interface Page<T> { data: T[]; nextCursor: string | null; hasMore: boolean }

function decodeCursor(c: unknown): { u: Date; id: string } | null {
  if (!c) return null;
  try { const o = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); const u = new Date(o.u); return isNaN(u.getTime()) ? null : { u, id: String(o.id || '') }; } catch { return null; }
}
const encodeCursor = (u: Date | null, id: string) => Buffer.from(JSON.stringify({ u: (u instanceof Date && !isNaN(u.getTime()) ? u : new Date(0)).toISOString(), id }), 'utf8').toString('base64url');

/** Keyset pagination over (field, _id), field = the record's change timestamp. `updatedSince` ⇒ field >= since. */
async function paginate<T>(coll: string, opts: { updatedSince?: unknown; limit?: unknown; cursor?: unknown; match?: Record<string, any>; field?: string; map: (d: any) => T }): Promise<Page<T>> {
  const field = opts.field || 'updatedAt';
  const limit = clampLimit(opts.limit);
  const and: any[] = [];
  const since = opts.updatedSince ? new Date(String(opts.updatedSince)) : null;
  if (since && !isNaN(since.getTime())) and.push({ [field]: { $gte: since } });
  const cur = decodeCursor(opts.cursor);
  if (cur) and.push({ $or: [{ [field]: { $gt: cur.u } }, { [field]: cur.u, _id: { $gt: cur.id } }] });
  const q: Record<string, any> = { ...(opts.match || {}) };
  if (and.length) q.$and = and;
  const docs = await (await col<any>(coll)).find(q).sort({ [field]: 1, _id: 1 }).limit(limit + 1).toArray();
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return { data: page.map(opts.map), nextCursor: hasMore && last ? encodeCursor(last[field], String(last._id)) : null, hasMore };
}

export const readLeads = (o: any): Promise<Page<any>> => paginate(CFG.COLL.LEADS, { ...o, match: { stage: { $nin: [CFG.STAGES.DELETED, CFG.STAGES.TRASH] } }, map: (l) => ({
  id: l._id, source: l.source || '', stage: l.stage || '', owner: l.assignedRm || '', unitType: l.unitType || '',
  createdAt: iso(l.createdAt), updatedAt: iso(l.updatedAt),
  siteVisitStatus: l.siteVisitStatus || '', siteVisitDate: dateOnly(l.siteVisitDate),
  bookingDate: dateOnly(l.bookingDate), nextFollowupDate: iso(l.nextFollowupAt),
}) });

export const readSiteVisits = (o: any): Promise<Page<any>> => paginate(CFG.COLL.LEADS, { ...o, match: { stage: { $nin: [CFG.STAGES.DELETED, CFG.STAGES.TRASH] }, $or: [{ siteVisitDate: { $ne: null } }, { siteVisitStatus: { $nin: ['', null] } }] }, map: (l) => ({
  leadId: l._id, date: dateOnly(l.siteVisitDate), status: l.siteVisitStatus || '', owner: l.assignedRm || '', updatedAt: iso(l.updatedAt),
}) });

export const readBookings = (o: any): Promise<Page<any>> => paginate(CFG.COLL.INVENTORY, { ...o, field: 'lastModified', match: { status: { $in: ['Booked', 'Sold'] } }, map: (u) => ({
  id: u._id, unit: u.unitNumber || '', tower: u.tower || '', unitType: u.unitType || '',
  value: Number(u.quotedAmount) || Number(u.price) || 0, status: u.status || '',
  bookingDate: dateOnly(u.bookedDate), leadId: u.leadId || '', updatedAt: iso(u.lastModified),
}) });

// Tasks have no updatedAt in the store, so the change field is createdAt (incremental = newly created tasks).
export const readTasks = (o: any): Promise<Page<any>> => paginate(CFG.COLL.TASKS, { ...o, field: 'createdAt', map: (t) => ({
  id: t._id, leadId: t.leadId || '', dueDate: iso(t.datetime), owner: t.assignedTo || '', status: t.status || (t.completed ? 'Completed' : 'Pending'), createdAt: iso(t.createdAt),
}) });

// Users are a small list with no change timestamp — returned in full (no cursor). No phone / e-mail.
export async function readUsers(): Promise<Page<any>> {
  const users = await listUsers();
  return { data: users.map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.status === 'Active' })), nextCursor: null, hasMore: false };
}

/* ------------------------------ HTTP serve ------------------------------ */

const bearer = (req: Request) => { const h = req.headers.get('authorization') || ''; return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : ''; };
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Best-effort per-company rate limit (per server instance): 60 requests / minute.
const hits = new Map<string, { n: number; reset: number }>();
function rateOk(companyId: string): boolean {
  const now = Date.now();
  const h = hits.get(companyId);
  if (!h || now > h.reset) { hits.set(companyId, { n: 1, reset: now + 60_000 }); return true; }
  if (h.n >= 60) return false;
  h.n++;
  return true;
}

/** Shared handler for every /api/v1 GET route: auth with the read key, then run the read inside that company. */
export async function serveRead(req: Request, read: (o: any) => Promise<Page<any>>): Promise<Response> {
  const url = new URL(req.url);
  const key = (bearer(req) || req.headers.get('x-api-key') || url.searchParams.get('_key') || '').trim();
  if (!key) return jsonRes(401, { error: 'auth_required', message: 'API key missing (Authorization: Bearer <key>, or X-Api-Key header)' });
  const companyId = await resolveReadKey(key);
  if (!companyId) return jsonRes(401, { error: 'auth_required', message: 'Invalid or disabled API key' });
  const tenant = await getTenantById(companyId);
  if (!tenant) return jsonRes(401, { error: 'auth_required', message: 'Invalid API key' });
  if (tenant.status !== 'Active') return jsonRes(403, { error: 'forbidden', message: 'This account is suspended' });
  if (!rateOk(companyId)) return jsonRes(429, { error: 'rate_limited', message: 'Too many requests (max 60 per minute).' });
  const o = { updatedSince: url.searchParams.get('updatedSince'), limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') };
  try {
    return jsonRes(200, await runWithTenant(tenant, () => read(o)));
  } catch (e: any) {
    console.error('[api/v1]', e?.message);
    return jsonRes(500, { error: 'internal', message: 'Something went wrong on the server.' });
  }
}

export const actions: ActionMap = {
  listReadKeys: { fn: () => listReadKeys(), perm: 'integrations.connect' },
  createReadKey: { fn: (d, ctx) => createReadKey(d, ctx), perm: 'integrations.connect' },
  revokeReadKey: { fn: (d, ctx) => revokeReadKey(d, ctx), perm: 'integrations.connect' },
};
