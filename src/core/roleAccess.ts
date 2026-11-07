/**
 * What a company's Admin can choose for each role (Settings › Roles & access). A fixed list, so nothing outside it can ever be
 * given: settings, keys, connected accounts and managing users are not on it, and Admins themselves are never limited, so a
 * company cannot lock itself out. Shared by the server (which enforces it) and the browser (which hides what is off).
 */
import type { Permission } from './rbac';

export type ConfigurableRole = 'Manager' | 'RM' | 'Viewer';
export const CONFIGURABLE_ROLES: Array<{ id: ConfigurableRole; label: string }> = [{ id: 'Manager', label: 'Manager' }, { id: 'RM', label: 'Agent' }, { id: 'Viewer', label: 'View only' }];

export interface AccessItem {
  id: string;
  group: string;
  label: string;
  /** The permissions this switches. Empty for a screen that needs none. */
  perms: Permission[];
  /** A screen to hide (screens with no data of their own to protect). */
  screen?: string;
  /** Changes something, so a View only user can never have it. */
  writes?: boolean;
  /** Only makes sense with this one on. */
  needs?: string;
  /** What it means, when the label is not enough. */
  note?: string;
  /** The older single switch this came from: a choice saved under it still counts. */
  was?: string;
}

export const ACCESS_ITEMS: AccessItem[] = [
  { id: 'leads.all', group: 'Leads', label: 'See all leads', perms: ['leads.viewAll'], note: 'Off: only the leads assigned to them.' },
  { id: 'leads.create', group: 'Leads', label: 'Add leads', perms: ['leads.create'], writes: true },
  { id: 'leads.edit', group: 'Leads', label: 'Edit leads', perms: ['leads.edit'], writes: true },
  { id: 'leads.import', group: 'Leads', label: 'Import leads', perms: ['leads.import'], writes: true },
  { id: 'leads.export', group: 'Leads', label: 'Export leads', perms: ['leads.export'] },
  { id: 'leads.phones', group: 'Leads', label: 'See phone numbers', perms: ['leads.phones'], note: 'Off: numbers show as 98•••••34 everywhere, including exports. They can still call through JustConnect and send WhatsApp from the CRM, but cannot call from their own phone.' },
  { id: 'reports.view', group: 'Reports', label: 'See reports and analytics', perms: ['reports.view'] },
  { id: 'reports.export', group: 'Reports', label: 'Export reports', perms: ['reports.export'], needs: 'reports.view' },
  { id: 'reports.credits', group: 'Reports', label: 'See WhatsApp credits', perms: ['reports.credits'], note: 'The balance at the top of the screen, usage and statement.' },
  { id: 'audit.view', group: 'Reports', label: 'See the audit log', perms: ['audit.view'] },
  { id: 'inventory.view', group: 'Inventory', label: 'See inventory', perms: ['inventory.view'] },
  { id: 'inventory.edit', group: 'Inventory', label: 'Edit inventory', perms: ['inventory.edit'], writes: true, needs: 'inventory.view' },
  { id: 'chat.view', group: 'Messages and calls', label: 'See chats and Social Inbox', perms: ['chat.view'] },
  { id: 'chat.send', group: 'Messages and calls', label: 'Send messages', perms: ['chat.send'], writes: true, needs: 'chat.view' },
  { id: 'calls.view', group: 'Messages and calls', label: 'See call history', perms: ['calls.view'] },
  { id: 'calls.log', group: 'Messages and calls', label: 'Log calls', perms: ['calls.log'], writes: true, needs: 'calls.view' },
  { id: 'marketing.posts', group: 'Marketing', label: 'Post Scheduler', perms: ['marketing.posts'], writes: true, was: 'marketing', note: 'Can publish, change and delete posts on your accounts.' },
  { id: 'marketing.ads', group: 'Marketing', label: 'Change ads', perms: ['marketing.ads'], writes: true, was: 'marketing', needs: 'leads.all', note: 'Can pause campaigns and change budgets, which spends money. The Ads screen needs "See all leads".' },
  { id: 'marketing.drip', group: 'Marketing', label: 'Drip Campaigns', perms: ['marketing.drip'], writes: true, was: 'marketing', note: 'Can start campaigns that message real leads.' },
  { id: 'marketing.bots', group: 'Marketing', label: 'WhatsApp Chatbots', perms: ['marketing.bots'], writes: true, note: 'Can start bots that answer real customers.' },
  { id: 'marketing.other', group: 'Marketing', label: 'Competitor Ads, review replies and page checks', perms: ['marketing.manage'], writes: true, was: 'marketing', note: 'Adds competitors, replies to Google reviews in public, and runs Search Console page checks.' },
  { id: 'tasks', group: 'Work', label: 'Tasks', perms: ['tasks.manage'], writes: true },
  { id: 'ai', group: 'Work', label: 'AI assistant', perms: ['ai.use', 'ai.actions'], writes: true },
  { id: 'screen.mis', group: 'Screens', label: 'Sales MIS', perms: [], screen: 'mis' },
  { id: 'screen.performance', group: 'Screens', label: 'YTD / MTD', perms: [], screen: 'performance' },
  { id: 'screen.kanban', group: 'Screens', label: 'Enquiry Status', perms: [], screen: 'kanban' },
  { id: 'screen.followups', group: 'Screens', label: 'Follow-ups', perms: [], screen: 'followups' },
  { id: 'screen.segments', group: 'Screens', label: 'Client Segments', perms: [], screen: 'segments' },
  { id: 'screen.templates', group: 'Screens', label: 'Templates', perms: [], screen: 'templates' },
  { id: 'screen.documents', group: 'Screens', label: 'Documents', perms: [], screen: 'documents' },
];

/** What a role can have before anything is chosen. Kept with the list: both sides must start from the same answer. */
const STARTS: Record<ConfigurableRole, string[]> = {
  Manager: ['leads.all', 'leads.create', 'leads.edit', 'leads.import', 'leads.export', 'leads.phones', 'reports.view', 'reports.export', 'reports.credits', 'audit.view', 'inventory.view', 'inventory.edit', 'chat.view', 'chat.send', 'calls.view', 'calls.log', 'marketing.posts', 'marketing.ads', 'marketing.drip', 'marketing.bots', 'marketing.other', 'tasks', 'ai'],
  RM: ['leads.create', 'leads.edit', 'leads.export', 'leads.phones', 'reports.view', 'inventory.view', 'chat.view', 'chat.send', 'calls.view', 'calls.log', 'tasks', 'ai'],
  Viewer: ['leads.all', 'leads.phones', 'reports.view', 'audit.view', 'inventory.view', 'chat.view', 'calls.view'],
};

export const itemOffered = (role: ConfigurableRole, item: AccessItem) => !(role === 'Viewer' && item.writes);
export const itemDefault = (role: ConfigurableRole, item: AccessItem) => !!item.screen || STARTS[role].includes(item.id);

export type RoleAccessConfig = Partial<Record<ConfigurableRole, Record<string, boolean>>>;
export interface UserAccess { allow: string[]; deny: string[]; hide: string[] }

/** What was chosen for it, including a choice saved under the older switch it came from. Null when nothing was. */
function pick(chosen: Record<string, unknown> | null | undefined, item: AccessItem): boolean | null {
  const v = chosen?.[item.id] ?? (item.was ? chosen?.[item.was] : undefined);
  return typeof v === 'boolean' ? v : null;
}

/** Is this on for the role, with what was chosen? Something it depends on being off turns it off too. */
export function itemOn(role: ConfigurableRole, item: AccessItem, chosen: Record<string, boolean> | undefined): boolean {
  if (!itemOffered(role, item)) return false;
  const on = pick(chosen, item) ?? itemDefault(role, item);
  if (!on) return false;
  const need = item.needs ? ACCESS_ITEMS.find((x) => x.id === item.needs) : null;
  return need ? itemOn(role, need, chosen) : true;
}

/** The changes from a role's starting point, which are what a signed-in user carries. Null when there are none. */
export function accessFor(role: string, config: RoleAccessConfig | null | undefined): UserAccess | null {
  if (role !== 'Manager' && role !== 'RM' && role !== 'Viewer') return null; // Admins and Platform support are never limited
  const chosen = config?.[role];
  const out: UserAccess = { allow: [], deny: [], hide: [] };
  for (const item of ACCESS_ITEMS) {
    const on = itemOn(role, item, chosen);
    if (item.screen) {
      if (!on) out.hide.push(item.screen);
    } else if (on !== itemDefault(role, item)) {
      if (!itemOffered(role, item)) continue;
      (on ? out.allow : out.deny).push(...item.perms);
    }
  }
  return out.allow.length || out.deny.length || out.hide.length ? out : null;
}

/** Only what is on the list, for a role that can have it: anything else sent to the server is dropped. */
export function cleanConfig(raw: any): RoleAccessConfig {
  const out: RoleAccessConfig = {};
  for (const { id: role } of CONFIGURABLE_ROLES) {
    const chosen: Record<string, boolean> = {};
    for (const item of ACCESS_ITEMS) {
      const v = pick(raw?.[role], item);
      if (v !== null && itemOffered(role, item) && v !== itemDefault(role, item)) chosen[item.id] = v;
    }
    if (Object.keys(chosen).length) out[role] = chosen;
  }
  return out;
}

/** Shared by both sides' `can`: what the company chose decides, if it chose anything about this permission. */
export function accessSays(access: UserAccess | null | undefined, permission: string): boolean | null {
  if (permission.startsWith('view.')) return !access?.hide?.includes(permission.slice(5));
  if (!access) return null;
  if (access.deny?.includes(permission)) return false;
  if (access.allow?.includes(permission)) return true;
  return null;
}
