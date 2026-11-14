/** Drip campaigns: draft until tested, new leads only, stop rules checked before each step, opt-outs kept, never sent twice. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { addLead, updateLead } from '../server/modules/leads';
import { fillVars, nextOpen, runDripDue, saveDripCampaign, saveDripEmail, setDripStatus, testDripCampaign, unsubscribeEmail, unsubscribeUrl, unsubSigOk, getDrip } from '../server/modules/dripCampaigns';

const chatSend = vi.hoisted(() => vi.fn(async () => ({ message: {} })));
const mailSend = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../server/modules/chat360', async (orig) => ({ ...(await orig<any>()), send: chatSend }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail: mailSend })) } }));
vi.mock('dns/promises', () => ({ default: { lookup: vi.fn(async (h: string) => [{ address: h === 'inside.example.com' ? '10.0.0.5' : '93.184.216.34', family: 4 }]) } }));

let t: Awaited<ReturnType<typeof startTestDb>>;
const ctx = { user: { name: 'Asha', role: 'Admin' } } as any;
const noon = new Date('2026-11-10T06:30:00Z'); // 12:00 in India
const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const WA = { channel: 'whatsapp', waitMinutes: 0, template: 'welcome', params: ['{first_name}'] };
const MAIL = { channel: 'email', waitMinutes: 1440, subject: 'Hello {name}', body: 'Hi {first_name}' };
const TASK = { channel: 'task', waitMinutes: 2880, taskName: 'Call {name}' };
const enrollment = (leadId: string) => inCo(async () => (await col<any>('dripEnrollments')).findOne({ leadId }));
const logs = () => inCo(async () => (await col<any>('dripLogs')).find({}).sort({ at: 1 }).toArray());
let n = 0;
const newLead = (fields: Record<string, string> = {}) => inCo(async () => (await addLead({ 'Prospect Name': 'Ravi Kumar', 'Phone Number': `98765${String(10000 + n++)}`, Email: `ravi${n}@example.com`, 'Enquiry Source': 'Facebook', ...fields } as any, null)).id);
const due = (leadId: string) => inCo(async () => (await col<any>('dripEnrollments')).updateOne({ leadId }, { $set: { nextAt: new Date(noon.getTime() - 1000) } }));
const run = (now = noon) => inCo(() => runDripDue(now));
const running = async (steps: any[] = [WA, MAIL, TASK], extra: any = {}) => {
  const { id } = await inCo(() => saveDripCampaign({ name: 'Welcome', steps, ...extra }, ctx));
  await inCo(() => testDripCampaign({ id, phone: '+91 90000 00000', email: 'me@example.com' }, ctx));
  await inCo(() => setDripStatus({ id, status: 'active' }, ctx));
  chatSend.mockClear();
  mailSend.mockClear();
  return id;
};

beforeAll(async () => {
  process.env.APP_URL = 'https://crm.example.com';
  t = await startTestDb();
});
afterAll(async () => {
  delete process.env.APP_URL;
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  await t.company('test', { dripCampaigns: true, chat360: true });
  chatSend.mockReset();
  chatSend.mockImplementation(async () => ({ message: {} }));
  mailSend.mockReset();
  mailSend.mockImplementation(async () => ({}));
  await inCo(async () => {
    const { encryptSecret } = await import('../server/core/settings');
    await (await col<any>(CFG.COLL.SETTINGS)).updateOne({ _id: 'CHAT360_API_KEY' }, { $set: { value: encryptSecret('AbCd.key') } }, { upsert: true }).catch(() => undefined);
    await saveDripEmail({ host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', fromName: 'Amaya', fromEmail: 'hello@amaya.example' }, ctx);
  });
  vi.spyOn(await import('../server/core/settings'), 'getSecret').mockImplementation(async (k: string) => (k === 'CHAT360_API_KEY' ? 'AbCd.key' : '') as any);
});

describe('campaign rules', () => {
  it('starts as a draft, needs a test, and any change asks for a new test', async () => {
    const { id } = await inCo(() => saveDripCampaign({ name: 'Welcome', steps: [WA] }, ctx));
    await expect(inCo(() => setDripStatus({ id, status: 'active' }, ctx))).rejects.toThrow(/test first/);
    expect((await inCo(() => testDripCampaign({ id, phone: '+91 90000 00000' }, ctx))).passed).toBe(true);
    await inCo(() => saveDripCampaign({ id, name: 'Welcome 2', steps: [WA] }, ctx));
    await expect(inCo(() => setDripStatus({ id, status: 'active' }, ctx))).rejects.toThrow(/test first/);
    await inCo(() => testDripCampaign({ id, phone: '+91 90000 00000' }, ctx));
    await inCo(() => setDripStatus({ id, status: 'active' }, ctx));
    await expect(inCo(() => saveDripCampaign({ id, name: 'Changed', steps: [WA] }, ctx))).rejects.toThrow(/Pause/);
  });

  it('a failed test does not count', async () => {
    const { id } = await inCo(() => saveDripCampaign({ name: 'W', steps: [WA] }, ctx));
    chatSend.mockRejectedValueOnce(new Error('No such template'));
    const r = await inCo(() => testDripCampaign({ id, phone: '+91 90000 00000' }, ctx));
    expect(r).toMatchObject({ passed: false });
    expect(r.results[0].message).toContain('No such template');
    await expect(inCo(() => setDripStatus({ id, status: 'active' }, ctx))).rejects.toThrow(/test first/);
  });

  it('refuses incomplete steps and a channel that is not set up', async () => {
    await expect(inCo(() => saveDripCampaign({ name: 'X', steps: [] }, ctx))).rejects.toThrow(/1 to 10/);
    await expect(inCo(() => saveDripCampaign({ name: 'X', steps: [{ channel: 'whatsapp' }] }, ctx))).rejects.toThrow(/template/);
    await expect(inCo(() => saveDripCampaign({ name: 'X', steps: [{ channel: 'email', subject: 'a' }] }, ctx))).rejects.toThrow(/text/);
    await expect(inCo(() => saveDripCampaign({ name: 'X', steps: [WA], hoursFrom: 20, hoursTo: 9 }, ctx))).rejects.toThrow(/hours/);
    await t.company('test', { dripCampaigns: true, chat360: false });
    const { id } = await inCo(() => saveDripCampaign({ name: 'W', steps: [{ channel: 'task', taskName: 'Call' }, WA] }, ctx));
    await inCo(async () => (await col<any>('dripCampaigns')).updateOne({ _id: id }, { $set: { testedAt: new Date() } }));
    await expect(inCo(() => setDripStatus({ id, status: 'active' }, ctx))).rejects.toThrow(/plan/);
  });

  it('a mail server inside the network is refused', async () => {
    await expect(inCo(() => saveDripEmail({ host: 'inside.example.com', port: 587, user: 'u', pass: 'p', fromEmail: 'a@b.example' }, ctx))).rejects.toThrow(/not a public/);
    await expect(inCo(() => saveDripEmail({ host: '10.0.0.5', port: 587, user: 'u', pass: 'p', fromEmail: 'a@b.example' }, ctx))).rejects.toThrow(/as a name/);
    await expect(inCo(() => saveDripEmail({ host: 'smtp.example.com', port: 22, user: 'u', pass: 'p', fromEmail: 'a@b.example' }, ctx))).rejects.toThrow(/port/);
  });

  it('the screen never shows the mail password', async () => {
    const r = await inCo(() => getDrip({ user: { role: 'Admin' } } as any));
    expect(r.mail).toMatchObject({ host: 'smtp.example.com', passSet: true });
    expect(JSON.stringify(r)).not.toMatch(/"pass"/);
    expect((await inCo(() => getDrip({ user: { role: 'Manager' } } as any))).mail).toBeNull();
  });
});

describe('stage trigger', () => {
  it('a campaign targeting a stage starts a lead the moment it reaches that stage, not on creation', async () => {
    await running([WA], { stages: ['Warm'] });
    const id = await newLead(); // created as New → a stage campaign does not start it yet
    expect(await enrollment(id)).toBeNull();
    await inCo(() => updateLead(id, { 'Lead Stage': 'Warm' } as any, null)); // reaches Warm → joins now
    expect(await enrollment(id)).toMatchObject({ status: 'active', stepIndex: 0 });
  });

  it('a stage campaign respects the source filter and does not start on an unrelated stage', async () => {
    await running([WA], { stages: ['Warm'], sources: ['Website'] });
    const other = await newLead({ 'Enquiry Source': 'Facebook' });
    await inCo(() => updateLead(other, { 'Lead Stage': 'Warm' } as any, null)); // right stage, wrong source
    expect(await enrollment(other)).toBeNull();
    const web = await newLead({ 'Enquiry Source': 'Website' });
    await inCo(() => updateLead(web, { 'Lead Stage': 'Hot' } as any, null)); // right source, wrong stage
    expect(await enrollment(web)).toBeNull();
    await inCo(() => updateLead(web, { 'Lead Stage': 'Warm' } as any, null)); // both match → joins
    expect(await enrollment(web)).toMatchObject({ status: 'active' });
  });
});

describe('who joins', () => {
  it('a new lead joins an active campaign, not a draft, and only with the right source', async () => {
    const { id: draft } = await inCo(() => saveDripCampaign({ name: 'Draft', steps: [WA] }, ctx));
    expect(draft).toBeTruthy();
    expect(await enrollment(await newLead())).toBeNull();
    await running([WA], { sources: ['Website'] });
    expect(await enrollment(await newLead({ 'Enquiry Source': 'Facebook' }))).toBeNull();
    expect(await enrollment(await newLead({ 'Enquiry Source': 'website' }))).toMatchObject({ status: 'active', stepIndex: 0 });
  });

  it('the same person is never in two campaigns at once', async () => {
    await running([WA]);
    const phone = '9876512121';
    const first = await newLead({ 'Phone Number': phone });
    const second = await inCo(async () => (await addLead({ 'Prospect Name': 'Ravi', 'Phone Number': phone, 'Enquiry Source': 'Facebook' } as any, null, { allowDuplicate: true } as any)).id);
    expect(await enrollment(first)).toBeTruthy();
    expect(await enrollment(second)).toBeNull();
  });

  it('nothing happens without the feature, and bulk imports do not join', async () => {
    await running([WA]);
    const { importLeads } = await import('../server/modules/leads');
    await inCo(() => importLeads([{ 'Prospect Name': 'Imported', 'Phone Number': '9876599999', 'Enquiry Source': 'Facebook' } as any], 'SKIP', null));
    expect(await inCo(async () => (await col<any>('dripEnrollments')).countDocuments({}))).toBe(0);
    await t.company('test', { dripCampaigns: false, chat360: true });
    expect(await enrollment(await newLead())).toBeNull();
  });
});

describe('sending', () => {
  it('a WhatsApp step with a header attachment sends it to the template as a link', async () => {
    await running([{ ...WA, attachments: ['FILE1'] }]);
    const id = await newLead();
    await due(id);
    await run();
    expect(chatSend).toHaveBeenCalledTimes(1);
    const arg = (chatSend.mock.calls[0] as any)[0];
    expect(arg.params[0]).toMatch(/^link=https?:\/\/\S+\/api\/public\/media\/\S*FILE1/); // the media link comes first
    expect(arg.params).toContain('Ravi'); // the body value is still sent
  });

  it('goes step by step, with each wait, filling in the details', async () => {
    await running();
    const id = await newLead();
    // Enrolment is stamped with the real clock; the worker runs on the fixed `noon`. Put the first step on the
    // worker's clock so the test does not depend on what day it runs (it failed on any day after 10 Nov 2026).
    await due(id);
    await run();
    expect(chatSend).toHaveBeenCalledTimes(1);
    expect((chatSend.mock.calls[0] as any)[0]).toMatchObject({ templateName: 'welcome', params: ['Ravi'], leadId: id });
    const en = await enrollment(id);
    expect(en.stepIndex).toBe(1);
    expect(en.nextAt.getTime()).toBe(noon.getTime() + 1440 * 60000);
    await run(); // not due yet
    expect(mailSend).not.toHaveBeenCalled();

    await due(id);
    await run();
    expect(mailSend).toHaveBeenCalledTimes(1);
    const mail = (mailSend.mock.calls[0] as any)[0];
    expect(mail.subject).toBe('Hello Ravi Kumar');
    expect(mail.text).toContain('Hi Ravi');
    expect(mail.text).toContain('/api/public/unsubscribe?');
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    await due(id);
    await run();
    expect((await enrollment(id)).status).toBe('completed');
    expect(await inCo(async () => (await col<any>(CFG.COLL.TASKS)).countDocuments({ leadId: id, name: 'Call Ravi Kumar' }))).toBe(1);
    expect((await logs()).map((l: any) => l.status)).toEqual(['sent', 'sent', 'sent']);
  });

  it('waits for the sending hours, in India time', async () => {
    await running([WA]);
    const id = await newLead();
    const night = new Date('2026-11-10T17:30:00Z'); // 23:00 in India
    await due(id);
    await run(night);
    expect(chatSend).not.toHaveBeenCalled();
    expect((await enrollment(id)).nextAt.toISOString()).toBe('2026-11-11T03:30:00.000Z'); // 09:00 next morning
    expect(nextOpen(new Date('2026-11-10T01:00:00Z'), 9, 20).toISOString()).toBe('2026-11-10T03:30:00.000Z');
    expect(nextOpen(noon, 9, 20)).toBe(noon);
  });

  it('holds to the daily limit', async () => {
    await running([WA], { dailyLimit: 1 });
    const a = await newLead(), b = await newLead();
    await due(a);
    await due(b);
    const r = await run();
    expect(chatSend).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sent: 1, limit: 1 });
  });

  it('skips a step it cannot send, says why, and carries on', async () => {
    await running([MAIL, { ...WA, waitMinutes: 1440 }]);
    const id = await inCo(async () => (await addLead({ 'Prospect Name': 'No Mail', 'Phone Number': '9876533333', 'Enquiry Source': 'Facebook' } as any, null)).id);
    await due(id);
    await run();
    expect((await logs())[0]).toMatchObject({ status: 'skipped', detail: 'No e-mail address.' });
    expect((await enrollment(id)).stepIndex).toBe(1);
  });

  it('a failed send tries 3 times, an hour apart, then moves on and says why', async () => {
    await running([WA, { ...MAIL, waitMinutes: 60 }]);
    const id = await newLead();
    chatSend.mockRejectedValue(new Error('Chat360 is down'));
    await due(id);
    await run();
    expect(await enrollment(id)).toMatchObject({ attempts: 1, stepIndex: 0, sendingStep: '' });
    await due(id);
    await run();
    await due(id);
    await run();
    expect(chatSend).toHaveBeenCalledTimes(3);
    expect(await enrollment(id)).toMatchObject({ stepIndex: 1, attempts: 0 });
    expect((await logs())[0]).toMatchObject({ status: 'failed', detail: 'Chat360 is down' });
  });

  it('a step a dead run may have sent is never sent again', async () => {
    const campaign = await running([WA, { ...MAIL, waitMinutes: 60 }]);
    const id = await newLead();
    const stepId = (await inCo(async () => (await col<any>('dripCampaigns')).findOne({ _id: campaign }))).steps[0].id;
    await inCo(async () => (await col<any>('dripEnrollments')).updateOne({ leadId: id }, { $set: { sendingStep: stepId } }));
    await due(id);
    await run();
    expect(chatSend).not.toHaveBeenCalled();
    expect((await enrollment(id)).stepIndex).toBe(1);
    expect((await logs())[0].detail).toMatch(/not repeated/);
  });

  it('two runs at once take a step only once', async () => {
    await running([WA]);
    const id = await newLead();
    await due(id);
    await Promise.all([run(), run()]);
    expect(chatSend).toHaveBeenCalledTimes(1);
  });

  it('a paused campaign sends nothing, and carries on when started again', async () => {
    const campaign = await running([WA]);
    const id = await newLead();
    await inCo(() => setDripStatus({ id: campaign, status: 'paused' }, ctx));
    await due(id);
    await run();
    expect(chatSend).not.toHaveBeenCalled();
    await inCo(() => setDripStatus({ id: campaign, status: 'active' }, ctx));
    await run();
    expect(chatSend).toHaveBeenCalledTimes(1);
  });

  it('archiving stops the leads in it', async () => {
    const campaign = await running([WA]);
    const id = await newLead();
    await inCo(() => setDripStatus({ id: campaign, status: 'archived' }, ctx));
    expect(await enrollment(id)).toMatchObject({ status: 'stopped', nextAt: null });
    await expect(inCo(() => setDripStatus({ id: campaign, status: 'active' }, ctx))).rejects.toThrow(/archived/);
  });
});

describe('stopping', () => {
  const inbound = (phone: string, text: string, at: Date) => inCo(async () => (await col<any>(CFG.COLL.CHAT_MESSAGES)).insertOne({ _id: `M${Math.random()}` as any, phoneLast10: phone, direction: 'Inbound', text, timestamp: at }));

  it.each([['Booked'], ['Lost'], ['Disqualified - Budget']])('stops when the lead becomes %s', async (stage) => {
    await running([WA]);
    const id = await newLead();
    await inCo(() => updateLead(id, { 'Lead Stage': stage } as any, null));
    await due(id);
    await run();
    expect(chatSend).not.toHaveBeenCalled();
    expect((await enrollment(id)).status).toBe('stopped');
  });

  it('stops on a site visit, unless told not to', async () => {
    await running([WA]);
    const id = await newLead();
    await inCo(() => updateLead(id, { 'Site Visit Status': CFG.SITE_VISIT.SCHEDULED } as any, null));
    await due(id);
    await run();
    expect((await enrollment(id)).status).toBe('stopped');
  });

  it('a WhatsApp reply stops it, so a person takes over', async () => {
    await running([WA]);
    const phone = '9876544444';
    const id = await newLead({ 'Phone Number': phone });
    await inbound(phone, 'Yes please send details', new Date(Date.now() + 1000));
    await due(id);
    await run();
    expect(chatSend).not.toHaveBeenCalled();
    expect((await enrollment(id)).stopReason).toMatch(/replied/);
  });

  it('STOP is kept for good, across campaigns', async () => {
    await running([WA]);
    const phone = '9876555555';
    const first = await newLead({ 'Phone Number': phone });
    await inbound(phone, ' stop! ', new Date(Date.now() + 1000));
    await due(first);
    await run();
    expect(await inCo(async () => (await col<any>('dripOptOuts')).findOne({ _id: `whatsapp:${phone}` }))).toBeTruthy();
    const again = await inCo(async () => (await addLead({ 'Prospect Name': 'Ravi', 'Phone Number': phone, 'Enquiry Source': 'Facebook' } as any, null, { allowDuplicate: true } as any)).id);
    await due(again);
    await run();
    expect(chatSend).not.toHaveBeenCalled();
    expect((await enrollment(again)).status).toBe('stopped');
  });

  it('an older message does not count as a reply', async () => {
    await running([WA]);
    const phone = '9876566666';
    await inbound(phone, 'Hello', new Date(Date.now() - 86400000));
    const id = await newLead({ 'Phone Number': phone });
    await due(id);
    await run();
    expect(chatSend).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing stops the e-mails only, and the link is signed', async () => {
    await running([MAIL, { ...WA, waitMinutes: 60 }]);
    const id = await newLead({ Email: 'Stop.Me@Example.com' });
    const url = new URL(await inCo(async () => unsubscribeUrl('stop.me@example.com')));
    expect(unsubSigOk('CMP-test', 'stop.me@example.com', url.searchParams.get('s')!)).toBe(true);
    expect(unsubSigOk('CMP-test', 'other@example.com', url.searchParams.get('s')!)).toBe(false);
    expect(unsubSigOk('CMP-other', 'stop.me@example.com', url.searchParams.get('s')!)).toBe(false);
    await inCo(() => unsubscribeEmail('Stop.Me@example.com'));
    await due(id);
    await run();
    expect(mailSend).not.toHaveBeenCalled();
    expect((await logs())[0].detail).toMatch(/unsubscribed/);
    await due(id);
    await run();
    expect(chatSend).toHaveBeenCalledTimes(1);
  });
});

describe('small rules and who', () => {
  it('fills only known details, leaving others to be seen', () => {
    expect(fillVars('Hi {name}, {nope}', { name: 'Ravi' })).toBe('Hi Ravi, {nope}');
  });

  it('Admins and Managers can use it, RMs cannot; the mail account is Admin only; the feature is needed', async () => {
    const base = { userAgent: 'vitest', ip: '10.9.9.9' };
    const session = (role: 'Admin' | 'Manager' | 'RM') => inCo(async () => {
      const email = `${role.toLowerCase()}@drip.test`;
      await createUser({ name: role, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
      return (await login(email, 'long-enough-pw', base)).token;
    });
    const admin = await session('Admin'), manager = await session('Manager'), rm = await session('RM');
    const call = (a: string, d: any, token: string) => inCo(() => dispatch(a, d, { ...base, token }));
    expect((await call('getDrip', {}, manager)).status).toBe(200);
    expect((await call('getDrip', {}, rm)).status).toBe(403);
    expect((await call('saveDripEmail', { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', fromEmail: 'a@b.example' }, manager)).status).toBe(403);
    expect((await call('saveDripEmail', { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', fromEmail: 'a@b.example' }, admin)).status).toBe(200);
    await t.company('test', { dripCampaigns: false });
    expect((await call('getDrip', {}, admin)).status).toBe(403);
  });
});

describe('results', () => {
  it('counts replies after joining, site visits and bookings, per campaign', async () => {
    const id = await running([WA]);
    const a = await newLead();
    const b = await newLead();
    const c = await newLead();
    const stats = async () => (await inCo(() => getDrip(ctx))).campaigns.find((x: any) => x.id === id)!.stats;
    expect(await stats()).toMatchObject({ entered: 3, replied: 0, visits: 0, bookings: 0 });
    const enA = await enrollment(a);
    await inCo(async () => {
      const chats = await col<any>(CFG.COLL.CHAT_MESSAGES);
      await chats.insertOne({ _id: 'R1', phoneLast10: enA.phoneLast10, direction: 'Inbound', text: 'Yes please', timestamp: new Date(enA.enrolledAt.getTime() + 60000) });
      const enB = await (await col<any>('dripEnrollments')).findOne({ leadId: b });
      await chats.insertOne({ _id: 'R2', phoneLast10: enB.phoneLast10, direction: 'Inbound', text: 'Before joining', timestamp: new Date(enB.enrolledAt.getTime() - 60000) });
      const leads = await col<any>(CFG.COLL.LEADS);
      await leads.updateOne({ _id: b }, { $set: { siteVisitStatus: CFG.SITE_VISIT.COMPLETED } });
      await leads.updateOne({ _id: c }, { $set: { stage: CFG.STAGES.BOOKED } });
    });
    expect(await stats()).toMatchObject({ entered: 3, replied: 1, visits: 1, bookings: 1 });
  });
});
