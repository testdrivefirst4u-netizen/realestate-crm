import { UserAccount, UserRole } from '../types/crm';

/**
 * Role-based access control — mirrored in server/ (the backend
 * enforces; the frontend only hides what the user cannot do).
 */

export type Permission =
  | 'leads.view'
  | 'leads.viewAll'
  | 'leads.editHistory'
  | 'leads.create'
  | 'leads.edit'
  | 'leads.trash'
  | 'leads.delete'
  | 'leads.import'
  | 'leads.export'
  | 'tasks.manage'
  | 'inventory.view'
  | 'inventory.edit'
  | 'reports.view'
  | 'reports.export'
  | 'chat.view'
  | 'chat.send'
  | 'calls.view'
  | 'calls.log'
  | 'ai.use'
  | 'ai.actions'
  | 'settings.view'
  | 'settings.edit'
  | 'users.manage'
  /** Add and manage Agents (Managers); Admins manage everyone (users.manage). */
  | 'users.manageAgents'
  | 'secrets.manage'
  | 'developer.view'
  | 'developer.edit'
  | 'developer.deploy'
  | 'audit.view';

const ALL: Permission[] = [
  'leads.view', 'leads.viewAll', 'leads.editHistory', 'leads.create', 'leads.edit', 'leads.trash', 'leads.delete', 'leads.import', 'leads.export',
  'tasks.manage', 'inventory.view', 'inventory.edit', 'reports.view', 'reports.export',
  'chat.view', 'chat.send', 'calls.view', 'calls.log', 'ai.use', 'ai.actions',
  'settings.view', 'settings.edit', 'users.manage', 'users.manageAgents', 'secrets.manage',
  'developer.view', 'developer.edit', 'developer.deploy', 'audit.view',
];

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  // Company settings, integrations and keys belong to the platform: only Developer (the Platform support account).
  Admin: ALL.filter((p) => !p.startsWith('settings.') && p !== 'secrets.manage' && !p.startsWith('developer.')),
  Developer: ALL,
  // Managers: full lead access and the audit log; may add and manage Agents.
  Manager: ALL.filter((p) => !p.startsWith('settings.') && p !== 'secrets.manage' && !p.startsWith('developer.') && p !== 'users.manage'),
  RM: [
    'leads.view', 'leads.create', 'leads.edit', 'leads.export',
    'tasks.manage', 'inventory.view', 'reports.view',
    'chat.view', 'chat.send', 'calls.view', 'calls.log', 'ai.use', 'ai.actions',
  ],
};

/** Map legacy role names stored in older builds. */
export function normalizeRole(role: string | undefined | null): UserRole {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'admin' || r === 'administrator') return 'Admin';
  if (r === 'developer' || r === 'dev') return 'Developer';
  if (r === 'manager' || r === 'sales manager') return 'Manager';
  return 'RM'; // 'rm', 'relationship manager', 'executive', 'user'
}

export function can(user: UserAccount | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  const role = normalizeRole(user.role);
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function roleLabel(role: UserRole | string): string {
  switch (normalizeRole(role)) {
    case 'Admin':
      return 'Administrator';
    case 'Manager':
      return 'Sales Manager';
    case 'Developer':
      return 'Platform support';
    default:
      return 'Agent';
  }
}

/** Roles a company can give its people (Developer is the platform's support account — never offered). */
export const ROLE_OPTIONS: Array<{ id: UserRole; label: string; description: string }> = [
  { id: 'RM', label: 'Agent', description: 'Works only the leads assigned to them: follow-ups, tasks, calls and chats.' },
  { id: 'Manager', label: 'Manager', description: 'Full access to all leads, reports, inventory and the audit log. Can add and manage Agents.' },
  { id: 'Admin', label: 'Admin', description: 'Everything a Manager can do, plus adding Managers and Admins.' },
];

/** Roles `actor` may give: Admins any company role, Managers only Agent. */
export function assignableRoles(actor: UserAccount | null | undefined): typeof ROLE_OPTIONS {
  if (can(actor, 'users.manage')) return ROLE_OPTIONS;
  return can(actor, 'users.manageAgents') ? ROLE_OPTIONS.filter((r) => r.id === 'RM') : [];
}
