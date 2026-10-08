/**
 * Global search (top bar): one query across everything the signed-in user can see in the CRM — leads,
 * message templates, tasks, notes, checklist items, inventory units, documents, client segments and the
 * team. Runs in the browser over the data the engine already holds (each user only has what the server let
 * them see), so it is instant and never exposes more than the screens do.
 *
 * Matching: every word of the query must appear (case- and accent-insensitive) in the item's text; items whose
 * title starts with / contains the query rank first. Leads use the existing lead search (phone digits, ids…).
 */
import type { ClientSegment, CrmDocument, ChecklistItem, InventoryUnit, Lead, MessageTemplate, NoteItem, TaskItem, UserAccount } from '../types/crm';
import { F } from './config';
import { searchLeads } from './analytics';
import { formatPhone } from './phone';

export type SearchKind = 'lead' | 'template' | 'task' | 'note' | 'checklist' | 'unit' | 'document' | 'segment' | 'user';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  /** A short piece of the matching text, around the first match. */
  snippet: string;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  /** Screen that lists this kind (view id), used for "show all". */
  view: string;
  hits: SearchHit[];
  total: number;
}

export interface SearchData {
  leads?: Lead[];
  templates?: MessageTemplate[];
  tasks?: TaskItem[];
  notes?: NoteItem[];
  checklist?: ChecklistItem[];
  inventory?: InventoryUnit[];
  documents?: CrmDocument[];
  segments?: ClientSegment[];
  users?: UserAccount[];
}

const fold = (s: unknown) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const queryTerms = (q: string) => fold(q).split(/\s+/).filter(Boolean);

/** All terms present in the text? */
export function matchesAll(text: string, terms: string[]): boolean {
  const t = fold(text);
  return terms.every((w) => t.includes(w));
}

/** ~`width` characters around the first match of any term (with ellipses), whitespace collapsed. */
export function snippetAround(text: string, terms: string[], width = 90): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  const low = fold(flat);
  const at = Math.min(...terms.map((w) => low.indexOf(w)).filter((i) => i >= 0), flat.length);
  const start = at >= flat.length ? 0 : Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

function rank(title: string, q: string): number {
  const t = fold(title), s = fold(q).trim();
  if (t === s) return 0;
  if (t.startsWith(s)) return 1;
  if (t.includes(s)) return 2;
  return 3;
}

interface Spec<T> {
  kind: SearchKind;
  label: string;
  view: string;
  items: T[] | undefined;
  id: (x: T) => string;
  title: (x: T) => string;
  subtitle: (x: T) => string;
  /** Everything searchable, including the title. */
  text: (x: T) => string;
  /** The text to cut the snippet from (default: text). */
  body?: (x: T) => string;
}

function searchKind<T>(spec: Spec<T>, q: string, terms: string[], limit: number): SearchGroup | null {
  const hits = (spec.items || [])
    .filter((x) => matchesAll(spec.text(x), terms))
    .map((x) => ({ x, r: rank(spec.title(x), q) }))
    .sort((a, b) => a.r - b.r || spec.title(a.x).localeCompare(spec.title(b.x)));
  if (!hits.length) return null;
  return {
    kind: spec.kind, label: spec.label, view: spec.view, total: hits.length,
    hits: hits.slice(0, limit).map(({ x }) => ({
      kind: spec.kind, id: spec.id(x), title: spec.title(x) || '(untitled)', subtitle: spec.subtitle(x),
      snippet: snippetAround((spec.body || spec.text)(x), terms),
    })),
  };
}

const clip = (s: unknown, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Search everything; groups in a stable order, at most `limit` hits each (with the full count). */
export function globalSearch(data: SearchData, q: string, limit = 5): SearchGroup[] {
  const query = String(q || '').trim();
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const groups: Array<SearchGroup | null> = [];

  // Leads: the lead search already understands phones, ids, e-mails and notes.
  const leads = searchLeads(data.leads || [], query, 50);
  if (leads.length) {
    groups.push({
      kind: 'lead', label: 'Leads', view: 'leads', total: leads.length,
      hits: leads.slice(0, limit).map((l) => ({
        kind: 'lead' as const, id: l[F.ID], title: l[F.NAME] || l[F.ID],
        subtitle: [l[F.ID], formatPhone(l[F.PHONE]), l[F.STAGE], l[F.UNIT_TYPE]].filter(Boolean).join(' · '),
        snippet: matchesAll(String(l[F.NOTES] || ''), terms) ? snippetAround(String(l[F.NOTES]), terms) : '',
      })),
    });
  }

  groups.push(searchKind<MessageTemplate>({
    kind: 'template', label: 'Templates', view: 'templates', items: data.templates,
    id: (t) => t.id, title: (t) => t.name, subtitle: (t) => t.type || 'Template', text: (t) => `${t.name} ${t.type} ${t.message}`, body: (t) => t.message,
  }, query, terms, limit));

  groups.push(searchKind<TaskItem>({
    kind: 'task', label: 'Tasks', view: 'tasks', items: data.tasks,
    id: (t) => t.id, title: (t) => t.name,
    subtitle: (t) => [t.completed ? 'Done' : 'Pending', t.lead, t.assignedTo].filter(Boolean).join(' · '),
    text: (t) => `${t.name} ${t.lead || ''} ${t.assignedTo || ''} ${(t.checklist || []).map((c) => c.text).join(' ')}`,
  }, query, terms, limit));

  groups.push(searchKind<NoteItem>({
    kind: 'note', label: 'Notes', view: 'tasks', items: data.notes,
    id: (n) => n.id, title: (n) => clip(n.text, 60), subtitle: () => 'Note', text: (n) => n.text,
  }, query, terms, limit));

  groups.push(searchKind<ChecklistItem>({
    kind: 'checklist', label: 'Checklist', view: 'tasks', items: data.checklist,
    id: (c) => c.id, title: (c) => clip(c.text, 60), subtitle: () => 'Checklist item', text: (c) => c.text,
  }, query, terms, limit));

  groups.push(searchKind<InventoryUnit>({
    kind: 'unit', label: 'Inventory', view: 'inventory', items: data.inventory,
    id: (u) => u.inventoryId, title: (u) => `Unit ${u.unitId}${u.tower ? ` · Tower ${u.tower}` : ''}`,
    subtitle: (u) => [u.unitType, u.floor !== '' && u.floor !== undefined ? `Floor ${u.floor}` : '', u.status, u.facing].filter(Boolean).join(' · '),
    text: (u) => `${u.unitId} ${u.tower} tower ${u.tower} ${u.unitType} floor ${u.floor} ${u.status} ${u.facing || ''} ${u.availability || ''} ${u.bookingStatus || ''} ${u.inventoryId}`,
  }, query, terms, limit));

  groups.push(searchKind<CrmDocument>({
    kind: 'document', label: 'Documents', view: 'documents', items: data.documents,
    id: (d) => d.id, title: (d) => d.name, subtitle: (d) => [d.category, d.leadId].filter(Boolean).join(' · '),
    text: (d) => `${d.name} ${d.category} ${d.leadId || ''} ${(d as any).description || ''}`,
  }, query, terms, limit));

  groups.push(searchKind<ClientSegment>({
    kind: 'segment', label: 'Client segments', view: 'segments', items: data.segments,
    id: (s) => s.id, title: (s) => s.name, subtitle: (s) => clip(s.description, 70), text: (s) => `${s.name} ${s.description}`,
  }, query, terms, limit));

  groups.push(searchKind<UserAccount>({
    kind: 'user', label: 'Team', view: 'settings', items: data.users,
    id: (u) => u.id, title: (u) => u.name, subtitle: (u) => `${u.email}${u.role ? ` · ${u.role}` : ''}`, text: (u) => `${u.name} ${u.email} ${u.role}`,
  }, query, terms, limit));

  return groups.filter((g): g is SearchGroup => !!g);
}

/** Split `text` into parts with the query terms marked, for safe highlighting in React. */
export function highlightParts(text: string, terms: string[]): Array<{ text: string; hit: boolean }> {
  const ws = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!ws.length || !text) return [{ text, hit: false }];
  const low = text.toLowerCase(); // same length as text, so positions line up
  const out: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    let best = -1, len = 0;
    for (const w of ws) {
      const at = low.indexOf(w, i);
      if (at >= 0 && (best < 0 || at < best)) { best = at; len = w.length; }
    }
    if (best < 0) { out.push({ text: text.slice(i), hit: false }); break; }
    if (best > i) out.push({ text: text.slice(i, best), hit: false });
    out.push({ text: text.slice(best, best + len), hit: true });
    i = best + len;
  }
  return out;
}
