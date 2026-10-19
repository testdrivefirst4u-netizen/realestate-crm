/**
 * Platform health: scheduled-job runs and a platform-wide error feed for the super admin console.
 *
 * recordJobRun / recordJobRejected are called by the cron routes (app/api/cron/*): every run updates the platform
 * `jobRuns` document of its job { lastRunAt, lastOk, lastOkAt, durationMs, summary, lastError, history (last 20) };
 * a call with a wrong CRON_SECRET only sets lastRejectedAt, so "the scheduler is calling but the secret is wrong"
 * becomes visible. platformHealth() adds each job's status (ok / late / failing / never), the Meta lead queue and
 * the latest errors of every active company.
 */
import { col } from '../core/db';
import { CFG } from '../core/config';
import { runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { queueCounts } from '../modules/metaQueue';
import { pc } from './base';
import { listActiveTenants } from './registry';
import type { HealthJob, PlatformHealth } from './contract';

export const JOB_RUNS = 'jobRuns';

/** The scheduled jobs and how often they should run (minutes). */
export const JOBS: Array<{ id: string; label: string; path: string; everyMin: number }> = [
  { id: 'meta', label: 'Facebook lead backup check', path: '/api/cron/meta', everyMin: 10 },
  { id: 'sheets', label: 'Google Sheets sync', path: '/api/cron/sheets', everyMin: 10 },
  { id: 'watch', label: 'Lead watch (reassign, visit reminders, summary)', path: '/api/cron/watch', everyMin: 10 },
  { id: 'followups', label: 'Follow-up reminders', path: '/api/cron/followups', everyMin: 60 },
  { id: 'daily', label: 'Daily digest & clean-up', path: '/api/cron/daily', everyMin: 24 * 60 },
];

interface JobRunDoc {
  _id: string;
  lastRunAt?: Date;
  lastOk?: boolean;
  lastOkAt?: Date;
  durationMs?: number;
  summary?: string;
  lastError?: string;
  lastRejectedAt?: Date;
  history?: Array<{ at: Date; ok: boolean; ms: number; summary: string }>;
}

const runs = () => pc<JobRunDoc>(JOB_RUNS);

/** Record one run of a job (never throws: monitoring must not break the job). */
export async function recordJobRun(job: string, startedAt: number, ok: boolean, summary: string, error = ''): Promise<void> {
  try {
    const at = new Date();
    const ms = Math.max(0, at.getTime() - startedAt);
    const s = truncate(summary, 300);
    await (await runs()).updateOne(
      { _id: job },
      {
        $set: { lastRunAt: at, lastOk: ok, durationMs: ms, summary: s, lastError: ok ? '' : truncate(error || summary, 300), ...(ok ? { lastOkAt: at } : {}) },
        $push: { history: { $each: [{ at, ok, ms, summary: s }], $slice: -20 } },
      },
      { upsert: true }
    );
  } catch (e: any) {
    console.error('[health] recordJobRun', job, e?.message);
  }
}

/** A call to a job with a missing or wrong CRON_SECRET. */
export async function recordJobRejected(job: string): Promise<void> {
  try {
    await (await runs()).updateOne({ _id: job }, { $set: { lastRejectedAt: new Date() } }, { upsert: true });
  } catch (e: any) {
    console.error('[health] recordJobRejected', job, e?.message);
  }
}

/** A short summary of a cron route's JSON result for the health page. */
export function summarize(data: any): string {
  if (!data || typeof data !== 'object') return '';
  if (data.skipped) return `Skipped: ${data.skipped}`;
  const parts: string[] = [];
  if (typeof data.companies === 'number') parts.push(`${data.companies} compan${data.companies === 1 ? 'y' : 'ies'}`);
  if (data.failed) parts.push(`${data.failed} failed`);
  if (data.queue) parts.push(`${data.queue.processed} queued lead${data.queue.processed === 1 ? '' : 's'} processed`);
  if (data.backfills) {
    const rows = Object.values(data.backfills).flat() as any[];
    const rec = rows.reduce((n, r) => n + (r?.recovered || 0), 0);
    const errs = rows.filter((r) => r?.error).length;
    if (rows.length) parts.push(`${rows.length} Page check${rows.length === 1 ? '' : 's'}`);
    if (rec) parts.push(`${rec} lead${rec === 1 ? '' : 's'} recovered`);
    if (errs) parts.push(`${errs} error${errs === 1 ? '' : 's'}`);
  }
  return parts.join(' · ') || 'Done';
}

export function jobStatus(doc: JobRunDoc | null | undefined, everyMin: number, nowMs = Date.now()): HealthJob['status'] {
  if (!doc?.lastRunAt) return 'never';
  if (doc.lastOk === false) return 'failing';
  // late after two missed intervals (+5 min slack for schedulers that start late)
  const lateMs = (everyMin * 2 + 5) * 60000;
  return nowMs - new Date(doc.lastRunAt).getTime() > lateMs ? 'late' : 'ok';
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : '');

export async function platformHealth(nowMs = Date.now()): Promise<PlatformHealth> {
  const docs = await (await runs()).find({}).toArray();
  const byId = new Map(docs.map((d) => [d._id, d]));
  const jobs: HealthJob[] = JOBS.map((j) => {
    const d = byId.get(j.id);
    return {
      id: j.id, label: j.label, path: j.path, everyMin: j.everyMin,
      status: jobStatus(d, j.everyMin, nowMs),
      lastRunAt: iso(d?.lastRunAt), lastOkAt: iso(d?.lastOkAt), lastRejectedAt: iso(d?.lastRejectedAt),
      durationMs: d?.durationMs ?? 0, summary: d?.summary || '', lastError: d?.lastError || '',
      history: (d?.history || []).slice(-10).reverse().map((h) => ({ at: iso(h.at), ok: h.ok, ms: h.ms, summary: h.summary })),
    };
  });

  const errors: PlatformHealth['errors'] = [];
  for (const tenant of await listActiveTenants()) {
    try {
      const rows = await runWithTenant(tenant, async () =>
        (await col(CFG.COLL.ERROR_LOG)).find({}).sort({ timestamp: -1 }).limit(15).toArray()
      );
      for (const r of rows as any[]) {
        errors.push({ at: iso(r.timestamp), company: tenant.name, companyId: tenant.id, scope: String(r.scope || ''), code: String(r.code || ''), message: truncate(String(r.message || ''), 240) });
      }
    } catch {
      /* one company's database being unavailable must not hide the others */
    }
  }
  errors.sort((a, b) => (a.at < b.at ? 1 : -1));

  return { checkedAt: new Date(nowMs).toISOString(), jobs, metaQueue: await queueCounts(new Date(nowMs)), errors: errors.slice(0, 40) };
}
