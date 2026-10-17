/**
 * Two-step sign-in (authenticator app) for CRM users and super admins: setup → confirm → the code is required at
 * sign-in (missing → asked for, wrong → refused), turning it off needs the password, and a password reset clears it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { login, totpDisable, totpEnable, totpSetup, updateUser, SYSTEM_CTX } from '../server/core/auth';
import { totpCode } from '../server/core/totp';
import { platformDispatch } from '../server/platform/router';

let t: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

const secretOf = (s: { secret: string }) => s.secret.replace(/\s/g, '');
const net = { userAgent: 'vitest', ip: '10.9.9.9' };

describe('two-step sign-in — CRM users', () => {
  it('setup, confirm, then the code is needed at sign-in; turning off needs the password', async () => {
    const ctx = await t.ctx('Admin');
    const email = ctx.user!.email;
    expect((await login(email, 'correct-horse-1', net)).user.twoFactor).toBe(false);

    const s = await totpSetup(ctx, 'Test CRM');
    expect(s.uri).toContain('otpauth://totp/Test%20CRM');
    await expect(totpEnable(ctx, '000000')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await totpEnable(ctx, totpCode(secretOf(s)))).twoFactor).toBe(true);

    await expect(login(email, 'correct-horse-1', net)).rejects.toMatchObject({ code: 'AUTH_FAILED', details: { totpRequired: true } });
    await expect(login(email, 'correct-horse-1', net, '123456')).rejects.toMatchObject({ code: 'AUTH_FAILED', details: { totpRequired: true } });
    await expect(login(email, 'wrong-password-1', net, totpCode(secretOf(s)))).rejects.toMatchObject({ code: 'AUTH_FAILED', message: 'Invalid email or password' });
    const ok = await login(email, 'correct-horse-1', net, totpCode(secretOf(s)));
    expect(ok.user.twoFactor).toBe(true);

    await expect(totpDisable(ctx, 'nope')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await totpDisable(ctx, 'correct-horse-1')).twoFactor).toBe(false);
    expect((await login(email, 'correct-horse-1', net)).user.twoFactor).toBe(false);
  });

  it('an administrator resetting the password turns two-step sign-in off (lost phone)', async () => {
    const ctx = await t.ctx('Sales');
    const s = await totpSetup(ctx);
    await totpEnable(ctx, totpCode(secretOf(s)));
    await updateUser({ id: ctx.user!.id, password: 'fresh-password-9' }, SYSTEM_CTX);
    expect((await login(ctx.user!.email, 'fresh-password-9', net)).user.twoFactor).toBe(false);
  });
});

describe('two-step sign-in — super admins', () => {
  it('the console login asks for the code once it is on', async () => {
    const pd = (action: string, data: any = {}, token = '') => platformDispatch(action, data, { token, ...net });
    const setup = await pd('saSetup', { name: 'Root', email: 'root@platform.io', password: 'super-secret-pw-1' });
    const token = setup.session!.token;
    const s = (await pd('saTotpSetup', {}, token)).body as any;
    const secret = secretOf(s.data);
    expect(((await pd('saTotpEnable', { code: totpCode(secret) }, token)).body as any).data.twoFactor).toBe(true);

    const noCode = await pd('saLogin', { email: 'root@platform.io', password: 'super-secret-pw-1' });
    expect(noCode.status).toBe(401);
    expect((noCode.body as any).details).toEqual({ totpRequired: true });
    expect(noCode.session).toBeUndefined();
    const withCode = await pd('saLogin', { email: 'root@platform.io', password: 'super-secret-pw-1', code: totpCode(secret) });
    expect(withCode.status).toBe(200);
    expect(withCode.session?.token).toBeTruthy();
  });
});
