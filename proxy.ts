/**
 * Tells the CRM layout which URL is being rendered (layouts do not receive the path), so a signed-out
 * visitor sent to /login comes back to the same screen — e.g. a shared `/leads?lead=ENQ-0001` link.
 * No auth decision is made here; app/(crm)/layout.tsx validates the session.
 */
import { NextResponse, type NextRequest } from 'next/server';

/** Read by server/core/pageSession.ts (kept as a literal: importing it would pull the database code into the proxy). */
const CRM_URL_HEADER = 'x-crm-url';

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(CRM_URL_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/dashboard', '/leads', '/segments', '/kanban', '/followups', '/tasks', '/inventory', '/chat360', '/calls', '/documents', '/templates', '/reports', '/audit', '/settings'],
};
