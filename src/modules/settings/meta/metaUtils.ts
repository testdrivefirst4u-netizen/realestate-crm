/**
 * Meta (Facebook / Instagram) Lead Ads — pure helpers for the settings screens (no React; unit-tested in
 * tests/meta-ui.test.ts). Contract: server/core/metaTypes.ts.
 */
import type { MetaActions, MetaPendingPage, MetaSourceConfig } from '../../../../server/core/metaTypes';
import type { AssignmentMode, DuplicateMode } from '../../../../server/core/leadSourceTypes';

export type MetaForm = MetaPendingPage['forms'][number];
export type ConnectRequest = MetaActions['connectMetaPages']['req'];
export type BackfillResult = MetaActions['backfillMetaSource']['res'];
export type ConnectResult = MetaActions['connectMetaPages']['res'];

/* ------------------------------ URL params -------------------------------- */

/** Query parameters the backend's OAuth callbacks (Facebook, Google) and deep links put on `/settings`. */
export const SETTINGS_LINK_PARAMS = ['section', 'metaConnect', 'metaError', 'googleConnected', 'googleError'] as const;

export interface SettingsLink {
  /** Settings section to open (`?section=leadSources`, `?section=googleSheets`). */
  section: string | null;
  /** Pending connection id from a finished Facebook login. */
  metaConnect: string | null;
  /** Why the Facebook login did not finish (cancelled, denied, …). */
  metaError: string | null;
  /** Google connection id (GCN-…) from a finished "Connect with Google". */
  googleConnected: string | null;
  /** Why the Google sign-in did not finish. */
  googleError: string | null;
}

export const EMPTY_SETTINGS_LINK: SettingsLink = { section: null, metaConnect: null, metaError: null, googleConnected: null, googleError: null };

const clean = (v: string | null, max: number) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, max) : null;
};

/** Opaque ids (pending connection, Google connection) — drop anything that could not be one. */
const token = (v: string | null) => {
  const t = clean(v, 200);
  return t && /^[A-Za-z0-9_-]+$/.test(t) ? t : null;
};

/** Read the settings-link parameters from a query string (`?a=b` or `a=b`). */
export function parseSettingsLink(search: string): SettingsLink {
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const section = clean(q.get('section'), 40);
  return {
    section: section && /^[A-Za-z][A-Za-z0-9_-]*$/.test(section) ? section : null,
    metaConnect: token(q.get('metaConnect')),
    metaError: clean(q.get('metaError'), 300),
    googleConnected: token(q.get('googleConnected')),
    googleError: clean(q.get('googleError'), 300),
  };
}

export const hasSettingsLink = (l: SettingsLink | null | undefined) =>
  !!(l && (l.section || l.metaConnect || l.metaError || l.googleConnected || l.googleError));

/** The query string without the settings-link parameters ('' or '?…'), other parameters kept in order. */
export function stripSettingsLinkParams(search: string): string {
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  SETTINGS_LINK_PARAMS.forEach((k) => q.delete(k));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * The settings section a link opens: a known `section`, else Lead sources for a Facebook return,
 * Google Sheets for a Google return, else `fallback`.
 */
export function initialSettingsSection<T extends string>(link: SettingsLink | null | undefined, known: readonly T[], fallback: T): T {
  const s = link?.section;
  if (s) {
    const hit = known.find((k) => k.toLowerCase() === s.toLowerCase());
    if (hit) return hit;
  }
  if ((link?.metaConnect || link?.metaError) && known.includes('leadSources' as T)) return 'leadSources' as T;
  if ((link?.googleConnected || link?.googleError) && known.includes('googleSheets' as T)) return 'googleSheets' as T;
  return fallback;
}

/** Explain a `metaError` from the Facebook callback in plain words. */
export function metaErrorText(raw: string | null | undefined): string {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/cancel|access_denied|denied|user_denied|declined/i.test(t)) {
    return 'Facebook login was cancelled, so no Pages were connected. Click “Connect Facebook / Instagram” to try again.';
  }
  if (/state|session|csrf/i.test(t)) return 'The Facebook login could not be matched to your CRM session (it may have taken too long). Please try again.';
  if (/no pages?/i.test(t)) return `${t} Make sure you manage at least one Facebook Page and allowed the CRM to see it.`;
  return t;
}

/* --------------------------- Page selection ------------------------------- */

export interface PageSelectability {
  selectable: boolean;
  /** Why the Page cannot be chosen ('' when it can). */
  reason: string;
}

/** Can this Page be connected? Rules mirror the server: one workspace per Page, no double connection, leads must be readable. */
export function pageSelectability(p: Pick<MetaPendingPage, 'claimedElsewhere' | 'alreadyConnected' | 'canReadLeads'>): PageSelectability {
  if (p.alreadyConnected) return { selectable: false, reason: 'Already connected in this workspace.' };
  if (p.claimedElsewhere) return { selectable: false, reason: 'This Page is linked to another workspace.' };
  if (!p.canReadLeads) return { selectable: false, reason: 'Your Facebook role on this Page can’t read leads — you need full control or advertiser access.' };
  return { selectable: true, reason: '' };
}

/** Per-Page choice in the connect dialog. `allForms` = every form (formIds ignored). */
export interface PageChoice {
  checked: boolean;
  allForms: boolean;
  formIds: string[];
}

/** Initial choices: every selectable Page ticked when it is the only one, all forms. */
export function initialChoices(pages: MetaPendingPage[]): Record<string, PageChoice> {
  const selectable = pages.filter((p) => pageSelectability(p).selectable);
  const out: Record<string, PageChoice> = {};
  pages.forEach((p) => {
    out[p.id] = { checked: selectable.length === 1 && selectable[0].id === p.id, allForms: true, formIds: [] };
  });
  return out;
}

export interface ConnectDefaults {
  sourceLabel: string;
  defaultStage: string;
  assignmentMode: AssignmentMode;
  rm: string;
  rms: string[];
  duplicates: DuplicateMode;
}

/** Validate the dialog and build the `connectMetaPages` request; `errors` is empty when it can be sent. */
export function buildConnectRequest(
  pendingId: string,
  pages: MetaPendingPage[],
  choices: Record<string, PageChoice>,
  d: ConnectDefaults
): { req: ConnectRequest; errors: string[] } {
  const errors: string[] = [];
  const chosen: ConnectRequest['pages'] = [];
  pages.forEach((p) => {
    const c = choices[p.id];
    if (!c || !c.checked || !pageSelectability(p).selectable) return;
    const known = new Set((p.forms || []).map((f) => f.id));
    const formIds = c.allForms ? [] : Array.from(new Set(c.formIds.filter((id) => known.has(id))));
    if (!c.allForms && formIds.length === 0) errors.push(`“${p.name}”: choose at least one form, or “All forms”.`);
    chosen.push({ pageId: p.id, formIds });
  });
  if (!pendingId) errors.push('The Facebook connection is missing — click “Connect Facebook / Instagram” again.');
  if (chosen.length === 0) errors.push('Choose at least one Page to connect.');
  if (d.assignmentMode === 'fixed' && !d.rm) errors.push('Choose the RM who receives the leads.');
  if (d.assignmentMode === 'round_robin' && d.rms.length < 1) errors.push('Choose at least one RM for round-robin.');
  return {
    req: {
      pendingId,
      pages: chosen,
      defaults: {
        sourceLabel: d.sourceLabel.trim() || 'Facebook',
        assignment: { mode: d.assignmentMode, rm: d.assignmentMode === 'fixed' ? d.rm : '', rms: d.assignmentMode === 'round_robin' ? d.rms : [] },
        duplicates: d.duplicates,
        defaultStage: d.defaultStage || 'New',
      },
    },
    errors,
  };
}

/** Toast text for the connect result. */
export function connectResultText(r: ConnectResult, pages: Array<Pick<MetaPendingPage, 'id' | 'name'>> = []): { title: string; message: string; tone: 'success' | 'warning' | 'alert' } {
  const created = r.created?.length || 0;
  const skipped = r.skipped || [];
  const nameOf = (id: string) => pages.find((p) => p.id === id)?.name || id;
  const skippedText = skipped.map((s) => `${nameOf(s.pageId)}: ${s.reason || 'skipped'}`).join(' · ');
  const plural = (n: number) => `${n} Page${n === 1 ? '' : 's'}`;
  if (created && !skipped.length) return { title: `Connected ${plural(created)}`, message: 'New leads from your lead forms will appear in the CRM within a minute or two.', tone: 'success' };
  if (created) return { title: `Connected ${plural(created)}, skipped ${skipped.length}`, message: skippedText, tone: 'warning' };
  return { title: 'No Pages were connected', message: skippedText || 'Nothing was chosen.', tone: 'alert' };
}

/** A pending connection that has expired (30 minutes) or was already used. */
export function isPendingGone(err: { code?: string; message?: string; userMessage?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'NOT_FOUND') return true;
  return /expired|not found|no longer|already used/i.test(`${err.userMessage || ''} ${err.message || ''}`);
}

/* ------------------------------ Source card ------------------------------- */

export const facebookPageUrl = (pageId: string) => `https://facebook.com/${encodeURIComponent(String(pageId || ''))}`;

/** "All forms" / "1 form" / "3 forms". */
export function formsSummary(meta: Pick<MetaSourceConfig, 'formIds'> | null | undefined): string {
  const n = meta?.formIds?.length || 0;
  return n === 0 ? 'All forms' : `${n} form${n === 1 ? '' : 's'}`;
}

/** Names of the filtered forms (unknown ids shown as ids). */
export function formNames(meta: Pick<MetaSourceConfig, 'formIds' | 'forms'> | null | undefined): string[] {
  const forms = meta?.forms || [];
  return (meta?.formIds || []).map((id) => forms.find((f) => f.id === id)?.name || id);
}

/** Does an error mean the Facebook connection has to be renewed (expired / revoked token, password change …)? */
export function needsReconnect(message: string | null | undefined): boolean {
  return /expired|reconnect|re-connect|session has been invalidated|invalid(ated)? (oauth|access )?token|error validating access token|password|log ?in again|permissions? (was|were|has been) (removed|revoked)/i.test(String(message || ''));
}

export const BACKFILL_DAYS = [1, 3, 7, 14, 30] as const;

export const backfillDaysLabel = (d: number) => (d === 1 ? 'Last 24 hours' : `Last ${d} days`);

/** Toast for "Fetch recent leads". */
export function backfillResultText(r: BackfillResult): { message: string; tone: 'success' | 'warning' | 'info' } {
  const parts = [`${r.created || 0} new`, `${r.duplicates || 0} already in the CRM`];
  if (r.rejected) parts.push(`${r.rejected} rejected`);
  if (r.failed) parts.push(`${r.failed} failed`);
  const text = parts.join(', ') + (r.message ? ` — ${r.message}` : '');
  const tone = r.failed || r.rejected ? 'warning' : r.created ? 'success' : 'info';
  return { message: text, tone };
}

/* ------------------------------ Form filter ------------------------------- */

/** Form filter state from a saved source (empty formIds = all forms). */
export const formFilterFrom = (meta: Pick<MetaSourceConfig, 'formIds'> | null | undefined): { allForms: boolean; formIds: string[] } => ({
  allForms: !(meta?.formIds?.length),
  formIds: [...(meta?.formIds || [])],
});

/** Saved form ids for a filter (validates "Only these forms" has at least one). */
export function formFilterToIds(f: { allForms: boolean; formIds: string[] }): { formIds: string[]; error: string } {
  if (f.allForms) return { formIds: [], error: '' };
  const ids = Array.from(new Set(f.formIds.filter(Boolean)));
  return ids.length ? { formIds: ids, error: '' } : { formIds: [], error: 'Choose at least one lead form, or “All forms”.' };
}

export const formStatusLabel = (status: string) => {
  const s = String(status || '').toUpperCase();
  return s === 'ACTIVE' ? '' : s === 'ARCHIVED' ? 'archived' : s === 'DELETED' ? 'deleted' : s ? s.toLowerCase() : '';
};
