/**
 * Message-template import — turns a Word (.docx), Excel (.xlsx), CSV or text/Markdown file into template drafts
 * that the user reviews before anything is saved.
 *
 * Pure and DOM-free: one small XML walker runs in the browser and in Node, so the code the tests exercise is
 * exactly the code users run (there is no separate DOMParser branch).
 *
 *  .docx  word/document.xml → paragraphs (heading level, bold, list numbering, links) and tables.
 *         One template per heading (Heading 1–9 / Title / outline-level styles). When styles don't split the
 *         document: all-bold short lines, then (only without blank-line structure) short "Label:" lines.
 *         Without headings, blank paragraphs separate templates and a short first line is the name.
 *         A table whose header has a Name and a Message column maps row by row (optional Type/Channel column).
 *         A heading with nothing under it ("Email scripts") is a container: its channel types the templates below.
 *  .xlsx  every visible sheet: a header row (Type | Name | Message and synonyms, or one column per channel) or,
 *         without one, the column rules — 1 = message, 2 = name + message, 3 = type + name + message.
 *  .csv / .tsv   the same column rules.   .txt / .md   "# Heading" sections, else blank-line blocks.
 *
 * Every draft is cleaned (whitespace, 4,000-character cap), its type normalised (WhatsApp, Email, SMS, Call,
 * Follow-up, Site Visit) and its merge fields rewritten to the tokens the app fills: {name}, {rm}, {unit}.
 */
import { unzipSync } from 'fflate';

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

export interface ParsedTemplate {
  type: string;
  name: string;
  message: string;
  /** Where the template was found, e.g. "Paragraph 12", "Table 1 · row 3", "Sheet1 · row 4". */
  source: string;
  /** Review hints: placeholders the app will not fill, a shortened message… */
  notes?: string[];
  /** Probably not a template (text outside the headings) — the review starts with it unticked. */
  unsure?: boolean;
}

export interface TemplateFileInput {
  name: string;
  bytes: Uint8Array | ArrayBuffer;
  /** Already-decoded text for .csv / .txt / .md (skips encoding detection). Ignored for Word/Excel. */
  text?: string;
}

export interface ParseTemplateOptions {
  /** Type for templates the file does not classify. Default "WhatsApp". */
  defaultType?: string;
  /** The app's existing types, so "follow up" in a file reuses an existing "Follow-up" spelling. */
  knownTypes?: string[];
}

export type TemplateFileFormat = 'docx' | 'xlsx' | 'csv' | 'text';

export interface TemplateFileParseResult {
  format: TemplateFileFormat;
  templates: ParsedTemplate[];
  /** File-level notices: sheets skipped, duplicates left out, list capped… */
  warnings: string[];
  /** Templates found before the per-file cap was applied. */
  totalFound: number;
}

/** A problem the user can fix (old format, damaged file…). `message` is ready to show as-is. */
export class TemplateImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateImportError';
  }
}

export const MAX_TEMPLATES_PER_FILE = 200;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_TEMPLATE_NAME_LENGTH = 120;
export const MAX_TEMPLATE_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_TEMPLATE_TYPE = 'WhatsApp';
export const TEMPLATE_IMPORT_TIP = 'Tip: one heading per template in Word; in Excel use columns Type | Name | Message.';
export const TEMPLATE_FILE_ACCEPT = [
  '.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.xltx', '.csv', '.tsv', '.txt', '.md', '.markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/tab-separated-values', 'text/plain', 'text/markdown',
].join(',');

/**
 * Merge fields → app tokens. Only the tokens the app fills wherever a template is used are targets:
 * `fillTemplate` (core/phone) replaces any `{word}` with the caller's value or '' — the Templates preview passes
 * name/rm/unit/time/project, Chat360 compose passes only name/rm/unit. Rewriting "[Date]" or "[Project]" to a
 * token would turn a visible blank into an empty string in a sent message, so those are left as typed and flagged.
 */
const PLACEHOLDER_ALIASES: Record<string, 'name' | 'rm' | 'unit'> = {
  ...aliases('name', [
    'name', 'customer', 'customer name', 'customers name', 'customer first name', 'customer full name', 'client', 'client name',
    'clients name', 'prospect', 'prospect name', 'lead name', 'first name', 'full name', 'guest name', 'recipient name',
    'contact name', 'buyer name',
  ]),
  ...aliases('rm', [
    'rm', 'rm name', 'relationship manager', 'relationship manager name', 'agent', 'agent name', 'sales manager',
    'sales executive', 'executive name', 'your name', 'my name', 'sender', 'sender name', 'consultant', 'consultant name',
    'advisor', 'advisor name', 'adviser', 'adviser name', 'salesperson', 'representative',
  ]),
  ...aliases('unit', ['unit', 'unit type', 'unit name', 'unit configuration', 'flat type', 'apartment type', 'configuration', 'bhk', 'bhk type', 'home type', 'residence type']),
};
/** Tokens the Templates view advertises — already in app style, never flagged. */
const APP_TOKENS = new Set(['name', 'rm', 'unit', 'time']);

export async function parseTemplateFile(file: TemplateFileInput, options: ParseTemplateOptions = {}): Promise<ParsedTemplate[]> {
  return (await parseTemplateFileDetailed(file, options)).templates;
}

export async function parseTemplateFileDetailed(file: TemplateFileInput, options: ParseTemplateOptions = {}): Promise<TemplateFileParseResult> {
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
  const ext = fileExtension(file.name);
  const warnings: string[] = [];
  if (!bytes.length && !file.text) throw new TemplateImportError('The file is empty.');
  if (bytes.length > MAX_TEMPLATE_FILE_BYTES) {
    throw new TemplateImportError(`The file is larger than ${MAX_TEMPLATE_FILE_BYTES / (1024 * 1024)} MB. Split it into smaller files and try again.`);
  }

  if (isZip(bytes)) {
    const pkg = openPackage(bytes);
    if (pkg.kind === 'docx') return finalise(flowToDrafts(docxFlow(readDocx(pkg))), 'docx', warnings, options);
    return finalise(readXlsx(pkg, warnings), 'xlsx', warnings, options);
  }

  assertPlainText(bytes, ext);
  const text = file.text ?? decodeText(bytes);
  const isMarkdown = ext === 'md' || ext === 'markdown';
  if (ext === 'csv' || ext === 'tsv' || (!isMarkdown && looksTabSeparated(text))) {
    return finalise(readDelimited(text, ext === 'csv' ? undefined : '\t'), 'csv', warnings, options);
  }
  return finalise(flowToDrafts(textFlow(text)), 'text', warnings, options);
}

/** Normalise a type/channel label: whatsapp/wa → WhatsApp, email/mail → Email, sms → SMS, call → Call… */
export function normaliseTemplateType(raw: string | null | undefined, fallback: string = DEFAULT_TEMPLATE_TYPE, knownTypes: string[] = []): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  const synonym = typeSynonym(s);
  const canonical = synonym ?? s;
  const known = knownTypes.find((k) => compactKey(k) === compactKey(canonical));
  if (known && known.trim()) return known.trim();
  if (synonym) return synonym;
  const capped = s.length > 40 ? s.slice(0, 40).trim() : s;
  return capped === capped.toLowerCase() ? capped.charAt(0).toUpperCase() + capped.slice(1) : capped;
}

/** Rewrite merge fields such as {{customer_name}}, [Name], <RM>, «FirstName» to {name}, {rm}, {unit}; leave others. */
export function normalisePlaceholders(text: string): string {
  return String(text ?? '').replace(PLACEHOLDER, (match: string, ...rest: unknown[]) => {
    const p = readPlaceholder(rest, match);
    if (!p) return match;
    const alias = PLACEHOLDER_ALIASES[p.compact];
    if (alias) return `{${alias}}`;
    if (p.form === 'brace' && APP_TOKENS.has(p.compact)) return `{${p.compact}}`; // {{time}}, {Time} → {time}
    return match;
  });
}

/** Placeholders the app will not fill on its own (e.g. "[Date]", "{{project}}"), in order of appearance. */
export function findUnfilledPlaceholders(text: string): string[] {
  const found: string[] = [];
  String(text ?? '').replace(PLACEHOLDER, (match: string, ...rest: unknown[]) => {
    const p = readPlaceholder(rest, match);
    if (p && !(p.exactBrace && APP_TOKENS.has(p.key)) && !found.includes(match)) found.push(match);
    return match;
  });
  return found;
}

/** Identity used to skip templates that already exist: case-insensitive name + whitespace-insensitive message. */
export function templateFingerprint(name: string, message: string): string {
  return `${String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}\u0000${String(message ?? '').replace(/\s+/g, ' ').trim()}`;
}

/* ------------------------------------------------------------------------ */
/* Drafts → templates                                                        */
/* ------------------------------------------------------------------------ */

interface Draft {
  name: string;
  message: string;
  source: string;
  /** Explicit type from the file (Type column, channel column, "Type:" line, "Email: …" heading). */
  type?: string;
  /** Type implied by the surroundings (container heading, sheet name/title). */
  hint?: string;
  /** Read "Type:" / "Name:" / "Message:" lines at the top of the message. */
  meta?: boolean;
  unsure?: boolean;
}

function finalise(drafts: Draft[], format: TemplateFileFormat, warnings: string[], options: ParseTemplateOptions): TemplateFileParseResult {
  const knownTypes = options.knownTypes ?? [];
  const fallback = normaliseTemplateType(options.defaultType || DEFAULT_TEMPLATE_TYPE, DEFAULT_TEMPLATE_TYPE, knownTypes);
  const templates: ParsedTemplate[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let shortened = 0;

  for (const raw of drafts) {
    const d = raw.meta ? applyMeta(raw) : raw;
    let message = normalisePlaceholders(cleanMessage(d.message));
    if (!message) continue;
    let name = cleanName(d.name);
    let explicitType = d.type?.trim() || '';
    if (!explicitType && name) {
      const split = splitTypePrefix(name);
      if (split.type) {
        explicitType = split.type;
        name = cleanName(split.name);
      }
    }
    if (!name) name = deriveName(message, templates.length + 1);
    const type = normaliseTemplateType(explicitType || d.hint || '', fallback, knownTypes);

    const notes: string[] = [];
    if (d.unsure) notes.push('Looks like an introduction or a note rather than a template');
    if (message.length > MAX_MESSAGE_LENGTH) {
      message = truncateText(message, MAX_MESSAGE_LENGTH);
      notes.push(`Shortened to ${MAX_MESSAGE_LENGTH.toLocaleString('en-GB')} characters`);
      shortened++;
    }
    const unfilled = findUnfilledPlaceholders(message);
    if (unfilled.length) notes.push(`Not filled in automatically: ${unfilled.slice(0, 6).join(', ')}${unfilled.length > 6 ? '…' : ''}`);

    const key = `${type}\u0000${templateFingerprint(name, message)}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const tpl: ParsedTemplate = { type, name, message, source: d.source };
    if (notes.length) tpl.notes = notes;
    if (d.unsure) tpl.unsure = true;
    templates.push(tpl);
  }

  const totalFound = templates.length;
  if (duplicates) warnings.push(`${duplicates} duplicate ${duplicates === 1 ? 'template was' : 'templates were'} left out.`);
  if (shortened) warnings.push(`${shortened} ${shortened === 1 ? 'message was' : 'messages were'} longer than ${MAX_MESSAGE_LENGTH.toLocaleString('en-GB')} characters and ${shortened === 1 ? 'has' : 'have'} been shortened.`);
  if (templates.length > MAX_TEMPLATES_PER_FILE) {
    warnings.push(`Found ${totalFound} templates — only the first ${MAX_TEMPLATES_PER_FILE} are listed. Split the file to import the rest.`);
    templates.length = MAX_TEMPLATES_PER_FILE;
  }
  return { format, templates, warnings, totalFound };
}

const META_LINE = /^(type|channel|medium|name|title|template name|message|script|text|body)\s*[:=]\s*(.*)$/i;

/** "Type: Email" / "Name: Welcome" / "Message: Hello…" lines at the top of a section or block. */
function applyMeta(d: Draft): Draft {
  const lines = d.message.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  let type = d.type;
  let name = d.name;
  for (let n = 0; n < 3 && i < lines.length; n++) {
    const m = META_LINE.exec(lines[i].trim());
    if (!m) break;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (/^(message|script|text|body)$/.test(key)) {
      lines[i] = value;
      break;
    }
    if (!value || value.length > 120 || hasPlaceholder(value)) break;
    if (/^(type|channel|medium)$/.test(key)) {
      if (value.length > 40) break;
      type = type || value;
    } else {
      name = name || value;
    }
    i++;
  }
  return { ...d, type, name, message: lines.slice(i).join('\n') };
}

function cleanMessage(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n?|[\u2028\u2029\u000B\u000C]/g, '\n')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B\uFEFF\u00AD]/g, '')
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '')
    .replace(/[ ]*\t[ \t]*/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanName(raw: string): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^#{1,6}\s+/, '');
  for (let i = 0; i < 2; i++) s = s.replace(/^(\*\*|__|\*|_|~~)(.+)\1$/, '$2').trim();
  s = s.replace(/^(?:[•▪◦·●○■□➤►▶✓✔]\s*|[-*]\s+)/, '');
  s = s.replace(/^(?:\(?\d{1,3}[.)]|Q\d{1,3}[.:)])\s+/i, '');
  s = s.replace(/[\s:–—-]+$/, '').trim();
  if (s.length > MAX_TEMPLATE_NAME_LENGTH) s = `${s.slice(0, MAX_TEMPLATE_NAME_LENGTH - 1).trimEnd()}…`;
  return s;
}

/** "NEW-01", "CALL-01", "COMM-00B", "SV 03" — a script reference, not a script. */
export function looksLikeTemplateCode(value: string): boolean {
  return /^[A-Z]{2,8}[ -]?\d{1,3}[A-Z]?$/.test(value.trim());
}

/** Up to `n` distinct template codes from a sheet's code-like columns (≥ 70 % codes), in row order. */
function sampleCodes(sheet: { rows: string[][]; header: HeaderMatch | null }, n: number): string[] {
  const start = sheet.header ? sheet.header.index + 1 : 0;
  const body = sheet.rows.slice(start);
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  for (let col = 0; col < width; col++) {
    const values = body.map((r) => (r[col] ?? '').trim()).filter(Boolean);
    if (values.length < 3 || values.filter(looksLikeTemplateCode).length < values.length * 0.7) continue;
    const out: string[] = [];
    for (const v of values) {
      if (looksLikeTemplateCode(v) && !out.includes(v)) out.push(v);
      if (out.length >= n) break;
    }
    return out;
  }
  return [];
}

/** First six words of the message's first line, else "Template N". */
function deriveName(message: string, n: number): string {
  const first = message.split('\n').find((line) => line.trim()) ?? '';
  const words = first.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return `Template ${n}`;
  const name = words.slice(0, 6).join(' ').replace(/[\s,;:.!?–—-]+$/, '');
  return cleanName(words.length > 6 ? `${name}…` : name) || `Template ${n}`;
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 1;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--; // never split an emoji's surrogate pair
  return `${s.slice(0, cut).trimEnd()}…`;
}

/* ------------------------------------------------------------------------ */
/* Types, hints, placeholders                                                */
/* ------------------------------------------------------------------------ */

const TYPE_SYNONYMS: Array<[RegExp, string]> = [
  [/^(whats ?app|wa|wapp|whatsapp business)( (message|messages|msg|msgs|text|template|templates|script|scripts|chat))?$/, 'WhatsApp'],
  [/^(e ?mails?|mails?|mailers?|e ?mail (message|messages|template|templates|body|script|scripts))$/, 'Email'],
  [/^(sms|text messages?|sms (text|message|messages|template|templates))$/, 'SMS'],
  [/^(calls?|calling|phone|phone calls?|tele ?calls?|tele ?calling|voice calls?|(call|calling|phone) scripts?)$/, 'Call'],
  [/^(follow ?ups?|follow ?up (message|messages|template|templates|script|scripts))$/, 'Follow-up'],
  [/^(site ?visits?|site ?visit (message|messages|template|templates|script|scripts))$/, 'Site Visit'],
  [/^(general|generic)$/, 'General'],
];

function typeSynonym(raw: string): string | undefined {
  const key = raw.toLowerCase().replace(/[_./|\-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key) return undefined;
  for (const [re, type] of TYPE_SYNONYMS) if (re.test(key)) return type;
  return undefined;
}

const HINT_PATTERNS: Array<[RegExp, string]> = [
  [/\bwhats\s*app\b|\bwa\b/i, 'WhatsApp'],
  [/\be-?mails?\b|\bmailers?\b|\bmail\b/i, 'Email'],
  [/\bsms\b/i, 'SMS'],
  [/\bfollow[\s-]?ups?\b/i, 'Follow-up'],
  [/\bsite[\s-]?visits?\b/i, 'Site Visit'],
  [/\b(?:tele-?)?call(?:s|ing)?\b|\bphone\b/i, 'Call'],
];

/** The channel a heading/sheet/column title talks about — the earliest mention wins ("Follow-up after call" → Follow-up). */
function detectTypeHint(text: string): string | undefined {
  let best: { index: number; type: string } | undefined;
  for (const [re, type] of HINT_PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { index: m.index, type };
  }
  return best?.type;
}

/** "[Email] Brochure follow-up", "WhatsApp – Welcome", "SMS: Reminder" → explicit type + the rest as the name. */
function splitTypePrefix(name: string): { type?: string; name: string } {
  const m = /^\s*[[(]\s*([^\])]{2,24}?)\s*[\])]\s*[:\-–—|]?\s*(.+)$/.exec(name) ?? /^\s*([A-Za-z][A-Za-z -]{0,22}?)\s*[:–—|-]\s+(.+)$/.exec(name);
  if (!m) return { name };
  const type = typeSynonym(m[1]);
  if (!type) return { name };
  const rest = m[2].trim();
  return { type, name: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

const PLACEHOLDER =
  /\{\{\s*([^{}\n]{1,40}?)\s*\}\}|\{\s*([^{}\n]{1,40}?)\s*\}|\[\[\s*([^[\]\n]{1,40}?)\s*\]\]|\[\s*([^[\]\n]{1,40}?)\s*\]|<<\s*([^<>\n]{1,40}?)\s*>>|«\s*([^«»\n]{1,40}?)\s*»|<\s*([^<>\n]{1,40}?)\s*>/g;
const HTML_TAG = /^(p|br|b|i|u|a|em|strong|div|span|li|ul|ol|h[1-6]|img|table|tr|td|th|hr|small|sup|sub|font|center|body|html)$/i;

interface Placeholder {
  key: string;
  compact: string;
  form: 'brace' | 'square' | 'angle' | 'guillemet';
  /** Written exactly like an app token: single braces. */
  exactBrace: boolean;
}

/** `rest` = the capture groups, offset and input of a PLACEHOLDER match (String.replace callback arguments). */
function readPlaceholder(rest: unknown[], match: string): Placeholder | null {
  const groups = rest.slice(0, 7) as Array<string | undefined>;
  const offset = rest[7] as number;
  const input = rest[8] as string;
  const i = groups.findIndex((g) => g !== undefined);
  if (i < 0) return null;
  const key = String(groups[i]).trim();
  const form = i <= 1 ? 'brace' : i <= 3 ? 'square' : i === 5 ? 'guillemet' : 'angle';
  if (!(form === 'brace' ? /^[A-Za-z0-9][\w .&'’-]*$/ : /^[A-Za-z][\w .&'’-]*$/).test(key)) return null;
  if (key.split(/\s+/).length > 5) return null;
  if (form === 'square' && input.charAt(offset + match.length) === '(') return null; // Markdown link [text](url)
  if (form === 'angle' && HTML_TAG.test(key)) return null;
  return { key, compact: compactKey(key), form, exactBrace: i === 1 };
}

function hasPlaceholder(text: string): boolean {
  let hit = false;
  text.replace(PLACEHOLDER, (match: string, ...rest: unknown[]) => {
    if (readPlaceholder(rest, match)) hit = true;
    return match;
  });
  return hit;
}

function aliases<T extends string>(token: T, keys: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) out[compactKey(k)] = token;
  return out;
}

function compactKey(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ------------------------------------------------------------------------ */
/* Headings, sections and blocks (Word + text share this)                    */
/* ------------------------------------------------------------------------ */

interface ColumnPlan {
  type?: number;
  name?: number;
  messages: Array<{ col: number; channel?: string; label: string }>;
}

interface RowsItem {
  kind: 'rows';
  rows: string[][];
  plan: ColumnPlan;
  headerIndex: number;
  source: string;
}

type FlowItem = { kind: 'heading'; text: string; level: number; source: string } | { kind: 'para'; text: string; source: string } | RowsItem;

const SEPARATOR_LINE = /^\s*([-*_=~•·])(?:\s*\1){2,}\s*$/;
const GREETING = /^(hi+|hello|hey|dear|namaste|namaskar(am)?|greetings|good\s+(morning|afternoon|evening|day)|thank\s*you|thanks|regards|warm\s+regards|best\s+regards|kind\s+regards|cheers)\b/i;

/** A short single line that could be a template name: no sentence punctuation, no placeholder. */
function isLabelLike(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 80 || t.includes('\n')) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/[,;.!?…]$/.test(t)) return false;
  if (t.split(/\s+/).length > 12) return false;
  return !hasPlaceholder(t);
}

/** First line of a block that names it — also not a greeting ("Hello {name}," / "Thank you for…" open a message). */
function looksLikeTitle(raw: string): boolean {
  return isLabelLike(raw) && !GREETING.test(raw.trim());
}

function hasTextBeforeNextHeading(items: FlowItem[], from: number): boolean {
  for (let j = from; j < items.length; j++) {
    const it = items[j];
    if (it.kind !== 'para') return false;
    if (it.text.trim() && !SEPARATOR_LINE.test(it.text)) return true;
  }
  return false;
}

/** The next heading/table after heading `i` is a deeper heading or a template table. */
function opensSubsections(items: FlowItem[], i: number): boolean {
  const own = items[i];
  if (own.kind !== 'heading') return false;
  for (let j = i + 1; j < items.length; j++) {
    const it = items[j];
    if (it.kind === 'rows') return true;
    if (it.kind === 'heading') return it.level > own.level;
  }
  return false;
}

function flowToDrafts(items: FlowItem[]): Draft[] {
  const out: Draft[] = [];
  const structured = items.some((it) => it.kind !== 'para');
  // A heading with no text before the next heading/table is a container ("Email scripts"): its channel applies to
  // the templates beneath it, and — for flat documents where everything is Heading 1 — to same-level siblings.
  const container = items.map((it, i) => it.kind === 'heading' && !hasTextBeforeNextHeading(items, i + 1));
  // Text under a heading that has sub-headings (or a template table) below it is usually an introduction.
  const parent = items.map((it, i) => it.kind === 'heading' && opensSubsections(items, i));
  const stack: Array<{ level: number; hint?: string; container: boolean }> = [];
  const nearestHint = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].hint) return stack[i].hint;
    return undefined;
  };
  let section: { name: string; source: string; hint?: string; unsure: boolean; lines: string[] } | null = null;
  let loose: Array<{ text: string; source: string }> = [];

  const flush = () => {
    if (section) {
      const message = section.lines.join('\n');
      if (message.trim()) out.push({ name: section.name, message, source: section.source, hint: section.hint, unsure: section.unsure, meta: true });
      section = null;
    }
    if (loose.length) {
      out.push(...blocksToDrafts(loose, nearestHint(), structured));
      loose = [];
    }
  };

  items.forEach((it, i) => {
    if (it.kind === 'heading') {
      flush();
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.level > it.level || (top.level === it.level && (container[i] || !top.container))) stack.pop();
        else break;
      }
      section = { name: it.text, source: it.source, hint: nearestHint(), unsure: parent[i], lines: [] };
      stack.push({ level: it.level, hint: detectTypeHint(it.text), container: container[i] });
    } else if (it.kind === 'rows') {
      flush();
      out.push(...draftsFromRows(it.rows, it.plan, it.headerIndex + 1, nearestHint(), (r, label) => `${it.source} · row ${r + 1}${label ? ` · ${label}` : ''}`));
    } else {
      const text = SEPARATOR_LINE.test(it.text) ? '' : it.text;
      if (section) section.lines.push(text);
      else loose.push({ text, source: it.source });
    }
  });
  flush();
  return out;
}

/** Blank lines/paragraphs separate templates; a short first line names the block. */
function blocksToDrafts(units: Array<{ text: string; source: string }>, hint: string | undefined, unsure: boolean): Draft[] {
  const blocks: Array<Array<{ text: string; source: string }>> = [];
  let current: Array<{ text: string; source: string }> = [];
  for (const u of units) {
    if (!u.text.trim()) {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(u);
    }
  }
  if (current.length) blocks.push(current);
  return blocks.map((block) => {
    const first = block[0].text.trim();
    const titled = block.length > 1 && looksLikeTitle(first) && !META_LINE.test(first);
    return {
      name: titled ? first : '',
      message: (titled ? block.slice(1) : block).map((u) => u.text).join('\n'),
      source: block[0].source,
      hint,
      unsure,
      meta: true,
    };
  });
}

/* ------------------------------------------------------------------------ */
/* Rows (Excel, CSV, Word tables)                                            */
/* ------------------------------------------------------------------------ */

const TYPE_HEADER = /^(type|types|channel|channels|medium|platform|mode|category|template type|message type|channel type|msg type)$/;
const NAME_HEADER =
  /^(name|names|title|titles|template name|template title|message name|script name|subject|subject line|scenario|situation|purpose|use case|usecase|topic|heading|label|occasion|when to use|trigger|stage|step)$/;
const MESSAGE_HEADER =
  /^(message|messages|msg|script|scripts|text|body|content|wording|copy|reply|replies|response|draft|template text|message text|message body|script text|template body|template message)$/;
const CHANNEL_HEADER =
  /^(whats ?app|wa|e ?mail|mail|sms|call|calls|calling|phone|tele ?calling|follow ?ups?|site visits?)( (message|messages|msg|script|scripts|text|body|template|templates|copy|content|reply))?$/;

type HeaderRole = { role: 'type' } | { role: 'name' } | { role: 'template' } | { role: 'message'; channel?: string };

/** "Template ID", "Script code", "Ref no." — a column of codes, never the message or the name. */
const ID_HEADER = /\b(id|ids|code|codes|ref|refs|reference|key|seq|serial|sl no|s no|sr no|number|no)\b/;

function classifyHeader(raw: string, loose: boolean): HeaderRole | null {
  const h = raw.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!h) return null;
  if (ID_HEADER.test(h) && !MESSAGE_HEADER.test(h)) return null;
  if (TYPE_HEADER.test(h)) return { role: 'type' };
  if (NAME_HEADER.test(h)) return { role: 'name' };
  if (h === 'template' || h === 'templates') return { role: 'template' };
  if (MESSAGE_HEADER.test(h)) return { role: 'message' };
  if (CHANNEL_HEADER.test(h)) return { role: 'message', channel: detectTypeHint(h) };
  if (!loose) return null;
  if (/\b(name|title|subject)\b/.test(h)) return { role: 'name' };
  if (/\b(message|messages|msg|script|scripts|body|text|content|wording|template|templates|reply|copy)\b/.test(h)) return { role: 'message', channel: detectTypeHint(h) };
  if (/\b(type|channel)\b/.test(h)) return { role: 'type' };
  return null;
}

function planFromHeader(cells: string[], loose: boolean): ColumnPlan | null {
  const plan: ColumnPlan = { messages: [] };
  const ambiguous: number[] = [];
  cells.forEach((cell, col) => {
    const r = classifyHeader(cell, loose);
    if (!r) return;
    if (r.role === 'type') plan.type ??= col;
    else if (r.role === 'name') plan.name ??= col;
    else if (r.role === 'template') ambiguous.push(col);
    else plan.messages.push({ col, channel: r.channel, label: cell.trim() });
  });
  // "Template" is the message when nothing else is, otherwise the name ("Template | Message").
  for (const col of ambiguous) {
    if (!plan.messages.length) plan.messages.push({ col, label: cells[col].trim() });
    else plan.name ??= col;
  }
  return plan.messages.length ? plan : null;
}

interface HeaderMatch {
  index: number;
  plan: ColumnPlan;
}

/** The header row within the first ten non-empty rows (title rows above it are allowed). */
function findHeaderRow(rows: string[][]): HeaderMatch | null {
  let single: HeaderMatch | null = null;
  for (let r = 0, seen = 0; r < rows.length && seen < 10; r++) {
    const filled = rows[r].filter((c) => c.trim());
    if (!filled.length) continue;
    seen++;
    if (filled.some((c) => c.trim().length > 40 || c.trim().split(/\s+/).length > 5 || /[;,.!?]/.test(c) || hasPlaceholder(c))) continue; // data rows have sentences, headers have labels
    const plan = planFromHeader(rows[r], filled.length > 1);
    if (!plan) continue;
    if (filled.length > 1) {
      if (plan.name !== undefined || plan.type !== undefined || plan.messages.length > 1) return { index: r, plan };
    } else if (!single && !plan.messages[0].channel) {
      // A lone "Message" cell heads a one-column list only when the data below sits in that same column.
      const col = plan.messages[0].col;
      if (rows.slice(r + 1).every((row) => row.every((c, i) => i === col || !c.trim()))) single = { index: r, plan };
    }
  }
  return single;
}

/** Without a header: 1 column = message, 2 = name + message, 3 = type + name + message (positions inferred). */
function headerlessPlan(rows: string[][]): ColumnPlan | null {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const values: string[][] = [];
  for (let c = 0; c < width; c++) values[c] = rows.map((r) => (r[c] ?? '').trim()).filter(Boolean);
  let cols = values.map((v, c) => (v.length ? c : -1)).filter((c) => c >= 0);
  if (!cols.length) return null;
  if (cols.length > 1 && values[cols[0]].length > 1 && values[cols[0]].every((v) => /^#?\d{1,4}[.)]?$/.test(v))) cols = cols.slice(1); // S.No
  if (cols.length === 1) return { messages: [{ col: cols[0], label: '' }] };

  const avg = (c: number) => values[c].reduce((sum, v) => sum + v.length, 0) / values[c].length;
  const message = cols.reduce((best, c) => (avg(c) >= avg(best) ? c : best));
  let type = cols.find((c) => c !== message && isTypeColumn(values[c]));
  const others = cols.filter((c) => c !== message && c !== type);
  const left = others.filter((c) => c < message);
  const name = left.length ? left[left.length - 1] : others[0];
  if (type === undefined && cols.length >= 3 && name !== undefined) {
    const before = others.filter((c) => c < name);
    const candidate = before[before.length - 1];
    if (candidate !== undefined && avg(candidate) <= 30) type = candidate;
  }
  return { type, name, messages: [{ col: message, label: '' }] };
}

function isTypeColumn(values: string[]): boolean {
  const recognised = values.filter((v) => typeSynonym(v)).length;
  return recognised > 0 && recognised >= Math.ceil(values.length * 0.6);
}

function draftsFromRows(rows: string[][], plan: ColumnPlan, start: number, hint: string | undefined, source: (row: number, label?: string) => string): Draft[] {
  const out: Draft[] = [];
  const multi = plan.messages.length > 1;
  const headerLabels = new Set(plan.messages.map((m) => m.label.toLowerCase()).filter(Boolean));
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const name = plan.name !== undefined ? (row[plan.name] ?? '').trim() : '';
    const rowType = plan.type !== undefined ? (row[plan.type] ?? '').trim() : '';
    for (const m of plan.messages) {
      const message = row[m.col] ?? '';
      if (!message.trim() || headerLabels.has(message.trim().toLowerCase())) continue; // blank, or a repeated header row
      out.push({
        name: multi && !m.channel ? [name, m.label].filter(Boolean).join(' – ') : name,
        message,
        // One column per channel ("WhatsApp | Email") decides the type; otherwise the row's Type cell does.
        type: multi && m.channel ? m.channel : rowType || m.channel,
        hint,
        source: source(r, multi ? m.label : undefined),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* CSV / TSV and text                                                        */
/* ------------------------------------------------------------------------ */

function readDelimited(text: string, delimiter?: string): Draft[] {
  const rows = parseDelimitedRows(text, delimiter ?? detectDelimiter(text)).map((r) => r.map((c) => c.replace(/\r\n?/g, '\n')));
  if (!rows.length) return [];
  const header = findHeaderRow(rows);
  const plan = header?.plan ?? headerlessPlan(rows);
  if (!plan) return [];
  const hint = header ? detectTypeHint(rows.slice(0, header.index).flat().join(' ')) : undefined;
  return draftsFromRows(rows, plan, header ? header.index + 1 : 0, hint, (r, label) => `Row ${r + 1}${label ? ` · ${label}` : ''}`);
}

/**
 * RFC 4180: quoted cells may hold the delimiter, doubled quotes and line breaks; CRLF / LF / CR endings.
 * Blank records are kept, so "Row N" matches the row number the user sees in Excel.
 */
function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      started = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      started = false;
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The most frequent of , ; tab | on the first line, outside quotes (Excel in many locales writes ";"). */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return Object.keys(counts).reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');
}

function looksTabSeparated(text: string): boolean {
  const lines = text.split(/\r\n?|\n/).filter((l) => l.trim()).slice(0, 50);
  if (lines.length < 2) return false;
  return lines.filter((l) => l.includes('\t')).length / lines.length >= 0.8;
}

/** Text / Markdown: "# Heading" lines start sections (outside code fences); every other line is a paragraph. */
function textFlow(text: string): FlowItem[] {
  const items: FlowItem[] = [];
  let fenced = false;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    const source = `Line ${i + 1}`;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    const m = fenced ? null : /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (m) items.push({ kind: 'heading', text: m[2], level: m[1].length, source });
    else items.push({ kind: 'para', text: line, source });
  });
  return items;
}

function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes); // Excel "CSV" on Windows
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

function assertPlainText(bytes: Uint8Array, ext: string): void {
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    const [what, saveAs] =
      ext === 'xls' ? ['an Excel 97–2003 (.xls) workbook', 'an Excel Workbook (.xlsx)']
      : ext === 'doc' ? ['a Word 97–2003 (.doc) document', 'a Word Document (.docx)']
      : ['an older Office file or a password-protected document', 'a Word (.docx) or Excel (.xlsx) file without a password'];
    throw new TemplateImportError(`This is ${what}, which can’t be read here. Open it, use File › Save As to save it as ${saveAs}, then import that copy.`);
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) throw new TemplateImportError('PDF files can’t be read here. Copy the scripts into Word (.docx) or Excel (.xlsx) and import that file.');
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) throw new TemplateImportError('Rich Text (.rtf) files aren’t supported. Save the document as Word (.docx) and try again.');
  const utf16 = startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
  if (!utf16 && bytes.subarray(0, 4096).includes(0)) throw new TemplateImportError('This file type isn’t supported. Use Word (.docx), Excel (.xlsx), CSV or plain text (.txt).');
}

/* ------------------------------------------------------------------------ */
/* Office packages (ZIP + XML)                                               */
/* ------------------------------------------------------------------------ */

type Parts = Map<string, Uint8Array>;

interface OfficePackage {
  kind: 'docx' | 'xlsx';
  parts: Parts;
  /** Main part, e.g. "word/document.xml" or "xl/workbook.xml" (lower-case). */
  main: string;
}

const MAX_PART_BYTES = 40 * 1024 * 1024;

function openPackage(bytes: Uint8Array): OfficePackage {
  const tooLarge: string[] = [];
  let raw: Record<string, Uint8Array>;
  try {
    // Only XML parts are inflated — images and embedded media are never decompressed.
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (!/\.(xml|rels)$/i.test(f.name)) return false;
        if (f.originalSize > MAX_PART_BYTES) {
          tooLarge.push(f.name.toLowerCase());
          return false;
        }
        return true;
      },
    });
  } catch {
    throw new TemplateImportError('This file couldn’t be opened — it may be damaged or not a real Word/Excel file. Open it, save a fresh copy and try again.');
  }
  const parts: Parts = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  let main = '';
  for (const r of parseRels(partText(parts, '_rels/.rels')).values()) {
    if (/\/officeDocument$/i.test(r.type)) {
      main = resolvePartName('', r.target);
      break;
    }
  }
  if (!main) main = parts.has('word/document.xml') ? 'word/document.xml' : parts.has('xl/workbook.xml') ? 'xl/workbook.xml' : '';
  if (main && tooLarge.includes(main)) throw new TemplateImportError('This document is too large to read here. Split it into smaller files and try again.');
  if (main.startsWith('word/') && parts.has(main)) return { kind: 'docx', parts, main };
  if (main.startsWith('xl/') && parts.has(main)) return { kind: 'xlsx', parts, main };
  if (parts.has('content.xml')) throw new TemplateImportError('OpenDocument files (.odt, .ods) aren’t supported. Save the file as Word (.docx) or Excel (.xlsx) and try again.');
  if (main.startsWith('ppt/')) throw new TemplateImportError('PowerPoint files aren’t supported. Copy the scripts into Word or Excel and import that file.');
  throw new TemplateImportError('This ZIP file isn’t a Word or Excel document. Use .docx, .xlsx, .csv or .txt.');
}

function partText(parts: Parts, name: string | undefined): string | undefined {
  const bytes = name ? parts.get(name.toLowerCase()) : undefined;
  if (!bytes) return undefined;
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes);
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

function relsPartFor(main: string): string {
  const dir = main.slice(0, main.lastIndexOf('/') + 1);
  return `${dir}_rels/${main.slice(dir.length)}.rels`;
}

function resolvePartName(dir: string, target: string): string {
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    /* keep as written */
  }
  const path = t.startsWith('/') ? t.slice(1) : dir + t;
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/').toLowerCase();
}

function parseRels(xml: string | undefined): Map<string, { type: string; target: string; external: boolean }> {
  const out = new Map<string, { type: string; target: string; external: boolean }>();
  if (!xml) return out;
  walkXml(xml, {
    open(local, _prefix, a) {
      if (local !== 'Relationship') return;
      const id = attr(a, 'Id');
      if (id) out.set(id, { type: attr(a, 'Type') ?? '', target: attr(a, 'Target') ?? '', external: /^external$/i.test(attr(a, 'TargetMode') ?? '') });
    },
    close() {},
    text() {},
  });
  return out;
}

/* ------------------------------- Word ----------------------------------- */

interface DocxPara {
  text: string;
  /** 0 = Title/Subtitle, 1–9 = heading level, null = body text. */
  level: number | null;
  bold: boolean;
}

type DocxBlock = { kind: 'para'; para: DocxPara } | { kind: 'table'; rows: string[][]; cells: DocxPara[][][] };

const WML_NS = /wordprocessingml\/(2006\/)?main$/;
const OFF = /^(0|false|off|none)$/i;
/** Level given to bold / "Label:" pseudo-headings — below any real heading. */
const PSEUDO_LEVEL = 10;

function readDocx(pkg: OfficePackage): DocxBlock[] {
  const dir = pkg.main.slice(0, pkg.main.lastIndexOf('/') + 1);
  const rels = parseRels(partText(pkg.parts, relsPartFor(pkg.main)));
  const related = (typeSuffix: string, fallback: string) => {
    for (const r of rels.values()) if (r.type.endsWith(typeSuffix)) return resolvePartName(dir, r.target);
    return fallback;
  };
  const styles = parseDocxStyles(partText(pkg.parts, related('/styles', `${dir}styles.xml`)));
  const numbering = parseDocxNumbering(partText(pkg.parts, related('/numbering', `${dir}numbering.xml`)));
  const links = new Map<string, string>();
  for (const [id, r] of rels) if (r.external && /\/hyperlink$/i.test(r.type)) links.set(id, r.target);
  return readDocxBody(partText(pkg.parts, pkg.main) ?? '', styles, numbering, links);
}

interface OpenPara {
  parts: string[];
  length: number;
  style?: string;
  outline?: number;
  numId?: string;
  ilvl?: number;
  boldRuns: number;
  plainRuns: number;
}
interface OpenCell {
  paras: DocxPara[];
  span: number;
  /** vMerge continuation — the text of the cell above repeats here. */
  continued: boolean;
}

function readDocxBody(xml: string, styles: DocxStyles, numbering: DocxNumbering, links: Map<string, string>): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const tables: Array<{ rows: OpenCell[][] }> = [];
  const listPrefix = makeListNumberer(numbering);
  const linkStack: Array<{ url?: string; start: number }> = [];
  let w = 'w';
  let rootSeen = false;
  let skip = 0; // >0 inside a subtree we ignore (tracked deletions, mc:Fallback copies)
  let para: OpenPara | null = null;
  let paraDepth = 0; // >1 inside a text box anchored in the paragraph
  let inPPr = false;
  let inNumPr = false;
  let inTcPr = false;
  let inSdtPr = false;
  let sdtDepth = 0;
  let tocAt = 0; // sdt depth of an open table of contents (0 = none)
  let inRun = false;
  let inRPr = false;
  let inText = false;
  let runBold: boolean | undefined;
  let runStyle: string | undefined;
  let runText = '';
  let pendingBreak = false; // a text-box paragraph began/ended: start a new line before the next text

  const currentCell = (): OpenCell | undefined => {
    const t = tables[tables.length - 1];
    const row = t?.rows[t.rows.length - 1];
    return row?.[row.length - 1];
  };
  const push = (s: string) => {
    if (!para || !s) return;
    if (pendingBreak && para.length) {
      para.parts.push('\n');
      para.length += 1;
    }
    pendingBreak = false;
    para.parts.push(s);
    para.length += s.length;
  };
  const flushRun = () => {
    if (inRun && runText) push(runText);
    runText = '';
  };
  const finishPara = (p: OpenPara) => {
    if (tocAt || styles.isToc(p.style)) return;
    const raw = p.parts.join('');
    const level = p.outline !== undefined ? (p.outline < 9 ? p.outline + 1 : null) : styles.level(p.style);
    let text = raw;
    if (level === null && raw.trim()) {
      const fromStyle = styles.numPr(p.style);
      text = listPrefix(p.numId ?? fromStyle?.numId, p.ilvl ?? fromStyle?.ilvl ?? 0) + raw;
    }
    const out: DocxPara = { text, level, bold: p.boldRuns > 0 && p.plainRuns === 0 };
    const cell = currentCell();
    if (cell) cell.paras.push(out);
    else blocks.push({ kind: 'para', para: out });
  };
  const finishTable = (t: { rows: OpenCell[][] }) => {
    const rows: string[][] = [];
    const cells: DocxPara[][][] = [];
    let above: string[] = [];
    for (const r of t.rows) {
      const texts: string[] = [];
      const paras: DocxPara[][] = [];
      let col = 0;
      for (const c of r) {
        const own = c.paras.map((x) => x.text).join('\n');
        texts[col] = c.continued && !own.trim() ? above[col] ?? '' : own;
        paras[col] = c.continued ? [] : c.paras;
        for (let k = 1; k < c.span; k++) {
          texts[col + k] = '';
          paras[col + k] = [];
        }
        col += c.span;
      }
      const dense = Array.from(texts, (x) => x ?? '');
      rows.push(dense);
      cells.push(Array.from(paras, (x) => x ?? []));
      above = dense;
    }
    const outer = currentCell(); // a nested table flows into the enclosing cell
    if (outer) {
      for (const row of cells) for (const c of row) outer.paras.push(...c);
      return;
    }
    if (rows.some((r) => r.some((x) => x.trim()))) blocks.push({ kind: 'table', rows, cells });
  };

  walkXml(xml, {
    open(local, prefix, a) {
      if (skip) {
        skip++;
        return;
      }
      if (!rootSeen) {
        rootSeen = true;
        w = nsPrefix(a, WML_NS, 'w');
      }
      if (local === 'Fallback') {
        skip = 1; // mc:AlternateContent — mc:Choice already carries the content
        return;
      }
      if (prefix !== w) return;
      switch (local) {
        case 'del':
        case 'moveFrom':
          skip = 1;
          return;
        case 'sdt':
          sdtDepth++;
          return;
        case 'sdtPr':
          inSdtPr = true;
          return;
        case 'docPartGallery':
          if (inSdtPr && /table of contents/i.test(attr(a, 'val') ?? '')) tocAt = sdtDepth;
          return;
        case 'tbl':
          if (!paraDepth) tables.push({ rows: [] });
          return;
        case 'tr':
          if (!paraDepth) tables[tables.length - 1]?.rows.push([]);
          return;
        case 'tc':
          if (!paraDepth) {
            const t = tables[tables.length - 1];
            t?.rows[t.rows.length - 1]?.push({ paras: [], span: 1, continued: false });
          }
          return;
        case 'tcPr':
          if (!paraDepth) inTcPr = true;
          return;
        case 'gridSpan': {
          const cell = inTcPr ? currentCell() : undefined;
          if (cell) cell.span = Math.max(1, toInt(attr(a, 'val'), 1));
          return;
        }
        case 'vMerge': {
          const cell = inTcPr ? currentCell() : undefined;
          const v = attr(a, 'val');
          if (cell) cell.continued = !v || v === 'continue';
          return;
        }
        case 'p':
          paraDepth++;
          if (paraDepth === 1) {
            para = { parts: [], length: 0, boldRuns: 0, plainRuns: 0 };
            pendingBreak = false;
          } else {
            flushRun(); // text box inside this paragraph: its paragraphs become lines of this one
            pendingBreak = true;
          }
          return;
        case 'pPr':
          if (paraDepth === 1 && !inRun) inPPr = true;
          return;
        case 'pStyle':
          if (inPPr && para) para.style = attr(a, 'val');
          return;
        case 'outlineLvl':
          if (inPPr && para) para.outline = toInt(attr(a, 'val'), 9);
          return;
        case 'numPr':
          if (inPPr) inNumPr = true;
          return;
        case 'numId':
          if (inNumPr && para) para.numId = attr(a, 'val');
          return;
        case 'ilvl':
          if (inNumPr && para) para.ilvl = toInt(attr(a, 'val'));
          return;
        case 'r':
          if (para) {
            flushRun();
            inRun = true;
            inRPr = false;
            runBold = undefined;
            runStyle = undefined;
          }
          return;
        case 'rPr':
          if (inRun) inRPr = true;
          return;
        case 'rStyle':
          if (inRPr) runStyle = attr(a, 'val');
          return;
        case 'b':
          if (inRPr) runBold = !OFF.test(attr(a, 'val') ?? '');
          return;
        case 't':
          if (inRun && !inRPr) inText = true;
          return;
        case 'tab':
          if (inRun && !inRPr) runText += '\t';
          return;
        case 'br':
        case 'cr':
          if (inRun && !inRPr) runText += '\n';
          return;
        case 'noBreakHyphen':
          if (inRun && !inRPr) runText += '-';
          return;
        case 'hyperlink':
          if (para) linkStack.push({ url: links.get(attr(a, 'id') ?? ''), start: para.length });
          return;
      }
    },
    close(local, prefix) {
      if (skip) {
        skip--;
        return;
      }
      if (prefix !== w) return;
      switch (local) {
        case 'sdt':
          if (tocAt === sdtDepth) tocAt = 0;
          sdtDepth = Math.max(0, sdtDepth - 1);
          return;
        case 'sdtPr':
          inSdtPr = false;
          return;
        case 't':
          inText = false;
          return;
        case 'rPr':
          inRPr = false;
          return;
        case 'r':
          if (inRun && para) {
            if (runText.trim()) {
              const bold = runBold ?? styles.bold(runStyle) ?? styles.bold(para.style) ?? false;
              if (bold) para.boldRuns++;
              else para.plainRuns++;
            }
            push(runText);
          }
          runText = '';
          inRun = false;
          inRPr = false;
          inText = false;
          return;
        case 'hyperlink': {
          const link = linkStack.pop();
          if (link?.url && para) {
            const shown = para.parts.join('').slice(link.start);
            const url = link.url.replace(/^mailto:/i, '');
            if (shown.trim() && !shown.includes(url)) push(` (${url})`); // keep the address a WhatsApp message needs
          }
          return;
        }
        case 'numPr':
          inNumPr = false;
          return;
        case 'pPr':
          inPPr = false;
          inNumPr = false;
          return;
        case 'p':
          paraDepth = Math.max(0, paraDepth - 1);
          if (paraDepth) {
            pendingBreak = true;
          } else if (para) {
            finishPara(para);
            para = null;
          }
          return;
        case 'tcPr':
          inTcPr = false;
          return;
        case 'tbl':
          if (!paraDepth) {
            const t = tables.pop();
            if (t) finishTable(t);
          }
          return;
      }
    },
    text(value) {
      if (!skip && inText) runText += value;
    },
  });
  return blocks;
}

type DocxItem = { kind: 'para'; text: string; level: number | null; bold: boolean; inTable: boolean; source: string } | RowsItem;

function docxFlow(blocks: DocxBlock[]): FlowItem[] {
  const items: DocxItem[] = [];
  let paraNo = 0;
  let tableNo = 0;
  for (const b of blocks) {
    if (b.kind === 'para') {
      paraNo++;
      items.push({ kind: 'para', ...b.para, inTable: false, source: `Paragraph ${paraNo}` });
      continue;
    }
    tableNo++;
    const header = findHeaderRow(b.rows);
    // A template table needs a Name/Title column and a Message/Script/Text column; anything else is just text.
    if (header && header.plan.name !== undefined) {
      items.push({ kind: 'rows', rows: b.rows, plan: header.plan, headerIndex: header.index, source: `Table ${tableNo}` });
      continue;
    }
    b.cells.forEach((row, r) => {
      for (const cell of row) for (const p of cell) items.push({ kind: 'para', ...p, inTable: true, source: `Table ${tableNo} · row ${r + 1}` });
      items.push({ kind: 'para', text: '', level: null, bold: false, inTable: true, source: '' }); // a row is a block
    });
  }
  const isHeading = chooseHeadingRule(items);
  return items.map((it): FlowItem => {
    if (it.kind === 'rows') return it;
    if (isHeading(it)) return { kind: 'heading', text: it.text, level: it.level ?? PSEUDO_LEVEL, source: it.source };
    return { kind: 'para', text: it.text, source: it.source };
  });
}

type DocxPredicate = (it: DocxItem) => boolean;

/**
 * Which paragraphs start a template:
 *  1. heading styles, when they split the document into two or more templates — plus bold sub-headings only when
 *     they clearly sit under each heading (≥ 2 per heading and the first line after most headings is one);
 *  2. otherwise all-bold short lines (with any heading styles, e.g. a Title above them);
 *  3. otherwise, only when blank paragraphs don't already separate the templates, short "Label:" lines.
 */
function chooseHeadingRule(items: DocxItem[]): DocxPredicate {
  const style: DocxPredicate = (it) => it.kind === 'para' && it.level !== null && !!it.text.trim();
  const bold: DocxPredicate = (it) => it.kind === 'para' && !it.inTable && it.level === null && it.bold && isLabelLike(it.text);
  const colon: DocxPredicate = (it) => it.kind === 'para' && !it.inTable && it.level === null && /:\s*$/.test(it.text) && looksLikeTitle(it.text);
  const either = (a: DocxPredicate, b: DocxPredicate): DocxPredicate => (it) => a(it) || b(it);

  const styleCount = items.filter(style).length;
  const boldCount = items.filter(bold).length;
  if (sectionsWithText(items, style) >= 2) {
    if (boldCount >= 2 * styleCount && firstLineMatches(items, style, bold) >= 0.5) return either(style, bold);
    return style;
  }
  if (boldCount && sectionsWithText(items, either(style, bold)) >= 2) return either(style, bold);
  if (!hasBlankSeparators(items) && sectionsWithText(items, either(style, colon)) >= 2) return either(style, colon);
  return style;
}

function sectionsWithText(items: DocxItem[], isHeading: DocxPredicate): number {
  let count = 0;
  let open = false;
  for (const it of items) {
    if (it.kind === 'rows') open = false;
    else if (isHeading(it)) open = true;
    else if (open && it.text.trim()) {
      count++;
      open = false;
    }
  }
  return count;
}

/** Share of headings whose first non-empty line below is a `candidate`. */
function firstLineMatches(items: DocxItem[], isHeading: DocxPredicate, candidate: DocxPredicate): number {
  let headings = 0;
  let hits = 0;
  items.forEach((it, i) => {
    if (it.kind === 'rows' || !isHeading(it)) return;
    headings++;
    for (let j = i + 1; j < items.length; j++) {
      const next = items[j];
      if (next.kind === 'rows' || isHeading(next)) break;
      if (!next.text.trim()) continue;
      if (candidate(next)) hits++;
      break;
    }
  });
  return headings ? hits / headings : 0;
}

function hasBlankSeparators(items: DocxItem[]): boolean {
  let seenText = false;
  let blank = false;
  for (const it of items) {
    if (it.kind !== 'para' || it.inTable) continue;
    if (!it.text.trim()) blank = seenText;
    else if (blank) return true;
    else seenText = true;
  }
  return false;
}

interface StyleDef {
  name: string;
  basedOn?: string;
  outline?: number;
  numId?: string;
  ilvl?: number;
  bold?: boolean;
}

interface DocxStyles {
  level(id?: string): number | null;
  isToc(id?: string): boolean;
  numPr(id?: string): { numId?: string; ilvl?: number } | undefined;
  bold(id?: string): boolean | undefined;
}

function parseDocxStyles(xml: string | undefined): DocxStyles {
  const defs = new Map<string, StyleDef>();
  if (xml) {
    let w = 'w';
    let root = true;
    let current: (StyleDef & { id: string }) | null = null;
    let inPPr = false;
    let inRPr = false;
    let inNumPr = false;
    walkXml(xml, {
      open(local, prefix, a) {
        if (root) {
          root = false;
          w = nsPrefix(a, WML_NS, 'w');
        }
        if (prefix !== w) return;
        if (local === 'style') {
          const id = attr(a, 'styleId');
          current = id ? { id, name: '' } : null;
          return;
        }
        if (!current) return;
        switch (local) {
          case 'name':
            current.name = (attr(a, 'val') ?? '').trim().toLowerCase();
            break;
          case 'basedOn':
            current.basedOn = attr(a, 'val');
            break;
          case 'pPr':
            inPPr = true;
            break;
          case 'rPr':
            inRPr = true;
            break;
          case 'outlineLvl':
            if (inPPr) current.outline = toInt(attr(a, 'val'), 9);
            break;
          case 'numPr':
            if (inPPr) inNumPr = true;
            break;
          case 'numId':
            if (inNumPr) current.numId = attr(a, 'val');
            break;
          case 'ilvl':
            if (inNumPr) current.ilvl = toInt(attr(a, 'val'));
            break;
          case 'b':
            if (inRPr) current.bold = !OFF.test(attr(a, 'val') ?? '');
            break;
        }
      },
      close(local, prefix) {
        if (prefix !== w) return;
        if (local === 'style') {
          if (current) defs.set(current.id, current);
          current = null;
          inPPr = inRPr = inNumPr = false;
        } else if (local === 'pPr') {
          inPPr = false;
          inNumPr = false;
        } else if (local === 'rPr') {
          inRPr = false;
        } else if (local === 'numPr') {
          inNumPr = false;
        }
      },
      text() {},
    });
  }

  /** First defined value along the basedOn chain (`null` is a definite "no"). */
  const inherited = <T>(id: string | undefined, pick: (d: StyleDef) => T | undefined): T | undefined => {
    let cur = id;
    for (let i = 0; cur && i < 12; i++) {
      const d = defs.get(cur);
      if (!d) return undefined;
      const v = pick(d);
      if (v !== undefined) return v;
      cur = d.basedOn;
    }
    return undefined;
  };
  const headingFromName = (name: string): number | undefined => {
    const m = /^heading\s*([1-9])$/.exec(name);
    if (m) return Number(m[1]);
    return name === 'title' || name === 'subtitle' ? 0 : undefined;
  };
  const levels = new Map<string, number | null>();
  return {
    level(id) {
      if (!id) return null;
      if (!levels.has(id)) {
        const fromDefs = inherited<number | null>(id, (d) => headingFromName(d.name) ?? (d.outline === undefined ? undefined : d.outline < 9 ? d.outline + 1 : null));
        levels.set(id, fromDefs !== undefined ? fromDefs : headingFromName(id.toLowerCase()) ?? null);
      }
      return levels.get(id) ?? null;
    },
    isToc(id) {
      if (!id) return false;
      const name = defs.get(id)?.name || id.toLowerCase();
      return /^toc\s*(\d|heading)/.test(name);
    },
    numPr: (id) => inherited(id, (d) => (d.numId !== undefined ? { numId: d.numId, ilvl: d.ilvl } : undefined)),
    bold: (id) => inherited(id, (d) => d.bold),
  };
}

interface NumLevel {
  fmt: string;
  text?: string;
  start: number;
}

interface DocxNumbering {
  level(numId: string, ilvl: number): NumLevel | undefined;
  abstractId(numId: string): string | undefined;
}

function parseDocxNumbering(xml: string | undefined): DocxNumbering {
  const abstracts = new Map<string, NumLevel[]>();
  const nums = new Map<string, string>();
  if (xml) {
    let w = 'w';
    let root = true;
    let abs: NumLevel[] | null = null;
    let lvl: NumLevel | null = null;
    let num: string | null = null;
    walkXml(xml, {
      open(local, prefix, a) {
        if (root) {
          root = false;
          w = nsPrefix(a, WML_NS, 'w');
        }
        if (prefix !== w) return;
        if (local === 'abstractNum') {
          abs = [];
          abstracts.set(attr(a, 'abstractNumId') ?? '', abs);
        } else if (local === 'lvl' && abs) {
          lvl = { fmt: 'decimal', start: 1 };
          abs[toInt(attr(a, 'ilvl'))] = lvl;
        } else if (local === 'numFmt' && lvl) {
          lvl.fmt = attr(a, 'val') ?? 'decimal';
        } else if (local === 'lvlText' && lvl) {
          lvl.text = attr(a, 'val');
        } else if (local === 'start' && lvl) {
          lvl.start = toInt(attr(a, 'val'), 1);
        } else if (local === 'num') {
          num = attr(a, 'numId') ?? null;
        } else if (local === 'abstractNumId' && num !== null) {
          nums.set(num, attr(a, 'val') ?? '');
        }
      },
      close(local, prefix) {
        if (prefix !== w) return;
        if (local === 'lvl') lvl = null;
        else if (local === 'abstractNum') abs = null;
        else if (local === 'num') num = null;
      },
      text() {},
    });
  }
  return {
    level: (numId, ilvl) => abstracts.get(nums.get(numId) ?? '')?.[ilvl],
    abstractId: (numId) => nums.get(numId),
  };
}

/** "• " for bullets, "1. " / "a) " / "1.2. " for numbered lists — numbering continues across a list. */
function makeListNumberer(numbering: DocxNumbering): (numId: string | undefined, ilvl: number) => string {
  const counters = new Map<string, number[]>();
  return (numId, ilvl) => {
    if (!numId || numId === '0') return '';
    const lvl = Math.max(0, Math.min(8, ilvl));
    const def = numbering.level(numId, lvl);
    const indent = '  '.repeat(Math.min(lvl, 4));
    if (!def || def.fmt === 'bullet') return `${indent}• `;
    if (def.fmt === 'none') return indent;
    const key = numbering.abstractId(numId) ?? numId;
    const counts = counters.get(key) ?? [];
    counts[lvl] = (counts[lvl] ?? 0) + 1;
    counts.length = lvl + 1; // deeper levels restart
    counters.set(key, counts);
    const pattern = def.text ?? `%${lvl + 1}.`;
    const label = pattern.replace(/%([1-9])/g, (_, k: string) => {
      const i = Number(k) - 1;
      const d = numbering.level(numId, i);
      return formatListNumber((d?.start ?? 1) + (counts[i] ?? 1) - 1, d?.fmt ?? 'decimal');
    });
    return `${indent}${label} `;
  };
}

function formatListNumber(n: number, fmt: string): string {
  switch (fmt) {
    case 'lowerLetter':
      return toLetters(n).toLowerCase();
    case 'upperLetter':
      return toLetters(n);
    case 'lowerRoman':
      return toRoman(n).toLowerCase();
    case 'upperRoman':
      return toRoman(n);
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n);
    default:
      return String(n);
  }
}

function toLetters(n: number): string {
  if (n < 1) return String(n);
  return String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.ceil(n / 26)); // Word: A…Z, AA…ZZ
}

function toRoman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const table: Array<[number, string]> = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  let rest = n;
  for (const [value, symbol] of table) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

/* ------------------------------- Excel ---------------------------------- */

const SML_NS = /spreadsheetml\/(2006\/)?main$/;
const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLS = 50;

function readXlsx(pkg: OfficePackage, warnings: string[]): Draft[] {
  const dir = pkg.main.slice(0, pkg.main.lastIndexOf('/') + 1);
  const rels = parseRels(partText(pkg.parts, relsPartFor(pkg.main)));
  let sharedPath = `${dir}sharedstrings.xml`;
  for (const r of rels.values()) if (/\/sharedStrings$/i.test(r.type)) sharedPath = resolvePartName(dir, r.target);
  const shared = parseSharedStrings(partText(pkg.parts, sharedPath));

  const sheets: Array<{ name: string; rows: string[][] }> = [];
  const listed = parseWorkbookSheets(partText(pkg.parts, pkg.main) ?? '');
  for (const s of listed) {
    if (s.hidden) continue;
    const rel = rels.get(s.rid);
    const xml = rel ? partText(pkg.parts, resolvePartName(dir, rel.target)) : undefined;
    if (xml) sheets.push({ name: s.name, rows: parseSheetRows(xml, shared) });
  }
  if (!listed.length) {
    // No sheet list (unusual writer): read the worksheet parts in order.
    const names = [...pkg.parts.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => toInt(a.replace(/\D/g, '')) - toInt(b.replace(/\D/g, '')));
    names.forEach((n, i) => sheets.push({ name: `Sheet${i + 1}`, rows: parseSheetRows(partText(pkg.parts, n) ?? '', shared) }));
  }

  const withData = sheets
    .filter((s) => s.rows.some((r) => r.some((c) => c.trim())))
    .map((s) => {
      const header = findHeaderRow(s.rows);
      const title = header ? s.rows.slice(0, header.index).flat().join(' ') : '';
      return { ...s, header, hint: detectTypeHint(title) ?? detectTypeHint(s.name) };
    });
  if (!withData.length) return [];
  // Sheets with a header row, or named after a channel ("WhatsApp", "Emails"), hold templates; with neither
  // anywhere, read the first sheet with the column rules. Other sheets (notes, lookups) are skipped.
  let chosen = withData.filter((s) => s.header || detectTypeHint(s.name));
  if (!chosen.length) chosen = [withData[0]];
  // A journey / mapping sheet (Stage · Trigger · Template ID · Purpose · CTA …) has no column of message
  // text — its longest cells are short labels and it refers to scripts by CODE (NEW-01, CALL-01 …).
  const codeSheets: Array<{ name: string; codes: string[] }> = [];
  const labelSheets: string[] = [];
  chosen = chosen.filter((s) => {
    const plan = s.header?.plan ?? headerlessPlan(s.rows);
    if (!plan || !plan.messages.length) return true; // handled below (nothing to import)
    const body = s.rows.slice(s.header ? s.header.index + 1 : 0);
    const values = body.flatMap((r) => plan.messages.map((m) => (r[m.col] ?? '').trim())).filter(Boolean);
    if (values.length < 3) return true;
    const sorted = values.map((v) => v.length).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median >= 25 || values.some((v) => hasPlaceholder(v))) return true;
    const codes = sampleCodes(s, 3);
    if (codes.length) codeSheets.push({ name: s.name, codes });
    else labelSheets.push(s.name);
    return false;
  });
  const skipped = withData.filter((s) => !chosen.includes(s) && !codeSheets.some((c) => c.name === s.name) && !labelSheets.includes(s.name)).map((s) => `“${s.name}”`);
  if (skipped.length) warnings.push(`Skipped ${skipped.length === 1 ? 'sheet' : 'sheets'} ${skipped.join(', ')} — no Type | Name | Message header row.`);
  for (const c of codeSheets) warnings.push(`Skipped “${c.name}” — it refers to scripts by code (${c.codes.join(', ')}) instead of holding the message text. Import the document that contains those scripts.`);
  if (labelSheets.length) warnings.push(`Skipped ${labelSheets.map((n) => `“${n}”`).join(', ')} — no column holds message text (only short labels).`);

  return chosen.flatMap((s) => {
    const plan = s.header?.plan ?? headerlessPlan(s.rows);
    if (!plan) return [];
    return draftsFromRows(s.rows, plan, s.header ? s.header.index + 1 : 0, s.hint, (r, label) => `${s.name} · row ${r + 1}${label ? ` · ${label}` : ''}`);
  });
}

function parseWorkbookSheets(xml: string): Array<{ name: string; rid: string; hidden: boolean }> {
  const out: Array<{ name: string; rid: string; hidden: boolean }> = [];
  let s = '';
  let root = true;
  walkXml(xml, {
    open(local, prefix, a) {
      if (root) {
        root = false;
        s = nsPrefix(a, SML_NS, '');
      }
      if (prefix !== s || local !== 'sheet') return;
      out.push({ name: attr(a, 'name') ?? `Sheet${out.length + 1}`, rid: attr(a, 'id') ?? '', hidden: /hidden/i.test(attr(a, 'state') ?? '') });
    },
    close() {},
    text() {},
  });
  return out;
}

function parseSharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let s = '';
  let root = true;
  let current: string | null = null;
  let phonetic = 0;
  let inText = false;
  walkXml(xml, {
    open(local, prefix, a) {
      if (root) {
        root = false;
        s = nsPrefix(a, SML_NS, '');
      }
      if (prefix !== s) return;
      if (local === 'si') current = '';
      else if (local === 'rPh') phonetic++;
      else if (local === 't' && current !== null && !phonetic) inText = true;
    },
    close(local, prefix) {
      if (prefix !== s) return;
      if (local === 't') inText = false;
      else if (local === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (local === 'si' && current !== null) {
        out.push(decodeOoxmlEscapes(current));
        current = null;
      }
    },
    text(value) {
      if (inText && current !== null) current += value;
    },
  });
  return out;
}

function parseSheetRows(xml: string, shared: string[]): string[][] {
  const grid: string[][] = [];
  const merges: string[] = [];
  let s = '';
  let root = true;
  let row = -1;
  let col = -1;
  let cellType = '';
  let value = '';
  let inline = '';
  let inValue = false;
  let inInline = false;
  let inText = false;
  let phonetic = 0;
  walkXml(xml, {
    open(local, prefix, a) {
      if (root) {
        root = false;
        s = nsPrefix(a, SML_NS, '');
      }
      if (prefix !== s) return;
      switch (local) {
        case 'row': {
          const r = toInt(attr(a, 'r'));
          row = r > 0 ? r - 1 : row + 1;
          col = -1;
          return;
        }
        case 'c': {
          const ref = attr(a, 'r');
          col = ref ? columnIndex(ref) : col + 1;
          cellType = attr(a, 't') ?? 'n';
          value = '';
          inline = '';
          return;
        }
        case 'v':
          inValue = true;
          return;
        case 'is':
          inInline = true;
          return;
        case 'rPh':
          phonetic++;
          return;
        case 't':
          if (inInline && !phonetic) inText = true;
          return;
        case 'mergeCell': {
          const ref = attr(a, 'ref');
          if (ref) merges.push(ref);
          return;
        }
      }
    },
    close(local, prefix) {
      if (prefix !== s) return;
      switch (local) {
        case 'v':
          inValue = false;
          return;
        case 'is':
          inInline = false;
          return;
        case 'rPh':
          phonetic = Math.max(0, phonetic - 1);
          return;
        case 't':
          inText = false;
          return;
        case 'c': {
          const text = cellText(cellType, value, inline, shared);
          if (text && row >= 0 && row < MAX_SHEET_ROWS && col >= 0 && col < MAX_SHEET_COLS) (grid[row] ??= [])[col] = text;
          return;
        }
      }
    },
    text(v) {
      if (inValue) value += v;
      else if (inText) inline += v;
    },
  });
  // Vertically merged cells (e.g. one "WhatsApp" spanning several rows) apply to every row they cover.
  for (const ref of merges) {
    const [from, to] = ref.split(':');
    if (!from || !to) continue;
    const r0 = toInt(from.replace(/^[A-Za-z]+/, '')) - 1;
    const r1 = Math.min(toInt(to.replace(/^[A-Za-z]+/, '')) - 1, MAX_SHEET_ROWS - 1);
    const c0 = columnIndex(from);
    const top = grid[r0]?.[c0];
    if (!top || r1 <= r0 || r1 - r0 > 500) continue;
    for (let r = r0 + 1; r <= r1; r++) {
      const cells = (grid[r] ??= []);
      if (!cells[c0]) cells[c0] = top;
    }
  }
  return Array.from(grid, (cells) => Array.from(cells ?? [], (c) => c ?? ''));
}

function cellText(type: string, value: string, inline: string, shared: string[]): string {
  switch (type) {
    case 's':
      return shared[toInt(value, -1)] ?? '';
    case 'inlineStr':
      return decodeOoxmlEscapes(inline);
    case 'str':
      return decodeOoxmlEscapes(value);
    case 'b':
      return value.trim() === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return '';
    default:
      return value.trim();
  }
}

/** "AB12" → 27 */
function columnIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel escapes control characters as _xHHHH_ (e.g. _x000D_ for a carriage return pasted into a cell). */
function decodeOoxmlEscapes(s: string): string {
  return s.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/* ------------------------------ XML walker ------------------------------ */

interface XmlVisitor {
  open(local: string, prefix: string, attrs: Record<string, string>): void;
  close(local: string, prefix: string): void;
  text(value: string): void;
}

const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const XML_ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Minimal streaming XML reader: elements (prefix + local name), attributes and entity-decoded text. */
function walkXml(xml: string, visitor: XmlVisitor): void {
  const token = new RegExp(XML_TOKEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = token.exec(xml))) {
    if (m[6] !== undefined) {
      visitor.text(decodeEntities(m[6]));
    } else if (m[3] !== undefined) {
      const [prefix, local] = splitQName(m[3]);
      visitor.open(local, prefix, parseAttrs(m[4]));
      if (m[5]) visitor.close(local, prefix);
    } else if (m[2] !== undefined) {
      const [prefix, local] = splitQName(m[2]);
      visitor.close(local, prefix);
    } else if (m[1] !== undefined) {
      visitor.text(m[1]);
    }
  }
}

function splitQName(name: string): [string, string] {
  const i = name.indexOf(':');
  return i < 0 ? ['', name] : [name.slice(0, i), name.slice(i + 1)];
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src) return out;
  const re = new RegExp(XML_ATTR.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

/** Attribute by local name, whatever its prefix ("w:val", "r:id"…). */
function attr(attrs: Record<string, string>, local: string): string | undefined {
  if (local in attrs) return attrs[local];
  for (const key in attrs) {
    const i = key.indexOf(':');
    if (i >= 0 && key.slice(i + 1) === local && !key.startsWith('xmlns')) return attrs[key];
  }
  return undefined;
}

/** The prefix bound to a namespace on the root element ('' when it is the default namespace). */
function nsPrefix(attrs: Record<string, string>, ns: RegExp, fallback: string): string {
  for (const key in attrs) {
    if (key === 'xmlns' && ns.test(attrs[key])) return '';
    if (key.startsWith('xmlns:') && ns.test(attrs[key])) return key.slice(6);
  }
  return fallback;
}

const XML_ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(XML_ENTITY, (m, e: string) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/* -------------------------------- utils --------------------------------- */

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

/** "PK" + a ZIP record signature (local file 03 04, empty archive 05 06, spanned 07 08) — not just text starting "PK". */
function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b]) && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8));
}

function fileExtension(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(String(name ?? '').trim())?.[1].toLowerCase() ?? '';
}

function toInt(value: string | undefined, fallback = 0): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}
