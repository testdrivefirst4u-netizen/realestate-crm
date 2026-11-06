/**
 * The company's choices for each role, read when a session is checked. Kept 30 seconds per company, so every request does not
 * need another read: a change reaches other server instances within that time. If it cannot be read, people keep what their
 * role has by default rather than being locked out.
 */
import { accessFor, CONFIGURABLE_ROLES, type RoleAccessConfig, type UserAccess } from '../../src/core/roleAccess';
import { CFG } from './config';
import { col } from './db';
import { currentTenant } from './tenant';

const KEEP_MS = 30000;
const kept = new Map<string, { at: number; config: RoleAccessConfig }>();

export async function loadRoleAccess(fresh = false): Promise<RoleAccessConfig> {
  const id = currentTenant()?.id || '';
  const hit = kept.get(id);
  if (!fresh && hit && Date.now() - hit.at < KEEP_MS) return hit.config;
  const doc = await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'roleAccess' });
  const config: RoleAccessConfig = doc?.config || {};
  kept.set(id, { at: Date.now(), config });
  return config;
}

export async function accessOfRole(role: string): Promise<UserAccess | null> {
  if (role !== 'Manager' && role !== 'RM' && role !== 'Viewer') return null;
  try {
    return accessFor(role, await loadRoleAccess());
  } catch (e: any) {
    console.error('[roleAccess]', e?.message);
    return null;
  }
}

/**
 * Is the company hiding phone numbers from any role? Alerts go to mixed groups by push and e-mail, past the router's mask, so
 * they then leave the number out. If the choice cannot be read they leave it out too: an alert still says who to open.
 */
export async function phonesHiddenFromSomeone(): Promise<boolean> {
  try {
    const config = await loadRoleAccess();
    return CONFIGURABLE_ROLES.some((r) => accessFor(r.id, config)?.deny.includes('leads.phones'));
  } catch (e: any) {
    console.error('[roleAccess]', e?.message);
    return true;
  }
}

export function clearRoleAccessCache() {
  kept.clear();
}
