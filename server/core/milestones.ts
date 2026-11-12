/**
 * Sales milestones — explicit evidence that a step of the journey actually happened (finding 6).
 *
 * The old funnel inferred "reached Qualified" from a lead's CURRENT stage rank, so a lead moved straight from New to
 * Booked counted as qualified and visited, and a lead that was qualified and later lost counted as never qualified.
 * Now each lead carries `milestones.<step> = { at, by, source }`, written once, the first time the step happens:
 *
 *   contacted        first follow-up remark or logged call
 *   qualified        stage first became Qualified / Warm / Hot (or later)
 *   visitScheduled   a site / virtual visit was first scheduled
 *   visitDone        a visit was completed (or a walk-in)
 *   reserved         a unit was reserved for the lead
 *   booked           a unit was booked (stage Booked, or a unit booking)
 *   cancelled        a booking was cancelled
 *
 * `source` says how it is known: 'event' (recorded when it happened) or 'backfill' (reconstructed from history by
 * scripts/backfill-milestones.ts; reports label those as reconstructed).
 */
import { CFG } from './config';
import { col } from './db';

export const MILESTONES = ['contacted', 'qualified', 'visitScheduled', 'visitDone', 'reserved', 'booked', 'cancelled'] as const;
export type Milestone = (typeof MILESTONES)[number];
export interface MilestoneMark { at: Date; by: string; source: 'event' | 'backfill' }

const S = CFG.STAGES;
const QUALIFIED_OR_LATER = new Set<string>([S.QUALIFIED, S.WARM, S.HOT, S.BOOKED]);

/** Milestones implied by a change of stage / visit status (pure). */
export function milestonesFromChange(change: { newStage?: string; oldStage?: string; newSvs?: string; oldSvs?: string; followupAdded?: boolean }): Milestone[] {
  const out: Milestone[] = [];
  if (change.followupAdded) out.push('contacted');
  if (change.newStage && change.newStage !== change.oldStage) {
    if (QUALIFIED_OR_LATER.has(change.newStage)) out.push('qualified');
    if (change.newStage === S.BOOKED) out.push('booked');
  }
  if (change.newSvs && change.newSvs !== change.oldSvs) {
    if (change.newSvs === CFG.SITE_VISIT.SCHEDULED) out.push('visitScheduled');
    if (change.newSvs === CFG.SITE_VISIT.COMPLETED || change.newSvs === CFG.SITE_VISIT.WALK_IN) out.push('visitDone');
  }
  return out;
}

/** Record milestones on a lead, each only if not already recorded (first time wins). Never throws. */
export async function markMilestones(leadId: string, steps: Milestone[], by: string, at = new Date(), source: MilestoneMark['source'] = 'event') {
  if (!leadId || !steps.length) return;
  try {
    const leads = await col(CFG.COLL.LEADS);
    for (const step of new Set(steps)) {
      await leads.updateOne({ _id: leadId as any, [`milestones.${step}`]: { $exists: false } }, { $set: { [`milestones.${step}`]: { at, by, source } } });
    }
  } catch (e: any) {
    console.error('[milestones]', leadId, e?.message);
  }
}

/** The browser shape: step → ISO date (read-only key `_milestones`; keys starting with _ are never written back). */
export function milestonesForUi(m: Partial<Record<Milestone, MilestoneMark>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of MILESTONES) {
    const v = m?.[k];
    if (v?.at) out[k] = (v.at instanceof Date ? v.at : new Date(v.at)).toISOString() + (v.source === 'backfill' ? '~' : '');
  }
  return out;
}
