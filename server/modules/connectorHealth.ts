/**
 * Connector contract and health (Release C) — one shape for every integration, so an admin sees the same states and
 * the same next step whatever the provider. Reads what each connector already records; makes no provider calls.
 *
 * Contract every connector meets (docs/INTEGRATIONS.md has the per-provider table):
 *   identity        which account / Page / number it is, and the permissions granted where the provider reports them
 *   ownership       stored in the company's own database (tenant), never shared across companies
 *   lifecycle       connect → verify (a test call) → reconnect → disconnect, each audited
 *   mapping         fields mapped to CRM fields, with a synthetic end-to-end test ("Send test data" / Test buttons)
 *   authenticity    signature or shared-secret check on every delivery; replay protection (timestamp window or
 *                   provider event id + dedupe)
 *   intake          persisted before acknowledgement (server/core/webhookInbox.ts or the Meta lead queue), normalised,
 *                   idempotent by provider id; correlation id per event
 *   recovery        retries with back-off, dead letters, replay, and a scheduled reconciliation against the
 *                   provider's own history where it offers one
 *
 * States:  connected · needs_reconnect (credentials expired or revoked — only a person can fix it) · degraded
 * (connected, but deliveries are failing or dead-lettered) · not_configured · disconnected.
 */
import type { ActionMap } from '../core/actions';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { getSecret } from '../core/settings';
import { currentTenant } from '../core/tenant';

export type ConnectorState = 'connected' | 'needs_reconnect' | 'degraded' | 'not_configured' | 'disconnected';
export interface ConnectorHealth {
  id: 'metaLeads' | 'whatsappDirect' | 'chat360' | 'telephony' | 'justconnect';
  name: string;
  state: ConnectorState;
  identity: string;
  detail: string;
  /** What to do next, in plain words, and where. Empty when nothing is needed. */
  action: string;
  lastEventAt: string;
  failing: number;
  deadLetters: number;
}

const TOKEN_EXPIRED = /expired|revoked|reconnect|invalid.*token|token.*invalid|wrong, revoked/i;

async function inboxStats(provider: string) {
  const c = await col<any>('webhookInbox');
  const [failing, dead, last] = await Promise.all([
    c.countDocuments({ provider, status: 'failed' }),
    c.countDocuments({ provider, status: 'dead' }),
    c.find({ provider }, { projection: { receivedAt: 1 } }).sort({ receivedAt: -1 }).limit(1).next(),
  ]);
  return { failing, dead, last: last?.receivedAt ? new Date(last.receivedAt).toISOString() : '' };
}

function withDeliveries(h: Omit<ConnectorHealth, 'failing' | 'deadLetters' | 'lastEventAt'>, s: { failing: number; dead: number; last: string }): ConnectorHealth {
  const out: ConnectorHealth = { ...h, failing: s.failing, deadLetters: s.dead, lastEventAt: s.last };
  if (out.state === 'connected' && (s.dead > 0 || s.failing > 5)) {
    out.state = 'degraded';
    out.detail = `${s.dead} event(s) could not be processed after every retry${s.failing ? `, ${s.failing} retrying` : ''}.`;
    out.action = 'Open Settings › Integrations › Delivery problems, fix the cause, then Replay.';
  }
  return out;
}

export async function getConnectorHealth(): Promise<ConnectorHealth[]> {
  const f = (currentTenant()?.features || {}) as Record<string, boolean>;
  const out: ConnectorHealth[] = [];

  if (f.metaLeads) {
    const pages = await (await col<any>('leadSources')).find({ type: 'meta', status: { $ne: 'Deleted' } }, { projection: { name: 1, status: 1, 'config.meta': 1 } }).toArray();
    if (!pages.length) out.push({ id: 'metaLeads', name: 'Facebook / Instagram lead forms', state: 'not_configured', identity: '', detail: 'No Page connected.', action: 'Connect a Facebook Page in Settings › Lead sources.', lastEventAt: '', failing: 0, deadLetters: 0 });
    for (const p of pages) {
      const m = p.config?.meta || {};
      const expired = TOKEN_EXPIRED.test(String(m.lastError || ''));
      out.push({
        id: 'metaLeads', name: 'Facebook / Instagram lead forms', identity: String(m.pageName || p.name || ''),
        state: p.status === 'Paused' ? 'disconnected' : expired ? 'needs_reconnect' : m.lastError ? 'degraded' : 'connected',
        detail: expired ? 'Facebook no longer accepts this Page\'s access (expired, password changed, or permission removed). New leads are not arriving through the webhook; the daily check cannot fetch them either.' : String(m.lastError || ''),
        action: expired ? 'An admin of the Facebook Page reconnects it: Settings › Lead sources › the Page › Reconnect. Then run Facebook sync for the missed days.' : m.lastError ? 'Open Settings › Lead sources › the Page to see the error, then Retry.' : '',
        lastEventAt: String(m.lastLeadAt || ''), failing: 0, deadLetters: 0,
      });
    }
  }

  if (f.whatsappDirect) {
    const c = await (await col<any>(CFG.COLL.INTEGRATIONS)).findOne({ _id: 'whatsappDirect' as any });
    const exp = c?.tokenSource !== 'platform' && c?.tokenExpiresAt ? new Date(c.tokenExpiresAt) : null;
    const expired = !!exp && exp.getTime() <= Date.now();
    const soon = !!exp && !expired && exp.getTime() - Date.now() < 14 * 86400e3;
    out.push(withDeliveries({
      id: 'whatsappDirect', name: 'WhatsApp (direct with Meta)', identity: c ? `${c.verifiedName || ''} ${c.displayPhone || ''}`.trim() : '',
      state: !c ? 'not_configured' : expired ? 'needs_reconnect' : 'connected',
      detail: !c ? 'Not connected.' : expired ? 'The access token has expired: messages cannot be sent or received.' : soon ? `The access token expires on ${exp!.toDateString()}.` : '',
      action: !c ? 'Connect WhatsApp in Settings › WhatsApp.' : expired || soon ? 'Settings › WhatsApp › Switch to permanent access (or reconnect with a new token).' : '',
    }, await inboxStats('whatsapp')));
  }

  if (f.chat360) {
    const key = await getSecret('CHAT360_API_KEY');
    const hook = await getSecret('CHAT360_WEBHOOK_SECRET');
    out.push(withDeliveries({
      id: 'chat360', name: 'WhatsApp (Chat360)', identity: '',
      state: !key ? 'not_configured' : !hook ? 'degraded' : 'connected',
      detail: !key ? 'No Chat360 API key.' : !hook ? 'Replies from customers cannot arrive: no webhook secret is set.' : '',
      action: !key ? 'Platform support adds the Chat360 key in Settings › Integrations.' : !hook ? 'Generate the webhook secret in Settings › Integrations › Chat360 and paste the URL into Chat360.' : '',
    }, await inboxStats('chat360')));
  }

  if (f.calls) {
    const hook = await getSecret('TELEPHONY_WEBHOOK_SECRET');
    out.push(withDeliveries({
      id: 'telephony', name: 'Telephony (call events)', identity: '',
      state: hook ? 'connected' : 'not_configured',
      detail: hook ? 'Accepts the call events of the configured provider (field map in Settings). Recording links are fetched only from allow-listed hosts.' : '',
      action: hook ? '' : 'Generate the telephony webhook secret in Settings › Integrations and give the URL to the provider.',
    }, await inboxStats('telephony')));
    const jc = await getSecret('JUSTCONNECT_API_KEY');
    const lastErr = await (await col<any>(CFG.COLL.ERROR_LOG)).find({ scope: /justconnect/i }).sort({ timestamp: -1 }).limit(1).next().catch(() => null);
    const revoked = !!lastErr && TOKEN_EXPIRED.test(String(lastErr.message || '')) && Date.now() - new Date(lastErr.timestamp).getTime() < 86400e3;
    out.push({
      id: 'justconnect', name: 'JustConnect (calling)', identity: '',
      state: !jc ? 'not_configured' : revoked ? 'needs_reconnect' : 'connected',
      detail: revoked ? 'JustConnect refused the API key in the last 24 hours (wrong, revoked or expired).' : '',
      action: !jc ? 'Platform support adds the JustConnect key in Settings › Integrations.' : revoked ? 'Create a new API key in JustConnect and paste it in Settings › Integrations › JustConnect, then press Test.' : '',
      lastEventAt: '', failing: 0, deadLetters: 0,
    });
  }
  return out;
}

export const actions: ActionMap = {
  getConnectorHealth: { perm: 'integrations.connect', fn: () => getConnectorHealth() },
};
