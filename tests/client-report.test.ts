/** Client Report delivery: share-link settings (enable/disable/rotate), token verification, and the stored aggregation. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { col } from '../server/core/db';
import { CFG } from '../server/core/config';
import { addLead } from '../server/modules/leads';
import { clientReportByToken, clientReportData, getClientReportShare, rotateClientReportShareToken, setClientReportShare } from '../server/modules/clientReport';

let t: Awaited<ReturnType<typeof startTestDb>>;
const inCo = async <T>(fn: () => Promise<T>) => { invalidateTenant(); return runWithTenant((await getTenantById('CMP-test'))!, fn); };

beforeAll(async () => { t = await startTestDb(); process.env.APP_URL = 'https://crm.example.com'; });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await t.reset(); await t.company('test'); });

describe('Client Report — share link', () => {
  it('mints a token and URL when sharing is turned on, and clears/keeps settings correctly', async () => {
    const ctx = await t.ctx('Admin');
    const before = await inCo(() => getClientReportShare({}, ctx));
    expect(before).toMatchObject({ enabled: false, emailMonthly: false, recipients: [], url: '' });

    const on = await inCo(() => setClientReportShare({ enabled: true, emailMonthly: false, recipients: [] }, ctx));
    expect(on.enabled).toBe(true);
    expect(on.url).toMatch(/^https:\/\/crm\.example\.com\/r\/test\/[a-f0-9]{48}$/);

    // turning it off keeps the (now-inactive) token but the public check must fail
    const off = await inCo(() => setClientReportShare({ enabled: false, emailMonthly: false, recipients: [] }, ctx));
    expect(off.enabled).toBe(false);
  });

  it('rejects the wrong token, and any token once sharing is off', async () => {
    const ctx = await t.ctx('Admin');
    const on = await inCo(() => setClientReportShare({ enabled: true, emailMonthly: false, recipients: [] }, ctx));
    const token = on.url.split('/').pop()!;

    const r = await inCo(() => clientReportByToken(token, '2026-11'));
    expect(r.month).toBe('2026-11');
    expect(r.company.name).toBeTruthy();

    await expect(inCo(() => clientReportByToken('deadbeef', '2026-11'))).rejects.toThrow(/not available/i);
    await inCo(() => setClientReportShare({ enabled: false, emailMonthly: false, recipients: [] }, ctx));
    await expect(inCo(() => clientReportByToken(token, '2026-11'))).rejects.toThrow(/not available/i);
  });

  it('rotating the token invalidates the old link', async () => {
    const ctx = await t.ctx('Admin');
    const on = await inCo(() => setClientReportShare({ enabled: true, emailMonthly: false, recipients: [] }, ctx));
    const oldToken = on.url.split('/').pop()!;
    const rotated = await inCo(() => rotateClientReportShareToken({}, ctx));
    const newToken = rotated.url.split('/').pop()!;
    expect(newToken).not.toBe(oldToken);
    await expect(inCo(() => clientReportByToken(oldToken, '2026-11'))).rejects.toThrow(/not available/i);
    await expect(inCo(() => clientReportByToken(newToken, '2026-11'))).resolves.toMatchObject({ month: '2026-11' });
  });

  it('requires at least one recipient before the monthly e-mail can be turned on', async () => {
    const ctx = await t.ctx('Admin');
    await expect(inCo(() => setClientReportShare({ enabled: true, emailMonthly: true, recipients: [] }, ctx))).rejects.toThrow(/e-mail address/i);
    const ok = await inCo(() => setClientReportShare({ enabled: true, emailMonthly: true, recipients: ['Client@Example.com', 'bad', 'owner@example.com'] }, ctx));
    expect(ok.recipients).toEqual(['client@example.com', 'owner@example.com']); // lowercased, invalid dropped
  });
});

describe('Client Report — stored aggregation', () => {
  it('counts leads and bookings for the month, and follower growth from snapshots', async () => {
    await inCo(async () => {
      await addLead({ 'Prospect Name': 'A', 'Phone Number': '9123400001', 'Enquiry Date': '2026-11-05', 'Lead Stage': 'Booked', 'Enquiry Source': 'Meta' } as any, null);
      await addLead({ 'Prospect Name': 'B', 'Phone Number': '9123400002', 'Enquiry Date': '2026-11-20', 'Lead Stage': 'New', 'Enquiry Source': 'Meta' } as any, null);
      await addLead({ 'Prospect Name': 'C', 'Phone Number': '9123400003', 'Enquiry Date': '2026-10-10', 'Lead Stage': 'New', 'Enquiry Source': 'Google' } as any, null);
      // two months of follower snapshots for one Instagram account
      const snaps = await col<any>('followerSnapshots');
      await snaps.insertMany([
        { _id: 'instagram:ig1:2026-10', key: 'instagram:ig1', kind: 'instagram', name: '@acme', month: '2026-10', followers: 1000, at: new Date() },
        { _id: 'instagram:ig1:2026-11', key: 'instagram:ig1', kind: 'instagram', name: '@acme', month: '2026-11', followers: 1120, at: new Date() },
      ]);
    });

    const r = await inCo(() => clientReportData('2026-11'));
    expect(r.leads.total).toBe(2);
    expect(r.leads.booked).toBe(1);
    expect(r.leads.totalPrev).toBe(1);
    expect(r.leads.bySource.find((s) => s.source === 'Meta')?.n).toBe(2);
    expect(r.audience.netGrowth).toBe(120);
    const acct = r.audience.accounts.find((a) => a.key === 'instagram:ig1');
    expect(acct).toMatchObject({ followers: 1120, delta: 120 });
  });
});
