/**
 * JustConnect step 3: caller names, outcomes both ways, call report.
 *
 *  - Contacts: every live lead with a phone number is kept as a JustConnect contact (POST /contacts matches by phone),
 *    so an agent sees "Meera Kapoor · Hot · 2.5 BHK" before picking up. Changed leads are sent by the background
 *    check (a batch per run, within JustConnect's 120 requests a minute); new leads go at once. Setting jcContactSync.
 *  - Outcomes: what an agent files in JustConnect becomes a remark on the lead (once per call); what an RM files in
 *    the CRM on a JustConnect call is filed back in JustConnect (PATCH /call-logs/{id}).
 *  - Report: GET /reports/calls for Sales MIS, agents shown by their CRM name.
 */
import type { ActionMap } from '../core/actions';
import { listUsers, SYSTEM_CTX, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { logError } from '../core/events';
import type { LeadDoc } from '../core/leadShape';
import { assertLeadAccess } from '../core/scope';
import { getSecret, settingsAll } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { last10, truncate } from '../core/utils';
import { jc, JustConnectError, type JcAgent } from '../integrations/justconnect';
import { agentFor } from './justconnect';

const S = CFG.STAGES;
const DEAD = [S.TRASH, S.DELETED];

/* -------------------------------- contacts ------------------------------- */

export async function contactSyncOn(): Promise<boolean> {
  if (!(await getSecret('JUSTCONNECT_API_KEY'))) return false;
  return (await settingsAll()).jcContactSync !== 'false';
}

/** The contact JustConnect keeps for a lead. */
export function contactFor(l: Pick<LeadDoc, '_id' | 'name' | 'phone' | 'email' | 'stage' | 'source' | 'unitType' | 'assignedRm'>) {
  const fields: Record<string, string> = { 'CRM ID': l._id };
  if (l.stage) fields.Stage = l.stage;
  if (l.unitType) fields['Interested in'] = l.unitType;
  if (l.source) fields.Source = l.source;
  if (l.assignedRm) fields.RM = l.assignedRm;
  return {
    name: truncate(l.name || l.phone, 120),
    phone: l.phone,
    ...(l.email ? { email: truncate(l.email, 200) } : {}),
    company: truncate([l.stage, l.unitType].filter(Boolean).join(' · '), 120) || undefined,
    tags: ['crm', ...(l.stage ? [l.stage.toLowerCase().slice(0, 30)] : [])],
    fields,
  };
}

const leadsCol = () => col<LeadDoc & { jcContactAt?: Date | null; jcContactError?: string }>(CFG.COLL.LEADS);
const needsSync = () => ({
  stage: { $nin: DEAD }, phoneLast10: { $regex: /^\d{10}$/ },
  $or: [{ jcContactAt: { $exists: false } }, { jcContactAt: null }, { $expr: { $gt: ['$updatedAt', '$jcContactAt'] } }],
});

async function pushOne(l: LeadDoc): Promise<boolean> {
  try {
    await jc('/contacts', { method: 'POST', body: contactFor(l) });
    await (await leadsCol()).updateOne({ _id: l._id }, { $set: { jcContactAt: new Date(), jcContactError: '' } });
    return true;
  } catch (e) {
    const msg = e instanceof JustConnectError ? e.message : String((e as any)?.message || e);
    // a lead JustConnect refuses (e.g. not an Indian number) is marked so it is not retried every run
    await (await leadsCol()).updateOne({ _id: l._id }, { $set: { jcContactAt: new Date(), jcContactError: truncate(msg, 200) } });
    if (e instanceof JustConnectError && (e.status === 401 || e.status === 403 || e.status === 429)) throw e;
    return false;
  }
}

/** Send the leads that changed since they were last sent (a batch per run). */
export async function syncContacts(opts: { limit?: number; deadline?: number; gapMs?: number } = {}): Promise<{ sent: number; failed: number; left: number; skipped?: string }> {
  if (!(await contactSyncOn())) return { sent: 0, failed: 0, left: 0, skipped: 'off' };
  const limit = Math.min(opts.limit ?? 60, 100);
  const deadline = opts.deadline ?? Date.now() + 45_000;
  const gap = opts.gapMs ?? 350;
  const c = await leadsCol();
  const batch = await c.find(needsSync() as any).sort({ updatedAt: -1 }).limit(limit).toArray();
  let sent = 0, failed = 0;
  for (const l of batch) {
    if (Date.now() > deadline) break;
    try {
      if (await pushOne(l)) sent++;
      else failed++;
    } catch (e: any) {
      await logError('justconnect.contacts', 'SERVER', e?.message, e?.stack);
      break; // key / plan / rate problem: stop this run
    }
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
  return { sent, failed, left: await c.countDocuments(needsSync() as any) };
}

/** A new or changed lead: send it now, after the response (best effort; the background check catches up). */
export function scheduleContactPush(leadId: string) {
  const tenant = currentTenant();
  const task = async () => {
    if (!(await contactSyncOn())) return;
    const l = await (await leadsCol()).findOne({ _id: leadId });
    if (l && !DEAD.includes(l.stage) && last10(l.phone).length === 10) await pushOne(l).catch(() => false);
  };
  const run = () => (tenant ? runWithTenant(tenant, task) : task()).catch(() => undefined);
  import('next/server').then(({ after }) => {
    try {
      after(run);
    } catch {
      void run();
    }
  }, () => void run());
}

export async function contactStatus(): Promise<{ on: boolean; synced: number; waiting: number; failed: number }> {
  const c = await leadsCol();
  const live = { stage: { $nin: DEAD }, phoneLast10: { $regex: /^\d{10}$/ } };
  const [synced, waiting, failed] = await Promise.all([
    c.countDocuments({ ...live, jcContactAt: { $ne: null }, jcContactError: { $in: ['', null] } } as any),
    c.countDocuments(needsSync() as any),
    c.countDocuments({ ...live, jcContactError: { $nin: ['', null] } } as any),
  ]);
  return { on: await contactSyncOn(), synced, waiting, failed };
}

/* -------------------------------- outcomes ------------------------------- */

export interface JcOutcome { code: string; label: string; parent: string | null; positive: boolean; needsNote: boolean }

export async function jcOutcomes(): Promise<JcOutcome[]> {
  const r = await jc<{ items: JcOutcome[] }>('/outcomes');
  return r.items || [];
}

/** File an outcome on a JustConnect call from the CRM: in JustConnect, on the CRM call, and as a remark on the lead. */
export async function jcFileOutcome(d: { callId: string; outcome: string; notes?: string }, ctx: Ctx) {
  const calls = await col<any>(CFG.COLL.CALLS);
  const call = await calls.findOne({ _id: String(d?.callId || '') });
  if (!call || call.provider !== 'JustConnect') throw fail('NOT_FOUND', 'JustConnect call not found');
  if (call.leadId) await assertLeadAccess(ctx, call.leadId);
  const list = await jcOutcomes();
  const o = list.find((x) => x.code === d?.outcome);
  if (!o) throw fail('VALIDATION', 'Choose one of the JustConnect outcomes');
  const notes = String(d?.notes || '').trim();
  if (o.needsNote && !notes) throw fail('VALIDATION', `“${o.label}” needs a note`);
  try {
    await jc(`/call-logs/${encodeURIComponent(call.providerCallId)}`, { method: 'PATCH', body: { outcome: o.code, ...(notes ? { notes: truncate(notes, 2000) } : {}) } });
  } catch (e) {
    if (e instanceof JustConnectError) throw fail(e.status === 400 ? 'VALIDATION' : 'SERVER', e.message);
    throw e;
  }
  const { updateCall } = await import('./calls');
  const updated = await updateCall(call._id, { outcome: o.label, ...(notes ? { notes } : {}) }, ctx);
  await calls.updateOne({ _id: call._id }, { $set: { jcRemarkDone: true } });
  if (call.leadId) {
    const { appendRemark } = await import('./leads');
    await appendRemark(call.leadId, outcomeRemark(o.label, notes, call), ctx).catch(() => undefined);
  }
  return updated;
}

/** "Call · 3 min · Interested — Wants a visit on Saturday" */
export function outcomeRemark(label: string, notes: string, call: { direction?: string; durationSec?: number }): string {
  const mins = call.durationSec ? ` · ${Math.max(1, Math.round(call.durationSec / 60))} min` : '';
  return truncate(`${call.direction === 'Inbound' ? 'Incoming call' : 'Call'}${mins} · ${label}${notes ? ` — ${notes}` : ''}`, 1000);
}

/** The outcome an agent filed in JustConnect → a remark on the lead (once per call). Called after a call is saved. */
export async function remarkFromJcOutcome(callId: string): Promise<boolean> {
  const calls = await col<any>(CFG.COLL.CALLS);
  const call = await calls.findOne({ _id: callId });
  if (!call || call.provider !== 'JustConnect' || call.jcRemarkDone || !call.leadId || !call.outcome || call.status === 'In Progress') return false;
  const claimed = await calls.updateOne({ _id: callId, jcRemarkDone: { $ne: true } }, { $set: { jcRemarkDone: true } });
  if (!claimed.modifiedCount) return false;
  const { appendRemark } = await import('./leads');
  const ctx: Ctx = { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: call.loggedBy || 'JustConnect' }, action: 'justconnect' };
  await appendRemark(call.leadId, outcomeRemark(call.outcome, String(call.notes || ''), call), ctx, undefined, call.loggedBy || 'JustConnect').catch(() => undefined);
  return true;
}

/* --------------------------------- report -------------------------------- */

export interface JcReportRow { name: string; calls: number; answered: number; missed: number; notAnswered: number; talkSeconds: number; avgTalkSeconds: number | null }

export async function jcCallReport(d: { since: string; until: string }) {
  const since = new Date(String(d?.since || ''));
  const until = new Date(String(d?.until || ''));
  if (isNaN(since.getTime()) || isNaN(until.getTime()) || until <= since) throw fail('VALIDATION', 'Choose a period');
  if (until.getTime() - since.getTime() > 92 * 86400000) throw fail('VALIDATION', 'At most 92 days at a time');
  let r: any;
  try {
    r = await jc(`/reports/calls?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`);
  } catch (e) {
    if (e instanceof JustConnectError) throw fail(e.status === 403 ? 'FORBIDDEN' : 'SERVER', e.status === 403 ? 'The JustConnect key cannot read reports — tick reports:read on the key.' : e.message);
    throw e;
  }
  // agents by their CRM name where linked
  const users = (await listUsers()).filter((u) => u.status !== 'Disabled');
  const links = new Map((await (await col<{ _id: string; jcAgent?: string }>(CFG.COLL.USERS)).find({}, { projection: { jcAgent: 1 } }).toArray()).map((u) => [u._id, u.jcAgent || '']));
  const agentList: JcAgent[] = await jc<{ items: JcAgent[] }>('/agents').then((x) => x.items || [], () => []);
  const nameOf = (a: { id?: string; name?: string } | undefined) => {
    const u = a?.id ? users.find((x) => agentFor(x, links.get(x.id), agentList)?.id === a.id) : null;
    return u?.name || a?.name || 'Unknown';
  };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const rate = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const t = r?.totals || {};
  return {
    timezone: String(r?.timezone || ''),
    totals: {
      calls: n(t.calls), inbound: n(t.inbound), outbound: n(t.outbound), answered: n(t.answered), missed: n(t.missed), notAnswered: n(t.notAnswered),
      talkSeconds: n(t.talkSeconds), avgTalkSeconds: rate(t.avgTalkSeconds), avgSpeedOfAnswerSeconds: rate(t.avgSpeedOfAnswerSeconds),
      answerRate: rate(t.answerRate), inboundAnswerRate: rate(t.inboundAnswerRate), abandonRate: rate(t.abandonRate), serviceLevel: rate(t.serviceLevel),
    },
    byDay: (Array.isArray(r?.byDay) ? r.byDay : []).map((x: any) => ({ date: String(x.date || ''), calls: n(x.calls), answered: n(x.answered), missed: n(x.missed), notAnswered: n(x.notAnswered), talkSeconds: n(x.talkSeconds) })),
    byAgent: (Array.isArray(r?.byAgent) ? r.byAgent : []).map((x: any): JcReportRow => ({
      name: nameOf(x.agent), calls: n(x.calls), answered: n(x.answered), missed: n(x.missed), notAnswered: n(x.notAnswered), talkSeconds: n(x.talkSeconds), avgTalkSeconds: rate(x.avgTalkSeconds),
    })),
  };
}

export const actions: ActionMap = {
  jcOutcomes: { fn: () => jcOutcomes().catch((e) => { if (e instanceof JustConnectError) throw fail('SERVER', e.message); throw e; }), perm: 'calls.view' },
  jcFileOutcome: { fn: (d, ctx) => jcFileOutcome(d, ctx), perm: 'calls.log' },
  jcCallReport: { fn: (d) => jcCallReport(d), perm: 'reports.view' },
  jcContactStatus: { fn: () => contactStatus(), perm: 'settings.view' },
  jcSyncContacts: { fn: () => syncContacts({ limit: 100, deadline: Date.now() + 45_000 }), perm: 'settings.edit' },
};
