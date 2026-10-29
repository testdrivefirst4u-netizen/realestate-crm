/** POST /api/calls/recordings: the ticked calls' recordings in one ZIP, only calls the user may see. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';

let token = '';
let crossSite = false;
vi.mock('../server/core/request', () => ({ withRequestTenant: (fn: (b: { token: string }) => Promise<Response>) => fn({ token }), isSameOrigin: async () => !crossSite }));

import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { addLead } from '../server/modules/leads';
import { logCall, updateCall } from '../server/modules/calls';
import { saveFile } from '../server/modules/storage';
import { POST } from '../app/api/calls/recordings/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.1.1.3' };

async function signIn(name: string, role: 'Admin' | 'RM') {
  const email = name.toLowerCase().replace(/\s+/g, '.') + '@zip.test';
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  return (await login(email, 'long-enough-pw', base)).token;
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('https://crm.example/api/calls/recordings', { method: 'POST', headers: { 'content-type': 'application/json', host: 'crm.example', ...headers }, body: JSON.stringify(body) }));

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('bulk download of call recordings', () => {
  it('zips the recordings with readable names; leaves out calls the user may not see and calls without one', async () => {
    const adminToken = await signIn('Asha Admin', 'Admin');
    const asha = await t.ctx('Admin', 'Asha Admin');
    const { lead: mine } = await addLead({ 'Prospect Name': 'Meera Rao', 'Phone Number': '9000000001', 'Assigned RM': 'Ravi Rao' }, asha);
    const { lead: other } = await addLead({ 'Prospect Name': 'Kiran Das', 'Phone Number': '9000000002', 'Assigned RM': 'Someone Else' }, asha);
    const rec = async (leadId: string, name: string, audio: string) => {
      const call = await logCall({ leadId, customerName: name, phone: '9000000001', startTime: '2026-10-28T07:39:00.000Z' }, asha);
      const f = await saveFile({ leadId, category: 'Call Recordings', name: `${call.id}_recording.wav`, mime: 'audio/wav', data: Buffer.from(audio), uploadedBy: 'test' });
      await updateCall(call.id, { recordingFileId: f.fileId, recordingUrl: f.url }, asha);
      return call.id;
    };
    const a = await rec(String(mine['Enquiry ID']), 'Meera Rao', 'AUDIO-A');
    const b = await rec(String(other['Enquiry ID']), 'Kiran Das', 'AUDIO-B');
    const none = (await logCall({ leadId: String(mine['Enquiry ID']), customerName: 'Meera Rao' }, asha)).id;

    token = adminToken;
    const res = await post({ ids: [a, b, none] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="Call recordings \d{4}-\d{2}-\d{2}\.zip"/);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['Kiran Das 2026-10-28 13-09.wav', 'Meera Rao 2026-10-28 13-09.wav']); // company time (IST)
    expect(strFromU8(files['Meera Rao 2026-10-28 13-09.wav'])).toBe('AUDIO-A');

    // an agent only gets the calls of their own leads
    token = await signIn('Ravi Rao', 'RM');
    const mineOnly = unzipSync(new Uint8Array(await (await post({ ids: [a, b] })).arrayBuffer()));
    expect(Object.keys(mineOnly)).toEqual(['Meera Rao 2026-10-28 13-09.wav']);
  });

  it('refuses without a session, from another site, with nothing selected or too much at once', async () => {
    token = '';
    expect((await post({ ids: ['CALL-1'] })).status).toBe(401);
    token = await signIn('Asha Admin', 'Admin');
    crossSite = true;
    expect((await post({ ids: ['CALL-1'] })).status).toBe(403);
    crossSite = false;
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: Array.from({ length: 101 }, (_, i) => `CALL-${i}`) })).status).toBe(400);
    expect((await post({ ids: ['CALL-NONE'] })).status).toBe(404);
  });
});
