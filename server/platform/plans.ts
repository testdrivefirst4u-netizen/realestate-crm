/**
 * Subscription plans (PCOLL.PLANS, `_id` = plan id). Display-only prices; a plan supplies the default
 * user limit and features of a new company. The three default plans are seeded once on first use.
 */
import { fail } from '../core/errors';
import { str, truncate } from '../core/utils';
import type { TenantFeatures } from '../core/tenant';
import { normalizeFeatures, PCOLL } from './registry';
import { pc, platformAudit, type SaCtx } from './base';
import type { Plan } from './contract';

interface PlanDoc extends Omit<Plan, 'id'> {
  _id: string;
  updatedAt: Date;
}

const ALL_ON: TenantFeatures = { aiCopilot: true, chat360: true, calls: true, inventory: true, unitLocator: true, projectLibrary: true, reports: true, segments: true, websiteApi: true, metaLeads: true, googleSheets: true };

export const DEFAULT_PLANS: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    description: 'Core CRM for small teams: leads, tasks, calls, inventory and reports.',
    maxUsers: 5,
    features: { aiCopilot: false, chat360: false, calls: true, inventory: true, reports: true, segments: true, unitLocator: false, projectLibrary: false, websiteApi: true, metaLeads: false, googleSheets: false },
    priceMonthly: 2999,
    currency: 'INR',
  },
  {
    id: 'growth',
    name: 'Growth',
    description: 'Adds AI Copilot and WhatsApp (Chat360) for growing sales teams.',
    maxUsers: 25,
    features: { ...ALL_ON, unitLocator: false, projectLibrary: false },
    priceMonthly: 9999,
    currency: 'INR',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Unlimited users with every module, including the unit locator.',
    maxUsers: 0,
    features: { ...ALL_ON, projectLibrary: false },
    priceMonthly: 24999,
    currency: 'INR',
  },
];

const PLAN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const plans = async () => {
  const c = await pc<PlanDoc>(PCOLL.PLANS);
  // Seed the default plans exactly once (a marker in the counters collection survives later deletions).
  const counters = await pc<{ _id: string }>(PCOLL.COUNTERS);
  const r = await counters.updateOne({ _id: 'plansSeeded' }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  if (r.upsertedCount === 1) {
    for (const p of DEFAULT_PLANS) {
      const { id, ...rest } = p;
      await c.updateOne({ _id: id }, { $setOnInsert: { ...rest, updatedAt: new Date() } }, { upsert: true });
    }
  }
  return c;
};

export function toPlan(d: PlanDoc): Plan {
  return {
    id: d._id,
    name: str(d.name),
    description: str(d.description),
    maxUsers: Math.max(0, Math.floor(Number(d.maxUsers) || 0)),
    features: normalizeFeatures(d.features),
    priceMonthly: Number(d.priceMonthly) || 0,
    currency: str(d.currency) || 'INR',
  };
}

export async function listPlans(): Promise<Plan[]> {
  const rows = await (await plans()).find({}).sort({ priceMonthly: 1, _id: 1 }).toArray();
  return rows.map(toPlan);
}

export async function getPlan(id: string): Promise<Plan | null> {
  const d = await (await plans()).findOne({ _id: String(id || '') });
  return d ? toPlan(d) : null;
}

export function validMaxUsers(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw fail('VALIDATION', 'Max users must be a whole number ≥ 0 (0 = unlimited)');
  return n;
}

export async function savePlan(d: any, ctx: SaCtx): Promise<Plan> {
  const p = d?.plan;
  if (!p || typeof p !== 'object') throw fail('VALIDATION', 'Plan is required');
  const id = String(p.id || '').trim().toLowerCase();
  if (!PLAN_ID_RE.test(id)) throw fail('VALIDATION', 'Plan id must be 1–32 characters: a-z, 0-9 and -');
  const name = String(p.name || '').trim();
  if (!name) throw fail('VALIDATION', 'Plan name is required');
  const price = Number(p.priceMonthly ?? 0);
  if (!Number.isFinite(price) || price < 0) throw fail('VALIDATION', 'Price must be a number ≥ 0');
  const currency = String(p.currency || 'INR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw fail('VALIDATION', 'Currency must be a 3-letter code');
  const c = await plans();
  const before = await c.findOne({ _id: id });
  const doc = {
    name: truncate(name, 80),
    description: truncate(String(p.description || '').trim(), 500),
    maxUsers: validMaxUsers(p.maxUsers ?? 0),
    features: normalizeFeatures({ ...(before?.features || {}), ...(p.features || {}) }),
    priceMonthly: price,
    currency,
    updatedAt: new Date(),
  };
  await c.updateOne({ _id: id }, { $set: doc }, { upsert: true });
  await platformAudit(ctx, before ? 'Plan Updated' : 'Plan Created', '', `${id} (${doc.name})`);
  return toPlan({ _id: id, ...doc });
}

export async function deletePlan(d: any, ctx: SaCtx) {
  const id = String(d?.id || '');
  const c = await plans();
  const p = await c.findOne({ _id: id });
  if (!p) throw fail('NOT_FOUND', 'Plan not found');
  const inUse = await (await pc(PCOLL.COMPANIES)).countDocuments({ plan: id, deletedAt: { $in: [null, undefined] } } as any);
  if (inUse > 0) throw fail('CONFLICT', `${inUse} compan${inUse === 1 ? 'y uses' : 'ies use'} this plan. Move them to another plan first.`);
  await c.deleteOne({ _id: id });
  await platformAudit(ctx, 'Plan Deleted', '', id);
  return { ok: true as const };
}
