/** Release A, finding 7 — an independent export restores into an isolated database and verifies, media included. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GridFSBucket } from 'mongodb';
import { startTestDb } from './helpers/mongo';
import { exportDb, restoreInto, verifyRestore } from '../scripts/recovery-lib';
import { encryptSecret } from '../server/core/settings';

let t: Awaited<ReturnType<typeof startTestDb>>;
let dir = '';
beforeAll(async () => {
  t = await startTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-export-'));
});
afterAll(async () => {
  await t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('finding 7: isolated restore drill', () => {
  it('exports every collection and media, restores into a new database, and verifies counts, checksums, chunks and the key', async () => {
    const db = t.db;
    await db.collection('leads').insertMany([{ _id: 'ENQ-0001', name: 'Mrs Iyer', enquiryDate: new Date('2026-11-01') }, { _id: 'ENQ-0002', name: 'Mr Rao', milestones: { contacted: { at: new Date() } } }] as any);
    await db.collection('units').insertOne({ _id: 'INV-0001', unitNumber: 'A101', rev: 3 } as any);
    await db.collection('secrets').insertOne({ _id: 'CHAT360_API_KEY', value: encryptSecret('synthetic-test-value') } as any);
    const bucket = new GridFSBucket(db, { bucketName: 'files', chunkSizeBytes: 1024 });
    await new Promise((res, rej) => bucket.openUploadStream('rec.mp3').on('finish', res).on('error', rej).end(Buffer.alloc(5000, 7)));

    const m = await exportDb(db, dir);
    expect(m.collections.map((c) => c.name)).toEqual(expect.arrayContaining(['leads', 'units', 'secrets', 'files.files', 'files.chunks']));

    const client = (db as any).client;
    const target = client.db('restore_drill_test');
    const r = await restoreInto(target, dir);
    expect(r.documents).toBeGreaterThanOrEqual(2 + 1 + 1 + 1 + 5);
    const rep = await verifyRestore(target, dir, { encryptionKey: 'amaya-dev-only-key' });
    expect(rep.ok).toBe(true);
    expect(rep.media).toMatchObject({ files: 1, chunksOk: true });
    expect(rep.secrets).toEqual({ count: 1, decryptable: true });
    expect(await target.collection('leads').findOne({ _id: 'ENQ-0001' })).toMatchObject({ enquiryDate: new Date('2026-11-01') }); // dates stay dates

    // the wrong key is reported, not silently accepted
    expect((await verifyRestore(target, dir, { encryptionKey: 'not-the-key' })).secrets.decryptable).toBe(false);
    // a lost media chunk fails verification
    await target.collection('files.chunks').deleteOne({ n: 2 });
    expect((await verifyRestore(target, dir)).ok).toBe(false);
    // a non-empty target is refused (never restores over data)
    await expect(restoreInto(target, dir)).rejects.toThrow(/not empty/);
    await target.dropDatabase();
  });
});
