/**
 * Reconstruct journey milestones for leads created before milestones were recorded (finding 6). One company DB.
 *
 * Sources, earliest evidence wins, every mark tagged source 'backfill' (reports show these as reconstructed):
 *   contacted       first follow-up remark (followups[].at), else first completed call linked to the lead
 *   qualified       first timeline 'stage_changed' entry whose title ends in Qualified / Warm / Hot / Booked
 *   visitScheduled  first timeline 'site_visit_scheduled'
 *   visitDone       first timeline 'site_visit_completed'
 *   booked          first timeline 'booking', else the lead's Booking Date
 * Milestones already present (recorded live) are never overwritten. Dry run by default; rollback removes only
 * marks with source 'backfill'.
 */
import type { Db } from 'mongodb';

type Mark = { at: Date; by: string; source: 'backfill' };
const QUAL = /→\s*(Qualified|Warm|Hot|Booked)\s*$/;

export async function backfillMilestones(db: Db, opts: { apply?: boolean; rollback?: boolean } = {}) {
  const leads = db.collection('leads');
  if (opts.rollback) {
    let n = 0;
    for (const k of ['contacted', 'qualified', 'visitScheduled', 'visitDone', 'reserved', 'booked', 'cancelled']) {
      n += (await leads.updateMany({ [`milestones.${k}.source`]: 'backfill' }, { $unset: { [`milestones.${k}`]: '' } })).modifiedCount;
    }
    return { rolledBack: n };
  }
  const tl = db.collection('activities');
  const calls = db.collection('calls');
  const counts: Record<string, number> = { contacted: 0, qualified: 0, visitScheduled: 0, visitDone: 0, booked: 0 };
  let scanned = 0;
  const cursor = leads.find({}, { projection: { _id: 1, followups: 1, bookingDate: 1, milestones: 1 } });
  for await (const l of cursor) {
    scanned++;
    const have = (l.milestones || {}) as Record<string, unknown>;
    const set: Record<string, Mark> = {};
    const mark = (k: string, at: Date | null | undefined) => {
      if (!at || have[k] || set[`milestones.${k}`]) return;
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) return;
      set[`milestones.${k}`] = { at: d, by: 'Backfill', source: 'backfill' };
      counts[k]++;
    };
    const fu = ((l.followups || []) as Array<{ at?: Date }>).map((f) => f.at).filter(Boolean).sort((a, b) => +new Date(a!) - +new Date(b!))[0];
    if (fu) mark('contacted', fu);
    else {
      const c = await calls.find({ leadId: l._id, status: 'Completed' }, { projection: { startTime: 1, createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).next();
      if (c) mark('contacted', c.startTime ? new Date(c.startTime) : c.createdAt);
    }
    const entries = await tl.find({ leadId: l._id, type: { $in: ['stage_changed', 'site_visit_scheduled', 'site_visit_completed', 'booking'] } }, { projection: { type: 1, title: 1, timestamp: 1, createdAt: 1, at: 1 } }).sort({ timestamp: 1 }).toArray();
    const when = (e: any) => e.timestamp || e.at || e.createdAt;
    for (const e of entries) {
      if (e.type === 'stage_changed' && QUAL.test(String(e.title || ''))) mark('qualified', when(e));
      if (e.type === 'site_visit_scheduled') mark('visitScheduled', when(e));
      if (e.type === 'site_visit_completed') mark('visitDone', when(e));
      if (e.type === 'booking') mark('booked', when(e));
    }
    if (l.bookingDate) mark('booked', l.bookingDate);
    if (opts.apply && Object.keys(set).length) await leads.updateOne({ _id: l._id }, { $set: set });
  }
  return { scanned, wouldMark: counts, applied: !!opts.apply };
}
