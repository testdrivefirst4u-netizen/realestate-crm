/**
 * File storage — replaces apps-script/16_Storage.gs (Google Drive) with MongoDB GridFS.
 * Files are served (auth-checked) by app/api/files/[id]/route.ts at `/api/files/<fileId>`.
 *
 * GridFS file metadata: { leadId, category, uploadedBy, description, mime }.
 * Lead documents are linked through the Documents collection (driveFileId = GridFS id, fileUrl = /api/files/<id>).
 */
import { ObjectId } from 'mongodb';
import { Readable } from 'node:stream';
import type { ActionMap } from '../core/actions';
import { assertLeadAccess } from '../core/scope';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col, filesBucket } from '../core/db';
import { fail } from '../core/errors';
import { addEvent } from '../core/events';
import { str, toIso, truncate } from '../core/utils';
import { getLead } from './leads';
import { saveRecord } from './records';

export interface SavedFile { fileId: string; url: string; size: number; mime: string; name: string }

export const fileUrlFor = (fileId: string) => `/api/files/${fileId}`;

export function isAllowedMime(mime: string) {
  return CFG.UPLOAD_MIME_ALLOW.some((re) => re.test(mime));
}

/** Strip paths, control and reserved characters; keep the extension; never empty. */
export function sanitizeFilename(name: unknown) {
  let s = String(name ?? '').normalize('NFC');
  s = s.split(/[\\/]/).pop() || '';
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').trim();
  if (s.length > 180) {
    const m = s.match(/(\.[A-Za-z0-9]{1,10})$/);
    const ext = m ? m[1] : '';
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s || `file_${Date.now()}`;
}

function normMime(mime: unknown) {
  return String(mime || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

function toObjectId(fileId: unknown): ObjectId | null {
  const s = String(fileId ?? '').trim();
  return /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

/** Store bytes in GridFS (MIME allow-list + size limit enforced here). */
export async function saveFile(opts: { leadId?: string; category: string; name: string; mime: string; data: Buffer; uploadedBy: string; description?: string }): Promise<SavedFile> {
  const data = opts.data;
  if (!data || !data.length) throw fail('VALIDATION', 'File content is empty');
  const maxMb = Math.round(CFG.UPLOAD_MAX_BYTES / (1024 * 1024));
  if (data.length > CFG.UPLOAD_MAX_BYTES) throw fail('VALIDATION', `File is larger than ${maxMb} MB.`);
  const mime = normMime(opts.mime);
  if (!isAllowedMime(mime)) throw fail('VALIDATION', `File type not allowed: ${mime}`);
  const name = sanitizeFilename(opts.name);
  const metadata = {
    leadId: str(opts.leadId),
    category: truncate(str(opts.category) || 'Other Files', 80),
    uploadedBy: str(opts.uploadedBy),
    description: truncate(str(opts.description), 1000),
    mime,
  };
  const bucket = await filesBucket();
  const upload = bucket.openUploadStream(name, { metadata });
  await new Promise<void>((resolve, reject) => {
    upload.once('finish', () => resolve());
    upload.once('error', reject);
    upload.end(data);
  });
  const fileId = upload.id.toString();
  return { fileId, url: fileUrlFor(fileId), size: data.length, mime, name };
}

export interface StoredFileInfo { id: ObjectId; mime: string; name: string; size: number; leadId?: string }

/** File metadata without the bytes (used by the download route). */
export async function statFile(fileId: string): Promise<StoredFileInfo | null> {
  const oid = toObjectId(fileId);
  if (!oid) return null;
  const f: any = await (await col(`${CFG.COLL.FILES_BUCKET}.files`)).findOne({ _id: oid });
  if (!f) return null;
  return { id: oid, mime: normMime(f.metadata?.mime || f.contentType), name: str(f.filename) || 'file', size: Number(f.length) || 0, leadId: str(f.metadata?.leadId) || undefined };
}

/** Stream a stored file (optionally a byte range, `end` exclusive) — for the download route. */
export async function openFileStream(info: StoredFileInfo, range?: { start: number; end: number }): Promise<Readable> {
  const bucket = await filesBucket();
  return bucket.openDownloadStream(info.id, range ? { start: range.start, end: range.end } : undefined);
}

/** Read a stored file (for the download route and for AI transcription). */
export async function readFile(fileId: string): Promise<{ data: Buffer; mime: string; name: string; size: number; leadId?: string } | null> {
  const info = await statFile(fileId);
  if (!info) return null;
  const stream = await openFileStream(info);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  const data = Buffer.concat(chunks);
  return { data, mime: info.mime, name: info.name, size: data.length, leadId: info.leadId };
}

/** Delete a stored file (no error when it does not exist). */
export async function deleteFile(fileId: string) {
  const oid = toObjectId(fileId);
  if (!oid) return;
  try {
    await (await filesBucket()).delete(oid);
  } catch {
    /* already gone */
  }
}

/** Decode a (possibly data:-URL prefixed) base64 payload, checking the size before allocating. */
function decodeBase64(base64: unknown): Buffer {
  const clean = String(base64 || '').replace(/^data:[^;,]*(;[^,]*)?;base64,/, '').replace(/\s+/g, '');
  if (!clean) throw fail('VALIDATION', 'File content is empty');
  const approx = Math.floor((clean.length * 3) / 4);
  if (approx > CFG.UPLOAD_MAX_BYTES + 3) {
    throw fail('VALIDATION', `File is larger than ${Math.round(CFG.UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`);
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) throw fail('VALIDATION', 'File content is not valid base64');
  return Buffer.from(clean, 'base64');
}

export async function uploadLeadFile(d: { leadId: string; category: string; name: string; mime: string; base64: string; description?: string }, ctx: Ctx): Promise<any> {
  if (!d || !str(d.leadId)) throw fail('VALIDATION', 'leadId is required');
  if (!ctx || !ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const leadId = str(d.leadId);
  const lead = await getLead(leadId);
  if (!lead) throw fail('NOT_FOUND', 'Lead not found: ' + leadId);
  const category = str(d.category) || 'Documents';
  const data = decodeBase64(d.base64);
  const file = await saveFile({ leadId, category, name: d.name, mime: d.mime, data, uploadedBy: ctx.user.name, description: d.description });
  let doc: any;
  try {
    doc = await saveRecord('documents', {
      leadId,
      name: str(d.name) || file.name,
      category: category === 'Documents' ? str((d as any).docCategory) || 'Customer Document' : category,
      fileUrl: file.url,
      driveFileId: file.fileId,
      description: str(d.description),
      uploadedBy: ctx.user.name,
    }, ctx);
  } catch (e) {
    await deleteFile(file.fileId); // do not leave an orphan file behind
    throw e;
  }
  await addEvent('document_uploaded', 'Lead', leadId, 'Document uploaded for ' + str(lead[CFG.LEAD.NAME]), doc.name, ctx.user.name);
  await auditLog(ctx, 'File Uploaded', 'Lead', leadId, `${doc.id}: ${file.name} (${file.mime}, ${file.size} bytes)`);
  return doc;
}

/** The lead's document records (CrmDocument shape), like GAS Storage_listLeadFiles. */
export async function listLeadFiles(leadId: string): Promise<any[]> {
  const id = str(leadId);
  if (!id) return [];
  const rows = await (await col(CFG.COLL.DOCUMENTS)).find({ leadId: id }).sort({ _id: 1 }).toArray();
  return rows.map((r: any) => ({
    id: str(r._id), leadId: str(r.leadId), name: str(r.name), category: str(r.category), fileUrl: str(r.fileUrl),
    driveFileId: str(r.driveFileId), uploadedDate: toIso(r.uploadedDate), uploadedBy: str(r.uploadedBy),
    description: str(r.description),
  }));
}

export const actions: ActionMap = {
  uploadLeadFile: { fn: async (d, ctx) => { await assertLeadAccess(ctx, d.leadId); return uploadLeadFile(d, ctx); }, perm: 'storage.edit' },
  listLeadFiles: { fn: async (d, ctx) => { await assertLeadAccess(ctx, d.leadId); return listLeadFiles(d.leadId); }, perm: 'storage.view' },
  getDriveStructure: { fn: () => ({ rootUrl: '', rootId: '', folders: [] }), perm: 'storage.view' },
};
