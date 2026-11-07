/** WhatsApp credits: nothing changes without the switch, holds before sending, charged once on delivery, and the money always adds up. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { createUser, login } from '../server/core/auth';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { handleMetaWebhookPost } from '../server/modules/metaQueue';
import { connectDirect, sendDirect } from '../server/modules/whatsappDirect';
import { NO_CREDITS, PRICING_DEFAULTS, buildStatement, creditsBalance, creditsOverview, getPricing, normalizeCategory, setPricing, sweepCredits, toRupees, toUnits } from '../server/modules/whatsappCredits';
import { addWhatsappCredits, cleanPricing, saveWhatsappPricing, whatsappCreditsOverview } from '../server/platform/whatsappCredits';

const SECRET = 'app-secret';
const NUMBER_ID = '10001';
const WABA = '20002';
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
const sa = { sa: { name: 'Rahul' }, ip: '1.1.1.1' } as any;
const CUSTOMER = '919876501234';
let t: Awaited<ReturnType<typeof startTestDb>>;
let sends = 0;
let sendAnswer: any = null;
let request = 0;

const inCo = async <T>(fn: () => Promise<T>, id = 'CMP-test') => {
  invalidateTenant();
  return runWithTenant((await getTenantById(id))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MARKETING = { name: 'offer', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Offer' }] };

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  if (path === `/${WABA}/phone_numbers`) return json(200, { data: [{ id: NUMBER_ID, display_phone_number: '+91 90000 11111', verified_name: 'Test' }] });
  if (path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
  if (path === `/${WABA}/message_templates`) return json(200, { data: [MARKETING] });
  if (path === `/${NUMBER_ID}/messages`) {
    sends++;
    return sendAnswer || json(200, { messages: [{ id: `wamid.${sends}` }] });
  }
  return json(404, { error: { message: `unexpected ${path}` } });
}
const webhook = (body: unknown) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return handleMetaWebhookPost(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), (fn) => void fn());
};
const status = (id: string, s: string, extra: Record<string, unknown> = {}) => webhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER_ID }, statuses: [{ id, status: s, recipient_id: CUSTOMER, ...extra }] } }] }] });
const PAID = (category: string) => ({ pricing: { billable: true, category, pricing_model: 'PMP', type: 'regular' } });
const add = (amount: number, companyId = 'CMP-test') => addWhatsappCredits({ companyId, amount, kind: 'add', reference: 'UTR123', requestId: `req-0000-${++request}` }, sa);
const wallet = (id = 'CMP-test') => inCo(async () => (await col<any>('whatsappWallet')).findOne({ _id: id }), id);
const ledger = () => inCo(async () => (await col<any>('whatsappLedger')).find({}).toArray());
const sendOffer = async () => (await inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'offer' }, ctx))).message.id;
const sendText = async () => (await inCo(() => sendDirect({ phone: CUSTOMER, text: 'Hi' }, ctx))).message.id;
const money = (w: any) => [toRupees(w.balance), toRupees(w.held)];

beforeAll(async () => {
  process.env.META_APP_ID = '111';
  process.env.META_APP_SECRET = SECRET;
  t = await startTestDb();
});
afterAll(async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { chat360: true, whatsappDirect: true, whatsappCredits: true });
  sends = 0;
  sendAnswer = null;
  vi.stubGlobal('fetch', vi.fn(fake));
  await setPricing(PRICING_DEFAULTS, 'test');
  await inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: 'TOKEN' }, ctx));
});
afterEach(() => vi.unstubAllGlobals());

describe('without the switch', () => {
  it('nothing is held, refused or charged', async () => {
    await t.company('test', { chat360: true, whatsappDirect: true, whatsappCredits: false });
    const id = await sendOffer();
    await status(id, 'delivered', PAID('marketing'));
    expect(sends).toBe(1);
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toBeNull();
  });
  it('the screen and its data are not available', async () => {
    await t.company('test', { chat360: true, whatsappDirect: true, whatsappCredits: false });
    const token = await inCo(async () => {
      await createUser({ name: 'Boss', email: 'boss@x.test', password: 'long-enough-pw', role: 'Admin', mustChangePassword: false }, null);
      return (await login('boss@x.test', 'long-enough-pw', { userAgent: 'v', ip: '1.1.1.1' })).token;
    });
    expect(((await inCo(() => dispatch('waCreditsOverview', {}, { userAgent: 'v', ip: '1.1.1.1', token }))) as any).status).toBe(403);
  });
  it('Super Admin cannot add credits until it is on', async () => {
    await t.company('test', { whatsappDirect: true, whatsappCredits: false });
    await expect(add(100)).rejects.toThrow(/Turn on/);
  });
});

describe('a paid message', () => {
  it('is held, then charged on delivery at the client price', async () => {
    await add(10);
    const id = await sendOffer();
    expect(money(await wallet())).toEqual([10, 0.96]);
    await status(id, 'sent', PAID('marketing'));
    expect(money(await wallet())).toEqual([10, 0.96]);
    await status(id, 'delivered', PAID('marketing'));
    expect(money(await wallet())).toEqual([9.04, 0]);
    const charge = (await ledger()).find((e) => e.type === 'charge');
    expect(charge).toMatchObject({ type: 'charge', units: -toUnits(0.96), costUnits: toUnits(0.8631), category: 'marketing', template: 'offer', agent: 'Asha' });
  });

  it('is charged once, whatever repeats arrive', async () => {
    await add(10);
    const id = await sendOffer();
    await status(id, 'delivered', PAID('marketing'));
    await status(id, 'delivered', PAID('marketing'));
    await status(id, 'read', PAID('marketing'));
    expect(money(await wallet())).toEqual([9.04, 0]);
    expect((await ledger()).filter((e) => e.type === 'charge')).toHaveLength(1);
  });

  it('a read receipt alone is proof enough', async () => {
    await add(10);
    await status(await sendOffer(), 'read', PAID('marketing'));
    expect(money(await wallet())).toEqual([9.04, 0]);
  });

  it('is not charged if it fails, and the hold comes back', async () => {
    await add(10);
    await status(await sendOffer(), 'failed', { errors: [{ code: 131026 }] });
    expect(money(await wallet())).toEqual([10, 0]);
    expect((await ledger()).filter((e) => e.type === 'charge')).toEqual([]);
  });

  it('gets its hold back if Meta refuses it outright', async () => {
    await add(10);
    sendAnswer = json(400, { error: { code: 131026, message: 'no' } });
    await expect(sendOffer()).rejects.toThrow();
    expect(money(await wallet())).toEqual([10, 0]);
  });

  it('uses the type Meta says it is, not the one expected', async () => {
    await add(10);
    await status(await sendOffer(), 'delivered', PAID('utility'));
    expect(money(await wallet())).toEqual([9.85, 0]);
  });

  it("Meta's free messages are free to the client, and still counted", async () => {
    await add(10);
    await status(await sendText(), 'delivered', { pricing: { billable: false, category: 'service', type: 'free_customer_service' } });
    expect(money(await wallet())).toEqual([10, 0]);
    expect((await ledger()).find((e) => e.type === 'free')).toMatchObject({ units: -0, costUnits: 0, category: 'service' });
    expect(await inCo(() => creditsOverview({}))).toMatchObject({ usedMonth: 0, byType: [{ key: 'service', messages: 1, free: 1, amount: 0 }] });
  });

  it('a receipt that beats the save is not lost', async () => {
    await add(10);
    await status('wamid.1', 'delivered', PAID('marketing'));
    expect(money(await wallet())).toEqual([10, 0]);
    await sendOffer();
    expect(money(await wallet())).toEqual([9.04, 0]);
    expect((await ledger()).filter((e) => e.type === 'charge')).toHaveLength(1);
  });
});

describe('running out', () => {
  it('stops before reaching Meta, and holds cannot overrun the balance', async () => {
    await add(2);
    await sendOffer();
    await sendOffer();
    const before = sends;
    await expect(sendOffer()).rejects.toThrow(NO_CREDITS);
    expect(sends).toBe(before);
    expect(money(await wallet())).toEqual([2, 1.92]);
  });

  it('many at once cannot overrun it', async () => {
    await add(2);
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => inCo(() => sendDirect({ phone: CUSTOMER, templateName: 'offer' }, ctx))));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(money(await wallet())).toEqual([2, 1.92]);
  });

  it('a customer who wrote in can still be answered, up to the monthly limit, going below zero', async () => {
    await setPricing({ ...PRICING_DEFAULTS, replyGrace: 2 }, 'test');
    const id = await sendText();
    await sendText();
    await expect(sendText()).rejects.toThrow(NO_CREDITS);
    await expect(sendOffer()).rejects.toThrow(NO_CREDITS);
    await status(id, 'delivered', PAID('service'));
    expect(money(await wallet())).toEqual([-0.15, 0]);
    expect(await inCo(() => creditsBalance())).toMatchObject({ finished: true });
  });

  it('warns without saying amounts, since every user can see the bell', async () => {
    await add(1);
    await status(await sendOffer(), 'delivered', PAID('marketing'));
    const events = await inCo(async () => (await col<any>(CFG.COLL.EVENTS)).find({ type: 'integration_alert' }).toArray());
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/₹|0\.04/);
  });

  it('prices cover Indian numbers only for now', async () => {
    await add(10);
    await expect(inCo(() => sendDirect({ phone: '971501234567', text: 'Hi' }, ctx))).rejects.toThrow(/Indian numbers/);
    expect(sends).toBe(0);
  });
});

describe('the background job', () => {
  it('frees a hold nothing ever came back for, and a late delivery still charges', async () => {
    await add(10);
    const id = await sendOffer();
    const later = new Date(Date.now() + 4 * 86400000);
    expect(await inCo(() => sweepCredits(later))).toMatchObject({ released: 1 });
    expect(money(await wallet())).toEqual([10, 0]);
    await status(id, 'delivered', PAID('marketing'));
    expect(money(await wallet())).toEqual([9.04, 0]);
  });
  it('charges a delivery whose send never saved, since Meta bills it', async () => {
    await add(10);
    await status('wamid.lost', 'delivered', PAID('marketing'));
    expect(await inCo(() => sweepCredits(new Date(Date.now() + 2 * 3600000)))).toMatchObject({ charged: 1 });
    expect(money(await wallet())).toEqual([9.04, 0]);
  });
  it('never charges a lost receipt Meta did not say was billable', async () => {
    await add(10);
    await status('wamid.phone', 'delivered');
    await status('wamid.free', 'delivered', { pricing: { billable: false, category: 'service' } });
    expect(await inCo(() => sweepCredits(new Date(Date.now() + 2 * 3600000)))).toMatchObject({ charged: 0 });
    expect(money(await wallet())).toEqual([10, 0]);
  });
  it('does nothing for a company without the switch', async () => {
    await t.company('test', { whatsappDirect: true, whatsappCredits: false });
    expect(await inCo(() => sweepCredits())).toEqual({ released: 0, charged: 0 });
  });
});

describe('Super Admin', () => {
  it('a double click adds once', async () => {
    const d = { companyId: 'CMP-test', amount: 500, kind: 'add' as const, reference: 'UTR1', requestId: 'same-request-id' };
    expect(await addWhatsappCredits(d, sa)).toEqual({ applied: true });
    expect(await addWhatsappCredits(d, sa)).toEqual({ applied: false });
    expect(money(await wallet())).toEqual([500, 0]);
  });
  it('needs a reference for a payment, a reason for a correction, and a sensible amount', async () => {
    const base = { companyId: 'CMP-test', requestId: 'req-valid-1' };
    await expect(addWhatsappCredits({ ...base, amount: 100, kind: 'add' }, sa)).rejects.toThrow(/reference/);
    await expect(addWhatsappCredits({ ...base, amount: -100, kind: 'add', reference: 'x' }, sa)).rejects.toThrow(/Correction/);
    await expect(addWhatsappCredits({ ...base, amount: -100, kind: 'correction' }, sa)).rejects.toThrow(/why/);
    await expect(addWhatsappCredits({ ...base, amount: 0, kind: 'add', reference: 'x' }, sa)).rejects.toThrow(/amount/);
    await expect(addWhatsappCredits({ ...base, amount: 99999999, kind: 'add', reference: 'x' }, sa)).rejects.toThrow(/amount/);
    await expect(addWhatsappCredits({ ...base, requestId: 'x', amount: 1, kind: 'add', reference: 'x' }, sa)).rejects.toThrow(/try again/);
  });
  it('a correction is kept as its own entry, never an edit', async () => {
    await add(100);
    await addWhatsappCredits({ companyId: 'CMP-test', amount: -30, kind: 'correction', note: 'Typed too much', requestId: 'req-correct-1' }, sa);
    expect(money(await wallet())).toEqual([70, 0]);
    expect((await ledger()).map((e) => toRupees(e.units)).sort((a, b) => a - b)).toEqual([-30, 100]);
  });
  it('sees balances, Meta cost and margin, and they add up', async () => {
    await add(100);
    await status(await sendOffer(), 'delivered', PAID('marketing'));
    const o = await whatsappCreditsOverview({});
    expect(o.companies[0]).toMatchObject({ companyId: 'CMP-test', balance: 99.04, addedMonth: 100, usedMonth: 0.96, metaCostMonth: 0.8631, marginMonth: 0.0969, messages: 1, mismatch: 0 });
    expect(o.totals).toMatchObject({ used: 0.96, metaCost: 0.8631, margin: 0.0969 });
  });
  it('is told if a balance ever differs from its history', async () => {
    await add(100);
    await inCo(async () => (await col<any>('whatsappWallet')).updateOne({ _id: 'CMP-test' }, { $inc: { balance: toUnits(5) } }));
    expect((await whatsappCreditsOverview({})).companies[0].mismatch).toBe(5);
  });
  it('changing a price applies to the next message, and bad prices are refused', async () => {
    await add(10);
    const r = await saveWhatsappPricing({ ...PRICING_DEFAULTS, prices: { ...PRICING_DEFAULTS.prices, marketing: 1.25 } }, sa);
    expect(r.prices.marketing).toBe(1.25);
    expect((await getPricing()).costs.marketing).toBe(0.8631);
    await status(await sendOffer(), 'delivered', PAID('marketing'));
    expect(money(await wallet())).toEqual([8.75, 0]);
    expect(() => cleanPricing({ ...PRICING_DEFAULTS, prices: { ...PRICING_DEFAULTS.prices, utility: -1 } })).toThrow(/utility price/);
    expect(() => cleanPricing({ ...PRICING_DEFAULTS, replyGrace: 1.5 })).toThrow(/replies/);
  });
});

describe('what the client sees', () => {
  it('its balance, usage and statement, but never Meta cost or margin', async () => {
    await add(100);
    await status(await sendOffer(), 'delivered', PAID('marketing'));
    const o = await inCo(() => creditsOverview({}));
    expect(o).toMatchObject({ balance: 99.04, available: 99.04, usedToday: 0.96, usedMonth: 0.96, addedMonth: 100, low: true });
    expect(o.byType).toEqual([{ key: 'marketing', messages: 1, free: 0, amount: 0.96 }]);
    expect(o.byTemplate).toEqual([{ key: 'offer', messages: 1, free: 0, amount: 0.96 }]);
    const raw = JSON.stringify(o);
    expect(raw).not.toMatch(/0\.8631|costUnits|margin|costs/i);
  });

  const asRole = async (role: 'Admin' | 'Manager' | 'RM' | 'Viewer') => inCo(async () => {
    const email = `${role.toLowerCase()}@credits.test`;
    await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
    return (await login(email, 'long-enough-pw', { userAgent: 'v', ip: '1.1.1.1' })).token;
  });
  it('Admins and Managers can see it; Agents and View only cannot', async () => {
    for (const [role, code] of [['Admin', 200], ['Manager', 200], ['RM', 403], ['Viewer', 403]] as const) {
      const token = await asRole(role);
      expect(((await inCo(() => dispatch('waCreditsBalance', {}, { userAgent: 'v', ip: '1.1.1.1', token }))) as any).status, role).toBe(code);
    }
  });
  it('a company sees only its own', async () => {
    await t.company('other', { whatsappDirect: true, whatsappCredits: true });
    await add(100);
    await add(7, 'CMP-other');
    expect((await inCo(() => creditsBalance(), 'CMP-other')).available).toBe(7);
    expect((await inCo(() => creditsBalance())).available).toBe(100);
    expect((await inCo(() => creditsOverview({}), 'CMP-other')).addedMonth).toBe(7);
  });
});

describe('the statement', () => {
  const e = (type: any, units: number, day: string, note = '') => ({ type, units: toUnits(units), day, at: new Date(day), note });
  it('runs from the opening balance, credits first each day, newest on top', () => {
    const rows = buildStatement([e('charge', -0.96, '2026-11-02'), e('charge', -0.15, '2026-11-02'), e('credit', 100, '2026-11-02', 'Paid'), e('charge', -1, '2026-11-03'), e('free', 0, '2026-11-03')], toUnits(5));
    expect(rows).toEqual([
      { date: '2026-11-03', details: '2 WhatsApp messages', credit: 0, used: 1, balance: 102.89 },
      { date: '2026-11-02', details: '2 WhatsApp messages', credit: 0, used: 1.11, balance: 103.89 },
      { date: '2026-11-02', details: 'Added by BroaddCast: Paid', credit: 100, used: 0, balance: 105 },
    ]);
  });
  it('shows a correction as one', () => {
    expect(buildStatement([e('credit', -5, '2026-11-02', 'Mistake')], toUnits(10))[0]).toEqual({ date: '2026-11-02', details: 'Correction by BroaddCast: Mistake', credit: 0, used: 5, balance: 5 });
  });
});

describe('small rules', () => {
  it("reads Meta's names for message types", () => {
    expect(normalizeCategory('MARKETING_LITE')).toBe('marketing');
    expect(normalizeCategory('authentication_international')).toBe('authentication');
    expect(normalizeCategory('', 'utility')).toBe('utility');
    expect(normalizeCategory('whatever')).toBe('service');
  });
  it('keeps exact money, with no rounding drift', () => {
    expect(toRupees(toUnits(0.8631))).toBe(0.8631);
    let total = 0;
    for (let i = 0; i < 1000; i++) total += toUnits(0.96);
    expect(toRupees(total)).toBe(960);
  });
});
