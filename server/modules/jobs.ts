/**
 * Scheduled jobs — port of apps-script/30_Triggers.gs (hourly follow-up/overdue reminders,
 * daily housekeeping + digest). Called from app/api/cron/*. The onEdit triggers are gone
 * (there is no sheet any more).
 */
import nodemailer from 'nodemailer';
import { cleanupSessions } from '../core/auth';
import { CFG } from '../core/config';
import { col, nextCounter } from '../core/db';
import { logError, trimErrors, trimEvents } from '../core/events';
import type { LeadDoc } from '../core/leadShape';
import { settingsAll } from '../core/settings';
import { dateKey, fmtDate, fmtHuman, makeZoned, truncate } from '../core/utils';
import { updateLead } from './leads';
import { parseSequence, STALE_STAGES } from './sequences';

const S = CFG.STAGES;
/** Stages that never get overdue reminders (TRIGGER_followups). */
const NO_REMINDER = [S.BOOKED, S.TRASH, S.DND, S.JUNK, S.NOT_RESPONDING, S.DELETED];

/** Events_addWithKey: an event with a caller-supplied key (per-day de-duplicated reminders). */
async function addEventWithKey(key: string, type: string, recordType: string, recordId: string, title: string, message: string, actor: string) {
  const n = await nextCounter('events');
  const id = 'EVT-' + String(n).padStart(6, '0');
  await (await col(CFG.COLL.EVENTS)).insertOne({
    _id: id as any, seq: n, key, type, recordType, recordId, title: truncate(title, 200), message: truncate(message || '', 500),
    createdAt: new Date(), actor: actor || 'System', payload: null,
  });
  return id;
}

/** One event per overdue follow-up per lead per day (key followup_overdue:<lead>:<yyyy-MM-dd>). */
export async function runHourlyFollowups(): Promise<{ notified: number }> {
  let notified = 0;
  try {
    const today = dateKey(new Date());
    const due = await (await col<LeadDoc>(CFG.COLL.LEADS))
      .find(
        { nextFollowupAt: { $ne: null, $lte: new Date() }, stage: { $nin: NO_REMINDER, $not: /^Disqualified/ } } as any,
        { projection: { _id: 1, name: 1, assignedRm: 1, nextFollowupAt: 1 } }
      )
      .toArray();
    if (!due.length) return { notified };
    const keys = due.map((l) => `followup_overdue:${l._id}:${today}`);
    const existing = new Set((await (await col(CFG.COLL.EVENTS)).find({ key: { $in: keys } }, { projection: { key: 1 } }).toArray()).map((e: any) => e.key));
    for (const l of due) {
      const key = `followup_overdue:${l._id}:${today}`;
      if (existing.has(key)) continue;
      await addEventWithKey(key, 'followup_overdue', 'Lead', l._id, 'Follow-up overdue: ' + l.name, 'Was due ' + fmtHuman(l.nextFollowupAt) + ' · RM ' + (l.assignedRm || '—'), 'System');
      existing.add(key);
      notified++;
    }
  } catch (e: any) {
    await logError('trigger.followups', 'INTERNAL', e?.message, e?.stack, 'trigger', {});
  }
  return { notified };
}

/* --------------------------------- daily -------------------------------- */

/** Start of the CRM-zone day containing `d`. */
function dayStart(d: Date) {
  const [y, m, day] = dateKey(d).split('-').map(Number);
  return makeZoned(y, m, day);
}

const rmOf = (l: Pick<LeadDoc, 'assignedRm'>) => l.assignedRm || '—';

export async function buildDigest(now = new Date()) {
  const leads = await col<LeadDoc>(CFG.COLL.LEADS);
  const todayStart = dayStart(now);
  const tomorrowStart = dayStart(new Date(todayStart.getTime() + 36 * 3600000));
  const yesterdayStart = dayStart(new Date(todayStart.getTime() - 12 * 3600000));
  const active = { stage: { $nin: [S.TRASH, S.DELETED] } };
  const proj = { projection: { name: 1, source: 1, unitType: 1, assignedRm: 1, stage: 1, nextFollowupAt: 1 } };

  const newQ = { ...active, enquiryDate: { $gte: yesterdayStart, $lt: todayStart } };
  const dueQ = { ...active, nextFollowupAt: { $gte: todayStart, $lt: tomorrowStart } };
  const overdueQ = { stage: { $nin: [S.TRASH, S.DELETED, S.BOOKED, S.DND, S.JUNK] }, nextFollowupAt: { $ne: null, $lt: todayStart } };
  const [newCount, newList, dueCount, dueList, overdueCount, overdueList] = await Promise.all([
    leads.countDocuments(newQ as any),
    leads.find(newQ as any, proj).sort({ enquiryDate: 1 }).limit(15).toArray(),
    leads.countDocuments(dueQ as any),
    leads.find(dueQ as any, proj).sort({ nextFollowupAt: 1 }).limit(20).toArray(),
    leads.countDocuments(overdueQ as any),
    leads.find(overdueQ as any, proj).sort({ nextFollowupAt: 1 }).limit(20).toArray(),
  ]);
  const line = (l: LeadDoc) => `  • ${fmtHuman(l.nextFollowupAt)} — ${l.name} (${l.stage}) — RM ${rmOf(l)}`;
  const subject = `${CFG.APP_NAME} digest · ${fmtDate(now)}`;
  const text = [
    `${CFG.APP_NAME} — daily digest for ${fmtDate(now)}`,
    '',
    `New enquiries yesterday: ${newCount}`,
    newList.map((l) => `  • ${l.name} (${l.source || ''}, ${l.unitType || ''}) — RM ${rmOf(l)}`).join('\n'),
    '',
    `Follow-ups due today: ${dueCount}`,
    dueList.map(line).join('\n'),
    '',
    `Overdue follow-ups: ${overdueCount}`,
    overdueList.map(line).join('\n'),
  ].join('\n');
  return { subject, text, counts: { newYesterday: newCount, dueToday: dueCount, overdue: overdueCount } };
}

async function sendDigest(): Promise<boolean> {
  const to = String((await settingsAll()).dailyDigestEmail || '').split(/[,;\s]+/).filter(Boolean);
  const smtp = process.env.SMTP_URL?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!to.length || !smtp || !from) return false;
  const { subject, text } = await buildDigest();
  await nodemailer.createTransport(smtp).sendMail({ from, to: to.join(', '), subject, text });
  return true;
}

/**
 * Follow-up sequence option: New/Open/Warm leads with no activity (no update) for `autoNotRespondingDays` days
 * move to "Not Responding" (through updateLead, so the timeline, events and audit record it). Off when 0.
 * At most 500 per run.
 */
export async function markStaleLeads(now = new Date()): Promise<number> {
  const seq = parseSequence((await settingsAll()).followupSequence);
  if (!seq.autoNotRespondingDays) return 0;
  const cutoff = new Date(now.getTime() - seq.autoNotRespondingDays * 86_400_000);
  const stale = await (await col<LeadDoc>(CFG.COLL.LEADS))
    .find({ stage: { $in: STALE_STAGES }, updatedAt: { $lt: cutoff } } as any, { projection: { _id: 1 } })
    .limit(500)
    .toArray();
  let moved = 0;
  for (const l of stale) {
    try {
      await updateLead(l._id, { [CFG.LEAD.STAGE]: S.NOT_RESPONDING }, null);
      moved++;
    } catch (e: any) {
      await logError('trigger.daily.stale', 'INTERNAL', e?.message, e?.stack, 'trigger', { leadId: l._id });
    }
  }
  return moved;
}

export async function runDaily(): Promise<{ ok: true; digestSent: boolean; markedNotResponding?: number }> {
  let digestSent = false;
  let markedNotResponding = 0;
  try { markedNotResponding = await markStaleLeads(); } catch (e: any) { await logError('trigger.daily.stale', 'INTERNAL', e?.message, e?.stack, 'trigger', {}); }
  try { await cleanupSessions(); } catch (e: any) { await logError('trigger.daily.sessions', 'INTERNAL', e?.message, e?.stack, 'trigger', {}); }
  try { await trimEvents(); } catch (e: any) { await logError('trigger.daily.events', 'INTERNAL', e?.message, e?.stack, 'trigger', {}); }
  try { await trimErrors(); } catch (e: any) { await logError('trigger.daily.errors', 'INTERNAL', e?.message, e?.stack, 'trigger', {}); }
  try { digestSent = await sendDigest(); } catch (e: any) { await logError('trigger.daily.digest', 'INTERNAL', e?.message, e?.stack, 'trigger', {}); }
  return { ok: true, digestSent, markedNotResponding };
}
