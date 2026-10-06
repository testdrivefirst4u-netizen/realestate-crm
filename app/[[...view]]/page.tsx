/**
 * Every CRM screen is served by this one route: `/dashboard`, `/leads`, `/kanban`, … (and `/` → `/dashboard`).
 * The SPA in src/App.tsx reads the path itself and keeps it in sync with the history API.
 */
import { CrmClient } from './CrmClient';

export default function Page() {
  return <CrmClient />;
}
