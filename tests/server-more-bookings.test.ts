/** Phones hidden from a role, slow first response, export alerts, duplicates across phone and e-mail, and results by ad. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { createUser, login } from '../server/core/auth';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { blankLeadDoc } from '../server/core/leadShape';
import { hidePhone, hidePhonesDeep, hidePhonesInText, revealPhonesDeep } from '../server/core/phoneMask';
import { clearRoleAccessCache, phonesHiddenFromSomeone } from '../server/core/roleAccess';
import { settingSet } from '../server/core/settings';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { dispatch } from '../server/router';
import { alertEmail, alertPush } from '../server/modules/leadAlerts';
import { mergeLeads } from '../server/modules/leadMerge';
import { logLeadExport } from '../server/modules/leadExports';
import { saveRoleAccess } from '../server/modules/roleAccess';
import { alertSlowResponse, parseSalesOps, runLeadWatch, slowNewLeads } from '../server/modules/salesOps';
import { findDuplicateGroups } from '../src/modules/leads/DuplicatesModal';
import { adResultRows, type MisLead } from '../src/modules/mis/misData';
import { isMaskedPhone, last10, phoneProblem, samePhone, telLink, whatsappLink } from '../src/core/phone';

const pushed = vi.hoisted(() => vi.fn(async () => ({ sent: 1, removed: 0 })));
vi.mock('../server/modules/push', async (orig) => ({ ...(await orig<any>()), sendPush: pushed }));

let t: Awaited<ReturnType<typeof startTestDb>>;
const base = { userAgent: 'vitest', ip: '10.9.9.9' };
const adminCtx = { user: { name: 'Boss', role: 'Admin', id: 'U-admin' } } as any;
const noon = new Date('2026-11-10T06:30:00Z'); // 12:00 in India
const NUMBER = '9876501234';
const inCo = async <T>(fn: () => Promise<T>, id = 'CMP-test') => {
  invalidateTenant();
  return runWithTenant((await getTenantById(id))!, fn);
};
const session = (role: 'Admin' | 'Manager' | 'RM' | 'Viewer', name: string = role) => inCo(async () => {
  const email = `${name.toLowerCase()}@bookings.test`;
  await createUser({ name, email, password: 'long-enough-pw', role, mustChangePassword: false }, null);
  return (await login(email, 'long-enough-pw', base)).token;
});
const call = async (action: string, data: any, token: string) => (await inCo(() => dispatch(action, data, { ...base, token }))) as any;
const putLead = (id: string, patch: Record<string, unknown> = {}) => inCo(async () => {
  await (await col<any>('leads')).insertOne({ ...blankLeadDoc(id), name: id, phone: NUMBER, phoneLast10: NUMBER, assignedRm: 'Asha', createdAt: noon, updatedAt: noon, ...patch });
});
const hideFromAgents = () => inCo(() => saveRoleAccess({ config: { RM: { 'leads.phones': false } } }, adminCtx));

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.reset();
  await t.company('test', { chat360: true, reports: true });
  clearRoleAccessCache();
  pushed.mockClear();
});

describe('hiding a number', () => {
  it('leaves none of the number readable, and the same person always looks the same', () => inCo(async () => {
    const h = hidePhone('+91 98765 01234');
    expect(h.replace(/[^\d•]/g, '')).toBe('98•••••34');
    expect(hidePhone('09876501234')).toBe(h);
    expect(hidePhone('919876501234')).toBe(h);
    expect(hidePhone('9876501235')).not.toBe(h);
  }));

  it('comes back as the real number only for the company that hid it', async () => {
    const h = await inCo(async () => hidePhone(NUMBER));
    expect(await inCo(async () => revealPhonesDeep({ phone: h }))).toEqual({ phone: NUMBER });
    await t.company('other', {});
    await expect(inCo(async () => revealPhonesDeep({ phone: h }), 'CMP-other')).rejects.toThrow(/hidden/);
  });

  it('refuses a hidden number changed by hand, rather than saving it', () => inCo(async () => {
    const h = hidePhone(NUMBER);
    const flip = h.slice(0, -1) + (h.endsWith('​') ? '‌' : '​');
    expect(() => revealPhonesDeep({ phone: flip })).toThrow(/hidden/);
    expect(() => revealPhonesDeep({ 'Phone Number': '98•••••34' })).toThrow(/hidden/);
  }));

  it('keeps a number from another country', () => inCo(async () => {
    const h = hidePhonesDeep({ phone: '+971 50 123 4567' }).phone;
    expect(h).not.toContain('123');
    expect(revealPhonesDeep({ phone: h }).phone).toBe('+971501234567');
  }));

  it('finds numbers in text and leaves ids, dates and links alone', () => inCo(async () => {
    expect(hidePhonesInText('Call 98765 01234 or +91-98765-01235 today')).not.toMatch(/987|01234|01235/);
    const untouched = { id: 'ENQ-A9876501234', fileId: 'a9876501234b', meta: '1469075678489909', when: '2026-11-06T10:00:00Z', at: new Date(0), n: 9876501234, link: 'https://x.example/a_9876501234_n.jpg' };
    expect(hidePhonesDeep(untouched)).toEqual(untouched);
  }));
});

describe('an Agent with See phone numbers off', () => {
  it('gets no real number from any answer, but an Admin does', async () => {
    const admin = await session('Admin', 'Boss');
    const agent = await session('RM', 'Asha');
    await putLead('ENQ-1', { notes: 'Alternate 9000012345', extra: { 'Other phone': '9000054321' }, followups: [{ n: 1, at: noon, text: 'Spoke on 98765 01234', by: 'A' }] });
    await hideFromAgents();
    const raw = JSON.stringify((await call('getAllLeads', {}, agent)).body);
    for (const leak of ['9876501234', '98765 01234', '9000012345', '9000054321']) expect(raw).not.toContain(leak);
    expect(raw).toContain('98•••••34');
    expect(JSON.stringify((await call('getAllLeads', {}, admin)).body)).toContain(NUMBER);
  });

  it('nothing changes for anyone until a company turns it off', async () => {
    const agent = await session('RM', 'Asha');
    await putLead('ENQ-1');
    expect(JSON.stringify((await call('getAllLeads', {}, agent)).body)).toContain(NUMBER);
    expect(await inCo(() => phonesHiddenFromSomeone())).toBe(false);
    await hideFromAgents();
    expect(await inCo(() => phonesHiddenFromSomeone())).toBe(true);
  });

  it('saving a lead with its hidden number does not overwrite the real one', async () => {
    const agent = await session('RM', 'Asha');
    await putLead('ENQ-1');
    await hideFromAgents();
    const lead = (await call('getAllLeads', {}, agent)).body.data.leads[0];
    const shown = lead['Phone Number'];
    expect(isMaskedPhone(shown)).toBe(true);
    const r = await call('updateLead', { id: 'ENQ-1', data: { 'Phone Number': shown, 'Prospect Name': 'Ravi' } }, agent);
    expect(r.status).toBe(200);
    expect(isMaskedPhone(r.body.data.lead['Phone Number'])).toBe(true);
    const saved = await inCo(async () => (await col<any>('leads')).findOne({ _id: 'ENQ-1' }));
    expect(saved.phoneLast10).toBe(NUMBER);
    expect(saved.name).toBe('Ravi');
    const tampered = await call('updateLead', { id: 'ENQ-1', data: { 'Phone Number': '98•••••34' } }, agent);
    expect(tampered.status).toBe(400);
    expect((await inCo(async () => (await col<any>('leads')).findOne({ _id: 'ENQ-1' }))).phoneLast10).toBe(NUMBER);
  });

  it('may still use the WhatsApp chat of a hidden number', async () => {
    const agent = await session('RM', 'Asha');
    await putLead('ENQ-1');
    await hideFromAgents();
    const shown = (await call('getAllLeads', {}, agent)).body.data.leads[0]['Phone Number'];
    expect((await call('chat360MarkRead', { phone: shown }, agent)).status).toBe(200);
  });

  it('still sees their own number in their own account', async () => {
    const agent = await session('RM', 'Asha');
    await hideFromAgents();
    await call('updateProfile', { phone: '9000011111' }, agent);
    expect(JSON.stringify((await call('me', {}, agent)).body)).not.toContain('••');
  });

  it('leaves the number out of alerts sent to mixed groups', () => {
    const lead = { 'Enquiry ID': 'ENQ-1', 'Prospect Name': 'Ravi', 'Phone Number': NUMBER };
    expect(alertPush(lead, 'created').body).toContain(NUMBER);
    expect(alertPush(lead, 'created', true).body).not.toContain(NUMBER);
    expect(alertEmail(lead, 'created', 'https://x', 'Co', true).text).not.toContain(NUMBER);
  });
});

describe('hidden numbers in the browser', () => {
  const H1 = '98•••••34​‌', H2 = '98•••••34‌‍';
  it('can be matched and shown, never dialled', () => {
    expect(samePhone(H1, H1)).toBe(true);
    expect(samePhone(H1, H2)).toBe(false); // same first and last digits, different people
    expect(last10(H1)).not.toBe(last10(H2));
    expect(telLink(H1)).toBe('#');
    expect(whatsappLink(H1)).toBe('#');
    expect(phoneProblem(H1)).toBe('');
  });
});

describe('a new lead left waiting', () => {
  const cfg = parseSalesOps({ responseAlertMin: 15 });
  const given = (mins: number) => new Date(noon.getTime() - mins * 60000);

  it('is off unless chosen', async () => {
    await putLead('ENQ-1', { assignedAt: given(60) });
    expect(parseSalesOps({}).responseAlertMin).toBe(0);
    expect(await inCo(() => slowNewLeads(parseSalesOps({}), noon))).toEqual([]);
    expect((await inCo(() => runLeadWatch(noon))).slow).toEqual({ alerted: 0 });
  });

  it('warns once, the RM and the managers, only after the time is up', async () => {
    await session('RM', 'Asha');
    await session('Manager', 'Mina');
    await putLead('ENQ-1', { assignedAt: given(20) });
    await putLead('ENQ-2', { assignedAt: given(5), phone: '9000012345', phoneLast10: '9000012345' });
    pushed.mockClear();
    expect((await inCo(() => alertSlowResponse(cfg, noon))).alerted).toBe(1);
    expect(pushed).toHaveBeenCalledTimes(1);
    const [ids, body] = pushed.mock.calls[0] as unknown as [string[], { title: string; body: string }];
    expect(ids).toHaveLength(2);
    expect(body.title).toBe('Not called yet: ENQ-1');
    expect(body.body).not.toContain(NUMBER);
    expect((await inCo(() => alertSlowResponse(cfg, noon))).alerted).toBe(0);
  });

  it('warns again for a new hand-over, but not about a lead someone called or moved on', async () => {
    await putLead('ENQ-1', { assignedAt: given(20) });
    await inCo(() => alertSlowResponse(cfg, noon));
    await inCo(async () => (await col<any>('leads')).updateOne({ _id: 'ENQ-1' }, { $set: { assignedAt: given(16) } }));
    expect((await inCo(() => alertSlowResponse(cfg, noon))).alerted).toBe(1);
    await putLead('ENQ-2', { assignedAt: given(20), phone: '9000012345', phoneLast10: '9000012345' });
    await inCo(async () => (await col<any>('calls')).insertOne({ _id: 'C1' as any, leadId: 'ENQ-2' }));
    await putLead('ENQ-3', { assignedAt: given(20), stage: 'Qualified' });
    expect((await inCo(() => slowNewLeads(cfg, noon))).map((r) => r.lead._id)).toEqual(['ENQ-1']);
  });

  it('counts working hours only, and stays quiet at night', async () => {
    const night = new Date('2026-11-10T18:30:00Z'); // midnight in India
    await putLead('ENQ-1', { assignedAt: new Date('2026-11-10T17:30:00Z') }); // 11 PM
    expect(await inCo(() => slowNewLeads(cfg, night))).toEqual([]);
    expect((await inCo(() => alertSlowResponse(cfg, night))).alerted).toBe(0);
    const morning = new Date('2026-11-11T03:50:00Z'); // 9:20 AM, 20 working minutes later
    expect(await inCo(() => slowNewLeads(cfg, morning))).toHaveLength(1);
  });

  it('on the Leads screen, an Agent sees only their own', async () => {
    const asha = await session('RM', 'Asha');
    await session('RM', 'Dev');
    await inCo(() => settingSet('salesOps', JSON.stringify({ responseAlertMin: 15, workStartHour: 0, workEndHour: 24 }), 'test'));
    const old = new Date(Date.now() - 3 * 3600000);
    await putLead('ENQ-1', { assignedAt: old });
    await putLead('ENQ-2', { assignedAt: old, assignedRm: 'Dev', phone: '9000012345', phoneLast10: '9000012345' });
    const r = await call('getSlowLeads', {}, asha);
    expect(r.status).toBe(200);
    expect(r.body.data.minutes).toBe(15);
    expect(r.body.data.rows.map((x: any) => x.id)).toEqual(['ENQ-1']);
  });
});

describe('lead exports', () => {
  const agent = { user: { name: 'Asha', role: 'RM', id: 'U-1' } } as any;
  const alerts = () => inCo(async () => (await col<any>('events')).countDocuments({ type: 'integration_alert' }));
  const logged = () => inCo(async () => (await col<any>(CFG.COLL.AUDIT_LOG)).countDocuments({ action: 'Leads Exported' }));

  it("adds up one person's downloads over the day and tells the Admins once", async () => {
    await inCo(() => logLeadExport({ count: 60, what: 'Leads screen' }, agent, noon));
    expect(await alerts()).toBe(0);
    await inCo(() => logLeadExport({ count: 60, what: 'Leads screen' }, agent, noon));
    expect(await alerts()).toBe(1);
    await inCo(() => logLeadExport({ count: 60, what: 'Leads screen' }, agent, noon));
    expect(await alerts()).toBe(1);
    expect(await logged()).toBe(3);
  });

  it('does not alert about an Admin, or when turned off, and still logs', async () => {
    await inCo(() => logLeadExport({ count: 5000, what: 'x' }, adminCtx, noon));
    await inCo(() => settingSet('salesOps', JSON.stringify({ exportAlertAt: 0 }), 'test'));
    await inCo(() => logLeadExport({ count: 5000, what: 'x' }, agent, noon));
    expect(await alerts()).toBe(0);
    expect(await logged()).toBe(2);
  });

  it('refuses someone who may not export', async () => {
    const viewer = { user: { name: 'V', role: 'Viewer', id: 'U-2' } } as any;
    await expect(inCo(() => logLeadExport({ count: 1 }, viewer, noon))).rejects.toThrow(/cannot export/);
  });
});

describe('duplicates', () => {
  const L = (id: string, phone: string, email = '', stage = 'New') => ({ 'Enquiry ID': id, 'Prospect Name': id, 'Phone Number': phone, Email: email, 'Lead Stage': stage }) as any;

  it('joins the same person across phones and e-mails', () => {
    const g = findDuplicateGroups([L('A', '9876501234', 'a@x.com'), L('B', '9876501234', 'b@x.com'), L('C', '9000012345', 'b@x.com'), L('Z', '9111122222', 'z@x.com')]);
    expect(g).toHaveLength(1);
    expect(g[0].leads.map((l) => l['Enquiry ID']).sort()).toEqual(['A', 'B', 'C']);
    expect(g[0]).toMatchObject({ by: 'both', phones: ['9876501234'], emails: ['b@x.com'], differs: true });
  });

  it('does not join strangers on a form-filler address', () => {
    expect(findDuplicateGroups([L('A', '9876501234', 'na@na.com'), L('B', '9000012345', 'NA@na.com'), L('C', '9111122222', 'test@gmail.com'), L('D', '9222233333', 'test@gmail.com')])).toEqual([]);
  });

  it('says nothing differs when only the format does', () => {
    expect(findDuplicateGroups([L('A', '9876501234', 'a@x.com'), L('B', '+91 98765-01234', 'A@x.com')])[0]).toMatchObject({ by: 'both', differs: false });
  });

  it('merges a chain on the server and keeps the other number and address on the lead', async () => {
    await putLead('A', { email: 'a@x.com' });
    await putLead('B', { email: 'b@x.com' });
    await putLead('C', { phone: '9000012345', phoneLast10: '9000012345', email: 'b@x.com' });
    await inCo(() => mergeLeads('A', ['C', 'B'], adminCtx));
    const kept = await inCo(async () => (await col<any>('leads')).findOne({ _id: 'A' }));
    expect(kept.phone).toBe(NUMBER);
    expect(kept.extra['Other phone']).toBe('9000012345');
    expect(kept.extra['Other e-mail']).toBe('b@x.com');
    expect(await inCo(async () => (await col<any>('leads')).countDocuments({ _id: { $in: ['B', 'C'] } }))).toBe(0);
  });

  it('still refuses a lead with nothing in common', async () => {
    await putLead('A', { email: 'a@x.com' });
    await putLead('B', { phone: '9000012345', phoneLast10: '9000012345', email: 'b@x.com' });
    await expect(inCo(() => mergeLeads('A', ['B'], adminCtx))).rejects.toThrow(/different phone/);
  });
});

describe('results by ad', () => {
  const lead = (ad: string, stage: string, sv = '', campaign = 'C1', adSet = 'S1') => ({ ad, stage, sv, campaign, adSet, day: '2026-11-02', id: ad + stage }) as unknown as MisLead;
  const seen = (l: MisLead) => l.sv === 'done';
  const spend = (name: string, amount: number, campaignName = 'C1', adsetName = 'S1') => ({ name, campaignName, adsetName, spend: amount });

  it("puts spend beside what each ad's leads went on to do", () => {
    const rows = adResultRows([lead('Ad A', 'new'), lead('Ad A', 'qualified'), lead('Ad A', 'booked', 'done')], [spend('Ad A', 3000)], 'ad', seen);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Ad A', spend: 3000, under: 'C1 › S1' });
    expect([rows[0].leads.length, rows[0].qualified.length, rows[0].visits.length, rows[0].booked.length]).toEqual([3, 2, 1, 1]);
  });

  it('keeps ads of the same name in different campaigns apart', () => {
    const rows = adResultRows([lead('Ad A', 'new', '', 'C2')], [spend('Ad A', 100, 'C1'), spend('Ad A', 900, 'C2')], 'ad', seen);
    expect(rows.find((r) => r.spend === 900)!.leads).toHaveLength(1);
    expect(rows.find((r) => r.spend === 100)!.leads).toHaveLength(0);
  });

  it('matches by name alone only when one ad has it', () => {
    expect(adResultRows([lead('Ad A', 'new', '', '', '')], [spend('ad a ', 100)], 'ad', seen)[0].leads).toHaveLength(1);
    const two = adResultRows([lead('Ad A', 'new', '', '', '')], [spend('Ad A', 100, 'C1'), spend('Ad A', 100, 'C2')], 'ad', seen);
    expect(two.filter((r) => r.spend === null)).toHaveLength(1);
  });

  it('shows spend with no leads and leads with no spend, biggest spend first', () => {
    const rows = adResultRows([lead('Renamed', 'new')], [spend('Big', 500), spend('Small', 50), spend('Paused', 0)], 'ad', seen);
    expect(rows.map((r) => [r.name, r.spend])).toEqual([['Big', 500], ['Small', 50], ['Renamed', null]]);
  });

  it('adds up at campaign level', () => {
    const rows = adResultRows([{ ...lead('Ad A', 'new'), campaign: 'C1' }, { ...lead('Ad B', 'new'), campaign: 'C1' }], [{ name: 'C1', campaignName: 'C1', adsetName: '', spend: 700 }], 'campaign', seen);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'C1', spend: 700 });
    expect(rows[0].leads).toHaveLength(2);
  });
});
