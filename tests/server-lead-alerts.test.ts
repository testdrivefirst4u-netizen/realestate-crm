/** Instant lead alerts (free only): settings, recipients, phone notification + e-mail content, sending, scheduling. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({ messageId: 'm1' }));
/** Alerts queued with next/server `after` are recorded instead of run, so each test drives sending itself. */
const queued: Array<() => unknown> = [];
vi.mock('next/server', () => ({ after: (fn: () => unknown) => { queued.push(fn); } }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
const pushSent: Array<{ endpoint: string; body: any }> = [];
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, body: string) => { pushSent.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); return { statusCode: 201 }; },
  },
}));
const chatSend = vi.fn(async () => ({ message: { id: 'wa1' } }));
vi.mock('../server/modules/chat360', async (orig) => ({ ...(await orig<typeof import('../server/modules/chat360')>()), send: chatSend }));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { updateSettings, getSettings } from '../server/core/settings';
import { addLead, updateLead } from '../server/modules/leads';
import { alertEmail, alertPush, alertRecipients, parseLeadAlerts, pushRecipients, sendLeadAlerts } from '../server/modules/leadAlerts';
import { pushSubscribe } from '../server/modules/push';
import type { Ctx, PublicUser } from '../server/core/auth';

const L = CFG.LEAD;
let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;
let rm: Ctx;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
  rm = await t.ctx('RM', 'Priya Sharma');
  process.env.SMTP_URL = 'smtp://localhost:2525';
  process.env.MAIL_FROM = 'crm@test.local';
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  sendMail.mockClear();
  chatSend.mockClear();
  pushSent.length = 0;
  queued.length = 0;
});
afterEach(() => {
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

const user = (name: string, email: string, status: 'Active' | 'Disabled' = 'Active') => ({ id: email, name, email, role: 'RM', status }) as unknown as PublicUser;
const device = (n: number) => ({ subscription: { endpoint: `https://push.example/dev${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } });

describe('lead alert rules', () => {
  it('defaults to a phone notification and an e-mail to the RM; old WhatsApp settings are ignored', () => {
    expect(parseLeadAlerts(undefined)).toEqual({ pushRm: true, emailRm: true, emailAlso: '' });
    expect(parseLeadAlerts('{"emailRm":false,"pushRm":"false","whatsappAuto":true,"whatsappRm":true}')).toEqual({ pushRm: false, emailRm: false, emailAlso: '' });
  });

  it('alerts the active RM (by name) plus listed active users, once each', () => {
    const users = [user('Priya Sharma', 'priya@x.in'), user('Manager', 'mgr@x.in'), user('Old Rep', 'old@x.in', 'Disabled')];
    const cfg = parseLeadAlerts({ emailRm: true, emailAlso: 'mgr@x.in, old@x.in, PRIYA@x.in' });
    expect(alertRecipients(cfg, ' priya sharma ', users).sort()).toEqual(['mgr@x.in', 'priya@x.in']);
    expect(alertRecipients({ ...cfg, emailRm: false, emailAlso: '' }, 'Priya Sharma', users)).toEqual([]);
    expect(pushRecipients(cfg, 'Priya Sharma', users).sort()).toEqual(['mgr@x.in', 'priya@x.in']);
    expect(pushRecipients({ ...cfg, pushRm: false }, 'Priya Sharma', users).sort()).toEqual(['mgr@x.in', 'priya@x.in']); // priya is also on the list
    expect(pushRecipients({ ...cfg, pushRm: false, emailAlso: '' }, 'Priya Sharma', users)).toEqual([]);
  });

  it('writes a useful notification and e-mail with a link to the lead', () => {
    const lead = { [L.ID]: 'ENQ-0007', [L.NAME]: 'Meera', [L.PHONE]: '9876543210', [L.SOURCE]: 'Website', [L.UNIT_TYPE]: '2 BHK', [L.RM]: 'Priya', [L.NOTES]: 'Wants a site visit' };
    expect(alertPush(lead, 'created')).toEqual({ title: 'New lead: Meera', body: 'Website · 2 BHK · RM Priya\nCall 9876543210', url: '/leads?lead=ENQ-0007', tag: 'lead-ENQ-0007' });
    expect(alertPush(lead, 'assigned').title).toBe('Lead assigned to you: Meera');
    const m = alertEmail(lead, 'created', 'https://crm.test/leads?lead=ENQ-0007', 'Amaya');
    expect(m.subject).toBe('New lead: Meera · Website');
    expect(m.text).toContain('Phone: 9876543210');
    expect(m.text).toContain('Wants a site visit');
    expect(m.text).toContain('https://crm.test/leads?lead=ENQ-0007');
  });
});

describe('lead alert settings', () => {
  it('only accepts active CRM users as extra recipients', async () => {
    await expect(updateSettings({ leadAlerts: { emailAlso: 'outsider@gmail.com' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await updateSettings({ leadAlerts: { pushRm: false, emailRm: true, emailAlso: rm.user!.email } }, admin);
    expect(s.leadAlerts).toEqual({ pushRm: false, emailRm: true, emailAlso: rm.user!.email });
    expect((await getSettings(admin)).mailConfigured).toBe(true);
  });
});

describe('scheduling', () => {
  it('queues one alert when a lead is created and one when it is reassigned (not for other edits)', async () => {
    const { lead } = await addLead({ [L.NAME]: 'Kavya', [L.PHONE]: '9876500009' }, admin);
    expect(queued).toHaveLength(1);
    await updateLead(lead[L.ID], { [L.UNIT_TYPE]: '3 BHK' }, admin);
    expect(queued).toHaveLength(1);
    await updateLead(lead[L.ID], { [L.RM]: 'Priya Sharma' }, admin);
    expect(queued).toHaveLength(2);
  });
});

describe('sending', () => {
  it('notifies the RM on every device and e-mails them — never WhatsApp', async () => {
    await pushSubscribe(device(1), rm);
    await pushSubscribe(device(2), rm);
    await pushSubscribe(device(3), admin); // not the RM, not on the list
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '+91 98765 43210', [L.RM]: 'Priya Sharma', [L.SOURCE]: 'Website' }, admin);
    expect(await sendLeadAlerts(lead, 'created')).toEqual({ emailed: 1, pushed: 2 });
    expect(pushSent.map((p) => p.endpoint).sort()).toEqual(['https://push.example/dev1', 'https://push.example/dev2']);
    expect(pushSent[0].body).toMatchObject({ title: 'New lead: Meera Kapoor', url: `/leads?lead=${lead[L.ID]}` });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: rm.user!.email, subject: 'New lead: Meera Kapoor · Website' }));
    expect(chatSend).not.toHaveBeenCalled();
  });

  it('a reassignment notifies the new RM; without SMTP only the phone notification goes', async () => {
    await pushSubscribe(device(1), rm);
    const { lead } = await addLead({ [L.NAME]: 'Rajiv', [L.PHONE]: '9876500002' }, admin);
    const { lead: after } = await updateLead(lead[L.ID], { [L.RM]: 'Priya Sharma' }, admin);
    delete process.env.SMTP_URL;
    expect(await sendLeadAlerts(after, 'assigned')).toEqual({ emailed: 0, pushed: 1 });
    expect(pushSent[0].body.title).toBe('Lead assigned to you: Rajiv');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('never throws when a provider fails', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP down'));
    const { lead } = await addLead({ [L.NAME]: 'Sunita', [L.PHONE]: '9876500003', [L.RM]: 'Priya Sharma' }, admin);
    await expect(sendLeadAlerts(lead, 'created')).resolves.toEqual({ emailed: 0, pushed: 0 });
  });
});
