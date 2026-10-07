/** Instant lead alerts: settings validation, recipients, e-mail content, auto WhatsApp template, scheduling. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({ messageId: 'm1' }));
/** Alerts queued with next/server `after` are recorded instead of run, so each test drives sending itself. */
const queued: Array<() => unknown> = [];
vi.mock('next/server', () => ({ after: (fn: () => unknown) => { queued.push(fn); } }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
const chatSend = vi.fn(async () => ({ message: { id: 'wa1' } }));
vi.mock('../server/modules/chat360', async (orig) => ({ ...(await orig<typeof import('../server/modules/chat360')>()), send: chatSend }));

import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { setSecret, updateSettings, getSettings } from '../server/core/settings';
import { addLead, updateLead } from '../server/modules/leads';
import { alertEmail, alertRecipients, parseLeadAlerts, renderParams, sendLeadAlerts } from '../server/modules/leadAlerts';
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
  sendMail.mockClear();
  chatSend.mockClear();
  queued.length = 0;
});
afterEach(() => {
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
});

const user = (name: string, email: string, status: 'Active' | 'Disabled' = 'Active') => ({ id: email, name, email, role: 'RM', status }) as unknown as PublicUser;

describe('lead alert rules', () => {
  it('defaults to e-mailing the RM and no WhatsApp', () => {
    expect(parseLeadAlerts(undefined)).toMatchObject({ emailRm: true, whatsappAuto: false, whatsappLanguage: 'en' });
    expect(parseLeadAlerts('{"emailRm":false,"whatsappAuto":"true"}')).toMatchObject({ emailRm: false, whatsappAuto: true });
  });

  it('alerts the active RM (by name) plus listed active users, once each', () => {
    const users = [user('Priya Sharma', 'priya@x.in'), user('Manager', 'mgr@x.in'), user('Old Rep', 'old@x.in', 'Disabled')];
    const cfg = parseLeadAlerts({ emailRm: true, emailAlso: 'mgr@x.in, old@x.in, PRIYA@x.in' });
    expect(alertRecipients(cfg, ' priya sharma ', users).sort()).toEqual(['mgr@x.in', 'priya@x.in']);
    expect(alertRecipients({ ...cfg, emailRm: false, emailAlso: '' }, 'Priya Sharma', users)).toEqual([]);
    expect(alertRecipients(cfg, 'Old Rep', users)).not.toContain('old@x.in');
  });

  it('fills template parameters from the lead', () => {
    const lead = { [L.NAME]: 'Meera Kapoor', [L.UNIT_TYPE]: '2.5 BHK', [L.RM]: 'Priya' };
    expect(renderParams('{first_name}, {unit} at {company}, RM {rm}', lead, 'Amaya')).toEqual(['Meera', '2.5 BHK at Amaya', 'RM Priya']);
    expect(renderParams('', lead, 'Amaya')).toEqual([]);
  });

  it('writes a useful e-mail with a link to the lead', () => {
    const lead = { [L.ID]: 'ENQ-0007', [L.NAME]: 'Meera', [L.PHONE]: '9876543210', [L.SOURCE]: 'Website', [L.NOTES]: 'Wants a site visit' };
    const m = alertEmail(lead, 'created', 'https://crm.test/leads?lead=ENQ-0007', 'Amaya');
    expect(m.subject).toBe('New lead: Meera · Website');
    expect(m.text).toContain('Phone: 9876543210');
    expect(m.text).toContain('Wants a site visit');
    expect(m.text).toContain('https://crm.test/leads?lead=ENQ-0007');
    expect(alertEmail(lead, 'assigned', 'x', '').subject).toBe('Lead assigned to you: Meera');
  });
});

describe('lead alert settings', () => {
  it('only accepts active CRM users as extra recipients and a valid template name', async () => {
    await expect(updateSettings({ leadAlerts: { emailAlso: 'outsider@gmail.com' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ leadAlerts: { whatsappAuto: true, whatsappTemplate: 'Bad Name!' } }, admin)).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await updateSettings({ leadAlerts: { emailRm: true, emailAlso: rm.user!.email, whatsappAuto: true, whatsappTemplate: 'welcome_v1' } }, admin);
    expect(s.leadAlerts).toMatchObject({ emailRm: true, emailAlso: rm.user!.email, whatsappAuto: true, whatsappTemplate: 'welcome_v1' });
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
  it('e-mails the assigned RM for a new lead and sends the WhatsApp template', async () => {
    await updateSettings({ leadAlerts: { whatsappAuto: true, whatsappTemplate: 'welcome_v1', whatsappParams: '{first_name}' } }, admin);
    await setSecret('CHAT360_API_KEY', 'test-key', admin);
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '+91 98765 43210', [L.RM]: 'Priya Sharma', [L.SOURCE]: 'Website' }, admin);
    const r = await sendLeadAlerts(lead, 'created');
    expect(r).toEqual({ emailed: 1, whatsapp: true });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: rm.user!.email, subject: 'New lead: Meera Kapoor · Website' }));
    expect(chatSend).toHaveBeenCalledWith(expect.objectContaining({ templateName: 'welcome_v1', params: ['Meera'], leadId: lead[L.ID] }), expect.anything());
  });

  it('a reassignment e-mails only (no WhatsApp) and nothing is sent without SMTP', async () => {
    await updateSettings({ leadAlerts: { whatsappAuto: true, whatsappTemplate: 'welcome_v1' } }, admin);
    await setSecret('CHAT360_API_KEY', 'test-key', admin);
    const { lead } = await addLead({ [L.NAME]: 'Rajiv', [L.PHONE]: '9876500002' }, admin);
    const { lead: after } = await updateLead(lead[L.ID], { [L.RM]: 'Priya Sharma' }, admin);
    expect(await sendLeadAlerts(after, 'assigned')).toEqual({ emailed: 1, whatsapp: false });
    delete process.env.SMTP_URL;
    sendMail.mockClear();
    expect((await sendLeadAlerts(after, 'assigned')).emailed).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('never throws when the provider fails', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP down'));
    const { lead } = await addLead({ [L.NAME]: 'Sunita', [L.PHONE]: '9876500003', [L.RM]: 'Priya Sharma' }, admin);
    await expect(sendLeadAlerts(lead, 'created')).resolves.toEqual({ emailed: 0, whatsapp: false });
  });
});
