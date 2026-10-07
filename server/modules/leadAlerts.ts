/**
 * Instant lead alerts (company setting `leadAlerts`, Settings › Lead alerts).
 *
 * When a lead is created (any source: CRM, website form, webhook, Google Sheet, Meta, WhatsApp) or reassigned:
 *   - e-mail the assigned RM (matched by name to an active CRM user) and any extra CRM users listed;
 *   - for a new lead only, send a WhatsApp template through Chat360 as an automatic first reply.
 * Runs after the response is sent (next/server `after`), so creating a lead never waits for or fails because of
 * an alert; problems go to the error log and the lead timeline. Bulk imports do not alert.
 */
import nodemailer from 'nodemailer';
import { after } from 'next/server';
import { listUsers, SYSTEM_CTX, type Ctx, type PublicUser } from '../core/auth';
import { CFG } from '../core/config';
import { fail } from '../core/errors';
import { addTimeline, logError } from '../core/events';
import { appUrl, getSecret, settingsAll } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { safeJsonParse, truncate } from '../core/utils';

const L = CFG.LEAD;

export interface LeadAlertConfig {
  /** E-mail the assigned RM. */
  emailRm: boolean;
  /** Extra recipients (comma-separated e-mails of active CRM users), e.g. the sales manager. */
  emailAlso: string;
  /** Send a WhatsApp template to every new lead that has a phone number. */
  whatsappAuto: boolean;
  /** Approved Chat360 / WhatsApp template name. */
  whatsappTemplate: string;
  whatsappLanguage: string;
  /** Template parameters, comma-separated; tokens: {name} {first_name} {company} {unit} {rm} {source}. */
  whatsappParams: string;
}

export const LEAD_ALERT_DEFAULTS: LeadAlertConfig = {
  emailRm: true,
  emailAlso: '',
  whatsappAuto: false,
  whatsappTemplate: '',
  whatsappLanguage: 'en',
  whatsappParams: '{first_name}',
};

export function parseLeadAlerts(raw: unknown): LeadAlertConfig {
  const o = (typeof raw === 'string' ? safeJsonParse<Record<string, unknown>>(raw, {}) : raw) as Record<string, unknown> | null;
  const s = (k: keyof LeadAlertConfig) => String(o?.[k] ?? LEAD_ALERT_DEFAULTS[k]).trim();
  return {
    emailRm: o?.emailRm === undefined ? LEAD_ALERT_DEFAULTS.emailRm : o.emailRm === true || o.emailRm === 'true',
    emailAlso: s('emailAlso'),
    whatsappAuto: o?.whatsappAuto === true || o?.whatsappAuto === 'true',
    whatsappTemplate: s('whatsappTemplate'),
    whatsappLanguage: s('whatsappLanguage') || 'en',
    whatsappParams: s('whatsappParams'),
  };
}

const EMAIL_LIST = (s: string) => s.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const TOKEN = /\{(name|first_name|company|unit|rm|source)\}/g;

/** Validate a settings patch; returns the normalised JSON string to store. */
export async function validateLeadAlerts(raw: unknown): Promise<string> {
  const c = parseLeadAlerts(raw);
  const active = new Set((await listUsers()).filter((u) => u.status !== 'Disabled').map((u) => u.email.toLowerCase()));
  for (const e of EMAIL_LIST(c.emailAlso)) {
    if (!active.has(e)) throw fail('VALIDATION', `Alert recipients must be active CRM users (${e} is not)`);
  }
  if (c.whatsappAuto && !/^[a-z0-9_]{1,100}$/.test(c.whatsappTemplate)) {
    throw fail('VALIDATION', 'Enter the approved WhatsApp template name (lower-case letters, digits and _)');
  }
  if (!/^[a-zA-Z]{2,3}([_-][a-zA-Z]{2})?$/.test(c.whatsappLanguage)) throw fail('VALIDATION', 'Template language must be a code such as en or en_US');
  const params = c.whatsappParams ? c.whatsappParams.split(',') : [];
  if (params.length > 10 || params.some((p) => p.trim().length > 200)) throw fail('VALIDATION', 'Use at most 10 template parameters of up to 200 characters');
  return JSON.stringify({ ...c, emailAlso: EMAIL_LIST(c.emailAlso).join(', ') });
}

/** Template parameters for a lead ({tokens} replaced; unknown text kept). */
export function renderParams(spec: string, lead: Record<string, string>, company: string): string[] {
  const name = String(lead[L.NAME] || '').trim();
  const values: Record<string, string> = {
    name, first_name: name.split(/\s+/)[0] || name, company, unit: lead[L.UNIT_TYPE] || '', rm: lead[L.RM] || '', source: lead[L.SOURCE] || '',
  };
  return (spec ? spec.split(',') : []).map((p) => truncate(p.trim().replace(TOKEN, (_, k) => values[k] || ''), 200));
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** E-mail addresses to alert for this lead (assigned RM + extra recipients), de-duplicated. */
export function alertRecipients(cfg: LeadAlertConfig, rm: string, users: PublicUser[]): string[] {
  const out = new Set<string>();
  if (cfg.emailRm && rm.trim()) {
    const u = users.find((x) => x.status !== 'Disabled' && sameName(x.name, rm));
    if (u?.email) out.add(u.email.toLowerCase());
  }
  const active = new Set(users.filter((u) => u.status !== 'Disabled').map((u) => u.email.toLowerCase()));
  for (const e of EMAIL_LIST(cfg.emailAlso)) if (active.has(e)) out.add(e);
  return [...out];
}

export function alertEmail(lead: Record<string, string>, kind: 'created' | 'assigned', link: string, company: string) {
  const name = lead[L.NAME] || 'Lead';
  const subject = kind === 'created'
    ? `New lead: ${name}${lead[L.SOURCE] ? ` · ${lead[L.SOURCE]}` : ''}`
    : `Lead assigned to you: ${name}`;
  const rows: Array<[string, string]> = [
    ['Name', name], ['Phone', lead[L.PHONE] || ''], ['E-mail', lead[L.EMAIL] || ''], ['Interested in', lead[L.UNIT_TYPE] || ''],
    ['Source', lead[L.SOURCE] || ''], ['Stage', lead[L.STAGE] || ''], ['Assigned RM', lead[L.RM] || 'Unassigned'],
  ];
  const notes = truncate(String(lead[L.NOTES] || ''), 600);
  const text = [
    `${kind === 'created' ? 'A new lead has arrived' : 'A lead has been assigned to you'}${company ? ` in ${company}` : ''}. Reply quickly — the first few minutes matter.`,
    '',
    ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    ...(notes ? ['', 'Notes:', notes] : []),
    '',
    `Open the lead: ${link}`,
  ].join('\n');
  return { subject: truncate(subject, 200), text };
}

/** Send the alerts for one lead now (inside the lead's company). Never throws. */
export async function sendLeadAlerts(lead: Record<string, string>, kind: 'created' | 'assigned'): Promise<{ emailed: number; whatsapp: boolean }> {
  const result = { emailed: 0, whatsapp: false };
  const id = lead[L.ID];
  try {
    const cfg = parseLeadAlerts((await settingsAll()).leadAlerts);
    const tenant = currentTenant();
    const company = tenant?.name || '';

    // 1. e-mail
    const smtp = process.env.SMTP_URL?.trim();
    const from = process.env.MAIL_FROM?.trim();
    if (smtp && from && (cfg.emailRm || cfg.emailAlso)) {
      const to = alertRecipients(cfg, String(lead[L.RM] || ''), await listUsers());
      if (to.length) {
        try {
          const { subject, text } = alertEmail(lead, kind, `${appUrl()}/leads?lead=${encodeURIComponent(id)}`, company);
          await nodemailer.createTransport(smtp).sendMail({ from, to: to.join(', '), subject, text });
          result.emailed = to.length;
          await addTimeline(id, 'alert_sent', 'Lead alert e-mailed', to.join(', '), 'System');
        } catch (e: any) {
          await logError('leadAlerts.email', 'UPSTREAM', e?.message, e?.stack, '', { leadId: id });
        }
      }
    }

    // 2. automatic WhatsApp first reply (new leads only; plan feature chat360 + a configured Chat360 key)
    const planAllows = !tenant || tenant.features.chat360;
    if (kind === 'created' && cfg.whatsappAuto && cfg.whatsappTemplate && planAllows && lead[L.PHONE] && (await getSecret('CHAT360_API_KEY'))) {
      try {
        const { send } = await import('./chat360'); // lazy: chat360 imports leads, which imports this module
        const ctx: Ctx = { ...SYSTEM_CTX, user: { ...SYSTEM_CTX.user!, name: 'Auto-reply' }, action: 'leadAlerts' };
        await send({ phone: lead[L.PHONE], leadId: id, templateName: cfg.whatsappTemplate, language: cfg.whatsappLanguage, params: renderParams(cfg.whatsappParams, lead, company) }, ctx);
        result.whatsapp = true;
      } catch (e: any) {
        await logError('leadAlerts.whatsapp', 'UPSTREAM', e?.message, e?.stack, '', { leadId: id });
        await addTimeline(id, 'alert_failed', 'Automatic WhatsApp reply failed', truncate(e?.message || String(e), 300), 'System');
      }
    }
  } catch (e: any) {
    try { await logError('leadAlerts', 'INTERNAL', e?.message, e?.stack, '', { leadId: id }); } catch { /* ignore */ }
  }
  return result;
}

/**
 * Queue the alerts to run after the current response (keeps the request fast). Outside a request (scripts,
 * tests) they run in the background. The company context is carried over explicitly.
 */
export function scheduleLeadAlerts(lead: Record<string, string>, kind: 'created' | 'assigned') {
  const tenant = currentTenant();
  const task = () => (tenant ? runWithTenant(tenant, () => sendLeadAlerts(lead, kind)) : sendLeadAlerts(lead, kind)).then(() => undefined, () => undefined);
  try {
    after(task);
  } catch {
    void task();
  }
}
