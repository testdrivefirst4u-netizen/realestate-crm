/** Calls: logging, updates, lead matching, telephony webhook (dedupe, no auto-transcribe), recordings, transcription + summary. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/modules/leads', () => ({
  findLeadByPhone: vi.fn(async () => null),
  getLead: vi.fn(async () => null),
  addLead: vi.fn(),
  updateLead: vi.fn(async () => ({ lead: {}, version: '1' })),
  actions: {},
}));
vi.mock('../server/modules/storage', () => ({
  saveFile: vi.fn(async (o: any) => ({ fileId: 'F' + o.name.length, url: '/api/files/F' + o.name.length, size: o.data.length, mime: o.mime, name: o.name })),
  readFile: vi.fn(async () => null),
  actions: {},
}));
vi.mock('../server/modules/records', () => ({ saveRecord: vi.fn(async () => ({})), actions: {} }));

import { startTestDb } from './helpers/mongo';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { settingSet } from '../server/core/settings';
import type { Ctx } from '../server/core/auth';
import * as leads from '../server/modules/leads';
import * as storage from '../server/modules/storage';
import * as records from '../server/modules/records';
import { actions, handleWebhook, listCalls, logCall, summarize, transcribe, updateCall, uploadRecording } from '../server/modules/calls';
import { POST as telephonyPOST } from '../app/api/webhooks/telephony/route';

let t: Awaited<ReturnType<typeof startTestDb>>;
let ctx: Ctx;
const LEAD = { 'Enquiry ID': 'ENQ-0007', 'Prospect Name': 'Meera Rao', 'Phone Number': '+919876543210', 'Assigned RM': 'Asha', 'Lead Stage': 'Warm', 'Unit Type Interested In': '2 BHK' };
const gemini = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });
const SUMMARY = JSON.stringify({ summary: 'Meera wants a 2 BHK.', keyPoints: ['2 BHK', 'Budget 1 Cr'], followupActions: ['Send brochure'], outcome: 'Interested', nextFollowup: '2026-10-10T11:00:00+05:30' });

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  vi.mocked(leads.getLead).mockReset().mockImplementation(async (id: string) => (id === 'ENQ-0007' ? LEAD : null));
  vi.mocked(leads.findLeadByPhone).mockReset().mockImplementation(async (p: string) => (String(p).replace(/\D/g, '').endsWith('9876543210') ? LEAD : null));
  vi.mocked(leads.updateLead).mockClear();
  vi.mocked(storage.saveFile).mockClear();
  vi.mocked(storage.readFile).mockReset().mockResolvedValue(null);
  vi.mocked(records.saveRecord).mockClear();
  await settingSet('telephonyFieldMap', CFG.SETTING_DEFAULTS.telephonyFieldMap, 'test');
  process.env.GEMINI_API_KEY = 'gem-key';
  await t.company();
  await t.secret('TELEPHONY_WEBHOOK_SECRET', 'tel-secret');
  ctx = await t.ctx('RM', 'Ravi');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('logging & updates', () => {
  it('logs a call against a lead with a CALL-00001 id, timeline, event and audit', async () => {
    const call = await logCall({ leadId: 'ENQ-0007', startTime: '2026-10-01T10:00:00Z', endTime: '2026-10-01T10:05:00Z', outcome: 'Interested' }, ctx);
    expect(call).toMatchObject({ id: 'CALL-00001', leadId: 'ENQ-0007', customerName: 'Meera Rao', phone: '+919876543210', durationSec: 300, status: 'Completed', direction: 'Outbound', provider: 'Manual', loggedBy: 'Ravi', callDate: '2026-10-01T10:00:00.000Z' });
    expect((await logCall({ phone: '9000000000' }, ctx)).id).toBe('CALL-00002');
    const doc: any = await (await col(CFG.COLL.CALLS)).findOne({ _id: 'CALL-00001' as any });
    expect(doc.startTime).toBeInstanceOf(Date);
    expect(await (await col(CFG.COLL.TIMELINE)).countDocuments({ leadId: 'ENQ-0007', type: 'call' })).toBe(1);
    expect(await (await col(CFG.COLL.EVENTS)).countDocuments({ type: 'call_logged' })).toBe(1);
    expect(await (await col(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Call Logged' })).toBe(2);
    await expect(logCall({}, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('ending an in-progress call computes duration, completes it and notifies once', async () => {
    const call = await logCall({ leadId: 'ENQ-0007', startTime: '2026-10-01T10:00:00Z' }, ctx);
    expect(call.status).toBe('In Progress');
    expect(await (await col(CFG.COLL.EVENTS)).countDocuments({ type: 'call_logged' })).toBe(0);
    const ended = await updateCall(call.id, { endTime: '2026-10-01T10:02:30Z', outcome: 'Callback' }, ctx);
    expect(ended).toMatchObject({ status: 'Completed', durationSec: 150, outcome: 'Callback' });
    expect(await (await col(CFG.COLL.EVENTS)).countDocuments({ type: 'call_logged' })).toBe(1);
    await expect(updateCall('CALL-99999', {}, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('browser patches cannot set stored-file references', async () => {
    const call = await logCall({ leadId: 'ENQ-0007' }, ctx);
    const updated: any = await actions.updateCall.fn({ id: call.id, data: { recordingFileId: 'someone-elses-file', notes: 'ok' } }, ctx);
    expect(updated.recordingFileId).toBe('');
    expect(updated.notes).toBe('ok');
  });

  it('lists calls newest first and suggests a lead for unlinked calls by phone', async () => {
    vi.mocked(leads.findLeadByPhone).mockResolvedValueOnce(null); // logCall lookup → stays unlinked
    await logCall({ phone: '+91 98765 43210', startTime: '2026-10-02T10:00:00Z' }, ctx);
    await logCall({ leadId: 'ENQ-0007', startTime: '2026-10-01T10:00:00Z' }, ctx);
    const all = await listCalls();
    expect(all.map((c) => c.id)).toEqual(['CALL-00001', 'CALL-00002']);
    expect(all[0]).toMatchObject({ leadId: '', matchedLeadId: 'ENQ-0007', matchedName: 'Meera Rao', matchedRM: 'Asha' });
    expect((await listCalls('ENQ-0007')).map((c) => c.id)).toEqual(['CALL-00002']);
  });
});

describe('telephony webhook', () => {
  it('creates, then updates the same provider call (dedupe on provider + id) without transcribing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const r1: any = await handleWebhook({ call_id: 'abc', from: '+919876543210', to: '04012345678', direction: 'incoming', start_time: '2026-10-01T10:00:00Z', status: 'ringing' }, 'zoho');
    expect(r1.callId).toBe('CALL-00001');
    const c1: any = (await listCalls())[0];
    expect(c1).toMatchObject({ direction: 'Inbound', leadId: 'ENQ-0007', provider: 'zoho', providerCallId: 'abc', loggedBy: 'zoho' });

    const r2: any = await handleWebhook({ call_id: 'abc', end_time: '2026-10-01T10:03:00Z', duration: '180', status: 'completed', recording_url: 'https://voice.zoho.in/rec/abc.mp3' }, 'zoho');
    expect(r2).toEqual({ ok: true, callId: 'CALL-00001', updated: true });
    const c2: any = (await listCalls())[0];
    expect(c2).toMatchObject({ status: 'Completed', durationSec: 180, recordingUrl: 'https://voice.zoho.in/rec/abc.mp3', transcript: '' });
    expect(fetchMock).not.toHaveBeenCalled();

    // same id from another provider is a different call
    const r3: any = await handleWebhook({ call_id: 'abc', from: '9123456789', direction: 'Outgoing', to: '9876543210' }, 'exotel');
    expect(r3.callId).toBe('CALL-00002');
    expect((await listCalls()).find((c) => c.id === 'CALL-00002')).toMatchObject({ direction: 'Outbound', phone: '9876543210' });
    expect(await handleWebhook({ call_id: 'zzz' }, 'zoho')).toEqual({ ok: true, ignored: 'no-phone' });
  });

  it('uses the telephonyFieldMap setting', async () => {
    await settingSet('telephonyFieldMap', JSON.stringify({ callId: 'CallSid', from: 'From', to: 'To', direction: 'Direction', status: 'CallStatus' }), 'test');
    await handleWebhook({ CallSid: 'CA1', From: '9876543210', To: '4000', Direction: 'inbound', CallStatus: 'no-answer' }, 'twilio');
    expect((await listCalls())[0]).toMatchObject({ providerCallId: 'CA1', status: 'No Answer', direction: 'Inbound' });
  });

  it('route authenticates with header or query secret and passes ?provider=', async () => {
    const body = JSON.stringify({ call_id: 'r1', from: '9876543210', direction: 'inbound' });
    const mk = (url: string, h: Record<string, string> = {}) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body });
    expect((await telephonyPOST(mk('http://x/api/webhooks/telephony?company=test&provider=zoho'))).status).toBe(403);
    expect((await telephonyPOST(mk('http://x/api/webhooks/telephony?company=test&provider=zoho&secret=bad'))).status).toBe(403);
    const ok = await telephonyPOST(mk('http://x/api/webhooks/telephony?company=test&provider=zoho', { 'x-webhook-secret': 'tel-secret' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'success', data: { ok: true, callId: 'CALL-00001' } });
    const again = await telephonyPOST(mk('http://x/api/webhooks/telephony?company=test&provider=zoho&secret=tel-secret'));
    expect((await again.json()).data.updated).toBe(true);
    expect((await listCalls())[0].provider).toBe('zoho');
  });
});

describe('recordings, transcription & summary', () => {
  it('uploads a recording to storage and records it as a document', async () => {
    const call = await logCall({ leadId: 'ENQ-0007' }, ctx);
    const updated = await uploadRecording({ callId: call.id, name: 'rec.mp3', mime: 'audio/mpeg', base64: 'data:audio/mpeg;base64,' + Buffer.from('ID3audio').toString('base64') }, ctx);
    const opts = vi.mocked(storage.saveFile).mock.calls[0][0];
    expect(opts).toMatchObject({ leadId: 'ENQ-0007', category: 'Call Recordings', name: 'rec.mp3', mime: 'audio/mpeg', uploadedBy: 'Ravi' });
    expect(opts.data.toString()).toBe('ID3audio');
    expect(updated).toMatchObject({ recordingFileId: 'F7', recordingUrl: '/api/files/F7' });
    expect(vi.mocked(records.saveRecord).mock.calls[0][0]).toBe('documents');
    const unlinked = await logCall({ phone: '9000000000' }, ctx);
    await expect(uploadRecording({ callId: unlinked.id, name: 'a', mime: 'audio/mpeg', base64: 'AA==' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('transcribes a stored recording, then summarises into AI Summary / Key Points / Follow-up Actions', async () => {
    const call = await logCall({ leadId: 'ENQ-0007' }, ctx);
    await updateCall(call.id, { recordingFileId: 'F1' }, ctx);
    vi.mocked(storage.readFile).mockResolvedValue({ data: Buffer.from('audio'), mime: 'audio/mpeg', name: 'r.mp3', size: 5 });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(gemini('Hello this is Meera')).mockResolvedValueOnce(gemini(SUMMARY));
    const out = await transcribe(call.id, ctx);
    expect(out).toMatchObject({
      transcript: 'Hello this is Meera', aiSummary: 'Meera wants a 2 BHK.', keyPoints: ['2 BHK', 'Budget 1 Cr'], followupActions: ['Send brochure'], outcome: 'Interested',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const audioBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(audioBody.contents[0].parts[0].inlineData).toEqual({ mimeType: 'audio/mpeg', data: Buffer.from('audio').toString('base64') });
    expect(vi.mocked(storage.saveFile).mock.calls.some((c) => c[0].category === 'Call Transcripts')).toBe(true);
    expect(leads.updateLead).toHaveBeenCalledWith('ENQ-0007', { 'Next Follow-up Date': '2026-10-10T05:30:00.000Z' }, ctx);
    const types = (await (await col(CFG.COLL.TIMELINE)).find({ leadId: 'ENQ-0007' }).toArray()).map((r: any) => r.type);
    expect(types).toEqual(expect.arrayContaining(['call_transcript', 'call_summary']));
  });

  it('summarize requires a transcript', async () => {
    const call = await logCall({ leadId: 'ENQ-0007' }, ctx);
    await expect(summarize(call.id, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(transcribe(call.id, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('only fetches provider recordings over https from allow-listed hosts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const url of ['https://evil.example.com/a.mp3', 'http://voice.zoho.in/a.mp3', 'https://zoho.in.evil.com/a.mp3', 'https://169.254.169.254/latest']) {
      const c = await logCall({ leadId: 'ENQ-0007', recordingUrl: url }, ctx);
      await expect(transcribe(c.id, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // redirect to a non-allowed host is refused
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }));
    const r = await logCall({ leadId: 'ENQ-0007', recordingUrl: 'https://voice.zoho.in/r.mp3' }, ctx);
    await expect(transcribe(r.id, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });

    // oversize declared length is refused
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'content-length': String(26 * 1024 * 1024), 'content-type': 'audio/mpeg' } }));
    await expect(transcribe(r.id, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });

    // allowed: downloads, keeps a copy, transcribes, summarises
    fetchMock
      .mockResolvedValueOnce(new Response(Buffer.from('mp3data'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
      .mockResolvedValueOnce(gemini('transcript text'))
      .mockResolvedValueOnce(gemini(SUMMARY));
    const out = await transcribe(r.id, ctx);
    expect(out.transcript).toBe('transcript text');
    expect(out.recordingUrl).toMatch(/^\/api\/files\//);
    expect(fetchMock.mock.calls.at(-3)![0]).toBe('https://voice.zoho.in/r.mp3');
  });
});
