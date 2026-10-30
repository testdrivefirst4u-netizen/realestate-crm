/** The prospect's name as shown on screens: with the salutation in front when there is one ("Mrs. Anita Rao"). */
import { F } from './config';

export function leadDisplayName(lead: Record<string, unknown> | null | undefined, fallback = ''): string {
  if (!lead) return fallback;
  const name = String(lead[F.NAME] || '').trim();
  if (!name) return fallback;
  const title = String(lead[F.SALUTATION] || '').trim();
  return title && !name.toLowerCase().startsWith(title.toLowerCase()) ? `${title} ${name}` : name;
}

/** A name the CRM made up because WhatsApp gave none: "WhatsApp +91…", the number itself, or nothing. */
export function isMadeUpName(name: unknown): boolean {
  const n = String(name || '').trim();
  return !n || /^whats ?app\b/i.test(n) || /^[+\d\s()-]{6,}$/.test(n) || !/\p{L}/u.test(n);
}

/** The person's real name for screens: the lead's (with salutation), else the WhatsApp contact name — '' when neither is known. */
export function personName(lead: Record<string, unknown> | null | undefined, contactName = ''): string {
  if (lead && !isMadeUpName(lead[F.NAME])) return leadDisplayName(lead);
  return isMadeUpName(contactName) ? '' : String(contactName).trim();
}
