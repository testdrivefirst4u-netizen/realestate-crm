/**
 * Super-admin management of one company's lead sources (PlatformLeadSourceActions).
 * Each call loads the company (not deleted), runs the company functions of server/modules/leadSources.ts
 * inside runWithTenant(company) and writes a platform audit entry for mutations. The company's plan does
 * not need `websiteApi` here (the public endpoint still refuses keys until the feature is on).
 */
import { runWithTenant } from '../core/tenant';
import type { PlatformLeadSourceActions } from '../core/leadSourceTypes';
import * as LS from '../modules/leadSources';
import { toTenant } from './registry';
import { platformAudit, type SaCtx } from './base';
import { companyActor, findCompany } from './companies';

type Req<K extends keyof PlatformLeadSourceActions> = PlatformLeadSourceActions[K]['req'];
type Res<K extends keyof PlatformLeadSourceActions> = PlatformLeadSourceActions[K]['res'];

async function inCompany<T>(companyId: unknown, fn: () => Promise<T>) {
  const c = await findCompany(String(companyId || ''));
  return { company: c, result: await runWithTenant(toTenant(c), fn) };
}

export async function listCompanyLeadSources(d: Req<'listCompanyLeadSources'>): Promise<Res<'listCompanyLeadSources'>> {
  return (await inCompany(d?.companyId, () => LS.listLeadSources())).result;
}

export async function createCompanyLeadSource(d: Req<'createCompanyLeadSource'>, ctx: SaCtx): Promise<Res<'createCompanyLeadSource'>> {
  const { company, result } = await inCompany(d?.companyId, () => LS.createLeadSource({ name: d?.name, type: d?.type, config: d?.config }, companyActor(ctx)));
  await platformAudit(ctx, 'Lead Source Created', company._id, `${result.source.id} ${result.source.name} (${result.source.type}) key ${result.source.keyPrefix}…`);
  return result;
}

export async function updateCompanyLeadSource(d: Req<'updateCompanyLeadSource'>, ctx: SaCtx): Promise<Res<'updateCompanyLeadSource'>> {
  const { company, result } = await inCompany(d?.companyId, () => LS.updateLeadSource({ id: d?.id, patch: d?.patch }, companyActor(ctx)));
  const fields = Object.keys(d?.patch && typeof d.patch === 'object' ? d.patch : {}).join(', ');
  await platformAudit(ctx, 'Lead Source Updated', company._id, `${result.id} ${result.name}: ${fields || 'no changes'}`);
  return result;
}

export async function rotateCompanyLeadSourceKey(d: Req<'rotateCompanyLeadSourceKey'>, ctx: SaCtx): Promise<Res<'rotateCompanyLeadSourceKey'>> {
  const { company, result } = await inCompany(d?.companyId, () => LS.rotateLeadSourceKey({ id: d?.id }, companyActor(ctx)));
  await platformAudit(ctx, 'Lead Source Key Rotated', company._id, `${result.source.id} ${result.source.name}: new key ${result.source.keyPrefix}…`);
  return result;
}

export async function deleteCompanyLeadSource(d: Req<'deleteCompanyLeadSource'>, ctx: SaCtx): Promise<Res<'deleteCompanyLeadSource'>> {
  const { company, result } = await inCompany(d?.companyId, () => LS.deleteLeadSource({ id: d?.id }, companyActor(ctx)));
  await platformAudit(ctx, 'Lead Source Deleted', company._id, String(d?.id || ''));
  return result;
}

export async function companyInboundLog(d: Req<'companyInboundLog'>): Promise<Res<'companyInboundLog'>> {
  return (await inCompany(d?.companyId, () => LS.listInboundLog({ sourceId: d?.sourceId, status: d?.status, limit: d?.limit }))).result;
}
