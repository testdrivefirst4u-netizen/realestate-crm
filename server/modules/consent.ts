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
 *   Company setting `whatsappMarketingConsent`:
 *     'optOut'   (default — the CRM's behaviour before this change): marketing goes to everyone who has not opted
 *                out; an explicit 'denied' or a STOP blocks it at once.
 *     'explicit' marketing only to numbers with recorded consent 'granted' (evidence kept). Recommended under
 *                India's DPDP Act; switching it on stops campaigns to people never asked — a business decision.
 *   Service messages are allowed unless the number is suppressed for everything ('blocked').
 *   The older per-number opt-out list (`dripOptOuts`, last ten digits) is read and written too, so existing drips
 *   and campaigns and this policy always agree.
 *
 * Meta's own rules still apply on top (approved templates outside the 24-hour service window): see
 * server/modules/whatsappDirect.ts and docs/INTEGRATIONS.md.
 */
import { col } from '../core/db';
import { phoneIdentity } from '../core/phone';
import { settingsAll } from '../core/settings';
import { last10, str, truncate } from '../core/utils';

const legacyOptOuts = () => col<{ _id: string; channel: string; at: Date; how: string }>('dripOptOuts');

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
  // keep the older opt-out list in step (drips and campaigns read it per send)
  const key = `whatsapp:${last10(id)}`;
  if (s === 'denied' || s === 'blocked') await (await legacyOptOuts()).updateOne({ _id: key }, { $set: { channel: 'whatsapp', at, how: truncate(meta.source || 'opt-out', 60) } }, { upsert: true });
  if (s === 'granted') await (await legacyOptOuts()).deleteOne({ _id: key });
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
  let state = await consentOf(phone);
  // an opt-out recorded the older way (STOP reply to a drip or campaign) counts, whatever this store says
  const k = last10(phone);
  if (state !== 'blocked' && state !== 'granted' && k.length === 10 && (await (await legacyOptOuts()).findOne({ _id: `whatsapp:${k}` }, { projection: { _id: 1 } }))) state = 'denied';
  if (state === 'blocked') return { ok: false, reason: 'This number asked not to be contacted on WhatsApp' };
  if (purpose === 'service') return { ok: true, reason: '' };
  if (state === 'denied') return { ok: false, reason: 'Opted out of WhatsApp marketing' };
  if (state === 'granted') return { ok: true, reason: '' };
  const policy = str((await settingsAll()).whatsappMarketingConsent) === 'explicit' ? 'explicit' : 'optOut';
  return policy === 'optOut' ? { ok: true, reason: '' } : { ok: false, reason: 'No recorded consent for WhatsApp marketing' };
}

/** A customer's own message: STOP (any channel provider) suppresses marketing to that number immediately. */
export async function noteInbound(phone: unknown, text: unknown) {
  if (isStopWord(text)) await optOut(phone, 'replied STOP', 'Customer', truncate(str(text), 80));
}

/** Words that mean "stop messaging me" in a customer's reply (English and common Indian-language forms). */
export function isStopWord(text: unknown): boolean {
  const t = str(text).trim().toLowerCase().replace(/[.!]+$/, '');
  return /^(stop|unsubscribe|opt ?out|stop all|cancel|no more|do not message|don'?t message|band karo|bandh karo|mat bhejo|वेंडा|बंद करो|nirutthu|venda)$/.test(t);
}
