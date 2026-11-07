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

/* -------------------------------- the preview -------------------------------- */

export interface PreviewPerson { label: string; name: string; rm: string; unit: string }

const PLACEHOLDER_NAME = /^(whatsapp\b|unknown$|\+?\d[\d\s-]*$)/i;

/** One value for one person, by the same rules as sending (server: whatsappCampaigns.fillValue). */
export function fillPreviewValue(spec: string, p: PreviewPerson, company: string): string {
  const name = p.name && !PLACEHOLDER_NAME.test(p.name.trim()) ? p.name.trim() : '';
  const vars: Record<string, string> = { name: name || 'there', first_name: name.split(/\s+/)[0] || 'there', rm: p.rm, unit: p.unit, company };
  return String(spec || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').trim();
}

/** How many of these people would fail for a value left empty. */
export function peopleMissingValues(specs: string[], people: PreviewPerson[], company: string): number {
  return people.filter((p) => specs.some((s) => s.trim() && !fillPreviewValue(s, p, company))).length;
}

export interface PreviewPart { text: string; empty: boolean }

/** The message in pieces, so a blank still to fill can stand out. */
export function previewBody(body: string, names: string[], values: string[]): PreviewPart[] {
  const parts: PreviewPart[] = [];
  let at = 0;
  for (const m of String(body || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (m.index > at) parts.push({ text: body.slice(at, m.index), empty: false });
    const value = values[names.indexOf(m[1])] || '';
    parts.push(value ? { text: value, empty: false } : { text: m[0], empty: true });
    at = m.index + m[0].length;
  }
  if (at < String(body || '').length) parts.push({ text: body.slice(at), empty: false });
  return parts;
}

export function leadToPerson(l: Lead): PreviewPerson {
  const name = String(l[F.NAME] || '');
  return { label: name || 'No name', name, rm: String(l[F.RM] || ''), unit: String(l[F.UNIT_TYPE] || '') };
}
