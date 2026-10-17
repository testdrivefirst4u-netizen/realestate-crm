/**
 * Facebook sync page (Settings › Facebook sync): is every Facebook / Instagram lead reaching the CRM?
 *
 * metaSyncReport({ compare }) — per connected Page its health (subscription, last lead, last checks, leads the
 *   checks had to recover, last error); with `compare` the Page's forms are read from Facebook for the last 7 days
 *   and each lead id is looked up in the intake log, giving Facebook / CRM / missing counts per form. Also the latest
 *   Facebook leads with how long each took to arrive, and webhook leads that failed or were skipped.
 * retryMetaLeads() — queue this company's failed / dead webhook leads again and process them now.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import type { MetaActions, MetaSyncForm, MetaSyncPage } from '../core/metaTypes';
import { requireTenant } from '../core/tenant';
import { dateKey, truncate } from '../core/utils';
import { listFormLeads, listForms, requireMetaConfig } from '../integrations/meta';
import { inboundCol, sourcesCol } from './intake';
import { errMsg, formAllowed, pageTokenOf, type MetaSourceDoc } from './meta';
import { processQueueItems, queueCol } from './metaQueue';

type Res<K extends keyof MetaActions> = MetaActions[K]['res'];

const DAY = 86400000;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : '');
const metaOf = (s: MetaSourceDoc) => (s.config?.meta || {}) as Record<string, any>;

/** Facebook vs CRM for the last 7 days, per form the source takes. */
async function compareForms(src: MetaSourceDoc, nowMs: number): Promise<MetaSyncForm[]> {
  const meta = metaOf(src);
  const token = pageTokenOf(src);
  if (!token) throw new Error('The Facebook connection has expired — connect with Facebook again.');
  const cfg = await requireMetaConfig();
  const forms = (await listForms(meta.pageId, token, cfg)).filter((f) => formAllowed(meta as any, f.id));
  const since = Math.floor((nowMs - 7 * DAY) / 1000);
  const today = dateKey(new Date(nowMs));
  const out: MetaSyncForm[] = [];
  for (const f of forms.slice(0, 30)) {
    const leads = await listFormLeads(f.id, token, since, 1000, cfg);
    const keys = leads.map((l) => `meta:${l.id}`);
    const inCrm = new Set(
      keys.length
        ? (await (await inboundCol()).find({ sourceId: src._id, idempotencyKey: { $in: keys } }, { projection: { idempotencyKey: 1 } }).toArray()).map((d) => d.idempotencyKey)
        : []
    );
    let fbToday = 0, crmToday = 0, crm7 = 0;
    for (const l of leads) {
      const isToday = dateKey(new Date(String(l.created_time))) === today;
      const got = inCrm.has(`meta:${l.id}`);
      if (isToday) fbToday++;
      if (got) crm7++;
      if (got && isToday) crmToday++;
    }
    out.push({ id: f.id, name: f.name, status: f.status, fbToday, fb7: leads.length, crmToday, crm7, missing7: leads.length - crm7 });
  }
  return out;
}

export async function metaSyncReport(d: { compare?: boolean } | undefined, nowMs = Date.now()): Promise<Res<'metaSyncReport'>> {
  const tenant = requireTenant();
  const sources = (await (await sourcesCol()).find({ type: 'meta' }).sort({ _id: 1 }).toArray()) as MetaSourceDoc[];
  const pages: MetaSyncPage[] = [];
  for (const s of sources) {
    const m = metaOf(s);
    const page: MetaSyncPage = {
      sourceId: s._id, name: s.name, status: s.status, pageId: m.pageId || '', pageName: m.pageName || '', subscribed: !!m.subscribed,
      lastLeadAt: m.lastLeadAt || '', lastQuickSyncAt: m.lastQuickSyncAt || '', lastBackfillAt: m.lastBackfillAt || '',
      recovered: Number(m.recovered || 0), lastRecoveredAt: m.lastRecoveredAt || '', lastError: m.lastError || '',
      forms: null, compareError: '',
    };
    if (d?.compare && s.status === 'Active') {
      try {
        page.forms = await compareForms(s, nowMs);
      } catch (e: any) {
        page.compareError = truncate(errMsg(e).replace(/^Internal error: /, ''), 300);
      }
    }
    pages.push(page);
  }

  const ids = sources.map((s) => s._id);
  const rows = ids.length ? await (await inboundCol()).find({ sourceId: { $in: ids } }).sort({ receivedAt: -1 }).limit(30).toArray() : [];
  const formName = new Map<string, string>();
  for (const s of sources) for (const f of (metaOf(s).forms || []) as Array<{ id: string; name: string }>) formName.set(f.id, f.name);
  const feed = rows.map((r) => {
    const p = (r.payload || {}) as Record<string, string>;
    const created = p._created_time ? Date.parse(p._created_time) : NaN;
    const at = new Date(r.receivedAt).getTime();
    return {
      at: iso(r.receivedAt),
      leadId: r.leadId || '',
      name: truncate(p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || '', 80),
      status: r.status,
      message: truncate(r.message || '', 160),
      form: p.meta_form || formName.get(p._form_id || '') || p._form_id || '',
      campaign: p.meta_campaign || '',
      platform: (String(p.message || '').match(/Platform: ([^\n]+)/) || [])[1] || '',
      // only meaningful for fresh leads: a backfill imports old leads much later
      delaySec: Number.isFinite(created) && at >= created && at - created < DAY ? Math.round((at - created) / 1000) : null,
    };
  });

  const problems = (
    await (await queueCol())
      .find({ companyId: tenant.id, status: { $in: ['failed', 'dead', 'skipped', 'orphan'] }, receivedAt: { $gte: new Date(nowMs - 7 * DAY) } })
      .sort({ receivedAt: -1 })
      .limit(50)
      .toArray()
  ).map((q) => ({ id: q._id, status: q.status, error: truncate(q.lastError || '', 240), receivedAt: iso(q.receivedAt), attempts: q.attempts || 0 }));

  return { checkedAt: new Date(nowMs).toISOString(), pages, feed, problems };
}

export async function retryMetaLeads(ctx: Ctx | null): Promise<Res<'retryMetaLeads'>> {
  const tenant = requireTenant();
  const q = await queueCol();
  const items = await q.find({ companyId: tenant.id, status: { $in: ['failed', 'dead'] } }, { projection: { _id: 1 } }).limit(200).toArray();
  if (!items.length) return { retried: 0, results: [] };
  const ids = items.map((i) => i._id);
  await q.updateMany({ _id: { $in: ids } }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: null, lastError: '' } });
  const results = await processQueueItems(ids, { deadline: Date.now() + 45000 });
  await auditLog(ctx, 'Facebook Leads Retried', 'Settings', '', `${ids.length} lead(s) retried`);
  return { retried: ids.length, results };
}

export const actions: ActionMap = {
  metaSyncReport: { fn: (d) => metaSyncReport(d), perm: 'settings.view' },
  retryMetaLeads: { fn: (_d, ctx) => retryMetaLeads(ctx), perm: 'settings.edit' },
};
