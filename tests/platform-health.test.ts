import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { jobStatus, platformHealth, recordJobRejected, recordJobRun, summarize } from '../server/platform/health';

let t: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500)); // let the platform index build started by pc() finish
  await t.stop();
});
beforeEach(async () => {
  await t.reset();
});

describe('platform health', () => {
  it('job status: ok, late after two missed runs, failing, never', () => {
    const now = Date.UTC(2026, 9, 17, 12, 0, 0);
    expect(jobStatus(null, 10, now)).toBe('never');
    expect(jobStatus({ _id: 'meta', lastRunAt: new Date(now - 12 * 60e3), lastOk: true }, 10, now)).toBe('ok');
    expect(jobStatus({ _id: 'meta', lastRunAt: new Date(now - 30 * 60e3), lastOk: true }, 10, now)).toBe('late');
    expect(jobStatus({ _id: 'meta', lastRunAt: new Date(now - 60e3), lastOk: false }, 10, now)).toBe('failing');
    expect(jobStatus({ _id: 'daily', lastRunAt: new Date(now - 20 * 3600e3), lastOk: true }, 1440, now)).toBe('ok');
  });

  it('summarises cron results', () => {
    expect(summarize({ skipped: 'Meta app is not configured' })).toBe('Skipped: Meta app is not configured');
    expect(summarize({ companies: 2, failed: 1 })).toBe('2 companies · 1 failed');
    expect(summarize({ queue: { processed: 3, byStatus: {} }, backfills: { amaya: [{ id: 'SRC-1', check: 'quick', result: '1 new', recovered: 1 }] } })).toBe('3 queued leads processed · 1 Page check · 1 lead recovered');
  });

  it('records runs (history of 20) and rejected calls, and reports them per job', async () => {
    for (let i = 0; i < 22; i++) await recordJobRun('meta', Date.now() - 1500, true, `run ${i}`);
    await recordJobRejected('sheets');
    await recordJobRun('followups', Date.now(), false, 'Follow-up job failed', 'boom');
    const h = await platformHealth();
    const meta = h.jobs.find((j) => j.id === 'meta')!;
    expect(meta).toMatchObject({ status: 'ok', summary: 'run 21', lastError: '' });
    expect(meta.history).toHaveLength(10);
    expect((await t.db.client.db(process.env.PLATFORM_DB || 'amaya_platform').collection('jobRuns').findOne({ _id: 'meta' as any }))!.history).toHaveLength(20);
    expect(h.jobs.find((j) => j.id === 'sheets')).toMatchObject({ status: 'never' });
    expect(h.jobs.find((j) => j.id === 'sheets')!.lastRejectedAt).not.toBe('');
    expect(h.jobs.find((j) => j.id === 'followups')).toMatchObject({ status: 'failing', lastError: 'boom' });
    expect(h.jobs.find((j) => j.id === 'daily')).toMatchObject({ status: 'never' });
    expect(h.metaQueue).toEqual({ pending: 0, failed: 0, done24h: 0 });
  });
});
