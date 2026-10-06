import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// leads.ts is implemented by another module; only its getLead() contract matters here.
vi.mock('../server/modules/leads', () => ({
  getLead: vi.fn(async (id: string) => (id === 'ENQ-0001' ? { 'Enquiry ID': 'ENQ-0001', 'Prospect Name': 'Mr Rao' } : null)),
}));

import { startTestDb } from './helpers/mongo';
import { listLeadFiles, readFile, sanitizeFilename, saveFile, uploadLeadFile } from '../server/modules/storage';
import { saveReportSnapshot, getReportSnapshot } from '../server/modules/reports';
import { listRecords } from '../server/modules/records';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';

let t: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('storage (GridFS)', () => {
  it('save/read roundtrip keeps bytes, mime, name and metadata', async () => {
    const data = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    const saved = await saveFile({ leadId: 'ENQ-0001', category: 'Documents', name: '../../etc/Agreement.pdf', mime: 'application/pdf', data, uploadedBy: 'Asha', description: 'signed' });
    expect(saved.fileId).toMatch(/^[a-f0-9]{24}$/);
    expect(saved.url).toBe(`/api/files/${saved.fileId}`);
    expect(saved.name).toBe('Agreement.pdf');
    expect(saved.size).toBe(7);
    const back = await readFile(saved.fileId);
    expect(back).not.toBeNull();
    expect(Buffer.compare(back!.data, data)).toBe(0);
    expect(back!.mime).toBe('application/pdf');
    expect(back!.name).toBe('Agreement.pdf');
    expect(back!.leadId).toBe('ENQ-0001');
    const meta: any = await (await col(`${CFG.COLL.FILES_BUCKET}.files`)).findOne({});
    expect(meta.metadata).toMatchObject({ leadId: 'ENQ-0001', category: 'Documents', uploadedBy: 'Asha', description: 'signed', mime: 'application/pdf' });

    expect(await readFile('nope')).toBeNull();
    expect(await readFile('65f0c0ffee0000000000abcd')).toBeNull();
  });

  it('rejects disallowed MIME types, empty files and oversize files', async () => {
    const base = { category: 'Documents', name: 'x', uploadedBy: 'A' };
    await expect(saveFile({ ...base, mime: 'application/x-msdownload', data: Buffer.from('MZ') })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveFile({ ...base, mime: 'application/javascript', data: Buffer.from('x') })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveFile({ ...base, mime: 'image/png', data: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'VALIDATION' });
    const big = Buffer.alloc(CFG.UPLOAD_MAX_BYTES + 1);
    await expect(saveFile({ ...base, mime: 'image/png', data: big })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await (await col(`${CFG.COLL.FILES_BUCKET}.files`)).countDocuments()).toBe(0);
  });

  it('sanitizes file names', () => {
    expect(sanitizeFilename('C:\\Users\\x\\photo.jpg')).toBe('photo.jpg');
    expect(sanitizeFilename('a<b>:"c|?.txt')).toBe('abc.txt');
    expect(sanitizeFilename('...hidden')).toBe('hidden');
    expect(sanitizeFilename('')).toMatch(/^file_\d+$/);
    expect(sanitizeFilename('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(180);
  });

  it('uploadLeadFile stores the file and creates a document record, timeline, event and audit', async () => {
    const ctx = await t.ctx('RM', 'Ravi');
    const content = Buffer.from('hello world');
    const doc = await uploadLeadFile({ leadId: 'ENQ-0001', category: 'Documents', name: 'id-proof.txt', mime: 'text/plain', base64: 'data:text/plain;base64,' + content.toString('base64'), description: 'Aadhaar' }, ctx);
    expect(doc.id).toBe('DOC-0001');
    expect(doc.leadId).toBe('ENQ-0001');
    expect(doc.category).toBe('Customer Document');
    expect(doc.driveFileId).toMatch(/^[a-f0-9]{24}$/);
    expect(doc.fileUrl).toBe(`/api/files/${doc.driveFileId}`);
    expect(doc.uploadedBy).toBe('Ravi');
    expect(doc.description).toBe('Aadhaar');

    const back = await readFile(doc.driveFileId);
    expect(back!.data.toString()).toBe('hello world');

    const files = await listLeadFiles('ENQ-0001');
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual(doc);
    expect(await listLeadFiles('ENQ-0002')).toEqual([]);
    expect(await listRecords('documents', ctx)).toHaveLength(1);

    expect(await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId: 'ENQ-0001', type: 'document_added' })).toBe(1);
    const ev: any = await (await col(CFG.COLL.EVENTS)).findOne({ type: 'document_uploaded' });
    expect(ev.title).toBe('Document uploaded for Mr Rao');
    expect(await (await col(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'File Uploaded' })).toBe(1);

    // a non-Documents category is kept as the document category
    const rec = await uploadLeadFile({ leadId: 'ENQ-0001', category: 'Call Recordings', name: 'call.mp3', mime: 'audio/mpeg', base64: Buffer.from([1, 2, 3]).toString('base64') }, ctx);
    expect(rec.category).toBe('Call Recordings');
  });

  it('uploadLeadFile validates lead, content and type', async () => {
    const ctx = await t.ctx('RM');
    const b64 = Buffer.from('x').toString('base64');
    await expect(uploadLeadFile({ leadId: '', category: '', name: 'a', mime: 'text/plain', base64: b64 }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(uploadLeadFile({ leadId: 'ENQ-9999', category: '', name: 'a', mime: 'text/plain', base64: b64 }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(uploadLeadFile({ leadId: 'ENQ-0001', category: '', name: 'a', mime: 'text/plain', base64: '' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(uploadLeadFile({ leadId: 'ENQ-0001', category: '', name: 'a.exe', mime: 'application/x-msdownload', base64: b64 }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await listLeadFiles('ENQ-0001')).toHaveLength(0);
  });
});

describe('report snapshots', () => {
  it('stores rows and returns a /api/reports url', async () => {
    const ctx = await t.ctx('Admin', 'Asha');
    const res: any = await saveReportSnapshot({ title: 'Monthly', range: 'Sep 2026', rows: [{ a: 1, 'b.c': '=SUM(1)' }, { a: 2, d: null }] }, ctx);
    expect(res.url).toMatch(/^\/api\/reports\/RPT_/);
    const snap = await getReportSnapshot(res.url.split('/').pop());
    expect(snap!.headers).toEqual(['a', 'b.c', 'd']);
    expect(snap!.rows).toEqual([[1, '=SUM(1)', ''], [2, '', '']]);
    expect(snap!.generatedBy).toBe('Asha');
    await expect(saveReportSnapshot({ title: 'x', range: '', rows: [] }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveReportSnapshot({ title: 'x', range: '', rows: new Array(50001).fill({ a: 1 }) }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
