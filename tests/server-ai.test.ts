/** AI (Gemini) module: chat passthrough hardening, quota, retry/fallback, reframe, lead summary. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/modules/leads', () => ({
  findLeadByPhone: vi.fn(async () => null),
  getLead: vi.fn(async () => null),
  addLead: vi.fn(),
  updateLead: vi.fn(),
  actions: {},
}));
vi.mock('../server/modules/storage', () => ({ saveFile: vi.fn(), readFile: vi.fn(), actions: {} }));
vi.mock('../server/modules/records', () => ({ saveRecord: vi.fn(), actions: {} }));

import { startTestDb } from './helpers/mongo';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { settingSet } from '../server/core/settings';
import type { Ctx } from '../server/core/auth';
import * as leads from '../server/modules/leads';
import { chat, reframe, summarizeLead, test as aiTest, transcribeAudio, generateText, AI_USAGE_COLL } from '../server/modules/ai';

let t: Awaited<ReturnType<typeof startTestDb>>;
let ctx: Ctx;

const okResp = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 3 } }), { status: 200 });
const errResp = (code: number, message = 'busy') => new Response(JSON.stringify({ error: { code, message } }), { status: code });
const modelOf = (url: unknown) => decodeURIComponent((String(url).match(/models\/([^:]+):/) || [])[1] || '');

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  process.env.GEMINI_API_KEY = 'gem-key';
  delete process.env.AI_DAILY_LIMIT;
  await settingSet('aiModel', 'gemini-3.8-flash', 'test');
  await settingSet('aiFastModel', 'gemini-3.5-flash-lite', 'test');
  ctx = await t.ctx('RM');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('aiChat', () => {
  it('passes contents/tools/systemInstruction through, uses the key header, clamps tokens and ignores unknown models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp('hello'));
    const tools = [{ functionDeclarations: [{ name: 'searchLeads', description: 'x', parameters: { type: 'OBJECT', properties: {} } }] }];
    const res = await chat({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: 'be nice', tools, toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      model: 'gemini-9-ultra-expensive', generationConfig: { maxOutputTokens: 100000, temperature: 0.5, bogus: 1 },
    }, ctx);
    expect(res.model).toBe('gemini-3.8-flash');
    expect(res.candidates[0].content.parts[0].text).toBe('hello');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect((init.headers as any)['x-goog-api-key']).toBe('gem-key');
    expect(url).not.toContain('key=');
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
    expect(body.generationConfig.temperature).toBe(0.5);
    expect(body.generationConfig.bogus).toBeUndefined();
    expect(body.tools).toEqual(tools);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(body.systemInstruction.parts[0].text).toBe('be nice');
  });

  it('accepts the configured fast model when requested', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp('ok'));
    const res = await chat({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], model: 'gemini-3.5-flash-lite' }, ctx);
    expect(res.model).toBe('gemini-3.5-flash-lite');
    expect(modelOf(fetchMock.mock.calls[0][0])).toBe('gemini-3.5-flash-lite');
  });

  it('fails NOT_CONFIGURED without a key and VALIDATION for bad / oversized input', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    delete process.env.GEMINI_API_KEY;
    await expect(chat({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    process.env.GEMINI_API_KEY = 'gem-key';
    await expect(chat({ contents: [] }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    const huge = 'x'.repeat(210 * 1024);
    await expect(chat({ contents: [{ role: 'user', parts: [{ text: huge }] }] }, ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces the per-user daily quota atomically', async () => {
    process.env.AI_DAILY_LIMIT = '2';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResp('ok'));
    const req = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    await chat(req, ctx);
    await chat(req, ctx);
    await expect(chat(req, ctx)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    const usage = await (await col(AI_USAGE_COLL)).findOne({ userId: ctx.user!.id });
    expect(usage!.count).toBe(3);
    // another user is unaffected
    const other = await t.ctx('RM');
    await expect(chat(req, other)).resolves.toBeTruthy();
  });

  it('retries a 503 once, then falls back to the next model and reports it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (modelOf(url) === 'gemini-3.8-flash' ? errResp(503) : okResp('from fallback')));
    const res = await chat({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, ctx);
    expect(res.model).toBe('gemini-3.7-flash');
    expect(fetchMock.mock.calls.map((c) => modelOf(c[0]))).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.7-flash']);
  });

  it('moves to the next model immediately on 404 and surfaces a non-transient error', async () => {
    let fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (modelOf(url) === 'gemini-3.8-flash' ? errResp(404, 'not found') : okResp('ok')));
    const res = await chat({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, ctx);
    expect(res.model).toBe('gemini-3.7-flash');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(errResp(400, 'API key not valid'));
    await expect(chat({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('other AI actions', () => {
  it('reframe uses the fast model and falls back to the input on an empty answer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp('Spoke to Mr Rao.')).mockResolvedValueOnce(okResp(''));
    expect((await reframe('spoke to mr rao', ctx)).result).toBe('Spoke to Mr Rao.');
    expect(modelOf(fetchMock.mock.calls[0][0])).toBe('gemini-3.5-flash-lite');
    expect((await reframe('as is', ctx)).result).toBe('as is');
    await expect(reframe('   ', ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('transcribeAudio sends inline audio to the transcription model and validates the input', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp('namaste'));
    const r = await transcribeAudio('data:audio/ogg;base64,' + Buffer.from('abc').toString('base64'), 'audio/ogg', ctx);
    expect(r.transcription).toBe('namaste');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(modelOf(fetchMock.mock.calls[0][0])).toBe(CFG.SETTING_DEFAULTS.aiTranscribeModel);
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'audio/ogg', data: Buffer.from('abc').toString('base64') });
    await expect(transcribeAudio('', 'audio/ogg', ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(transcribeAudio('abcd', 'text/html', ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('generateText supports JSON mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp('{"a":1}'));
    expect(await generateText('give json', ctx, { json: true, maxOutputTokens: 99999 })).toBe('{"a":1}');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('summarizeLead includes the lead and its timeline, and audits', async () => {
    vi.mocked(leads.getLead).mockResolvedValue({ 'Enquiry ID': 'ENQ-0001', 'Prospect Name': 'Meera Rao', 'Lead Stage': 'Warm', 'Phone Number': '+919876543210' });
    await (await col(CFG.COLL.TIMELINE)).insertOne({ _id: 'TL_1' as any, leadId: 'ENQ-0001', timestamp: new Date(), type: 'remark', title: 'Asked about 2 BHK', details: 'wants ground floor', actor: 'RM', refType: '', refId: '' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp('- Warm lead\nRecommended next step: call'));
    const r = await summarizeLead('ENQ-0001', ctx);
    expect(r.summary).toContain('Recommended next step');
    const prompt = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).contents[0].parts[0].text;
    expect(prompt).toContain('Meera Rao');
    expect(prompt).toContain('Asked about 2 BHK: wants ground floor');
    expect(await (await col(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'AI Lead Summary' })).toBe(1);
    vi.mocked(leads.getLead).mockResolvedValue(null);
    await expect(summarizeLead('ENQ-404', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('test() tries only the configured model and reports failures as ok:false', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(errResp(404, 'nope'));
    const r = await aiTest();
    expect(r.ok).toBe(false);
    expect(r.model).toBe('gemini-3.8-flash');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
