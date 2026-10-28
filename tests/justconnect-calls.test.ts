/**
 * JustConnect calls → CRM (step 2): webhook signatures, saving calls (once, linked to the lead and the RM), the
 * recording copy, the AI summary with Hot / Warm / Cold, missed-call notes, and the catch-up sync. JustConnect, the AI
 * and Web Push are faked.
 */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
vi.mock('../server/modules/ai', async (orig) => ({
  ...(await orig<typeof import('../server/modules/ai')>()),
  transcribeAudio: async () => ({ transcription: 'RM: Hello Meera. Customer: We want a 2.5 BHK for my parents, can we visit on Saturday?' }),
  generateText: async () => JSON.stringify({ summary: 'Wants a 2.5 BHK for her parents; visit on Saturday.', keyPoints: ['2.5 BHK', 'for parents'], followupActions: ['Confirm Saturday visit'], outcome: 'Site Visit Planned', temperature: 'Hot', temperatureReason: 'Asked to visit this Saturday.', nextFollowup: null }),
}));
const pushSent: Array<{ endpoint: string; body: any }> = [];
vi.mock('web-push', () => ({ default: { setVapidDetails: () => {}, sendNotification: async (sub: any, body: string) => { pushSent.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); return { statusCode: 201 }; } } }));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { setSecret, settingsAll } from '../server/core/settings';
import { updateProfile, type Ctx } from '../server/core/auth';
import { addLead, timelineForLead } from '../server/modules/leads';
import { pushSubscribe } from '../server/modules/push';
import { validJcSignature } from '../server/integrations/justconnect';
import { crmStatus, finishCall, ingestJcCall, jcMyCall, jcTranscriptText, syncJcCalls, type JcCall, type JcTranscript } from '../server/modules/jcCalls';
import { transcribe } from '../server/modules/calls';

const L = CFG.LEAD;
let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx, priya: Ctx;
let jcLog: JcCall[] = [];
const WAV = Buffer.from('RIFF....WAVEfmt fake audio');
/** What GET /call-logs/{id}/transcript answers (null = 404 no-transcript), and how often it was asked. */
let jcTranscript: JcTranscript | null = null;
let transcriptAsks = 0;
const JC_TRANSCRIPT: JcTranscript = {
  status: 'ready', languages: ['te-IN', 'en-IN'],
  lines: [{ speaker: 'agent', text: 'Namaste, Amaya nundi Priya.', atSeconds: 1.2, final: true }, { speaker: 'customer', text: 'We want to visit on Saturday.', atSeconds: 4.6, final: true }],
  text: 'Agent: Namaste, Amaya nundi Priya.\nCustomer: We want to visit on Saturday.',
};

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
  priya = await t.ctx('RM', 'Priya Sharma');
  pushSent.length = 0;
  jcLog = [];
  jcTranscript = null;
  transcriptAsks = 0;
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  await setSecret('JUSTCONNECT_API_KEY', 'jc_key', admin);
  const agents = [{ id: 'ag1', name: 'Priya S', role: 'agent', extension: '1002', email: priya.user!.email, loginId: 'P', status: 'online', canCallOut: true }];
  vi.stubGlobal('fetch', async (url: string) => {
    const u = new URL(url);
    const p = u.pathname.replace('/api/v1', '');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (p === '/agents') return json({ items: agents });
    if (p === '/outcomes') return json({ items: [{ code: 'INTERESTED', label: 'Interested' }] });
    if (p === '/call-logs') {
      const page = Number(u.searchParams.get('page') || 1);
      return json({ items: page === 1 ? jcLog : [], page, limit: 100, hasMore: false });
    }
    if (/\/call-logs\/[^/]+\/(recording|voicemail)$/.test(p)) return new Response(WAV, { status: 200, headers: { 'content-type': 'audio/wav', 'content-length': String(WAV.length) } });
    if (/\/call-logs\/[^/]+\/transcript$/.test(p)) {
      transcriptAsks++;
      return jcTranscript ? json({ transcript: jcTranscript }) : new Response(JSON.stringify({ error: 'No transcript.', code: 'no-transcript' }), { status: 404 });
    }
    return new Response('{}', { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const jcCall = (o: Partial<JcCall> = {}): JcCall => ({
  id: 'jc1', direction: 'outbound', status: 'answered', customer: '9876543210', businessNumber: '4012345678',
  agent: { id: 'ag1', name: 'Priya S', extension: '1002' }, rang: [], startedAt: '2026-10-26T09:00:00.000Z', answeredAt: '2026-10-26T09:00:08.000Z',
  endedAt: '2026-10-26T09:03:20.000Z', talkSeconds: 192, durationSeconds: 200, recording: { url: 'x' }, voicemail: null, outcome: 'INTERESTED', notes: 'Wants a visit', ref: null,
  updatedAt: '2026-10-26T09:04:00.000Z', ...o,
});
const crmCalls = async () => (await col<any>(CFG.COLL.CALLS)).find({ provider: 'JustConnect' }).toArray();

describe('webhook signature', () => {
  it('accepts JustConnect\'s HMAC of "<t>.<body>", refuses tampering and anything older than 5 minutes', () => {
    const body = '{"event":"call_log.ended"}';
    const now = 1_800_000_000;
    const sig = (t: number, b = body, key = 'whsec') => `t=${t},v1=${crypto.createHmac('sha256', key).update(`${t}.${b}`).digest('hex')}`;
    expect(validJcSignature(body, sig(now), 'whsec', now)).toBe(true);
    expect(validJcSignature(body + ' ', sig(now), 'whsec', now)).toBe(false);
    expect(validJcSignature(body, sig(now, body, 'other'), 'whsec', now)).toBe(false);
    expect(validJcSignature(body, sig(now - 301), 'whsec', now)).toBe(false);
    expect(validJcSignature(body, 'garbage', 'whsec', now)).toBe(false);
  });

  it('maps statuses', () => {
    expect(crmStatus({ status: 'answered', direction: 'outbound' })).toBe('Completed');
    expect(crmStatus({ status: 'missed', direction: 'inbound' })).toBe('Missed');
    expect(crmStatus({ status: 'missed', direction: 'outbound' })).toBe('No Answer');
    expect(crmStatus({ status: 'in-progress', direction: 'inbound' })).toBe('In Progress');
    expect(crmStatus({ status: 'voicemail', direction: 'inbound' })).toBe('Voicemail');
  });
});

describe('saving calls', () => {
  it('saves a call once, linked to the lead (our ref) and the RM behind the agent; later changes update it', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    const started = await ingestJcCall(jcCall({ status: 'in-progress', endedAt: null, talkSeconds: 0, ref: lead[L.ID], outcome: null }));
    expect(started).toMatchObject({ created: true, ended: false });
    let [c] = await crmCalls();
    expect(c).toMatchObject({ leadId: lead[L.ID], status: 'In Progress', direction: 'Outbound', loggedBy: 'Priya Sharma', providerCallId: 'jc1' });

    const ended = await ingestJcCall(jcCall({ ref: lead[L.ID] }));
    expect(ended).toMatchObject({ created: false, ended: true });
    const all = await crmCalls();
    expect(all).toHaveLength(1);
    c = all[0];
    expect(c).toMatchObject({ status: 'Completed', durationSec: 192, outcome: 'Interested', notes: 'Wants a visit' });
    expect(JSON.stringify(await timelineForLead(lead[L.ID]))).toContain('Call ended');
  });

  it('links by phone when there is no ref; internal calls and calls without a number are skipped', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Ravi', [L.PHONE]: '+91 98765 00002', [L.RM]: 'Priya Sharma' }, admin);
    await ingestJcCall(jcCall({ id: 'jc2', direction: 'inbound', customer: '09876500002' }));
    expect((await crmCalls())[0]).toMatchObject({ leadId: lead[L.ID], direction: 'Inbound' });
    expect((await ingestJcCall(jcCall({ id: 'jc3', direction: 'internal', customer: null }))).callId).toBe('');
    expect(await crmCalls()).toHaveLength(1);
  });
});

describe('after the call', () => {
  it('copies the recording into the CRM, then the AI writes the summary and Hot / Warm / Cold', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ ref: lead[L.ID] }));
    const r = await finishCall(callId);
    expect(r).toMatchObject({ recording: true, ai: true });
    const c = (await crmCalls())[0];
    expect(c.recordingFileId).toBeTruthy();
    expect(c.recordingUrl).toMatch(/^\/api\/files\//);
    expect(c).toMatchObject({ aiTemperature: 'Hot', aiTemperatureReason: 'Asked to visit this Saturday.', aiSummary: expect.stringContaining('2.5 BHK') });
    // runs once
    expect(await finishCall(callId)).toMatchObject({ recording: false, ai: false });
  });

  it('short calls are saved with the recording but not sent to the AI', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Quick', [L.PHONE]: '9876500005', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ id: 'jc5', customer: '9876500005', talkSeconds: 8, ref: lead[L.ID] }));
    expect(await finishCall(callId)).toMatchObject({ recording: true, ai: false });
  });

  it('a missed incoming call notifies the RM on their phone and asks for a call-back', async () => {
    await pushSubscribe({ subscription: { endpoint: 'https://push.example/p', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } }, priya);
    const { lead } = await addLead({ [L.NAME]: 'Missed One', [L.PHONE]: '9876500006', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ id: 'jc6', direction: 'inbound', status: 'missed', customer: '9876500006', agent: null, talkSeconds: 0, recording: null }));
    expect(await finishCall(callId)).toMatchObject({ missed: true });
    expect(pushSent[0].body).toMatchObject({ title: 'Missed call: Missed One', url: `/leads?lead=${lead[L.ID]}` });
    expect(JSON.stringify(await timelineForLead(lead[L.ID]))).toContain('Missed call — call back');
    expect(await finishCall(callId)).toMatchObject({ missed: false }); // once
  });
});

describe("JustConnect's transcripts", () => {
  it('builds the text from the lines when JustConnect sends none, and nothing while it is not ready', () => {
    expect(jcTranscriptText({ ...JC_TRANSCRIPT, text: '' })).toBe('Agent: Namaste, Amaya nundi Priya.\nCustomer: We want to visit on Saturday.');
    expect(jcTranscriptText({ ...JC_TRANSCRIPT, status: 'in-progress' })).toBe('');
    expect(jcTranscriptText(null)).toBe('');
  });

  it('call_log.transcribed: its transcript is saved on the call and the lead, then the AI summarises it (no audio sent to the AI)', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ ref: lead[L.ID], transcript: { url: 'x', status: 'ready', lines: 2 } }));
    expect(await finishCall(callId, { transcript: JC_TRANSCRIPT })).toMatchObject({ recording: true, ai: true });
    const c = (await crmCalls())[0];
    expect(c).toMatchObject({ transcript: JC_TRANSCRIPT.text, transcriptSource: 'JustConnect', aiTemperature: 'Hot', aiSummary: expect.stringContaining('2.5 BHK') });
    expect(c.transcriptFileId).toBeTruthy();
    expect(transcriptAsks).toBe(0); // it came in the event
    expect(JSON.stringify(await timelineForLead(lead[L.ID]))).toContain('Call transcript (JustConnect)');
    // a repeat delivery changes nothing
    expect(await finishCall(callId, { transcript: JC_TRANSCRIPT })).toMatchObject({ ai: false });
  });

  it('waits while JustConnect is still transcribing, then fetches it once the call says it is ready', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Wait', [L.PHONE]: '9876500007', [L.RM]: 'Priya Sharma' }, admin);
    const endedAt = new Date().toISOString();
    const { callId } = await ingestJcCall(jcCall({ id: 'jc7', customer: '9876500007', ref: lead[L.ID], endedAt, transcript: { url: 'x', status: 'in-progress', lines: 0 } }));
    expect(await finishCall(callId)).toMatchObject({ recording: true, ai: false }); // waits: no AI transcript of the audio
    expect((await crmCalls())[0].transcript || '').toBe('');
    jcTranscript = JC_TRANSCRIPT;
    await ingestJcCall(jcCall({ id: 'jc7', customer: '9876500007', ref: lead[L.ID], endedAt, transcript: { url: 'x', status: 'ready', lines: 2 } }));
    expect(await finishCall(callId)).toMatchObject({ ai: true });
    expect((await crmCalls())[0]).toMatchObject({ transcript: JC_TRANSCRIPT.text, transcriptSource: 'JustConnect' });
    expect(transcriptAsks).toBe(1);
  });

  it('no JustConnect transcript within 10 minutes (or transcription off): the AI transcribes the recording', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Late', [L.PHONE]: '9876500008', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ id: 'jc8', customer: '9876500008', ref: lead[L.ID], endedAt: new Date(Date.now() - 11 * 60_000).toISOString(), transcript: { url: 'x', status: 'in-progress', lines: 0 } }));
    expect(await finishCall(callId)).toMatchObject({ ai: true });
    expect((await crmCalls())[0]).toMatchObject({ transcript: expect.stringContaining('2.5 BHK'), transcriptSource: 'AI' });
  });

  it('"Transcribe & summarise" uses JustConnect\'s transcript first; "Re-transcribe" then asks the AI', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Manual', [L.PHONE]: '9876500009', [L.RM]: 'Priya Sharma' }, admin);
    const { callId } = await ingestJcCall(jcCall({ id: 'jc9', customer: '9876500009', ref: lead[L.ID], talkSeconds: 8 }));
    await finishCall(callId); // short call: recording only
    jcTranscript = JC_TRANSCRIPT;
    await transcribe(callId, admin);
    expect((await crmCalls())[0]).toMatchObject({ transcript: JC_TRANSCRIPT.text, transcriptSource: 'JustConnect' });
    await transcribe(callId, admin);
    expect((await crmCalls())[0]).toMatchObject({ transcript: expect.stringContaining('2.5 BHK'), transcriptSource: 'AI' });
  });
});

describe('catch-up sync', () => {
  it('pulls changed calls, finishes them, and remembers where it got to', async () => {
    await updateProfile(priya, { name: 'Priya Sharma' });
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    jcLog = [jcCall({ ref: lead[L.ID] }), jcCall({ id: 'jc9', direction: 'internal', customer: null, updatedAt: '2026-10-26T09:05:00.000Z' })];
    const r = await syncJcCalls({ deadline: Date.now() + 20000 });
    expect(r).toMatchObject({ saved: 1, created: 1 });
    expect(r.finished).toBe(1);
    expect((await settingsAll()).jcCallsCursor).toBe('2026-10-26T09:05:00.000Z');
    // again: nothing new
    expect(await syncJcCalls({ deadline: Date.now() + 20000 })).toMatchObject({ created: 0 });
    expect(await crmCalls()).toHaveLength(1);
  });

  it('does nothing without a key', async () => {
    await setSecret('JUSTCONNECT_API_KEY', '', admin);
    expect(await syncJcCalls()).toMatchObject({ skipped: 'not connected' });
  });
});

describe('call window (jcMyCall)', () => {
  const inbound = (o: Partial<JcCall> = {}) => jcCall({ id: 'in1', direction: 'inbound', status: 'in-progress', agent: null, rang: [], answeredAt: null, endedAt: null, talkSeconds: 0, recording: null, outcome: null, notes: null, ...o });

  it('an incoming call rings → is answered → ends, for the person whose phone rang, and nobody else', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    await ingestJcCall(inbound(), undefined, { id: 'ag1', name: 'Priya S' });
    expect(await jcMyCall({}, priya)).toMatchObject({ phase: 'ringing', direction: 'Inbound', leadId: lead[L.ID], customerName: 'Meera Kapoor' });
    expect(await jcMyCall({}, admin)).toBeNull();

    await ingestJcCall(inbound({ agent: { id: 'ag1', name: 'Priya S' }, answeredAt: '2026-10-26T09:00:08.000Z' }));
    expect(await jcMyCall({}, priya)).toMatchObject({ phase: 'live', answeredAt: '2026-10-26T09:00:08.000Z' });

    await ingestJcCall(inbound({ status: 'answered', agent: { id: 'ag1', name: 'Priya S' }, answeredAt: '2026-10-26T09:00:08.000Z', talkSeconds: 95, recording: { url: 'x' } }));
    const done = await jcMyCall({}, priya);
    expect(done).toMatchObject({ phase: 'ended', status: 'Completed', durationSec: 95, aiPending: true });
    // asked by id later (waiting for the AI): still there
    await (await col<any>(CFG.COLL.CALLS)).updateOne({ _id: done!.id }, { $set: { jcLiveAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await jcMyCall({}, priya)).toBeNull();
    expect(await jcMyCall({ id: done!.id }, priya)).toMatchObject({ id: done!.id, phase: 'ended' });
    expect(await jcMyCall({ id: done!.id }, admin)).toBeNull();
  });

  it('a call a colleague picked up leaves my window', async () => {
    const ravi = await t.ctx('RM', 'Ravi Rao');
    await ingestJcCall(inbound(), undefined, { id: 'ag1', name: 'Priya S' });
    // the ring group rang Priya; Ravi took the call
    await (await col<any>(CFG.COLL.CALLS)).updateOne({ providerCallId: 'in1' }, { $set: { jcAgentUserId: ravi.user!.id, jcAnsweredAt: '2026-10-26T09:00:08.000Z' } });
    expect(await jcMyCall({}, priya)).toBeNull();
    expect(await jcMyCall({}, ravi)).toMatchObject({ phase: 'live' });
  });

  it('an outgoing call from the CRM is "ringing" (customer being rung) until answered', async () => {
    await ingestJcCall(jcCall({ id: 'out1', status: 'in-progress', answeredAt: null, endedAt: null, talkSeconds: 0, recording: null, outcome: null }));
    expect(await jcMyCall({}, priya)).toMatchObject({ phase: 'ringing', direction: 'Outbound' });
  });
});

describe('a caller who is not a lead yet', () => {
  it('keeps the recording and AI notes, and they move onto the lead when that number becomes a lead', async () => {
    const { callId } = await ingestJcCall(jcCall({ id: 'new1', direction: 'inbound', customer: '9123456789', agent: { id: 'ag1', name: 'Priya S' } }));
    expect((await crmCalls())[0]).toMatchObject({ leadId: '' });
    expect(await finishCall(callId)).toMatchObject({ recording: true, ai: true });
    let c = (await crmCalls())[0];
    expect(c.recordingFileId).toBeTruthy();
    expect(c.aiSummary).toContain('2.5 BHK');
    const meta = async () => (await (await col<any>(CFG.COLL.FILES_BUCKET + '.files')).findOne({}, { sort: { uploadDate: 1 } }))?.metadata;
    expect((await meta()).leadId).toBe('');

    const { lead } = await addLead({ [L.NAME]: 'New Caller', [L.PHONE]: '+91 91234 56789', [L.RM]: 'Priya Sharma' }, admin);
    c = (await crmCalls())[0];
    expect(c).toMatchObject({ leadId: lead[L.ID], customerName: 'New Caller' });
    expect((await meta()).leadId).toBe(lead[L.ID]);
    expect(c.transcriptFileId).toBeTruthy();
    const tl = JSON.stringify(await timelineForLead(lead[L.ID]));
    expect(tl).toContain('Incoming call');
    expect(tl).toContain('AI call summary');
  });
});

describe('live call buttons and the phone inside the CRM', () => {
  const sent: Array<{ method: string; path: string; body: any }> = [];
  const PHONE = { agent: { id: 'ag1', name: 'Priya S', extension: '1002' }, websocketUrl: 'wss://pbx.justconnect.biz:8089/ws', domain: 'pbx.justconnect.biz', username: 'jc2_p', password: 'secret-pw', uri: 'sip:jc2_p@pbx.justconnect.biz', displayName: 'Priya S', callerIds: [{ number: '4012345678', label: 'Main' }] };
  let phone: any = PHONE;
  let refuse: { status: number; code?: string } | null = null;
  beforeEach(() => {
    sent.length = 0;
    phone = PHONE;
    refuse = null;
    const agents = [
      { id: 'ag1', name: 'Priya S', role: 'agent', extension: '1002', email: priya.user!.email, loginId: 'P', status: 'online', canCallOut: true },
      { id: 'ag2', name: 'Ravi R', role: 'agent', extension: '1003', email: 'ravi@x.test', loginId: 'R', status: 'break', canCallOut: true },
    ];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const p = new URL(url).pathname.replace('/api/v1', '');
      const method = init.method || 'GET';
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (p === '/agents') return json({ items: agents });
      if (p === '/outcomes') return json({ items: [] });
      sent.push({ method, path: p, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (refuse) return json({ error: 'Refused', code: refuse.code }, refuse.status);
      if (/\/agents\/[^/]+\/phone$/.test(p)) return json({ phone });
      if (/\/agents\/[^/]+\/status$/.test(p)) return json({ agent: { id: 'ag1', status: JSON.parse(String(init.body)).status } });
      if (/\/transfer$/.test(p)) return json({ to: { type: 'agent', name: 'Ravi R', extension: '1003' }, call: {} }, 202);
      if (/\/(end|mute|unmute)$/.test(p)) return json({ call: {} }, 202);
      return json({}, 404);
    });
  });

  const liveCall = async () => {
    const { callId } = await ingestJcCall(jcCall({ id: 'live1', direction: 'inbound', status: 'in-progress', answeredAt: '2026-10-26T09:00:08.000Z', endedAt: null, talkSeconds: 0, recording: null, outcome: null }), undefined, { id: 'ag1', name: 'Priya S' });
    return callId;
  };

  it('ends, mutes and transfers my own call through JustConnect; not a colleague\'s', async () => {
    const { jcCallControl } = await import('../server/modules/justconnect');
    const id = await liveCall();
    expect(await jcCallControl({ callId: id, action: 'mute' }, priya)).toEqual({ ok: true, muted: true });
    expect(await jcMyCall({}, priya)).toMatchObject({ muted: true });
    expect(await jcCallControl({ callId: id, action: 'transfer', to: '1003' }, priya)).toMatchObject({ ok: true, to: 'Ravi R' });
    expect(await jcCallControl({ callId: id, action: 'transfer', to: '+91 98765 00000' }, priya)).toMatchObject({ ok: true });
    expect(await jcCallControl({ callId: id, action: 'end' }, priya)).toEqual({ ok: true });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /call-logs/live1/mute', 'POST /call-logs/live1/transfer', 'POST /call-logs/live1/transfer', 'POST /call-logs/live1/end']);
    expect(sent[1].body).toEqual({ to: '1003' });
    expect(sent[2].body).toEqual({ to: '9876500000' });
    // somebody else's call: not found, nothing sent
    sent.length = 0;
    await expect(jcCallControl({ callId: id, action: 'end' }, admin)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(jcCallControl({ callId: id, action: 'hack' }, priya)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(sent).toEqual([]);
  });

  it('explains JustConnect refusals, including a key without calls:control', async () => {
    const { jcCallControl } = await import('../server/modules/justconnect');
    const id = await liveCall();
    refuse = { status: 409, code: 'agent-busy' };
    await expect(jcCallControl({ callId: id, action: 'transfer', to: '1003' }, priya)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('another call') });
    refuse = { status: 403 };
    await expect(jcCallControl({ callId: id, action: 'end' }, priya)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('calls:control') });
    // an ended call is refused before asking JustConnect
    await (await col<any>(CFG.COLL.CALLS)).updateOne({ _id: id }, { $set: { status: 'Completed' } });
    sent.length = 0;
    await expect(jcCallControl({ callId: id, action: 'end' }, priya)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(sent).toEqual([]);
  });

  it('status: reads mine, sets online / break / offline for my agent only', async () => {
    const { jcMyStatus, jcSetMyStatus, jcTransferTargets } = await import('../server/modules/justconnect');
    expect(await jcMyStatus(priya)).toEqual({ agent: { name: 'Priya S', extension: '1002', status: 'online', canCallOut: true } });
    expect(await jcSetMyStatus({ status: 'break' }, priya)).toEqual({ status: 'break' });
    expect(sent[0]).toMatchObject({ method: 'PUT', path: `/agents/${encodeURIComponent(priya.user!.email)}/status`, body: { status: 'break' } });
    await expect(jcSetMyStatus({ status: 'on-call' }, priya)).rejects.toMatchObject({ code: 'VALIDATION' });
    // colleagues to hand a call to: everybody but me
    expect((await jcTransferTargets(priya)).map((a) => a.name)).toEqual(['Ravi R']);
  });

  it('phone login: my own agent\'s, only on JustConnect\'s secure socket', async () => {
    const { jcMyPhone } = await import('../server/modules/justconnect');
    expect(await jcMyPhone(priya)).toMatchObject({ websocketUrl: PHONE.websocketUrl, uri: PHONE.uri, password: 'secret-pw', extension: '1002', domain: 'pbx.justconnect.biz' });
    expect(sent[0].path).toBe(`/agents/${encodeURIComponent(priya.user!.email)}/phone`);
    phone = { ...PHONE, websocketUrl: 'wss://evil.example.com/ws' };
    await expect(jcMyPhone(priya)).rejects.toMatchObject({ code: 'SERVER' });
    phone = { ...PHONE, websocketUrl: 'ws://pbx.justconnect.biz/ws' };
    await expect(jcMyPhone(priya)).rejects.toMatchObject({ code: 'SERVER' });
    refuse = { status: 403 };
    await expect(jcMyPhone(priya)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('phones:connect') });
    // a user set to "never call through JustConnect"
    await (await col<any>(CFG.COLL.USERS)).updateOne({ _id: admin.user!.id }, { $set: { jcAgent: 'none' } });
    await expect(jcMyPhone(admin)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
