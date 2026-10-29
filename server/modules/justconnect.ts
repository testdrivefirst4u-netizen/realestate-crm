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
import { assertPhoneAccess } from '../core/scopeGuards';
import { digits, truncate } from '../core/utils';
import { jc, JustConnectError, type JcAgent } from '../integrations/justconnect';
import { getLead } from './leads';

const L = CFG.LEAD;
const NEEDED_SCOPES = ['calls:read', 'calls:write', 'contacts:read', 'contacts:write', 'reports:read'];
/** Optional: the live call buttons (end, transfer, mute, status) and the phone inside the CRM. */
const PHONE_SCOPES = ['calls:control', 'phones:connect'];

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
    const phoneMissing = PHONE_SCOPES.filter((s) => !scopes.includes(s));
    const business = r.business?.name || '';
    const phoneNote = phoneMissing.length ? ` For the phone inside the CRM and the live call buttons, also tick ${phoneMissing.join(' and ')} (Change on the key's row).` : '';
    return {
      ok: !!r.ok && missing.length === 0,
      business,
      scopes,
      missing,
      message: (missing.length
        ? `Connected to ${business || 'JustConnect'}, but the key is missing: ${missing.join(', ')}. Make a new key with those ticked.`
        : `Connected to ${business || 'JustConnect'} (key ${r.key?.prefix || ''}).`) + phoneNote,
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
  } else if (phone) await assertPhoneAccess(ctx, phone); // a typed number of another RM's lead is refused like that lead
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
      const ended = ['completed', 'failed', 'unanswered', 'cancelled', 'canceled', 'busy', 'no_answer'].includes(r.call.status);
      return { status, callStatus: r.call.result?.connected ? 'answered' : r.call.status, talkSeconds: 0, connected: !!r.call.result?.connected, ended };
    }
    const r = await jc<{ request: { status: string; call?: { status?: string; talkSeconds?: number } | null } }>(`/click-to-call/${id}`);
    const callStatus = r.request.call?.status || '';
    const ended = ['agent-did-not-answer', 'failed'].includes(r.request.status) || (!!callStatus && callStatus !== 'in-progress');
    return { status: r.request.status, callStatus, talkSeconds: r.request.call?.talkSeconds || 0, connected: callStatus === 'answered', ended };
  } catch (e) {
    friendly(e);
  }
}

/* ------------------------- live call buttons and the phone inside the CRM ------------------------- */

/** The JustConnect agent the signed-in user is: their saved link, else their e-mail (JustConnect accepts either). */
async function myAgentRef(ctx: Ctx): Promise<string> {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const me = await (await usersCol()).findOne({ _id: ctx.user.id }, { projection: { jcAgent: 1 } });
  if (me?.jcAgent === 'none') throw fail('VALIDATION', 'You are not set up to call through JustConnect. Ask your administrator to link you to a JustConnect agent.');
  return me?.jcAgent || ctx.user.email;
}

/** calls:control / phones:connect refusals → messages an RM can act on. */
function friendlyControl(e: unknown, scope: string): never {
  if (!(e instanceof JustConnectError)) throw e;
  const byCode: Record<string, [string, string]> = {
    'call-ended': ['CONFLICT', 'This call has already ended.'],
    'call-not-answered': ['CONFLICT', 'Nobody has answered yet, so there is nobody to hand on or mute.'],
    'call-not-controllable': ['CONFLICT', 'This call cannot be changed from the CRM (a call between colleagues, or with more than two people).'],
    'agent-offline': ['CONFLICT', 'That colleague is signed out of JustConnect, so the call cannot go to them.'],
    'agent-busy': ['CONFLICT', 'That colleague is on another call.'],
    'agent-unavailable': ['CONFLICT', 'That colleague is on a break.'],
    'agent-cannot-call-out': ['FORBIDDEN', 'Your JustConnect agent may not make outgoing calls, so the call cannot go to an outside number.'],
    'call-not-controlled': ['SERVER', 'JustConnect could not change the call. Try again in a moment.'],
    'status-not-set': ['SERVER', 'JustConnect could not set your status. Try again in a moment.'],
    'mute-unavailable': ['SERVER', 'Muting is unavailable right now. Mute on your phone instead.'],
  };
  const known = byCode[e.code];
  if (known) throw fail(known[0] as any, known[1]);
  if (e.status === 403) throw fail('FORBIDDEN', `JustConnect refused: the "Amaya CRM" key needs ${scope}. The JustConnect owner ticks it under Developer Panel › API Keys › Change.`);
  if (e.status === 404) throw fail('NOT_FOUND', 'JustConnect does not know this call or agent (any more).');
  friendly(e);
}

const callsCol = () => col<{ _id: string; provider?: string; providerCallId?: string; jcAgentUserId?: string; jcRingingUserIds?: string[]; status?: string; jcMuted?: boolean }>(CFG.COLL.CALLS);

/** End, transfer, mute or unmute one of the signed-in user's JustConnect calls (by the CRM call id). */
export async function jcCallControl(d: { callId: string; action: string; to?: string }, ctx: Ctx): Promise<{ ok: true; muted?: boolean; to?: string }> {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const action = String(d?.action || '');
  if (!['end', 'transfer', 'mute', 'unmute'].includes(action)) throw fail('VALIDATION', 'Unknown call button');
  const call = await (await callsCol()).findOne({ _id: String(d?.callId || ''), provider: 'JustConnect' });
  // only your own call: the one you took, or one ringing for you
  if (!call?.providerCallId || !(call.jcAgentUserId === ctx.user.id || (call.jcRingingUserIds || []).includes(ctx.user.id))) throw fail('NOT_FOUND', 'Call not found');
  if (call.status && call.status !== 'In Progress') throw fail('CONFLICT', 'This call has already ended.');
  const path = `/call-logs/${encodeURIComponent(call.providerCallId)}/${action}`;
  try {
    if (action === 'transfer') {
      const raw = String(d?.to || '').trim();
      if (!raw) throw fail('VALIDATION', 'Choose a colleague or type a number');
      // a colleague's extension / id, or a 10-digit number
      const to = /^[0-9+\s-]{10,}$/.test(raw) ? digits(raw).slice(-10) : raw;
      const r = await jc<{ to?: { type: string; name?: string; number?: string } }>(path, { method: 'POST', body: { to } });
      return { ok: true, to: r.to?.name || r.to?.number || to };
    }
    await jc(path, { method: 'POST' });
  } catch (e) {
    friendlyControl(e, 'calls:control');
  }
  if (action === 'mute' || action === 'unmute') {
    await (await callsCol()).updateOne({ _id: call._id }, { $set: { jcMuted: action === 'mute' } });
    return { ok: true, muted: action === 'mute' };
  }
  return { ok: true };
}

/** Colleagues a call can be handed to (with whether they can take it now). */
export async function jcTransferTargets(ctx: Ctx): Promise<Array<{ id: string; name: string; extension: string; status: string }>> {
  const ref = (await myAgentRef(ctx)).toLowerCase();
  const agents = await agentsList();
  return agents
    .filter((a) => ![a.id, a.email, a.extension, a.loginId].some((v) => String(v || '').toLowerCase() === ref))
    .map((a) => ({ id: a.id, name: a.name, extension: a.extension, status: a.status }));
}

const STATUSES = ['online', 'break', 'lunch', 'bio-break', 'offline'];

/** The signed-in user's JustConnect agent and whether they are taking calls. */
export async function jcMyStatus(ctx: Ctx): Promise<{ agent: { name: string; extension: string; status: string; canCallOut: boolean } | null }> {
  if (!ctx.user) throw fail('AUTH_REQUIRED', 'Please sign in');
  const me = await (await usersCol()).findOne({ _id: ctx.user.id }, { projection: { jcAgent: 1 } });
  const a = agentFor(ctx.user, me?.jcAgent, await agentsList());
  return { agent: a ? { name: a.name, extension: a.extension, status: a.status, canCallOut: !!a.canCallOut } : null };
}

/** Online / a break / offline — calls ring an agent only while they are online. */
export async function jcSetMyStatus(d: { status: string }, ctx: Ctx): Promise<{ status: string }> {
  const status = String(d?.status || '');
  if (!STATUSES.includes(status)) throw fail('VALIDATION', 'Choose online, a break or offline');
  const ref = await myAgentRef(ctx);
  try {
    const r = await jc<{ agent: { status: string } }>(`/agents/${encodeURIComponent(ref)}/status`, { method: 'PUT', body: { status } });
    return { status: r.agent?.status || status };
  } catch (e) {
    friendlyControl(e, 'calls:control');
  }
}

export interface JcPhoneLogin {
  websocketUrl: string;
  uri: string;
  username: string;
  password: string;
  domain: string;
  displayName: string;
  extension: string;
  callerIds: Array<{ number: string; label: string }>;
}

/**
 * The signed-in user's own JustConnect phone login, for the phone inside the CRM (JsSIP in their browser). Only ever
 * their own agent's; the API key itself stays on the server. The socket must be JustConnect's (wss://…justconnect.biz).
 */
export async function jcMyPhone(ctx: Ctx): Promise<JcPhoneLogin> {
  const ref = await myAgentRef(ctx);
  let p: any;
  try {
    p = (await jc<{ phone: any }>(`/agents/${encodeURIComponent(ref)}/phone`)).phone;
  } catch (e) {
    if (e instanceof JustConnectError && e.status === 404) throw fail('VALIDATION', 'Your CRM user is not linked to a JustConnect agent. Ask your administrator to link you under Settings › WhatsApp, AI & calls › JustConnect.');
    friendlyControl(e, 'phones:connect');
  }
  let host = '';
  try {
    const u = new URL(String(p?.websocketUrl || ''));
    if (u.protocol === 'wss:') host = u.hostname;
  } catch { /* checked below */ }
  if (!host || !(host === 'justconnect.biz' || host.endsWith('.justconnect.biz')) || !p?.uri || !p?.password) throw fail('SERVER', 'JustConnect sent a phone login the CRM cannot use. Try again, or raise a ticket with JustConnect.');
  return {
    websocketUrl: String(p.websocketUrl),
    uri: String(p.uri),
    username: String(p.username || ''),
    password: String(p.password),
    domain: String(p.domain || host),
    displayName: String(p.displayName || ctx.user!.name),
    extension: String(p.agent?.extension || ''),
    callerIds: Array.isArray(p.callerIds) ? p.callerIds.map((c: any) => ({ number: String(c.number || ''), label: String(c.label || '') })) : [],
  };
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
  jcMyCall: { fn: async (d, ctx) => (await import('./jcCalls')).jcMyCall(d, ctx), perm: 'calls.view' },
  jcCallControl: { fn: (d, ctx) => jcCallControl(d, ctx), perm: 'calls.log' },
  jcTransferTargets: { fn: (_d, ctx) => jcTransferTargets(ctx), perm: 'calls.log' },
  jcMyStatus: { fn: (_d, ctx) => jcMyStatus(ctx), perm: 'calls.view' },
  jcSetMyStatus: { fn: (d, ctx) => jcSetMyStatus(d, ctx), perm: 'calls.log' },
  jcMyPhone: { fn: (_d, ctx) => jcMyPhone(ctx), perm: 'calls.log' },
};
