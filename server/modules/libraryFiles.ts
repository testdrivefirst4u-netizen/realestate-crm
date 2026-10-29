/**
 * Turning an uploaded file into Project Library chapters and passages: PDF (one chapter per page, or per few pages),
 * Word .docx (chapters at headings, table rows as passages), Excel .xlsx and CSV (one chapter per sheet, one
 * passage per row as "Header: value · …"), and plain text / Markdown. Scanned PDFs with no text are read by the AI
 * when it is set up. Old binary formats (.doc, .xls, .ppt) are refused with a hint to save them in a newer format.
 */
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { parseCsvText } from '../../src/services/csvService';
import type { Ctx } from '../core/auth';
import { fail } from '../core/errors';

export interface ImportedPassage { text: string; pageNumber?: number }
export interface ImportedChapter { title: string; passages: ImportedPassage[] }
export type LibraryFileKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text';

const MAX_CHAPTERS = 60;
const MAX_PASSAGES = 200;
const MAX_PASSAGE = 1500;

export function fileKind(name: string, mime: string): LibraryFileKind {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'csv') return 'csv';
  if (['txt', 'md', 'markdown'].includes(ext) || /^text\/plain$|^text\/markdown$/.test(mime)) return 'text';
  if (ext === 'doc') throw fail('VALIDATION', 'Old Word files (.doc) cannot be read. Open it in Word and use Save As → Word Document (.docx), or save it as PDF.');
  if (ext === 'xls') throw fail('VALIDATION', 'Old Excel files (.xls) cannot be read. Open it in Excel and use Save As → Excel Workbook (.xlsx).');
  if (ext === 'ppt' || ext === 'pptx') throw fail('VALIDATION', 'PowerPoint files cannot be read. Save the slides as PDF and upload that.');
  throw fail('VALIDATION', 'Upload a PDF, Word (.docx), Excel (.xlsx), CSV or text file.');
}

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t ]+/g, ' ').trim();

function cut(s: string): string {
  if (s.length <= MAX_PASSAGE) return s;
  const at = s.lastIndexOf(' ', MAX_PASSAGE - 1);
  return s.slice(0, at > MAX_PASSAGE / 2 ? at : MAX_PASSAGE - 1) + '…';
}

/** Running text → passages of a readable size: lines joined into paragraphs, split at sentence ends. */
export function textToPassages(text: string, pageNumber?: number): ImportedPassage[] {
  const out: ImportedPassage[] = [];
  let buf = '';
  const flush = () => {
    const t = clean(buf);
    if (t.length >= 3) out.push({ text: cut(t), ...(pageNumber ? { pageNumber } : {}) });
    buf = '';
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) {
      if (buf.length >= 120) flush();
      continue;
    }
    // a list item starts its own passage once the paragraph so far is long enough to stand alone
    if (/^([•●▪◦*-]|\d{1,2}[.)])\s/.test(line) && buf.length >= 120) flush();
    buf = buf ? `${buf} ${line}` : line;
    if ((buf.length >= 300 && /[.!?:;]$/.test(line)) || buf.length >= 900) flush();
  }
  flush();
  return out;
}

/** "Header: value · Header: value" for a table row (just the values when there is no header). */
function rowText(headers: string[], cells: string[]): string {
  const parts = cells.map((v, i) => {
    const val = clean(v);
    if (!val) return '';
    const h = clean(headers[i] || '');
    return h && h !== val ? `${h}: ${val}` : val;
  }).filter(Boolean);
  return parts.length ? cut(parts.join(' · ')) : '';
}

/** A table (first row with two or more filled cells is the header) → chapters of at most MAX_PASSAGES rows. */
function tableChapters(title: string, rows: string[][]): ImportedChapter[] {
  const filled = rows.filter((r) => r.some((c) => clean(c)));
  if (!filled.length) return [];
  const headAt = filled.findIndex((r) => r.filter((c) => clean(c)).length >= 2);
  const headers = headAt >= 0 && filled.length > headAt + 1 ? filled[headAt].map(clean) : [];
  // anything above the header (a sheet title, a note) is kept as its own passage
  const before = headAt > 0 ? filled.slice(0, headAt).map((r) => rowText([], r)) : [];
  const body = (headers.length ? filled.slice(headAt + 1) : filled).map((r) => rowText(headers, r));
  const passages = [...before, ...body].filter(Boolean).map((text) => ({ text }));
  const out: ImportedChapter[] = [];
  for (let i = 0; i < passages.length; i += MAX_PASSAGES) {
    const part = passages.slice(i, i + MAX_PASSAGES);
    out.push({ title: passages.length > MAX_PASSAGES ? `${title} (rows ${i + 1}–${i + part.length})` : title, passages: part });
  }
  return out;
}

/** Long single-chapter content is split into parts so each chapter stays readable. */
function splitLong(ch: ImportedChapter): ImportedChapter[] {
  if (ch.passages.length <= MAX_PASSAGES) return [ch];
  const out: ImportedChapter[] = [];
  for (let i = 0; i < ch.passages.length; i += MAX_PASSAGES) out.push({ title: `${ch.title} (part ${out.length + 1})`, passages: ch.passages.slice(i, i + MAX_PASSAGES) });
  return out;
}

/* ---------------------------------- PDF ---------------------------------- */

/** Pages → chapters: one per page, or a few pages per chapter for long documents. */
function pagesToChapters(pages: string[]): ImportedChapter[] {
  const per = Math.max(1, Math.ceil(pages.length / MAX_CHAPTERS));
  const out: ImportedChapter[] = [];
  for (let i = 0; i < pages.length; i += per) {
    const passages = pages.slice(i, i + per).flatMap((t, j) => textToPassages(t, i + j + 1));
    if (!passages.length) continue;
    const last = Math.min(i + per, pages.length);
    out.push({ title: per === 1 ? `Page ${i + 1}` : `Pages ${i + 1}–${last}`, passages: passages.slice(0, MAX_PASSAGES) });
  }
  return out;
}

async function readPdf(data: Buffer, ctx: Ctx): Promise<ImportedChapter[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    pages = (await extractText(pdf, { mergePages: false })).text as string[];
  } catch {
    throw fail('VALIDATION', 'This PDF could not be opened. It may be damaged or password-protected.');
  }
  if (pages.join('').replace(/\s+/g, '').length >= 40) return pagesToChapters(pages);
  // scanned pages (pictures): let the AI read them
  let read = '';
  try {
    const { readDocumentText } = await import('./ai');
    read = await readDocumentText(data, 'application/pdf', ctx);
  } catch (e: any) {
    if (e?.code === 'NOT_CONFIGURED') throw fail('VALIDATION', 'This PDF is scanned pictures with no text in it. Set up AI in Settings → Integrations to read scanned PDFs, or upload a PDF with selectable text.');
    throw e;
  }
  const byPage = read.split(/^\s*=+\s*Page\s+\d+\s*=+\s*$/im).map((s) => s.trim());
  const scanned = byPage[0] ? byPage : byPage.slice(1);
  const chapters = pagesToChapters(scanned.length ? scanned : [read]);
  if (!chapters.length) throw fail('VALIDATION', 'No text could be read from this PDF.');
  return chapters;
}

/* ---------------------------------- Word --------------------------------- */

const xmlText = (xml: string) =>
  (xml.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) || [])
    .map((t) => (t.startsWith('<w:t') && !t.startsWith('<w:tab') ? t.replace(/<[^>]+>/g, '') : ' '))
    .join('')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function readDocx(data: Buffer): ImportedChapter[] {
  let xml = '';
  try {
    const files = unzipSync(new Uint8Array(data), { filter: (f) => f.name === 'word/document.xml' });
    xml = files['word/document.xml'] ? strFromU8(files['word/document.xml']) : '';
  } catch {
    /* not a zip */
  }
  if (!xml) throw fail('VALIDATION', 'This Word file could not be opened. Save it again as .docx or PDF and retry.');
  const chapters: ImportedChapter[] = [];
  let current: ImportedChapter = { title: 'Introduction', passages: [] };
  let short: string[] = []; // short lines (list items, labels) gathered into one passage
  const flushShort = () => {
    if (short.length) current.passages.push({ text: cut(short.join(' · ')) });
    short = [];
  };
  const add = (t: string) => {
    if (t.length < 80) {
      short.push(t);
      if (short.join(' · ').length >= 400) flushShort();
      return;
    }
    flushShort();
    for (const p of textToPassages(t)) current.passages.push(p);
  };
  const body = xml.slice(xml.indexOf('<w:body'));
  for (const block of body.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g) || []) {
    if (block.startsWith('<w:tbl>')) {
      flushShort();
      const rows = (block.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []).map((r) => (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((c) => clean(xmlText(c))));
      for (const ch of tableChapters('', rows)) current.passages.push(...ch.passages);
      continue;
    }
    const t = clean(xmlText(block));
    if (!t) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] || '';
    if (/^(title|heading ?[12])$/i.test(style) || /^(Heading|Title)[12]?$/i.test(style)) {
      flushShort();
      if (current.passages.length) chapters.push(current);
      current = { title: t.slice(0, 200), passages: [] };
      continue;
    }
    add(t);
  }
  flushShort();
  if (current.passages.length) chapters.push(current);
  return chapters.flatMap(splitLong);
}

/* --------------------------------- Excel --------------------------------- */

async function readXlsx(data: Buffer): Promise<ImportedChapter[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as any);
  } catch {
    throw fail('VALIDATION', 'This Excel file could not be opened. Save it again as .xlsx and retry.');
  }
  const out: ImportedChapter[] = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(row.cellCount, 40); c++) {
        let v = '';
        try {
          v = row.getCell(c).text || '';
        } catch {
          v = '';
        }
        cells.push(v);
      }
      rows.push(cells);
    });
    out.push(...tableChapters(ws.name || `Sheet ${out.length + 1}`, rows));
  });
  return out;
}

/* ------------------------------ text and CSV ------------------------------ */

function readText(text: string): ImportedChapter[] {
  const chapters: ImportedChapter[] = [];
  let title = 'Introduction';
  let lines: string[] = [];
  const flush = () => {
    const passages = textToPassages(lines.join('\n'));
    if (passages.length) chapters.push({ title, passages });
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,2}\s+(.+)$/.exec(line.trim());
    if (h) {
      flush();
      title = clean(h[1]).slice(0, 200);
    } else lines.push(line);
  }
  flush();
  return chapters.flatMap(splitLong);
}

/** The chapters of an uploaded file (empty chapters dropped, at most 60). */
export async function readLibraryFile(data: Buffer, name: string, mime: string, ctx: Ctx): Promise<ImportedChapter[]> {
  const kind = fileKind(name, mime);
  const chapters =
    kind === 'pdf' ? await readPdf(data, ctx)
    : kind === 'docx' ? readDocx(data)
    : kind === 'xlsx' ? await readXlsx(data)
    : kind === 'csv' ? tableChapters('Table', parseCsvText(data.toString('utf8').replace(/^﻿/, '')))
    : readText(data.toString('utf8').replace(/^﻿/, ''));
  const kept = chapters.filter((c) => c.passages.length).slice(0, MAX_CHAPTERS);
  if (!kept.length) throw fail('VALIDATION', 'No text was found in this file.');
  return kept;
}
