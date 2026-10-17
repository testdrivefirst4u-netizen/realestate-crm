/**
 * Merge duplicate leads into one (same person entered twice: same phone, or same e-mail when there is no phone).
 *
 *   mergeLeads(keepId, mergeIds) — the kept lead keeps its id and its own values; an empty field is filled from the
 *   others (oldest first). Follow-ups of all leads are combined in date order and renumbered; enquiry notes are
 *   joined; the earliest enquiry date / created time and the latest follow-up time win. Calls, documents, WhatsApp
 *   chats, the inbound log, timeline and events of the merged leads move to the kept lead. The merged leads go to
 *   Archived Leads (recoverable) with `mergedInto`. Everything runs in one transaction where supported.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { bumpVersion, col, getClient } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import type { ArchivedLeadDoc, FollowupEntry, LeadDoc } from '../core/leadShape';
import { last10, str, truncate } from '../core/utils';
import { supportsTransactions } from './leads';

const S = CFG.STAGES;
const leadsCol = () => col<LeadDoc>(CFG.COLL.LEADS);
const archiveCol = () => col<ArchivedLeadDoc & { mergedInto?: string }>(CFG.COLL.ARCHIVE);

/** Collection.field pairs that point at a lead id. */
export const LEAD_REFS: Array<[string, string]> = [
  ['activities', 'leadId'], ['activities', 'refId'], ['calls', 'leadId'], ['documents', 'leadId'], ['inboundLeads', 'leadId'],
  ['waContacts', 'leadId'], ['waMessages', 'leadId'], ['units', 'leadId'], ['events', 'recordId'],
];

const TEXT_FIELDS: Array<keyof LeadDoc> = [
  'name', 'phone', 'email', 'source', 'unitType', 'purchaseOrRent', 'siteVisitStatus', 'assignedRm', 'brochureShared', 'relationship', 'enquiredFor',
];
const DATE_FIELDS: Array<keyof LeadDoc> = ['siteVisitDate', 'bookingDate', 'nextFollowupAt'];

const time = (d: Date | null | undefined) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null);
const minDate = (ds: Array<Date | null | undefined>) => ds.filter((d) => time(d) !== null).sort((a, b) => time(a)! - time(b)!)[0] || null;
const maxDate = (ds: Array<Date | null | undefined>) => ds.filter((d) => time(d) !== null).sort((a, b) => time(b)! - time(a)!)[0] || null;
const isPlaceholderName = (n: string) => !n.trim() || /^unknown$/i.test(n.trim()) || /^(website|webhook|google sheet|meta lead ads) enquiry\b/i.test(n.trim());

/** The merged document (pure: no database access). `others` oldest first. */
export function mergeDocs(keep: LeadDoc, others: LeadDoc[], actor: string, now = new Date()): LeadDoc {
  const all = [keep, ...others];
  const out: LeadDoc = { ...keep, extra: { ...(keep.extra || {}) } };
  for (const f of TEXT_FIELDS) {
    const cur = str(out[f]);
    if (cur && !(f === 'name' && isPlaceholderName(cur))) continue;
    const from = others.map((o) => str(o[f])).find((v) => v && !(f === 'name' && isPlaceholderName(v)));
    if (from) (out as any)[f] = from;
  }
  for (const f of DATE_FIELDS) if (time(out[f] as Date | null) === null) {
    const from = others.map((o) => o[f] as Date | null).find((d) => time(d) !== null);
    if (from) (out as any)[f] = from;
  }
  for (const o of others) for (const [k, v] of Object.entries(o.extra || {})) if (str(v) && !str(out.extra[k])) out.extra[k] = v;
  out.phoneLast10 = last10(out.phone);
  out.enquiryDate = minDate(all.map((d) => d.enquiryDate)) || keep.enquiryDate;
  out.createdAt = minDate(all.map((d) => d.createdAt)) || keep.createdAt;
  out.lastFollowupAt = maxDate(all.map((d) => d.lastFollowupAt));
  const notes: string[] = [];
  for (const d of all) for (const line of str(d.notes).split('\n')) if (line.trim() && !notes.includes(line.trim())) notes.push(line.trim());
  out.notes = notes.join('\n');
  // follow-ups: every entry once, in date order (undated ones keep their place after the dated ones), renumbered
  const seen = new Set<string>();
  const fu: FollowupEntry[] = [];
  all.forEach((d, li) => (d.followups || []).forEach((e, ei) => {
    const key = `${time(e.at) ?? ''}|${str(e.text)}`;
    if (seen.has(key)) return;
    seen.add(key);
    fu.push({ ...e, n: li * 10000 + ei });
  }));
  fu.sort((a, b) => (time(a.at) ?? Infinity) - (time(b.at) ?? Infinity) || a.n - b.n);
  out.followups = fu.slice(-CFG.MAX_FOLLOWUPS).map((e, i) => ({ ...e, n: i + 1 }));
  out.updatedAt = now;
  out.updatedBy = actor;
  return out;
}

export async function mergeLeads(keepId: unknown, mergeIds: unknown, ctx: Ctx | null): Promise<{ id: string; merged: string[]; version: string }> {
  const actor = ctx?.user?.name || 'System';
  const kid = str(keepId);
  const ids = [...new Set((Array.isArray(mergeIds) ? mergeIds : []).map(str).filter((x) => x && x !== kid))];
  if (!kid) throw fail('VALIDATION', 'Choose the lead to keep');
  if (!ids.length) throw fail('VALIDATION', 'Choose at least one other lead to merge into it');
  if (ids.length > 20) throw fail('VALIDATION', 'At most 20 leads at once');
  const leads = await leadsCol();
  const docs = await leads.find({ _id: { $in: [kid, ...ids] } }).toArray();
  const keep = docs.find((d) => d._id === kid);
  if (!keep) throw fail('NOT_FOUND', 'Lead not found: ' + kid);
  const others = ids.map((id) => {
    const d = docs.find((x) => x._id === id);
    if (!d) throw fail('NOT_FOUND', 'Lead not found: ' + id);
    return d;
  });
  // only the same person: same phone (last 10 digits), or the same e-mail
  const p = keep.phoneLast10 && keep.phoneLast10.length === 10 ? keep.phoneLast10 : '';
  const e = str(keep.email).toLowerCase();
  for (const o of others) {
    const samePhone = !!p && o.phoneLast10 === p;
    const sameEmail = !!e && str(o.email).toLowerCase() === e;
    if (!samePhone && !sameEmail) throw fail('VALIDATION', `${o._id} has a different phone number and e-mail than ${kid} — only duplicates of the same person can be merged`);
    if (o.stage === S.DELETED) throw fail('VALIDATION', `${o._id} is already deleted`);
  }
  others.sort((a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0));
  const merged = mergeDocs(keep, others, actor);
  const now = new Date();

  const write = async (session?: any) => {
    const opt = session ? { session } : {};
    await leads.replaceOne({ _id: kid }, merged, opt);
    for (const o of others) {
      await (await archiveCol()).replaceOne({ _id: o._id }, { ...o, archivedAt: now, archivedBy: actor, mergedInto: kid }, { upsert: true, ...opt });
      await leads.deleteOne({ _id: o._id }, opt);
    }
    for (const [c, f] of LEAD_REFS) await (await col(c)).updateMany({ [f]: { $in: ids } }, { $set: { [f]: kid } }, opt);
  };
  const client = await getClient();
  if (client && (await supportsTransactions())) {
    const session = client.startSession();
    try {
      await session.withTransaction(() => write(session));
    } finally {
      await session.endSession();
    }
  } else {
    await write();
  }
  await addTimeline(kid, 'lead_merged', 'Duplicates merged into this lead', truncate(others.map((o) => `${o._id} (${o.name || 'no name'})`).join(', '), 300), actor, 'Lead', kid);
  await auditLog(ctx, 'Leads Merged', 'Lead', kid, truncate(`Merged ${ids.join(', ')} into ${kid}`, 500));
  return { id: kid, merged: ids, version: await bumpVersion() };
}

export const actions: ActionMap = {
  mergeLeads: { fn: (d, ctx) => mergeLeads(d?.keepId, d?.mergeIds, ctx), perm: 'leads.delete' },
};
