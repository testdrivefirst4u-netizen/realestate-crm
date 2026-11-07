/** The WhatsApp profile: reading it, sending only what changed, not writing over someone else's change, the photo, and a new name. */
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { CFG } from '../server/core/config';
import { col } from '../server/core/db';
import { runWithTenant } from '../server/core/tenant';
import { encryptSecret } from '../server/core/settings';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { handleMetaWebhookPost } from '../server/modules/metaQueue';
import { connectDirect } from '../server/modules/whatsappDirect';
import { actions, changedFields, cleanProfile, finishName, getProfile, nameProblem, readProfile, requestName, saveProfile } from '../server/modules/whatsappProfile';

const SECRET = 'app-secret';
const NUMBER_ID = '10001';
const WABA = '20002';
const TOKEN = 'SUPER.SECRET.TOKEN';
const PIN = '246810';
const ctx = { user: { name: 'Asha', role: 'Admin', email: 'a@x.test' } } as any;
let t: Awaited<ReturnType<typeof startTestDb>>;
let calls: Array<{ path: string; method: string; body: any; raw: string; query: URLSearchParams }> = [];
let profile: any;
let number: any;
let refuse: Record<string, any> = {};

const inCo = async <T>(fn: () => Promise<T>) => {
  invalidateTenant();
  return runWithTenant((await getTenantById('CMP-test'))!, fn);
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
  const raw = typeof init.body === 'string' ? init.body : '';
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  const method = init.method || 'GET';
  calls.push({ path, method, body, raw, query: url.searchParams });
  if (refuse[path] && method === 'POST') return json(400, { error: refuse[path] });
  if (path === `/${WABA}/phone_numbers`) return json(200, { data: [{ id: NUMBER_ID, display_phone_number: '+91 90000 11111', verified_name: 'Sample Homes' }] });
  if (path === `/${WABA}/subscribed_apps`) return json(200, { success: true });
  if (path === `/${WABA}/message_templates`) return json(200, { data: [] });
  if (path === `/${NUMBER_ID}/register`) return json(200, { success: true });
  if (path === `/${NUMBER_ID}/whatsapp_business_profile`) {
    if (method === 'POST') { profile = { ...profile, ...body }; return json(200, { success: true }); }
    return json(200, { data: [profile] });
  }
  if (path === `/${NUMBER_ID}`) {
    if (method === 'POST') return json(200, { success: true });
    return json(200, number);
  }
  if (path === '/111/uploads') return json(200, { id: 'upload:1' });
  if (path === '/upload:1') return json(200, { h: 'HANDLE-1' });
  return json(404, { error: { message: `unexpected ${path}` } });
}
const posts = (path: string) => calls.filter((c) => c.path === path && c.method === 'POST');
const PROFILE_PATH = `/${NUMBER_ID}/whatsapp_business_profile`;
const connect = () => inCo(() => connectDirect({ phoneNumberId: NUMBER_ID, wabaId: WABA, token: TOKEN }, ctx));
const form = (over: Record<string, unknown> = {}) => ({ about: 'Homes in Hyderabad', address: 'Road 1', description: 'We build homes.', email: 'hi@sample.example', websites: ['https://sample.example'], vertical: 'PROF_SERVICES', ...over });
const setMode = (set: Record<string, unknown>) => inCo(async () => { await (await col(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'whatsappDirect' } as any, { $set: set }); });

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
  await t.company('test', { whatsappDirect: true });
  profile = { about: 'Homes in Hyderabad', address: 'Road 1', description: 'We build homes.', email: 'hi@sample.example', websites: ['https://sample.example'], vertical: 'PROF_SERVICES', profile_picture_url: 'https://pps.whatsapp.net/x.jpg' };
  number = { verified_name: 'Sample Homes', name_status: 'APPROVED' };
  refuse = {};
  vi.stubGlobal('fetch', vi.fn(fake));
  await connect();
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('tidying and checking what was typed', () => {
  it('adds https to a website, and drops empty ones', () => {
    expect(cleanProfile(form({ websites: ['sample.example', ' '] })).fields.websites).toEqual(['https://sample.example']);
  });
  it.each([
    ['about', { about: 'x'.repeat(140) }, /about line/],
    ['address', { address: 'x'.repeat(257) }, /address/],
    ['description', { description: 'x'.repeat(513) }, /description/],
    ['bad e-mail', { email: 'not-an-email' }, /e-mail/],
    ['long e-mail', { email: `${'x'.repeat(130)}@a.example` }, /e-mail/],
    ['three websites', { websites: ['https://a.example', 'https://b.example', 'https://c.example'] }, /up to 2/],
    ['bad website', { websites: ['nothing here'] }, /does not look like a website/],
    ['long website', { websites: [`https://${'a'.repeat(260)}.example`] }, /256/],
    ['unknown category', { vertical: 'REAL_ESTATE' }, /category/],
  ])('refuses %s', (_n, over, msg) => expect(cleanProfile(form(over)).problem).toMatch(msg));
  it('accepts what fits exactly', () => {
    expect(cleanProfile(form({ about: 'x'.repeat(139), address: 'x'.repeat(256), description: 'x'.repeat(512) })).problem).toBe('');
  });
  it('allows no category', () => expect(cleanProfile(form({ vertical: '' })).problem).toBe(''));
  it('reads an empty profile without trouble', () => {
    expect(readProfile({ data: [] })).toEqual({ about: '', address: '', description: '', email: '', websites: [], vertical: '', picture: '' });
    expect(readProfile(null).about).toBe('');
  });
  it('treats Meta’s "undefined" category as none, and never keeps a picture link that is not https', () => {
    expect(readProfile({ data: [{ vertical: 'UNDEFINED', profile_picture_url: 'javascript:alert(1)' }] })).toMatchObject({ vertical: '', picture: '' });
  });
  it('finds only what changed', () => {
    const a = cleanProfile(form()).fields;
    expect(changedFields(a, a)).toEqual({});
    expect(changedFields(a, { ...a, about: 'New', websites: [] })).toEqual({ about: 'New', websites: [] });
  });
  it('checks a new name', () => {
    expect(nameProblem('ab', 'Sample')).toMatch(/at least 3/);
    expect(nameProblem('x'.repeat(76), 'Sample')).toMatch(/up to 75/);
    expect(nameProblem('sample', 'Sample')).toMatch(/already/);
    expect(nameProblem('Sample Homes', 'Sample')).toBe('');
  });
});

describe('reading the profile', () => {
  it('shows what Meta holds', async () => {
    const v = await inCo(() => getProfile());
    expect(v.profile).toMatchObject({ about: 'Homes in Hyderabad', vertical: 'PROF_SERVICES', picture: 'https://pps.whatsapp.net/x.jpg' });
    expect(v.name).toMatchObject({ current: 'Sample Homes', status: 'APPROVED', pending: '', finish: false, canChange: true, pinSaved: false });
    expect(v.displayPhone).toBe('+91 90000 11111');
  });
  it('never includes the token or PIN', async () => {
    await setMode({ pin: encryptSecret(PIN) });
    const out = JSON.stringify(await inCo(() => getProfile()));
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(PIN);
  });
  it('keeps working if Meta refuses the newer name fields', async () => {
    const real = (globalThis.fetch as any).getMockImplementation();
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      if (String(input).includes('new_name_status')) return json(400, { error: { code: 100, message: 'Tried accessing nonexisting field' } });
      return real(input, init);
    }));
    expect((await inCo(() => getProfile())).name.current).toBe('Sample Homes');
  });
  it('picks up a name changed elsewhere', async () => {
    number.verified_name = 'Sample Homes Pvt';
    await inCo(() => getProfile());
    const doc: any = await inCo(async () => (await col(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'whatsappDirect' } as any));
    expect(doc.verifiedName).toBe('Sample Homes Pvt');
  });
  it('says so when no number is connected', async () => {
    await inCo(async () => { await (await col(CFG.COLL.INTEGRATIONS)).deleteOne({ _id: 'whatsappDirect' } as any); });
    await expect(inCo(() => getProfile())).rejects.toThrow(/not connected/);
  });
});

describe('saving the profile', () => {
  const base = () => readProfile({ data: [profile] });
  it('sends only what changed', async () => {
    await inCo(() => saveProfile({ ...form({ about: 'New line' }), base: base() }, ctx));
    expect(posts(PROFILE_PATH)).toHaveLength(1);
    expect(posts(PROFILE_PATH)[0].body).toEqual({ messaging_product: 'whatsapp', about: 'New line' });
  });
  it('sends nothing if nothing changed', async () => {
    await inCo(() => saveProfile({ ...form(), base: base() }, ctx));
    expect(posts(PROFILE_PATH)).toHaveLength(0);
  });
  it('returns the saved version', async () => {
    const v = await inCo(() => saveProfile({ ...form({ address: 'Road 2' }), base: base() }, ctx));
    expect(v.profile.address).toBe('Road 2');
  });
  it('refuses to write over a change made elsewhere since it was opened', async () => {
    const opened = base();
    profile.about = 'Changed in WhatsApp Manager';
    await expect(inCo(() => saveProfile({ ...form({ address: 'Road 2' }), base: opened }, ctx))).rejects.toThrow(/changed outside the CRM/);
    expect(posts(PROFILE_PATH)).toHaveLength(0);
  });
  it('refuses an empty about line, which WhatsApp does not allow', async () => {
    await expect(inCo(() => saveProfile({ ...form({ about: '' }), base: base() }, ctx))).rejects.toThrow(/empty about/);
    expect(posts(PROFILE_PATH)).toHaveLength(0);
  });
  it('can clear the address', async () => {
    await inCo(() => saveProfile({ ...form({ address: '' }), base: base() }, ctx));
    expect(posts(PROFILE_PATH)[0].body.address).toBe('');
  });
  it('writes emoji and other languages the way Meta asks: escaped', async () => {
    await inCo(() => saveProfile({ ...form({ about: 'Homes \u{1F3E0} हैदराबाद' }), base: base() }, ctx));
    const sent = posts(PROFILE_PATH)[0];
    expect(/^[\x00-\x7f]*$/.test(sent.raw)).toBe(true);
    expect(sent.body.about).toBe('Homes \u{1F3E0} हैदराबाद');
  });
  it('uploads a photo, then sends its handle', async () => {
    await inCo(() => saveProfile({ ...form(), base: base(), photo: { name: 'p.jpg', mime: 'image/jpeg', base64: Buffer.from('jpeg-bytes').toString('base64') } }, ctx));
    expect(posts('/111/uploads')).toHaveLength(1);
    expect(posts(PROFILE_PATH)[0].body).toEqual({ messaging_product: 'whatsapp', profile_picture_handle: 'HANDLE-1' });
  });
  it('refuses a picture of the wrong kind or too big, before sending anything', async () => {
    await expect(inCo(() => saveProfile({ ...form(), base: base(), photo: { mime: 'image/gif', base64: 'AAAA' } }, ctx))).rejects.toThrow(/JPG or PNG/);
    await expect(inCo(() => saveProfile({ ...form(), base: base(), photo: { mime: 'image/png', base64: Buffer.alloc(3 * 1024 * 1024 + 10).toString('base64') } }, ctx))).rejects.toThrow(/3 MB/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('passes on Meta’s refusal in words', async () => {
    refuse[PROFILE_PATH] = { code: 100, message: 'Invalid parameter' };
    await expect(inCo(() => saveProfile({ ...form({ about: 'New' }), base: base() }, ctx))).rejects.toThrow(/Meta did not accept this: Invalid parameter/);
  });
  it('records who changed what', async () => {
    await inCo(() => saveProfile({ ...form({ about: 'New', email: 'new@sample.example' }), base: base() }, ctx));
    const log: any = await inCo(async () => (await col(CFG.COLL.AUDIT_LOG)).find({ action: 'WhatsApp Profile Updated' }).next());
    expect(JSON.stringify(log)).toContain('about, email');
    expect(JSON.stringify(log)).toContain('Asha');
  });
});

describe('asking for a new name', () => {
  it('sends it to Meta', async () => {
    await inCo(() => requestName({ name: 'Sample Realty' }, ctx));
    const sent = posts(`/${NUMBER_ID}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].query.get('new_display_name')).toBe('Sample Realty');
  });
  it('a number on the Business app changes it in the app', async () => {
    await setMode({ mode: 'coexistence' });
    await expect(inCo(() => requestName({ name: 'Sample Realty' }, ctx))).rejects.toThrow(/in the app on the phone/);
    expect(posts(`/${NUMBER_ID}`)).toHaveLength(0);
    expect((await inCo(() => getProfile())).name.canChange).toBe(false);
  });
  it('shows a change under review, and not as ready', async () => {
    number = { ...number, new_display_name: 'Sample Realty', new_name_status: 'PENDING_REVIEW' };
    expect((await inCo(() => getProfile())).name).toMatchObject({ pending: 'Sample Realty', pendingStatus: 'PENDING_REVIEW', finish: false });
  });
  it('does not show a request that already took effect', async () => {
    number = { ...number, new_display_name: 'Sample Homes', new_name_status: 'APPROVED' };
    expect((await inCo(() => getProfile())).name).toMatchObject({ pending: '', finish: false });
  });
});

describe('finishing a new name', () => {
  const approved = () => { number = { ...number, new_display_name: 'Sample Realty', new_name_status: 'APPROVED' }; };
  const REG = `/${NUMBER_ID}/register`;
  it('offers it once Meta has approved', async () => {
    approved();
    expect((await inCo(() => getProfile())).name.finish).toBe(true);
  });
  it('registers again with the PIN given', async () => {
    approved();
    await inCo(() => finishName({ pin: PIN }, ctx));
    expect(posts(REG)[0].body).toEqual({ messaging_product: 'whatsapp', pin: PIN });
  });
  it('uses the PIN saved at signup without asking', async () => {
    approved();
    await setMode({ pin: encryptSecret(PIN) });
    expect((await inCo(() => getProfile())).name.pinSaved).toBe(true);
    await inCo(() => finishName({}, ctx));
    expect(posts(REG)[0].body.pin).toBe(PIN);
  });
  it('does nothing before approval: Meta says it would have no effect', async () => {
    number = { ...number, new_display_name: 'Sample Realty', new_name_status: 'PENDING_REVIEW' };
    await expect(inCo(() => finishName({ pin: PIN }, ctx))).rejects.toThrow(/not approved/);
    expect(posts(REG)).toHaveLength(0);
  });
  it('asks for the PIN when none is saved, and checks it', async () => {
    approved();
    await expect(inCo(() => finishName({}, ctx))).rejects.toThrow(/6-digit/);
    await expect(inCo(() => finishName({ pin: '12' }, ctx))).rejects.toThrow(/6-digit/);
    expect(posts(REG)).toHaveLength(0);
  });
  it('says plainly when the PIN is wrong', async () => {
    approved();
    refuse[REG] = { code: 133005, message: 'PIN mismatch' };
    await expect(inCo(() => finishName({ pin: PIN }, ctx))).rejects.toThrow(/not this number's two-step PIN/);
  });
  it('never writes the PIN in the audit log', async () => {
    approved();
    await inCo(() => finishName({ pin: PIN }, ctx));
    const logs = await inCo(async () => (await col(CFG.COLL.AUDIT_LOG)).find({}).toArray());
    expect(JSON.stringify(logs)).not.toContain(PIN);
  });
});

describe('Meta telling us the decision', () => {
  const hook = (value: unknown) => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'phone_number_name_update', value }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return handleMetaWebhookPost(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), (fn) => void fn());
  };
  const alerts = () => inCo(async () => JSON.stringify(await (await col(CFG.COLL.META)).find({ _id: /^alert:/ } as any).toArray()));
  it('alerts Admins when approved, with the deadline', async () => {
    const res = await hook({ display_phone_number: '919000011111', decision: 'APPROVED', requested_verified_name: 'Sample Realty' });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect(await alerts()).toContain('whatsapp-name-APPROVED-Sample Realty'));
  });
  it('alerts Admins when rejected', async () => {
    await hook({ decision: 'REJECTED', requested_verified_name: 'Sample Realty' });
    await vi.waitFor(async () => expect(await alerts()).toContain('whatsapp-name-REJECTED-Sample Realty'));
  });
  it('ignores an account that is not connected', async () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '999', changes: [{ field: 'phone_number_name_update', value: { decision: 'APPROVED', requested_verified_name: 'Other' } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    await handleMetaWebhookPost(new Request('https://crm.example.com/api/webhooks/meta', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), (fn) => void fn());
    await new Promise((r) => setTimeout(r, 50));
    expect(await alerts()).not.toContain('Other');
  });
});

describe('who can do this', () => {
  it('needs the same permission as connecting WhatsApp', () => {
    for (const a of ['waDirectProfileGet', 'waDirectProfileSave', 'waDirectNameRequest', 'waDirectNameFinish']) expect(actions[a].perm).toBe('integrations.connect');
  });
});
