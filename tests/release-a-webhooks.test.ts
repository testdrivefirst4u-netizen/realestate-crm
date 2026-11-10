/**
 * Release A, finding 4 — webhooks are stored before they are acknowledged; repeats create one result; failures are
 * retried, dead-lettered and replayable; a database failure is never answered with success.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { POST as telephonyPOST } from '../app/api/webhooks/telephony/route';
import { POST as chat360POST } from '../app/api/webhooks/chat360/route';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { settingSet } from '../server/core/settings';
import { __setInboxHandler, COLL_INBOX, MAX_ATTEMPTS, process as processInbox, replay, runInboxDue } from '../server/core/webhookInbox';
import { handleWebhook, statusRank } from '../server/modules/calls';
import { SYSTEM_CTX } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
const tel = (body: unknown, provider = 'exotel') =>
  telephonyPOST(new Request(`http://x/api/webhooks/telephony?company=test&provider=${provider}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'tel-secret' }, body: JSON.stringify(body) }));
const calls = async () => (await col<any>(CFG.COLL.CALLS)).find({}).toArray();
const inbox = async () => (await col<any>(COLL_INBOX)).find({}).toArray();

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  __setInboxHandler('telephony', null);
  // restore the real telephony handler
  __setInboxHandler('telephony', (p, m) => handleWebhook(p, m.provider || ''));
  try { await t.db.command({ collMod: COLL_INBOX, validator: {} }); } catch { /* collection may not exist */ }
  await t.company();
  await t.secret('TELEPHONY_WEBHOOK_SECRET', 'tel-secret');
  await t.secret('CHAT360_WEBHOOK_SECRET', 'c360-secret');
  await settingSet('telephonyFieldMap', CFG.SETTING_DEFAULTS.telephonyFieldMap, 'test');
});

describe('finding 4: durable webhook intake', () => {
  it('the same call event delivered five times (some in parallel) creates one call', async () => {
    const ev = { call_id: 'X-1', from: '+919876511111', direction: 'inbound', status: 'ringing' };
    const res = await Promise.all([tel(ev), tel(ev), tel(ev)]);
    expect(res.every((r) => r.status === 200)).toBe(true);
    await tel(ev);
    await tel(ev);
    expect(await calls()).toHaveLength(1);
    expect(await inbox()).toHaveLength(1);
  });

  it('distinct events of one call in parallel still make one call (cross-instance claim)', async () => {
    const legs = [
      { call_id: 'X-2', from: '9876511112', direction: 'inbound', status: 'ringing' },
      { call_id: 'X-2', from: '9876511112', direction: 'inbound', status: 'answered', duration: '5' },
      { call_id: 'X-2', from: '9876511112', direction: 'inbound', status: 'completed', duration: '62', end_time: '2026-11-10T10:01:02Z' },
    ];
    await Promise.all(legs.map((l) => handleWebhook(l, 'exotel')));
    const all = await calls();
    expect(all).toHaveLength(1);
  });

  it('callbacks out of order: an ended call never goes back to in progress, duration never shrinks', async () => {
    await handleWebhook({ call_id: 'X-3', from: '9876511113', direction: 'inbound', status: 'completed', duration: '90' }, 'exotel');
    await handleWebhook({ call_id: 'X-3', from: '9876511113', direction: 'inbound', status: 'in-progress', duration: '4' }, 'exotel');
    const [c] = await calls();
    expect(c.status).toBe('Completed');
    expect(c.durationSec).toBe(90);
    expect(statusRank('In Progress')).toBeLessThan(statusRank('Missed'));
  });

  it('a database failure before the event is stored answers 503, never success', async () => {
    await (await col<any>(COLL_INBOX)).insertOne({ _id: 'warmup' } as any);
    await t.db.command({ collMod: COLL_INBOX, validator: { $jsonSchema: { required: ['__never__'] } }, validationAction: 'error' });
    const r = await tel({ call_id: 'X-4', from: '9876511114', direction: 'inbound' });
    expect(r.status).toBe(503);
    expect((await r.json()).status).toBe('error');
    expect(await calls()).toHaveLength(0);
  });

  it('a processing failure is stored, acknowledged as accepted, retried with back-off, then dead-lettered and replayable', async () => {
    let fail = true;
    let runs = 0;
    __setInboxHandler('telephony', async () => {
      runs++;
      if (fail) throw new Error('lead service down');
      return { ok: true };
    });
    const r = await tel({ call_id: 'X-5', from: '9876511115' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'accepted', retrying: true });
    let [item] = await inbox();
    expect(item).toMatchObject({ status: 'failed', attempts: 1, lastError: 'lead service down' });

    // not due yet: nothing runs; then each attempt after its back-off
    expect(await runInboxDue(new Date())).toEqual({ done: 0, failed: 0, dead: 0 });
    let clock = Date.now();
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      clock += 25 * 3600e3;
      await runInboxDue(new Date(clock));
    }
    [item] = await inbox();
    expect(item.status).toBe('dead');
    expect(item.attempts).toBe(MAX_ATTEMPTS);
    expect(runs).toBe(MAX_ATTEMPTS);

    // the operator fixes the cause and replays it
    fail = false;
    const ctx = await t.ctx('Admin');
    const after = await replay(item._id, ctx);
    expect(after?.status).toBe('done');
    expect((await (await col<any>(CFG.COLL.AUDIT_LOG)).findOne({ action: 'Webhook Replayed' }))).toBeTruthy();
  });

  it('a stuck "processing" event (server stopped mid-way) is taken over after its lock lapses', async () => {
    __setInboxHandler('telephony', async () => ({ ok: true }));
    await (await col<any>(COLL_INBOX)).insertOne({ _id: 'telephony:stuck', provider: 'telephony', dedupeKey: 'stuck', correlationId: 'c', receivedAt: new Date(), eventAt: null, status: 'processing', attempts: 1, nextAttemptAt: null, lockedUntil: new Date(Date.now() - 1000), lastError: '', payload: {}, meta: {}, result: null, processedAt: null });
    expect((await processInbox('telephony:stuck'))?.status).toBe('done');
  });

  it('Chat360: the same message id twice is stored once', async () => {
    const body = JSON.stringify({ event_type: 'message_received', m_id: 'wamid.1', from: '919876511116', text: { body: 'Is the 2 BHK available?' } });
    const mk = () => chat360POST(new Request('http://x/api/webhooks/chat360?company=test', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'c360-secret' }, body }));
    const a = await mk();
    const b = await mk();
    expect(a.status).toBe(200);
    expect(await b.json()).toMatchObject({ duplicate: true });
    expect((await inbox()).filter((x) => x.provider === 'chat360')).toHaveLength(1);
  });

  it('SYSTEM context exists for handlers', () => {
    expect(SYSTEM_CTX.user?.id).toBe('SYSTEM');
  });
});
