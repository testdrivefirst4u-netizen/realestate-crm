/**
 * Project Library: the company's own copy of the library content (documents with their chapters and passages,
 * and the Quick Specs sections). Nothing saved = the library built into the app. Admins edit it, and so do the people
 * an admin names as library editors (stored beside the content); everyone reads it.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, listUsers, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { str, truncate } from '../core/utils';
import { defaultLibrary } from '../../src/documents/libraryContent';
import { LOCATIONS_DOC_ID, locationsDoc } from '../../src/documents/amayaLocations';
import { readLibraryFile } from './libraryFiles';
import { decodeBase64, deleteFile, isAllowedMime, sanitizeFilename, saveFile } from './storage';

const DOC_ID = 'content';
const EDITORS_ID = 'editors';
const MAX_BYTES = 4_000_000;
const MAX_DOCUMENTS = 60;
const CATEGORIES = ['Brochure', 'Floor Plans', 'Monthly Packages', 'Pricing & Payment', 'Legal & RERA', 'Locations'];
const ICONS = ['building', 'shield', 'money', 'heart', 'sparkles', 'map', 'book', 'file'];

const libraryCol = () => col<any>(CFG.COLL.LIBRARY);
const arr = (v: unknown, max: number): any[] => (Array.isArray(v) ? v.slice(0, max) : []);
const text = (v: unknown, max: number) => truncate(str(v).trim(), max);

/** A link the library may offer for download: the app's own files or an https address. */
function safeLink(v: unknown): string {
  const s = text(v, 2000);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : '';
  } catch {
    return '';
  }
}

/** Keep only the known shape, with limits (the content is shown to every user and searched by the AI). */
export function cleanLibrary(input: any) {
  const ids = new Set<string>();
  const documents = arr(input?.documents, MAX_DOCUMENTS).map((d: any, i: number) => {
    let id = text(d?.id, 60).replace(/[^a-z0-9-]/gi, '-').toLowerCase() || `doc-${i + 1}`;
    while (ids.has(id)) id += '-2';
    ids.add(id);
    const title = text(d?.title, 200);
    if (!title) throw fail('VALIDATION', `Document ${i + 1} needs a title.`);
    const refName = text(d?.refName, 40) || text(d?.shortName, 40) || title.slice(0, 40);
    return {
      id, title,
      shortName: text(d?.shortName, 80) || refName,
      refName,
      refTitle: text(d?.refTitle, 200) || title,
      idPrefix: (text(d?.idPrefix, 6).replace(/[^a-z0-9]/gi, '') || refName.replace(/[^a-z0-9]/gi, '').slice(0, 3) || 'DOC').toUpperCase(),
      category: CATEGORIES.includes(str(d?.category)) ? str(d.category) : 'Brochure',
      badgeColor: text(d?.badgeColor, 120).replace(/[^a-z0-9 \-[\]#:/]/gi, ''),
      summary: text(d?.summary, 1000),
      fileName: text(d?.fileName, 200),
      downloadUrl: safeLink(d?.downloadUrl),
      chapters: arr(d?.chapters, 60).map((c: any, ci: number) => ({
        title: text(c?.title, 200) || `Chapter ${ci + 1}`,
        passages: arr(c?.passages, 200)
          .map((p: any) => ({
            text: text(p?.text, 4000),
            tags: arr(p?.tags, 30).map((t) => text(t, 60)).filter(Boolean),
            ...(Number.isFinite(Number(p?.pageNumber)) && Number(p.pageNumber) > 0 ? { pageNumber: Math.floor(Number(p.pageNumber)) } : {}),
          }))
          .filter((p) => p.text),
      })),
    };
  });
  const sections = arr(input?.sections, 30).map((s: any, i: number) => ({
    category: text(s?.category, 120) || `Section ${i + 1}`,
    docRef: text(s?.docRef, 60),
    icon: ICONS.includes(str(s?.icon)) ? str(s.icon) : 'file',
    items: arr(s?.items, 60).map((x) => text(x, 500)).filter(Boolean),
  }));
  return { documents, sections };
}

async function editorEmails(): Promise<string[]> {
  const doc = await (await libraryCol()).findOne({ _id: EDITORS_ID });
  return Array.isArray(doc?.emails) ? doc.emails.map((e: unknown) => str(e).toLowerCase()).filter(Boolean) : [];
}

/** Admins, plus the people an admin named as library editors. */
async function canEditLibrary(ctx: Ctx | undefined): Promise<boolean> {
  if (!ctx?.user) return false;
  if (can(ctx.user, 'users.manage')) return true;
  return (await editorEmails()).includes(str(ctx.user.email).toLowerCase());
}

/**
 * Documents added to the built-in library after a company saved its own: added to the saved library once (an
 * editor who deletes one later is not overruled). The save bumps updatedAt, so an editor with an older copy open
 * is asked to reload instead of saving over it.
 */
const ADDED_LATER: Array<{ id: string; doc: () => unknown }> = [{ id: LOCATIONS_DOC_ID, doc: locationsDoc }];

async function addLaterDocuments(doc: any): Promise<any> {
  const missing = ADDED_LATER.filter((x) => !arr(doc?.seeded, 50).includes(x.id));
  if (!doc?.content || !missing.length) return doc;
  const have = new Set(arr(doc.content.documents, 200).map((d: any) => str(d?.id)));
  const content = { ...doc.content, documents: [...arr(doc.content.documents, 200), ...missing.filter((x) => !have.has(x.id)).map((x) => x.doc())] };
  const updatedAt = new Date();
  const r = await (await libraryCol()).updateOne({ _id: DOC_ID, updatedAt: doc.updatedAt }, { $set: { content, updatedAt }, $addToSet: { seeded: { $each: missing.map((x) => x.id) } } });
  return r.matchedCount ? { ...doc, content, updatedAt } : doc;
}

export async function libraryGet(ctx?: Ctx): Promise<{ content: ReturnType<typeof cleanLibrary> | null; updatedAt: string; updatedBy: string; canEdit: boolean; editors?: string[] }> {
  const doc = await addLaterDocuments(await (await libraryCol()).findOne({ _id: DOC_ID }));
  const out = { content: doc?.content || null, updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : '', updatedBy: str(doc?.updatedBy), canEdit: await canEditLibrary(ctx) };
  // only admins see (and change) who the editors are
  return ctx?.user && can(ctx.user, 'users.manage') ? { ...out, editors: await editorEmails() } : out;
}

/** Admins choose who else may edit the library (active CRM users). */
export async function librarySetEditors(d: { emails: unknown }, ctx: Ctx) {
  const list: unknown[] = Array.isArray(d?.emails) ? d.emails.slice(0, 100) : [];
  const wanted = [...new Set(list.map((e) => str(e).trim().toLowerCase()).filter(Boolean))];
  const active = new Set((await listUsers()).filter((u) => u.status !== 'Disabled').map((u) => u.email.toLowerCase()));
  for (const e of wanted) if (!active.has(e)) throw fail('VALIDATION', `Library editors must be active CRM users (${e} is not)`);
  await (await libraryCol()).updateOne({ _id: EDITORS_ID }, { $set: { emails: wanted, updatedAt: new Date(), updatedBy: ctx.user?.name || '' } }, { upsert: true });
  await auditLog(ctx, 'Project Library Editors', 'Library', EDITORS_ID, wanted.length ? wanted.join(', ') : 'Admins only');
  return libraryGet(ctx);
}

/** Save the company's library; `content: null` goes back to the library built into the app. */
/**
 * Save the content only if the library is still the one it was based on (`basedOn`: its updatedAt; null = nothing
 * saved yet, the built-in library). False when someone saved in between.
 */
async function writeLibrary(content: unknown, basedOn: Date | null, ctx: Ctx): Promise<boolean> {
  const lib = await libraryCol();
  const set = { content, updatedAt: new Date(), updatedBy: ctx.user?.name || '' };
  if (basedOn === null) {
    try {
      await lib.insertOne({ _id: DOC_ID, ...set });
      return true;
    } catch (e: any) {
      if (e?.code === 11000) return false;
      throw e;
    }
  }
  return (await lib.updateOne({ _id: DOC_ID, updatedAt: basedOn }, { $set: set })).matchedCount === 1;
}

export async function librarySave(d: { content: unknown; baseUpdatedAt?: string }, ctx: Ctx) {
  if (!(await canEditLibrary(ctx))) throw fail('FORBIDDEN', 'Only admins and the chosen library editors can change the Project Library');
  const lib = await libraryCol();
  if (d?.content === null) {
    await lib.deleteOne({ _id: DOC_ID });
    await auditLog(ctx, 'Project Library Reset', 'Library', DOC_ID, 'Back to the built-in project library');
    return libraryGet(ctx);
  }
  if (!d?.content || typeof d.content !== 'object') throw fail('VALIDATION', 'Nothing to save');
  const content = cleanLibrary(d.content);
  if (!content.documents.length && !content.sections.length) throw fail('VALIDATION', 'The library cannot be empty. Use "Restore original" instead.');
  if (JSON.stringify(content).length > MAX_BYTES) throw fail('VALIDATION', 'The library is too large. Shorten or remove some passages.');
  if (typeof d.baseUpdatedAt === 'string') {
    // the editor says which saved library it started from: refuse if someone saved since (e.g. added a file)
    const basedOn = d.baseUpdatedAt ? new Date(d.baseUpdatedAt) : null;
    if (basedOn && isNaN(basedOn.getTime())) throw fail('VALIDATION', 'Bad library version');
    if (!(await writeLibrary(content, basedOn, ctx))) {
      const now = await lib.findOne({ _id: DOC_ID }, { projection: { updatedBy: 1 } });
      throw fail('CONFLICT', `${now?.updatedBy || 'Someone'} changed the library after you started editing. Copy your changes, close and reopen the library, then make them again.`);
    }
  } else {
    await lib.updateOne({ _id: DOC_ID }, { $set: { content, updatedAt: new Date(), updatedBy: ctx.user?.name || '' } }, { upsert: true });
  }
  const passages = content.documents.reduce((n, x) => n + x.chapters.reduce((m, c) => m + c.passages.length, 0), 0);
  await auditLog(ctx, 'Project Library Updated', 'Library', DOC_ID, `${content.documents.length} documents, ${passages} passages, ${content.sections.length} quick-spec sections`);
  return libraryGet(ctx);
}

/* ------------------------------ adding files ------------------------------ */

/** Files arrive in pieces small enough for one request each (the host limits a request to ~4.5 MB). */
const PART_B64 = 4_200_000;
const MAX_PARTS = Math.ceil(CFG.UPLOAD_MAX_BYTES / 3_000_000);
const uploadsCol = () => col<any>(CFG.COLL.LIBRARY_UPLOADS);
const uploadIdOk = (v: unknown) => /^[a-z0-9-]{8,40}$/i.test(str(v));

export async function libraryUploadPart(d: { uploadId: string; index: number; base64: string }, ctx: Ctx) {
  if (!(await canEditLibrary(ctx))) throw fail('FORBIDDEN', 'Only admins and the chosen library editors can add files to the Project Library');
  const index = Number(d?.index);
  if (!uploadIdOk(d?.uploadId) || !Number.isInteger(index) || index < 0 || index >= MAX_PARTS) throw fail('VALIDATION', 'Bad upload piece');
  if (str(d?.base64).length > PART_B64) throw fail('VALIDATION', 'Upload piece is too large');
  const data = decodeBase64(d.base64);
  const uploads = await uploadsCol();
  await uploads.updateOne(
    { _id: `${d.uploadId}:${index}` },
    { $set: { uploadId: str(d.uploadId), index, data, by: str(ctx.user?.email).toLowerCase(), createdAt: new Date() } },
    { upsert: true },
  );
  return { ok: true };
}

/** "Payment_Schedule-v2.pdf" → "Payment Schedule v2". */
const titleFromName = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' – ').replace(/\s+/g, ' ').trim() || 'Uploaded document';

/** A sensible category from the file name; the editor can change it. */
export function guessCategory(name: string): string {
  const n = name.toLowerCase();
  if (/rera|legal|agreement|sale deed|approval|sanction|noc|title/.test(n)) return 'Legal & RERA';
  if (/price|pricing|payment|cost|schedule|milestone|bsp|quote/.test(n)) return 'Pricing & Payment';
  if (/floor|plan|layout|unit|bhk/.test(n)) return 'Floor Plans';
  if (/package|care|food|meal|service|monthly/.test(n)) return 'Monthly Packages';
  return 'Brochure';
}

/**
 * Put the uploaded pieces together, keep the original file (downloadable from the library), read its text into
 * chapters and passages and add it to the library as a new document.
 */
export async function libraryImport(d: { uploadId: string; parts: number; name: string; mime: string; title?: string; category?: string }, ctx: Ctx) {
  if (!(await canEditLibrary(ctx))) throw fail('FORBIDDEN', 'Only admins and the chosen library editors can add files to the Project Library');
  const parts = Number(d?.parts);
  if (!uploadIdOk(d?.uploadId) || !Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) throw fail('VALIDATION', 'Bad upload');
  const uploads = await uploadsCol();
  const by = str(ctx.user?.email).toLowerCase();
  const pieces = await uploads.find({ uploadId: str(d.uploadId), by }).sort({ index: 1 }).toArray();
  await uploads.deleteMany({ $or: [{ uploadId: str(d.uploadId) }, { createdAt: { $lt: new Date(Date.now() - 86_400_000) } }] });
  if (pieces.length !== parts || pieces.some((p, i) => p.index !== i)) throw fail('VALIDATION', 'The upload did not arrive complete. Please try again.');
  const data = Buffer.concat(pieces.map((p) => Buffer.from(p.data.buffer ?? p.data)));
  if (data.length > CFG.UPLOAD_MAX_BYTES) throw fail('VALIDATION', `File is larger than ${Math.round(CFG.UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`);

  const name = sanitizeFilename(d.name);
  const mime = str(d.mime).split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const chapters = await readLibraryFile(data, name, mime, ctx);

  const file = await saveFile({ category: 'Library', name, mime: isAllowedMime(mime) ? mime : 'application/octet-stream', data, uploadedBy: ctx.user?.name || '', description: 'Project Library' });
  const title = text(d.title, 200) || titleFromName(name);
  const refName = title.split(/\s+/).slice(0, 3).join(' ').slice(0, 40);
  const first = chapters[0].passages[0]?.text || '';
  const doc = {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'document',
    title, shortName: title.slice(0, 80), refName, refTitle: title, idPrefix: '',
    category: CATEGORIES.includes(str(d.category)) ? str(d.category) : guessCategory(name),
    badgeColor: '', summary: truncate(first, 300), fileName: name, downloadUrl: file.url,
    chapters: chapters.map((c) => ({ title: c.title, passages: c.passages.map((p) => ({ text: p.text, tags: [], ...(p.pageNumber ? { pageNumber: p.pageNumber } : {}) })) })),
  };
  let next;
  try {
    // added to the library as it is now; if someone saves in between, read it again (nothing of theirs is lost)
    for (let attempt = 0; ; attempt++) {
      const current = await (await libraryCol()).findOne({ _id: DOC_ID });
      const content = current?.content || defaultLibrary();
      if (content.documents.length >= MAX_DOCUMENTS) throw fail('VALIDATION', `The library already has ${MAX_DOCUMENTS} documents. Remove one before adding another.`);
      next = cleanLibrary({ ...content, documents: [...content.documents, doc] });
      if (JSON.stringify(next).length > MAX_BYTES) throw fail('VALIDATION', 'This file has too much text for the library. Upload a shorter file or split it into parts.');
      if (await writeLibrary(next, current ? current.updatedAt : null, ctx)) break;
      if (attempt >= 4) throw fail('CONFLICT', 'The library is being changed by someone else right now. Please try again.');
    }
  } catch (e) {
    await deleteFile(file.fileId); // no orphan file when the library was not saved
    throw e;
  }
  const added = next.documents[next.documents.length - 1];
  const passages = added.chapters.reduce((n, c) => n + c.passages.length, 0);
  await auditLog(ctx, 'Project Library File Added', 'Library', DOC_ID, `${name} → “${added.title}”: ${added.chapters.length} chapters, ${passages} passages`);
  return { ...(await libraryGet(ctx)), added: { id: added.id, title: added.title, chapters: added.chapters.length, passages } };
}

export const actions: ActionMap = {
  libraryGet: { fn: (_d, ctx) => libraryGet(ctx) },
  // admins (users.manage) and the chosen library editors — checked inside
  librarySave: { fn: (d, ctx) => librarySave(d, ctx) },
  libraryUploadPart: { fn: (d, ctx) => libraryUploadPart(d, ctx) },
  libraryImport: { fn: (d, ctx) => libraryImport(d, ctx) },
  librarySetEditors: { fn: (d, ctx) => librarySetEditors(d, ctx), perm: 'users.manage' },
};
