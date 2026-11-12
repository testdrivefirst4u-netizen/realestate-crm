/**
 * WhatsApp campaigns (plan feature whatsappCampaigns, on a direct WhatsApp connection): one approved template to a chosen list,
 * now or at a set time. Chat360 companies keep Chat360's own campaigns.
 *
 * Nobody is messaged twice: a person is one row per campaign, claimed before sending. If a send's outcome is unknown it is
 * marked failed, never retried. Anything Meta says about the account as a whole (restricted, too fast, template paused) and
 * running out of credits pause the campaign, and the people not reached stay waiting for Resume.
 *
 * Servers here stop after about a minute, so work is done in batches: each hands over to the next (/api/cron/campaigns), the
 * screen also pushes while open, and the background job picks up the rest, including scheduled ones.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col } from '../core/db';
import { fail } from '../core/errors';
import { logError } from '../core/events';
import { leadFilter } from '../core/scope';
import { currentTenant } from '../core/tenant';
import { dateKey, e164, last10, shortId, str, truncate } from '../core/utils';
import { STOP_WORDS } from './whatsappBotEngine';
import { creditsBalance, creditsOn, getPricing, ledgerCol, normalizeCategory } from './whatsappCredits';
import { isConnected, sendDirect } from './whatsappDirect';

const L = CFG.LEAD;
const S = CFG.STAGES;
const MAX_RECIPIENTS = 10000;
const BATCH = 20;
const AT_ONCE = 10;
const STALE_MS = 10 * 60000;
const REPLY_WINDOW_MS = 3 * 86400000;
const CAMPAIGN_CTX: Ctx = { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: 'Campaign' }, action: 'whatsappCampaign' };
/** Meta is saying something about the whole account, so carrying on would only make it worse. */
const PAUSE_CODES = new Set([190, 368, 4, 80007, 130429, 131048, 131031, 132015, 132016, 133010]);

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'stopped';
export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
export interface CampaignDoc {
  _id: string; name: string; status: CampaignStatus; template: string; language: string; category: string; params: string[]; headerFileId: string; perDay: number;
  audience: string; skipped: Record<string, number>; tested: boolean; consentBy: string; consentAt: Date | null; scheduledAt: Date | null; startedAt: Date | null; finishedAt: Date | null;
  pauseReason: string; lockUntil: Date | null; createdBy: string; createdAt: Date; updatedAt: Date;
}
export interface RecipientDoc { _id: string; campaignId: string; phone: string; phoneLast10: string; leadId: string; name: string; status: RecipientStatus; messageId: string; error: string; claimedAt: Date | null; sentAt: Date | null; sentDay: string; repliedAt: Date | null }

const campaignsCol = () => col<CampaignDoc>('whatsappCampaigns');
const recipientsCol = () => col<RecipientDoc>('whatsappCampaignRecipients');
const optOutCol = () => col<any>('dripOptOuts');
const templatesCol = () => col<any>('whatsappTemplates');
const leadsCol = () => col<any>(CFG.COLL.LEADS);
const bad = (m: string) => fail('VALIDATION', m);
const featureOn = () => !!(currentTenant()?.features as any)?.whatsappCampaigns;

/* --------------------------------- values ---------------------------------- */

const PLACEHOLDER_NAME = /^(whatsapp\b|unknown$|\+?\d[\d\s-]*$)/i;

/** One value of the template for one person. A missing name reads "there" ("Hello there"). Anything else missing is left empty, and that person fails rather than getting a blank. */
export function fillValue(spec: string, r: { name: string; rm: string; unit: string }, company: string): string {
  const name = r.name && !PLACEHOLDER_NAME.test(r.name.trim()) ? r.name.trim() : '';
  const vars: Record<string, string> = { name: name || 'there', first_name: name.split(/\s+/)[0] || 'there', rm: r.rm, unit: r.unit, company };
  return String(spec || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').trim();
}

/* -------------------------------- building --------------------------------- */

async function approvedTemplate(name: string, language: string) {
  const t = await (await templatesCol()).findOne({ name, language });
  if (!t) throw bad('Choose a template.');
  if (t.status !== 'APPROVED') throw bad(`The template ${name} is not approved yet.`);
  if (!t.sendable && !t.headerMedia) throw bad(`The template ${name} cannot be sent. ${t.notSendable}`);
  return t;
}

export async function saveCampaign(d: any, ctx: Ctx): Promise<{ id: string }> {
  const name = truncate(str(d?.name), 100);
  if (!name) throw bad('Give the campaign a name.');
  const template = str(d?.template);
  const language = str(d?.language);
  const t = await approvedTemplate(template, language);
  const params: string[] = (Array.isArray(d?.params) ? d.params : []).map((p: unknown) => truncate(String(p ?? ''), 500));
  if (params.length !== (t.paramNames || []).length) throw bad(`This template needs ${(t.paramNames || []).length} values.`);
  if (params.some((p) => !p.trim())) throw bad('Fill in every value of the template.');
  const headerFileId = str(d?.headerFileId);
  if (t.headerMedia && !headerFileId) throw bad(`This template needs a ${t.headerMedia} at the top. Add one.`);
  const perDay = Math.round(Number(d?.perDay)) || 250;
  if (perDay < 1 || perDay > 100000) throw bad('Enter how many people to message each day.');
  const fields = { name, template, language, category: normalizeCategory(t.category, 'marketing'), params, headerFileId: t.headerMedia ? headerFileId : '', perDay, tested: false, updatedAt: new Date() };
  const c = await campaignsCol();
  const id = str(d?.id);
  if (id) {
    const cur = await c.findOne({ _id: id });
    if (!cur) throw fail('NOT_FOUND', 'This campaign is no longer here.');
    if (cur.status !== 'draft') throw bad('Only a draft can be changed.');
    await c.updateOne({ _id: id }, { $set: fields });
    return { id };
  }
  const newId = shortId('WC');
  await c.insertOne({ _id: newId, ...fields, status: 'draft', audience: '', skipped: {}, consentBy: '', consentAt: null, scheduledAt: null, startedAt: null, finishedAt: null, pauseReason: '', lockUntil: null, createdBy: ctx.user?.name || 'System', createdAt: new Date() });
  await auditLog(ctx, 'WhatsApp Campaign Created', 'Campaign', newId, name);
  return { id: newId };
}

/** Who gets it. Leads are checked against what this person may see; numbers that opted out, or are not real, are left out and counted. */
export async function setAudience(d: any, ctx: Ctx): Promise<{ added: number; skipped: Record<string, number> }> {
  const id = str(d?.id);
  const c = await (await campaignsCol()).findOne({ _id: id });
  if (!c) throw fail('NOT_FOUND', 'This campaign is no longer here.');
  if (c.status !== 'draft') throw bad('Only a draft can be changed.');
  const leadIds: string[] = (Array.isArray(d?.leadIds) ? d.leadIds : []).map(str).filter(Boolean);
  const list: Array<{ phone: unknown; name: unknown }> = Array.isArray(d?.list) ? d.list : [];
  if (leadIds.length + list.length > MAX_RECIPIENTS) throw bad(`A campaign can have up to ${MAX_RECIPIENTS.toLocaleString('en-IN')} people.`);
  if (!leadIds.length && !list.length) throw bad('Choose who should get this.');
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] || 0) + 1; };
  const people = new Map<string, { phone: string; name: string; leadId: string }>();
  const add = (phone: string, name: string, leadId: string) => {
    const full = e164(phone);
    const key = last10(full);
    if (key.length < 10 || full.length < 11 || full.length > 15) return skip('No valid number');
    if (creditsOn() && !/^91\d{10}$/.test(full)) return skip('Outside India');
    if (people.has(key)) return skip('Same number twice');
    people.set(key, { phone: full, name: truncate(name, 120), leadId });
  };
  if (leadIds.length) {
    const scope = await leadFilter(ctx);
    const leads = await (await leadsCol()).find({ _id: { $in: leadIds }, ...(scope ? { $and: [scope] } : {}) } as any, { projection: { name: 1, phone: 1, stage: 1 } }).toArray();
    if (leads.length < new Set(leadIds).size) skipped['Not available to you'] = new Set(leadIds).size - leads.length;
    for (const l of leads) {
      if ([S.TRASH, S.DELETED].includes(l.stage)) { skip('Deleted leads'); continue; }
      add(str(l.phone), str(l.name), String(l._id));
    }
  }
  for (const row of list) add(str(row?.phone), str(row?.name), '');
  const opted = new Set((await (await optOutCol()).find({ _id: { $in: [...people.keys()].map((k) => `whatsapp:${k}`) } }, { projection: { _id: 1 } }).toArray()).map((x: any) => String(x._id).slice(9)));
  for (const k of opted) {
    people.delete(k);
    skip('Asked not to be messaged');
  }
  const recipients = await recipientsCol();
  await recipients.deleteMany({ campaignId: id });
  const docs = [...people.entries()].map(([key, p]): RecipientDoc => ({ _id: `${id}:${key}`, campaignId: id, phone: p.phone, phoneLast10: key, leadId: p.leadId, name: p.name, status: 'pending', messageId: '', error: '', claimedAt: null, sentAt: null, sentDay: '', repliedAt: null }));
  for (let i = 0; i < docs.length; i += 1000) await recipients.insertMany(docs.slice(i, i + 1000), { ordered: false });
  await (await campaignsCol()).updateOne({ _id: id }, { $set: { audience: truncate(str(d?.label), 120), skipped, tested: false, updatedAt: new Date() } });
  return { added: docs.length, skipped };
}

/** A real send to one number, so the person starting it has seen what customers will get. */
export async function testCampaign(d: any): Promise<{ ok: true }> {
  const c = await (await campaignsCol()).findOne({ _id: str(d?.id) });
  if (!c) throw fail('NOT_FOUND', 'This campaign is no longer here.');
  const phone = e164(str(d?.phone));
  if (phone.length < 11) throw bad('Enter the number to test on, with the country code.');
  const company = str(currentTenant()?.name);
  await sendDirect({ phone, templateName: c.template, templateLanguage: c.language, params: c.params.map((p) => fillValue(p, { name: 'Test Customer', rm: 'Your RM', unit: 'Sample unit' }, company) || 'Sample'), headerFileId: c.headerFileId, isTest: true }, CAMPAIGN_CTX);
  await (await campaignsCol()).updateOne({ _id: c._id }, { $set: { tested: true } });
  return { ok: true };
}

const counts = async (id: string) => {
  const out: Record<string, number> = {};
  for (const r of await (await recipientsCol()).aggregate<{ _id: string; n: number }>([{ $match: { campaignId: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()) out[r._id] = r.n;
  return out;
};

export async function startCampaign(d: any, ctx: Ctx, now = new Date()): Promise<{ status: CampaignStatus }> {
  const c = await (await campaignsCol()).findOne({ _id: str(d?.id) });
  if (!c) throw fail('NOT_FOUND', 'This campaign is no longer here.');
  if (c.status !== 'draft') throw bad('This campaign has already been started.');
  if (!(await isConnected())) throw bad('Connect a WhatsApp number first, in Settings › WhatsApp direct.');
  if (d?.consent !== true) throw bad('Confirm these people agreed to hear from you on WhatsApp.');
  if (!c.tested) throw bad('Send yourself a test first, after the last change.');
  await approvedTemplate(c.template, c.language);
  const n = await counts(c._id);
  if (!n.pending) throw bad('There is nobody to send this to.');
  if (creditsOn()) {
    const need = n.pending * (await getPricing()).prices[normalizeCategory(c.category, 'marketing')];
    const { available } = await creditsBalance();
    if (available < need) throw bad(`This campaign needs about ₹${need.toLocaleString('en-IN', { maximumFractionDigits: 2 })} of credits, and ₹${available.toLocaleString('en-IN')} is available.`);
  }
  let scheduledAt: Date | null = null;
  if (d?.at) {
    scheduledAt = new Date(String(d.at));
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) throw bad('Choose a time in the future.');
    if (scheduledAt.getTime() > now.getTime() + 60 * 86400000) throw bad('Choose a time within the next 60 days.');
  }
  const status: CampaignStatus = scheduledAt ? 'scheduled' : 'running';
  await (await campaignsCol()).updateOne({ _id: c._id }, { $set: { status, scheduledAt, startedAt: scheduledAt ? null : now, consentBy: ctx.user?.name || 'System', consentAt: now, pauseReason: '', updatedAt: now } });
  await auditLog(ctx, scheduledAt ? 'WhatsApp Campaign Scheduled' : 'WhatsApp Campaign Started', 'Campaign', c._id, `${c.name} · ${n.pending} people · consent confirmed`);
  if (!scheduledAt) await nudgeWorker();
  return { status };
}

export async function changeCampaign(d: any, ctx: Ctx): Promise<{ ok: true }> {
  const c = await (await campaignsCol()).findOne({ _id: str(d?.id) });
  if (!c) throw fail('NOT_FOUND', 'This campaign is no longer here.');
  const action = str(d?.action);
  const coll = await campaignsCol();
  if (action === 'pause' && ['running', 'scheduled'].includes(c.status)) await coll.updateOne({ _id: c._id }, { $set: { status: 'paused', pauseReason: `Paused by ${ctx.user?.name || 'someone'}.` } });
  else if (action === 'resume' && c.status === 'paused') {
    await coll.updateOne({ _id: c._id }, { $set: { status: 'running', startedAt: c.startedAt || new Date(), pauseReason: '' } });
    await nudgeWorker();
  } else if (action === 'stop' && ['running', 'scheduled', 'paused'].includes(c.status)) await coll.updateOne({ _id: c._id }, { $set: { status: 'stopped', finishedAt: new Date() } });
  else if (action === 'delete' && c.status === 'draft') {
    await (await recipientsCol()).deleteMany({ campaignId: c._id });
    await coll.deleteOne({ _id: c._id });
  } else throw bad('That cannot be done to this campaign now.');
  await auditLog(ctx, `WhatsApp Campaign ${action}`, 'Campaign', c._id, c.name);
  return { ok: true };
}

/* --------------------------------- sending --------------------------------- */

async function pause(id: string, reason: string) {
  await (await campaignsCol()).updateOne({ _id: id, status: 'running' }, { $set: { status: 'paused', pauseReason: truncate(reason, 300) } });
}

/** Send one person. Refusals about the whole account put them back in the queue; anything else is final, so nobody gets it twice. */
async function sendOne(c: CampaignDoc, r: RecipientDoc, lead: any, company: string, now: Date): Promise<'ok' | 'pause' | 'done'> {
  const recipients = await recipientsCol();
  // checked again right before sending: an opt-out that arrived while the campaign was queued stops it here
  const allowed = await (await import('./consent')).canSend(r.phone, 'marketing');
  if (!allowed.ok || (await (await optOutCol()).findOne({ _id: `whatsapp:${r.phoneLast10}` }, { projection: { _id: 1 } }))) {
    await recipients.updateOne({ _id: r._id }, { $set: { status: 'skipped', error: allowed.ok ? 'Asked not to be messaged.' : allowed.reason } });
    return 'done';
  }
  const person = { name: str(lead?.name) || r.name, rm: str(lead?.assignedRm), unit: str(lead?.unitType) };
  const params = c.params.map((p) => fillValue(p, person, company));
  if (params.some((p) => !p)) {
    await recipients.updateOne({ _id: r._id }, { $set: { status: 'failed', error: 'A value of the template is empty for this person.' } });
    return 'done';
  }
  try {
    const { message } = await sendDirect({ phone: r.phone, leadId: r.leadId || undefined, contactName: r.name, templateName: c.template, templateLanguage: c.language, params, headerFileId: c.headerFileId, campaignId: c._id }, CAMPAIGN_CTX);
    const id = str(message?.id);
    // a receipt may already have reached the message itself
    const row = id ? await (await col<any>(CFG.COLL.CHAT_MESSAGES)).findOne({ _id: id }, { projection: { status: 1, error: 1 } }) : null;
    const status = (['delivered', 'read', 'failed'].includes(str(row?.status)) ? row.status : 'sent') as RecipientStatus;
    await recipients.updateOne({ _id: r._id }, { $set: { status, messageId: id, sentAt: now, sentDay: dateKey(now), error: str(row?.error) } });
    return 'ok';
  } catch (e: any) {
    const code = Number(e?.details?.metaCode) || 0;
    const noCredits = /credits are finished/i.test(String(e?.message));
    if (noCredits || PAUSE_CODES.has(code)) {
      await recipients.updateOne({ _id: r._id }, { $set: { status: 'pending', claimedAt: null } });
      await pause(c._id, noCredits ? 'Credits ran out. Add credits, then resume.' : String(e?.message));
      return 'pause';
    }
    await recipients.updateOne({ _id: r._id }, { $set: { status: 'failed', error: truncate(String(e?.message), 300) } });
    return 'done';
  }
}

/** Run what is due until the time is up. Returns whether more is waiting, so the next batch can be started. */
export async function runCampaignsDue(budgetMs = 45000, now = new Date()): Promise<{ sent: number; more: boolean }> {
  const out = { sent: 0, more: false };
  if (!featureOn()) return out;
  const coll = await campaignsCol();
  const recipients = await recipientsCol();
  await coll.updateMany({ status: 'scheduled', scheduledAt: { $lte: now } }, { $set: { status: 'running', startedAt: now } });
  const until = Date.now() + budgetMs;
  const company = str(currentTenant()?.name);
  for (const listed of await coll.find({ status: 'running' }).sort({ startedAt: 1 }).toArray()) {
    // one worker per campaign
    const locked = await coll.findOneAndUpdate({ _id: listed._id, status: 'running', $or: [{ lockUntil: null }, { lockUntil: { $lt: new Date() } }] }, { $set: { lockUntil: new Date(Date.now() + budgetMs + 15000) } });
    if (!locked) { out.more = true; continue; }
    try {
      // a send that never reported back: unknown, so never tried again
      await recipients.updateMany({ campaignId: listed._id, status: 'sending', claimedAt: { $lt: new Date(now.getTime() - STALE_MS) } }, { $set: { status: 'failed', error: 'The send was interrupted, so it may not have gone out. Not tried again, to avoid sending twice.' } });
      for (;;) {
        if (Date.now() >= until) { out.more = true; break; }
        const c = await coll.findOne({ _id: listed._id });
        if (!c || c.status !== 'running') break;
        const today = await recipients.countDocuments({ sentDay: dateKey(now) });
        const room = c.perDay - today;
        if (room <= 0) break; // tomorrow's job carries on
        const batch = await recipients.find({ campaignId: c._id, status: 'pending' }).limit(Math.min(BATCH, room)).toArray();
        if (!batch.length) {
          if (!(await recipients.countDocuments({ campaignId: c._id, status: 'sending' }))) await coll.updateOne({ _id: c._id, status: 'running' }, { $set: { status: 'completed', finishedAt: new Date() } });
          break;
        }
        const claimed: RecipientDoc[] = [];
        for (const r of batch) {
          const got = await recipients.updateOne({ _id: r._id, status: 'pending' }, { $set: { status: 'sending', claimedAt: new Date() } });
          if (got.modifiedCount) claimed.push(r);
        }
        const leads = new Map((await (await leadsCol()).find({ _id: { $in: claimed.map((r) => r.leadId).filter(Boolean) } }, { projection: { name: 1, assignedRm: 1, unitType: 1 } }).toArray()).map((l: any) => [String(l._id), l]));
        let paused = false;
        for (let i = 0; i < claimed.length && !paused; i += AT_ONCE) {
          const results = await Promise.all(claimed.slice(i, i + AT_ONCE).map((r) => sendOne(c, r, leads.get(r.leadId), company, now)));
          out.sent += results.filter((x) => x === 'ok').length;
          paused = results.includes('pause');
        }
        // whoever was claimed but not reached goes back
        if (paused) await recipients.updateMany({ _id: { $in: claimed.map((r) => r._id) }, status: 'sending', messageId: '' }, { $set: { status: 'pending', claimedAt: null } });
        if (paused) break;
      }
    } catch (e: any) {
      await logError('whatsappCampaign.run', e?.code || 'INTERNAL', e?.message, e?.stack, '', { campaignId: listed._id });
    } finally {
      await coll.updateOne({ _id: listed._id }, { $set: { lockUntil: null } });
    }
  }
  if (out.sent) await bumpVersion();
  return out;
}

/** Start the next batch without waiting for it. If this fails, the screen and the background job carry on. */
export async function nudgeWorker(): Promise<void> {
  const base = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const secret = process.env.CRON_SECRET?.trim();
  if (!base || !secret) return;
  await fetch(`${base}/api/cron/campaigns`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(1500) }).catch(() => undefined);
}

/* ------------------------------ what came back ------------------------------ */

const AHEAD: Record<string, RecipientStatus[]> = { sent: ['delivered', 'read', 'failed'], delivered: ['read', 'failed'], read: ['failed'] };

/** A receipt from Meta. Account-wide problems pause the campaign. */
export async function noteCampaignStatus(messageId: string, status: string, error: string, metaCode: number): Promise<void> {
  if (!featureOn()) return;
  const recipients = await recipientsCol();
  if (status === 'failed') {
    const r = await recipients.findOneAndUpdate({ messageId, status: { $ne: 'failed' } }, { $set: { status: 'failed', error: truncate(error, 300) } });
    if (r && PAUSE_CODES.has(metaCode)) await pause(r.campaignId, error);
    return;
  }
  if (AHEAD[status]) await recipients.updateOne({ messageId, status: { $nin: [...AHEAD[status], status as RecipientStatus] } }, { $set: { status: status as RecipientStatus } });
}

/** The customer answered: counted as a reply to the latest campaign they got. STOP is remembered, for good. */
export async function noteCampaignReply(phone: string, text: string, now = new Date()): Promise<void> {
  if (!featureOn()) return;
  const key = last10(phone);
  if (STOP_WORDS.test(text)) await (await optOutCol()).updateOne({ _id: `whatsapp:${key}` }, { $set: { channel: 'whatsapp', at: now, how: 'Replied STOP' } }, { upsert: true });
  const latest = await (await recipientsCol()).find({ phoneLast10: key, sentAt: { $gte: new Date(now.getTime() - REPLY_WINDOW_MS) }, repliedAt: null }).sort({ sentAt: -1 }).limit(1).next();
  if (latest) await (await recipientsCol()).updateOne({ _id: latest._id }, { $set: { repliedAt: now } });
}

/* --------------------------------- reports --------------------------------- */

export async function listCampaigns() {
  const list = await (await campaignsCol()).find({}).sort({ createdAt: -1 }).limit(300).toArray();
  const ids = list.map((c) => c._id);
  const grouped = await (await recipientsCol()).aggregate<{ _id: { c: string; s: string }; n: number }>([{ $match: { campaignId: { $in: ids } } }, { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } }]).toArray();
  const replies = await (await recipientsCol()).aggregate<{ _id: string; n: number }>([{ $match: { campaignId: { $in: ids }, repliedAt: { $ne: null } } }, { $group: { _id: '$campaignId', n: { $sum: 1 } } }]).toArray();
  const spent = await (await ledgerCol()).aggregate<{ _id: string; u: number }>([{ $match: { campaignId: { $in: ids } } }, { $group: { _id: '$campaignId', u: { $sum: '$units' } } }]).toArray();
  const pricing = await getPricing();
  return {
    connected: await isConnected(), creditsOn: creditsOn(), prices: pricing.prices,
    campaigns: list.map((c) => {
      const n = (s: string) => grouped.find((g) => g._id.c === c._id && g._id.s === s)?.n || 0;
      const total = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'].reduce((t, s) => t + n(s), 0);
      return {
        id: c._id, name: c.name, status: c.status, template: c.template, language: c.language, category: c.category, params: c.params, headerFileId: c.headerFileId, perDay: c.perDay, audience: c.audience, skippedAtStart: c.skipped, tested: c.tested,
        scheduledAt: c.scheduledAt?.toISOString() || '', startedAt: c.startedAt?.toISOString() || '', finishedAt: c.finishedAt?.toISOString() || '', pauseReason: c.pauseReason, createdBy: c.createdBy, createdAt: c.createdAt.toISOString(),
        stats: { total, waiting: n('pending') + n('sending'), sent: n('sent') + n('delivered') + n('read'), delivered: n('delivered') + n('read'), read: n('read'), failed: n('failed'), skipped: n('skipped'), replied: replies.find((r) => r._id === c._id)?.n || 0, credits: Math.round(-(spent.find((s) => s._id === c._id)?.u || 0)) / 10000 },
      };
    }),
  };
}

export async function campaignDetail(d: any) {
  const id = str(d?.id);
  if (!(await (await campaignsCol()).findOne({ _id: id }))) throw fail('NOT_FOUND', 'This campaign is no longer here.');
  const recipients = await recipientsCol();
  const leadIds = (await recipients.distinct('leadId', { campaignId: id, status: { $in: ['sent', 'delivered', 'read'] } })).filter(Boolean);
  const leads = await (await leadsCol()).find({ _id: { $in: leadIds } }, { projection: { stage: 1, siteVisitStatus: 1, bookingDate: 1 } }).toArray();
  const failures = await recipients.find({ campaignId: id, status: 'failed' }, { projection: { name: 1, phone: 1, error: 1 } }).limit(50).toArray();
  return {
    visits: leads.filter((l: any) => [CFG.SITE_VISIT.COMPLETED, CFG.SITE_VISIT.WALK_IN].includes(l.siteVisitStatus)).length,
    bookings: leads.filter((l: any) => l.stage === S.BOOKED || l.bookingDate).length,
    failures: failures.map((f) => ({ name: f.name, phone: f.phone, error: f.error })),
  };
}

const need = (fn: (d: any, ctx: Ctx) => Promise<unknown>) => (d: any, ctx: Ctx) => {
  if (!featureOn()) throw fail('FORBIDDEN', 'WhatsApp campaigns are not included in your company\'s plan.');
  return fn(d, ctx);
};

export const actions: ActionMap = {
  waCampaignList: { fn: need(() => listCampaigns()), perm: 'marketing.campaigns' },
  waCampaignDetail: { fn: need((d) => campaignDetail(d)), perm: 'marketing.campaigns' },
  waCampaignSave: { fn: need(saveCampaign), perm: 'marketing.campaigns' },
  waCampaignAudience: { fn: need(setAudience), perm: 'marketing.campaigns' },
  waCampaignTest: { fn: need((d) => testCampaign(d)), perm: 'marketing.campaigns' },
  waCampaignStart: { fn: need((d, ctx) => startCampaign(d, ctx)), perm: 'marketing.campaigns' },
  waCampaignChange: { fn: need(changeCampaign), perm: 'marketing.campaigns' },
  waCampaignTick: { fn: need(() => runCampaignsDue(40000)), perm: 'marketing.campaigns' },
};
