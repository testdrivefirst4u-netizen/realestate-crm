/**
 * CRM — CSV import / export service.
 *
 * Import pipeline (client side, pure — no network):
 *   text ─▶ parseCsvText (RFC-4180, multi-line cells) ─▶ mapHeaders (exclusive, strict)
 *        ─▶ one normalised Lead per record (dates → ISO, stage synonyms → config stages)
 *        ─▶ conflict analysis against existing leads (Enquiry ID first, then phone — exactly
 *           what the server does) + in-file duplicate detection ─▶ preview.
 *
 * The SERVER performs the actual import (`api.leads.importBulk(leads, strategy)`), applies the
 * strategy (SKIP | OVERWRITE | CREATE_COPY) and assigns Enquiry IDs for new rows. This module
 * never generates IDs and never fills client-side defaults: an OVERWRITE only patches the
 * non-empty fields it receives, so a blank cell must stay blank.
 */
import { DEFAULT_CONFIG, F, LEAD_BASE_HEADERS, LEAD_DATE_FIELDS, MAX_FOLLOWUPS, STAGES, followupField } from '../core/config';
import { addDays, dateKey, formatDateTime, getParts, normalizeDateValue, parseDate, toSheetDateTime } from '../core/dates';
import { downloadText, toCsv } from '../core/format';
import { digitsOnly, last10 } from '../core/phone';
import { Lead } from '../types/crm';
import { normalizeUnitType } from '../core/units';

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/** Strategies understood by the server (importLeads). MERGE was removed — it lost data. */
export type ConflictResolutionStrategy = 'SKIP' | 'OVERWRITE' | 'CREATE_COPY';

export const IMPORT_STRATEGIES: Array<{ id: ConflictResolutionStrategy; label: string; description: string }> = [
  { id: 'SKIP', label: 'Skip existing', description: 'Keep matched CRM records untouched; only the new rows are created.' },
  { id: 'OVERWRITE', label: 'Overwrite matched', description: 'Update the matched records with the non-blank values from the file. Blank cells never erase data.' },
  { id: 'CREATE_COPY', label: 'Create copies', description: 'Create the matched rows as new enquiries with fresh Enquiry IDs, so both versions coexist.' },
];

export type ConflictReason = 'ID_MATCH' | 'PHONE_MATCH';

export interface ImportConflictItem {
  incoming: Lead;
  existing: Lead;
  reason: ConflictReason;
  rowIndex: number;
}

export type MappingConfidence = 'EXACT' | 'FUZZY' | 'NONE';

export interface ColumnMappingInfo {
  crmField: string;
  csvHeader: string;
  confidence: MappingConfidence;
}

export type PreviewStatus = 'NEW' | 'UPDATE' | 'DUPLICATE';

export interface CSVRowPreview {
  /** 1-based record number in the file (the header row is record 1). */
  rowIndex: number;
  lead: Lead;
  raw: Record<string, string>;
  /** NEW = will be created · UPDATE = matches an existing lead (strategy decides) · DUPLICATE = repeats an earlier row in this file (not sent). */
  status: PreviewStatus;
  conflictReason?: ConflictReason;
  matchedExisting?: Lead;
  duplicateOfRow?: number;
  warnings: string[];
  unknownStage?: boolean;
}

export interface CSVParseResult {
  /** Rows that will be sent to the server (NEW + UPDATE). */
  validLeads: Lead[];
  brandNewLeads: Lead[];
  conflicts: ImportConflictItem[];
  inFileDuplicates: CSVRowPreview[];
  /** Row-level problems (skipped rows). */
  errors: string[];
  /** Data records found in the file (header excluded, fully blank records excluded). */
  totalRowsParsed: number;
  /** Non-blank headers in positional order. */
  detectedHeaders: string[];
  columnMappings: ColumnMappingInfo[];
  unmappedHeaders: string[];
  /** "Follow-up N" columns found in the file. */
  followupColumns: string[];
  /** Stage values that could not be mapped to a configured stage (kept as-is, flagged). */
  unknownStages: string[];
  previewRows: CSVRowPreview[];
}

export interface ParseOptions {
  /** Stages accepted as "known" (defaults to DEFAULT_CONFIG stages). */
  stages?: string[];
  /** Force a delimiter; auto-detected when omitted. */
  delimiter?: string;
}

/* ------------------------------------------------------------------------ */
/* RFC-4180 parser                                                           */
/* ------------------------------------------------------------------------ */

/** Pick the delimiter from the first record (quotes respected). Defaults to a comma. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const d of Object.keys(counts)) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * Parse a whole CSV text into records. Handles quoted cells that contain the delimiter,
 * escaped quotes ("") and embedded line breaks; accepts CRLF / LF / CR line endings and a BOM.
 * Records that are entirely blank are dropped. Cells are returned untrimmed.
 */
export function parseCsvText(text: string, delimiter?: string): string[][] {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const delim = delimiter || detectDelimiter(s);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let cellStarted = false; // true once any char (or an opening quote) has been seen for the current cell
  const n = s.length;

  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && !cellStarted) {
      inQuotes = true;
      cellStarted = true;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = '';
      cellStarted = false;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStarted = false;
      if (ch === '\r' && s[i + 1] === '\n') i++;
      continue;
    }
    cell += ch;
    cellStarted = true;
  }
  if (cellStarted || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* ------------------------------------------------------------------------ */
/* Header mapping                                                            */
/* ------------------------------------------------------------------------ */

/** Lower-case, strip decoration ("Mobile No.*" → "mobile no"), hyphens/underscores → spaces. */
export function normalizeHeader(h: string): string {
  return String(h ?? '')
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[*:#.()[\]"'’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FieldRule {
  field: string;
  /** Normalised header spellings that count as an exact match. */
  aliases: string[];
  /** Anchored patterns tested against the normalised header. */
  fuzzy: RegExp[];
}

const nh = normalizeHeader;

/**
 * Priority order matters for the fuzzy pass: the more specific fields claim their headers first
 * so e.g. "Visit Date" is taken by Site Visit Date before Site Visit Status could consider it.
 */
const FIELD_RULES: FieldRule[] = [
  {
    field: F.ID,
    aliases: [F.ID, 'enquiry id', 'enq id', 'lead id', 'id', 'enquiry no', 'enquiry number', 'inquiry id', 'ref no', 'reference no', 'reference', 'crm id'].map(nh),
    fuzzy: [/^(enquiry|inquiry|enq|lead|crm|ref|reference)\s*(id|no|num|number)$/],
  },
  {
    field: F.NAME,
    aliases: [F.NAME, 'name', 'client name', 'customer name', 'full name', 'lead name', 'contact name', 'prospect', 'customer', 'client'].map(nh),
    fuzzy: [/^(prospect|client|customer|lead|contact|full|first)\s*name$/],
  },
  {
    field: F.PHONE,
    aliases: [F.PHONE, 'phone', 'phone no', 'phone number', 'mobile', 'mobile no', 'mobile number', 'contact', 'contact no', 'contact number', 'whatsapp', 'whatsapp no', 'whatsapp number', 'mob', 'mob no', 'cell', 'telephone', 'ph no'].map(nh),
    fuzzy: [/^(phone|mobile|mob|cell|cellphone|whatsapp|wa|telephone|tel|ph)(\s*(phone|no|num|number))?$/, /^contact\s*(no|num|number)$/, /^(primary|customer|client)\s*(phone|mobile|contact)(\s*(no|number))?$/],
  },
  {
    field: F.EMAIL,
    aliases: [F.EMAIL, 'e mail', 'email id', 'email address', 'e mail id', 'e mail address', 'mail id', 'mail'].map(nh),
    fuzzy: [/^e?\s*mail(\s*(id|address))?$/],
  },
  {
    field: F.STAGE,
    aliases: [F.STAGE, 'stage', 'status', 'lead status', 'pipeline stage', 'pipeline'].map(nh),
    fuzzy: [/^(lead|enquiry|pipeline|current)\s*(stage|status)$/],
  },
  {
    field: F.SOURCE,
    aliases: [F.SOURCE, 'source', 'lead source', 'channel', 'campaign', 'medium', 'origin', 'utm source', 'inquiry source'].map(nh),
    fuzzy: [/^(enquiry|inquiry|enq|lead)\s*source$/, /^(channel|campaign|medium|origin)$/, /^utm\s*source$/],
  },
  {
    field: F.UNIT_TYPE,
    aliases: [F.UNIT_TYPE, 'unit type', 'unit', 'configuration', 'config', 'bhk', 'typology', 'interested in', 'flat type', 'apartment type', 'unit preference', 'unit size', 'interested unit'].map(nh),
    fuzzy: [/^(unit|flat|apartment|home)\s*(type|size|preference|config|configuration)(\s*interested(\s*in)?)?$/, /^(configuration|config|bhk|typology)$/, /^interested\s*in$/],
  },
  {
    field: F.PURCHASE_OR_RENT,
    aliases: [F.PURCHASE_OR_RENT, 'purchase/rent', 'purchase or rental', 'buy or rent', 'buy/rent', 'intent', 'transaction type', 'requirement type', 'purpose', 'buy rent'].map(nh),
    fuzzy: [/^(purchase|buy|buying)\s*(or|\/|\s)\s*rent(al|ing)?$/, /^(intent|transaction\s*type|requirement\s*type|purpose)$/],
  },
  {
    field: F.SITE_VISIT_DATE,
    aliases: [F.SITE_VISIT_DATE, 'visit date', 'sv date', 'site visit on', 'visited on'].map(nh),
    fuzzy: [/^(site\s*)?visit\s*(date|on)$/],
  },
  {
    field: F.SITE_VISIT_STATUS,
    aliases: [F.SITE_VISIT_STATUS, 'site visit', 'visit status', 'sv status', 'site visit done'].map(nh),
    fuzzy: [/^(site\s*)?visit(\s*status)?$/, /^sv\s*status$/],
  },
  {
    field: F.BOOKING_DATE,
    aliases: [F.BOOKING_DATE, 'booked on', 'booked date', 'date of booking'].map(nh),
    fuzzy: [/^book(ing|ed)\s*(date|on)$/],
  },
  {
    field: F.LAST_FOLLOWUP,
    aliases: [F.LAST_FOLLOWUP, 'last follow up', 'last follow up date', 'last followup', 'last contacted', 'last contact', 'last contact date', 'last activity', 'last call', 'last call date', 'last follow up date and time'].map(nh),
    fuzzy: [/^last\s*(follow\s*up|followup|contact(ed)?|activity|call)(\s*(date|on|date\s*(&|and)\s*time))?$/],
  },
  {
    field: F.NEXT_FOLLOWUP,
    aliases: [F.NEXT_FOLLOWUP, 'next follow up', 'next followup', 'follow up date', 'followup date', 'next follow up on', 'next action date', 'reminder date', 'next call', 'next call date', 'next contact date', 'follow up'].map(nh),
    fuzzy: [/^next\s*(follow\s*up|followup)(\s*(date|on))?$/, /^(follow\s*up|followup)\s*(date|on)$/, /^(reminder|next\s*(action|call|contact))(\s*date)?$/],
  },
  {
    field: F.ENQUIRY_DATE,
    aliases: [F.ENQUIRY_DATE, 'date', 'created date', 'created at', 'created on', 'created', 'lead date', 'inquiry date', 'date of enquiry', 'date of inquiry', 'enquiry on', 'timestamp', 'enq date'].map(nh),
    fuzzy: [/^(enquiry|inquiry|enq|lead|creation)\s*(date|on|at)$/, /^created(\s*(date|on|at))?$/, /^date(\s*of\s*(enquiry|inquiry|lead))?$/, /^timestamp$/],
  },
  {
    field: F.NOTES,
    aliases: [F.NOTES, 'notes', 'note', 'remarks', 'remark', 'comments', 'comment', 'description', 'enquiry remarks', 'message', 'requirement', 'requirements'].map(nh),
    fuzzy: [/^(enquiry|inquiry|lead|customer)?\s*(notes?|remarks?|comments?|description|message)$/],
  },
  {
    field: F.RM,
    aliases: [F.RM, 'rm', 'relationship manager', 'assigned to', 'assigned', 'owner', 'lead owner', 'sales rep', 'sales person', 'salesperson', 'sales executive', 'executive', 'agent', 'assignee', 'handled by', 'rm name'].map(nh),
    fuzzy: [/^(assigned\s*(rm|to|user)?|rm(\s*name)?|relationship\s*manager|(lead\s*)?owner|sales\s*(rep|person|executive|manager)|salesperson|agent|executive|handled\s*by|assignee)$/],
  },
  {
    field: F.BROCHURE,
    aliases: [F.BROCHURE, 'brochure', 'brochure sent', 'brochure status'].map(nh),
    fuzzy: [/^brochure(\s*(shared|sent|status))?$/],
  },
  {
    field: F.RELATIONSHIP,
    aliases: [F.RELATIONSHIP, 'relationship', 'relation', 'relation to prospect', 'relationship with prospect'].map(nh),
    fuzzy: [/^relation(ship)?(\s*(to|with)\s*(the\s*)?prospect)?$/],
  },
  {
    field: F.ENQUIRED_FOR,
    aliases: [F.ENQUIRED_FOR, 'enquiring for', 'enquiry for', 'inquired for', 'inquiring for', 'for whom', 'buying for', 'looking for whom'].map(nh),
    fuzzy: [/^(enquir(ed|ing|y)|inquir(ed|ing|y)|buying|looking)\s*for(\s*whom)?$/, /^for\s*whom$/],
  },
];

/** Fields the import can write (server-managed audit columns are excluded). */
export const IMPORTABLE_FIELDS: string[] = FIELD_RULES.map((r) => r.field);

const RE_FOLLOWUP_HEADER = /^follow\s*up\s*(\d{1,3})$/;

export interface HeaderMapping {
  /** CRM field → index of the CSV column that feeds it. */
  fieldToIndex: Record<string, number>;
  /** "Follow-up N" columns found in the file: field → column index. */
  followupToIndex: Record<string, number>;
  mappings: ColumnMappingInfo[];
  unmappedHeaders: string[];
}

/**
 * Map CSV headers to CRM fields. Exclusive: each CSV column feeds at most one field and each field
 * is fed by at most one column. Exact (alias) matches are resolved for every field before any
 * fuzzy pattern runs, so a loose pattern can never steal a column that another field names exactly.
 * Blank header cells are ignored but keep their positional index so later columns do not shift.
 */
export function mapHeaders(headers: string[]): HeaderMapping {
  const columns = headers
    .map((h, index) => ({ index, header: String(h ?? '').trim(), norm: nh(h) }))
    .filter((c) => c.header.length > 0);
  const claimed = new Set<number>();
  const fieldToIndex: Record<string, number> = {};
  const confidence: Record<string, MappingConfidence> = {};

  for (const rule of FIELD_RULES) {
    const col = columns.find((c) => !claimed.has(c.index) && rule.aliases.includes(c.norm));
    if (col) {
      fieldToIndex[rule.field] = col.index;
      confidence[rule.field] = 'EXACT';
      claimed.add(col.index);
    }
  }
  for (const rule of FIELD_RULES) {
    if (fieldToIndex[rule.field] !== undefined) continue;
    const col = columns.find((c) => !claimed.has(c.index) && rule.fuzzy.some((re) => re.test(c.norm)));
    if (col) {
      fieldToIndex[rule.field] = col.index;
      confidence[rule.field] = 'FUZZY';
      claimed.add(col.index);
    }
  }

  const followupToIndex: Record<string, number> = {};
  for (const c of columns) {
    if (claimed.has(c.index)) continue;
    const m = c.norm.match(RE_FOLLOWUP_HEADER);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > MAX_FOLLOWUPS) continue;
    const field = followupField(n);
    if (followupToIndex[field] !== undefined) continue;
    followupToIndex[field] = c.index;
    claimed.add(c.index);
  }

  const mappings: ColumnMappingInfo[] = FIELD_RULES.map((rule) => {
    const idx = fieldToIndex[rule.field];
    return idx === undefined
      ? { crmField: rule.field, csvHeader: '', confidence: 'NONE' }
      : { crmField: rule.field, csvHeader: headers[idx].trim(), confidence: confidence[rule.field] };
  });

  return {
    fieldToIndex,
    followupToIndex,
    mappings,
    unmappedHeaders: columns.filter((c) => !claimed.has(c.index)).map((c) => c.header),
  };
}

/* ------------------------------------------------------------------------ */
/* Value normalisation                                                       */
/* ------------------------------------------------------------------------ */

const stageKey = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Common spellings seen in exports from other CRMs / spreadsheets → Amaya stage. Keys are `stageKey()` form. */
const STAGE_SYNONYMS: Record<string, string> = {};
const syn = (stage: string, words: string[]) => words.forEach((w) => (STAGE_SYNONYMS[stageKey(w)] = stage));
syn(STAGES.NEW, ['new', 'new lead', 'new enquiry', 'new inquiry', 'fresh', 'fresh lead', 'enquiry', 'inquiry', 'enquired', 'lead', 'unassigned', 'untouched', 'yet to contact', 'not contacted', 'uncontacted']);
syn(STAGES.OPEN, ['open', 'contacted', 'attempted contact', 'attempted', 'cold contact', 'cold', 'in progress', 'inprogress', 'follow up', 'followup', 'following up', 'in discussion', 'discussion', 'call back', 'callback', 'pending', 'working', 'active', 'in touch', 'connected', 'first call done', 'call done', 'ongoing']);
syn(STAGES.WARM, ['warm', 'interested', 'engaged', 'nurturing', 'considering', 'medium', 'moderate', 'lukewarm']);
syn(STAGES.HOT, ['hot', 'very interested', 'highly interested', 'site visit scheduled', 'visit scheduled', 'sv scheduled', 'scheduled', 'ready to visit', 'high', 'high priority', 'urgent', 'priority']);
syn(STAGES.QUALIFIED, ['qualified', 'site visit done', 'site visit completed', 'site visit complete', 'visit done', 'visit completed', 'visited', 'sv done', 'walk in', 'walkin', 'walk in done', 'negotiation', 'negotiating', 'under negotiation', 'booking in progress', 'booking under process', 'token', 'token paid', 'token received', 'advance paid', 'finalising', 'finalizing', 'closing']);
syn(STAGES.BOOKED, ['booked', 'booking done', 'booking confirmed', 'booking complete', 'booking completed', 'closed won', 'won', 'converted', 'conversion', 'sold', 'sale', 'sale done', 'agreement', 'agreement signed', 'registered', 'registration done']);
syn(STAGES.NOT_RESPONDING, ['not responding', 'no response', 'not reachable', 'unreachable', 'not answering', 'no answer', 'rnr', 'ringing no response', 'ring no response', 'switched off', 'not picking', 'not picking up', 'npc', 'nr', 'no reply', 'unresponsive', 'did not pick', 'call not answered', 'not connected']);
syn(STAGES.DND, ['dnd', 'do not disturb', 'do not call', 'dnc', 'dont call', 'do not contact', 'blocked', 'unsubscribed', 'opt out', 'opted out']);
syn(STAGES.JUNK, ['junk', 'spam', 'invalid', 'invalid number', 'wrong number', 'wrong no', 'incorrect number', 'fake', 'test', 'test lead', 'irrelevant', 'not relevant', 'bogus']);
syn(STAGES.DQ_BUDGET, ['disqualified budget', 'dq budget', 'budget', 'budget issue', 'budget mismatch', 'out of budget', 'over budget', 'low budget', 'budget constraint', 'price too high', 'expensive', 'too expensive', 'dq price', 'price', 'disqualified price', 'not affordable', 'cannot afford']);
syn(STAGES.DQ_LOCATION, ['disqualified location', 'dq location', 'location', 'location issue', 'location mismatch', 'wrong location', 'far', 'too far', 'distance', 'location not suitable', 'different location', 'other location', 'different city', 'other city', 'out of city', 'outstation']);
syn(STAGES.DQ_RENTAL, ['disqualified rental', 'disqualified rent', 'dq rental', 'dq rent', 'rental', 'rent', 'rent only', 'looking for rent', 'wants rent', 'rental enquiry', 'rental inquiry', 'rent enquiry', 'lease', 'on rent', 'for rent']);
syn(STAGES.TRASH, ['trash', 'trashed', 'bin', 'recycle bin', 'deleted', 'delete', 'removed']);

/**
 * Map a stage cell to a configured stage (case/punctuation-insensitive, common synonyms).
 * Unknown values are returned unchanged with `known: false` so the preview can flag them.
 * A blank cell stays blank — the server defaults new leads to "New" and ignores blanks on overwrite.
 */
export function normalizeStage(raw: string, knownStages: string[] = DEFAULT_CONFIG.options[F.STAGE]): { stage: string; known: boolean } {
  const s = String(raw ?? '').trim();
  if (!s) return { stage: '', known: true };
  const key = stageKey(s);
  const direct = knownStages.find((k) => stageKey(k) === key) || (Object.values(STAGES) as string[]).find((k) => stageKey(k) === key);
  if (direct) return { stage: direct, known: true };
  const mapped = STAGE_SYNONYMS[key];
  if (mapped) return { stage: mapped, known: true };
  return { stage: s, known: false };
}

/** Date-bearing lead fields the import may set (audit columns are server-managed). */
export const IMPORT_DATE_FIELDS: string[] = LEAD_DATE_FIELDS.filter((f) => f !== F.CREATED_AT && f !== F.UPDATED_AT);

// Wall-clock forms whose day/month we can verify after parsing (catches "31/02/2026" rolling into March).
const RE_WALL_DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ ,T]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)?$/;
const RE_WALL_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;

/**
 * Normalise a date cell to ISO. Accepts everything `parseDate` does (dd/MM/yyyy, yyyy-MM-dd,
 * "01 Oct 2026, 05:30 PM", ISO, Excel/Sheets serials…). Blank stays blank — never "today".
 * Returns `ok: false` for non-blank garbage or impossible calendar dates (the caller blanks the
 * field and warns).
 */
export function normalizeImportDate(raw: string): { iso: string; ok: boolean } {
  const s = String(raw ?? '').trim();
  if (!s) return { iso: '', ok: true };
  const bad = { iso: '', ok: false };
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!(n > 20000 && n < 80000)) return bad; // not a spreadsheet serial — "12" is not a date
    return { iso: normalizeDateValue(n), ok: true };
  }
  const d = parseDate(s);
  if (!d) return bad;
  const p = getParts(d);
  if (p.y < 1990 || p.y > 2100) return bad;
  let m: RegExpMatchArray | null;
  if ((m = s.match(RE_WALL_DMY))) {
    if (p.d !== +m[1] || p.m !== +m[2]) return bad;
  } else if ((m = s.match(RE_WALL_YMD))) {
    if (p.y !== +m[1] || p.m !== +m[2] || p.d !== +m[3]) return bad;
  }
  return { iso: d.toISOString(), ok: true };
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------------ */
/* Import analysis                                                           */
/* ------------------------------------------------------------------------ */

function emptyResult(errors: string[], partial: Partial<CSVParseResult> = {}): CSVParseResult {
  return {
    validLeads: [],
    brandNewLeads: [],
    conflicts: [],
    inFileDuplicates: [],
    errors,
    totalRowsParsed: 0,
    detectedHeaders: [],
    columnMappings: [],
    unmappedHeaders: [],
    followupColumns: [],
    unknownStages: [],
    previewRows: [],
    ...partial,
  };
}

/**
 * Parse CSV text, map columns, normalise every record into a Lead and analyse it against the
 * existing leads. Pure: nothing is written. The caller sends `validLeads` to the server.
 */
export function parseAndAnalyzeCSV(csvText: string, existingLeads: Lead[], options: ParseOptions = {}): CSVParseResult {
  const records = parseCsvText(csvText, options.delimiter);
  if (records.length < 2) {
    return emptyResult(['The file needs a header row and at least one data row.']);
  }

  const headerRow = records[0].map((h) => h.trim());
  const detectedHeaders = headerRow.filter((h) => h.length > 0);
  const mapping = mapHeaders(headerRow);
  const { fieldToIndex, followupToIndex } = mapping;
  const followupColumns = Object.keys(followupToIndex).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));

  const base = { detectedHeaders, columnMappings: mapping.mappings, unmappedHeaders: mapping.unmappedHeaders, followupColumns };

  if (fieldToIndex[F.NAME] === undefined) {
    return emptyResult([`No "${F.NAME}" column found. Add a header such as "Prospect Name", "Name" or "Customer Name".`], base);
  }

  const knownStages = options.stages && options.stages.length ? options.stages : DEFAULT_CONFIG.options[F.STAGE];

  // Raw-row keys: duplicate header names get a positional suffix so nothing is lost in the inspector.
  const rawKeys: Array<{ index: number; key: string }> = [];
  const seenKeys = new Map<string, number>();
  headerRow.forEach((h, index) => {
    if (!h) return;
    const count = (seenKeys.get(h) || 0) + 1;
    seenKeys.set(h, count);
    rawKeys.push({ index, key: count === 1 ? h : `${h} (${count})` });
  });

  // Lookups mirroring the server: Enquiry ID, then phone (exactly 10 digits).
  const existingById = new Map<string, Lead>();
  const existingByPhone = new Map<string, Lead>();
  const existingByEmail = new Map<string, Lead>();
  for (const l of existingLeads) {
    const id = String(l[F.ID] || '').trim().toLowerCase();
    if (id && !existingById.has(id)) existingById.set(id, l);
    const p = last10(l[F.PHONE]);
    if (p.length === 10 && !existingByPhone.has(p)) existingByPhone.set(p, l);
    const e = String(l[F.EMAIL] || '').trim().toLowerCase();
    if (e && !existingByEmail.has(e)) existingByEmail.set(e, l);
  }

  const seenFileIds = new Map<string, number>();
  const seenFilePhones = new Map<string, number>();

  const errors: string[] = [];
  const previewRows: CSVRowPreview[] = [];
  const validLeads: Lead[] = [];
  const brandNewLeads: Lead[] = [];
  const conflicts: ImportConflictItem[] = [];
  const inFileDuplicates: CSVRowPreview[] = [];
  const unknownStages = new Set<string>();

  const cellAt = (values: string[], index: number | undefined) => (index === undefined ? '' : String(values[index] ?? '').trim());

  for (let r = 1; r < records.length; r++) {
    const values = records[r];
    const rowIndex = r + 1;

    const raw: Record<string, string> = {};
    for (const { index, key } of rawKeys) raw[key] = String(values[index] ?? '').trim();

    const name = cellAt(values, fieldToIndex[F.NAME]);
    if (!name) {
      errors.push(`Row ${rowIndex}: skipped — ${F.NAME} is empty.`);
      continue;
    }

    const warnings: string[] = [];
    const lead: Record<string, string> = {};
    for (const field of IMPORTABLE_FIELDS) lead[field] = cellAt(values, fieldToIndex[field]);
    lead[F.NAME] = name;

    // Phone
    const phoneDigits = digitsOnly(lead[F.PHONE]);
    if (!lead[F.PHONE]) warnings.push('Phone number is missing.');
    else if (phoneDigits.length < 10) warnings.push(`Phone number has only ${phoneDigits.length} digits.`);
    else if (phoneDigits.length > 13) warnings.push(`Phone number has ${phoneDigits.length} digits — please check it.`);

    // Email
    if (lead[F.EMAIL] && !RE_EMAIL.test(lead[F.EMAIL])) warnings.push(`Email "${lead[F.EMAIL]}" does not look valid.`);

    // Stage
    const stageInfo = normalizeStage(lead[F.STAGE], knownStages);
    lead[F.STAGE] = stageInfo.stage;
    if (!stageInfo.known) {
      unknownStages.add(stageInfo.stage);
      warnings.push(`Stage "${stageInfo.stage}" is not a configured stage — it will be imported as typed.`);
    }

    // Dates → ISO; blanks stay blank (the server stamps the Enquiry Date on create).
    for (const field of IMPORT_DATE_FIELDS) {
      if (fieldToIndex[field] === undefined) continue;
      const original = lead[field];
      const { iso, ok } = normalizeImportDate(original);
      if (!ok) warnings.push(`Could not read ${field} "${original}" — left blank.`);
      lead[field] = iso;
    }

    // Follow-up N columns
    for (const field of followupColumns) {
      const v = cellAt(values, followupToIndex[field]);
      if (v) lead[field] = v;
    }

    // Conflict analysis (Enquiry ID first, then phone — same order as the server).
    const incomingId = lead[F.ID].toLowerCase();
    const incomingPhone = last10(lead[F.PHONE]);
    let matchedExisting: Lead | undefined;
    let conflictReason: ConflictReason | undefined;
    if (incomingId && existingById.has(incomingId)) {
      matchedExisting = existingById.get(incomingId);
      conflictReason = 'ID_MATCH';
    } else if (incomingPhone.length === 10 && existingByPhone.has(incomingPhone)) {
      matchedExisting = existingByPhone.get(incomingPhone);
      conflictReason = 'PHONE_MATCH';
    }
    if (incomingId && conflictReason !== 'ID_MATCH') {
      // Unknown ID: the server assigns IDs, so never carry a foreign one in.
      warnings.push(`${F.ID} "${lead[F.ID]}" is not in the CRM — a new ID will be assigned.`);
      lead[F.ID] = '';
    }
    const email = lead[F.EMAIL].toLowerCase();
    if (!matchedExisting && email && existingByEmail.has(email)) {
      const other = existingByEmail.get(email)!;
      warnings.push(`Email matches ${other[F.ID]} (${other[F.NAME]}) — the server matches on Enquiry ID and phone only, so this row is treated as new.`);
    }

    // In-file duplicates (same Enquiry ID as typed, or same phone, as an earlier row) are not sent:
    // the server would reject the second copy with a phone conflict and abort the whole batch.
    let duplicateOfRow: number | undefined;
    let duplicateKey: 'Enquiry ID' | 'phone number' = 'phone number';
    if (incomingId && seenFileIds.has(incomingId)) {
      duplicateOfRow = seenFileIds.get(incomingId);
      duplicateKey = 'Enquiry ID';
    } else if (incomingPhone.length === 10 && seenFilePhones.has(incomingPhone)) {
      duplicateOfRow = seenFilePhones.get(incomingPhone);
    }

    const typedLead = lead as unknown as Lead;
    let status: PreviewStatus;
    if (duplicateOfRow !== undefined) {
      status = 'DUPLICATE';
      warnings.unshift(`Duplicate of row ${duplicateOfRow} in this file (same ${duplicateKey}) — not imported.`);
    } else {
      if (incomingId) seenFileIds.set(incomingId, rowIndex);
      if (incomingPhone.length === 10) seenFilePhones.set(incomingPhone, rowIndex);
      status = matchedExisting ? 'UPDATE' : 'NEW';
    }

    const preview: CSVRowPreview = {
      rowIndex,
      lead: typedLead,
      raw,
      status,
      conflictReason: status === 'UPDATE' ? conflictReason : undefined,
      matchedExisting: status === 'UPDATE' ? matchedExisting : undefined,
      duplicateOfRow,
      warnings,
      unknownStage: !stageInfo.known || undefined,
    };
    previewRows.push(preview);

    if (status === 'DUPLICATE') {
      inFileDuplicates.push(preview);
    } else {
      validLeads.push(typedLead);
      if (status === 'UPDATE' && matchedExisting && conflictReason) conflicts.push({ incoming: typedLead, existing: matchedExisting, reason: conflictReason, rowIndex });
      else brandNewLeads.push(typedLead);
    }
  }

  return {
    ...emptyResult(errors, base),
    validLeads,
    brandNewLeads,
    conflicts,
    inFileDuplicates,
    totalRowsParsed: records.length - 1,
    unknownStages: Array.from(unknownStages),
    previewRows,
  };
}

/* ------------------------------------------------------------------------ */
/* Export                                                                    */
/* ------------------------------------------------------------------------ */

const isFollowupHeader = (h: string) => /^Follow-up \d+$/.test(h);
const followupNumber = (h: string) => Number(h.replace(/\D/g, ''));

/**
 * Every column present in the data: base headers first (always, so an export re-imports cleanly),
 * then Follow-up 1..N in numeric order, then any other sheet column alphabetically.
 */
export function collectExportHeaders(leads: Lead[]): string[] {
  const seen = new Set<string>(LEAD_BASE_HEADERS);
  const followups = new Set<string>();
  const extras = new Set<string>();
  for (const l of leads) {
    for (const k of Object.keys(l)) {
      if (k.startsWith('_') || seen.has(k)) continue;
      const v = (l as Record<string, unknown>)[k];
      if (v === undefined || v === null || v === '') continue;
      if (isFollowupHeader(k)) followups.add(k);
      else extras.add(k);
    }
  }
  return [
    ...LEAD_BASE_HEADERS,
    ...Array.from(followups).sort((a, b) => followupNumber(a) - followupNumber(b)),
    ...Array.from(extras).sort((a, b) => a.localeCompare(b)),
  ];
}

/** CSV text (with BOM) for `leads`; date fields are rendered with `formatDateTime`. */
export function buildLeadsCsv(leads: Lead[], headers: string[] = collectExportHeaders(leads)): string {
  const dateFields = new Set<string>(LEAD_DATE_FIELDS);
  const rows = leads.map((l) => {
    const row: Record<string, unknown> = {};
    for (const h of headers) {
      const v = (l as Record<string, unknown>)[h];
      row[h] = dateFields.has(h) ? formatDateTime(v as string, v === undefined || v === null ? '' : String(v)) : v ?? '';
    }
    return row;
  });
  return toCsv(headers, rows);
}

export function defaultExportFilename(prefix = 'Leads'): string {
  return `${prefix}_${dateKey(new Date())}.csv`;
}

/** Download every lead as CSV. Exports all columns present in the data, including Follow-up N. */
export function exportLeadsToCSV(leads: Lead[], filename: string = defaultExportFilename(), headers?: string[]): boolean {
  if (!leads.length) return false;
  downloadText(filename, buildLeadsCsv(leads, headers));
  return true;
}

/* ------------------------------------------------------------------------ */
/* Sample template                                                           */
/* ------------------------------------------------------------------------ */

/** Columns a user fills in. Enquiry ID is included (blank) so exports round-trip; audit columns are not. */
export const TEMPLATE_HEADERS: string[] = LEAD_BASE_HEADERS.filter((h) => h !== F.CREATED_AT && h !== F.UPDATED_AT && h !== F.UPDATED_BY);

/** Sample import CSV built only from DEFAULT_CONFIG option values and LEAD_BASE_HEADERS. */
export function generateSampleCSVTemplate(now: Date = new Date()): string {
  const opt = (field: string, i: number) => {
    const list = DEFAULT_CONFIG.options[field] || [];
    return list.length ? list[i % list.length] : '';
  };
  const sample = (i: number, values: Partial<Record<string, string>>): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    for (const h of TEMPLATE_HEADERS) row[h] = values[h] ?? '';
    row[F.STAGE] = values[F.STAGE] ?? opt(F.STAGE, i);
    row[F.SOURCE] = values[F.SOURCE] ?? opt(F.SOURCE, i);
    row[F.UNIT_TYPE] = normalizeUnitType(values[F.UNIT_TYPE] ?? opt(F.UNIT_TYPE, i));
    row[F.PURCHASE_OR_RENT] = values[F.PURCHASE_OR_RENT] ?? opt(F.PURCHASE_OR_RENT, 0);
    row[F.SITE_VISIT_STATUS] = values[F.SITE_VISIT_STATUS] ?? opt(F.SITE_VISIT_STATUS, i);
    row[F.RELATIONSHIP] = values[F.RELATIONSHIP] ?? opt(F.RELATIONSHIP, i);
    row[F.ENQUIRED_FOR] = values[F.ENQUIRED_FOR] ?? opt(F.ENQUIRED_FOR, i);
    row[F.BROCHURE] = values[F.BROCHURE] ?? opt(F.BROCHURE, i);
    row[F.RM] = values[F.RM] ?? opt(F.RM, i);
    return row;
  };
  const rows = [
    sample(0, {
      [F.ENQUIRY_DATE]: toSheetDateTime(now),
      [F.NAME]: 'Sample Prospect One',
      [F.PHONE]: '+91 98765 43210',
      [F.EMAIL]: 'prospect.one@example.com',
      [F.NEXT_FOLLOWUP]: toSheetDateTime(addDays(now, 2)),
      [F.NOTES]: 'Enquired for parents; prefers a lower floor.',
    }),
    sample(1, {
      [F.ENQUIRY_DATE]: toSheetDateTime(now),
      [F.NAME]: 'Sample Prospect Two',
      [F.PHONE]: '+91 91234 56789',
      [F.EMAIL]: 'prospect.two@example.com',
      [F.NEXT_FOLLOWUP]: toSheetDateTime(addDays(now, 3)),
      [F.NOTES]: 'Leave Enquiry ID blank — the CRM assigns it on import.',
    }),
    sample(2, {
      [F.ENQUIRY_DATE]: toSheetDateTime(addDays(now, -1)),
      [F.NAME]: 'Sample Prospect Three',
      [F.PHONE]: '+91 99887 76655',
      [F.EMAIL]: '',
      [F.NEXT_FOLLOWUP]: toSheetDateTime(addDays(now, 1)),
      [F.NOTES]: 'Dates may be dd/MM/yyyy, yyyy-MM-dd HH:mm or "01 Oct 2026, 05:30 PM".',
    }),
  ];
  return toCsv(TEMPLATE_HEADERS, rows);
}

export function downloadSampleTemplate(filename = 'Leads_Import_Template.csv') {
  downloadText(filename, generateSampleCSVTemplate());
}

/* ------------------------------------------------------------------------ */
/* Compatibility facade                                                      */
/* ------------------------------------------------------------------------ */

/** Static facade kept for callers that import `CSVService`. The named exports above are preferred. */
export class CSVService {
  public static generateSampleCSVTemplate = generateSampleCSVTemplate;
  public static exportLeadsToCSV = exportLeadsToCSV;
  public static parseAndAnalyzeCSV = parseAndAnalyzeCSV;
  public static parseCsvText = parseCsvText;
  public static mapHeaders = mapHeaders;
  public static normalizeStage = normalizeStage;
  public static collectExportHeaders = collectExportHeaders;
  public static buildLeadsCsv = buildLeadsCsv;
}
