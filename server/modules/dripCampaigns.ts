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
import type { Readable } from 'node:stream';
import type { ActionMap } from '../core/actions';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, nextSeq } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import { appUrl, decryptSecret, encryptSecret, getSecret } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { shortId, str, truncate } from '../core/utils';
import { listActiveTenants } from '../platform/registry';
import { getLead, getLeadsConfig } from './leads';
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
export interface DripStep { id: string; channel: DripChannel; waitMinutes: number; template: string; params: string[]; subject: string; body: string; taskName: string; attachments: string[] }
export interface DripCampaign { _id: string; name: string; status: 'draft' | 'active' | 'paused' | 'archived'; sources: string[]; stages: string[]; steps: DripStep[]; hoursFrom: number; hoursTo: number; dailyLimit: number; stopOnVisit: boolean; testedAt: Date | null; createdBy: string; createdAt: Date; updatedAt: Date }
interface Enrollment { _id: string; campaignId: string; leadId: string; phoneLast10: string; email: string; stepIndex: number; nextAt: Date | null; status: 'active' | 'completed' | 'stopped'; stopReason: string; enrolledAt: Date; attempts: number; sendingStep: string; updatedAt: Date }
interface DripLog { _id: string; campaignId: string; leadId: string; stepId: string; channel: DripChannel; status: 'sent' | 'skipped' | 'failed' | 'stopped'; detail: string; day: string; at: Date; providerId?: string; delivery?: 'delivered' | 'read' | 'failed' }
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
  const step: DripStep = { id: String(raw?.id || '') || shortId('STEP'), channel, waitMinutes, template: '', params: [], subject: '', body: '', taskName: '', attachments: (Array.isArray(raw?.attachments) ? raw.attachments : []).map((a: unknown) => String(a || '').trim()).filter(Boolean).slice(0, 10) };
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
  // Stages that start the campaign: a lead joins when it reaches one of these (empty = start new leads, as before).
  const stages = [...new Set((Array.isArray(d?.stages) ? d.stages : []).map((s: unknown) => String(s).trim()).filter(Boolean))].slice(0, 50) as string[];
  return { name, steps, hoursFrom, hoursTo, dailyLimit, sources, stages, stopOnVisit: d?.stopOnVisit !== false };
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

export interface DripTemplate { name: string; body: string; header: 'none' | 'image' | 'document' | 'video'; sampleUrl: string }

/** Approved WhatsApp templates (name, body, header) for the step dropdown and preview — from the direct connection when on it, otherwise Chat360. [] on any error. */
async function whatsappTemplates(): Promise<DripTemplate[]> {
  try {
    if ((currentTenant()?.features as any)?.whatsappDirect) {
      const direct = await import('./whatsappDirect');
      if (await direct.isConnected()) {
        return (await direct.approvedTemplates())
          .map((t: any) => ({ name: String(t?.name || ''), body: String(t?.body || ''), header: (['image', 'document', 'video'].includes(String(t?.headerMedia || '').toLowerCase()) ? String(t.headerMedia).toLowerCase() : 'none') as DripTemplate['header'], sampleUrl: '' }))
          .filter((t) => t.name);
      }
    }
    return await (await import('./chat360')).templateDetails();
  } catch {
    return [];
  }
}

/** How many live leads are currently in each stage (bin / deleted left out), for the stage picker. */
async function stageCounts(): Promise<Record<string, number>> {
  try {
    const rows = await (await col<any>(CFG.COLL.LEADS)).aggregate([
      { $match: { stage: { $nin: [CFG.STAGES.DELETED, CFG.STAGES.TRASH] } } },
      { $group: { _id: '$stage', n: { $sum: 1 } } },
    ]).toArray();
    const out: Record<string, number> = {};
    for (const r of rows as Array<{ _id: string; n: number }>) if (r._id) out[String(r._id)] = r.n;
    return out;
  } catch {
    return {};
  }
}

async function whatsappSetup(): Promise<{ ready: boolean; reason: string }> {
  if (!(currentTenant()?.features as any)?.chat360) return { ready: false, reason: "WhatsApp (Chat360) isn't included in this company's plan." };
  const direct = (currentTenant()?.features as any)?.whatsappDirect && (await (await import('./whatsappDirect')).isConnected());
  if (!direct && !(await getSecret('CHAT360_API_KEY'))) return { ready: false, reason: 'Chat360 is not connected yet.' };
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

/** Build nodemailer attachments from stored file ids (missing or unreadable ones are skipped). */
async function mailAttachments(ids: string[]): Promise<Array<{ filename: string; content: Readable; contentType: string }>> {
  if (!ids?.length) return [];
  const { statFile, openFileStream } = await import('./storage');
  const out: Array<{ filename: string; content: Readable; contentType: string }> = [];
  for (const id of ids.slice(0, 10)) {
    try {
      const info = await statFile(id);
      if (info) out.push({ filename: info.name || 'attachment', content: await openFileStream(info), contentType: info.mime });
    } catch {
      /* skip an unreadable attachment rather than fail the whole send */
    }
  }
  return out;
}

async function sendMail(to: string, subject: string, body: string, attachments: string[] = []): Promise<void> {
  const m = await loadMail();
  if (!m?.host || !m.pass) throw fail('NOT_CONFIGURED', "The company's mail account is not set up.");
  const url = unsubscribeUrl(to);
  const files = await mailAttachments(attachments);
  await transport({ ...m, pass: decryptSecret(m.pass) }).sendMail({
    from: m.fromName ? { name: m.fromName, address: m.fromEmail } : m.fromEmail, to, subject,
    text: `${body}\n\n--\nTo stop these e-mails: ${url}`,
    ...(files.length ? { attachments: files } : {}),
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

async function sendWhatsapp(phone: string, step: DripStep, vars: Record<string, string>, leadId?: string): Promise<string> {
  const { send } = await import('./chat360');
  const params = step.params.map((p) => fillVars(p, vars));
  // a media-header template carries its header image/document/video as `link` (Chat360)
  if (step.attachments?.[0]) {
    try {
      const { publicMediaUrl } = await import('./socialPosts');
      params.unshift(`link=${publicMediaUrl(step.attachments[0])}`);
    } catch {
      /* no media link available */
    }
  }
  const r = await send({ phone, leadId, templateName: step.template, params }, SYSTEM_CTX);
  return str((r as any)?.message?.id); // the WhatsApp message id, so delivery/read receipts can update this step's log
}

/* -------------------------------- enrolment -------------------------------- */

/**
 * Enroll a lead into the first active campaign that fits, unless that person is already in one. Never fails the lead's save.
 * - `isNew` (lead just created): campaigns with no stages ("new-lead" campaigns) fit, source permitting.
 * - a campaign WITH stages fits only when the lead is AT one of those stages (so it starts the moment a lead reaches it).
 */
async function tryEnroll(lead: any, opts: { stage?: string; isNew: boolean }, now: Date): Promise<string> {
  try {
    if (!(currentTenant()?.features as any)?.dripCampaigns) return '';
    const leadId = String(lead?.[L.ID] || '');
    if (!leadId) return '';
    const source = String(lead?.[L.SOURCE] || '').trim().toLowerCase();
    const stage = String(opts.stage ?? lead?.[L.STAGE] ?? '').trim().toLowerCase();
    const list = await (await campaignsCol()).find({ status: 'active' }).sort({ createdAt: 1 }).toArray();
    const fit = list.find((c) => {
      if (c.sources.length && !c.sources.some((s) => s.toLowerCase() === source)) return false;
      const stages = c.stages || [];
      return stages.length ? !!stage && stages.some((s) => s.toLowerCase() === stage) : opts.isNew;
    });
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

/** A new lead joins the first active campaign that fits (new-lead campaigns, and stage campaigns whose stage the lead starts in). */
export const enrollNewLead = (lead: any, now = new Date()): Promise<string> => tryEnroll(lead, { isNew: true }, now);

/** A lead that has just reached `stage` joins the first active campaign targeting that stage. */
export const enrollOnStage = (lead: any, stage: string, now = new Date()): Promise<string> => tryEnroll(lead, { stage, isNew: false }, now);

/* --------------------------------- sending --------------------------------- */

/** The next moment inside the sending hours (India time): now, or when they next open. */
export function nextOpen(now: Date, from: number, to: number): Date {
  const ist = new Date(now.getTime() + IST_MS);
  const h = ist.getUTCHours();
  if (h >= from && h < to) return now;
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (h >= to ? 1 : 0), from);
  return new Date(day - IST_MS);
}

async function log(c: DripCampaign, en: Enrollment, step: DripStep | null, status: DripLog['status'], detail: string, now: Date, providerId = '') {
  await (await logsCol()).insertOne({ _id: shortId('DL'), campaignId: c._id, leadId: en.leadId, stepId: step?.id || '', channel: step?.channel || 'task', status, detail: truncate(detail, 300), day: dayOf(now), at: now, ...(providerId ? { providerId } : {}) });
}

/** Why this lead should get nothing more, if anything. Recording a STOP for good on the way. */
async function stopReason(c: DripCampaign, en: Enrollment, lead: any): Promise<string> {
  if (!lead) return 'The lead no longer exists.';
  const stage = String(lead[L.STAGE] || '');
  if ([S.BOOKED, S.LOST, S.TRASH, S.DELETED].includes(stage) || /^Disqualified/i.test(stage)) return `The lead is now ${stage}.`;
  const visit = String(lead[L.SITE_VISIT_STATUS] || '');
  if (c.stopOnVisit && [CFG.SITE_VISIT.SCHEDULED, CFG.SITE_VISIT.COMPLETED, CFG.SITE_VISIT.WALK_IN].includes(visit)) return `Site visit: ${visit}.`;
  const phone = last10(lead[L.PHONE]) || en.phoneLast10;
  const policy = await (await import('./consent')).canSend(lead[L.PHONE] || phone, 'marketing');
  if (!policy.ok) return policy.reason + '.';
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
async function sendStep(step: DripStep, lead: any): Promise<{ skip: string; providerId: string }> {
  const vars = varsOf(lead);
  const leadId = String(lead[L.ID]);
  if (step.channel === 'whatsapp') {
    const phone = String(lead[L.PHONE] || '');
    if (last10(phone).length !== 10) return { skip: 'No phone number.', providerId: '' };
    const providerId = await sendWhatsapp(phone, step, vars, leadId);
    return { skip: '', providerId };
  }
  if (step.channel === 'email') {
    const to = cleanEmail(lead[L.EMAIL]);
    if (!EMAIL.test(to)) return { skip: 'No e-mail address.', providerId: '' };
    if (await (await optOutCol()).findOne({ _id: `email:${to}` })) return { skip: 'They unsubscribed from e-mails.', providerId: '' };
    await sendMail(to, fillVars(step.subject, vars), fillVars(step.body, vars), step.attachments);
    await addTimeline(leadId, 'drip_email', `Drip e-mail sent: ${truncate(fillVars(step.subject, vars), 120)}`, '', 'System');
    return { skip: '', providerId: '' };
  }
  await addTask({ name: fillVars(step.taskName, vars), leadId, assignedTo: String(lead[L.RM] || '') || 'Unassigned', datetime: new Date().toISOString() }, SYSTEM_CTX);
  return { skip: '', providerId: '' };
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
    const { skip, providerId } = await sendStep(step, lead);
    await log(c, en, step, skip ? 'skipped' : 'sent', skip, now, providerId);
    await advance();
    return skip ? 'skipped' : 'sent';
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

/**
 * What became of the leads in each campaign: who wrote back on WhatsApp after joining it, and who has visited or booked since.
 * These are the leads' results, not proof the messages caused them: an RM may have called the same lead.
 */
async function dripResults(ids: string[]) {
  const out = new Map<string, { entered: number; replied: number; visits: number; bookings: number }>();
  for (const id of ids) out.set(id, { entered: 0, replied: 0, visits: 0, bookings: 0 });
  if (!ids.length) return out;
  const enrolled = await (await enrollCol()).find({ campaignId: { $in: ids } }, { projection: { campaignId: 1, leadId: 1, phoneLast10: 1, enrolledAt: 1 } }).toArray();
  if (!enrolled.length) return out;
  const leads = await (await col<any>(CFG.COLL.LEADS)).find({ _id: { $in: [...new Set(enrolled.map((e) => e.leadId))] } }, { projection: { stage: 1, siteVisitStatus: 1, bookingDate: 1 } }).toArray();
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  const phones = [...new Set(enrolled.map((e) => e.phoneLast10).filter((p) => p?.length === 10))];
  const lastReply = new Map<string, Date>();
  if (phones.length) {
    const rows = await (await col<any>(CFG.COLL.CHAT_MESSAGES)).aggregate<{ _id: string; last: Date }>([{ $match: { phoneLast10: { $in: phones }, direction: 'Inbound' } }, { $group: { _id: '$phoneLast10', last: { $max: '$timestamp' } } }]).toArray();
    for (const r of rows) lastReply.set(r._id, new Date(r.last));
  }
  const counted = new Set<string>(); // two leads merged into one count once
  for (const e of enrolled) {
    const seen = `${e.campaignId}:${e.leadId}`;
    if (counted.has(seen)) continue;
    counted.add(seen);
    const r = out.get(e.campaignId)!;
    r.entered++;
    const replied = lastReply.get(e.phoneLast10);
    if (replied && replied >= new Date(e.enrolledAt)) r.replied++;
    const l = leadById.get(e.leadId);
    if (!l) continue;
    if ([CFG.SITE_VISIT.COMPLETED, CFG.SITE_VISIT.WALK_IN].includes(l.siteVisitStatus)) r.visits++;
    if (l.stage === S.BOOKED || l.bookingDate) r.bookings++;
  }
  return out;
}

export async function getDrip(ctx: Ctx) {
  const rows = await (await campaignsCol()).find({ status: { $ne: 'archived' } }).sort({ createdAt: -1 }).toArray();
  const ids = rows.map((r) => r._id);
  const counts = async (coll: Awaited<ReturnType<typeof enrollCol>> | Awaited<ReturnType<typeof logsCol>>) => (coll as any).aggregate([{ $match: { campaignId: { $in: ids } } }, { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } }]).toArray() as Promise<Array<{ _id: { c: string; s: string }; n: number }>>;
  const entered = await counts(await enrollCol());
  const logged = await counts(await logsCol());
  const n = (list: Array<{ _id: { c: string; s: string }; n: number }>, c: string, s: string) => list.find((x) => x._id.c === c && x._id.s === s)?.n || 0;
  const m = await loadMail();
  const results = await dripResults(ids);
  return {
    campaigns: rows.map((r) => ({
      id: r._id, name: r.name, status: r.status, sources: r.sources, stages: r.stages || [], steps: r.steps, hoursFrom: r.hoursFrom, hoursTo: r.hoursTo, dailyLimit: r.dailyLimit, stopOnVisit: r.stopOnVisit, tested: !!r.testedAt, createdBy: r.createdBy,
      stats: { running: n(entered, r._id, 'active'), finished: n(entered, r._id, 'completed'), stopped: n(entered, r._id, 'stopped'), sent: n(logged, r._id, 'sent'), skipped: n(logged, r._id, 'skipped'), failed: n(logged, r._id, 'failed'), ...results.get(r._id)! },
    })),
    whatsapp: await whatsappSetup(),
    // the company's own lead stages, so a campaign's "start at stage" is picked from a list, not typed
    stageOptions: (await getLeadsConfig().catch(() => ({ options: {} as Record<string, string[]> }))).options[CFG.LEAD.STAGE] || [],
    // how many leads are currently in each stage, shown next to the stage picker
    stageCounts: await stageCounts(),
    // approved WhatsApp templates, so a step's template is picked from a list (the field still allows typing a name)
    templates: await whatsappTemplates(),
    email: await emailSetup(),
    // the account details only for those who may change them, and never the password
    mail: ctx.user && (await import('../core/auth')).can(ctx.user, 'integrations.connect') ? { host: m?.host || '', port: m?.port || 587, user: m?.user || '', fromName: m?.fromName || '', fromEmail: m?.fromEmail || '', passSet: !!m?.pass } : null,
  };
}

export async function getDripActivity(d: any) {
  const id = String(d?.id || '');
  const c = await (await campaignsCol()).findOne({ _id: id });
  const logs = await logsCol();
  const rows = await logs.find({ campaignId: id }).sort({ at: -1 }).limit(100).toArray();

  // per-step funnel: how many were sent / failed / skipped at each step, in step order
  const byStep = await logs.aggregate<{ _id: { s: string; st: string }; n: number }>([{ $match: { campaignId: id } }, { $group: { _id: { s: '$stepId', st: '$status' }, n: { $sum: 1 } } }]).toArray();
  const stepStat = (stepId: string, status: string) => byStep.find((x) => x._id.s === stepId && x._id.st === status)?.n || 0;
  const funnel = (c?.steps || []).map((s, i) => ({ step: i + 1, channel: s.channel, label: s.channel === 'whatsapp' ? s.template : s.channel === 'email' ? s.subject : s.taskName, sent: stepStat(s.id, 'sent'), failed: stepStat(s.id, 'failed'), skipped: stepStat(s.id, 'skipped') }));

  // why things failed: the top reasons, grouped
  const reasons = await logs.aggregate<{ _id: string; n: number }>([{ $match: { campaignId: id, status: 'failed' } }, { $group: { _id: '$detail', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]).toArray();
  const failReasons = reasons.map((r) => ({ reason: str(r._id) || 'Unknown error', n: r.n }));

  // who is in the campaign now, and at which step
  const active = await (await enrollCol()).find({ campaignId: id, status: 'active' }).sort({ enrolledAt: -1 }).limit(200).toArray();
  const names = new Map<string, string>();
  for (const l of await (await col<{ _id: string; name?: string }>(CFG.COLL.LEADS)).find({ _id: { $in: [...new Set(active.map((e) => e.leadId))] } }, { projection: { name: 1 } }).toArray()) names.set(l._id, String(l.name || ''));
  const enrolled = active.map((e) => ({ leadId: e.leadId, name: names.get(e.leadId) || e.leadId, step: e.stepIndex + 1, totalSteps: c?.steps.length || 0, nextAt: e.nextAt ? e.nextAt.toISOString() : '', enrolledAt: e.enrolledAt.toISOString() }));

  // WhatsApp delivery / read receipts recorded against sent messages
  const dl = await logs.aggregate<{ _id: string; n: number }>([{ $match: { campaignId: id, delivery: { $exists: true } } }, { $group: { _id: '$delivery', n: { $sum: 1 } } }]).toArray();
  const dCount = (s: string) => dl.find((x) => x._id === s)?.n || 0;
  const delivery = { sent: await logs.countDocuments({ campaignId: id, status: 'sent', channel: 'whatsapp' }), delivered: dCount('delivered') + dCount('read'), read: dCount('read'), failed: dCount('failed') };

  return {
    rows: rows.map((r) => ({ id: r._id, leadId: r.leadId, channel: r.channel, status: r.status, detail: r.detail, delivery: r.delivery || '', at: r.at.toISOString() })),
    funnel, failReasons, enrolled, delivery,
    failedCount: await logs.countDocuments({ campaignId: id, status: 'failed' }),
  };
}

/** Stop one lead's enrolment in a campaign (from the enrolled-leads list). */
export async function stopDripLead(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const campaignId = String(d?.id || '');
  const leadId = String(d?.leadId || '');
  const r = await (await enrollCol()).updateOne({ campaignId, leadId, status: 'active' }, { $set: { status: 'stopped', stopReason: 'Stopped by an administrator.', nextAt: null, sendingStep: '', updatedAt: new Date() } });
  if (!r.matchedCount) throw fail('NOT_FOUND', 'That lead is not currently in this campaign.');
  await addTimeline(leadId, 'drip_stopped', 'Drip campaign stopped by an administrator', '', ctx.user?.name || 'System').catch(() => undefined);
  await bumpVersion();
  return { ok: true };
}

/** Resend the steps that failed in the last 7 days (skipping leads that should no longer be messaged). */
export async function retryDripFailed(d: any, ctx: Ctx): Promise<{ resent: number; failed: number; skipped: number }> {
  const c = await (await campaignsCol()).findOne({ _id: String(d?.id || '') });
  if (!c) throw fail('NOT_FOUND', 'Campaign not found');
  const now = new Date();
  const failed = await (await logsCol()).find({ campaignId: c._id, status: 'failed', at: { $gte: new Date(now.getTime() - 7 * 24 * 3600_000) } }).sort({ at: -1 }).limit(300).toArray();
  const stepById = new Map(c.steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const logs = await logsCol();
  let resent = 0, failedAgain = 0, skipped = 0;
  for (const f of failed) {
    const key = `${f.leadId}:${f.stepId}`;
    if (done.has(key)) continue;
    done.add(key);
    const step = stepById.get(f.stepId);
    const lead = step ? await getLead(f.leadId) : null;
    if (!step || !lead) { skipped++; continue; }
    const en = await (await enrollCol()).findOne({ campaignId: c._id, leadId: f.leadId });
    const why = await stopReason(c, (en || { enrolledAt: new Date(0), phoneLast10: last10(lead[L.PHONE]) }) as Enrollment, lead);
    if (why) { skipped++; continue; }
    try {
      const { skip, providerId } = await sendStep(step, lead);
      await logs.insertOne({ _id: shortId('DL'), campaignId: c._id, leadId: f.leadId, stepId: step.id, channel: step.channel, status: skip ? 'skipped' : 'sent', detail: skip || 'Resent after a failure', day: dayOf(now), at: new Date(), ...(providerId ? { providerId } : {}) });
      skip ? skipped++ : resent++;
    } catch (e: any) {
      await logs.insertOne({ _id: shortId('DL'), campaignId: c._id, leadId: f.leadId, stepId: step.id, channel: step.channel, status: 'failed', detail: truncate(String(e?.message || e), 300), day: dayOf(now), at: new Date() });
      failedAgain++;
    }
  }
  await auditLog(ctx, 'Drip Failed Steps Retried', 'Settings', c._id, `${resent} resent, ${failedAgain} failed, ${skipped} skipped`);
  await bumpVersion();
  return { resent, failed: failedAgain, skipped };
}

const feature = () => {
  if (!(currentTenant()?.features as any)?.dripCampaigns) throw fail('FORBIDDEN', "Drip campaigns are not included in your company's plan.");
};

export const actions: ActionMap = {
  getDrip: { fn: (_d, ctx) => { feature(); return getDrip(ctx); }, perm: 'marketing.drip' },
  getDripActivity: { fn: (d) => { feature(); return getDripActivity(d); }, perm: 'marketing.drip' },
  saveDripCampaign: { fn: (d, ctx) => { feature(); return saveDripCampaign(d, ctx); }, perm: 'marketing.drip' },
  testDripCampaign: { fn: (d, ctx) => { feature(); return testDripCampaign(d, ctx); }, perm: 'marketing.drip' },
  setDripStatus: { fn: (d, ctx) => { feature(); return setDripStatus(d, ctx); }, perm: 'marketing.drip' },
  stopDripLead: { fn: (d, ctx) => { feature(); return stopDripLead(d, ctx); }, perm: 'marketing.drip' },
  retryDripFailed: { fn: (d, ctx) => { feature(); return retryDripFailed(d, ctx); }, perm: 'marketing.drip' },
  saveDripEmail: { fn: (d, ctx) => { feature(); return saveDripEmail(d, ctx); }, perm: 'integrations.connect' },
};
