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
  | 'secrets.manage'
  | 'developer.view'
  | 'developer.edit'
  | 'developer.deploy'
  | 'audit.view';

const ALL: Permission[] = [
  'leads.view', 'leads.viewAll', 'leads.editHistory', 'leads.create', 'leads.edit', 'leads.trash', 'leads.delete', 'leads.import', 'leads.export',
  'tasks.manage', 'inventory.view', 'inventory.edit', 'reports.view', 'reports.export',
  'chat.view', 'chat.send', 'calls.view', 'calls.log', 'ai.use', 'ai.actions',
  'settings.view', 'settings.edit', 'users.manage', 'secrets.manage',
  'developer.view', 'developer.edit', 'developer.deploy', 'audit.view',
];

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  Admin: ALL.filter((p) => !p.startsWith('developer.edit') && p !== 'developer.deploy').concat(['developer.view']),
  Developer: ALL,
  Manager: [
    'leads.view', 'leads.viewAll', 'leads.editHistory', 'leads.create', 'leads.edit', 'leads.trash', 'leads.import', 'leads.export',
    'tasks.manage', 'inventory.view', 'inventory.edit', 'reports.view', 'reports.export',
    'chat.view', 'chat.send', 'calls.view', 'calls.log', 'ai.use', 'ai.actions',
    'settings.view', 'audit.view',
  ],
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
      return 'Developer';
    default:
      return 'Relationship Manager';
  }
}

export const ROLE_OPTIONS: Array<{ id: UserRole; label: string; description: string }> = [
  { id: 'RM', label: 'RM / User', description: 'Works leads, follow-ups, tasks, calls and chats. Cannot delete or change settings.' },
  { id: 'Manager', label: 'Manager', description: 'Everything an RM can do plus trash/import leads, edit inventory, view audit log.' },
  { id: 'Admin', label: 'Admin', description: 'Full access to settings, users, integrations and API keys.' },
  { id: 'Developer', label: 'Developer', description: 'Same access as Admin — for the technical owner of the deployment.' },
];
