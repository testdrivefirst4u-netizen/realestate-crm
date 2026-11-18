/**
 * Realtime push (Ably) — makes the whole CRM update live instead of waiting for the 30s poll.
 *
 * It rides the existing event feed: every change already writes a CrmEvent (server/core/events.ts → addEvent). Here we
 * also publish a tiny "something changed" notification to the company's own Ably channel. The browser holds a WebSocket
 * to Ably (subscribe-only, scoped to its company by a signed token from /api/realtime/ably-token) and, on each message,
 * immediately re-polls getEvents — so the proven event pipeline stays the single source of truth and nothing can arrive
 * out of order. If ABLY_API_KEY is not set, everything here is a no-op and the CRM runs exactly as before (30s poll).
 *
 * The key is secret and server-only. The browser never sees it; it authenticates through the token endpoint.
 */
import Ably from 'ably';
import { currentTenant } from './tenant';

let rest: Ably.Rest | null = null;
function restClient(): Ably.Rest | null {
  const key = process.env.ABLY_API_KEY?.trim();
  if (!key) return null;
  if (!rest) rest = new Ably.Rest(key);
  return rest;
}

export const realtimeEnabled = () => !!process.env.ABLY_API_KEY?.trim();
/** One channel per company (tenant.id === the client's company.id), so a tenant only ever receives its own events. */
export const channelFor = (tenantId: string) => `company-${tenantId}`;

/** Push a change notification to the company's live channel. Never throws — realtime is best-effort; the poll catches up. */
export async function publishRealtime(type: string, recordType: string, recordId: string): Promise<void> {
  try {
    const c = restClient();
    if (!c) return;
    const t = currentTenant();
    if (!t) return;
    await c.channels.get(channelFor(t.id)).publish('change', { type, recordType, recordId, at: Date.now() });
  } catch {
    /* ignore: the 30s poll still delivers the change */
  }
}

/** A subscribe-only Ably token scoped to this company's channel, for the browser SDK (never the raw key). */
export async function ablyTokenRequest(tenantId: string, clientId: string): Promise<unknown | null> {
  const c = restClient();
  if (!c) return null;
  return c.auth.createTokenRequest({ clientId, capability: JSON.stringify({ [channelFor(tenantId)]: ['subscribe'] }) });
}
