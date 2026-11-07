/** Reading an uploaded list, and choosing leads, for a WhatsApp campaign. No screen code, so the rules can be tested. */
import { F } from '../../core/config';
import type { Lead } from '../../types/crm';

export interface ListRow { phone: string; name: string }

/** The phone and name columns, by their headings. With no heading row, the first column holding a number is the phone. */
export function parseAudienceRows(rows: string[][]): { list: ListRow[]; problem: string } {
  const clean = rows.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (!clean.length) return { list: [], problem: 'This file is empty.' };
  const heads = clean[0].map((c) => String(c ?? '').trim().toLowerCase());
  let phoneCol = heads.findIndex((h) => /phone|mobile|whats\s*app|number|contact/.test(h));
  let nameCol = heads.findIndex((h) => /name/.test(h));
  let start = 1;
  if (phoneCol < 0) {
    phoneCol = clean[0].findIndex((c) => String(c ?? '').replace(/\D/g, '').length >= 10);
    if (phoneCol < 0) return { list: [], problem: 'No phone number column found. Add a column headed Phone.' };
    nameCol = clean[0].findIndex((c, i) => i !== phoneCol && /[a-z]/i.test(String(c ?? '')));
    start = 0;
  }
  const list = clean.slice(start).map((r) => ({ phone: String(r[phoneCol] ?? '').trim(), name: nameCol >= 0 ? String(r[nameCol] ?? '').trim() : '' })).filter((r) => r.phone);
  return list.length ? { list, problem: '' } : { list: [], problem: 'No phone numbers found in this file.' };
}

export interface LeadFilters { stages: string[]; sources: string[]; rms: string[] }

/** Empty means any. */
export function filterLeads(leads: Lead[], f: LeadFilters): Lead[] {
  const has = (set: string[], v: unknown) => !set.length || set.includes(String(v ?? ''));
  return leads.filter((l) => has(f.stages, l[F.STAGE]) && has(f.sources, l[F.SOURCE]) && has(f.rms, l[F.RM]));
}

/** What each value can be filled from. */
export const VALUE_FIELDS = [{ token: '{first_name}', label: 'First name' }, { token: '{name}', label: 'Full name' }, { token: '{rm}', label: 'Their RM' }, { token: '{unit}', label: 'Unit interested in' }, { token: '{company}', label: 'Company name' }];
