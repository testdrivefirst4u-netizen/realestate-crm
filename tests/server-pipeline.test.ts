/** Pipeline dashboard: server aggregation (no PII) and the revocable public share link gated by its token. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb } from './helpers/mongo';
import { runWithTenant } from '../server/core/tenant';
import { getTenantById, invalidateTenant } from '../server/platform/registry';
import { addLead } from '../server/modules/leads';
import { getPipelineShare, pipelineByToken, pipelineData, rotatePipelineShareToken, setPipelineShare } from '../server/modules/pipelineShare';
import { CFG } from '../server/core/config';
import type { Ctx } from '../server/core/auth';

let t: Awaited<ReturnType<typeof startTestDb>>;
let admin: Ctx;
const L = CFG.LEAD;
const inCo = async <T>(fn: () => Promise<T>) => { invalidateTenant(); return runWithTenant((await getTenantById('CMP-test'))!, fn); };

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await t.reset(); await t.company('test'); admin = await t.ctx('Admin', 'Asha Admin'); });

describe('pipeline dashboard', () => {
  it('aggregates leads with no PII', async () => {
    await inCo(() => addLead({ [L.NAME]: 'A', [L.PHONE]: '9000000001', [L.EMAIL]: 'a@x.com', [L.SOURCE]: 'Website', [L.STAGE]: 'Qualified', [L.RM]: 'Asha Admin' }, admin));
    await inCo(() => addLead({ [L.NAME]: 'B', [L.PHONE]: '9000000002', [L.SOURCE]: 'Facebook', [L.STAGE]: 'New' }, admin));
    await inCo(() => addLead({ [L.NAME]: 'C', [L.PHONE]: '9000000003', [L.SOURCE]: 'Website', [L.STAGE]: 'Disqualified - Project Type' }, admin));
    const d = await inCo(() => pipelineData());
    expect(d.kpis.leads).toBe(3);
    expect(d.kpis.qualified).toBe(1);
    expect(d.byStage.find((r) => r.label === 'Qualified')?.count).toBe(1);
    expect(d.bySource.map((r) => r.label).sort()).toEqual(['Facebook', 'Website']);
    // disqualification-reason summary
    expect(d.byDisqualReason.find((r) => r.label === 'Disqualified - Project Type')?.count).toBe(1);
    // leads created now fall into this month and this year
    expect(d.mtd.leads).toBe(3);
    expect(d.ytd.leads).toBe(3);
    expect(JSON.stringify(d)).not.toContain('9000000001'); // no phone
    expect(JSON.stringify(d)).not.toContain('a@x.com'); // no e-mail
  });

  it('the public link is off by default and gated by its token; rotating kills the old one', async () => {
    await inCo(() => addLead({ [L.NAME]: 'A', [L.PHONE]: '9000000001', [L.SOURCE]: 'Website' }, admin));
    expect((await inCo(() => getPipelineShare())).enabled).toBe(false);
    await expect(inCo(() => pipelineByToken('anything'))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const share = await inCo(() => setPipelineShare({ enabled: true }, admin));
    expect(share.enabled).toBe(true);
    expect(share.url).toContain('/p/test/');
    const token = share.url.split('/').pop()!;

    expect((await inCo(() => pipelineByToken(token))).kpis.leads).toBe(1);
    await expect(inCo(() => pipelineByToken('wrong-token'))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const rotated = await inCo(() => rotatePipelineShareToken({}, admin));
    expect(rotated.url).not.toBe(share.url);
    await expect(inCo(() => pipelineByToken(token))).rejects.toMatchObject({ code: 'FORBIDDEN' }); // old token dead

    await inCo(() => setPipelineShare({ enabled: false }, admin)); // switched off → even the right token fails
    const newToken = rotated.url.split('/').pop()!;
    await expect(inCo(() => pipelineByToken(newToken))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the public dashboard payload masks customer PII and is token-gated', async () => {
    const { publicAnalyticsByToken } = await import('../server/modules/pipelineShare');
    await inCo(() => addLead({ [L.NAME]: 'Ravi Kumar', [L.PHONE]: '9876501234', [L.EMAIL]: 'r@x.com', [L.SOURCE]: 'Website' }, admin));
    await expect(inCo(() => publicAnalyticsByToken('nope'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const share = await inCo(() => setPipelineShare({ enabled: true }, admin));
    const token = share.url.split('/').pop()!;
    const data = await inCo(() => publicAnalyticsByToken(token));
    expect(data.leads.length).toBe(1);
    const s = JSON.stringify(data.leads);
    expect(s).not.toContain('Ravi Kumar'); // name masked
    expect(s).not.toContain('9876501234'); // phone removed
    expect(s).not.toContain('r@x.com'); // e-mail removed
    expect(data.sources).toContain('Website');
    expect(data.pipeline.kpis.leads).toBe(1);
  });
});
