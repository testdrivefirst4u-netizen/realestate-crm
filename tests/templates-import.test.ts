/**
 * Message-template import (src/modules/templates/importTemplates.ts): Word / Excel / CSV / text → template drafts.
 * The .docx / .xlsx fixtures are built in memory with fflate, so no binary fixtures live in the repo.
 */
import { describe, it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  MAX_MESSAGE_LENGTH,
  MAX_TEMPLATES_PER_FILE,
  ParsedTemplate,
  TemplateImportError,
  findUnfilledPlaceholders,
  normalisePlaceholders,
  normaliseTemplateType,
  parseTemplateFile,
  parseTemplateFileDetailed,
  templateFingerprint,
} from '../src/modules/templates/importTemplates';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const core = (list: ParsedTemplate[]) => list.map(({ type, name, message }) => ({ type, name, message }));

/* ------------------------------ .docx builder ----------------------------- */

const run = (text: string, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text: string, o: { style?: string; bold?: boolean; num?: [string, number] } = {}) => {
  const props = o.style || o.num ? `<w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.num ? `<w:numPr><w:ilvl w:val="${o.num[1]}"/><w:numId w:val="${o.num[0]}"/></w:numPr>` : ''}</w:pPr>` : '';
  return `<w:p>${props}${text ? run(text, o.bold) : ''}</w:p>`;
};
const heading = (level: number, text: string) => para(text, { style: `Heading${level}` });
const blank = '<w:p/>';
const table = (rows: string[][]) =>
  `<w:tbl><w:tblPr/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${c.split('\n').map((line) => para(line)).join('')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="berschrift3"><w:name w:val="heading 3"/></w:style>
  <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

function docx(body: string, o: { styles?: boolean; numbering?: boolean; links?: Record<string, string> } = {}): Uint8Array {
  const rels = [
    o.styles === false ? '' : `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
    o.numbering ? `<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>` : '',
    ...Object.entries(o.links ?? {}).map(([id, url]) => `<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${esc(url)}" TargetMode="External"/>`),
  ].join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="${PKG}">${rels}</Relationships>`),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}<w:sectPr/></w:body></w:document>`
    ),
    'word/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  };
  if (o.styles !== false) files['word/styles.xml'] = strToU8(STYLES);
  if (o.numbering) files['word/numbering.xml'] = strToU8(NUMBERING);
  return zipSync(files);
}

const fromDocx = (body: string, o?: Parameters<typeof docx>[1]) => parseTemplateFile({ name: 'Amaya scripts.docx', bytes: docx(body, o) });

/* ------------------------------ .xlsx builder ----------------------------- */

interface SheetSpec {
  name: string;
  rows: Array<Array<string | number | null>>;
  hidden?: boolean;
  merges?: string[];
}

function xlsx(sheets: SheetSpec[]): Uint8Array {
  const shared: string[] = [];
  const index = new Map<string, number>();
  const sst = (s: string) => {
    if (!index.has(s)) {
      index.set(s, shared.length);
      shared.push(s);
    }
    return index.get(s);
  };
  const cell = (v: string | number | null, ref: string) => {
    if (v === null || v === '') return '';
    return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
  };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((s, i) => {
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, `${String.fromCharCode(65 + ci)}${ri + 1}`)).join('')}</row>`).join('');
    const merges = s.merges?.length ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${S}" xmlns:r="${R}"><sheetData>${rows}</sheetData>${merges}</worksheet>`);
  });
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0"?><workbook xmlns="${S}" xmlns:r="${R}"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="${PKG}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdShared" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
  );
  files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0"?><sst xmlns="${S}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`);
  files['_rels/.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files['[Content_Types].xml'] = strToU8(CONTENT_TYPES);
  return zipSync(files);
}

const fromXlsx = (sheets: SheetSpec[]) => parseTemplateFileDetailed({ name: 'Templates.xlsx', bytes: xlsx(sheets) });
const fromText = (name: string, text: string, options?: Parameters<typeof parseTemplateFile>[1]) => parseTemplateFile({ name, bytes: strToU8(text) }, options);

/* ================================== Word ================================== */

describe('Word (.docx)', () => {
  it('makes one template per heading — runs joined, blank lines kept, merge fields normalised', async () => {
    const body = [
      heading(1, 'Welcome message'),
      `<w:p><w:r><w:t xml:space="preserve">Hello {{customer_</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>name}}, </w:t></w:r><w:r><w:t>thank you for your interest in Amaya.</w:t></w:r></w:p>`,
      blank,
      para('Warm regards,'),
      `<w:p><w:r><w:t>[RM Name]</w:t><w:br/><w:t>Amaya by Vera Vita</w:t></w:r></w:p>`,
      heading(1, 'Site visit reminder'),
      para('Hi <Customer Name>, a reminder of your visit on [Date] — see you soon!'),
    ].join('');
    const out = await fromDocx(body);
    expect(core(out)).toEqual([
      { type: 'WhatsApp', name: 'Welcome message', message: 'Hello {name}, thank you for your interest in Amaya.\n\nWarm regards,\n{rm}\nAmaya by Vera Vita' },
      { type: 'WhatsApp', name: 'Site visit reminder', message: 'Hi {name}, a reminder of your visit on [Date] — see you soon!' },
    ]);
    expect(out[0].source).toBe('Paragraph 1');
    expect(out[0].notes).toBeUndefined();
    expect(out[1].notes).toEqual(['Not filled in automatically: [Date]']);
  });

  it('types templates from container headings, "[SMS] …" prefixes and "Type:" lines', async () => {
    const body = [
      para('Amaya Sales Scripts', { style: 'Title' }),
      heading(1, 'Email scripts'),
      heading(2, 'Brochure follow-up'),
      para('Dear {name}, please find the brochure attached.'),
      heading(2, '[SMS] Visit reminder'),
      para('Reminder: your Amaya visit is tomorrow.'),
      heading(1, 'Call scripts'),
      heading(2, 'Opening'),
      para('Good morning, this is {rm} calling from Amaya.'),
      heading(2, 'Price objection'),
      para('Type: WhatsApp'),
      para('I understand, {name}. Let me share a cost comparison.'),
    ].join('');
    expect(core(await fromDocx(body))).toEqual([
      { type: 'Email', name: 'Brochure follow-up', message: 'Dear {name}, please find the brochure attached.' },
      { type: 'SMS', name: 'Visit reminder', message: 'Reminder: your Amaya visit is tomorrow.' },
      { type: 'Call', name: 'Opening', message: 'Good morning, this is {rm} calling from Amaya.' },
      { type: 'WhatsApp', name: 'Price objection', message: 'I understand, {name}. Let me share a cost comparison.' },
    ]);
  });

  it('applies a container heading to same-level siblings when everything is Heading 1', async () => {
    const body = [
      heading(1, 'Email templates'),
      heading(1, 'Brochure'),
      para('Dear {name}, here is the brochure.'),
      heading(1, 'Price list'),
      para('Dear {name}, the price list is attached.'),
      heading(1, 'WhatsApp templates'),
      heading(1, 'Welcome'),
      para('Hi {name}!'),
    ].join('');
    expect((await fromDocx(body)).map((t) => [t.type, t.name])).toEqual([
      ['Email', 'Brochure'],
      ['Email', 'Price list'],
      ['WhatsApp', 'Welcome'],
    ]);
  });

  it('uses all-bold lines as headings when the document has no heading styles', async () => {
    const body = [
      para('Welcome message', { bold: true }),
      blank,
      para('Hello {name}, welcome to Amaya.'),
      blank,
      para('Site visit follow-up', { bold: true }),
      para('Thank you for visiting today, {name}.'),
    ].join('');
    expect(core(await fromDocx(body, { styles: false }))).toEqual([
      { type: 'WhatsApp', name: 'Welcome message', message: 'Hello {name}, welcome to Amaya.' },
      { type: 'WhatsApp', name: 'Site visit follow-up', message: 'Thank you for visiting today, {name}.' },
    ]);
  });

  it('keeps a bold label inside a message when heading styles already split the document', async () => {
    const body = [
      heading(1, 'Welcome'),
      para('Hello {name}!'),
      para('Highlights:', { bold: true }),
      para('Clubhouse and healthcare on site'),
      heading(1, 'Reminder'),
      para('See you tomorrow, {name}.'),
    ].join('');
    expect(core(await fromDocx(body))).toEqual([
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}!\nHighlights:\nClubhouse and healthcare on site' },
      { type: 'WhatsApp', name: 'Reminder', message: 'See you tomorrow, {name}.' },
    ]);
  });

  it('treats bold lines under each heading as sub-headings (channel headings with named scripts)', async () => {
    const body = [
      heading(1, 'WhatsApp'),
      para('Welcome', { bold: true }),
      para('Hi {name}, welcome to Amaya!'),
      para('Reminder', { bold: true }),
      para('Hi {name}, see you tomorrow.'),
      heading(1, 'Email'),
      para('Brochure', { bold: true }),
      para('Dear {name}, the brochure is attached.'),
      para('Price list', { bold: true }),
      para('Dear {name}, the price list is attached.'),
    ].join('');
    expect((await fromDocx(body)).map((t) => [t.type, t.name])).toEqual([
      ['WhatsApp', 'Welcome'],
      ['WhatsApp', 'Reminder'],
      ['Email', 'Brochure'],
      ['Email', 'Price list'],
    ]);
  });

  it('without headings, splits on blank paragraphs and names each block from a short first line', async () => {
    const body = [
      para('Welcome message'),
      para('Hello {name}, thanks for your enquiry.'),
      blank,
      para('Thank you for visiting Amaya today — we loved meeting you.'),
      blank,
      blank,
      para('Brochure'),
      para('Here is our brochure: https://amaya.example/brochure'),
    ].join('');
    const out = await fromDocx(body);
    expect(core(out)).toEqual([
      { type: 'WhatsApp', name: 'Welcome message', message: 'Hello {name}, thanks for your enquiry.' },
      { type: 'WhatsApp', name: 'Thank you for visiting Amaya today…', message: 'Thank you for visiting Amaya today — we loved meeting you.' },
      { type: 'WhatsApp', name: 'Brochure', message: 'Here is our brochure: https://amaya.example/brochure' },
    ]);
    expect(out.some((t) => t.unsure)).toBe(false);
  });

  it('uses "Label:" lines as headings when templates are not separated by blank lines', async () => {
    const body = [para('Welcome:'), para('Hello {name}, thanks for your enquiry.'), para('Reminder:'), para('Hi {name}, see you tomorrow.')].join('');
    expect(core(await fromDocx(body, { styles: false }))).toEqual([
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}, thanks for your enquiry.' },
      { type: 'WhatsApp', name: 'Reminder', message: 'Hi {name}, see you tomorrow.' },
    ]);
  });

  it('maps a table with Name / Message headers row by row; other tables stay text', async () => {
    const body = [
      table([['Amaya by Vera Vita', 'Sales scripts 2026']]),
      heading(1, 'Templates'),
      table([
        ['Template name', 'Channel', 'Message'],
        ['Welcome', 'WA', 'Hello {{name}}!\nWelcome to Amaya.'],
        ['Brochure', 'e-mail', 'Dear [Customer], the brochure is attached.'],
        ['', '', ''],
      ]),
    ].join('');
    const out = await fromDocx(body);
    expect(core(out)).toEqual([
      { type: 'WhatsApp', name: 'Amaya by Vera Vita', message: 'Sales scripts 2026' },
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}!\nWelcome to Amaya.' },
      { type: 'Email', name: 'Brochure', message: 'Dear {name}, the brochure is attached.' },
    ]);
    expect(out[0].unsure).toBe(true); // text before the first heading — listed, but unticked in the review
    expect(out[0].notes?.[0]).toMatch(/introduction or a note/);
    expect(out[1].source).toBe('Table 2 · row 2');
  });

  it('flags text under a heading that has sub-headings (e.g. an intro under the Title) as unsure', async () => {
    const body = [
      para('Amaya Sales Scripts', { style: 'Title' }),
      para('Internal use only. Personalise every message before sending.'),
      heading(1, 'Welcome'),
      para('Hello {name}!'),
    ].join('');
    const out = await fromDocx(body);
    expect(out.map((t) => [t.name, !!t.unsure])).toEqual([
      ['Amaya Sales Scripts', true],
      ['Welcome', false],
    ]);
  });

  it('fills vertically merged table cells and ignores rows without a message', async () => {
    const tc = (text: string, props = '') => `<w:tc><w:tcPr>${props}</w:tcPr>${text ? para(text) : blank}</w:tc>`;
    const body = `<w:tbl>
      <w:tr>${tc('Type')}${tc('Title')}${tc('Script')}</w:tr>
      <w:tr>${tc('Email', '<w:vMerge w:val="restart"/>')}${tc('Brochure')}${tc('Dear {name}, brochure attached.')}</w:tr>
      <w:tr>${tc('', '<w:vMerge/>')}${tc('Price list')}${tc('Dear {name}, price list attached.')}</w:tr>
      <w:tr>${tc('Internal notes row', '<w:gridSpan w:val="3"/>')}</w:tr>
    </w:tbl>`;
    expect(core(await fromDocx(body))).toEqual([
      { type: 'Email', name: 'Brochure', message: 'Dear {name}, brochure attached.' },
      { type: 'Email', name: 'Price list', message: 'Dear {name}, price list attached.' },
    ]);
  });

  it('keeps bullets and numbering from Word lists', async () => {
    const body = [
      heading(1, 'Amenities'),
      para('Here is what you get:'),
      para('Clubhouse', { num: ['1', 0] }),
      para('24x7 healthcare', { num: ['1', 0] }),
      heading(1, 'Visit steps'),
      para('Meet your RM', { num: ['2', 0] }),
      para('Tour the show flat', { num: ['2', 0] }),
      para('Bring ID proof', { num: ['2', 1] }),
      para('Discuss pricing', { num: ['2', 0] }),
    ].join('');
    expect((await fromDocx(body, { numbering: true })).map((t) => t.message)).toEqual([
      'Here is what you get:\n• Clubhouse\n• 24x7 healthcare',
      '1. Meet your RM\n2. Tour the show flat\n  a) Bring ID proof\n3. Discuss pricing',
    ]);
  });

  it('handles Word quirks: tracked changes, text boxes, links, tabs, table of contents, localised heading styles', async () => {
    const body = [
      `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>
        <w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>Welcome</w:t></w:r><w:r><w:tab/><w:t>1</w:t></w:r></w:p>
      </w:sdtContent></w:sdt>`,
      para('Welcome', { style: 'berschrift3' }),
      `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:rPr><w:b/></w:rPr></w:pPr>
        <w:r><w:t xml:space="preserve">Hello {name}, </w:t></w:r>
        <w:del w:id="1" w:author="Rahul"><w:r><w:delText>old offer </w:delText></w:r></w:del>
        <w:ins w:id="2" w:author="Rahul"><w:r><w:t xml:space="preserve">book a visit </w:t></w:r></w:ins>
        <w:hyperlink r:id="rIdVisit"><w:r><w:t>here</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r>
      </w:p>`,
      `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Limited units left</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice>
        <mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Limited units left</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
      `<w:p><w:r><w:t>Call</w:t><w:tab/><w:t>98490</w:t><w:noBreakHyphen/><w:t>12345 &amp; ask for &#8220;Amaya&#8221;</w:t></w:r></w:p>`,
      para('Price list', { style: 'berschrift3' }),
      para('Dear {name}, the price list is attached.'),
    ].join('');
    expect(core(await fromDocx(body, { links: { rIdVisit: 'https://amaya.example/visit' } }))).toEqual([
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}, book a visit here (https://amaya.example/visit).\nLimited units left\nCall 98490-12345 & ask for “Amaya”' },
      { type: 'WhatsApp', name: 'Price list', message: 'Dear {name}, the price list is attached.' },
    ]);
  });

  it('accepts an ArrayBuffer and passes known types through', async () => {
    const bytes = docx([heading(1, 'Follow up - Day 3'), para('Hi {name}, just checking in.')].join(''));
    const out = await parseTemplateFile({ name: 'x.docx', bytes: bytes.slice().buffer }, { knownTypes: ['WhatsApp', 'Follow Up'] });
    expect(core(out)).toEqual([{ type: 'Follow Up', name: 'Day 3', message: 'Hi {name}, just checking in.' }]);
  });
});

/* ================================== Excel ================================= */

describe('Excel (.xlsx)', () => {
  it('reads a header row and shared strings, normalising types and skipping empty rows', async () => {
    const res = await fromXlsx([
      {
        name: 'Templates',
        rows: [
          ['Type', 'Name', 'Message'],
          ['wa', 'Welcome', 'Hello {{Name}}, welcome to Amaya!'],
          [null, null, null],
          ['E-mail', 'Brochure', 'Dear [Client Name],\nPlease find the brochure attached.\n— <RM>'],
          ['Call', 'No script yet', null],
        ],
      },
    ]);
    expect(res.format).toBe('xlsx');
    expect(core(res.templates)).toEqual([
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}, welcome to Amaya!' },
      { type: 'Email', name: 'Brochure', message: 'Dear {name},\nPlease find the brochure attached.\n— {rm}' },
    ]);
    expect(res.templates.map((t) => t.source)).toEqual(['Templates · row 2', 'Templates · row 4']);
    expect(res.warnings).toEqual([]);
  });

  it('handles prefixed XML, rich text, _x000D_ escapes, inline and formula strings, title rows and hidden or unrelated sheets', async () => {
    const sharedStrings = `<?xml version="1.0"?><x:sst xmlns:x="${S}">
      <x:si><x:t>Email templates</x:t></x:si>
      <x:si><x:t>Name</x:t></x:si>
      <x:si><x:t>Message</x:t></x:si>
      <x:si><x:r><x:rPr><x:b/></x:rPr><x:t xml:space="preserve">Dear {name}, </x:t></x:r><x:r><x:t xml:space="preserve">thank you._x000D_
Regards, [Your Name]</x:t></x:r><x:rPh sb="0" eb="1"><x:t>ignored</x:t></x:rPh></x:si>
      <x:si><x:t>Thank you</x:t></x:si>
      <x:si><x:t>Keep these numbers handy</x:t></x:si>
    </x:sst>`;
    const scripts = `<?xml version="1.0"?><x:worksheet xmlns:x="${S}"><x:sheetData>
      <x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row>
      <x:row r="3"><x:c r="A3" t="s"><x:v>1</x:v></x:c><x:c r="B3" t="s"><x:v>2</x:v></x:c></x:row>
      <x:row r="4"><x:c r="A4" t="s"><x:v>4</x:v></x:c><x:c r="B4" t="s"><x:v>3</x:v></x:c></x:row>
      <x:row r="5"><x:c r="A5" t="inlineStr"><x:is><x:t>Brochure</x:t></x:is></x:c><x:c r="B5" t="inlineStr"><x:is><x:t>Here is the brochure: {{ project }}</x:t></x:is></x:c></x:row>
      <x:row r="6"><x:c r="A6"><x:v>42</x:v></x:c><x:c r="B6" t="str"><x:f>CONCAT("Formula ","text")</x:f><x:v>Formula text</x:v></x:c></x:row>
    </x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A1:B1"/></x:mergeCells></x:worksheet>`;
    const notes = `<?xml version="1.0"?><x:worksheet xmlns:x="${S}"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>5</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
    const hidden = `<?xml version="1.0"?><x:worksheet xmlns:x="${S}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Name</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>Message</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>Old</x:t></x:is></x:c><x:c r="B2" t="inlineStr"><x:is><x:t>Old message</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
    const bytes = zipSync({
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`),
      'xl/workbook.xml': strToU8(
        `<?xml version="1.0"?><x:workbook xmlns:x="${S}" xmlns:r="${R}"><x:sheets><x:sheet name="Notes" sheetId="1" r:id="rId1"/><x:sheet name="Scripts" sheetId="2" r:id="rId2"/><x:sheet name="Old" sheetId="3" state="hidden" r:id="rId3"/></x:sheets></x:workbook>`
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<?xml version="1.0"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
      ),
      'xl/sharedStrings.xml': strToU8(sharedStrings),
      'xl/worksheets/sheet1.xml': strToU8(notes),
      'xl/worksheets/sheet2.xml': strToU8(scripts),
      'xl/worksheets/sheet3.xml': strToU8(hidden),
    });
    const res = await parseTemplateFileDetailed({ name: 'Scripts.xlsm', bytes });
    expect(core(res.templates)).toEqual([
      { type: 'Email', name: 'Thank you', message: 'Dear {name}, thank you.\nRegards, {rm}' },
      { type: 'Email', name: 'Brochure', message: 'Here is the brochure: {{ project }}' },
      { type: 'Email', name: '42', message: 'Formula text' },
    ]);
    expect(res.templates[1].notes).toEqual(['Not filled in automatically: {{ project }}']);
    expect(res.warnings).toEqual(['Skipped sheet “Notes” — no Type | Name | Message header row.']);
  });

  it('applies the column rules without a header: 2 = name + message, 3 = type + name + message, S.No ignored', async () => {
    const two = await fromXlsx([{ name: 'Sheet1', rows: [[1, 'Welcome', 'Hello {name}, welcome!'], [2, 'Reminder', 'Hi {name}, see you tomorrow.']] }]);
    expect(core(two.templates)).toEqual([
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}, welcome!' },
      { type: 'WhatsApp', name: 'Reminder', message: 'Hi {name}, see you tomorrow.' },
    ]);
    const three = await fromXlsx([
      {
        name: 'Sheet1',
        rows: [
          ['WhatsApp', 'Welcome', 'Hello {name}, welcome to Amaya!'],
          ['Email', 'Brochure', 'Dear {name}, please find the brochure attached.'],
          ['sms', 'Reminder', 'Reminder: visit tomorrow at 11.'],
        ],
      },
    ]);
    expect(three.templates.map((t) => [t.type, t.name])).toEqual([
      ['WhatsApp', 'Welcome'],
      ['Email', 'Brochure'],
      ['SMS', 'Reminder'],
    ]);
  });

  it('names one-column messages from their first six words', async () => {
    const res = await fromXlsx([{ name: 'Sheet1', rows: [['Hello {name}, thank you for your enquiry about Amaya.'], ['Your site visit is confirmed.']] }]);
    expect(res.templates.map((t) => t.name)).toEqual(['Hello {name}, thank you for your…', 'Your site visit is confirmed']);
  });

  it('reads every channel-named sheet and one message column per channel', async () => {
    const sheets = await fromXlsx([
      { name: 'WhatsApp', rows: [['Welcome', 'Hello {name}, welcome!']] },
      { name: 'Emails', rows: [['Brochure', 'Dear {name}, brochure attached.']] },
    ]);
    expect(sheets.templates.map((t) => [t.type, t.name])).toEqual([
      ['WhatsApp', 'Welcome'],
      ['Email', 'Brochure'],
    ]);
    const perChannel = await fromXlsx([
      {
        name: 'Scripts',
        rows: [
          ['Scenario', 'WhatsApp', 'Email script'],
          ['New enquiry', 'Hi {name}! Thanks for reaching out.', 'Dear {name},\nThank you for your enquiry.'],
          ['After visit', 'Thanks for visiting, {name}!', null],
        ],
      },
    ]);
    expect(core(perChannel.templates)).toEqual([
      { type: 'WhatsApp', name: 'New enquiry', message: 'Hi {name}! Thanks for reaching out.' },
      { type: 'Email', name: 'New enquiry', message: 'Dear {name},\nThank you for your enquiry.' },
      { type: 'WhatsApp', name: 'After visit', message: 'Thanks for visiting, {name}!' },
    ]);
  });

  it('fills vertically merged Type cells down', async () => {
    const res = await fromXlsx([
      {
        name: 'Sheet1',
        rows: [
          ['Type', 'Name', 'Message'],
          ['Email', 'Brochure', 'Dear {name}, brochure attached.'],
          [null, 'Price list', 'Dear {name}, price list attached.'],
        ],
        merges: ['A2:A3'],
      },
    ]);
    expect(res.templates.map((t) => t.type)).toEqual(['Email', 'Email']);
  });

  it('skips a journey / mapping sheet that refers to scripts by code, and never treats an ID column as the message', async () => {
    // The shape of the "CRM Ready WhatsApp Master Sheet": a journey map, not a template library.
    const res = await fromXlsx([
      {
        name: 'WhatsApp Journey',
        rows: [
          ['Seq', 'Lead Stage', 'Trigger / Event', 'Timing', 'Template ID', 'Purpose', 'Personalisation', 'CTA', 'CRM Action', 'Next Stage'],
          ['01', 'New Enquiry', 'New enquiry created', 'Immediately', 'NEW-01', 'Introduction', 'Customer name; self/parents', 'Reply / call', 'Assign RM; create first-contact task', 'Open'],
          ['02', 'Open', 'First call completed', 'Within 15 min', 'CALL-01', 'Call follow-up', 'Key requirement; purpose', 'Reply with questions', 'Log call outcome; set follow-up date', 'Open'],
          ['03', 'Open', 'Brochure/details shared', 'Immediately', 'DOC-01', 'Details acknowledgement', 'Relevant home/options', 'Review & reply', 'Mark details shared', 'Open'],
          ['04', 'Open', 'No reply for 3 days', 'Day 3', 'FU-01', 'Soft follow-up', 'Last shared information', 'Reply', 'Set reminder', 'Open'],
        ],
      },
      { name: 'Stage Mapping', rows: [['Suggested CRM Stage', 'Journey Treatment'], ['New Enquiry', 'New'], ['Contacted / Open', 'Open']] },
      {
        name: 'Scripts',
        rows: [
          ['Template ID', 'Name', 'Message'],
          ['NEW-01', 'Introduction', 'Hello {name}, thank you for your interest in Amaya by Vera Vita. May I share a few details here?'],
          ['CALL-01', 'Call follow-up', 'Hello {name}, it was lovely speaking with you today. I will share the details we discussed shortly.'],
        ],
      },
    ]);
    expect(res.templates.map((t) => [t.name, t.message.slice(0, 12)])).toEqual([['Introduction', 'Hello {name}'], ['Call follow-up', 'Hello {name}']]);
    expect(res.warnings.join('\n')).toMatch(/Skipped “WhatsApp Journey” — it refers to scripts by code \(NEW-01, CALL-01, DOC-01\)/);
    expect(res.warnings.join('\n')).toMatch(/Skipped sheets? “Stage Mapping” — no Type \| Name \| Message header row/);

    // Short labels only → skipped with a different explanation
    const labels = await fromXlsx([{ name: 'Sheet1', rows: [['Name', 'Message'], ['Intro', 'Say hello'], ['Follow-up', 'Check in'], ['Visit', 'Confirm date']] }]);
    expect(labels.templates).toEqual([]);
    expect(labels.warnings.join('\n')).toMatch(/no column holds message text/);
  });
});

/* ================================ CSV / text =============================== */

describe('CSV and text files', () => {
  it('parses quoted CSV cells with commas, quotes and line breaks', async () => {
    const csv = 'Type,Name,Message\r\n"WhatsApp","Welcome","Hello {{name}},\nwelcome to Amaya, Medchal!"\r\nsms,"Visit ""reminder""","See you at 11, {Customer Name}"\r\n';
    expect(core(await fromText('templates.csv', csv))).toEqual([
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name},\nwelcome to Amaya, Medchal!' },
      { type: 'SMS', name: 'Visit "reminder"', message: 'See you at 11, {name}' },
    ]);
  });

  it('detects semicolons, resolves "Template" headers and reads headerless two-column files', async () => {
    const semicolons = await fromText('a.csv', 'Template;Message\n\nWelcome;Hello {name}\n');
    expect(core(semicolons)).toEqual([{ type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}' }]);
    expect(semicolons[0].source).toBe('Row 3'); // blank rows count, so the label matches the sheet
    expect(core(await fromText('b.csv', 'Template name,Template\nWelcome,Hello {name}\n'))).toEqual([{ type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}' }]);
    expect(core(await fromText('c.csv', 'Welcome,"Hello {name}, welcome!"\nReminder,"Hi {name}, see you tomorrow."\n'))).toEqual([
      { type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}, welcome!' },
      { type: 'WhatsApp', name: 'Reminder', message: 'Hi {name}, see you tomorrow.' },
    ]);
  });

  it('decodes Windows-1252 CSV, UTF-16 tab-separated text and pre-decoded text', async () => {
    const cp1252 = new Uint8Array([...strToU8('Name,Message\nWelcome,'), 0x93, ...strToU8('Namaste'), 0x94, ...strToU8(' from Amaya\n')]);
    expect((await parseTemplateFile({ name: 'win.csv', bytes: cp1252 }))[0].message).toBe('“Namaste” from Amaya');

    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('Name\tMessage\r\nWelcome\tHello {name}\r\n', 'utf16le')]);
    const res = await parseTemplateFileDetailed({ name: 'export.txt', bytes: utf16 });
    expect(res.format).toBe('csv');
    expect(core(res.templates)).toEqual([{ type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}' }]);

    expect(core(await parseTemplateFile({ name: 'pasted.csv', bytes: new Uint8Array(), text: 'Name,Message\nHi,Hello {name}' }))).toEqual([{ type: 'WhatsApp', name: 'Hi', message: 'Hello {name}' }]);
  });

  it('splits text files on blank lines and separators, naming blocks from a short first line', async () => {
    const txt = 'Welcome message\nHello {name}, thank you for your enquiry.\nRegards, {rm}\n\n\nReminder:\nHi [Name], see you tomorrow at 11.\n\n---\n\nThank you for visiting Amaya today!\n';
    expect(core(await fromText('scripts.txt', txt))).toEqual([
      { type: 'WhatsApp', name: 'Welcome message', message: 'Hello {name}, thank you for your enquiry.\nRegards, {rm}' },
      { type: 'WhatsApp', name: 'Reminder', message: 'Hi {name}, see you tomorrow at 11.' },
      { type: 'WhatsApp', name: 'Thank you for visiting Amaya today', message: 'Thank you for visiting Amaya today!' },
    ]);
  });

  it('uses Markdown headings, with container headings setting the type and intro text flagged', async () => {
    const md = 'Internal use only — personalise before sending.\n\n# Email\n\n## Brochure\nDear {{name}},\n\nPlease find the brochure attached.\n\n## Price list\nDear {name}, the price list is attached.\n\n# WhatsApp\n## Welcome\n**Hi {name}!** Welcome to Amaya.\n';
    const out = await fromText('scripts.md', md);
    expect(core(out)).toEqual([
      { type: 'WhatsApp', name: 'Internal use only — personalise before…', message: 'Internal use only — personalise before sending.' },
      { type: 'Email', name: 'Brochure', message: 'Dear {name},\n\nPlease find the brochure attached.' },
      { type: 'Email', name: 'Price list', message: 'Dear {name}, the price list is attached.' },
      { type: 'WhatsApp', name: 'Welcome', message: '**Hi {name}!** Welcome to Amaya.' },
    ]);
    expect(out.map((t) => !!t.unsure)).toEqual([true, false, false, false]);
  });

  it('reads "Type:" / "Name:" / "Message:" lines in text blocks', async () => {
    const txt = 'Type: Email\nName: Brochure\nMessage: Dear {name},\nthe brochure is attached.\n\nChannel: call\nTitle: Opening\nGood morning, this is {rm} from Amaya.';
    expect(core(await fromText('meta.txt', txt))).toEqual([
      { type: 'Email', name: 'Brochure', message: 'Dear {name},\nthe brochure is attached.' },
      { type: 'Call', name: 'Opening', message: 'Good morning, this is {rm} from Amaya.' },
    ]);
  });
});

/* =========================== Normalisation & limits ========================= */

describe('placeholders', () => {
  it('rewrites known merge fields to app tokens and leaves the rest as typed', () => {
    const input = 'Hi {{ Customer Name }}, I am [RM], about your <Unit Type> — «FirstName» {Name} {{time}} [Time] {{date}} [Project] <b>x</b> [link](https://x.example) {{1}}';
    const out = normalisePlaceholders(input);
    expect(out).toBe('Hi {name}, I am {rm}, about your {unit} — {name} {name} {time} [Time] {{date}} [Project] <b>x</b> [link](https://x.example) {{1}}');
    expect(findUnfilledPlaceholders(out)).toEqual(['[Time]', '{{date}}', '[Project]', '{{1}}']);
    expect(findUnfilledPlaceholders('Hello {name}, {rm} here about {unit} at {time}.')).toEqual([]);
  });

  it('accepts the usual spellings of each placeholder', () => {
    expect(normalisePlaceholders('{{first_name}} [Customer’s Name] <Relationship Manager> [Your Name] {{agent}} [BHK] {flat type} [Unit No]')).toBe(
      '{name} {name} {rm} {rm} {rm} {unit} {unit} [Unit No]'
    );
  });
});

describe('types', () => {
  it('normalises channel spellings and keeps custom types', () => {
    const raw = ['whatsapp', 'WA', 'Whatsapp msg', 'email', 'E-mail', 'mail', 'SMS', 'sms text', 'call', 'Calling script', 'Phone', 'follow up', 'Follow-ups', 'site visit', '', '  ', 'brochure', 'NRI'];
    expect(raw.map((t) => normaliseTemplateType(t))).toEqual([
      'WhatsApp', 'WhatsApp', 'WhatsApp', 'Email', 'Email', 'Email', 'SMS', 'SMS', 'Call', 'Call', 'Call', 'Follow-up', 'Follow-up', 'Site Visit', 'WhatsApp', 'WhatsApp', 'Brochure', 'NRI',
    ]);
    expect(normaliseTemplateType('follow up', 'WhatsApp', ['Follow Up'])).toBe('Follow Up');
    expect(normaliseTemplateType('BROCHURE', 'WhatsApp', ['Brochure'])).toBe('Brochure');
    expect(normaliseTemplateType('', 'Email')).toBe('Email');
  });

  it('uses the default type option for unclassified templates', async () => {
    expect((await fromText('a.txt', 'Hello {name}', { defaultType: 'sms' }))[0].type).toBe('SMS');
  });
});

describe('limits and clean-up', () => {
  it(`caps a file at ${MAX_TEMPLATES_PER_FILE} templates and reports the total`, async () => {
    const csv = `Name,Message\n${Array.from({ length: 250 }, (_, i) => `T${i + 1},Message number ${i + 1}`).join('\n')}`;
    const res = await parseTemplateFileDetailed({ name: 'many.csv', bytes: strToU8(csv) });
    expect(res.templates).toHaveLength(MAX_TEMPLATES_PER_FILE);
    expect(res.totalFound).toBe(250);
    expect(res.warnings).toEqual([`Found 250 templates — only the first ${MAX_TEMPLATES_PER_FILE} are listed. Split the file to import the rest.`]);
  });

  it(`shortens messages to ${MAX_MESSAGE_LENGTH} characters without splitting an emoji`, async () => {
    const long = `${'a'.repeat(MAX_MESSAGE_LENGTH - 2)}😀${'b'.repeat(50)}`;
    const res = await parseTemplateFileDetailed({ name: 'long.csv', bytes: strToU8(`Name,Message\nLong,"${long}"`) });
    const msg = res.templates[0].message;
    expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(msg.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(msg)).toBe(false);
    expect(res.templates[0].notes).toContain('Shortened to 4,000 characters');
    expect(res.warnings).toContain('1 message was longer than 4,000 characters and has been shortened.');
  });

  it('collapses extra blank lines, trims spaces and drops duplicates within the file', async () => {
    const csv = 'Name,Message\nWelcome,"Hello {name}\u00A0 \n\n\n\nWelcome\t to Amaya   "\nWelcome,"Hello {name}\n\nWelcome to Amaya"\nEmpty,"   "\n';
    const res = await parseTemplateFileDetailed({ name: 'dupes.csv', bytes: strToU8(csv) });
    expect(core(res.templates)).toEqual([{ type: 'WhatsApp', name: 'Welcome', message: 'Hello {name}\n\nWelcome to Amaya' }]);
    expect(res.warnings).toEqual(['1 duplicate template was left out.']);
  });

  it('fingerprints templates case- and whitespace-insensitively for the "already exists" check', () => {
    expect(templateFingerprint(' Welcome ', 'Hello  {name}\n')).toBe(templateFingerprint('welcome', 'Hello {name}'));
    expect(templateFingerprint('Welcome', 'Hello {name}')).not.toBe(templateFingerprint('Welcome', 'Hello {rm}'));
  });
});

describe('unsupported files', () => {
  it('explains old Office formats, PDFs, damaged ZIPs and other packages', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(parseTemplateFile({ name: 'old.doc', bytes: ole })).rejects.toThrow(/Word 97–2003/);
    await expect(parseTemplateFile({ name: 'old.xls', bytes: ole })).rejects.toThrow(/Excel 97–2003/);
    await expect(parseTemplateFile({ name: 'scan.pdf', bytes: strToU8('%PDF-1.7\n…') })).rejects.toThrow(/PDF files/);
    await expect(parseTemplateFile({ name: 'broken.docx', bytes: new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]) })).rejects.toBeInstanceOf(TemplateImportError);
    await expect(parseTemplateFile({ name: 'archive.zip', bytes: zipSync({ 'hello.txt': strToU8('hi') }) })).rejects.toThrow(/isn’t a Word or Excel document/);
    await expect(parseTemplateFile({ name: 'photo.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]) })).rejects.toThrow(/isn’t supported/);
    await expect(parseTemplateFile({ name: 'empty.txt', bytes: new Uint8Array() })).rejects.toThrow('The file is empty.');
  });

  it('does not mistake text that starts with "PK" for a ZIP file', async () => {
    expect(core(await fromText('intro.txt', 'PK Reddy introduction\nHello {name}, this is PK from Amaya.'))).toEqual([
      { type: 'WhatsApp', name: 'PK Reddy introduction', message: 'Hello {name}, this is PK from Amaya.' },
    ]);
  });

  it('returns no templates (rather than failing) for a file without any text', async () => {
    const res = await parseTemplateFileDetailed({ name: 'blank.docx', bytes: docx(blank + blank) });
    expect(res.templates).toEqual([]);
  });
});
