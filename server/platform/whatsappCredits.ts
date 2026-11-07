/**
 * WhatsApp credits, the Super Admin side: every client's balance and month, Meta's cost and the margin, adding credits, and
 * prices. Companies keep their own ledgers (server/modules/whatsappCredits.ts); this visits each one with the switch on.
 */
import { fail } from '../core/errors';
import { runWithTenant } from '../core/tenant';
import { dateKey, str, truncate } from '../core/utils';
import { addCreditEntry, CATEGORIES, getPricing, monthOf, monthSummary, setPricing, toRupees, toUnits, type WhatsappPricing } from '../modules/whatsappCredits';
import { mapLimit, platformAudit, type SaCtx } from './base';
import type { PlatformActions, WhatsappCreditsOverview, WhatsappCreditsCompany } from './contract';
import { getTenantById, listActiveTenants } from './registry';

type Req<K extends keyof PlatformActions> = PlatformActions[K]['req'];

export async function whatsappCreditsOverview(d: Req<'whatsappCreditsOverview'>, now = new Date()): Promise<WhatsappCreditsOverview> {
  const month = monthOf(d?.month, now);
  const pricing = await getPricing();
  const tenants = (await listActiveTenants()).filter((t) => (t.features as any)?.whatsappCredits);
  const companies = await mapLimit(tenants, 5, (t) => runWithTenant(t, async (): Promise<WhatsappCreditsCompany> => {
    const s = await monthSummary(month);
    const available = s.wallet.balance - s.wallet.held;
    return {
      companyId: t.id, name: t.name, direct: !!(t.features as any)?.whatsappDirect,
      balance: toRupees(s.wallet.balance), held: toRupees(s.wallet.held), low: available < toUnits(pricing.lowBalanceAt),
      addedMonth: toRupees(s.addedUnits), usedMonth: toRupees(s.usedUnits), metaCostMonth: toRupees(s.costUnits), marginMonth: toRupees(s.usedUnits - s.costUnits),
      messages: s.used.length, freeMessages: s.used.filter((e) => e.type === 'free').length, mismatch: toRupees(s.mismatchUnits),
      recent: s.entries.filter((e) => e.type === 'credit').sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 5).map((e) => ({ at: e.at.toISOString(), amount: toRupees(e.units), reference: e.reference || '', note: e.note || '', by: e.by || '' })),
    };
  }));
  companies.sort((a, b) => a.name.localeCompare(b.name));
  const add = (f: (c: WhatsappCreditsCompany) => number) => Math.round(companies.reduce((t, c) => t + f(c), 0) * 10000) / 10000;
  return {
    month, thisMonth: dateKey(now).slice(0, 7), pricing, companies,
    totals: { balance: add((c) => c.balance), added: add((c) => c.addedMonth), used: add((c) => c.usedMonth), metaCost: add((c) => c.metaCostMonth), margin: add((c) => c.marginMonth), messages: add((c) => c.messages) },
  };
}

const MAX_ONE_TIME = 1000000;

export async function addWhatsappCredits(d: Req<'addWhatsappCredits'>, ctx: SaCtx): Promise<{ applied: boolean }> {
  const companyId = str(d?.companyId);
  const tenant = await getTenantById(companyId);
  if (!tenant) throw fail('NOT_FOUND', 'Company not found');
  if (!(tenant.features as any)?.whatsappCredits) throw fail('VALIDATION', 'Turn on WhatsApp credits for this company first.');
  const amount = Math.round(Number(d?.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_ONE_TIME) throw fail('VALIDATION', `Enter an amount up to ₹${MAX_ONE_TIME.toLocaleString('en-IN')}.`);
  const correction = d?.kind === 'correction';
  if (!correction && amount < 0) throw fail('VALIDATION', 'To take credits away, choose Correction.');
  const reference = truncate(str(d?.reference), 120);
  const note = truncate(str(d?.note), 200);
  if (!correction && !reference) throw fail('VALIDATION', 'Enter the payment reference (UTR, UPI or invoice number).');
  if (correction && !note) throw fail('VALIDATION', 'Say why this correction is being made.');
  const requestId = str(d?.requestId);
  if (!/^[\w-]{8,64}$/.test(requestId)) throw fail('VALIDATION', 'Please try again.');
  const by = ctx.sa?.name || 'Super admin';
  const r = await runWithTenant(tenant, () => addCreditEntry({ requestId, units: toUnits(amount), reference, note: correction ? note : note, by }));
  if (r.applied) await platformAudit(ctx, correction ? 'WhatsApp Credits Corrected' : 'WhatsApp Credits Added', companyId, `₹${amount} · ${reference || note}`);
  return r;
}

/** Prices can be below cost only on purpose: the screen warns, this only refuses nonsense. */
export function cleanPricing(d: any): WhatsappPricing {
  const num = (v: unknown, what: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw fail('VALIDATION', `Check the ${what}.`);
    return Math.round(n * 10000) / 10000;
  };
  const table = (src: any, label: string) => Object.fromEntries(CATEGORIES.map((c) => [c, num(src?.[c], `${c} ${label}`)])) as WhatsappPricing['prices'];
  const lowBalanceAt = Number(d?.lowBalanceAt);
  const replyGrace = Number(d?.replyGrace);
  if (!Number.isFinite(lowBalanceAt) || lowBalanceAt < 0 || lowBalanceAt > MAX_ONE_TIME) throw fail('VALIDATION', 'Check the low balance amount.');
  if (!Number.isInteger(replyGrace) || replyGrace < 0 || replyGrace > 10000) throw fail('VALIDATION', 'Check the number of replies allowed at zero.');
  return { prices: table(d?.prices, 'price'), costs: table(d?.costs, "cost"), lowBalanceAt, replyGrace };
}

export async function saveWhatsappPricing(d: Req<'saveWhatsappPricing'>, ctx: SaCtx): Promise<WhatsappPricing> {
  const clean = cleanPricing(d);
  await setPricing(clean, ctx.sa?.name || 'Super admin');
  await platformAudit(ctx, 'WhatsApp Prices Changed', '', CATEGORIES.map((c) => `${c} ₹${clean.prices[c]} (cost ₹${clean.costs[c]})`).join(', '));
  return getPricing();
}
