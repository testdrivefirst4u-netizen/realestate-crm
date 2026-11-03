/**
 * LinkedIn (plan feature linkedin): "Connect LinkedIn" in Settings › Social accounts, posts to the company page from
 * the post scheduler, and Lead Gen Form leads (a lead source of type 'linkedin', made when lead sync is switched on).
 * Platform app: Super admin › Settings › Marketing apps (Community Management API; Lead Sync API for leads).
 *
 * Connect = GET /api/integrations/linkedin/connect[?leads=1] → linkedin.com/oauth/v2/authorization (organization admin
 *           and social scopes; with leads=1 also r_ads + r_marketing_leadgen_automation) →
 *           GET /api/integrations/linkedin/callback → tokens (encrypted) in `integrations` { _id: 'linkedin' }, with
 *           the pages the person administers and the ad accounts (for leads).
 * Posts   = POST /rest/posts as the organization (an image is uploaded first with /rest/images?action=initializeUpload).
 * Leads   = every 10 minutes GET /rest/leadFormResponses for the chosen ad account since the last check; each answer is
 *           mapped with its form's questions (predefined fields → CRM fields) and ingested once (key li:<response id>).
 */
import type { ActionMap } from '../core/actions';
import { auditLog, type Ctx } from '../core/auth';
import { CFG } from '../core/config';
import { col, nextSeq } from '../core/db';
import { ApiError, fail } from '../core/errors';
import { appUrl, decryptSecret, encryptSecret } from '../core/settings';
import { requireTenant, runWithTenant } from '../core/tenant';
import { truncate } from '../core/utils';
import { listActiveTenants } from '../platform/registry';
import { LINKEDIN_CALLBACK_PATH, loadMarketingApps } from '../platform/marketingApps';
import { ingestLead, sourcesCol, type SourceDoc } from './intake';
import { defaultConfig, toSource } from './leadSources';
import { beginSocialOAuth, endSocialOAuth, socialSettingsRedirect } from './socialOAuth';

const API = 'https://api.linkedin.com/rest';
const PURPOSE = 'linkedin';
const BASE_SCOPES = ['r_organization_admin', 'w_organization_social', 'r_organization_social'];
const LEAD_SCOPES = ['r_ads', 'r_marketing_leadgen_automation'];

interface LinkedInDoc {
  _id: 'linkedin';
  token: string; // encrypted
  refresh: string; // encrypted ('' when LinkedIn gave none)
  expiresAt: Date | null;
  scopes: string[];
  orgs: Array<{ urn: string; name: string }>;
  orgUrn: string;
  adAccounts: Array<{ urn: string; name: string }>;
  leadAccount: string;
  leadsSince?: Date | null;
  leadsError?: string;
  sourceId?: string;
  updatedAt?: Date;
  updatedBy?: string;
}
const docCol = () => col<LinkedInDoc>(CFG.COLL.INTEGRATIONS);
const loadDoc = async () => (await docCol()).findOne({ _id: 'linkedin' });
const redirectUri = () => `${appUrl()}${LINKEDIN_CALLBACK_PATH}`;

async function tokenCall(body: Record<string, string>): Promise<any> {
  const apps = await loadMarketingApps();
  if (!apps.linkedinClientId || !apps.linkedinClientSecret) throw fail('NOT_CONFIGURED', 'LinkedIn is not set up on this platform yet (Super admin › Settings › Marketing apps).');
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({ ...body, client_id: apps.linkedinClientId, client_secret: apps.linkedinClientSecret }).toString(),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.access_token) throw fail('VALIDATION', truncate(`LinkedIn: ${j?.error_description || j?.error || `answered ${res.status}`}`, 300));
  return j;
}

async function accessToken(): Promise<string> {
  const d = await loadDoc();
  if (!d?.token) throw fail('VALIDATION', 'Connect LinkedIn first (Settings › Social accounts).');
  if (!d.expiresAt || d.expiresAt.getTime() - 10 * 60000 > Date.now()) return decryptSecret(d.token);
  const refresh = d.refresh ? decryptSecret(d.refresh) : '';
  if (!refresh) throw fail('VALIDATION', 'The LinkedIn connection expired. Connect LinkedIn again (Settings › Social accounts).');
  const j = await tokenCall({ grant_type: 'refresh_token', refresh_token: refresh });
  await (await docCol()).updateOne({ _id: 'linkedin' }, { $set: { token: encryptSecret(j.access_token), ...(j.refresh_token ? { refresh: encryptSecret(j.refresh_token) } : {}), expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null } });
  return j.access_token;
}

/** One LinkedIn REST call (versioned API). Returns the JSON body and the created entity's id header. */
export async function li<T = any>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ data: T; id: string }> {
  const apps = await loadMarketingApps();
  const token = init.token || (await accessToken());
  const res = await fetch(path.startsWith('http') ? path : `${API}/${path.replace(/^\/+/, '')}`, {
    method: init.method || (init.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, 'LinkedIn-Version': apps.linkedinVersion, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text().catch(() => '');
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'VALIDATION' : 'SERVER', truncate(`LinkedIn: ${j?.message || `answered ${res.status}`}`, 300));
  return { data: j as T, id: res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || '' };
}

/* -------------------------------- connect -------------------------------- */

export async function startLinkedInConnect(input: { sessionCookie: string; nowMs?: number; leads?: boolean }): Promise<{ redirect: string; nonce?: string }> {
  const b = await beginSocialOAuth(input, PURPOSE, 'linkedin', 'LinkedIn', 'linkedinError');
  if ('redirect' in b) return { redirect: b.redirect };
  const apps = await loadMarketingApps();
  if (!apps.linkedinClientId || !apps.linkedinClientSecret) return { redirect: socialSettingsRedirect({ linkedinError: 'LinkedIn is not set up on this platform yet. Ask your platform administrator.' }) };
  const scope = [...BASE_SCOPES, ...(input.leads ? LEAD_SCOPES : [])].join(' ');
  const q = new URLSearchParams({ response_type: 'code', client_id: apps.linkedinClientId, redirect_uri: redirectUri(), state: b.state, scope });
  return { redirect: `https://www.linkedin.com/oauth/v2/authorization?${q.toString()}`, nonce: b.nonce };
}

const orgId = (urn: string) => String(urn).split(':').pop() || '';

export async function finishLinkedInConnect(input: { params: URLSearchParams; sessionCookie: string; nonceCookie: string; nowMs?: number }): Promise<{ redirect: string }> {
  const e = await endSocialOAuth(input, PURPOSE, 'linkedin', 'LinkedIn', 'linkedinError');
  if ('redirect' in e) return { redirect: e.redirect };
  try {
    const names = await runWithTenant(e.tenant, async () => {
      const j = await tokenCall({ grant_type: 'authorization_code', code: e.code, redirect_uri: redirectUri() });
      const token = String(j.access_token);
      const scopes = String(j.scope || '').split(/[\s,]+/).filter(Boolean);
      const acl = await li<{ elements?: Array<{ organization?: string }> }>('organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED', { token });
      const orgs: Array<{ urn: string; name: string }> = [];
      for (const el of (acl.data.elements || []).slice(0, 20)) {
        const urn = String(el.organization || '');
        if (!urn) continue;
        const o = await li<{ localizedName?: string }>(`organizations/${orgId(urn)}`, { token }).catch(() => ({ data: { localizedName: '' }, id: '' }));
        orgs.push({ urn, name: truncate(String(o.data.localizedName || urn), 120) });
      }
      if (!orgs.length) throw fail('VALIDATION', 'LinkedIn says this account is not an admin of any company page. Sign in with a page admin.');
      let adAccounts: Array<{ urn: string; name: string }> = [];
      if (scopes.includes('r_ads') || scopes.includes('r_marketing_leadgen_automation')) {
        const a = await li<{ elements?: Array<{ id?: number; name?: string }> }>('adAccounts?q=search&search=(status:(values:List(ACTIVE)))', { token }).catch(() => ({ data: { elements: [] }, id: '' }));
        adAccounts = (a.data.elements || []).filter((x) => x.id).map((x) => ({ urn: `urn:li:sponsoredAccount:${x.id}`, name: truncate(String(x.name || x.id), 120) }));
      }
      const cur = await loadDoc();
      await (await docCol()).updateOne({ _id: 'linkedin' }, { $set: {
        token: encryptSecret(token), refresh: j.refresh_token ? encryptSecret(j.refresh_token) : '', expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null, scopes,
        orgs, orgUrn: orgs.some((o) => o.urn === cur?.orgUrn) ? cur!.orgUrn : orgs.length === 1 ? orgs[0].urn : '',
        adAccounts, leadAccount: adAccounts.some((a) => a.urn === cur?.leadAccount) ? cur!.leadAccount : '', leadsError: '', updatedAt: new Date(), updatedBy: e.user.name,
      } }, { upsert: true });
      await auditLog({ user: e.user } as Ctx, 'LinkedIn Connected', 'Settings', 'linkedin', orgs.map((o) => o.name).join(', '));
      return orgs.map((o) => o.name).join(', ');
    });
    return { redirect: socialSettingsRedirect({ linkedinConnected: truncate(names, 200) }) };
  } catch (err: any) {
    if (!(err instanceof ApiError)) console.error('[linkedin:callback]', err?.message);
    return { redirect: socialSettingsRedirect({ linkedinError: truncate(err?.message || 'Could not connect LinkedIn.', 300) }) };
  }
}

/* ---------------------------------- posts --------------------------------- */

/** Post to the chosen company page: text, with an image (bytes) or a link. */
export async function postToLinkedIn(p: { text: string; image?: { data: Buffer; mime: string } | null; link?: string }): Promise<{ id: string; url: string }> {
  const d = await loadDoc();
  if (!d?.orgUrn) throw fail('VALIDATION', 'Choose the LinkedIn company page first (Settings › Social accounts).');
  let content: Record<string, unknown> | undefined;
  if (p.image) {
    const init = await li<{ value?: { uploadUrl?: string; image?: string } }>('images?action=initializeUpload', { body: { initializeUploadRequest: { owner: d.orgUrn } } });
    const up = init.data.value;
    if (!up?.uploadUrl || !up.image) throw fail('SERVER', 'LinkedIn did not accept the image upload.');
    const put = await fetch(up.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': p.image.mime }, body: new Uint8Array(p.image.data), signal: AbortSignal.timeout(60000) });
    if (!put.ok) throw fail('SERVER', `LinkedIn image upload failed (${put.status}).`);
    content = { media: { id: up.image } };
  } else if (p.link) {
    content = { article: { source: p.link, title: truncate(p.text.split('\n')[0] || p.link, 200) } };
  }
  const r = await li('posts', { body: {
    author: d.orgUrn, commentary: truncate(p.text, 3000), visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    ...(content ? { content } : {}), lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
  } });
  return { id: r.id, url: r.id ? `https://www.linkedin.com/feed/update/${encodeURIComponent(r.id)}/` : '' };
}

/* ---------------------------------- leads --------------------------------- */

const FIELD: Record<string, string> = {
  FIRST_NAME: 'first_name', LAST_NAME: 'last_name', EMAIL: 'email', WORK_EMAIL: 'email', PHONE_NUMBER: 'phone', WORK_PHONE: 'phone',
  CITY: 'city', STATE: 'state', COUNTRY: 'country', COMPANY_NAME: 'Company', JOB_TITLE: 'Job title', POSTAL_CODE: 'Postal code',
};
const formCache = new Map<string, Array<{ id: string; field: string; label: string }>>();

async function formQuestions(formUrn: string): Promise<Array<{ id: string; field: string; label: string }>> {
  const m = String(formUrn).match(/leadGenForm:(\d+)/);
  if (!m) return [];
  if (formCache.has(m[1])) return formCache.get(m[1])!;
  const r = await li<{ content?: { questions?: any[] } }>(`leadForms/${m[1]}`).catch(() => ({ data: { content: { questions: [] } }, id: '' }));
  const qs = (r.data.content?.questions || []).map((q: any) => ({ id: String(q.questionId ?? ''), field: String(q.predefinedField || ''), label: String(q.question?.localized?.en_US || q.name || q.predefinedField || '') }));
  formCache.set(m[1], qs);
  return qs;
}

/** One LinkedIn lead form response → intake fields. */
export function mapLinkedInAnswers(answers: any[], questions: Array<{ id: string; field: string; label: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of answers || []) {
    const q = questions.find((x) => x.id === String(a?.questionId ?? ''));
    const det = a?.answerDetails || {};
    const value = String(det.textQuestionAnswer?.answer ?? (Array.isArray(det.multipleChoiceAnswer?.options) ? det.multipleChoiceAnswer.options.join(', ') : '') ?? '').trim();
    if (!value) continue;
    const key = (q && FIELD[q.field]) || q?.label || `Question ${a?.questionId}`;
    out[key] = out[key] && key !== 'email' && key !== 'phone' ? `${out[key]}, ${value}` : out[key] || value;
  }
  return out;
}

async function leadSource(): Promise<SourceDoc> {
  const d = await loadDoc();
  const src = await (await sourcesCol()).findOne(d?.sourceId ? { _id: d.sourceId } : { type: 'linkedin' });
  if (src) return { ...src, config: toSource(src).config };
  const doc: SourceDoc = {
    _id: await nextSeq('SRC', 4), type: 'linkedin', name: 'LinkedIn Lead Gen Forms', status: 'Active', keyPrefix: '', config: defaultConfig('linkedin'),
    stats: { received: 0, created: 0, duplicates: 0, rejected: 0, failed: 0, lastReceivedAt: null, lastError: '' }, createdAt: new Date(), createdBy: 'LinkedIn', updatedAt: new Date(),
  };
  await (await sourcesCol()).insertOne(doc);
  await (await docCol()).updateOne({ _id: 'linkedin' }, { $set: { sourceId: doc._id } });
  return { ...doc, config: toSource(doc).config };
}

/** New lead form responses of the chosen ad account since the last check (≤ 7 days back the first time). */
export async function syncLinkedInLeads(now = new Date()): Promise<{ received: number; created: number }> {
  const d = await loadDoc();
  if (!d?.leadAccount) return { received: 0, created: 0 };
  const since = d.leadsSince ? d.leadsSince.getTime() - 5 * 60000 : now.getTime() - 7 * 86400000;
  const owner = `(sponsoredAccount:${encodeURIComponent(d.leadAccount)})`;
  let received = 0, created = 0;
  try {
    const source = await leadSource();
    let start = 0;
    for (let page = 0; page < 10; page++) {
      const r = await li<{ elements?: any[]; paging?: { total?: number } }>(`leadFormResponses?q=owner&owner=${owner}&leadType=(leadType:SPONSORED)&limitedToTestLeads=false&submittedAtTimeRange=(start:${since},end:${now.getTime()})&start=${start}&count=50`);
      const els = r.data.elements || [];
      for (const el of els) {
        received++;
        const qs = await formQuestions(String(el.versionedLeadGenFormUrn || el.leadGenFormUrn || ''));
        const fields = mapLinkedInAnswers(el.formResponse?.answers || [], qs);
        const res = await ingestLead(source, fields, { origin: 'linkedin', idempotencyKey: `li:${el.id || el.leadGenFormResponseUrn || ''}` });
        if (res.status === 'created' && !res.replay) created++;
      }
      start += els.length;
      if (els.length < 50) break;
    }
    await (await docCol()).updateOne({ _id: 'linkedin' }, { $set: { leadsSince: now, leadsError: '' } });
  } catch (e: any) {
    await (await docCol()).updateOne({ _id: 'linkedin' }, { $set: { leadsError: truncate(e?.message || String(e), 300) } });
    throw e;
  }
  return { received, created };
}

export async function runLinkedInCron(now = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tenant of await listActiveTenants()) {
    if (!tenant.features.linkedin) continue;
    try {
      const r = await runWithTenant(tenant, () => syncLinkedInLeads(now));
      if (r.received) out[tenant.slug] = r;
    } catch (e: any) {
      out[tenant.slug] = { error: truncate(e?.message || String(e), 200) };
    }
  }
  return out;
}

/* -------------------------------- settings -------------------------------- */

export interface LinkedInView {
  available: boolean;
  connected: boolean;
  leadAccess: boolean;
  orgs: Array<{ urn: string; name: string }>;
  orgUrn: string;
  adAccounts: Array<{ urn: string; name: string }>;
  leadAccount: string;
  leadsSince: string;
  leadsError: string;
  expiresAt: string;
  connectUrl: string;
}

export async function getLinkedIn(): Promise<LinkedInView> {
  const [d, apps] = await Promise.all([loadDoc(), loadMarketingApps()]);
  return {
    available: !!(apps.linkedinClientId && apps.linkedinClientSecret), connected: !!d?.token, leadAccess: !!d?.scopes?.includes('r_marketing_leadgen_automation'),
    orgs: d?.orgs || [], orgUrn: d?.orgUrn || '', adAccounts: d?.adAccounts || [], leadAccount: d?.leadAccount || '',
    leadsSince: d?.leadsSince ? d.leadsSince.toISOString() : '', leadsError: d?.leadsError || '', expiresAt: d?.expiresAt && !d.refresh ? d.expiresAt.toISOString() : '',
    connectUrl: '/api/integrations/linkedin/connect',
  };
}

export async function saveLinkedIn(input: any, ctx: Ctx): Promise<LinkedInView> {
  const d = await loadDoc();
  if (!d) throw fail('VALIDATION', 'Connect LinkedIn first.');
  const set: Partial<LinkedInDoc> = {};
  if (input?.orgUrn !== undefined) {
    if (input.orgUrn && !d.orgs.some((o) => o.urn === input.orgUrn)) throw fail('VALIDATION', 'Choose one of your LinkedIn pages.');
    set.orgUrn = String(input.orgUrn || '');
  }
  if (input?.leadAccount !== undefined) {
    if (input.leadAccount && !d.adAccounts.some((a) => a.urn === input.leadAccount)) throw fail('VALIDATION', 'Choose one of your LinkedIn ad accounts.');
    set.leadAccount = String(input.leadAccount || '');
    if (set.leadAccount && set.leadAccount !== d.leadAccount) set.leadsSince = null;
  }
  await (await docCol()).updateOne({ _id: 'linkedin' }, { $set: { ...set, updatedAt: new Date(), updatedBy: ctx.user?.name || 'System' } });
  if (set.leadAccount) await leadSource();
  return getLinkedIn();
}

export async function disconnectLinkedIn(ctx: Ctx): Promise<LinkedInView> {
  requireTenant();
  await (await docCol()).updateOne({ _id: 'linkedin' }, { $set: { token: '', refresh: '', orgs: [], adAccounts: [], leadAccount: '', updatedAt: new Date() } });
  await auditLog(ctx, 'LinkedIn Disconnected', 'Settings', 'linkedin', '');
  return getLinkedIn();
}

export const actions: ActionMap = {
  getLinkedIn: { fn: () => getLinkedIn(), perm: 'integrations.connect' },
  saveLinkedIn: { fn: (d, ctx) => saveLinkedIn(d, ctx), perm: 'integrations.connect' },
  disconnectLinkedIn: { fn: (_d, ctx) => disconnectLinkedIn(ctx), perm: 'integrations.connect' },
  syncLinkedInLeads: { fn: async () => syncLinkedInLeads(), perm: 'integrations.connect' },
};
