/**
 * One consent and suppression policy for every WhatsApp send — manual, campaign, chatbot and drip (Release C).
 *
 * Stored per full international number (E.164) in `consents`: the current state plus its history, each change with
 * who / when / how (evidence). A STOP reply, an unsubscribe link or an agent marking "denied" suppresses the number
 * at once; a send that was already queued is checked again just before it goes out.
 *
 *   canSend(phone, purpose)   purpose 'marketing'  — templates sent to many people, drips, promotional bots
 *                             purpose 'service'    — a reply to the customer's own message, booking / visit /
 *                                                    payment updates they asked for
 *   Marketing needs consent 'granted' (or, when the company allows it, 'unknown' for first contact on the number
 *   the customer gave themselves: setting `marketingWithoutExplicitConsent`, default off). 'denied' blocks
 *   marketing always. Service messages are allowed unless the number is suppressed for everything ('blocked').
 *
 * Meta's own rules still apply on top (approved templates outside the 24-hour service window): see
 * server/modules/whatsappDirect.ts and docs/INTEGRATIONS.md.
 */
import { col } from '../core/db';
import { phoneIdentity } from '../core/phone';
import { settingsAll } from '../core/settings';
import { str, truncate } from '../core/utils';

export type ConsentValue = 'granted' | 'denied' | 'unknown' | 'blocked';
export interface ConsentDoc {
  _id: string; // E.164
  state: ConsentValue;
  updatedAt: Date;
  history: Array<{ state: ConsentValue; at: Date; source: string; evidence: string; by: string; leadId?: string }>;
}
const consents = () => col<ConsentDoc>('consents');

export async function recordConsent(phone: unknown, state: string, meta: { source: string; evidence?: string; by: string; leadId?: string; at?: Date }) {
  const id = phoneIdentity(phone)?.e164;
  if (!id) return null;
  const s = (['granted', 'denied', 'unknown', 'blocked'].includes(state) ? state : 'unknown') as ConsentValue;
  const at = meta.at || new Date();
  const entry = { state: s, at, source: truncate(meta.source, 40), evidence: truncate(str(meta.evidence), 300), by: truncate(meta.by, 80), ...(meta.leadId ? { leadId: meta.leadId } : {}) };
  await (await consents()).updateOne({ _id: id }, { $set: { state: s, updatedAt: at }, $push: { history: { $each: [entry], $slice: -50 } } }, { upsert: true });
  return { phone: id, state: s };
}

/** STOP / unsubscribe / agent opt-out: marketing stops immediately for this number. */
export const optOut = (phone: unknown, source: string, by = 'Customer', evidence = '') => recordConsent(phone, 'denied', { source, by, evidence });

export async function consentOf(phone: unknown): Promise<ConsentValue> {
  const id = phoneIdentity(phone)?.e164;
  if (!id) return 'unknown';
  return (await (await consents()).findOne({ _id: id }, { projection: { state: 1 } }))?.state || 'unknown';
}

export async function canSend(phone: unknown, purpose: 'marketing' | 'service'): Promise<{ ok: boolean; reason: string }> {
  const state = await consentOf(phone);
  if (state === 'blocked') return { ok: false, reason: 'This number asked not to be contacted on WhatsApp' };
  if (purpose === 'service') return { ok: true, reason: '' };
  if (state === 'denied') return { ok: false, reason: 'Opted out of WhatsApp marketing' };
  if (state === 'granted') return { ok: true, reason: '' };
  const allowUnknown = String((await settingsAll()).marketingWithoutExplicitConsent || 'false') === 'true';
  return allowUnknown ? { ok: true, reason: '' } : { ok: false, reason: 'No recorded consent for WhatsApp marketing' };
}

/** Words that mean "stop messaging me" in a customer's reply (English and common Indian-language forms). */
export function isStopWord(text: unknown): boolean {
  const t = str(text).trim().toLowerCase().replace(/[.!]+$/, '');
  return /^(stop|unsubscribe|opt ?out|stop all|cancel|no more|do not message|don'?t message|band karo|bandh karo|mat bhejo|वेंडा|बंद करो|nirutthu|venda)$/.test(t);
}
