/** Project Library files: PDF / Word / Excel / CSV become chapters and passages; uploads arrive in pieces. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { strToU8, zipSync } from 'fflate';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login, SYSTEM_CTX } from '../server/core/auth';
import { readLibraryFile, textToPassages } from '../server/modules/libraryFiles';
import { guessCategory } from '../server/modules/library';
import { readFile } from '../server/modules/storage';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.1.1.3' };
const tokens: Record<string, string> = {};
async function signIn(name: string, role: 'Admin' | 'Manager' | 'RM') {
  const email = name.toLowerCase() + '@libfiles.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;

/** A small real PDF with one line of text per page. */
function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((txt, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${txt.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

function makeDocx(): Buffer {
  const p = (text: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
    ${p('Amenities', 'Heading1')}
    ${p('Amaya has a clubhouse with a heated pool, a library and a yoga deck, all built for comfortable senior living &amp; safety.')}
    ${p('Pricing', 'Heading1')}
    <w:tbl><w:tr>${cell('Unit')}${cell('Size')}</w:tr><w:tr>${cell('2 BHK')}${cell('1,250 sq.ft')}</w:tr><w:tr>${cell('2.5 BHK')}${cell('1,533 sq.ft')}</w:tr></w:tbl>
  </w:body></w:document>`;
  return Buffer.from(zipSync({ 'word/document.xml': strToU8(xml), '[Content_Types].xml': strToU8('<Types/>') }));
}

async function makeXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Price List');
  ws.addRow(['Amaya price list']);
  ws.addRow(['Unit', 'Size', 'Price']);
  ws.addRow(['2 BHK', '1,250', '₹1.1 Cr']);
  ws.addRow(['2.5 BHK', '1,533', '₹1.4 Cr']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await signIn('Asha', 'Admin');
  await signIn('Meera', 'Manager');
});

describe('reading files', () => {
  it('PDF: one section per page with page numbers', async () => {
    const ch = await readLibraryFile(makePdf(['Amaya is near MediCiti hospital in Medchal.', 'TG RERA number P02200011109 is approved.']), 'Brochure.pdf', 'application/pdf', SYSTEM_CTX);
    expect(ch.map((c) => c.title)).toEqual(['Page 1', 'Page 2']);
    expect(ch[1].passages[0]).toMatchObject({ pageNumber: 2 });
    expect(ch[1].passages[0].text).toContain('P02200011109');
  });

  it('Word: chapters at headings; table rows as "Header: value"', async () => {
    const ch = await readLibraryFile(makeDocx(), 'Amaya Notes.docx', '', SYSTEM_CTX);
    expect(ch.map((c) => c.title)).toEqual(['Amenities', 'Pricing']);
    expect(ch[0].passages[0].text).toContain('senior living & safety');
    expect(ch[1].passages.map((p) => p.text)).toEqual(['Unit: 2 BHK · Size: 1,250 sq.ft', 'Unit: 2.5 BHK · Size: 1,533 sq.ft']);
  });

  it('Excel: a section per sheet, a passage per row; the title above the header is kept', async () => {
    const ch = await readLibraryFile(await makeXlsx(), 'Prices.xlsx', '', SYSTEM_CTX);
    expect(ch).toHaveLength(1);
    expect(ch[0].title).toBe('Price List');
    expect(ch[0].passages.map((p) => p.text)).toEqual(['Amaya price list', 'Unit: 2 BHK · Size: 1,250 · Price: ₹1.1 Cr', 'Unit: 2.5 BHK · Size: 1,533 · Price: ₹1.4 Cr']);
  });

  it('CSV and text; old formats are refused with a hint', async () => {
    const csv = await readLibraryFile(Buffer.from('Package,Price\nFood,"₹12,000"\n'), 'packages.csv', 'text/csv', SYSTEM_CTX);
    expect(csv[0].passages[0].text).toBe('Package: Food · Price: ₹12,000');
    const txt = await readLibraryFile(Buffer.from('# Location\nNear Kandlakoya.\n# Transport\nBuggy service inside the campus.'), 'notes.md', '', SYSTEM_CTX);
    expect(txt.map((c) => c.title)).toEqual(['Location', 'Transport']);
    await expect(readLibraryFile(Buffer.from('x'), 'old.doc', '', SYSTEM_CTX)).rejects.toThrow(/\.docx/);
    await expect(readLibraryFile(Buffer.from('x'), 'old.xls', '', SYSTEM_CTX)).rejects.toThrow(/\.xlsx/);
    await expect(readLibraryFile(Buffer.from('x'), 'slides.pptx', '', SYSTEM_CTX)).rejects.toThrow(/PDF/);
  });

  it('running text is split into readable passages', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} about the Amaya project and its care services.`).join('\n');
    const ps = textToPassages(long, 3);
    expect(ps.length).toBeGreaterThan(1);
    expect(ps.every((p) => p.pageNumber === 3 && p.text.length <= 1500)).toBe(true);
  });

  it('guesses a category from the file name', () => {
    expect(guessCategory('TG RERA Approval.pdf')).toBe('Legal & RERA');
    expect(guessCategory('Payment Schedule.xlsx')).toBe('Pricing & Payment');
    expect(guessCategory('Floor plan 2BHK.pdf')).toBe('Floor Plans');
    expect(guessCategory('Amaya brochure.pdf')).toBe('Brochure');
  });
});

describe('adding a file to the library', () => {
  const send = async (who: string, id: string, data: Buffer, size = 3_000_000) => {
    const parts = Math.ceil(data.length / size);
    for (let i = 0; i < parts; i++) expect((await as(who, 'libraryUploadPart', { uploadId: id, index: i, base64: data.subarray(i * size, (i + 1) * size).toString('base64') })).status).toBe('success');
    return parts;
  };

  it('a library editor uploads in pieces; the file becomes a searchable document with the original kept', async () => {
    const pdf = makePdf(['Payment milestone one is 10 percent on booking.', 'Escrow account details for buyers.']);
    // not an editor yet
    expect((await as('Meera', 'libraryUploadPart', { uploadId: 'abcdefgh1', index: 0, base64: pdf.toString('base64') })).status).toBe('error');
    await as('Asha', 'librarySetEditors', { emails: ['meera@libfiles.test'] });

    const parts = await send('Meera', 'upload-test-1', pdf, 400); // several small pieces
    expect(parts).toBeGreaterThan(1);
    const r = await as('Meera', 'libraryImport', { uploadId: 'upload-test-1', parts, name: 'Payment_Schedule.pdf', mime: 'application/pdf' });
    expect(r.status).toBe('success');
    expect(r.data.added).toMatchObject({ title: 'Payment Schedule', chapters: 2, passages: 2 });

    const doc = r.data.content.documents.at(-1);
    expect(doc).toMatchObject({ title: 'Payment Schedule', category: 'Pricing & Payment', fileName: 'Payment_Schedule.pdf' });
    expect(doc.chapters[1].passages[0]).toMatchObject({ text: 'Escrow account details for buyers.', pageNumber: 2 });
    expect(r.data.content.documents.length).toBeGreaterThan(5); // the built-in documents are kept
    const file = await readFile(doc.downloadUrl.split('/').pop());
    expect(file?.data.equals(pdf)).toBe(true);

    // the pieces are gone: importing again fails
    expect((await as('Meera', 'libraryImport', { uploadId: 'upload-test-1', parts, name: 'x.pdf', mime: 'application/pdf' })).status).toBe('error');
  });

  it('a missing piece or an unreadable file is refused and nothing is added', async () => {
    await send('Asha', 'upload-test-2', makePdf(['Hello Amaya page one text here.']), 300);
    const bad = await as('Asha', 'libraryImport', { uploadId: 'upload-test-2', parts: 99, name: 'a.pdf', mime: 'application/pdf' });
    expect(bad.status).toBe('error');

    await send('Asha', 'upload-test-3', Buffer.from('not really a pdf at all'));
    const unreadable = await as('Asha', 'libraryImport', { uploadId: 'upload-test-3', parts: 1, name: 'broken.pdf', mime: 'application/pdf' });
    expect(unreadable.status).toBe('error');
    expect((await as('Asha', 'libraryGet')).data.content).toBeNull();
  });
});

describe('search highlighting', () => {
  it('escapes the text and the terms, and never matches inside an escape', async () => {
    const { highlightTerms } = await import('../src/documents/projectDocuments');
    expect(highlightTerms("Owner's <b>flat</b>", ['39'])).toBe('Owner&#39;s &lt;b&gt;flat&lt;/b&gt;');
    expect(highlightTerms('Tom & Jerry', ['amp'])).toBe('Tom &amp; Jerry');
    const lit = highlightTerms('2.5 BHK <script>', ['bhk', '<script>']);
    expect(lit).not.toContain('<script>');
    expect((lit.match(/<mark/g) || []).length).toBe(2);
  });
});

describe('zip bombs', () => {
  it('a Word file that would unpack to far too much is refused before it is unpacked', async () => {
    const huge = new Uint8Array(200 * 1024 * 1024); // zeros: compresses to a few hundred KB
    const bomb = Buffer.from(zipSync({ 'word/document.xml': huge }, { level: 9 }));
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    await expect(readLibraryFile(bomb, 'bomb.docx', '', SYSTEM_CTX)).rejects.toThrow(/too much data/);
  });
});
