/** Project Library: the built-in library rebuilds exactly; admins save the company's own copy, everyone reads it. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login } from '../server/core/auth';
import { PROJECT_DOCUMENTS } from '../src/documents/projectDocuments';
import { buildDocuments, defaultLibrary } from '../src/documents/projectLibrary';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.1.1.2' };
const tokens: Record<string, string> = {};

async function signIn(name: string, role: 'Admin' | 'Manager' | 'RM' | 'Viewer') {
  const email = name.toLowerCase() + '@library.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  tokens[name] = (await login(email, 'long-enough-pw', base)).token;
}
const as = async (who: string, action: string, data: any = {}) => (await dispatch(action, data, { ...base, token: tokens[who] })).body as any;

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
  await signIn('Ravi', 'RM');
  await signIn('Fiona', 'Viewer');
});

describe('project library', () => {
  it('the built-in library, turned into the editable shape and back, is unchanged', () => {
    const rebuilt = buildDocuments(defaultLibrary());
    expect(rebuilt).toEqual(PROJECT_DOCUMENTS.map((d) => ({ ...d })));
  });

  it('nothing saved = built-in; an admin saves, everyone reads it; others cannot save; restore goes back', async () => {
    expect((await as('Ravi', 'libraryGet')).data.content).toBeNull();

    const content = defaultLibrary();
    content.sections[0].items.push('New point: show flat ready by March');
    content.documents[0].chapters[0].passages.push({ text: 'A new passage about <b>Amaya</b>.', tags: [] });
    content.documents[1].downloadUrl = 'javascript:alert(1)';
    content.documents.push({ ...content.documents[0], id: 'brochure', title: 'Second brochure' });

    expect((await as('Meera', 'librarySave', { content })).status).toBe('error');
    expect((await as('Ravi', 'librarySave', { content })).status).toBe('error');
    expect((await as('Fiona', 'librarySave', { content })).status).toBe('error');

    const saved = await as('Asha', 'librarySave', { content });
    expect(saved.status).toBe('success');
    expect(saved.data.updatedBy).toBe('Asha');

    const read = (await as('Fiona', 'libraryGet')).data;
    expect(read.content.sections[0].items).toContain('New point: show flat ready by March');
    expect(read.content.documents[0].chapters[0].passages.at(-1).text).toBe('A new passage about <b>Amaya</b>.');
    expect(read.content.documents[1].downloadUrl).toBe(''); // unsafe link dropped
    expect(read.content.documents.map((d: any) => d.id).filter((id: string) => id.startsWith('brochure'))).toEqual(['brochure', 'brochure-2']);

    expect((await as('Asha', 'librarySave', { content: { documents: [{ title: '' }], sections: [] } })).status).toBe('error');
    expect((await as('Asha', 'librarySave', { content: null })).status).toBe('success');
    expect((await as('Ravi', 'libraryGet')).data.content).toBeNull();
  });
});

describe('library editors', () => {
  it('an admin names editors; a named manager can save, others cannot; only admins see or change the list', async () => {
    const content = defaultLibrary();
    content.sections[0].items.push('Edited by a library editor');

    expect((await as('Meera', 'libraryGet')).data).toMatchObject({ canEdit: false });
    expect((await as('Meera', 'libraryGet')).data.editors).toBeUndefined();
    expect((await as('Asha', 'libraryGet')).data).toMatchObject({ canEdit: true, editors: [] });

    expect((await as('Meera', 'librarySetEditors', { emails: ['meera@library.test'] })).status).toBe('error');
    expect((await as('Asha', 'librarySetEditors', { emails: ['nobody@library.test'] })).status).toBe('error');
    const set = await as('Asha', 'librarySetEditors', { emails: ['Meera@Library.test'] });
    expect(set.status).toBe('success');
    expect(set.data.editors).toEqual(['meera@library.test']);

    expect((await as('Meera', 'libraryGet')).data.canEdit).toBe(true);
    const saved = await as('Meera', 'librarySave', { content });
    expect(saved.status).toBe('success');
    expect(saved.data.updatedBy).toBe('Meera');
    expect((await as('Ravi', 'librarySave', { content })).status).toBe('error');
    expect((await as('Ravi', 'libraryGet')).data.canEdit).toBe(false);

    await as('Asha', 'librarySetEditors', { emails: [] });
    expect((await as('Meera', 'librarySave', { content })).status).toBe('error');
  });
});

describe('saving over someone else', () => {
  it('a save based on an older library is refused; one based on the latest goes through', async () => {
    const content = defaultLibrary();
    const first = await as('Asha', 'librarySave', { content, baseUpdatedAt: '' });
    expect(first.status).toBe('success');
    // someone else saves after Asha opened the editor
    expect((await as('Asha', 'librarySave', { content, baseUpdatedAt: first.data.updatedAt })).status).toBe('success');
    const stale = await as('Asha', 'librarySave', { content, baseUpdatedAt: first.data.updatedAt });
    expect(stale).toMatchObject({ status: 'error', code: 'CONFLICT' });
    // nothing saved yet is also a version: a second "first save" is refused
    await as('Asha', 'librarySave', { content: null });
    expect((await as('Asha', 'librarySave', { content, baseUpdatedAt: '' })).status).toBe('success');
    expect((await as('Asha', 'librarySave', { content, baseUpdatedAt: '' }))).toMatchObject({ code: 'CONFLICT' });
  });
});
