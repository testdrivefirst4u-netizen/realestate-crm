/** Phone notifications (Web Push): device subscriptions per user, delivery, and forgetting devices that are gone. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotification = vi.fn(async (_sub: { endpoint: string }, _body: string) => ({ statusCode: 201 }));
vi.mock('web-push', () => ({ default: { setVapidDetails: () => {}, sendNotification: (sub: any, body: string) => sendNotification(sub, body) } }));

import { startTestDb } from './helpers/mongo';
import type { Ctx } from '../server/core/auth';
import { deviceName, pushStatus, pushSubscribe, pushTest, pushUnsubscribe, sendPush } from '../server/modules/push';

let t: Awaited<ReturnType<typeof startTestDb>>;
let rm: Ctx, other: Ctx;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  rm = { ...(await t.ctx('RM', 'Priya Sharma')), userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1' };
  other = await t.ctx('RM', 'Ravi Kumar');
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  sendNotification.mockReset();
  sendNotification.mockImplementation(async () => ({ statusCode: 201 }));
});

const sub = (n: number) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/dev${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } });

describe('device subscriptions', () => {
  it('saves a device per user, names it, and refuses bad subscriptions', async () => {
    const s = await pushSubscribe(sub(1), rm);
    expect(s).toMatchObject({ configured: true, publicKey: 'test-public-key', devices: [{ device: 'iPhone · Safari' }] });
    await expect(pushSubscribe({ subscription: { endpoint: 'http://insecure.example/x', keys: sub(1).subscription.keys } }, rm)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(pushSubscribe({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'short', auth: '!' } } }, rm)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(pushSubscribe({ subscription: { endpoint: 'https://attacker.example/x', keys: sub(1).subscription.keys } }, rm)).rejects.toMatchObject({ code: 'VALIDATION' }); // not a browser push service
    expect(deviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36')).toBe('Android · Chrome');
  });

  it('the same device signing in as someone else moves to them; at most 10 devices each', async () => {
    await pushSubscribe(sub(1), rm);
    await pushSubscribe(sub(1), other);
    expect((await pushStatus(rm)).devices).toHaveLength(0);
    expect((await pushStatus(other)).devices).toHaveLength(1);
    for (let i = 0; i < 12; i++) await pushSubscribe(sub(100 + i), rm);
    expect((await pushStatus(rm)).devices).toHaveLength(10);
  });

  it('removes this device (by endpoint) or one from the list (by id), only your own', async () => {
    await pushSubscribe(sub(1), rm);
    const s = await pushSubscribe(sub(2), rm);
    await pushUnsubscribe({ id: s.devices[0].id }, other); // not theirs: nothing happens
    expect((await pushStatus(rm)).devices).toHaveLength(2);
    await pushUnsubscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev1' }, rm);
    expect((await pushStatus(rm)).devices).toHaveLength(1);
  });

  it('without server keys nothing is subscribed or sent', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    await expect(pushSubscribe(sub(1), rm)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(await sendPush([rm.user!.id], { title: 'x', body: 'y' })).toEqual({ sent: 0, removed: 0, failed: 0 });
  });
});

describe('delivery', () => {
  it('sends to every device of the users and forgets devices the push service says are gone', async () => {
    await pushSubscribe(sub(1), rm);
    await pushSubscribe(sub(2), rm);
    await pushSubscribe(sub(3), other);
    sendNotification.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith('dev2')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const r = await sendPush([rm.user!.id], { title: 'New lead: Meera', body: 'Facebook', url: '/leads?lead=ENQ-0001', tag: 'lead-ENQ-0001' });
    expect(r).toEqual({ sent: 1, removed: 1, failed: 0 });
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toEqual({ title: 'New lead: Meera', body: 'Facebook', url: '/leads?lead=ENQ-0001', tag: 'lead-ENQ-0001' });
    expect((await pushStatus(rm)).devices).toHaveLength(1);
  });

  it('a test notification needs a subscribed device', async () => {
    await expect(pushTest(rm)).rejects.toMatchObject({ code: 'VALIDATION' });
    await pushSubscribe(sub(1), rm);
    expect(await pushTest(rm)).toMatchObject({ sent: 1 });
  });
});
