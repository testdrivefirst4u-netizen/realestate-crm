import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { buildXlsx, colName, excelSerialToText, readXlsxRows, rowsToCsv } from '../src/core/xlsx';
import { buildLeadExportTable } from '../src/services/csvService';

describe('xlsx writer / reader', () => {
  it('names columns like Excel', () => {
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it('round-trips text exactly — long phone numbers, symbols, Indic text, new lines', () => {
    const headers = ['Enquiry ID', 'Phone Number', 'Notes'];
    const rows = [
      ['ENQ-0001', '919676847969', 'Price < ₹1.38 Cr & "2BHK"\nCall back Sunday'],
      ['ENQ-0002', '', 'హైదరాబాద్'],
    ];
    const back = readXlsxRows(buildXlsx(headers, rows));
    expect(back).toEqual([headers, ...rows.map((r) => r.map(String))]);
  });

  it('reads shared strings, numbers and date-formatted cells from a workbook made elsewhere', () => {
    const files = {
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Name</t></si><si><t>Enquiry Date</t></si><si><r><t>Asha </t></r><r><t>Rao</t></r></si></sst>'),
      'xl/styles.xml': strToU8('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Phone</t></is></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46304</v></c><c r="C2"><v>9876543210</v></c></row>' +
          '<row r="4"><c r="C4"><v>1</v></c></row>' +
          '</sheetData></worksheet>'
      ),
    };
    const rows = readXlsxRows(zipSync(files));
    expect(rows[0]).toEqual(['Name', 'Enquiry Date', 'Phone']);
    expect(rows[1]).toEqual(['Asha Rao', '2026-10-09', '9876543210']);
    expect(rows[2]).toEqual([]); // the gap row stays so row numbers line up
    expect(rows[3]).toEqual(['', '', '1']);
  });

  it('converts Excel serial dates, with and without time', () => {
    expect(excelSerialToText(46304)).toBe('2026-10-09');
    expect(excelSerialToText(46304.75)).toBe('2026-10-09 18:00');
  });

  it('refuses files that are not workbooks with a readable message', () => {
    expect(() => readXlsxRows(strToU8('Name,Phone\nAsha,98765'))).toThrow(/not a valid \.xlsx/);
  });

  it('rows → CSV quotes only where needed', () => {
    expect(rowsToCsv([['a', 'b,c'], ['x "y"', 'line\nbreak', 'z']])).toBe('a,"b,c",\r\n"x ""y""","line\nbreak",z');
  });
});

describe('full lead export table', () => {
  it('has every CRM and extra column, the follow-up count and one date + text column pair per remark', () => {
    const leads: any[] = [
      { 'Enquiry ID': 'ENQ-0001', 'Prospect Name': 'Asha', 'Phone Number': '919676847969', City: 'Hyderabad', Campaign: 'Video_Sept2026', 'Follow-up 1': '2026-10-01 10:00 — Called, no answer', 'Follow-up 2': '2026-10-03 16:30 — Interested in 2BHK' },
      { 'Enquiry ID': 'ENQ-0002', 'Prospect Name': 'Ravi', 'Budget Range': '1 Cr' },
    ];
    const { headers, rows } = buildLeadExportTable(leads);
    for (const h of ['Enquiry ID', 'Prospect Name', 'Phone Number', 'Enquiry Notes', 'Assigned RM', 'City', 'Campaign', 'Budget Range', 'Follow-ups', 'Remark 1 Date', 'Remark 1', 'Remark 2 Date', 'Remark 2']) {
      expect(headers).toContain(h);
    }
    expect(headers.some((h) => /^Follow-up \d+$/.test(h))).toBe(false);
    const col = (h: string) => headers.indexOf(h);
    expect(rows[0][col('Phone Number')]).toBe('919676847969');
    expect(rows[0][col('Follow-ups')]).toBe('2');
    expect(rows[0][col('Remark 2')]).toBe('Interested in 2BHK');
    expect(rows[0][col('Remark 1 Date')]).toMatch(/01 Oct 2026/);
    expect(rows[1][col('Budget Range')]).toBe('1 Cr');
    expect(rows[1][col('Follow-ups')]).toBe('0');
    expect(rows.every((r) => r.length === headers.length)).toBe(true);
  });
});
