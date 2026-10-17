/**
 * Minimal .xlsx writer and reader (Office Open XML) on top of fflate — no spreadsheet library in the bundle.
 *
 * buildXlsx: one sheet, every cell an inline string (so phone numbers, ids and long numbers are never turned into
 *   9.19E+11 or rounded by Excel), bold frozen header row, sensible column widths.
 * readXlsxRows: the first sheet as rows of strings (shared and inline strings, numbers, booleans; date-formatted
 *   numbers become "yyyy-MM-dd HH:mm" so the CSV import pipeline can parse them). Pure string parsing — no DOM.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const MAX_CELL = 32767;
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const esc = (s: string) => s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 0 → A, 25 → Z, 26 → AA */
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(ref: string, value: unknown, style: number): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return '';
  const t = text.length > MAX_CELL ? text.slice(0, MAX_CELL) : text;
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(t)}</t></is></c>`;
}

/** An .xlsx workbook with one sheet: `headers` in a bold frozen first row, then `rows`. */
export function buildXlsx(headers: string[], rows: unknown[][], sheetName = 'Sheet1'): Uint8Array {
  const widths = headers.map((h, c) => {
    let w = String(h).length;
    for (let r = 0; r < Math.min(rows.length, 300); r++) w = Math.max(w, Math.min(60, String(rows[r][c] ?? '').split('\n')[0].length));
    return Math.max(8, Math.min(60, w + 2));
  });
  const lastCol = colName(Math.max(0, headers.length - 1));
  const out: string[] = [];
  out.push(`<row r="1">${headers.map((h, c) => cellXml(`${colName(c)}1`, h, 1)).join('')}</row>`);
  rows.forEach((row, i) => {
    const r = i + 2;
    out.push(`<row r="${r}">${headers.map((_, c) => cellXml(`${colName(c)}${r}`, row[c], 2)).join('')}</row>`);
  });
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:${lastCol}${rows.length + 1}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${out.join('')}</sheetData>` +
    (headers.length ? `<autoFilter ref="A1:${lastCol}${rows.length + 1}"/>` : '') +
    '</worksheet>';
  const name = esc(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    ),
    // styles: 0 default, 1 bold header on light fill, 2 text (@) with top alignment
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6EFF6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>' +
        '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };
  return zipSync(files, { level: 6 });
}

/** Save an .xlsx in the browser. */
export function downloadXlsx(filename: string, headers: string[], rows: unknown[][], sheetName?: string): void {
  const data = buildXlsx(headers, rows, sheetName);
  const blob = new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------------------------------- reading -------------------------------- */

const unesc = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });

/** All <t>…</t> text inside a fragment (rich text runs joined; phonetic <rPh> runs skipped). */
const textOf = (xml: string) => {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
  return unesc(s);
};

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unesc(m[1]) : '';
};

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Excel serial date (1900 system) → "yyyy-MM-dd" or "yyyy-MM-dd HH:mm". */
export function excelSerialToText(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return d.getUTCHours() || d.getUTCMinutes() ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}

const colIndexOf = (ref: string) => {
  const letters = ref.replace(/\d+$/, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Rows of the first worksheet of an .xlsx file, as strings. Throws a readable error for non-xlsx input. */
export function readXlsxRows(data: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error('This file is not a valid .xlsx workbook. In Excel use File → Save As → Excel Workbook (.xlsx), or CSV.');
  }
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : '');

  // first sheet's path: workbook.xml → its r:id → workbook rels target
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = read('xl/workbook.xml');
  const firstSheet = wb.match(/<sheet\b[^>]*>/);
  const rid = firstSheet ? attr(firstSheet[0], 'r:id') : '';
  if (rid) {
    for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(m[0], 'Id') === rid) {
        const target = attr(m[0], 'Target');
        sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      }
    }
  }
  const sheet = read(sheetPath);
  if (!sheet) throw new Error('The workbook has no readable worksheet.');

  const shared: string[] = [];
  for (const m of read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  // which style indexes are dates
  const styles = read('xl/styles.xml');
  const customFmts = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) customFmts.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode'));
  const dateStyle: boolean[] = [];
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (xfs) {
    for (const m of xfs[1].matchAll(/<xf\b[^>]*\/?>/g)) {
      const id = Number(attr(m[0], 'numFmtId') || 0);
      const code = (customFmts.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
      dateStyle.push(BUILTIN_DATE_FMTS.has(id) || (/[dy]/.test(code) && !/^[#0.,%\s]+$/.test(code)) || /h+:m/.test(code));
    }
  }

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowAttrs = rm[1] ?? rm[3] ?? '';
    const r = attr(`<row${rowAttrs}>`, 'r');
    const rowIdx = r ? parseInt(r, 10) - 1 : rows.length;
    const cells: string[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${cm[1]}>`;
      const ref = attr(tag, 'r');
      const col = ref ? colIndexOf(ref) : nextCol;
      nextCol = col + 1;
      const type = attr(tag, 't');
      const body = cm[2] || '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      let value = '';
      if (type === 's') value = shared[Number(v?.[1] ?? -1)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'b') value = v?.[1] === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = v ? unesc(v[1]) : '';
      else if (v) {
        const n = Number(v[1]);
        const s = Number(attr(tag, 's') || 0);
        value = Number.isFinite(n) && dateStyle[s] ? excelSerialToText(n) : Number.isFinite(n) && Number.isInteger(n) ? String(n) : unesc(v[1]);
      }
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows[rowIdx] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  // drop trailing empty rows
  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
  return rows;
}

/** Rows → CSV text (RFC 4180 quoting), so an uploaded workbook can go through the CSV import pipeline. */
export function rowsToCsv(rows: string[][]): string {
  const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => Array.from({ length: width }, (_, i) => q(String(r[i] ?? ''))).join(',')).join('\r\n');
}
