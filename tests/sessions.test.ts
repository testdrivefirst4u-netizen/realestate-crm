/** Devices: at most 2 sessions per person (a 3rd signs out the oldest), idle sign-out after an hour, device lists. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/modules/push', async (orig) => ({ ...(await orig<any>()), sendPush: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
import { startTestDb } from './helpers/mongo';
import { dispatch } from '../server/router';
import { createUser, login, SESSION_END_MESSAGES } from '../server/core/auth';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { sendPush } from '../server/modules/push';

let t: Awaited<ReturnType<typeof startTestDb>>;
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const LAPTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const TABLET = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1';
const signIn = async (email: string, ua: string) => (await login(email, 'long-enough-pw', { userAgent: ua, ip: '10.2.2.2' })).token;
const as = async (token: string, action: string, data: any = {}) => (await dispatch(action, data, { userAgent: 'vitest', ip: '10.2.2.2', token })).body as any;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await createUser({ name: 'Asha Admin', email: 'asha@sess.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null);
  await createUser({ name: 'Ravi Rao', email: 'ravi@sess.test', password: 'long-enough-pw', role: 'RM', mustChangePassword: false }, null);
  vi.mocked(sendPush).mockClear();
});

describe('device limit', () => {
  it('a 3rd sign-in signs out the oldest device, which is told why; the person hears about new sign-ins', async () => {
    const phone = await signIn('ravi@sess.test', PHONE);
    const laptop = await signIn('ravi@sess.test', LAPTOP);
    expect((await as(phone, 'me')).status).toBe('success');
    const tablet = await signIn('ravi@sess.test', TABLET);
    // the phone (oldest) is out, with the reason; the other two still work
    expect(await as(phone, 'me')).toMatchObject({ status: 'error', code: 'AUTH_REQUIRED', message: SESSION_END_MESSAGES.device_limit });
    expect((await as(laptop, 'me')).status).toBe('success');
    expect((await as(tablet, 'me')).status).toBe('success');
    const mine = (await as(tablet, 'mySessions')).data;
    expect(mine.map((s: any) => [s.device, s.current])).toEqual([['iPad · Safari', true], ['Windows · Chrome', false]]);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendPush).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ title: 'New sign-in to your CRM account' }));
  });

  it('signing out one device or all others from My profile; the device is told who signed it out', async () => {
    const laptop = await signIn('ravi@sess.test', LAPTOP);
    const phone = await signIn('ravi@sess.test', PHONE);
    const other = (await as(phone, 'mySessions')).data.find((s: any) => !s.current);
    expect((await as(phone, 'endMySession', { id: other.id })).data).toHaveLength(1);
    expect(await as(laptop, 'me')).toMatchObject({ code: 'AUTH_REQUIRED', message: SESSION_END_MESSAGES.ended_by_user });
    const laptop2 = await signIn('ravi@sess.test', LAPTOP);
    await as(phone, 'endMyOtherSessions');
    expect((await as(laptop2, 'me')).status).toBe('error');
    expect((await as(phone, 'me')).status).toBe('success'); // the current one stays
  });
});

describe('idle sign-out', () => {
  it('an hour without activity signs the device out; activity (touchSession) keeps it signed in', async () => {
    const token = await signIn('ravi@sess.test', LAPTOP);
    const sessions = await col(CFG.COLL.SESSIONS);
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    // 50 minutes idle: still in; using the CRM resets the clock
    await sessions.updateOne({ userId: 'USR-0002' }, { $set: { lastActive: ago(50) } });
    expect((await as(token, 'touchSession')).status).toBe('success');
    const s = await sessions.findOne({ userId: 'USR-0002' });
    expect(Date.now() - s!.lastActive.getTime()).toBeLessThan(5000);
    // background refreshes do not count as activity
    await sessions.updateOne({ userId: 'USR-0002' }, { $set: { lastActive: ago(CFG.SESSION_IDLE_MINUTES + 5) } });
    expect(await as(token, 'getEvents', { since: 0 })).toMatchObject({ code: 'AUTH_REQUIRED', message: SESSION_END_MESSAGES.idle });
  });

  it('sessions from before this rule are not signed out at once', async () => {
    const token = await signIn('ravi@sess.test', LAPTOP);
    await (await col(CFG.COLL.SESSIONS)).updateOne({ userId: 'USR-0002' }, { $unset: { lastActive: '' } });
    expect((await as(token, 'me')).status).toBe('success');
  });
});

describe('admins', () => {
  it('see how many devices each person uses and can sign them out; an Agent cannot', async () => {
    const admin = await signIn('asha@sess.test', LAPTOP);
    const r1 = await signIn('ravi@sess.test', PHONE);
    await signIn('ravi@sess.test', LAPTOP);
    expect((await as(admin, 'sessionCounts')).data).toMatchObject({ 'USR-0001': 1, 'USR-0002': 2 });
    expect((await as(admin, 'userSessions', { userId: 'USR-0002' })).data).toHaveLength(2);
    expect((await as(r1, 'sessionCounts')).status).toBe('error');
    expect((await as(r1, 'endUserSessions', { userId: 'USR-0001' })).status).toBe('error');
    expect((await as(admin, 'endUserSessions', { userId: 'USR-0002' })).data).toEqual([]);
    expect(await as(r1, 'me')).toMatchObject({ code: 'AUTH_REQUIRED', message: SESSION_END_MESSAGES.ended_by_admin });
  });
});
