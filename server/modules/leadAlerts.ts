/**
 * Instant lead alerts (company setting `leadAlerts`, Settings › Alerts & follow-ups). Free only — no WhatsApp/SMS.
 *
 * When a lead is created (any source: CRM, website form, webhook, Google Sheet, Meta, WhatsApp) or reassigned:
 *   - phone notification (Web Push, ./push.ts) to the assigned RM and to the extra CRM users listed;
 *   - e-mail to the same people (when the server has SMTP).
 * Runs after the response is sent (next/server `after`), so creating a lead never waits for or fails because of
 * an alert; problems go to the error log. Bulk imports do not alert.
 */
import nodemailer from 'nodemailer';
import { after } from 'next/server';
import { listUsers, type PublicUser } from '../core/auth';
import { CFG } from '../core/config';
import { fail } from '../core/errors';
import { addTimeline, logError } from '../core/events';
import { appUrl, settingsAll } from '../core/settings';
import { currentTenant, runWithTenant } from '../core/tenant';
import { safeJsonParse, truncate } from '../core/utils';
import { idsByEmail, idsByName, sendPush } from './push';

const L = CFG.LEAD;

export interface LeadAlertConfig {
  /** Phone notification to the assigned RM. */
  pushRm: boolean;
  /** E-mail the assigned RM. */
  emailRm: boolean;
  /** Extra recipients (comma-separated e-mails of active CRM users), e.g. the sales manager: notified of every new lead. */
  emailAlso: string;
}

export const LEAD_ALERT_DEFAULTS: LeadAlertConfig = { pushRm: true, emailRm: true, emailAlso: '' };

const flag = (v: unknown, d: boolean) => (v === undefined || v === null || v === '' ? d : v === true || v === 'true');

export function parseLeadAlerts(raw: unknown): LeadAlertConfig {
  const o = (typeof raw === 'string' ? safeJsonParse<Record<string, unknown>>(raw, {}) : raw) as Record<string, unknown> | null;
  return {
    pushRm: flag(o?.pushRm, LEAD_ALERT_DEFAULTS.pushRm),
    emailRm: flag(o?.emailRm, LEAD_ALERT_DEFAULTS.emailRm),
    emailAlso: String(o?.emailAlso ?? '').trim(),
  };
}

const EMAIL_LIST = (s: string) => s.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Validate a settings patch; returns the normalised JSON string to store. */
export async function validateLeadAlerts(raw: unknown): Promise<string> {
  const c = parseLeadAlerts(raw);
  const active = new Set((await listUsers()).filter((u) => u.status !== 'Disabled').map((u) => u.email.toLowerCase()));
  for (const e of EMAIL_LIST(c.emailAlso)) {
    if (!active.has(e)) throw fail('VALIDATION', `Alert recipients must be active CRM users (${e} is not)`);
  }
  return JSON.stringify({ ...c, emailAlso: EMAIL_LIST(c.emailAlso).join(', ') });
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

/** Users to notify on their phones: the assigned RM (when on) and the extra recipients. */
export function pushRecipients(cfg: LeadAlertConfig, rm: string, users: PublicUser[]): string[] {
  return [...new Set([...(cfg.pushRm && rm.trim() ? idsByName([rm], users) : []), ...idsByEmail(EMAIL_LIST(cfg.emailAlso), users)])];
}

/** The phone notification for a lead. */
export function alertPush(lead: Record<string, string>, kind: 'created' | 'assigned') {
  const name = lead[L.NAME] || 'Lead';
  const bits = [lead[L.SOURCE], lead[L.UNIT_TYPE], lead[L.RM] ? `RM ${lead[L.RM]}` : 'Unassigned'].filter(Boolean);
  return {
    title: kind === 'created' ? `New lead: ${name}` : `Lead assigned to you: ${name}`,
    body: [bits.join(' · '), lead[L.PHONE] ? `Call ${lead[L.PHONE]}` : ''].filter(Boolean).join('\n'),
    url: `/leads?lead=${encodeURIComponent(lead[L.ID] || '')}`,
    tag: `lead-${lead[L.ID] || ''}`,
  };
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
export async function sendLeadAlerts(lead: Record<string, string>, kind: 'created' | 'assigned'): Promise<{ emailed: number; pushed: number }> {
  const result = { emailed: 0, pushed: 0 };
  const id = lead[L.ID];
  try {
    const cfg = parseLeadAlerts((await settingsAll()).leadAlerts);
    const users = await listUsers();
    const rm = String(lead[L.RM] || '');

    // 1. phone notifications (free)
    const ids = pushRecipients(cfg, rm, users);
    if (ids.length) result.pushed = (await sendPush(ids, alertPush(lead, kind))).sent;

    // 2. e-mail
    const smtp = process.env.SMTP_URL?.trim();
    const from = process.env.MAIL_FROM?.trim();
    if (smtp && from && (cfg.emailRm || cfg.emailAlso)) {
      const to = alertRecipients(cfg, rm, users);
      if (to.length) {
        try {
          const { subject, text } = alertEmail(lead, kind, `${appUrl()}/leads?lead=${encodeURIComponent(id)}`, currentTenant()?.name || '');
          await nodemailer.createTransport(smtp).sendMail({ from, to: to.join(', '), subject, text });
          result.emailed = to.length;
          await addTimeline(id, 'alert_sent', 'Lead alert e-mailed', to.join(', '), 'System');
        } catch (e: any) {
          await logError('leadAlerts.email', 'UPSTREAM', e?.message, e?.stack, '', { leadId: id });
        }
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
