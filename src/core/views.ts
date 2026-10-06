/**
 * The CRM screens: one App Router route each (`app/(crm)/<view>/page.tsx`).
 *
 * `viewAllowed` is the single rule for "may this user open this screen?" — the server pages call it
 * before rendering (a typed or bookmarked URL redirects to the dashboard) and the sidebar uses it to
 * hide entries, so both always agree.
 */
import { hasFeature, type FeatureName } from './features';
import type { Permission } from './rbac';

export type ViewId =
  | 'dashboard' | 'leads' | 'segments' | 'kanban' | 'followups' | 'tasks' | 'inventory' | 'chat360' | 'calls'
  | 'documents' | 'templates' | 'reports' | 'audit' | 'settings';

export const VIEW_IDS: ViewId[] = ['dashboard', 'leads', 'segments', 'kanban', 'followups', 'tasks', 'inventory', 'chat360', 'calls', 'documents', 'templates', 'reports', 'audit', 'settings'];

export const DEFAULT_VIEW: ViewId = 'dashboard';

/** Page headings (top bar) and browser-tab titles. */
export const VIEW_TITLES: Record<ViewId, string> = {
  dashboard: 'Dashboard', leads: 'All Leads', segments: 'Client Segments', kanban: 'Enquiry Status', followups: 'Follow-ups', tasks: 'Tasks & Notes',
  inventory: 'Inventory', chat360: 'WhatsApp · Chat360', calls: 'Call History', documents: 'Documents', templates: 'Templates', reports: 'Reports', audit: 'Audit Log', settings: 'Settings',
};

export const viewHref = (view: ViewId) => `/${view}`;

/** `/leads` → 'leads'; anything else (including nested paths) → null. */
export function viewFromPath(pathname: string | null | undefined): ViewId | null {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  const v = decodeURIComponent(parts[0]).toLowerCase() as ViewId;
  return VIEW_IDS.includes(v) ? v : null;
}

type SettingsLike = { features?: Record<string, boolean> | null } | null | undefined;

/** Plan feature + permission a screen needs (the same rules the sidebar shows entries by). */
export function viewAllowed(view: ViewId, settings: SettingsLike, can: (p: Permission) => boolean): boolean {
  const on = (name: FeatureName) => hasFeature(settings, name);
  switch (view) {
    case 'chat360': return on('chat360') && can('chat.view');
    case 'calls': return on('calls') && can('calls.view');
    case 'inventory': return on('inventory') && can('inventory.view');
    case 'segments': return on('segments');
    case 'documents': return on('documents');
    case 'templates': return on('templates');
    case 'reports': return on('reports') && can('reports.view');
    case 'audit': return can('audit.view');
    default: return true;
  }
}
