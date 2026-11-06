/**
 * Every lead download goes in the audit log, and Admins are told when one person has taken many in a day. Counted over the day
 * so several small downloads add up. Files are built in the browser, so this records what the screens download: phone numbers
 * being hidden from a role (Settings › Roles & access) is what actually protects the list, since they are not in the browser.
 */
import type { ActionMap } from '../core/actions';
import { auditLog, can, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { settingsAll } from '../core/settings';
import { dateKey, truncate } from '../core/utils';
import { notifyAdmins } from './adminAlerts';
import { parseSalesOps } from './salesOps';

export async function logLeadExport(d: any, ctx: Ctx, now = new Date()): Promise<{ logged: boolean }> {
  const user = ctx.user;
  if (!user) throw fail('AUTH_REQUIRED', 'Please sign in');
  if (!can(user, 'leads.export') && !can(user, 'reports.export')) throw fail('FORBIDDEN', 'Your role cannot export leads.');
  const count = Math.max(0, Math.round(Number(d?.count) || 0));
  const what = truncate(String(d?.what || 'Lead list'), 120);
  if (!count) return { logged: false };
  await auditLog(ctx, 'Leads Exported', 'Lead', '', `${count} leads · ${what}`);

  if (user.role === 'Admin' || user.role === 'Developer') return { logged: true };
  const limit = parseSalesOps((await settingsAll()).salesOps).exportAlertAt;
  if (!limit) return { logged: true };
  const day = dateKey(now);
  const doc = await (await col<{ _id: string; n: number; at: Date }>(CFG.COLL.META)).findOneAndUpdate(
    { _id: `exports:${user.id}:${day}` },
    { $inc: { n: count }, $set: { at: now } },
    { upsert: true, returnDocument: 'after' }
  );
  const today = doc?.n ?? count;
  if (today >= limit) {
    await notifyAdmins(`export:${user.id}:${day}`, `Large lead export by ${user.name}`, `${user.name} (${user.role}) has downloaded ${today} leads today. Latest: ${count} from ${what}.`, now.getTime());
  }
  return { logged: true };
}

export const actions: ActionMap = {
  logLeadExport: { fn: (d, ctx) => logLeadExport(d, ctx), perm: 'leads.view' },
};
