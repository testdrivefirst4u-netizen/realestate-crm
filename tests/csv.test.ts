import { describe, it, expect } from 'vitest';
import {
  parseCsvText,
  detectDelimiter,
  mapHeaders,
  normalizeHeader,
  normalizeStage,
  normalizeImportDate,
  parseAndAnalyzeCSV,
  collectExportHeaders,
  buildLeadsCsv,
  generateSampleCSVTemplate,
  TEMPLATE_HEADERS,
  IMPORT_STRATEGIES,
  CSVService,
} from '../src/services/csvService';
import { DEFAULT_CONFIG, F, LEAD_BASE_HEADERS, STAGES } from '../src/core/config';
import { Lead } from '../src/types/crm';

const lead = (over: Partial<Lead>): Lead =>
  ({
    [F.ID]: 'ENQ-0001',
    [F.ENQUIRY_DATE]: '2026-09-01T04:30:00.000Z',
    [F.NAME]: 'Existing Person',
    [F.PHONE]: '+91 98490 12345',
    [F.EMAIL]: 'existing@example.com',
    [F.STAGE]: STAGES.WARM,
    [F.SOURCE]: 'Website',
    [F.UNIT_TYPE]: '2 BHK',
    [F.PURCHASE_OR_RENT]: 'Purchase',
    [F.SITE_VISIT_STATUS]: '',
    [F.NEXT_FOLLOWUP]: '',
    [F.NOTES]: '',
    [F.RM]: 'Rahul',
    [F.BROCHURE]: 'Yes',
    [F.RELATIONSHIP]: 'Self',
    [F.ENQUIRED_FOR]: 'Self',
    ...over,
  }) as Lead;

/* ------------------------------------------------------------------------ */

describe('parseCsvText — RFC-4180', () => {
  it('keeps a quoted multi-line cell (with commas and escaped quotes) as ONE cell', () => {
    const csv = 'Name,Notes,Phone\r\n"Ravi","line one\r\nline two, still notes\nsaid ""hello""","9849012345"\r\n"Sita","plain","9000000001"\r\n';
    const rows = parseCsvText(csv);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(['Ravi', 'line one\r\nline two, still notes\nsaid "hello"', '9849012345']);
    expect(rows[2]).toEqual(['Sita', 'plain', '9000000001']);
  });

  it('handles LF, CR, CRLF, a BOM and no trailing newline', () => {
    expect(parseCsvText('﻿a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsvText('a,b\rc,d\r')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsvText('a,b\r\nc,d\r\n\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('drops fully blank records but keeps empty cells positionally', () => {
    expect(parseCsvText('a,,c\n,,\n1,,3\n')).toEqual([['a', '', 'c'], ['1', '', '3']]);
  });

  it('auto-detects semicolon and tab delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(parseCsvText('a;b\n"1;x";2')).toEqual([['a', 'b'], ['1;x', '2']]);
    expect(parseCsvText('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

/* ------------------------------------------------------------------------ */

describe('mapHeaders — strict, exclusive column mapping', () => {
  it('normalises decoration in headers', () => {
    expect(normalizeHeader(' Mobile No.* ')).toBe('mobile no');
    expect(normalizeHeader('Next Follow-up Date')).toBe('next follow up date');
    expect(normalizeHeader('Last Follow-up Date & Time')).toBe('last follow up date & time');
  });

  it('maps "Mobile No." → Phone Number and does NOT map "Current City" to Purchase or Rent', () => {
    const m = mapHeaders(['Mobile No.', 'Name', 'Current City', 'Lead Stage']);
    expect(m.fieldToIndex[F.PHONE]).toBe(0);
    expect(m.fieldToIndex[F.NAME]).toBe(1);
    expect(m.fieldToIndex[F.STAGE]).toBe(3);
    expect(m.fieldToIndex[F.PURCHASE_OR_RENT]).toBeUndefined();
    expect(m.unmappedHeaders).toEqual(['Current City']);
    expect(m.mappings.find((x) => x.crmField === F.PHONE)).toEqual({ crmField: F.PHONE, csvHeader: 'Mobile No.', confidence: 'EXACT' });
    expect(m.mappings.find((x) => x.crmField === F.PURCHASE_OR_RENT)?.confidence).toBe('NONE');
  });

  it('matches phone-like headers and nothing else', () => {
    for (const h of ['Phone', 'phone number', 'Mobile', 'Contact', 'Contact No', 'Contact Number', 'WhatsApp', 'WhatsApp Number']) {
      expect(mapHeaders([h]).fieldToIndex[F.PHONE], h).toBe(0);
    }
    for (const h of ['Contact Name', 'Phonetic', 'Emergency', 'Contacted On']) {
      expect(mapHeaders([h]).fieldToIndex[F.PHONE], h).toBeUndefined();
    }
  });

  it('a generic "rep" header does not become Assigned RM, but "Sales Rep" does', () => {
    expect(mapHeaders(['rep']).fieldToIndex[F.RM]).toBeUndefined();
    expect(mapHeaders(['Sales Rep']).fieldToIndex[F.RM]).toBe(0);
    expect(mapHeaders(['Assigned RM']).fieldToIndex[F.RM]).toBe(0);
  });

  it('is exclusive: each column feeds at most one field, exact names win over fuzzy ones', () => {
    const headers = ['Site Visit Status', 'Status', 'Date', 'Next Follow-up Date', 'Visit Date', 'Follow-up 1', 'Follow-up 2'];
    const m = mapHeaders(headers);
    expect(m.fieldToIndex[F.SITE_VISIT_STATUS]).toBe(0);
    expect(m.fieldToIndex[F.STAGE]).toBe(1);
    expect(m.fieldToIndex[F.ENQUIRY_DATE]).toBe(2);
    expect(m.fieldToIndex[F.NEXT_FOLLOWUP]).toBe(3);
    expect(m.fieldToIndex[F.SITE_VISIT_DATE]).toBe(4);
    expect(m.followupToIndex).toEqual({ 'Follow-up 1': 5, 'Follow-up 2': 6 });
    const used = Object.values(m.fieldToIndex);
    expect(new Set(used).size).toBe(used.length);
    expect(m.unmappedHeaders).toEqual([]);
  });

  it('a blank header cell keeps its positional index so later columns do not shift', () => {
    const m = mapHeaders(['Name', '', 'Phone']);
    expect(m.fieldToIndex[F.NAME]).toBe(0);
    expect(m.fieldToIndex[F.PHONE]).toBe(2);
  });
});

/* ------------------------------------------------------------------------ */

describe('normalizeStage', () => {
  it('maps synonyms (case-insensitive) onto configured stages', () => {
    expect(normalizeStage('contacted')).toEqual({ stage: STAGES.OPEN, known: true });
    expect(normalizeStage('Site Visit Done')).toEqual({ stage: STAGES.QUALIFIED, known: true });
    expect(normalizeStage('HOT')).toEqual({ stage: STAGES.HOT, known: true });
    expect(normalizeStage('not responding')).toEqual({ stage: STAGES.NOT_RESPONDING, known: true });
    expect(normalizeStage('DQ - Budget')).toEqual({ stage: STAGES.DQ_BUDGET, known: true });
    expect(normalizeStage('disqualified – location')).toEqual({ stage: STAGES.DQ_LOCATION, known: true });
    expect(normalizeStage('booking done')).toEqual({ stage: STAGES.BOOKED, known: true });
  });

  it('leaves unknown values as typed and flags them; blank stays blank', () => {
    expect(normalizeStage('Lost / Dropped')).toEqual({ stage: 'Lost / Dropped', known: false });
    expect(normalizeStage('')).toEqual({ stage: '', known: true });
  });
});

/* ------------------------------------------------------------------------ */

describe('normalizeImportDate', () => {
  it('dd/MM/yyyy → ISO (midnight IST)', () => {
    expect(normalizeImportDate('01/10/2026')).toEqual({ iso: '2026-09-30T18:30:00.000Z', ok: true });
    expect(normalizeImportDate('01/10/2026 17:30')).toEqual({ iso: '2026-10-01T12:00:00.000Z', ok: true });
  });

  it('accepts Excel serials, ISO and the CRM display format', () => {
    expect(normalizeImportDate('46296')).toEqual({ iso: '2026-09-30T18:30:00.000Z', ok: true }); // 2026-10-01 in the sheet TZ
    expect(normalizeImportDate('2026-10-01T12:00:00.000Z').iso).toBe('2026-10-01T12:00:00.000Z');
    expect(normalizeImportDate('01 Oct 2026, 05:30 PM').iso).toBe('2026-10-01T12:00:00.000Z');
  });

  it('blank stays blank, garbage and short numbers are rejected (never defaulted to today)', () => {
    expect(normalizeImportDate('')).toEqual({ iso: '', ok: true });
    expect(normalizeImportDate('   ')).toEqual({ iso: '', ok: true });
    expect(normalizeImportDate('TBD')).toEqual({ iso: '', ok: false });
    expect(normalizeImportDate('12')).toEqual({ iso: '', ok: false });
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(normalizeImportDate('31/02/2026')).toEqual({ iso: '', ok: false });
    expect(normalizeImportDate('2026-02-30')).toEqual({ iso: '', ok: false });
    expect(normalizeImportDate('29/02/2028').ok).toBe(true); // leap year
    expect(normalizeImportDate('2026-10-01T20:00:00Z').iso).toBe('2026-10-01T20:00:00.000Z'); // zoned ISO is not day-checked
  });
});

/* ------------------------------------------------------------------------ */

describe('parseAndAnalyzeCSV', () => {
  const header = `${F.NAME},Mobile No.,${F.STAGE},${F.ENQUIRY_DATE},${F.NEXT_FOLLOWUP},${F.ID},Current City,Follow-up 1`;

  it('builds normalised leads, converts dd/MM/yyyy to ISO and leaves a blank Enquiry Date blank', () => {
    const csv = `${header}\nRavi Kumar,9849012345,contacted,01/10/2026,02/10/2026 10:00,,Hyderabad,"2026-09-30 11:00 — spoke"\nSita Devi,9000000001,,,,,Pune,\n`;
    const res = parseAndAnalyzeCSV(csv, []);
    expect(res.errors).toEqual([]);
    expect(res.totalRowsParsed).toBe(2);
    expect(res.validLeads).toHaveLength(2);
    const [ravi, sita] = res.validLeads;
    expect(ravi[F.NAME]).toBe('Ravi Kumar');
    expect(ravi[F.PHONE]).toBe('9849012345');
    expect(ravi[F.STAGE]).toBe(STAGES.OPEN);
    expect(ravi[F.ENQUIRY_DATE]).toBe('2026-09-30T18:30:00.000Z');
    expect(ravi[F.NEXT_FOLLOWUP]).toBe('2026-10-02T04:30:00.000Z');
    expect(ravi['Follow-up 1']).toBe('2026-09-30 11:00 — spoke');
    expect(ravi[F.ID]).toBe(''); // server assigns
    expect(sita[F.ENQUIRY_DATE]).toBe(''); // never "today"
    expect(sita[F.STAGE]).toBe(''); // server defaults to New on create, ignores blanks on overwrite
    expect(res.unmappedHeaders).toEqual(['Current City']);
    expect(res.followupColumns).toEqual(['Follow-up 1']);
    expect(res.previewRows[1].raw['Current City']).toBe('Pune');
  });

  it('flags duplicate phones within the file (same last 10 digits) and leaves them out of the payload', () => {
    const csv = `${header}\nRavi Kumar,9849012345,New,,,,,\nRavi Again,+91 98490 12345,Hot,,,,,\nSomeone Else,9000000002,New,,,,,\n`;
    const res = parseAndAnalyzeCSV(csv, []);
    expect(res.validLeads.map((l) => l[F.NAME])).toEqual(['Ravi Kumar', 'Someone Else']);
    expect(res.inFileDuplicates).toHaveLength(1);
    const dup = res.inFileDuplicates[0];
    expect(dup.status).toBe('DUPLICATE');
    expect(dup.rowIndex).toBe(3);
    expect(dup.duplicateOfRow).toBe(2);
    expect(dup.warnings[0]).toMatch(/Duplicate of row 2 .*phone/);
    expect(res.previewRows.map((r) => r.status)).toEqual(['NEW', 'DUPLICATE', 'NEW']);
  });

  it('flags duplicate Enquiry IDs within the file', () => {
    const existing = [lead({ [F.ID]: 'ENQ-0007', [F.PHONE]: '9111111111' })];
    const csv = `${header}\nA,9000000001,New,,,ENQ-0007,,\nB,9000000002,New,,,enq-0007,,\n`;
    const res = parseAndAnalyzeCSV(csv, existing);
    expect(res.previewRows.map((r) => r.status)).toEqual(['UPDATE', 'DUPLICATE']);
    expect(res.inFileDuplicates[0].warnings[0]).toMatch(/same Enquiry ID/);
  });

  it('detects conflicts with existing leads by Enquiry ID first, then phone — and never by email', () => {
    const existing = [
      lead({ [F.ID]: 'ENQ-0001', [F.PHONE]: '9849012345', [F.EMAIL]: 'a@example.com' }),
      lead({ [F.ID]: 'ENQ-0002', [F.PHONE]: '9000000009', [F.EMAIL]: 'b@example.com' }),
    ];
    const csv = `${F.NAME},Phone,${F.EMAIL},${F.ID}\nById,9333333333,x@example.com,ENQ-0002\nByPhone,+91 98490 12345,y@example.com,\nByEmailOnly,9444444444,b@example.com,\nUnknownId,9555555555,,LEAD-99\n`;
    const res = parseAndAnalyzeCSV(csv, existing);
    const [byId, byPhone, byEmail, unknownId] = res.previewRows;
    expect(byId.status).toBe('UPDATE');
    expect(byId.conflictReason).toBe('ID_MATCH');
    expect(byId.lead[F.ID]).toBe('ENQ-0002'); // kept so the server matches it
    expect(byPhone.status).toBe('UPDATE');
    expect(byPhone.conflictReason).toBe('PHONE_MATCH');
    expect(byPhone.matchedExisting?.[F.ID]).toBe('ENQ-0001');
    expect(byEmail.status).toBe('NEW');
    expect(byEmail.warnings.some((w) => w.includes('Email matches ENQ-0002'))).toBe(true);
    expect(unknownId.status).toBe('NEW');
    expect(unknownId.lead[F.ID]).toBe(''); // foreign IDs are never carried in
    expect(unknownId.warnings.some((w) => w.includes('LEAD-99'))).toBe(true);
    expect(res.conflicts).toHaveLength(2);
    expect(res.brandNewLeads).toHaveLength(2);
    expect(res.validLeads).toHaveLength(4);
  });

  it('flags unknown stages and unreadable dates, skips rows without a name', () => {
    const csv = `${header}\nNo Stage Match,9000000001,Lost / Dropped,31/02/2026,,,,\n,9000000002,New,,,,,\n`;
    const res = parseAndAnalyzeCSV(csv, []);
    expect(res.unknownStages).toEqual(['Lost / Dropped']);
    expect(res.previewRows[0].unknownStage).toBe(true);
    expect(res.previewRows[0].lead[F.STAGE]).toBe('Lost / Dropped');
    expect(res.previewRows[0].lead[F.ENQUIRY_DATE]).toBe('');
    expect(res.previewRows[0].warnings.some((w) => w.startsWith(`Could not read ${F.ENQUIRY_DATE}`))).toBe(true);
    expect(res.errors).toEqual([`Row 3: skipped — ${F.NAME} is empty.`]);
  });

  it('reports missing header / name column clearly', () => {
    expect(parseAndAnalyzeCSV('', []).errors[0]).toMatch(/header row/);
    expect(parseAndAnalyzeCSV('Name,Phone\n', []).errors[0]).toMatch(/header row/);
    const res = parseAndAnalyzeCSV('Phone,Email\n9849012345,a@b.co\n', []);
    expect(res.errors[0]).toMatch(new RegExp(`No "${F.NAME}" column`));
    expect(res.detectedHeaders).toEqual(['Phone', 'Email']);
  });

  it('exposes only server-supported strategies (MERGE is gone)', () => {
    expect(IMPORT_STRATEGIES.map((s) => s.id)).toEqual(['SKIP', 'OVERWRITE', 'CREATE_COPY']);
    expect((CSVService as any).resolveConflicts).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */

describe('export', () => {
  it('collects base headers, Follow-up N in numeric order, then extra sheet columns', () => {
    const leads = [
      lead({ 'Follow-up 10': 'x', 'Follow-up 2': 'y', Zebra: 'z', _row: 5 } as Partial<Lead>),
      lead({ 'Follow-up 1': 'a', Alpha: 'b' } as Partial<Lead>),
    ];
    const headers = collectExportHeaders(leads);
    expect(headers.slice(0, LEAD_BASE_HEADERS.length)).toEqual(LEAD_BASE_HEADERS);
    expect(headers.slice(LEAD_BASE_HEADERS.length)).toEqual(['Follow-up 1', 'Follow-up 2', 'Follow-up 10', 'Alpha', 'Zebra']);
  });

  it('writes a BOM, CRLF rows, quotes every cell and formats date fields for display', () => {
    const csv = buildLeadsCsv([lead({ [F.ENQUIRY_DATE]: '2026-10-01T12:00:00.000Z', [F.NOTES]: 'He said "ok", twice', 'Follow-up 1': 'f1' } as Partial<Lead>)]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(2);
    const headerCells = parseCsvText(lines[0])[0];
    const cells = parseCsvText(lines[1])[0];
    expect(cells[headerCells.indexOf(F.ENQUIRY_DATE)]).toBe('01 Oct 2026, 05:30 PM');
    expect(cells[headerCells.indexOf(F.NOTES)]).toBe('He said "ok", twice');
    expect(cells[headerCells.indexOf('Follow-up 1')]).toBe('f1');
    expect(lines[1]).toContain('"He said ""ok"", twice"');
  });

  it('an export re-imports with every base column mapped exactly', () => {
    const csv = buildLeadsCsv([lead({})]);
    const res = parseAndAnalyzeCSV(csv, []);
    expect(res.previewRows).toHaveLength(1);
    expect(res.unmappedHeaders).toEqual([F.CREATED_AT, F.UPDATED_AT, F.UPDATED_BY]);
    expect(res.columnMappings.every((m) => m.confidence === 'EXACT')).toBe(true);
    expect(res.previewRows[0].lead[F.ENQUIRY_DATE]).toBe('2026-09-01T04:30:00.000Z'); // display format round-trips
  });
});

/* ------------------------------------------------------------------------ */

describe('generateSampleCSVTemplate', () => {
  it('uses LEAD_BASE_HEADERS (minus audit columns) and only DEFAULT_CONFIG option values', () => {
    const csv = generateSampleCSVTemplate(new Date('2026-10-02T06:00:00.000Z'));
    const rows = parseCsvText(csv);
    expect(rows[0]).toEqual(TEMPLATE_HEADERS);
    const audit: string[] = [F.CREATED_AT, F.UPDATED_AT, F.UPDATED_BY];
    expect(TEMPLATE_HEADERS).toEqual(LEAD_BASE_HEADERS.filter((h) => !audit.includes(h)));
    expect(rows).toHaveLength(4);
    const idx = (h: string) => rows[0].indexOf(h);
    for (const r of rows.slice(1)) {
      expect(r[idx(F.ID)]).toBe('');
      expect(DEFAULT_CONFIG.options[F.STAGE]).toContain(r[idx(F.STAGE)]);
      expect(DEFAULT_CONFIG.options[F.SOURCE]).toContain(r[idx(F.SOURCE)]);
      expect(DEFAULT_CONFIG.options[F.UNIT_TYPE]).toContain(r[idx(F.UNIT_TYPE)]);
      expect(DEFAULT_CONFIG.options[F.SITE_VISIT_STATUS]).toContain(r[idx(F.SITE_VISIT_STATUS)]);
      expect(DEFAULT_CONFIG.options[F.BROCHURE]).toContain(r[idx(F.BROCHURE)]);
    }
    expect(rows[1][idx(F.ENQUIRY_DATE)]).toBe('2026-10-02 11:30'); // toSheetDateTime in IST
    const res = parseAndAnalyzeCSV(csv, []);
    expect(res.validLeads).toHaveLength(3);
    expect(res.errors).toEqual([]);
    expect(res.unknownStages).toEqual([]);
  });
});
