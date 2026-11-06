/** Settings › Roles & access: an Admin chooses what Managers, Agents and View only users can do. The list is in src/core/roleAccess.ts. */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { clearRoleAccessCache, loadRoleAccess } from '../core/roleAccess';
import { cleanConfig, type RoleAccessConfig } from '../../src/core/roleAccess';

export async function getRoleAccess(): Promise<{ config: RoleAccessConfig }> {
  return { config: await loadRoleAccess(true) };
}

export async function saveRoleAccess(d: any, ctx: Ctx): Promise<{ config: RoleAccessConfig }> {
  const before = await loadRoleAccess(true);
  const config = cleanConfig(d?.config);
  await (await col<any>(CFG.COLL.INTEGRATIONS)).updateOne({ _id: 'roleAccess' }, { $set: { config, updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' } }, { upsert: true });
  clearRoleAccessCache();
  await auditLog(ctx, 'Role Access Changed', 'Settings', 'roleAccess', Object.keys(config).join(', ') || 'Back to defaults', { before, after: config });
  return { config };
}

export const actions: ActionMap = {
  getRoleAccess: { fn: () => getRoleAccess(), perm: 'users.manage' },
  saveRoleAccess: { fn: (d, ctx) => saveRoleAccess(d, ctx), perm: 'users.manage' },
};
