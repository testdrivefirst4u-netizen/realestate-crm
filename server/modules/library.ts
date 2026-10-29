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

const DOC_ID = 'content';
const EDITORS_ID = 'editors';
const MAX_BYTES = 1_500_000;
const CATEGORIES = ['Brochure', 'Floor Plans', 'Monthly Packages', 'Pricing & Payment', 'Legal & RERA'];
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
  const documents = arr(input?.documents, 40).map((d: any, i: number) => {
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

export async function libraryGet(ctx?: Ctx): Promise<{ content: ReturnType<typeof cleanLibrary> | null; updatedAt: string; updatedBy: string; canEdit: boolean; editors?: string[] }> {
  const doc = await (await libraryCol()).findOne({ _id: DOC_ID });
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
export async function librarySave(d: { content: unknown }, ctx: Ctx) {
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
  await lib.updateOne({ _id: DOC_ID }, { $set: { content, updatedAt: new Date(), updatedBy: ctx.user?.name || '' } }, { upsert: true });
  const passages = content.documents.reduce((n, x) => n + x.chapters.reduce((m, c) => m + c.passages.length, 0), 0);
  await auditLog(ctx, 'Project Library Updated', 'Library', DOC_ID, `${content.documents.length} documents, ${passages} passages, ${content.sections.length} quick-spec sections`);
  return libraryGet(ctx);
}

export const actions: ActionMap = {
  libraryGet: { fn: (_d, ctx) => libraryGet(ctx) },
  // admins (users.manage) and the chosen library editors — checked inside
  librarySave: { fn: (d, ctx) => librarySave(d, ctx) },
  librarySetEditors: { fn: (d, ctx) => librarySetEditors(d, ctx), perm: 'users.manage' },
};
