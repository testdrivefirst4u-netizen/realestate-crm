/**
 * Drip campaigns (plan feature dripCampaigns, off by default; screen /dripcampaigns): a company writes a series of steps, each
 * WhatsApp (an approved Chat360 template), e-mail (through the company's own mail account) or a task for the RM, sent to
 * new leads over time.
 *
 * Campaign  = `dripCampaigns` { status 'draft' | 'active' | 'paused' | 'archived', sources, steps, hours, dailyLimit, testedAt }.
 *             A test send is required before it can go active, and any edit asks for a new one.
 * Enrolment = `dripEnrollments` { _id '<campaign>:<lead>', stepIndex, nextAt, status 'active' | 'completed' | 'stopped' }.
 *             Only leads created after the campaign is active, never bulk imports, and one running campaign per phone.
 * Stopping  = looked at just before every step, from the lead as it is then, so nothing is missed: a WhatsApp reply, a site
 *             visit, Booked, Lost, Disqualified or the bin. "STOP" on WhatsApp or an e-mail unsubscribe is also kept for good in
 *             `dripOptOuts`, per channel; STOP ends the whole campaign, an unsubscribe only its e-mails.
 * Sending   = every cron run, due steps only, inside the campaign's hours (India time) and daily limit. A step is marked before it
 *             goes: if a run dies midway that step is not sent again, as a lead getting nothing beats one getting it twice.
 *             A failed send is tried 3 times, an hour apart, then the campaign moves on and the log says why.
 */
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import dns from 'dns/promises';
import net from 'net';
import type { ActionMap } from '../core/actions';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import { appUrl, decryptSecret, encryptSecret, getSecret } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { shortId, truncate } from '../core/utils';
import { listActiveTenants } from '../platform/registry';
import { getLead } from './leads';
import { isPrivateAddress } from './searchConsole';
import { addTask } from './tasks';

const L = CFG.LEAD;
const S = CFG.STAGES;
const IST_MS = 330 * 60000;
const HOUR_MS = 3600000;
const LEASE_MS = 30 * 60000;
const MAX_STEPS = 10;
const MAX_WAIT_MIN = 90 * 24 * 60;
const MAX_ATTEMPTS = 3;
const RUN_LIMIT = 100;
const RUN_BUDGET_MS = 90000;
const STOP_WORDS = /^\s*(stop|unsubscribe|opt[ -]?out|cancel|remove me|do not (message|contact) me)\s*[.!]*\s*$/i;

export type DripChannel = 'whatsapp' | 'email' | 'task';
export interface DripStep { id: string; channel: DripChannel; waitMinutes: number; template: string; params: string[]; subject: string; body: string; taskName: string }
export interface DripCampaign { _id: string; name: string; status: 'draft' | 'active' | 'paused' | 'archived'; sources: string[]; steps: DripStep[]; hoursFrom: number; hoursTo: number; dailyLimit: number; stopOnVisit: boolean; testedAt: Date | null; createdBy: string; createdAt: Date; updatedAt: Date }
interface Enrollment { _id: string; campaignId: string; leadId: string; phoneLast10: string; email: string; stepIndex: number; nextAt: Date | null; status: 'active' | 'completed' | 'stopped'; stopReason: string; enrolledAt: Date; attempts: number; sendingStep: string; updatedAt: Date }
interface DripLog { _id: string; campaignId: string; leadId: string; stepId: string; channel: DripChannel; status: 'sent' | 'skipped' | 'failed' | 'stopped'; detail: string; day: string; at: Date }
interface MailDoc { _id: 'dripEmail'; host: string; port: number; user: string; pass: string; fromName: string; fromEmail: string; updatedAt: Date; updatedBy: string }

const campaignsCol = () => col<DripCampaign>('dripCampaigns');
const enrollCol = () => col<Enrollment>('dripEnrollments');
const logsCol = () => col<DripLog>('dripLogs');
const optOutCol = () => col<{ _id: string; channel: string; at: Date; how: string }>('dripOptOuts');
const mailCol = () => col<MailDoc>(CFG.COLL.INTEGRATIONS);
const bad = (m: string) => fail('VALIDATION', m);
const last10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);
const cleanEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dayOf = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

/* ------------------------------ campaigns --------------------------------- */

function readStep(raw: any, i: number): DripStep {
  const channel = String(raw?.channel) as DripChannel;
  const n = i + 1;
  if (!['whatsapp', 'email', 'task'].includes(channel)) throw bad(`Step ${n}: choose WhatsApp, e-mail or an RM task.`);
  const waitMinutes = Math.round(Number(raw?.waitMinutes) || 0);
  if (waitMinutes < 0 || waitMinutes > MAX_WAIT_MIN) throw bad(`Step ${n}: the wait can be up to 90 days.`);
  const step: DripStep = { id: String(raw?.id || '') || shortId('STEP'), channel, waitMinutes, template: '', params: [], subject: '', body: '', taskName: '' };
  if (channel === 'whatsapp') {
    step.template = truncate(String(raw?.template || '').trim(), 200);
    if (!step.template) throw bad(`Step ${n}: enter the approved WhatsApp template's name.`);
    step.params = (Array.isArray(raw?.params) ? raw.params : []).slice(0, 20).map((p: unknown) => truncate(String(p ?? ''), 500));
  } else if (channel === 'email') {
    step.subject = String(raw?.subject || '').replace(/[\r\n]+/g, ' ').trim();
    step.body = String(raw?.body || '').trim();
    if (!step.subject || step.subject.length > 200) throw bad(`Step ${n}: enter a subject of up to 200 characters.`);
    if (!step.body || step.body.length > 10000) throw bad(`Step ${n}: enter the e-mail text, up to 10,000 characters.`);
  } else {
    step.taskName = truncate(String(raw?.taskName || '').trim(), 200);
    if (!step.taskName) throw bad(`Step ${n}: enter what the RM should do.`);
  }
  return step;
}

function readCampaign(d: any) {
  const name = String(d?.name || '').trim();
  if (!name || name.length > 120) throw bad('Give the campaign a name of up to 120 characters.');
  const raw = Array.isArray(d?.steps) ? d.steps : [];
  if (!raw.length || raw.length > MAX_STEPS) throw bad(`A campaign has 1 to ${MAX_STEPS} steps.`);
  const steps = raw.map(readStep);
  const hoursFrom = Number(d?.hoursFrom ?? 9), hoursTo = Number(d?.hoursTo ?? 20);
  if (!Number.isInteger(hoursFrom) || !Number.isInteger(hoursTo) || hoursFrom < 0 || hoursTo > 24 || hoursFrom >= hoursTo) throw bad('Choose sending hours where the start is before the end.');
  const dailyLimit = Number(d?.dailyLimit ?? 200);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 2000) throw bad('The daily limit is 1 to 2,000 messages.');
  const sources = [...new Set((Array.isArray(d?.sources) ? d.sources : []).map((s: unknown) => String(s).trim()).filter(Boolean))].slice(0, 50) as string[];
  return { name, steps, hoursFrom, hoursTo, dailyLimit, sources, stopOnVisit: d?.stopOnVisit !== false };
}

export async function saveDripCampaign(d: any, ctx: Ctx): Promise<{ id: string }> {
  const fields = readCampaign(d);
  const c = await campaignsCol();
  const now = new Date();
  if (d?.id) {
    // any change asks for a new test; a running one is paused first, so nothing goes out half-changed
    const r = await c.updateOne({ _id: String(d.id), status: { $in: ['draft', 'paused'] } }, { $set: { ...fields, testedAt: null, updatedAt: now } });
    if (!r.matchedCount) throw bad('Pause the campaign before changing it.');
    await auditLog(ctx, 'Drip Campaign Changed', 'Settings', String(d.id), fields.name);
    return { id: String(d.id) };
  }
  const id = await nextSeq('DRIP', 4);
  await c.insertOne({ _id: id, ...fields, status: 'draft', testedAt: null, createdBy: ctx.user?.name || 'System', createdAt: now, updatedAt: now });
  await auditLog(ctx, 'Drip Campaign Created', 'Settings', id, fields.name);
  return { id };
}

/* -------------------------------- channels --------------------------------- */

async function whatsappSetup(): Promise<{ ready: boolean; reason: string }> {
  if (!(currentTenant()?.features as any)?.chat360) return { ready: false, reason: "WhatsApp (Chat360) isn't included in this company's plan." };
  if (!(await getSecret('CHAT360_API_KEY'))) return { ready: false, reason: 'Chat360 is not connected yet.' };
  return { ready: true, reason: '' };
}

async function loadMail(): Promise<MailDoc | null> {
  return (await mailCol()).findOne({ _id: 'dripEmail' });
}
const emailSetup = async () => {
  const m = await loadMail();
  return m?.host && m.pass && m.fromEmail ? { ready: true, reason: '' } : { ready: false, reason: "The company's mail account is not set up yet." };
};

/** Mail settings are typed by a company: the server only connects to a public mail host, never inside its own network. */
async function assertMailHost(host: string) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host) || net.isIP(host)) throw bad('Enter the mail server as a name, like smtp.example.com.');
  const found = await dns.lookup(host, { all: true }).catch(() => []);
  if (!found.length) throw bad('That mail server could not be found.');
  if (found.some((a) => isPrivateAddress(a.address))) throw bad('That mail server is not a public address.');
}

function transport(m: { host: string; port: number; user: string; pass: string }) {
  return nodemailer.createTransport({ host: m.host, port: m.port, secure: m.port === 465, auth: { user: m.user, pass: m.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
}

export async function saveDripEmail(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const cur = await loadMail();
  const host = String(d?.host || '').trim().toLowerCase();
  const port = Number(d?.port);
  const user = String(d?.user || '').trim();
  const fromEmail = cleanEmail(d?.fromEmail);
  const fromName = String(d?.fromName || '').replace(/[\r\n<>"]+/g, ' ').trim().slice(0, 100);
  if (![465, 587, 2525].includes(port)) throw bad('The mail port is usually 587 or 465.');
  if (!user || user.length > 200) throw bad('Enter the mail account user name.');
  if (!EMAIL.test(fromEmail)) throw bad('Enter the e-mail address messages are sent from.');
  const pass = String(d?.pass || '') ? encryptSecret(String(d.pass)) : cur?.pass || '';
  if (!pass) throw bad('Enter the mail account password.');
  await assertMailHost(host);
  await (await mailCol()).updateOne({ _id: 'dripEmail' }, { $set: { host, port, user, pass, fromName, fromEmail, updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' } }, { upsert: true });
  await auditLog(ctx, 'Drip Mail Account Saved', 'Settings', 'dripEmail', `${host} · ${fromEmail}`);
  return { ok: true };
}

const secretKey = () => crypto.createHash('sha256').update('drip-unsubscribe\n' + (process.env.SECRETS_ENCRYPTION_KEY?.trim() || (process.env.NODE_ENV !== 'production' ? 'amaya-dev-only-key' : ''))).digest();
const unsubSig = (company: string, email: string) => crypto.createHmac('sha256', secretKey()).update(`${company}:${email}`).digest('base64url').slice(0, 32);
export function unsubSigOk(company: string, email: string, sig: string): boolean {
  const want = unsubSig(company, email);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
export function unsubscribeUrl(email: string): string {
  const company = currentTenant()?.id || '';
  return `${appUrl()}/api/public/unsubscribe?${new URLSearchParams({ c: company, e: email, s: unsubSig(company, email) }).toString()}`;
}
/** From the public unsubscribe page, in the company's context. */
export async function unsubscribeEmail(email: string): Promise<void> {
  await (await optOutCol()).updateOne({ _id: `email:${cleanEmail(email)}` }, { $set: { channel: 'email', at: new Date(), how: 'Unsubscribe link' } }, { upsert: true });
}

async function sendMail(to: string, subject: string, body: string): Promise<void> {
  const m = await loadMail();
  if (!m?.host || !m.pass) throw fail('NOT_CONFIGURED', "The company's mail account is not set up.");
  const url = unsubscribeUrl(to);
  await transport({ ...m, pass: decryptSecret(m.pass) }).sendMail({
    from: m.fromName ? { name: m.fromName, address: m.fromEmail } : m.fromEmail, to, subject,
    text: `${body}\n\n--\nTo stop these e-mails: ${url}`,
    headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
}

export function fillVars(text: string, vars: Record<string, string>): string {
  return String(text || '').replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all));
}
function varsOf(lead: any): Record<string, string> {
  const name = String(lead?.[L.NAME] || '').trim();
  return { name, first_name: name.split(/\s+/)[0] || '', rm: String(lead?.[L.RM] || ''), source: String(lead?.[L.SOURCE] || ''), company: String(currentTenant()?.name || '') };
}

async function sendWhatsapp(phone: string, step: DripStep, vars: Record<string, string>, leadId?: string) {
  const { send } = await import('./chat360');
  await send({ phone, leadId, templateName: step.template, params: step.params.map((p) => fillVars(p, vars)) }, SYSTEM_CTX);
}

/* -------------------------------- enrolment -------------------------------- */

/** A new lead joins the first active campaign that fits, unless that person is already in one. Never fails the lead's save. */
export async function enrollNewLead(lead: any, now = new Date()): Promise<string> {
  try {
    if (!(currentTenant()?.features as any)?.dripCampaigns) return '';
    const leadId = String(lead?.[L.ID] || '');
    if (!leadId) return '';
    const source = String(lead?.[L.SOURCE] || '').trim().toLowerCase();
    const list = await (await campaignsCol()).find({ status: 'active' }).sort({ createdAt: 1 }).toArray();
    const fit = list.find((c) => !c.sources.length || c.sources.some((s) => s.toLowerCase() === source));
    if (!fit?.steps.length) return '';
    const phoneLast10 = last10(lead?.[L.PHONE]);
    const email = cleanEmail(lead?.[L.EMAIL]);
    const e = await enrollCol();
    if (phoneLast10.length === 10 && await e.findOne({ phoneLast10, status: 'active' }, { projection: { _id: 1 } })) return '';
    await e.insertOne({ _id: `${fit._id}:${leadId}`, campaignId: fit._id, leadId, phoneLast10, email, stepIndex: 0, nextAt: new Date(now.getTime() + fit.steps[0].waitMinutes * 60000), status: 'active', stopReason: '', enrolledAt: now, attempts: 0, sendingStep: '', updatedAt: now });
    await addTimeline(leadId, 'drip_started', `Drip campaign started: ${fit.name}`, '', 'System');
    return fit._id;
  } catch (err: any) {
    if (err?.code !== 11000) console.error('[drip:enroll]', err?.message);
    return '';
  }
}

/* --------------------------------- sending --------------------------------- */

/** The next moment inside the sending hours (India time): now, or when they next open. */
export function nextOpen(now: Date, from: number, to: number): Date {
  const ist = new Date(now.getTime() + IST_MS);
  const h = ist.getUTCHours();
  if (h >= from && h < to) return now;
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (h >= to ? 1 : 0), from);
  return new Date(day - IST_MS);
}

async function log(c: DripCampaign, en: Enrollment, step: DripStep | null, status: DripLog['status'], detail: string, now: Date) {
  await (await logsCol()).insertOne({ _id: shortId('DL'), campaignId: c._id, leadId: en.leadId, stepId: step?.id || '', channel: step?.channel || 'task', status, detail: truncate(detail, 300), day: dayOf(now), at: now });
}

/** Why this lead should get nothing more, if anything. Recording a STOP for good on the way. */
async function stopReason(c: DripCampaign, en: Enrollment, lead: any): Promise<string> {
  if (!lead) return 'The lead no longer exists.';
  const stage = String(lead[L.STAGE] || '');
  if ([S.BOOKED, S.LOST, S.TRASH, S.DELETED].includes(stage) || /^Disqualified/i.test(stage)) return `The lead is now ${stage}.`;
  const visit = String(lead[L.SITE_VISIT_STATUS] || '');
  if (c.stopOnVisit && [CFG.SITE_VISIT.SCHEDULED, CFG.SITE_VISIT.COMPLETED, CFG.SITE_VISIT.WALK_IN].includes(visit)) return `Site visit: ${visit}.`;
  const phone = last10(lead[L.PHONE]) || en.phoneLast10;
  if (phone.length === 10) {
    const opted = await optOutCol();
    if (await opted.findOne({ _id: `whatsapp:${phone}` })) return 'This person asked not to be messaged.';
    const replies = await (await col<any>(CFG.COLL.CHAT_MESSAGES)).find({ phoneLast10: phone, direction: 'Inbound', timestamp: { $gte: en.enrolledAt } }).sort({ timestamp: -1 }).limit(20).toArray();
    if (replies.length) {
      if (replies.some((m) => STOP_WORDS.test(String(m.text || '')))) {
        await opted.updateOne({ _id: `whatsapp:${phone}` }, { $set: { channel: 'whatsapp', at: new Date(), how: 'Replied STOP' } }, { upsert: true });
        return 'They replied STOP on WhatsApp.';
      }
      return 'They replied on WhatsApp, so a person takes over.';
    }
  }
  return '';
}

/** Send one step. Returns why it was skipped, if it was. Throws when the send failed. */
async function sendStep(step: DripStep, lead: any): Promise<string> {
  const vars = varsOf(lead);
  const leadId = String(lead[L.ID]);
  if (step.channel === 'whatsapp') {
    const phone = String(lead[L.PHONE] || '');
    if (last10(phone).length !== 10) return 'No phone number.';
    await sendWhatsapp(phone, step, vars, leadId);
    return '';
  }
  if (step.channel === 'email') {
    const to = cleanEmail(lead[L.EMAIL]);
    if (!EMAIL.test(to)) return 'No e-mail address.';
    if (await (await optOutCol()).findOne({ _id: `email:${to}` })) return 'They unsubscribed from e-mails.';
    await sendMail(to, fillVars(step.subject, vars), fillVars(step.body, vars));
    await addTimeline(leadId, 'drip_email', `Drip e-mail sent: ${truncate(fillVars(step.subject, vars), 120)}`, '', 'System');
    return '';
  }
  await addTask({ name: fillVars(step.taskName, vars), leadId, assignedTo: String(lead[L.RM] || '') || 'Unassigned', datetime: new Date().toISOString() }, SYSTEM_CTX);
  return '';
}

/** Runs one due enrolment, with a lease so two runs never take the same one. */
async function runOne(en0: Enrollment, c: DripCampaign, now: Date): Promise<string> {
  const e = await enrollCol();
  const en = await e.findOneAndUpdate({ _id: en0._id, status: 'active', nextAt: { $lte: now } }, { $set: { nextAt: new Date(now.getTime() + LEASE_MS), updatedAt: now } }, { returnDocument: 'before' });
  if (!en) return 'taken';
  const lead = await getLead(en.leadId);
  const why = await stopReason(c, en, lead);
  const finish = async (status: 'stopped' | 'completed', reason: string) => e.updateOne({ _id: en._id }, { $set: { status, stopReason: reason, nextAt: null, sendingStep: '', updatedAt: now } });
  if (why) {
    await finish('stopped', why);
    await log(c, en, null, 'stopped', why, now);
    if (lead) await addTimeline(en.leadId, 'drip_stopped', `Drip campaign stopped: ${c.name}`, why, 'System');
    return 'stopped';
  }
  const step = c.steps[en.stepIndex];
  if (!step) {
    await finish('completed', '');
    return 'completed';
  }
  const advance = async () => {
    const next = c.steps[en.stepIndex + 1];
    if (!next) return finish('completed', '');
    return e.updateOne({ _id: en._id }, { $set: { stepIndex: en.stepIndex + 1, nextAt: new Date(now.getTime() + next.waitMinutes * 60000), attempts: 0, sendingStep: '', updatedAt: now } });
  };
  // a run died while this step was going out: it may have gone, so never again
  if (en.sendingStep === step.id) {
    await log(c, en, step, 'failed', 'A sending run stopped midway. This step was not repeated, in case it had gone.', now);
    await advance();
    return 'unknown';
  }
  if (step.channel !== 'task') {
    const open = nextOpen(now, c.hoursFrom, c.hoursTo);
    if (open.getTime() > now.getTime()) {
      await e.updateOne({ _id: en._id }, { $set: { nextAt: open, updatedAt: now } });
      return 'later';
    }
    const today = await (await logsCol()).countDocuments({ campaignId: c._id, day: dayOf(now), status: 'sent', channel: { $ne: 'task' } });
    if (today >= c.dailyLimit) {
      await e.updateOne({ _id: en._id }, { $set: { nextAt: nextOpen(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, c.hoursFrom) - IST_MS), c.hoursFrom, c.hoursTo), updatedAt: now } });
      return 'limit';
    }
  }
  await e.updateOne({ _id: en._id }, { $set: { sendingStep: step.id } });
  try {
    const skipped = await sendStep(step, lead);
    await log(c, en, step, skipped ? 'skipped' : 'sent', skipped, now);
    await advance();
    return skipped ? 'skipped' : 'sent';
  } catch (err: any) {
    const said = truncate(String(err?.message || err), 300);
    const attempts = en.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await log(c, en, step, 'failed', said, now);
      await advance();
      return 'failed';
    }
    await e.updateOne({ _id: en._id }, { $set: { attempts, sendingStep: '', nextAt: new Date(now.getTime() + HOUR_MS), updatedAt: now } });
    return 'retry';
  }
}

export async function runDripDue(now = new Date(), until = Date.now() + RUN_BUDGET_MS): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const active = await (await campaignsCol()).find({ status: 'active' }).toArray();
  if (!active.length) return out;
  const byId = new Map(active.map((c) => [c._id, c]));
  const due = await (await enrollCol()).find({ status: 'active', nextAt: { $lte: now }, campaignId: { $in: [...byId.keys()] } }).sort({ nextAt: 1 }).limit(RUN_LIMIT).toArray();
  for (const en of due) {
    if (Date.now() > until) break;
    const r = await runOne(en, byId.get(en.campaignId)!, now);
    out[r] = (out[r] || 0) + 1;
  }
  return out;
}

/** Every company with the feature; the cron's share of time is split so one cannot hold up the others. */
export async function runDripCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const until = Date.now() + RUN_BUDGET_MS;
  for (const tenant of await listActiveTenants()) {
    if (!(tenant.features as any).dripCampaigns) continue;
    try {
      const r = await runWithTenant(tenant, () => runDripDue(now, until));
      if (Object.keys(r).length) out[tenant.slug] = r;
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

/* ---------------------------------- screen --------------------------------- */

export async function testDripCampaign(d: any, ctx: Ctx): Promise<{ results: Array<{ step: number; channel: DripChannel; ok: boolean; message: string }>; passed: boolean }> {
  const c = await (await campaignsCol()).findOne({ _id: String(d?.id || '') });
  if (!c) throw fail('NOT_FOUND', 'Campaign not found');
  const phone = String(d?.phone || '').trim();
  const email = cleanEmail(d?.email);
  const needsPhone = c.steps.some((s) => s.channel === 'whatsapp');
  const needsEmail = c.steps.some((s) => s.channel === 'email');
  if (needsPhone && last10(phone).length !== 10) throw bad('Enter your own WhatsApp number to test with.');
  if (needsEmail && !EMAIL.test(email)) throw bad('Enter your own e-mail address to test with.');
  const vars = { name: 'Test Lead', first_name: 'Test', rm: ctx.user?.name || 'RM', source: 'Test', company: String(currentTenant()?.name || '') };
  const results: Array<{ step: number; channel: DripChannel; ok: boolean; message: string }> = [];
  for (const [i, step] of c.steps.entries()) {
    if (step.channel === 'task') { results.push({ step: i + 1, channel: step.channel, ok: true, message: 'RM tasks are made for real leads only.' }); continue; }
    try {
      if (step.channel === 'whatsapp') await sendWhatsapp(phone, step, vars);
      else await sendMail(email, `[TEST] ${fillVars(step.subject, vars)}`, fillVars(step.body, vars));
      results.push({ step: i + 1, channel: step.channel, ok: true, message: 'Sent.' });
    } catch (e: any) {
      results.push({ step: i + 1, channel: step.channel, ok: false, message: truncate(String(e?.message || e), 300) });
    }
  }
  const passed = results.every((r) => r.ok);
  if (passed) await (await campaignsCol()).updateOne({ _id: c._id }, { $set: { testedAt: new Date() } });
  await auditLog(ctx, 'Drip Campaign Tested', 'Settings', c._id, passed ? 'passed' : 'failed');
  return { results, passed };
}

export async function setDripStatus(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const c = await (await campaignsCol()).findOne({ _id: String(d?.id || '') });
  if (!c) throw fail('NOT_FOUND', 'Campaign not found');
  const status = String(d?.status);
  if (status === 'active') {
    if (c.status === 'archived') throw bad('This campaign is archived.');
    if (!c.testedAt && c.steps.some((s) => s.channel !== 'task')) throw bad('Send a test first, so you have seen the messages.');
    const w = await whatsappSetup();
    if (!w.ready && c.steps.some((s) => s.channel === 'whatsapp')) throw bad(w.reason);
    const m = await emailSetup();
    if (!m.ready && c.steps.some((s) => s.channel === 'email')) throw bad(m.reason);
  } else if (status === 'paused') {
    if (c.status !== 'active') throw bad('Only a running campaign can be paused.');
  } else if (status === 'archived') {
    await (await enrollCol()).updateMany({ campaignId: c._id, status: 'active' }, { $set: { status: 'stopped', stopReason: 'The campaign was archived.', nextAt: null, updatedAt: new Date() } });
  } else throw bad('Choose a status.');
  await (await campaignsCol()).updateOne({ _id: c._id }, { $set: { status: status as DripCampaign['status'], updatedAt: new Date() } });
  await auditLog(ctx, `Drip Campaign ${status === 'active' ? 'Started' : status === 'paused' ? 'Paused' : 'Archived'}`, 'Settings', c._id, c.name);
  return { ok: true };
}

export async function getDrip(ctx: Ctx) {
  const rows = await (await campaignsCol()).find({ status: { $ne: 'archived' } }).sort({ createdAt: -1 }).toArray();
  const ids = rows.map((r) => r._id);
  const counts = async (coll: Awaited<ReturnType<typeof enrollCol>> | Awaited<ReturnType<typeof logsCol>>) => (coll as any).aggregate([{ $match: { campaignId: { $in: ids } } }, { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } }]).toArray() as Promise<Array<{ _id: { c: string; s: string }; n: number }>>;
  const entered = await counts(await enrollCol());
  const logged = await counts(await logsCol());
  const n = (list: Array<{ _id: { c: string; s: string }; n: number }>, c: string, s: string) => list.find((x) => x._id.c === c && x._id.s === s)?.n || 0;
  const m = await loadMail();
  return {
    campaigns: rows.map((r) => ({
      id: r._id, name: r.name, status: r.status, sources: r.sources, steps: r.steps, hoursFrom: r.hoursFrom, hoursTo: r.hoursTo, dailyLimit: r.dailyLimit, stopOnVisit: r.stopOnVisit, tested: !!r.testedAt, createdBy: r.createdBy,
      stats: { running: n(entered, r._id, 'active'), finished: n(entered, r._id, 'completed'), stopped: n(entered, r._id, 'stopped'), sent: n(logged, r._id, 'sent'), skipped: n(logged, r._id, 'skipped'), failed: n(logged, r._id, 'failed') },
    })),
    whatsapp: await whatsappSetup(),
    email: await emailSetup(),
    // the account details only for those who may change them, and never the password
    mail: ctx.user && (await import('../core/auth')).can(ctx.user, 'integrations.connect') ? { host: m?.host || '', port: m?.port || 587, user: m?.user || '', fromName: m?.fromName || '', fromEmail: m?.fromEmail || '', passSet: !!m?.pass } : null,
  };
}

export async function getDripActivity(d: any) {
  const rows = await (await logsCol()).find({ campaignId: String(d?.id || '') }).sort({ at: -1 }).limit(100).toArray();
  return { rows: rows.map((r) => ({ id: r._id, leadId: r.leadId, channel: r.channel, status: r.status, detail: r.detail, at: r.at.toISOString() })) };
}

const feature = () => {
  if (!(currentTenant()?.features as any)?.dripCampaigns) throw fail('FORBIDDEN', "Drip campaigns are not included in your company's plan.");
};

export const actions: ActionMap = {
  getDrip: { fn: (_d, ctx) => { feature(); return getDrip(ctx); }, perm: 'marketing.manage' },
  getDripActivity: { fn: (d) => { feature(); return getDripActivity(d); }, perm: 'marketing.manage' },
  saveDripCampaign: { fn: (d, ctx) => { feature(); return saveDripCampaign(d, ctx); }, perm: 'marketing.manage' },
  testDripCampaign: { fn: (d, ctx) => { feature(); return testDripCampaign(d, ctx); }, perm: 'marketing.manage' },
  setDripStatus: { fn: (d, ctx) => { feature(); return setDripStatus(d, ctx); }, perm: 'marketing.manage' },
  saveDripEmail: { fn: (d, ctx) => { feature(); return saveDripEmail(d, ctx); }, perm: 'integrations.connect' },
};
