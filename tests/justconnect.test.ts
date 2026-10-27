/** JustConnect calling (step 1): key test, CRM user ↔ agent links, click-to-call and its refusals. Fetch is faked. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { setSecret } from '../server/core/settings';
import { updateProfile, type Ctx } from '../server/core/auth';
import { addLead } from '../server/modules/leads';
import { jcAgents, jcCallStatus, jcClickToCall, jcSetAgent, jcTest } from '../server/modules/justconnect';

const L = CFG.LEAD;
let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx, priya: Ctx;
let calls: Array<{ url: string; method: string; body: any; auth: string }> = [];
let respond: (url: string, method: string, body: any) => { status: number; json: unknown } = () => ({ status: 200, json: {} });

const AGENTS = [
  { id: 'ag1', name: 'Priya S', role: 'agent', extension: '1002', email: 'PRIYA@test.local', loginId: 'P1', status: 'online', canCallOut: true },
  { id: 'ag2', name: 'Desk', role: 'agent', extension: '1003', email: 'desk@x.in', loginId: 'D1', status: 'offline', canCallOut: true },
];

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
  admin = await t.ctx('Admin', 'Asha Admin');
  priya = await t.ctx('RM', 'Priya Sharma');
  // make Priya's CRM e-mail match the JustConnect agent (case-insensitive)
  AGENTS[0].email = priya.user!.email.toUpperCase();
  calls = [];
  respond = (url) => (url.endsWith('/agents') ? { status: 200, json: { items: AGENTS } } : { status: 200, json: {} });
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', body, auth: init.headers?.Authorization || '' });
    const r = respond(url, init.method || 'GET', body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('connection', () => {
  it('needs a key; the test names the business and any missing scope', async () => {
    await expect(jcAgents()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await setSecret('JUSTCONNECT_API_KEY', 'jc_abc.secret', admin);
    respond = () => ({ status: 200, json: { ok: true, business: { name: 'Amaya Senior Living' }, key: { prefix: 'jc_abc', scopes: ['calls:read', 'calls:write'] } } });
    const r = await jcTest();
    expect(r).toMatchObject({ ok: false, business: 'Amaya Senior Living', missing: ['contacts:read', 'contacts:write', 'reports:read'] });
    expect(calls[0]).toMatchObject({ url: 'https://api.justconnect.biz/api/v1/ping', auth: 'Bearer jc_abc.secret' });
    respond = () => ({ status: 401, json: { error: 'Invalid key' } });
    expect(await jcTest()).toMatchObject({ ok: false, message: 'The key is wrong, revoked or expired.' });
  });
});

describe('agents', () => {
  it('matches users by e-mail, or by the agent picked; "none" opts out; viewers are left out', async () => {
    await setSecret('JUSTCONNECT_API_KEY', 'k', admin);
    await t.ctx('Viewer', 'Founder');
    let r = await jcAgents();
    expect(r.users.find((u) => u.name === 'Priya Sharma')).toMatchObject({ auto: true, agent: { id: 'ag1' } });
    expect(r.users.find((u) => u.name === 'Asha Admin')!.agent).toBeNull();
    expect(r.users.some((u) => u.name === 'Founder')).toBe(false);
    r = await jcSetAgent({ userId: admin.user!.id, agent: 'ag2' });
    expect(r.users.find((u) => u.name === 'Asha Admin')).toMatchObject({ auto: false, agent: { id: 'ag2' } });
    await expect(jcSetAgent({ userId: admin.user!.id, agent: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' });
    r = await jcSetAgent({ userId: priya.user!.id, agent: 'none' });
    expect(r.users.find((u) => u.name === 'Priya Sharma')!.agent).toBeNull();
  });
});

describe('click-to-call', () => {
  it('rings the RM through their agent with the lead as ref, then reports progress', async () => {
    await setSecret('JUSTCONNECT_API_KEY', 'k', admin);
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    respond = (url) => (url.endsWith('/agents') ? { status: 200, json: { items: AGENTS } } : url.endsWith('/click-to-call')
      ? { status: 202, json: { request: { id: 'req1', status: 'ringing-agent' } } }
      : { status: 200, json: { request: { id: 'req1', status: 'agent-answered', call: { status: 'in-progress' } } } });
    expect(await jcClickToCall({ leadId: lead[L.ID] }, priya)).toEqual({ mode: 'app', requestId: 'req1', status: 'ringing-agent' });
    expect(calls.find((c) => c.url.endsWith('/click-to-call'))).toMatchObject({ method: 'POST', body: { agent: priya.user!.email, to: '9876543210', label: 'Meera Kapoor', ref: lead[L.ID], ringSeconds: 30 } });
    expect(await jcCallStatus({ id: 'req1', mode: 'app' })).toMatchObject({ status: 'agent-answered', callStatus: 'in-progress' });

    // a saved link is used instead of the e-mail
    await jcSetAgent({ userId: priya.user!.id, agent: 'ag2' });
    await jcClickToCall({ leadId: lead[L.ID] }, priya);
    expect(calls.filter((c) => c.url.endsWith('/click-to-call')).pop()!.body.agent).toBe('ag2');
  });

  it('turns JustConnect refusals into messages an RM can act on', async () => {
    await setSecret('JUSTCONNECT_API_KEY', 'k', admin);
    const { lead } = await addLead({ [L.NAME]: 'Ravi', [L.PHONE]: '9876500002', [L.RM]: 'Priya Sharma' }, admin);
    // app signed out and no mobile saved: tell them to add it
    respond = () => ({ status: 409, json: { error: 'Agent offline', code: 'agent-offline' } });
    await expect(jcClickToCall({ leadId: lead[L.ID] }, priya)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/not signed in.*Add your mobile number/), details: { fallback: 'dial' } });
    respond = () => ({ status: 409, json: { error: 'Busy', code: 'agent-busy' } });
    await expect(jcClickToCall({ leadId: lead[L.ID] }, priya)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/another JustConnect call/) });
    const { lead: noPhone } = await addLead({ [L.NAME]: 'No phone', [L.EMAIL]: 'x@y.in', [L.RM]: 'Priya Sharma' }, admin).catch(() => ({ lead: null as any }));
    if (noPhone) await expect(jcClickToCall({ leadId: noPhone[L.ID] }, priya)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('app signed out (or no agent): rings the RM\'s own mobile first with a masked call, recorded, lead as ref', async () => {
    await setSecret('JUSTCONNECT_API_KEY', 'k', admin);
    await updateProfile(priya, { phone: '98765 11111' });
    const { lead } = await addLead({ [L.NAME]: 'Meera Kapoor', [L.PHONE]: '9876543210', [L.RM]: 'Priya Sharma' }, admin);
    respond = (url) => url.endsWith('/click-to-call') ? { status: 409, json: { error: 'Agent offline', code: 'agent-offline' } }
      : url.endsWith('/calls/bridge') ? { status: 202, json: { call: { id: 'br1', status: 'calling' } } }
      : { status: 200, json: { call: { status: 'calling', legs: [{ n: 0, status: 'answered' }, { n: 1, status: 'ringing' }] } } };
    expect(await jcClickToCall({ leadId: lead[L.ID] }, priya)).toEqual({ mode: 'mobile', requestId: 'br1', status: 'calling' });
    const bridge = calls.find((c) => c.url.endsWith('/calls/bridge'))!;
    expect(bridge.body).toMatchObject({ from: '919876511111', to: '9876543210', record: true, ref: lead[L.ID], toLabel: 'Meera Kapoor', fromLabel: 'Priya Sharma' });
    expect(bridge.body.whisper).toContain('Meera Kapoor');
    expect(await jcCallStatus({ id: 'br1', mode: 'mobile' })).toMatchObject({ status: 'agent-answered' });
    respond = () => ({ status: 200, json: { call: { status: 'unanswered', legs: [{ n: 0, status: 'no_answer' }] } } });
    expect(await jcCallStatus({ id: 'br1', mode: 'mobile' })).toMatchObject({ status: 'agent-did-not-answer' });
    // no JustConnect agent at all (404) also rings the mobile
    respond = (url) => url.endsWith('/click-to-call') ? { status: 404, json: { error: 'No such agent' } } : { status: 202, json: { call: { id: 'br2', status: 'calling' } } };
    expect((await jcClickToCall({ leadId: lead[L.ID] }, priya)).mode).toBe('mobile');
  });

  it('an RM cannot call a lead they cannot see', async () => {
    await setSecret('JUSTCONNECT_API_KEY', 'k', admin);
    const { lead } = await addLead({ [L.NAME]: 'Someone else', [L.PHONE]: '9876500003', [L.RM]: 'Asha Admin' }, admin);
    await expect(jcClickToCall({ leadId: lead[L.ID] }, priya)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    expect(calls.some((c) => c.url.endsWith('/click-to-call'))).toBe(false);
  });
});

describe('how Call works per user', () => {
  it('defaults to JustConnect; a user or an admin can switch to the phone dialer and back', async () => {
    const { updateUser } = await import('../server/core/auth');
    expect(priya.user!.callVia).toBe('justconnect');
    expect((await updateProfile(priya, { callVia: 'direct' })).callVia).toBe('direct');
    expect((await updateUser({ id: priya.user!.id, callVia: 'justconnect' }, admin)).callVia).toBe('justconnect');
    expect((await updateUser({ id: priya.user!.id, callVia: 'direct' }, admin)).callVia).toBe('direct');
  });
});
