/**
 * Records (documents, templates — shared; notes, checklist — private per user) — port of apps-script/13_Records.gs.
 *
 * `_id` is the business id: DOC-0001, TPL-0001, NOTE-0001, CHK-0001. Notes and checklist items carry
 * `userId` and are only visible to / editable by their owner. Shared kinds bump the data version.
 */
import type { ActionMap } from '../core/actions';
import type { Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import { resolveSuppliedId } from './leads';
import { assertLeadAccess, filterByLead } from '../core/scope';
import { bool, parseDate, str, toIso } from '../core/utils';

export type RecordKind = 'documents' | 'templates' | 'notes' | 'checklist';

interface KindDef { coll: string; prefix: string; perUser: boolean }

function recordDef(kind: RecordKind): KindDef {
  switch (kind) {
    case 'documents': return { coll: CFG.COLL.DOCUMENTS, prefix: 'DOC', perUser: false };
    case 'templates': return { coll: CFG.COLL.TEMPLATES, prefix: 'TPL', perUser: false };
    case 'notes': return { coll: CFG.COLL.NOTES, prefix: 'NOTE', perUser: true };
    case 'checklist': return { coll: CFG.COLL.CHECKLIST, prefix: 'CHK', perUser: true };
    default: throw fail('VALIDATION', 'Unknown record kind: ' + kind);
  }
}

/** GAS Records_serialize. */
function serialize(kind: RecordKind, r: any): any {
  switch (kind) {
    case 'documents':
      return {
        id: str(r._id), leadId: str(r.leadId), name: str(r.name), category: str(r.category), fileUrl: str(r.fileUrl),
        driveFileId: str(r.driveFileId), uploadedDate: toIso(r.uploadedDate), uploadedBy: str(r.uploadedBy), description: str(r.description),
      };
    case 'templates':
      return { id: str(r._id), type: str(r.type), name: str(r.name), message: str(r.message), updated: toIso(r.updated) };
    case 'notes':
      return { id: str(r._id), userId: str(r.userId), text: str(r.text), created: toIso(r.created), updated: toIso(r.updated) };
    case 'checklist':
      return { id: str(r._id), userId: str(r.userId), text: str(r.text), completed: bool(r.completed), updated: toIso(r.updated) };
  }
}

/**
 * Document links must be https:// URLs or files served by this app (`/api/files/<id>`).
 * Anything else (javascript:, data:, http:, protocol-relative …) is rejected. Empty is allowed.
 */
export function validateFileUrl(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  if (/^\/api\/files\/[A-Za-z0-9_-]{1,64}$/.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw fail('VALIDATION', 'File URL must be an https:// link');
  }
  if (u.protocol !== 'https:' || !u.hostname || /[\s<>"]/.test(s)) throw fail('VALIDATION', 'File URL must be an https:// link');
  return s;
}

/** GAS Records_toCells — the stored fields for a save (full replacement of the editable fields). */
function toFields(kind: RecordKind, rec: any, ctx: Ctx, isNew: boolean): Record<string, unknown> {
  const now = new Date();
  const actor = ctx && ctx.user ? ctx.user.name : 'System';
  switch (kind) {
    case 'documents':
      return {
        leadId: str(rec.leadId), name: str(rec.name), category: str(rec.category), fileUrl: validateFileUrl(rec.fileUrl),
        driveFileId: str(rec.driveFileId), uploadedDate: parseDate(rec.uploadedDate) || now, uploadedBy: str(rec.uploadedBy) || actor,
        description: str(rec.description),
      };
    case 'templates':
      return { type: str(rec.type) || 'WhatsApp', name: str(rec.name), message: rec.message == null ? '' : String(rec.message), updated: now };
    case 'notes':
      return { text: rec.text == null ? '' : String(rec.text), updated: now, ...(isNew ? { userId: ctx.user!.id, created: now } : {}) };
    case 'checklist':
      return { text: rec.text == null ? '' : String(rec.text), completed: bool(rec.completed), updated: now, ...(isNew ? { userId: ctx.user!.id } : {}) };
  }
}

function requireUser(def: KindDef, ctx: Ctx) {
  if (def.perUser && !(ctx && ctx.user && ctx.user.id)) throw fail('AUTH_REQUIRED', 'Please sign in');
}

export async function listRecords(kind: RecordKind, ctx: Ctx): Promise<any[]> {
  const def = recordDef(kind);
  const c = await col(def.coll);
  if (def.perUser) {
    const uid = ctx && ctx.user ? ctx.user.id : '__none__';
    const rows = await c.find({ userId: uid }).sort(kind === 'notes' ? { updated: -1 } : { _id: 1 }).toArray();
    return rows.map((r) => serialize(kind, r));
  }
  const rows = await c.find({}).sort({ _id: 1 }).toArray();
  return rows.map((r) => serialize(kind, r)).filter((r) => r.id);
}

export async function saveRecord(kind: RecordKind, data: any, ctx: Ctx): Promise<any> {
  const def = recordDef(kind);
  if (!data || typeof data !== 'object') throw fail('VALIDATION', 'Record data required');
  requireUser(def, ctx);
  const c = await col<any>(def.coll);
  const reqId = str(data.id);
  if (reqId.length > 64) throw fail('VALIDATION', 'Invalid record id');
  const existing = reqId ? await c.findOne({ _id: reqId }) : null;
  let id: string;
  if (existing) {
    if (def.perUser && str(existing.userId) !== ctx.user!.id) throw fail('FORBIDDEN', 'Not your record');
    id = reqId;
    await c.updateOne({ _id: id }, { $set: toFields(kind, data, ctx, false) });
  } else {
    const fields = toFields(kind, data, ctx, true);
    // A browser-supplied id is kept only when it can never collide with an issued one (see leads.resolveSuppliedId).
    id = reqId && !/^tmp_/.test(reqId) ? await resolveSuppliedId(def.prefix, 4, reqId, async (x) => !!(await c.findOne({ _id: x }, { projection: { _id: 1 } }))) : await nextSeq(def.prefix, 4);
    try {
      await c.insertOne({ _id: id, ...fields });
    } catch (e: any) {
      if (e?.code === 11000) throw fail('CONFLICT', 'Record ' + id + ' already exists');
      throw e;
    }
  }
  const saved = serialize(kind, await c.findOne({ _id: id }));
  if (kind === 'documents' && saved.leadId) {
    await addTimeline(saved.leadId, 'document_added', 'Document added: ' + saved.name, saved.category, ctx.user ? ctx.user.name : 'System', 'Document', saved.id);
  }
  if (!def.perUser) await bumpVersion();
  return saved;
}

export async function removeRecord(kind: RecordKind, id: string, ctx: Ctx): Promise<void> {
  const def = recordDef(kind);
  requireUser(def, ctx);
  const c = await col<any>(def.coll);
  const key = str(id);
  const existing = key ? await c.findOne({ _id: key }) : null;
  if (!existing) throw fail('NOT_FOUND', 'Record not found');
  if (def.perUser && str(existing.userId) !== ctx.user!.id) throw fail('FORBIDDEN', 'Not your record');
  await c.deleteOne({ _id: key });
  if (!def.perUser) await bumpVersion();
}

/** Lead documents follow their lead's visibility (server/core/scope.ts); general documents are shared. */
async function assertDocumentAccess(kind: RecordKind, id: unknown, data: any, ctx: Ctx) {
  if (kind !== 'documents') return;
  if (data?.leadId) await assertLeadAccess(ctx, data.leadId);
  const existing: any = id ? await (await col(CFG.COLL.DOCUMENTS)).findOne({ _id: str(id) as any }, { projection: { leadId: 1 } }) : null;
  if (existing?.leadId) await assertLeadAccess(ctx, existing.leadId);
}

export const actions: ActionMap = {
  listRecords: {
    fn: async (d, ctx) => {
      const rows = await listRecords(d.kind, ctx);
      return d.kind === 'documents' ? filterByLead(ctx.user, rows, (r: any) => r.leadId) : rows;
    },
    perm: 'records.view',
  },
  saveRecord: { fn: async (d, ctx) => { await assertDocumentAccess(d.kind, d.data?.id, d.data, ctx); return saveRecord(d.kind, d.data, ctx); }, perm: 'records.edit' },
  deleteRecord: { fn: async (d, ctx) => { await assertDocumentAccess(d.kind, d.id, null, ctx); return removeRecord(d.kind, d.id, ctx); }, perm: 'records.edit' },
};
