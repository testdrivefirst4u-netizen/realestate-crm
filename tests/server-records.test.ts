import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { listRecords, removeRecord, saveRecord } from '../server/modules/records';
import { col, getVersion } from '../server/core/db';
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

describe('records', () => {
  it('documents: create, update, list, delete; timeline entry; version bump', async () => {
    const ctx = await t.ctx('Admin', 'Asha');
    const v0 = await getVersion();
    const doc = await saveRecord('documents', { id: 'tmp_1', leadId: 'ENQ-0001', name: 'Agreement', category: 'Legal', fileUrl: 'https://drive.google.com/file/d/x' }, ctx);
    expect(doc.id).toBe('DOC-0001');
    expect(doc.uploadedBy).toBe('Asha');
    expect(doc.uploadedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await getVersion()).not.toBe(v0);
    const tl = await (await col(CFG.COLL.TIMELINE)).find({ leadId: 'ENQ-0001', type: 'document_added' }).toArray();
    expect(tl).toHaveLength(1);

    const upd = await saveRecord('documents', { ...doc, name: 'Agreement v2' }, ctx);
    expect(upd.id).toBe('DOC-0001');
    expect(upd.name).toBe('Agreement v2');
    expect(await listRecords('documents', ctx)).toHaveLength(1);

    await removeRecord('documents', 'DOC-0001', ctx);
    expect(await listRecords('documents', ctx)).toHaveLength(0);
    await expect(removeRecord('documents', 'DOC-0001', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('documents: fileUrl must be https or /api/files/<id>', async () => {
    const ctx = await t.ctx('Admin');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'http://example.com/a.pdf', '//evil.com/x', '/api/files/../secret', 'ftp://x/y']) {
      await expect(saveRecord('documents', { name: 'x', fileUrl: bad }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    const ok1 = await saveRecord('documents', { name: 'a', fileUrl: '/api/files/65f0c0ffee0000000000abcd' }, ctx);
    expect(ok1.fileUrl).toBe('/api/files/65f0c0ffee0000000000abcd');
    const ok2 = await saveRecord('documents', { name: 'b', fileUrl: 'https://example.com/b.pdf' }, ctx);
    expect(ok2.fileUrl).toBe('https://example.com/b.pdf');
    const ok3 = await saveRecord('documents', { name: 'c' }, ctx);
    expect(ok3.fileUrl).toBe('');
  });

  it('templates: shared, default type WhatsApp', async () => {
    const a = await t.ctx('Admin');
    const b = await t.ctx('RM');
    const tpl = await saveRecord('templates', { name: 'Hi', message: 'Hello {name}' }, a);
    expect(tpl.id).toBe('TPL-0001');
    expect(tpl.type).toBe('WhatsApp');
    const listB = await listRecords('templates', b);
    expect(listB).toHaveLength(1);
    expect(listB[0].message).toBe('Hello {name}');
  });

  it('notes and checklist are private to their owner', async () => {
    const a = await t.ctx('RM', 'Anil');
    const b = await t.ctx('RM', 'Bina');
    const v0 = await getVersion();
    const note = await saveRecord('notes', { id: 'tmp_x', text: 'call back Mr Rao' }, a);
    expect(note.id).toBe('NOTE-0001');
    expect(note.userId).toBe(a.user!.id);
    expect(note.created).not.toBe('');
    expect(await getVersion()).toBe(v0); // private records do not bump the shared version

    expect(await listRecords('notes', a)).toHaveLength(1);
    expect(await listRecords('notes', b)).toHaveLength(0);

    // B cannot edit or delete A's note, nor take it over by id
    await expect(saveRecord('notes', { id: note.id, text: 'hijack' }, b)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(removeRecord('notes', note.id, b)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await listRecords('notes', a))[0].text).toBe('call back Mr Rao');

    const edited = await saveRecord('notes', { id: note.id, text: 'done' }, a);
    expect(edited.text).toBe('done');
    expect(edited.userId).toBe(a.user!.id);

    const item = await saveRecord('checklist', { text: 'Send brochure', completed: true }, b);
    expect(item.id).toBe('CHK-0001');
    expect(item.completed).toBe(true);
    expect(await listRecords('checklist', a)).toHaveLength(0);
    expect(await listRecords('checklist', b)).toHaveLength(1);
    await expect(removeRecord('checklist', item.id, a)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await removeRecord('checklist', item.id, b);
    expect(await listRecords('checklist', b)).toHaveLength(0);

    await removeRecord('notes', note.id, a);
    expect(await listRecords('notes', a)).toHaveLength(0);
  });

  it('rejects unknown kinds and missing data', async () => {
    const ctx = await t.ctx('Admin');
    await expect(listRecords('bogus' as any, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveRecord('templates', null, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
