/**
 * A tiny in-browser signal for realtime pushes. The engine's Ably subscription (src/core/engine.ts) calls emitLive()
 * whenever the server pushes "something changed"; any screen that polls its own data — Live Chat, Social Inbox, the open
 * chat thread — subscribes with onLive() and re-polls immediately instead of waiting for its own timer. A no-op on the
 * server and when realtime (ABLY_API_KEY) is off, in which case each screen's poll interval stays as the fallback.
 */
export interface LiveChange { type?: string; recordType?: string; recordId?: string }

/** Broadcast that the server pushed a change (called by the engine on each Ably message). */
export function emitLive(detail?: LiveChange): void {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent('crm:live', { detail: detail || {} })); } catch { /* ignore */ }
}

/** Re-poll now on a realtime push. Returns an unsubscribe fn. The callback gets the change (recordType etc.) if present. */
export function onLive(cb: (change: LiveChange) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const h = (e: Event) => { try { cb((e as CustomEvent).detail || {}); } catch { /* ignore */ } };
  window.addEventListener('crm:live', h);
  return () => window.removeEventListener('crm:live', h);
}
