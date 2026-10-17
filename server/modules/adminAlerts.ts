/**
 * Admin alerts for integration problems (runs inside a company context).
 *
 * notifyAdmins(key, title, message):
 *   - an `integration_alert` event → every CRM user's notification bell (red, with sound);
 *   - an e-mail to the company's alert recipients (Settings › Integrations › daily digest e-mail) when SMTP is set.
 * The same `key` alerts at most once per THROTTLE_MS (state in the company `meta` collection), so a sync that keeps
 * failing every 10 minutes does not flood anyone.
 */
import nodemailer from 'nodemailer';
import { CFG } from '../core/config';
import { col } from '../core/db';
import { addEvent, logError } from '../core/events';
import { settingsAll } from '../core/settings';
import { currentTenant } from '../core/tenant';
import { truncate } from '../core/utils';

export const THROTTLE_MS = 6 * 60 * 60 * 1000;

/** Recipients: the daily digest addresses (comma / space separated). */
async function recipients(): Promise<string[]> {
  return String((await settingsAll()).dailyDigestEmail || '').split(/[,;\s]+/).filter((s) => /@/.test(s));
}

/**
 * Tell the company's admins about an integration problem. Returns false when the same key alerted recently.
 * Never throws: alerting must not break the job that found the problem.
 */
export async function notifyAdmins(key: string, title: string, message: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const meta = await col<{ _id: string; at: Date }>(CFG.COLL.META);
    const id = 'alert:' + key;
    const cutoff = new Date(nowMs - THROTTLE_MS);
    // claim the slot atomically: only one caller per window gets through
    const claimed = await meta.findOneAndUpdate(
      { _id: id, $or: [{ at: { $lt: cutoff } }, { at: { $exists: false } }] },
      { $set: { at: new Date(nowMs) } },
      { upsert: false }
    );
    if (!claimed) {
      try {
        await meta.insertOne({ _id: id, at: new Date(nowMs) });
      } catch (e: any) {
        if (e?.code === 11000) return false; // exists and is recent
        throw e;
      }
    }
    await addEvent('integration_alert', 'integration', key, truncate(title, 200), truncate(message, 500), 'System');
    const to = await recipients();
    const smtp = process.env.SMTP_URL?.trim();
    const from = process.env.MAIL_FROM?.trim();
    if (to.length && smtp && from) {
      const company = currentTenant()?.name || 'CRM';
      await nodemailer.createTransport(smtp).sendMail({ from, to: to.join(', '), subject: `[${company}] ${title}`, text: `${message}\n\n— ${company} CRM` });
    }
    return true;
  } catch (e: any) {
    await logError('alerts.notify', 'INTERNAL', e?.message, e?.stack, '', { key });
    return false;
  }
}
