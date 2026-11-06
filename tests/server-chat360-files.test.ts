/** WhatsApp attachments: only what WhatsApp takes, sent from a signed link, and only that file through the public route. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { settingSet } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { send, uploadWhatsappFile } from '../server/modules/chat360';
import { mediaSig } from '../server/modules/socialPosts';
import { saveFile } from '../server/modules/storage';
import { GET as mediaGET } from '../app/api/public/media/[companyId]/[fileId]/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
let bodies: any[] = [];
const ctx = { user: { name: 'Asha' } } as any;
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const b64 = (s: string) => Buffer.from(s).toString('base64');
const PDF = { name: 'Floor plan.pdf', mime: 'application/pdf', base64: b64('%PDF-1.4 test') };
const PNG = { name: 'view.png', mime: 'image/png', base64: b64('png-bytes') };

beforeAll(async () => {
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  delete process.env.APP_URL;
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { chat360: true });
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any = {}) => {
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ message_id: `wamid.${bodies.length}`, access_token: 'tok', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  await inCo(async () => {
    await t.secret('CHAT360_API_KEY', 'AbCd1234.secret');
    await t.secret('CHAT360_LOGIN_PASSWORD', 'pw');
    await settingSet('chat360BusinessNumber', '919000000000', 'test');
    await settingSet('chat360LoginEmail', 'a@b.example', 'test');
  });
});
afterEach(() => vi.unstubAllGlobals());

const sessionBody = () => bodies.find((b) => b.type && b.to);

describe('attachments', () => {
  it('sends a document by a signed link, with its name and caption', async () => {
    const up = await inCo(() => uploadWhatsappFile(PDF, ctx));
    expect(up.kind).toBe('document');
    const { message } = await inCo(() => send({ phone: '9876501234', text: 'Here it is', fileId: up.fileId }, ctx));
    const b = sessionBody();
    expect(b.type).toBe('document');
    expect(b.document).toMatchObject({ caption: 'Here it is', filename: 'Floor plan.pdf' });
    expect(b.document.link).toMatch(new RegExp(`^https://crm\\.example\\.com/api/public/media/CMP-test/${up.fileId}\\?sig=`));
    expect(message).toMatchObject({ messageType: 'document', mediaUrl: `/api/files/${up.fileId}` });
    expect(message.text).toBe('📄 Floor plan.pdf\nHere it is');
  });

  it('sends a photo as a photo, a caption being optional', async () => {
    const up = await inCo(() => uploadWhatsappFile(PNG, ctx));
    const { message } = await inCo(() => send({ phone: '9876501234', fileId: up.fileId }, ctx));
    const b = sessionBody();
    expect(b.type).toBe('image');
    expect(b.image.link).toContain(up.fileId);
    expect(b.image.caption).toBeUndefined();
    expect(b.image.filename).toBeUndefined();
    expect(message.messageType).toBe('image');
  });

  it('plain text still goes as before', async () => {
    await inCo(() => send({ phone: '9876501234', text: 'Hello' }, ctx));
    expect(sessionBody()).toMatchObject({ type: 'text', text: { body: 'Hello' } });
  });

  it('refuses what WhatsApp would not take, or too large a file', async () => {
    await expect(inCo(() => uploadWhatsappFile({ name: 'x.exe', mime: 'application/x-msdownload', base64: b64('x') }, ctx))).rejects.toThrow(/WhatsApp can send/);
    await expect(inCo(() => uploadWhatsappFile({ name: 'x.svg', mime: 'image/svg+xml', base64: b64('x') }, ctx))).rejects.toThrow(/WhatsApp can send/);
    await expect(inCo(() => uploadWhatsappFile({ ...PDF, base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') }, ctx))).rejects.toThrow(/3 MB/);
  });

  it('will not send some other file of the company', async () => {
    const other = await inCo(() => saveFile({ category: 'Lead documents', name: 'id.pdf', mime: 'application/pdf', data: Buffer.from('secret'), uploadedBy: 'x' }));
    await expect(inCo(() => send({ phone: '9876501234', fileId: other.fileId }, ctx))).rejects.toThrow(/Attach the file again/);
    await expect(inCo(() => send({ phone: '9876501234', fileId: '000000000000000000000000' }, ctx))).rejects.toThrow(/Attach the file again/);
    expect(sessionBody()).toBeUndefined();
  });
});

describe('the public link', () => {
  const open = (fileId: string, sig: string) => mediaGET(new Request(`https://crm.example.com/api/public/media/CMP-test/${fileId}?sig=${sig}`), { params: Promise.resolve({ companyId: 'CMP-test', fileId }) });

  it('serves the WhatsApp file with its signature, and nothing without it', async () => {
    const up = await inCo(() => uploadWhatsappFile(PDF, ctx));
    const ok = await open(up.fileId, mediaSig('CMP-test', up.fileId));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect((await open(up.fileId, 'wrong')).status).toBe(404);
  });

  it('still never serves other company files, even signed', async () => {
    const other = await inCo(() => saveFile({ category: 'Lead documents', name: 'id.pdf', mime: 'application/pdf', data: Buffer.from('secret'), uploadedBy: 'x' }));
    expect((await open(other.fileId, mediaSig('CMP-test', other.fileId))).status).toBe(404);
  });
});
