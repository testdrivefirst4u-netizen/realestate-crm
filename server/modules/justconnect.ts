/**
 * JustConnect calling (step 1): connection test, CRM user ↔ JustConnect agent links, click-to-call.
 *
 * Click-to-call: the RM's JustConnect phone rings first; when they answer, the customer is called from the business
 * number (the customer never sees the RM's own number). The lead id goes along as `ref`, so the call can be matched
 * back to the lead. A CRM user is linked to an agent by an explicit choice (Settings) or, by default, the same e-mail.
 */
import type { ActionMap } from '../core/actions';
import { listUsers, type Ctx, type PublicUser } from '../core/auth';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { fail } from '../core/errors';
import { addTimeline } from '../core/events';
import { assertLeadAccess } from '../core/scope';
import { digits, truncate } from '../core/utils';
import { jc, JustConnectError, type JcAgent } from '../integrations/justconnect';
import { getLead } from './leads';

const L = CFG.LEAD;
const NEEDED_SCOPES = ['calls:read', 'calls:write', 'contacts:read', 'contacts:write', 'reports:read'];

/** JustConnect refusals → messages an RM can act on. */
function friendly(e: unknown): never {
  if (!(e instanceof JustConnectError)) throw e;
  const byCode: Record<string, string> = {
    'agent-offline': 'Your JustConnect app is not signed in. Open JustConnect on your phone, sign in, and try again.',
    'agent-busy': 'You are already on another JustConnect call. Finish it and try again.',
    'agent-cannot-call-out': 'Your JustConnect agent is not allowed to make outgoing calls. The JustConnect owner can allow it on the Agents screen.',
    'call-not-placed': 'JustConnect could not start the call. Try again in a moment.',
  };
  if (byCode[e.code]) throw fail(e.code === 'call-not-placed' ? 'SERVER' : 'CONFLICT', byCode[e.code]);
  if (e.status === 404) throw fail('VALIDATION', 'Your CRM user is not linked to a JustConnect agent. Ask your administrator to link you under Settings › WhatsApp, AI & calls › JustConnect.');
  if (e.status === 401) throw fail('NOT_CONFIGURED', 'The JustConnect API key is wrong, revoked or expired. A super admin can paste a new one in the company settings.');
  if (e.status === 403) throw fail('FORBIDDEN', e.message || 'JustConnect refused: the key lacks calls:write or outgoing calls are not on your plan.');
  if (e.status === 429) throw fail('RATE_LIMIT', 'Too many JustConnect requests — wait a few seconds and try again.');
  if (e.status === 400) throw fail('VALIDATION', e.message);
  throw fail('SERVER', e.message);
}

/** Test the key: business name and whether every scope the CRM uses is ticked. */
export async function jcTest(): Promise<{ ok: boolean; message: string; business: string; scopes: string[]; missing: string[] }> {
  try {
    const r = await jc<{ ok: boolean; business?: { name?: string }; key?: { scopes?: string[]; prefix?: string } }>('/ping');
    const scopes = r.key?.scopes || [];
    const missing = NEEDED_SCOPES.filter((s) => !scopes.includes(s));
    const business = r.business?.name || '';
    return {
      ok: !!r.ok && missing.length === 0,
      business,
      scopes,
      missing,
      message: missing.length
        ? `Connected to ${business || 'JustConnect'}, but the key is missing: ${missing.join(', ')}. Make a new key with those ticked.`
        : `Connected to ${business || 'JustConnect'} (key ${r.key?.prefix || ''}).`,
    };
  } catch (e: any) {
    if (e instanceof JustConnectError) return { ok: false, business: '', scopes: [], missing: [], message: e.status === 401 ? 'The key is wrong, revoked or expired.' : e.message };
    throw e;
  }
}

async function agentsList(): Promise<JcAgent[]> {
  try {
    const r = await jc<{ items: JcAgent[] }>('/agents');
    return Array.isArray(r.items) ? r.items : [];
  } catch (e) {
    friendly(e);
  }
}

type UserDocJc = { _id: string; jcAgent?: string };
const usersCol = () => col<UserDocJc>(CFG.COLL.USERS);

/** The agent a CRM user calls through: their saved link (agent id; 'none' = not linked) or the agent with their e-mail. */
export function agentFor(user: Pick<PublicUser, 'email'>, saved: string | undefined, agents: JcAgent[]): JcAgent | null {
  if (saved === 'none') return null;
  if (saved) return agents.find((a) => a.id === saved) || null;
  const e = user.email.trim().toLowerCase();
  return agents.find((a) => (a.email || '').trim().toLowerCase() === e) || null;
}

/** Settings table: every active CRM user with the JustConnect agent they call through. */
export async function jcAgents(): Promise<{ agents: JcAgent[]; users: Array<{ id: string; name: string; email: string; role: string; link: string; agent: JcAgent | null; auto: boolean; mobile: string }> }> {
  const agents = await agentsList();
  const saved = new Map((await (await usersCol()).find({}, { projection: { jcAgent: 1 } }).toArray()).map((u) => [u._id, u.jcAgent || '']));
  const users = (await listUsers()).filter((u) => u.status !== 'Disabled' && u.role !== 'Viewer');
  return {
    agents,
    users: users.map((u) => {
      const link = saved.get(u.id) || '';
      return { id: u.id, name: u.name, email: u.email, role: u.role, link, agent: agentFor(u, link, agents), auto: !link, mobile: u.phone || '' };
    }),
  };
}

/** Link a CRM user to an agent: an agent id, '' (match by e-mail) or 'none' (never call through JustConnect). */
export async function jcSetAgent(d: { userId: string; agent: string }) {
  const userId = String(d?.userId || '');
  const agent = String(d?.agent ?? '').trim();
  if (!userId) throw fail('VALIDATION', 'Choose a user');
  if (agent && agent !== 'none' && !(await agentsList()).some((a) => a.id === agent)) throw fail('VALIDATION', 'That JustConnect agent does not exist any more — reload the list.');
  const r = await (await usersCol()).updateOne({ _id: userId }, agent ? { $set: { jcAgent: agent } } : { $unset: { jcAgent: '' } });
  if (!r.matchedCount) throw fail('NOT_FOUND', 'User not found');
  return jcAgents();
}

/**
 * Start a call to a lead (or a number). Two ways, chosen automatically:
 *  - app: the RM is signed in to the JustConnect app → click-to-call rings the app first;
 *  - mobile: otherwise (app signed out, or no JustConnect agent) a masked call rings the RM's own mobile — the number
 *    saved in the CRM (My profile / Team) — and then the customer. Either way the customer sees only the business number.
 */
export async function jcClickToCall(d: { leadId?: string; phone?: string }, ctx: Ctx): Promise<{ mode: 'app' | 'mobile'; requestId: string; status: string }> {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  let phone = String(d?.phone || '').trim();
  let label = '';
  const leadId = String(d?.leadId || '').trim();
  if (leadId) {
    await assertLeadAccess(ctx, leadId);
    const lead = await getLead(leadId);
    if (!lead) throw fail('NOT_FOUND', 'Lead not found');
    phone = phone || String(lead[L.PHONE] || '');
    label = String(lead[L.NAME] || '');
  }
  if (digits(phone).length < 10) throw fail('VALIDATION', 'This lead has no phone number to call.');
  const me = await (await usersCol()).findOne({ _id: ctx.user.id }, { projection: { jcAgent: 1, phone: 1 } as any }) as (UserDocJc & { phone?: string }) | null;
  const saved = me?.jcAgent || '';
  const myMobile = String(me?.phone || '').trim();
  if (saved === 'none') throw fail('VALIDATION', 'You are not set up to call through JustConnect. Use your phone instead, or ask your administrator.');

  const note = async (how: string) => {
    if (leadId) await addTimeline(leadId, 'call', 'Call started through JustConnect', `By ${ctx.user!.name} — ${how}`, ctx.user!.name);
  };

  // 1. the JustConnect app, when the RM is signed in to it
  let appError: JustConnectError | null = null;
  try {
    const r = await jc<{ request: { id: string; status: string } }>('/click-to-call', {
      method: 'POST',
      body: { agent: saved || ctx.user.email, to: phone, label: truncate(label || phone, 40), ref: leadId || undefined, ringSeconds: 30 },
    });
    await note('their JustConnect app rings first');
    return { mode: 'app', requestId: r.request.id, status: r.request.status };
  } catch (e) {
    if (!(e instanceof JustConnectError)) throw e;
    // app signed out, or this user has no JustConnect agent → ring their own mobile instead
    if (!(e.code === 'agent-offline' || e.status === 404)) friendly(e);
    appError = e;
  }

  // 2. a masked call to the RM's own mobile
  if (!myMobile) {
    throw fail('VALIDATION', appError?.code === 'agent-offline'
      ? 'Your JustConnect app is not signed in, and no mobile number is saved for you. Add your mobile number in My profile (Settings › My profile) and the CRM will ring your phone instead.'
      : 'Add your mobile number in My profile (Settings › My profile) — the CRM rings it first and then connects you to the customer.', { fallback: 'dial' });
  }
  try {
    const r = await jc<{ call: { id: string; status: string } }>('/calls/bridge', {
      method: 'POST',
      body: {
        from: myMobile, to: phone, record: true, ref: leadId || undefined, maxMinutes: 60, ringSeconds: 30,
        whisper: truncate(`Connecting you to ${label || 'the customer'}${leadId ? ', from the CRM' : ''}.`, 300),
        fromLabel: truncate(ctx.user.name, 60), toLabel: truncate(label || phone, 60),
      },
    });
    await note('their mobile rings first');
    return { mode: 'mobile', requestId: r.call.id, status: r.call.status };
  } catch (e) {
    friendly(e);
  }
}

/** How far a call got (the screen asks every few seconds until it settles). Both ways map onto the same statuses. */
export async function jcCallStatus(d: { id: string; mode?: string }) {
  const id = String(d?.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw fail('VALIDATION', 'Invalid call request');
  try {
    if (d?.mode === 'mobile') {
      const r = await jc<{ call: { status: string; result?: { connected?: boolean } | null; legs?: Array<{ n: number; status: string }> } }>(`/calls/${id}`);
      const first = (r.call.legs || []).find((l) => l.n === 0);
      // the RM's mobile is leg 0: once it answered, the customer is being rung
      const status = r.call.status === 'failed' ? 'failed'
        : r.call.status === 'unanswered' || first?.status === 'no_answer' || first?.status === 'busy' ? 'agent-did-not-answer'
        : first && ['answered', 'done'].includes(first.status) ? 'agent-answered'
        : r.call.status === 'completed' ? 'agent-answered'
        : 'ringing-agent';
      return { status, callStatus: r.call.result?.connected ? 'answered' : r.call.status, talkSeconds: 0 };
    }
    const r = await jc<{ request: { status: string; call?: { status?: string; talkSeconds?: number } | null } }>(`/click-to-call/${id}`);
    return { status: r.request.status, callStatus: r.request.call?.status || '', talkSeconds: r.request.call?.talkSeconds || 0 };
  } catch (e) {
    friendly(e);
  }
}

let lastSync = new Map<string, number>();
/** "Sync now" / opening Call History: pull new calls from JustConnect (at most every 20 seconds per company). */
export async function jcSyncCalls() {
  const { syncJcCalls } = await import('./jcCalls'); // lazy: jcCalls imports this module
  const { tenantKey } = await import('../core/tenant');
  const k = tenantKey('jc-sync');
  const prev = lastSync.get(k) || 0;
  if (Date.now() - prev < 20_000) return { saved: 0, created: 0, finished: 0, skipped: 'just synced' };
  lastSync.set(k, Date.now());
  try {
    return await syncJcCalls({ deadline: Date.now() + 40_000 });
  } catch (e) {
    friendly(e);
  }
}

export const actions: ActionMap = {
  jcSyncCalls: { fn: () => jcSyncCalls(), perm: 'calls.view' },
  jcTest: { fn: () => jcTest(), perm: 'settings.view' },
  jcAgents: { fn: () => jcAgents(), perm: 'settings.view' },
  jcSetAgent: { fn: (d) => jcSetAgent(d), perm: 'settings.edit' },
  jcClickToCall: { fn: (d, ctx) => jcClickToCall(d, ctx), perm: 'calls.log' },
  jcCallStatus: { fn: (d) => jcCallStatus(d), perm: 'calls.view' },
};
