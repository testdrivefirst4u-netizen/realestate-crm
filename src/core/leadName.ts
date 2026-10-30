/** The prospect's name as shown on screens: with the salutation in front when there is one ("Mrs. Anita Rao"). */
import { F } from './config';

export function leadDisplayName(lead: Record<string, unknown> | null | undefined, fallback = ''): string {
  if (!lead) return fallback;
  const name = String(lead[F.NAME] || '').trim();
  if (!name) return fallback;
  const title = String(lead[F.SALUTATION] || '').trim();
  return title && !name.toLowerCase().startsWith(title.toLowerCase()) ? `${title} ${name}` : name;
}
