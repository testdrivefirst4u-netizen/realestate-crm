/** Ad conversions: lead results go to the company's Meta dataset once per lead and event, hashed, with retries. */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { addLead, updateLead } from '../server/modules/leads';
import { inboundCol } from '../server/modules/intake';
import { getAdConversions, normalisePhone, saveAdConversions, sendDue, sendRecentAdConversions, testAdConversion } from '../server/modules/adConversions';
import { dispatch } from '../server/router';
import type { Ctx } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;
const TOKEN = 'EAAB' + 'x'.repeat(60);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const fetchMock = vi.fn();
const sentBodies = () => fetchMock.mock.calls.map((c) => JSON.parse(String(c[1].body)));
const metaOk = () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'x' }), { status: 200 });
const queue = () => inCo(async () => (await col<any>(CFG.COLL.CONVERSIONS)).find({}).sort({ _id: 1 }).toArray());

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { adConversions: true });
  admin = await t.ctx('Admin', 'Asha');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => metaOk());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const turnOn = (extra: Record<string, unknown> = {}) => inCo(() => saveAdConversions({ enabled: true, datasetId: '1234567890123456', token: TOKEN, ...extra }, admin));
const newLead = (fields: Record<string, string> = {}) =>
  inCo(async () => (await addLead({ 'Prospect Name': 'Ravi', 'Phone Number': '98765 01234', Email: ' Ravi@Example.com ', ...fields } as any, null)).id);
const move = (id: string, patch: Record<string, string>) => inCo(() => updateLead(id, patch as any, null));

describe('settings', () => {
  it('validates, keeps the token write-only, and refuses to switch on without dataset and token', async () => {
    await expect(inCo(() => saveAdConversions({ enabled: true }, admin))).rejects.toThrow(/dataset ID and the access token/);
    await expect(inCo(() => saveAdConversions({ datasetId: 'abc' }, admin))).rejects.toThrow(/is a number/);
    await expect(inCo(() => saveAdConversions({ testCode: 'hello' }, admin))).rejects.toThrow(/TEST12345/);
    await expect(inCo(() => saveAdConversions({ rules: [{ event: 'A', when: 'stage', value: 'Hot' }, { event: 'a', when: 'stage', value: 'Booked' }] }, admin))).rejects.toThrow(/once/);
    const v = await turnOn();
    expect(v).toMatchObject({ enabled: true, datasetId: '1234567890123456', tokenSet: true });
    expect(v.rules.map((r) => r.event)).toEqual(['Qualified', 'Site Visit Done', 'Booked']);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    const raw = await inCo(async () => (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'metaCapi' }));
    expect(JSON.stringify(raw)).not.toContain(TOKEN); // stored encrypted
  });

  it('is hidden when the Super Admin switch is off', async () => {
    await t.company('test', { adConversions: false });
    const r = await dispatch('getAdConversions', {}, { token: admin.token!, userAgent: 'vitest', ip: '1.1.1.1', companyId: 'CMP-test' });
    expect(r.status).toBe(403);
  });

  it('a test event carries the test code', async () => {
    await turnOn();
    await expect(inCo(() => testAdConversion({}, admin))).rejects.toThrow(/test code/);
    expect(await inCo(() => testAdConversion({ testCode: 'TEST4321' }, admin))).toMatchObject({ ok: true });
    expect(sentBodies()[0]).toMatchObject({ test_event_code: 'TEST4321', data: [{ event_name: 'Qualified', action_source: 'system_generated' }] });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/graph\.facebook\.com\/v[\d.]+\/1234567890123456\/events$/);
  });
});

describe('sending', () => {
  it('a lead reaching Qualified is sent once, hashed; going back and forth does not send it again', async () => {
    await turnOn();
    const id = await newLead();
    await move(id, { 'Lead Stage': 'Qualified' });
    await vi.waitFor(async () => expect((await queue())[0]?.status).toBe('sent'));
    const body = sentBodies()[0];
    expect(body.data[0]).toMatchObject({
      event_name: 'Qualified',
      action_source: 'system_generated',
      user_data: { ph: [sha('919876501234')], em: [sha('ravi@example.com')] },
      custom_data: { event_source: 'crm', lead_event_source: 'BroaddCast CRM' },
    });
    expect(JSON.stringify(body)).not.toContain('9876501234');
    expect(JSON.stringify(body)).not.toContain('ravi@example.com');
    await move(id, { 'Lead Stage': 'Hot' });
    await move(id, { 'Lead Stage': 'Qualified' });
    await inCo(() => sendDue());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await queue())[0]).toMatchObject({ matchedBy: 'phone + e-mail' });
  });

  it('a walk-in counts as Site Visit Done; stages without an event send nothing; switched off sends nothing', async () => {
    await turnOn();
    const id = await newLead();
    await move(id, { 'Lead Stage': 'Hot' });
    await move(id, { 'Site Visit Status': 'Site Visit - Walk-In' });
    await vi.waitFor(async () => expect((await queue()).map((q) => q.event)).toEqual(['Site Visit Done']));
    await inCo(() => saveAdConversions({ enabled: false }, admin));
    await move(id, { 'Lead Stage': 'Booked', 'Booking Date': '2026-11-01' });
    expect((await queue()).map((q) => q.event)).toEqual(['Site Visit Done']);
  });

  it('a Facebook lead form enquiry sends Meta its own lead id', async () => {
    await turnOn();
    const id = await newLead();
    await inCo(async () => (await inboundCol()).insertOne({ _id: 'INB_1', sourceId: 'SRC-0001', receivedAt: new Date(), status: 'created', leadId: id, message: '', payload: {}, ip: '', origin: 'meta', idempotencyKey: 'meta:123456789012345' }));
    await move(id, { 'Lead Stage': 'Qualified' });
    await vi.waitFor(async () => expect((await queue())[0]?.status).toBe('sent'));
    expect(sentBodies()[0].data[0].user_data.lead_id).toBe(123456789012345);
    expect((await queue())[0].matchedBy).toBe('Facebook lead + phone + e-mail');
  });

  it('a refused event is retried later; after 7 days it is given up', async () => {
    await turnOn();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), { status: 400 }));
    const id = await newLead();
    await move(id, { 'Lead Stage': 'Qualified' });
    await vi.waitFor(async () => expect((await queue())[0]?.status).toBe('failed'));
    const failed = (await queue())[0];
    expect(failed.error).toMatch(/Invalid OAuth/);
    expect(failed.nextAt.getTime()).toBeGreaterThan(Date.now());
    // not due yet: nothing happens
    expect(await inCo(() => sendDue())).toEqual({});
    fetchMock.mockImplementation(async () => metaOk());
    expect(await inCo(() => sendDue({ now: new Date(Date.now() + 3600e3) }))).toEqual({ sent: 1 });

    const id2 = await newLead({ 'Phone Number': '9123401234', Email: '' });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    await move(id2, { 'Lead Stage': 'Booked', 'Booking Date': '2026-11-01' });
    await vi.waitFor(async () => expect((await queue()).find((q) => q.leadId === id2)?.status).toBe('failed'));
    expect(await inCo(() => sendDue({ now: new Date(Date.now() + 8 * 86400e3) }))).toEqual({ expired: 1 });
    expect((await inCo(() => getAdConversions())).last30).toMatchObject({ sent: 1, expired: 1 });
  });

  it('normalises Indian numbers to Meta’s format', () => {
    expect(normalisePhone('+91 98765-01234')).toBe('919876501234');
    expect(normalisePhone('09876501234')).toBe('919876501234');
    expect(normalisePhone('9876501234')).toBe('919876501234');
    expect(normalisePhone('12')).toBe('');
  });
});

describe('send last 7 days', () => {
  const when = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000);
  /** A lead whose step happened while sending was off: its history has it, the queue does not. */
  const stepWhileOff = async (daysAgo: number, stage = 'Qualified') => {
    const id = await newLead({ 'Phone Number': `98765 ${String(Math.floor(Math.random() * 90000) + 10000)}` });
    await inCo(async () => (await col<any>(CFG.COLL.TIMELINE)).insertOne({ _id: `TL-${id}-${stage}` as any, leadId: id, timestamp: when(daysAgo), type: 'stage_changed', title: `Stage changed: Open → ${stage}`, details: '', actor: 'x' }));
    return id;
  };

  it('sends what was missed with its real date, once, and logs it', async () => {
    await turnOn();
    const id = await stepWhileOff(3);
    const preview = await inCo(() => sendRecentAdConversions({ preview: true }, admin));
    expect(preview).toMatchObject({ found: 1, byEvent: { Qualified: 1 }, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const r = await inCo(() => sendRecentAdConversions({}, admin));
    expect(r).toMatchObject({ found: 1, sent: 1, left: 0 });
    const body = sentBodies()[0].data[0];
    expect(body.event_name).toBe('Qualified');
    expect(Math.abs(body.event_time - Math.floor(when(3).getTime() / 1000))).toBeLessThan(60);
    const q = await queue();
    expect(q.map((x: any) => x._id)).toEqual([`meta:${id}:Qualified`]);
    expect(q[0].status).toBe('sent');
    expect((await inCo(() => sendRecentAdConversions({}, admin))).found).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Lead Results Sent For Last 7 Days' }))).toBe(1);
  });

  it('leaves what Meta would refuse, stages with no rule, and what was already sent', async () => {
    await turnOn();
    await stepWhileOff(8);
    await stepWhileOff(2, 'Lost');
    const sentAlready = await newLead();
    await move(sentAlready, { 'Lead Stage': 'Qualified' });
    fetchMock.mockClear();
    expect((await inCo(() => sendRecentAdConversions({ preview: true }, admin))).found).toBe(0);
  });

  it('reads site visits too', async () => {
    await turnOn();
    const id = await newLead();
    await inCo(async () => (await col<any>(CFG.COLL.TIMELINE)).insertOne({ _id: 'TL-SV' as any, leadId: id, timestamp: when(1), type: 'site_visit_completed', title: 'Site visit: Site Visit - Completed', details: '', actor: 'x' }));
    expect((await inCo(() => sendRecentAdConversions({ preview: true }, admin))).byEvent).toEqual({ 'Site Visit Done': 1 });
  });

  it('a lead reaching a step twice counts once, with the first date', async () => {
    await turnOn();
    const id = await stepWhileOff(5);
    await inCo(async () => (await col<any>(CFG.COLL.TIMELINE)).insertOne({ _id: 'TL-AGAIN' as any, leadId: id, timestamp: when(1), type: 'stage_changed', title: 'Stage changed: Warm → Qualified', details: '', actor: 'x' }));
    await inCo(() => sendRecentAdConversions({}, admin));
    expect(sentBodies()).toHaveLength(1);
    expect(Math.abs(sentBodies()[0].data[0].event_time - Math.floor(when(5).getTime() / 1000))).toBeLessThan(60);
  });

  it('refuses while off or in test mode, sending nothing', async () => {
    await stepWhileOff(1);
    await expect(inCo(() => sendRecentAdConversions({}, admin))).rejects.toThrow(/Switch on/);
    await turnOn({ testCode: 'TEST12345' });
    await expect(inCo(() => sendRecentAdConversions({}, admin))).rejects.toThrow(/test event code/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failure stays in the queue to retry', async () => {
    await turnOn();
    await stepWhileOff(2);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Down', code: 2 } }), { status: 500 }));
    const r = await inCo(() => sendRecentAdConversions({}, admin));
    expect(r.sent).toBe(0);
    expect((await queue())[0].status).toBe('failed');
  });

  it('needs the feature and the connect permission', async () => {
    await turnOn();
    await t.company('test', { adConversions: false });
    expect((await inCo(() => dispatch('sendRecentAdConversions', {}, { userAgent: 'vitest', ip: '10.9.9.9', token: admin.token }))).status).toBe(403);
  });
});
